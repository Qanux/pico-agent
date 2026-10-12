// pico-agent: the LangChain stream bridge.
//
// This is the LLM boundary — the one place pi-ai's providers are replaced by
// LangChain chat models. pi transcripts (system/user/assistant/toolResult with
// content blocks and tool declarations in system messages) are converted to
// LangChain BaseMessages; the AgentModel's chat model is called with
// bindTools + streaming; and the AIMessageChunk stream is normalized back
// into pi's AssistantMessageEvent protocol (start / text_delta /
// toolcall_start|delta|end / done / error), which is what the agent loop and
// every subscriber consume. Failures are encoded in the stream per the
// StreamFn contract — never thrown.

import type { BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import {
	AIMessage,
	AIMessageChunk,
	HumanMessage,
	SystemMessage,
	ToolMessage,
	type BaseMessage,
} from "@langchain/core/messages";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "./types.ts";
import { AssistantMessageEventStream as EventStreamImpl } from "./event-stream.ts";
import type { AgentModel } from "./models.ts";
import { collapseSystemMessages, getCurrentTools, normalizeContext, toolJsonSchema } from "./transcript.ts";
import { getSystemMessageText } from "./text.ts";
import { parseStreamingJson } from "./json-parse.ts";
import { transformMessages } from "./transform-messages.ts";
import { clampMaxTokensToContext, thinkingBudgetForLevel } from "./simple-options.ts";
import type { JsonObject } from "../support/json-value.ts";

/** Options the agent loop forwards into every stream request. */
export interface StreamFnOptions {
	/** Cooperative cancellation for the request. */
	signal?: AbortSignal;
	/** Sampling temperature override. */
	temperature?: number;
	/** Max output tokens override. */
	maxTokens?: number;
	/** Requested reasoning/thinking level (honored by models that support it). */
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Session id forwarded to cache-aware models. */
	sessionId?: string;
	/**
	 * API key resolved by the host (Agent.getApiKey). LangChain chat models hold
	 * their own credentials and ignore this field; custom stream functions may
	 * honor it.
	 */
	apiKey?: string;
}

const EMPTY_USAGE = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

type LangChainContentBlock = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

function imageToBlock(image: ImageContent): LangChainContentBlock {
	return { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } };
}

/** pi transcript → LangChain messages. System messages collapse into one leading message. */
export function transcriptToLangChainMessages(context: TranscriptContext): BaseMessage[] {
	const collapsed = collapseSystemMessages(context);
	const head = collapsed.messages[0];
	const rest = head !== undefined && head.role === "system" ? collapsed.messages.slice(1) : collapsed.messages;
	const result: BaseMessage[] = [];
	if (head !== undefined && head.role === "system") result.push(new SystemMessage({ content: getSystemMessageText(head) }));
	for (const message of rest) {
		switch (message.role) {
			case "system":
				// collapseSystemMessages dropped these; defensive no-op.
				break;
			case "user": {
				if (typeof message.content === "string") {
					result.push(new HumanMessage({ content: message.content }));
				} else {
					const blocks: LangChainContentBlock[] = [];
					for (const block of message.content) {
						if (block.type === "text") blocks.push({ type: "text", text: block.text });
						else blocks.push(imageToBlock(block));
					}
					result.push(new HumanMessage({ content: blocks }));
				}
				break;
			}
			case "assistant": {
				const text = message.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("");
				const thinking = message.content
					.filter((block): block is ThinkingContent => block.type === "thinking")
					.map((block) => block.thinking)
					.join("");
				const toolCalls = message.content
					.filter((block): block is ToolCall => block.type === "toolCall")
					.map((block) => ({ id: block.id, name: block.name, args: block.arguments as Record<string, unknown> }));
				result.push(
					new AIMessage({
						content: text,
						...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
						...(thinking.length > 0 ? { additional_kwargs: { reasoning_content: thinking } } : {}),
					}),
				);
				break;
			}
			case "toolResult": {
				const toolResult = message as ToolResultMessage;
				if (toolResult.content.every((block) => block.type === "text")) {
					result.push(
						new ToolMessage({
							tool_call_id: toolResult.toolCallId,
							name: toolResult.toolName,
							content: toolResult.content.map((block) => (block as TextContent).text).join("\n"),
						}),
					);
				} else {
					const blocks: LangChainContentBlock[] = [];
					for (const block of toolResult.content) {
						if (block.type === "text") blocks.push({ type: "text", text: block.text });
						else blocks.push(imageToBlock(block));
					}
					result.push(new ToolMessage({ tool_call_id: toolResult.toolCallId, name: toolResult.toolName, content: blocks }));
				}
				break;
			}
		}
	}
	return result;
}

function textOf(chunk: AIMessageChunk): string {
	const content = chunk.content;
	if (typeof content === "string") return content;
	return content
		.map((block) => (typeof block === "string" ? block : block.type === "text" ? block.text : ""))
		.join("");
}

const REASONING_FIELD_PRECEDENCE = ["reasoning_content", "reasoning", "reasoning_text"] as const;

