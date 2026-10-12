/**
 * LangChain layer regression — the pico-agent counterpart of the predecessor's
 * provider verify. There the check was "18 provider factories resolve and
 * their catalogs load"; here the substrate is LangChain, so the equivalent
 * surface is the model layer + stream bridge:
 *
 *   A transcript mapping: pi transcripts convert to LangChain messages —
 *      system collapse, user text/image, assistant text+thinking+tool_calls,
 *      toolResult text join.
 *   B event protocol (scripted model): one full response replays as the exact
 *      AssistantMessageEvent sequence, with usage, stop reason, and endTurn
 *      mapped from usage_metadata / finish_reason.
 *   C streaming tool calls (chunked model): OpenAI-style tool_call_chunks
 *      fragments reassemble into complete tool calls; two concurrent calls
 *      keep separate ids/args; cache usage maps; stop reason is toolUse even
 *      though the concat'd tool_calls array stays empty.
 *   D abort: a pre-aborted signal fails before any request; a model that
 *      hangs until the signal fires ends with stopReason "aborted".
 *   E tool declarations: declared tools reach bindTools as JSON Schema
 *      (zod → JSON conversion); no tools means no bindTools call; a plain
 *      JSON-Schema declaration from a session snapshot passes through
 *      unchanged (the restore path).
 *   F model factories: createOpenAIModel wraps a real ChatOpenAI with catalog
 *      metadata; createUnavailableModel fails loudly through the bridge.
 * Run: node examples/verify-bridge.ts
 */
import { z } from "zod";
import { ChatOpenAI, ChatOpenAIResponses } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
	BaseChatModel,
	type BaseChatModelCallOptions,
	type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import {
	AIMessage,
	AIMessageChunk,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import {
	clampMaxTokensToContext,
	createAnthropicModel,
	createGoogleModel,
	createModelStreamFn,
	createOpenAIModel,
	createOpenAIResponsesModel,
	createScriptedModel,
	createUnavailableModel,
	DEFAULT_THINKING_BUDGETS,
	normalizeContext,
	thinkingBudgetForLevel,
	transformMessages,
	transcriptToLangChainMessages,
	type AgentModel,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Message,
	type Tool,
	type ToolCall,
} from "pico-agent";

let failures = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		api: "langchain-scripted",
		provider: "scripted",
		model: "mock",
		usage: {
			input: 11, output: 7, cacheRead: 4, cacheWrite: 2, totalTokens: 18,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		content,
		stopReason,
	};
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

const streamFn = createModelStreamFn();
const callStream = (model: AgentModel, context: Parameters<typeof streamFn>[1], options?: Parameters<typeof streamFn>[2]) =>
	streamFn(model, context, options);

/** A model that yields a fixed list of chunks (the streaming-fragment shape). */
class ChunkedChatModel extends BaseChatModel<BaseChatModelCallOptions, AIMessageChunk> {
	readonly chunks: AIMessageChunk[];
	constructor(chunks: AIMessageChunk[]) {
		super({});
		this.chunks = chunks;
	}
	_llmType(): string {
		return "chunked";
	}
	async _generate(): Promise<ChatResult> {
		throw new Error("stream only");
	}
	async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
		for (const chunk of this.chunks) yield new ChatGenerationChunk({ message: chunk, text: "" });
	}
}

function chunkedModel(chunks: AIMessageChunk[], id = "chunked"): AgentModel {
	return { ...createUnavailableModel(), id, name: id, provider: "chunked", chat: new ChunkedChatModel(chunks) };
}

/** A model whose stream never yields until the abort signal fires. */
class HangingChatModel extends BaseChatModel<BaseChatModelCallOptions, AIMessageChunk> {
	constructor() {
		super({});
	}
	_llmType(): string {
		return "hanging";
	}
	async _generate(): Promise<ChatResult> {
		throw new Error("stream only");
	}
	async *_streamResponseChunks(
		_messages: never,
		options?: BaseChatModelCallOptions,
	): AsyncGenerator<ChatGenerationChunk> {
		await new Promise<never>((_resolve, reject) => {
			const fail = () => reject(new DOMException("This operation was aborted", "AbortError"));
			if (options?.signal?.aborted) {
				fail();
				return;
			}
			options?.signal?.addEventListener("abort", fail, { once: true });
		});
	}
}

