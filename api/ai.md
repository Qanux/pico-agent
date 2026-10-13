# Model layer

The predecessor vendored pi-ai's provider catalog (18 providers over 4 wire adapters). This SDK replaces it with LangChain: an `AgentModel` pairs a `@langchain/*` chat model with the catalog metadata the agent core reads (`contextWindow` drives compaction, `id` rides in session snapshots). No registry, no auth subsystem — bring your own chat model.

## `AgentModel` and the factories

```typescript
import {
	createOpenAIModel,        // any OpenAI-compatible endpoint (OpenAI, DeepSeek, vLLM, ...)
	createAnthropicModel,     // Anthropic Messages API
	createGoogleModel,        // Google Generative AI
	createOpenAIResponsesModel, // OpenAI Responses API
} from "pico-agent";

const model = createOpenAIModel({
	model: "deepseek-chat",
	baseURL: "https://api.deepseek.com/v1",   // apiKey: pass explicitly or let env vars speak
	contextWindow: 131_072,   // default 131072
	maxTokens: 8_192,         // default 8192
	temperature: 0,
});
```

| Factory | Wire API | `contextWindow` default | Notes |
|---|---|---|---|
| `createOpenAIModel` | openai-completions | 131072 | `reasoning: false`; `baseURL` for any compatible endpoint |
| `createOpenAIResponsesModel` | openai-responses | 131072 | `reasoning: true` |
| `createAnthropicModel` | anthropic-messages | 200000 | `reasoning: true` |
| `createGoogleModel` | google-generative-ai | 1048576 | `reasoning: true`; `maxTokens` default 65536 |

Every factory accepts `model`, `apiKey?`, `temperature?`, `contextWindow?`, `maxTokens?` (OpenAI ones also `baseURL?`).

### `createScriptedModel` — keyless replay for tests

```typescript
import { createScriptedModel } from "pico-agent";

const model = createScriptedModel({
	id: "verify",                     // default "scripted"
	contextWindow: 4_096,             // as reported to compaction
	responses: [                      // one AssistantMessage per model call
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { ... } }], usage, stopReason: "toolUse", ... },
		{ role: "assistant", content: [{ type: "text", text: "done" }], usage, stopReason: "stop", ... },
	],
});
```

The first call returns `responses[0]`, the second `responses[1]`, …; beyond the script it keeps returning the last response. Bound tool declarations are ignored — the script is authoritative. This is the model side of every `examples/verify-*.ts` suite (the predecessor scripted the stream function instead; scripting the model also exercises the LangChain mapping).

`createUnavailableModel()` is the placeholder for agents constructed without a model — any run fails with "No model configured". `assistantToChunk(message)` assembles a LangChain `AIMessageChunk` from a pi `AssistantMessage` (the scripted model's building block, exported for custom fixtures).

## The bridge

```typescript
import { createModelStreamFn } from "pico-agent";

const streamFn = createModelStreamFn();   // (model, context, options) => stream
```

One bridge serves every `AgentModel`. Per turn it:

1. maps the transcript with `transcriptToLangChainMessages(context)` — system messages collapse into one leading message, images become `image_url` data URLs;
2. binds the context's tools as JSON-Schema declarations (`bindTools`);
3. streams chunks back, reassembling streamed `tool_call_chunks` into pi `toolCall` blocks and `reasoning_content` into `thinking` blocks;
4. honors `options.signal` (abort ends the stream with `stopReason: "aborted"`) and applies `options.maxTokens` / `temperature` when set.

`transformMessages(messages, options?)` repairs a transcript for replay across models: strips `thoughtSignature` from tool calls crossing models, optionally normalizes provider-illegal tool call IDs (rewriting the matching results), drops errored/aborted turns, and synthesizes error tool results for orphaned tool calls so "every call must be answered" holds. Session restore uses it to make any snapshot a valid request.

## Thinking budgets and clamps

```typescript
import {
	DEFAULT_THINKING_BUDGETS,   // per-level token budgets
	thinkingBudgetForLevel,     // (level, customBudgets?) => number
	clampReasoning,             // clamp a requested level to what the model supports
	clampThinkingBudgetToAnswerRoom, // never spend the whole window on thinking
	adjustMaxTokensForThinking, // raise maxTokens to fit a thinking budget
	clampMaxTokensToContext,    // (model, context, maxTokens) => fits the window
	MIN_ANSWER_TOKENS,          // 1024 — the floor the clamps defend
} from "pico-agent";
```

The bridge applies these automatically; they are exported for hosts doing their own request math.

## Types — the message model

```typescript
type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
```

```typescript
// System messages carry prompt + tool declarations over time:
const system: SystemMessage = {
	role: "system",
	content: "You are a coding assistant.",       // leading message = base prompt
	// toolsAdded?: Tool[], toolsRemoved?: ToolReference[],
	timestamp: 0,
};

const user: UserMessage = {
	role: "user",
	content: "read the config",                    // string | (TextContent | ImageContent)[]
	timestamp: Date.now(),
};

const assistant: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "…" },
		{ type: "text", text: "Reading it now." },
		{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "config.json" } },
	],
	api: "langchain-openai", provider: "openai", model: "deepseek-chat",
	usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
			 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",                          // "pending"|"stop"|"length"|"toolUse"|"error"|"aborted"|"deferred"
	timestamp: Date.now(),
};

const toolResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call-1",                           // pairs with the toolCall by id
	toolName: "read",
	content: [{ type: "text", text: '{ "port": 8080 }' }],
	isError: false,
	timestamp: Date.now(),
};
```

Other type exports: `AgentModel`, `TranscriptContext`, `StreamFnOptions`, `Usage`, `ThinkingLevel`, `ThinkingBudgets`, `ConstrainedSamplingConfig`, JSON types.

## Events

`EventStream<TEvent, TResult>` — push events, `end()` with a result; consumers iterate or `await stream.result()`. `AssistantMessageEventStream` / `createAssistantMessageEventStream` specialize it for streaming assistant-message assembly (`text_delta`, `thinking_delta`, tool-call frames). The abort contract: end with an empty message, `stopReason: "aborted"`.

## Utilities (highlights)

```typescript
import {
	estimateContextTokens, estimateMessageTokens, calculateContextTokens,
	contentText, getSystemMessageText, renderSystemMessageUpdate,
	normalizeContext, collapseSystemMessages, getCurrentSystemPrompt,
	parseStreamingJson, parseJsonWithRepair, repairJson,
	validateToolArguments, validateToolCall,
} from "pico-agent";

// Context-size estimate: provider usage when available + char-based trailing estimate.
const { tokens } = estimateContextTokens(agent.state.messages);

// Fold { systemPrompt, tools, messages } into a TranscriptContext (leading system message).
const transcript = normalizeContext({ systemPrompt, tools, messages });

// Text extraction from any content shape.
const text = contentText(message.content);

// Streaming-tolerant JSON (tool arguments that arrive in fragments).
const args = parseStreamingJson(chunkSoFar);

// Schema validation of model-issued tool calls before execution.
const verdict = validateToolCall(toolCall, tool);
```

## What the predecessor had that this layer does not

No `createModels` registry, no 18 provider factories, no OAuth/auth store, no `completeSimple`/`generateImages`/`classify`, no `retryProviderRequest`. Providers are whatever LangChain speaks; auth is the chat model's own (`apiKey` in the factory or the provider's env variable); one-shot completion is one `agent.prompt()` away.