function thinkingOf(chunk: AIMessageChunk, lockedField: string | null): { text: string; field: string | null } {
	const kwargs = chunk.additional_kwargs as Record<string, unknown> | undefined;
	if (kwargs === undefined) return { text: "", field: lockedField };
	// Like pi's adapters: endpoints expose reasoning under different keys
	// (llama.cpp reasoning_content, others reasoning/reasoning_text, sometimes
	// two at once with identical content) — the first non-empty key wins and
	// stays locked for the rest of the stream to avoid double emission.
	const fields = lockedField !== null ? [lockedField] : REASONING_FIELD_PRECEDENCE;
	for (const field of fields) {
		const value = kwargs[field];
		if (typeof value === "string" && value.length > 0) return { text: value, field };
	}
	return { text: "", field: lockedField };
}

function usageOf(chunk: AIMessageChunk | undefined): Usage {
	const usage = EMPTY_USAGE();
	if (!chunk?.usage_metadata) return usage;
	usage.input = chunk.usage_metadata.input_tokens ?? 0;
	usage.output = chunk.usage_metadata.output_tokens ?? 0;
	usage.cacheRead = chunk.usage_metadata.input_token_details?.cache_read ?? 0;
	usage.cacheWrite = chunk.usage_metadata.input_token_details?.cache_creation ?? 0;
	usage.totalTokens = chunk.usage_metadata.total_tokens ?? usage.input + usage.output;
	return usage;
}

function finishReasonOf(chunk: AIMessageChunk | undefined): string | undefined {
	const value = (chunk?.response_metadata as { finish_reason?: unknown } | undefined)?.finish_reason;
	return typeof value === "string" ? value : undefined;
}

function copyPartial(partial: AssistantMessage): AssistantMessage {
	return { ...partial, content: partial.content.map((block) => ({ ...block })) };
}

/**
 * Build the default stream function over LangChain chat models. Stateless per
 * call: the model, transcript, tools, and options all arrive with each
 * request, so one factory serves any number of agents and mid-run model swaps
 * (prepareRequest) work unchanged.
 */