/** Records every bindTools call and the last request/options it received. */
class SpyChatModel extends BaseChatModel<BaseChatModelCallOptions, AIMessageChunk> {
	readonly bound: Array<Array<{ name: string; description: string; parameters: Record<string, unknown> }>> = [];
	lastMessages: unknown[] = [];
	lastOptions: Record<string, unknown> = {};
	constructor() {
		super({});
	}
	_llmType(): string {
		return "spy";
	}
	bindTools(
		tools: BindToolsInput[],
	): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
		this.bound.push(tools as Array<{ name: string; description: string; parameters: Record<string, unknown> }>);
		return this as unknown as Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions>;
	}
	async _generate(): Promise<ChatResult> {
		throw new Error("stream only");
	}
	async *_streamResponseChunks(messages: never[], options?: BaseChatModelCallOptions): AsyncGenerator<ChatGenerationChunk> {
		this.lastMessages = messages;
		this.lastOptions = (options ?? {}) as Record<string, unknown>;
		yield new ChatGenerationChunk({ message: new AIMessageChunk({ content: "ok" }), text: "" });
	}
}

// ---- Scenario A: transcript → LangChain message mapping ----
{
	console.log("--- scenario A: transcript mapping ---");
	const context = normalizeContext({
		systemPrompt: "You are the head.",
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "user",
				content: [
					{ type: "text", text: "look at this" },
					{ type: "image", mimeType: "image/png", data: "AAAA" },
				],
				timestamp: 2,
			},
			reply(
				[
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "I will call echo" },
					{ type: "toolCall", id: "c1", name: "echo", arguments: { msg: "hi" } },
				],
				"toolUse",
			),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "echo",
				content: [
					{ type: "text", text: "line1" },
					{ type: "text", text: "line2" },
				],
				isError: false,
				timestamp: 3,
			},
			{ role: "system", content: "updated guidance", timestamp: 4 },
			{ role: "user", content: "thanks", timestamp: 5 },
		],
	});
	const mapped = transcriptToLangChainMessages(context);
	check(mapped.length === 6, `A: six LangChain messages (got ${mapped.length})`);
	const head = mapped[0];
	check(head instanceof SystemMessage, "A: transcript head is a SystemMessage");
	check(
		head !== undefined &&
			String(head.content).includes("You are the head.") &&
			String(head.content).includes("updated guidance"),
		"A: later system messages collapse into the head",
	);
	const plainUser = mapped[1];
	check(
		plainUser instanceof HumanMessage && plainUser.content === "hello",
		"A: string user content stays a string HumanMessage",
	);
	const imageUser = mapped[2];
	check(
		imageUser instanceof HumanMessage &&
			JSON.stringify(imageUser.content) ===
				JSON.stringify([
					{ type: "text", text: "look at this" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
				]),
		"A: image content becomes an image_url block",
	);
	const assistant = mapped[3];
	check(
		assistant instanceof AIMessage &&
			assistant.content === "I will call echo" &&
			JSON.stringify(assistant.tool_calls) === JSON.stringify([{ id: "c1", name: "echo", args: { msg: "hi" } }]) &&
			(assistant.additional_kwargs as { reasoning_content?: string }).reasoning_content === "hmm",
		"A: assistant maps text, tool_calls, and reasoning_content",
	);
	const toolResult = mapped[4];
	check(
		toolResult instanceof ToolMessage &&
			toolResult.tool_call_id === "c1" &&
			toolResult.name === "echo" &&
			toolResult.content === "line1\nline2",
		"A: toolResult maps ids and joins text blocks",
	);
}

