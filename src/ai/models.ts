// pico-langchain: the model layer.
//
// pi-ai's provider catalog is replaced by LangChain chat models. An AgentModel
// pairs a LangChain BaseChatModel with the catalog metadata the agent core
// reads (context window for compaction, id for sessions). Two factories:
// - createOpenAIModel: any OpenAI-compatible endpoint via @langchain/openai.
// - createScriptedModel: keyless replay of scripted AssistantMessages for
//   tests and demos — the port of pico-agent's scripted StreamFn verify
//   pattern, now living at the model instead of the stream function.

import { ChatOpenAI, ChatOpenAIResponses } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
	BaseChatModel,
	type BaseChatModelCallOptions,
	type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { Runnable } from "@langchain/core/runnables";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { AssistantMessage, ToolCall as PiToolCall } from "./types.ts";

/** Chat model handle plus the catalog metadata the agent core reads. */
export interface AgentModel {
	id: string;
	name: string;
	provider: string;
	api: string;
	baseUrl?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	/** Context window in tokens; drives autoCompaction's effective window. */
	contextWindow: number;
	maxTokens: number;
	/** The LangChain chat model this agent talks to. */
	chat: BaseChatModel<BaseChatModelCallOptions, AIMessageChunk>;
}

export interface OpenAIModelOptions {
	model: string;
	apiKey?: string;
	baseURL?: string;
	temperature?: number;
	/** Context window in tokens. Default 131072. */
	contextWindow?: number;
	/** Max output tokens. Default 8192. */
	maxTokens?: number;
}

/** Real model over any OpenAI-compatible endpoint (OpenAI, DeepSeek, ...) via @langchain/openai. */
export function createOpenAIModel(options: OpenAIModelOptions): AgentModel {
	const chat = new ChatOpenAI({
		model: options.model,
		apiKey: options.apiKey,
		configuration: options.baseURL !== undefined ? { baseURL: options.baseURL } : undefined,
		temperature: options.temperature,
	});
	return {
		id: options.model,
		name: options.model,
		provider: "openai",
		api: "langchain-openai",
		...(options.baseURL !== undefined ? { baseUrl: options.baseURL } : {}),
		reasoning: false,
		input: ["text", "image"],
		contextWindow: options.contextWindow ?? 131_072,
		maxTokens: options.maxTokens ?? 8_192,
		chat,
	};
}

export interface AnthropicModelOptions {
	model: string;
	apiKey?: string;
	temperature?: number;
	/** Context window in tokens. Default 200000. */
	contextWindow?: number;
	/** Max output tokens. Default 8192. */
	maxTokens?: number;
}

/** Anthropic Messages wire API (the anthropic-messages adapter's counterpart). */
export function createAnthropicModel(options: AnthropicModelOptions): AgentModel {
	const chat = new ChatAnthropic({
		model: options.model,
		apiKey: options.apiKey,
		temperature: options.temperature,
	});
	return {
		id: options.model,
		name: options.model,
		provider: "anthropic",
		api: "langchain-anthropic",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: options.contextWindow ?? 200_000,
		maxTokens: options.maxTokens ?? 8_192,
		chat,
	};
}

export interface GoogleModelOptions {
	model: string;
	apiKey?: string;
	temperature?: number;
	/** Context window in tokens. Default 1048576. */
	contextWindow?: number;
	/** Max output tokens. Default 65536. */
	maxTokens?: number;
}

/** Google Generative AI wire API (the google-generative-ai adapter's counterpart). */
export function createGoogleModel(options: GoogleModelOptions): AgentModel {
	const chat = new ChatGoogleGenerativeAI({
		model: options.model,
		apiKey: options.apiKey,
		temperature: options.temperature,
	});
	return {
		id: options.model,
		name: options.model,
		provider: "google",
		api: "langchain-google",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: options.contextWindow ?? 1_048_576,
		maxTokens: options.maxTokens ?? 65_536,
		chat,
	};
}

/** OpenAI Responses wire API (the openai-responses adapter's counterpart). */
export function createOpenAIResponsesModel(options: OpenAIModelOptions): AgentModel {
	const chat = new ChatOpenAIResponses({
		model: options.model,
		apiKey: options.apiKey,
		configuration: options.baseURL !== undefined ? { baseURL: options.baseURL } : undefined,
		temperature: options.temperature,
	});
	return {
		id: options.model,
		name: options.model,
		provider: "openai",
		api: "langchain-openai-responses",
		...(options.baseURL !== undefined ? { baseUrl: options.baseURL } : {}),
		reasoning: true,
		input: ["text", "image"],
		contextWindow: options.contextWindow ?? 131_072,
		maxTokens: options.maxTokens ?? 8_192,
		chat,
	};
}