export function createModelStreamFn() {
	return (model: AgentModel, context: TranscriptContext, options?: StreamFnOptions): AssistantMessageEventStream => {
		const stream = new EventStreamImpl();

		void (async () => {
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: EMPTY_USAGE(),
				stopReason: "pending",
				timestamp: Date.now(),
			};
			let started = false;
				let textIndex = -1;
				let emittedText = "";
				let thinkingIndex = -1;
				let emittedThinking = "";
				let reasoningField: string | null = null;
			// Tool-call streaming state, keyed by the chunk index the model assigns.
			const toolFragments = new Map<number, string>();
			const toolContentIndex = new Map<number, number>();

			const begin = () => {
				if (started) return;
				started = true;
				stream.push({ type: "start", partial: copyPartial(partial) });
			};
			const fail = (error: unknown) => {
				const reason = options?.signal?.aborted ? "aborted" : "error";
				partial.stopReason = reason;
				partial.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason, error: copyPartial(partial) });
			};

			try {
				if (options?.signal?.aborted) throw new Error("Request aborted");

				const tools = getCurrentTools(context.messages);
				const bound =
					tools.length > 0 && model.chat.bindTools
						? model.chat.bindTools(
								tools.map((tool) => ({
									name: tool.name,
									description: tool.description,
									parameters: toolJsonSchema(tool.parameters),
									// JSON-schema constrained sampling maps to the OpenAI-style
									// strict flag; models without the concept ignore it.
									...(tool.constrainedSampling !== false &&
									tool.constrainedSampling?.type === "json_schema"
										? { strict: true }
										: {}),
								})),
							)
						: model.chat;

				const callOptions: Partial<BaseChatModelCallOptions> & Record<string, unknown> = {};
				if (options?.signal !== undefined) callOptions.signal = options.signal;
				if (options?.temperature !== undefined) callOptions.temperature = options.temperature;
				callOptions.maxTokens = clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens);
				if (options?.sessionId !== undefined) callOptions.sessionId = options.sessionId;
				if (options?.reasoning !== undefined) {
					const effort =
						options.reasoning === "xhigh" || options.reasoning === "max"
							? "high"
							: options.reasoning === "minimal"
								? "minimal"
								: options.reasoning;
					callOptions.reasoningEffort = effort;
					// pi sent a per-level token budget to its adapters; LangChain has no
					// unified field, so it travels under this generic key for wrapped
					// models that understand it.
					callOptions.thinkingBudget = thinkingBudgetForLevel(options.reasoning);
				}

				// Repair the transcript the way pi's wire adapters did: image
				// downgrade, cross-model thinking/signature handling, orphaned tool
				// calls, ID normalization hooks live in transformMessages.
				const transformed = transformMessages(context.messages, model);
				const request = transcriptToLangChainMessages(normalizeContext({ messages: transformed }));
				let accumulated: AIMessageChunk | undefined;

				const responseStream = await bound.stream(request, callOptions);
				for await (const message of responseStream) {
					const chunk = message;
					accumulated = accumulated ? accumulated.concat(chunk) : chunk;
					begin();

					// Text deltas.
					const fullText = textOf(accumulated);
					if (fullText.length > emittedText.length) {
						if (textIndex === -1) {
							textIndex = partial.content.length;
							partial.content.push({ type: "text", text: "" });
							stream.push({ type: "text_start", contentIndex: textIndex, partial: copyPartial(partial) });
						}
						const delta = fullText.slice(emittedText.length);
						emittedText = fullText;
						(partial.content[textIndex] as TextContent).text = fullText;
						stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: copyPartial(partial) });
					}

					// Thinking deltas.
					const thinking = thinkingOf(accumulated, reasoningField);
					reasoningField = thinking.field;
					const fullThinking = thinking.text;
					if (fullThinking.length > emittedThinking.length) {
						if (thinkingIndex === -1) {
							thinkingIndex = partial.content.length;
							partial.content.push({ type: "thinking", thinking: "" });
							stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: copyPartial(partial) });
						}
						const delta = fullThinking.slice(emittedThinking.length);
						emittedThinking = fullThinking;
						(partial.content[thinkingIndex] as ThinkingContent).thinking = fullThinking;
						stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: copyPartial(partial) });
					}

					// Tool-call argument fragments (streaming models).
					for (const fragment of chunk.tool_call_chunks ?? []) {
						const index = fragment.index ?? 0;
						const existing = toolFragments.get(index);
						const argsFragment = fragment.args ?? "";
						if (existing === undefined) {
							toolFragments.set(index, argsFragment);
							const contentIndex = partial.content.length;
							toolContentIndex.set(index, contentIndex);
							partial.content.push({
								type: "toolCall",
								id: fragment.id ?? "",
								name: fragment.name ?? "",
								arguments: parseStreamingJson<JsonObject>(argsFragment),
							});
							stream.push({ type: "toolcall_start", contentIndex, partial: copyPartial(partial) });
						} else {
							toolFragments.set(index, existing + argsFragment);
							const block = partial.content[toolContentIndex.get(index) ?? 0];
							if (block?.type === "toolCall") {
								block.arguments = parseStreamingJson<JsonObject>(toolFragments.get(index));
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: toolContentIndex.get(index) ?? 0,
								delta: argsFragment,
								partial: copyPartial(partial),
							});
						}
					}
				}

				// Finalize: authoritative tool calls, usage, stop reason.
				const finalToolCalls = accumulated?.tool_calls ?? [];
				if (toolFragments.size > 0) {
					// Streaming tool calls: blocks already live in partial.content from
					// tool_call_chunks; finalize each in place with the model's
					// authoritative id/name/args.
					const indices = [...toolFragments.keys()].sort((a, b) => a - b);
					for (let i = 0; i < indices.length; i++) {
						const index = indices[i]!;
						const call = finalToolCalls[i];
						const contentIndex = toolContentIndex.get(index) ?? 0;
						const block = partial.content[contentIndex];
						if (block?.type !== "toolCall") continue;
						const toolCall: ToolCall = {
							type: "toolCall",
							id: call?.id ?? block.id,
							name: call?.name ?? block.name,
							arguments: ((call?.args ?? block.arguments) ?? {}) as JsonObject,
						};
						partial.content[contentIndex] = toolCall;
						stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: copyPartial(partial) });
					}
				} else {
					// Non-streaming tool calls (e.g. scripted models): synthesize the
					// full start → delta → end sequence so the event protocol holds.
					for (const call of finalToolCalls) {
						const toolCall: ToolCall = {
							type: "toolCall",
							id: call.id ?? "",
							name: call.name,
							arguments: (call.args ?? {}) as JsonObject,
						};
						const contentIndex = partial.content.length;
						partial.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex, partial: copyPartial(partial) });
						stream.push({
							type: "toolcall_delta",
							contentIndex,
							delta: JSON.stringify(toolCall.arguments),
							partial: copyPartial(partial),
						});
						stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: copyPartial(partial) });
					}
				}
				if (textIndex >= 0) {
					stream.push({ type: "text_end", contentIndex: textIndex, content: emittedText, partial: copyPartial(partial) });
				}
				if (thinkingIndex >= 0) {
					stream.push({
						type: "thinking_end",
						contentIndex: thinkingIndex,
						content: emittedThinking,
						partial: copyPartial(partial),
					});
				}

					const finish = finishReasonOf(accumulated);
					partial.usage = usageOf(accumulated);
					// Streaming tool calls only expose tool_call_chunks; the concat'd
					// tool_calls array stays empty for them, so both signals count.
					const hasToolCalls = finalToolCalls.length > 0 || toolFragments.size > 0;
					partial.stopReason = hasToolCalls ? "toolUse" : finish === "length" ? "length" : "stop";
					partial.rawStopReason = finish;
					partial.endTurn = !hasToolCalls;
				const reason = partial.stopReason as "stop" | "length" | "toolUse";
				stream.push({ type: "done", reason, message: copyPartial(partial) });
			} catch (error) {
				fail(error);
			}
		})();

		return stream;
	};
}