// ---- Scenario B: event protocol over the scripted model ----
{
	console.log("--- scenario B: scripted event protocol ---");
	const model = createScriptedModel({
		id: "mock",
		responses: [
			reply(
				[
					{ type: "thinking", thinking: "let me think" },
					{ type: "text", text: "hello world" },
					{ type: "toolCall", id: "c1", name: "echo", arguments: { msg: "hi" } },
				],
				"toolUse",
			),
			reply([{ type: "text", text: "done" }], "stop"),
		],
	});
	const baseContext = normalizeContext({ systemPrompt: "sys", messages: [{ role: "user", content: "go", timestamp: 1 }] });

	const events = await collect(callStream(model, baseContext));
	check(
		events.map((e) => e.type).join(",") ===
			"start,text_start,text_delta,thinking_start,thinking_delta,toolcall_start,toolcall_delta,toolcall_end,text_end,thinking_end,done",
		`B: full event sequence (got ${events.map((e) => e.type).join(",")})`,
	);
	const done = events.at(-1);
	check(
		done?.type === "done" &&
			done.reason === "toolUse" &&
			done.message.stopReason === "toolUse" &&
			done.message.endTurn === false &&
			done.message.usage.input === 11 &&
			done.message.usage.output === 7 &&
			done.message.usage.cacheRead === 4 &&
			done.message.usage.cacheWrite === 2 &&
			done.message.model === "mock" &&
			done.message.provider === "scripted",
		"B: done carries mapped stop reason, usage, and model identity",
	);
	const toolEnd = events.find((e) => e.type === "toolcall_end");
	check(
		toolEnd?.type === "toolcall_end" &&
			(toolEnd.toolCall satisfies ToolCall).id === "c1" &&
			toolEnd.toolCall.name === "echo" &&
			JSON.stringify(toolEnd.toolCall.arguments) === JSON.stringify({ msg: "hi" }),
		"B: synthesized tool call sequence ends with the full call",
	);

	const stopEvents = await collect(callStream(model, baseContext));
	const stopDone = stopEvents.at(-1);
	check(
		stopDone?.type === "done" && stopDone.reason === "stop" && stopDone.message.endTurn === true,
		"B: replay advances to the next scripted response (stop turn)",
	);
}

// ---- Scenario C: streaming tool_call_chunks reassembly ----
{
	console.log("--- scenario C: streaming tool_call_chunks ---");
	const model = chunkedModel([
		new AIMessageChunk({ content: "He" }),
		new AIMessageChunk({ content: "llo" }),
		new AIMessageChunk({ content: "", tool_call_chunks: [{ index: 0, id: "call_1", name: "echo", args: '{"msg"' }] }),
		new AIMessageChunk({ content: "", tool_call_chunks: [{ index: 0, args: ":12}" }] }),
		new AIMessageChunk({ content: "", tool_call_chunks: [{ index: 1, id: "call_2", name: "add", args: '{"a":3,"b":4}' }] }),
		new AIMessageChunk({
			content: "",
			usage_metadata: {
				input_tokens: 11,
				output_tokens: 7,
				total_tokens: 18,
				input_token_details: { cache_read: 4, cache_creation: 2 },
			},
			response_metadata: { finish_reason: "tool_calls" },
		}),
	]);
	const context = normalizeContext({ systemPrompt: "sys", messages: [{ role: "user", content: "go", timestamp: 1 }] });
	const events = await collect(callStream(model, context));

	const textDeltas = events.filter((e) => e.type === "text_delta").map((e) => (e.type === "text_delta" ? e.delta : ""));
	check(textDeltas.join("") === "Hello" && textDeltas.length === 2, `C: text streamed in fragments (${textDeltas.join("|")})`);
	const starts = events.filter((e) => e.type === "toolcall_start");
	check(starts.length === 2, "C: two toolcall_start events for two streamed calls");
	const ends = events.filter((e) => e.type === "toolcall_end");
	check(
		ends.length === 2 &&
			ends.every(
				(e): e is Extract<AssistantMessageEvent, { type: "toolcall_end" }> => e.type === "toolcall_end",
			) &&
			ends[0]!.toolCall.id === "call_1" &&
			ends[0]!.toolCall.name === "echo" &&
			JSON.stringify(ends[0]!.toolCall.arguments) === JSON.stringify({ msg: 12 }) &&
			ends[1]!.toolCall.id === "call_2" &&
			ends[1]!.toolCall.name === "add" &&
			JSON.stringify(ends[1]!.toolCall.arguments) === JSON.stringify({ a: 3, b: 4 }),
		"C: fragmented args reassembled into complete calls per index",
	);
	const done = events.at(-1);
	check(
		done?.type === "done" &&
			done.reason === "toolUse" &&
			done.message.stopReason === "toolUse" &&
			done.message.endTurn === false &&
			done.message.rawStopReason === "tool_calls" &&
			done.message.usage.input === 11 &&
			done.message.usage.cacheRead === 4 &&
			done.message.usage.cacheWrite === 2 &&
			done.message.usage.totalTokens === 18,
		"C: done maps usage (incl. cache) and toolUse from streamed fragments",
	);
}