/** Assemble a LangChain AIMessageChunk from a scripted pi AssistantMessage. */
export function assistantToChunk(message: AssistantMessage): AIMessageChunk {
	const text = message.content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
	const thinking = message.content
		.filter((block): block is Extract<typeof block, { type: "thinking" }> => block.type === "thinking")
		.map((block) => block.thinking)
		.join("");
	const toolCalls = message.content
		.filter((block): block is PiToolCall => block.type === "toolCall")
		.map((block) => ({ id: block.id, name: block.name, args: block.arguments as Record<string, unknown> }));
	const finishReason =
		message.stopReason === "toolUse" ? "tool_calls" : message.stopReason === "length" ? "length" : "stop";
	return new AIMessageChunk({
		content: text,
		...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		...(thinking.length > 0 ? { additional_kwargs: { reasoning_content: thinking } } : {}),
		usage_metadata: {
			input_tokens: message.usage.input,
			output_tokens: message.usage.output,
			total_tokens: message.usage.totalTokens || message.usage.input + message.usage.output,
			...(message.usage.cacheRead > 0 || message.usage.cacheWrite > 0
				? {
						input_token_details: {
							...(message.usage.cacheRead > 0 ? { cache_read: message.usage.cacheRead } : {}),
							...(message.usage.cacheWrite > 0 ? { cache_creation: message.usage.cacheWrite } : {}),
						},
					}
				: {}),
		},
		response_metadata: { finish_reason: finishReason },
	});
}

interface ScriptedChatModelFields {
	responses: AssistantMessage[];
}

/**
 * A chat model that replays a fixed script of pi AssistantMessages: the first
 * call returns responses[0], the second responses[1], ... (tool calls
 * included; beyond the script it keeps returning the last response). Ignores
 * bound tools — the script is authoritative, like pico's scripted stream
 * functions.
 */
class ScriptedChatModel extends BaseChatModel<BaseChatModelCallOptions, AIMessageChunk> {
	readonly scriptedResponses: AssistantMessage[];
	private index = 0;

	constructor(fields: ScriptedChatModelFields) {
		super({});
		this.scriptedResponses = fields.responses;
	}

	_llmType(): string {
		return "scripted";
	}

	bindTools(
		_tools: BindToolsInput[],
		_kwargs?: Partial<BaseChatModelCallOptions>,
	): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
		// The script decides tool calls; bound tool specs are ignored.
		return this as unknown as Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions>;
	}

	private next(): AssistantMessage {
		const message = this.scriptedResponses[Math.min(this.index, this.scriptedResponses.length - 1)]!;
		if (this.index < this.scriptedResponses.length - 1) this.index++;
		return message;
	}

	async _generate(
		_messages: BaseMessage[],
		_options?: BaseChatModelCallOptions,
		_runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		const chunk = assistantToChunk(this.next());
		return { generations: [{ text: "", message: new AIMessage({ content: chunkContentText(chunk) }) }] };
	}

	async *_streamResponseChunks(
		_messages: BaseMessage[],
		_options?: BaseChatModelCallOptions,
		_runManager?: CallbackManagerForLLMRun,
	): AsyncGenerator<ChatGenerationChunk> {
		yield new ChatGenerationChunk({ message: assistantToChunk(this.next()), text: "" });
	}
}

function chunkContentText(chunk: AIMessageChunk): string {
	const content = chunk.content;
	return typeof content === "string" ? content : "";
}

export interface ScriptedModelOptions {
	/** Model id recorded on assistant messages and session snapshots. Default "scripted". */
	id?: string;
	/** Script: one AssistantMessage per model call, tool calls included. */
	responses: AssistantMessage[];
	/** Context window reported to compaction. Default 131072. */
	contextWindow?: number;
}

/** Keyless scripted model: the model side of pico-agent's verify pattern. */
export function createScriptedModel(options: ScriptedModelOptions): AgentModel {
	const id = options.id ?? "scripted";
	return {
		id,
		name: id,
		provider: "scripted",
		api: "langchain-scripted",
		reasoning: false,
		input: ["text"],
		contextWindow: options.contextWindow ?? 131_072,
		maxTokens: 8_192,
		chat: new ScriptedChatModel({ responses: options.responses }),
	};
}

class UnavailableChatModel extends BaseChatModel<BaseChatModelCallOptions, AIMessageChunk> {
	_llmType(): string {
		return "unavailable";
	}

	async _generate(): Promise<ChatResult> {
		throw new Error("No model configured: pass initialState.model or restore a session with a model.");
	}

	async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
		throw new Error("No model configured: pass initialState.model or restore a session with a model.");
	}
}

/** Placeholder for agents constructed without a model; any run fails with a clear error. */
export function createUnavailableModel(): AgentModel {
	return {
		id: "unknown",
		name: "unknown",
		provider: "unknown",
		api: "unknown",
		baseUrl: "",
		reasoning: false,
		input: [],
		contextWindow: 0,
		maxTokens: 0,
		chat: new UnavailableChatModel({}),
	};
}
