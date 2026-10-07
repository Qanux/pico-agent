# AI slice

Vendored subset of pi-ai v0.87.1: core types, the models registry, 18 providers over 4 protocol adapters, auth, and utilities. All re-exported from the package root.

## Types — the message model

```typescript
type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
```

```typescript
// System messages carry prompt + tool declarations over time:
const system: SystemMessage = {
	role: "system",
	content: "You are a coding assistant.",       // leading message = base prompt
	// sections?: Record<string, string | null>,   // named prompt sections, replaced by name
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
	api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
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

Other type exports: `Model<TApi>` (`{ id, name, api, provider, baseUrl?, reasoning, input, cost, contextWindow, maxTokens }`), `TranscriptContext`, `SimpleStreamOptions`, `Usage`, `ThinkingLevel`, `ThinkingBudgets`, per-API option types (`AnthropicOptions`, `OpenAIResponsesOptions`, `OpenAICompletionsOptions`, `GoogleOptions`), JSON types, and typebox vocabulary (`Type`, `Static<T>`, `TSchema`).

## Models registry

Providers do **not** self-register — wire the ones you use:

```typescript
import { createModels, deepseekProvider, openaiProvider } from "pico-agent";

const models = createModels();
models.setProvider(deepseekProvider());
models.setProvider(openaiProvider());

const model = models.getModel("deepseek", "deepseek-flash");
const allChat = models.getModels();                          // every registered provider
const usable = await models.getAvailable();                  // auth-complete only
```

Request entry points: `streamSimple(model, context, options)` (the `StreamFn` backbone — `models.streamSimple.bind(models)`), `completeSimple(...)` (one-shot, resolves the final `AssistantMessage`), `stream`, `streamDeferred`, `generateImages`, `classify`.

```typescript
const message = await models.completeSimple(model, {
	systemPrompt: "Translate to French.",
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});
```

Dynamic catalogs refresh with `models.refresh({ providers: [...] })`; errors return without rejecting.

## Providers (18 factories)

`anthropicProvider`, `openaiProvider`, `googleProvider`, `xaiProvider`, `zaiProvider`, `zaiCodingCnProvider`, `minimaxProvider`, `minimaxCnProvider`, `moonshotaiProvider`, `moonshotaiCnProvider`, `xiaomiProvider`, `xiaomiTokenPlanCnProvider`, `xiaomiTokenPlanSgpProvider`, `xiaomiTokenPlanAmsProvider`, `qwenTokenPlanProvider`, `qwenTokenPlanCnProvider`, `qwenTokenPlanIndividualProvider`, `deepseekProvider`.

Each returns a `Provider` with a static model catalog (chat; several also ship images/classifiers). The 4 adapters underneath: anthropic-messages, openai-responses, openai-completions, google-generative-ai.

### `fauxProvider` — scripted provider for tests

```typescript
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "pico-agent";

const handle = fauxProvider({ models: [{ id: "mock-1" }] });
handle.setResponses([
	fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
	fauxAssistantMessage("done", { stopReason: "stop" }),
]);

const models = createModels();
models.setProvider(handle.provider);
const model = handle.getModel();   // the registered mock model
```

In-process, keyless, no network — the same technique the `examples/verify-*.ts` suites use. `appendResponses` adds more steps; responses can also be factories (`() => AssistantMessage`) for dynamic scripts.

## Auth

```typescript
const auth = await models.getAuth(model);            // resolved key / credential / undefined
await models.login("anthropic", "oauth", interaction); // provider-owned OAuth flow
await models.logout("anthropic");
```

API keys resolve from environment variables (`envApiKeyAuth`) or per-request via `Agent`'s `getApiKey` / `SimpleStreamOptions.apiKey`. Credential stores are injectable (`CredentialStore` interface; in-memory default).

## Utilities (highlights)

```typescript
import {
	estimateContextTokens, estimateMessageTokens, retryProviderRequest,
	normalizeContext, contentText, uuidv7, EventStream,
} from "pico-agent";

// Context-size estimate: provider usage when available + char-based trailing estimate.
const { tokens } = estimateContextTokens(agent.state.messages);

// SDK-style retry (408/409/429/5xx, x-should-retry, retry-after honored) with
// abortable backoff. maxRetries defaults to 0 — retrying is opt-in.
const message = await retryProviderRequest(
	() => models.completeSimple(model, context),
	{ maxRetries: 3, maxRetryDelayMs: 30_000, signal },
);

// Fold { systemPrompt, tools, messages } into a TranscriptContext (leading system message).
const transcript = normalizeContext({ systemPrompt, tools, messages });

// Text extraction from any content shape.
const text = contentText(message.content);

const id = uuidv7();   // time-ordered UUID
```