// ---- Scenario D: abort contract ----
{
	console.log("--- scenario D: abort ---");
	const context = normalizeContext({ systemPrompt: "sys", messages: [{ role: "user", content: "go", timestamp: 1 }] });

	const preAborted = new AbortController();
	preAborted.abort();
	const events1 = await collect(callStream(createScriptedModel({ responses: [reply([{ type: "text", text: "x" }], "stop")] }), context, { signal: preAborted.signal }));
	const err1 = events1.at(-1);
	check(
		events1.length === 1 &&
			err1?.type === "error" &&
			err1.reason === "aborted" &&
			err1.error.stopReason === "aborted",
		"D: pre-aborted signal fails before any request",
	);

	const hanging: AgentModel = { ...createUnavailableModel(), id: "hang", chat: new HangingChatModel() };
	const controller = new AbortController();
	const stream = callStream(hanging, context, { signal: controller.signal });
	setTimeout(() => controller.abort(), 30);
	const events2 = await collect(stream);
	const err2 = events2.at(-1);
	check(
		err2?.type === "error" && err2.reason === "aborted" && err2.error.stopReason === "aborted",
		"D: mid-stream abort ends with stopReason aborted",
	);
}

// ---- Scenario E: tool declarations reach bindTools as JSON Schema ----
{
	console.log("--- scenario E: bindTools declarations ---");
	const spy = new SpyChatModel();
	const model: AgentModel = { ...createUnavailableModel(), id: "spy", chat: spy };
	const echo: Tool = {
		name: "echo",
		description: "echoes the message",
		parameters: z.object({ msg: z.string().describe("the message") }),
	};
	const withTools = normalizeContext({ systemPrompt: "sys", tools: [echo], messages: [{ role: "user", content: "go", timestamp: 1 }] });
	const events = await collect(callStream(model, withTools));
	const done = events.at(-1);
	check(done?.type === "done" && spy.bound.length === 1, "E: declared tools triggered exactly one bindTools call");
	const declaration = spy.bound[0]?.[0];
	check(
		declaration?.name === "echo" &&
			declaration.description === "echoes the message" &&
			declaration.parameters.type === "object" &&
			(declaration.parameters.properties as { msg: { type: string } }).msg?.type === "string" &&
			(declaration.parameters.required as string[]).includes("msg"),
		"E: zod schema crossed as JSON Schema with description and required",
	);

	const withoutTools = normalizeContext({ systemPrompt: "sys", messages: [{ role: "user", content: "go", timestamp: 1 }] });
	await collect(callStream(model, withoutTools));
	check(spy.bound.length === 1, "E: no declared tools means no bindTools call");

	// The restore path: a declaration that crossed a session snapshot arrives
	// as plain JSON Schema (not zod) and must pass through unchanged.
	const snapshotContext = normalizeContext({
		systemPrompt: "sys",
		tools: [
			{
				name: "echo",
				description: "echoes the message",
				parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
			} as unknown as Tool,
		],
		messages: [{ role: "user", content: "go", timestamp: 1 }],
	});
	await collect(callStream(model, snapshotContext));
	const restored = spy.bound[1]?.[0];
	check(
		spy.bound.length === 2 &&
			JSON.stringify(restored?.parameters) ===
				JSON.stringify({ type: "object", properties: { msg: { type: "string" } }, required: ["msg"] }),
		"E: plain JSON-Schema declarations from snapshots pass through byte-for-byte",
	);
}

// ---- Scenario F: model factories ----
{
	console.log("--- scenario F: model factories ---");
	const openai = createOpenAIModel({ model: "gpt-4o-mini", baseURL: "https://example.test/v1", contextWindow: 65_536 });
	check(
		openai.chat instanceof ChatOpenAI &&
			openai.id === "gpt-4o-mini" &&
			openai.provider === "openai" &&
			openai.baseUrl === "https://example.test/v1" &&
			openai.contextWindow === 65_536 &&
			openai.maxTokens === 8_192,
		"F: createOpenAIModel wraps a ChatOpenAI with catalog metadata",
	);
	const context = normalizeContext({ systemPrompt: "sys", messages: [{ role: "user", content: "go", timestamp: 1 }] });
	const events = await collect(callStream(createUnavailableModel(), context));
	const err = events.at(-1);
	check(
		err?.type === "error" && err.reason === "error" && (err.error.errorMessage ?? "").includes("No model configured"),
		"F: createUnavailableModel fails loudly through the bridge",
	);
}

// ---- Scenario G: transcript repair before the wire (transformMessages) ----
{
	console.log("--- scenario G: transformMessages ---");
	const anthropicLike = createAnthropicModel({ model: "claude-test", apiKey: "verify" });
	const messages: Message[] = [
		{ role: "system", content: "sys", timestamp: 0 },
		{ role: "user", content: "go", timestamp: 1 },
		reply(
			[
				{ type: "thinking", thinking: "secret-plan", thinkingSignature: "sig1" },
				{ type: "text", text: "will call" },
				{ type: "toolCall", id: "c1", name: "echo", arguments: {}, thoughtSignature: "g-sig" },
			],
			"toolUse",
		),
		// A system update between the call and its result must be held back.
		{ role: "system", content: "mid-turn update", timestamp: 2 },
		// An errored turn is unsafe to replay and must vanish.
		reply([{ type: "text", text: "half turn" }], "error"),
		{ role: "user", content: "interrupted", timestamp: 3 },
		// A thinking turn from a DIFFERENT model: thinking becomes text, redacted
		// and thought signatures drop.
		reply(
			[
				{ type: "thinking", thinking: "other-model-plan", thinkingSignature: "sig2" },
				{ type: "thinking", thinking: "", thinkingSignature: "sig3" },
				{ type: "thinking", thinking: "redacted-blob", redacted: true },
				{ type: "text", text: "cross model" },
			],
			"stop",
		),
	];

	const repaired = transformMessages(messages, anthropicLike);
	// system, user, assistant(kept), held system, orphan toolResult, user, cross-model assistant
	const roles = repaired.map((m) => m.role).join(",");
	check(roles === "system,user,assistant,toolResult,system,user,assistant", `G: repair keeps order, inserts the orphan result, holds the system (got ${roles})`);
	const orphan = repaired[3];
	check(
		orphan?.role === "toolResult" &&
			orphan.toolCallId === "c1" &&
			orphan.isError &&
			orphan.content[0]?.type === "text" &&
			orphan.content[0].text === "No result provided",
		"G: the orphaned toolCall gets a synthetic error result",
	);
	check(
		!repaired.some((m) => m.role === "assistant" && m.stopReason === "error"),
		"G: the errored assistant turn is dropped from the replay",
	);
	const cross = repaired.at(-1);
	check(
		cross?.role === "assistant" &&
			JSON.stringify(cross.content) ===
				JSON.stringify([
					{ type: "text", text: "other-model-plan" },
					{ type: "text", text: "cross model" },
				]),
		"G: cross-model thinking converts to text; empty-thinking and redacted blocks drop",
	);
	// Same model: signatures survive replay.
	const sameModelTurn = {
		...reply([{ type: "thinking", thinking: "same", thinkingSignature: "sig1" }], "stop"),
		provider: anthropicLike.provider,
		api: anthropicLike.api,
		model: anthropicLike.id,
	};
	const sameModelRepaired = transformMessages([sameModelTurn], anthropicLike);
	check(
		sameModelRepaired[0]?.role === "assistant" &&
			JSON.stringify(sameModelRepaired[0].content) === JSON.stringify([{ type: "thinking", thinking: "same", thinkingSignature: "sig1" }]),
		"G: same-model thinking with signature survives replay",
	);

	// Non-vision model: images downgrade to placeholder text.
	const textOnly = { ...createUnavailableModel(), id: "text-only", input: ["text"] as ("text" | "image")[] };
	const withImage = transformMessages(
		[
			{
				role: "user",
				content: [
					{ type: "text", text: "see" },
					{ type: "image", mimeType: "image/png", data: "AAAA" },
				],
				timestamp: 1,
			},
		],
		textOnly,
	);
	check(
		withImage[0]?.role === "user" &&
			JSON.stringify(withImage[0].content) ===
				JSON.stringify([{ type: "text", text: "see" }, { type: "text", text: "(image omitted: model does not support images)" }]),
		"G: images downgrade to placeholders for non-vision models",
	);

	// ID normalization: a Responses-style oversized id rewritten for another
	// provider, with the matching tool result following the rewrite.
	const longId = "resp_|_very_long_id_0123456789";
	const expectedId = `norm_${longId.slice(0, 8)}`;
	const normalize = (id: string) => (id.length > 20 ? expectedId : id);
	const normalized = transformMessages(
		[
			reply([{ type: "toolCall", id: longId, name: "echo", arguments: {} }], "toolUse"),
			{
				role: "toolResult",
				toolCallId: longId,
				toolName: "echo",
				content: [{ type: "text", text: "r" }],
				isError: false,
				timestamp: 2,
			},
		],
		anthropicLike,
		normalize,
	);
	check(
		normalized[0]?.role === "assistant" &&
			(normalized[0].content[0] as ToolCall).id === expectedId &&
			normalized[1]?.role === "toolResult" &&
			normalized[1].toolCallId === expectedId,
		"G: normalizeToolCallId rewrites the call and its result together",
	);

	// End to end: the bridge repairs before converting. A dangling toolCall in
	// the transcript reaches the chat model WITH its synthetic result attached.
	const spy2 = new SpyChatModel();
	const bridgeModel: AgentModel = { ...createUnavailableModel(), id: "spy2", chat: spy2 };
	await collect(callStream(bridgeModel, normalizeContext({
		systemPrompt: "sys",
		messages: [
			{ role: "user", content: "go", timestamp: 1 },
			reply([{ type: "toolCall", id: "orphan-1", name: "echo", arguments: {} }], "toolUse"),
		],
	})));
	check(
		spy2.lastMessages.filter((m) => (m as { tool_call_id?: string }).tool_call_id === "orphan-1").length === 1,
		"G: the bridge sends the repaired transcript over the wire",
	);
}

// ---- Scenario H: wire-protocol factories, strict tools, clamps, budgets ----
{
	console.log("--- scenario H: factories, strict, clamps ---");
	const anthropic = createAnthropicModel({ model: "claude-sonnet-4-5", apiKey: "verify" });
	check(
		anthropic.chat instanceof ChatAnthropic &&
			anthropic.provider === "anthropic" &&
			anthropic.api === "langchain-anthropic" &&
			anthropic.reasoning === true &&
			anthropic.contextWindow === 200_000,
		"H: createAnthropicModel wraps ChatAnthropic (the anthropic-messages wire API)",
	);
	const google = createGoogleModel({ model: "gemini-2.5-pro", apiKey: "verify" });
	check(
		google.chat instanceof ChatGoogleGenerativeAI &&
			google.provider === "google" &&
			google.api === "langchain-google" &&
			google.contextWindow === 1_048_576,
		"H: createGoogleModel wraps ChatGoogleGenerativeAI (the google-generative-ai wire API)",
	);
	const responses = createOpenAIResponsesModel({ model: "gpt-5.1" });
	check(
		responses.chat instanceof ChatOpenAIResponses && responses.api === "langchain-openai-responses",
		"H: createOpenAIResponsesModel wraps ChatOpenAIResponses (the openai-responses wire API)",
	);

	// Constrained sampling: json_schema maps to the OpenAI-style strict flag.
	const spy3 = new SpyChatModel();
	const strictModel: AgentModel = { ...createUnavailableModel(), id: "spy3", chat: spy3 };
	const strictTool: Tool = {
		name: "shaped",
		description: "strict tool",
		parameters: z.object({ a: z.string() }),
		constrainedSampling: { type: "json_schema", strict: "require" },
	};
	await collect(callStream(strictModel, normalizeContext({
		systemPrompt: "sys",
		tools: [strictTool],
		messages: [{ role: "user", content: "go", timestamp: 1 }],
	})));
	check((spy3.bound[0]?.[0] as { strict?: boolean } | undefined)?.strict === true, "H: json_schema constrained sampling crosses as strict=true");

	// maxTokens clamps against the context window; the reasoning level maps to
	// an effort plus a token budget the way streamSimple's options did.
	const tinyWindow: AgentModel = { ...createUnavailableModel(), id: "tiny", contextWindow: 1_000, maxTokens: 8_192 };
	const clamped = clampMaxTokensToContext(tinyWindow, normalizeContext({ systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 1 }] }), 8_192);
	check(clamped < 1_000 && clamped >= 1, `H: maxTokens clamps below the window (got ${clamped})`);
	check(clampMaxTokensToContext({ ...createUnavailableModel(), contextWindow: 0 }, normalizeContext({ messages: [{ role: "user", content: "", timestamp: 1 }] }), 512) === 512, "H: a windowless model keeps the caller's maxTokens");

	const spy4 = new SpyChatModel();
	const budgetModel: AgentModel = { ...createUnavailableModel(), id: "spy4", contextWindow: 1_000_000, chat: spy4 };
	await collect(callStream(budgetModel, normalizeContext({
		systemPrompt: "sys",
		messages: [{ role: "user", content: "go", timestamp: 1 }],
	}), { reasoning: "low" }));
	check(
		spy4.lastOptions.reasoningEffort === "low" && spy4.lastOptions.thinkingBudget === DEFAULT_THINKING_BUDGETS.low,
		"H: reasoning level maps to effort plus a token budget",
	);
	check(thinkingBudgetForLevel("xhigh") === DEFAULT_THINKING_BUDGETS.high, "H: xhigh clamps to the high budget");
}

console.log(failures === 0 ? "\nBRIDGE VERIFY OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
