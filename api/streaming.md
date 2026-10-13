# Streaming

## `StreamFn` — the provider contract

One function per host; the agent calls it once per turn.

```typescript
type StreamFn = (
	model: AgentModel,
	context: TranscriptContext,   // { systemPrompt?, tools?, messages }
	options?: StreamFnOptions,
) => Promise<EventStream<ProviderEvent, AssistantMessage>>;
```

The returned `EventStream` ends with either an error event or a `done` event whose value is the final `AssistantMessage` (carrying `usage` and `stopReason`).

### Real provider wiring — the LangChain bridge

```typescript
import { createAnthropicModel, createModelStreamFn } from "pico-agent";

const model = createAnthropicModel({ model: "claude-sonnet-4-5" });
const streamFn = createModelStreamFn();   // that's the whole StreamFn
```

The bridge maps the transcript to LangChain messages (`transcriptToLangChainMessages`), binds the agent's tools as JSON-Schema declarations, streams `tool_call_chunks` back into assembled pi tool calls, and honors `options.signal` — see [ai.md](ai.md).

### Scripted (keyless) — tests and fixtures

The predecessor scripted the *stream function*; here the script lives at the *model*: `createScriptedModel` replays a fixed list of `AssistantMessage`s through the real bridge, so the LangChain mapping itself is under test too.

```typescript
import { createModelStreamFn, createScriptedModel } from "pico-agent";

const model = createScriptedModel({
	responses: [
		{ role: "assistant", /* …toolCall block, stopReason "toolUse"… */ },
		{ role: "assistant", /* …text block, stopReason "stop"… */ },
	],
});
const agent = new Agent({
	initialState: { systemPrompt, model, tools },
	streamFn: createModelStreamFn(),
});
```

Beyond the script it keeps returning the last response. The pattern every `examples/verify-*.ts` suite uses.

**Abort contract**: on `options.signal` abort, the stream ends with an empty assistant message with `stopReason: "aborted"` — the loop never pre-checks the signal between turns, the stream function owns this path.

## Default stream function

```typescript
import { getDefaultStreamFn, setDefaultStreamFn } from "pico-agent";

setDefaultStreamFn(createModelStreamFn());
// Agents constructed without a runtime streamFn now use it:
const agent = new Agent({ initialState: { model, tools: [] } });   // falls back at runtime
const current = getDefaultStreamFn();
```

## `streamProxy(model, context, options)` — server-routed traffic

For apps that route LLM calls through their own server: the server holds auth and provider credentials; events stream back with partial fields stripped to reduce bandwidth. Call shape matches a `StreamFn` invocation, so it drops into a custom `streamFn`:

```typescript
import { streamProxy } from "pico-agent";

const streamFn = async (model, context, options) =>
	streamProxy(model, context, { ...options /* apiKey lives server-side */ });
```

## `StreamFnOptions` (highlights)

`signal`, `temperature`, `maxTokens`, `reasoning` (`"minimal" | "low" | "medium" | "high" | "xhigh" | "max"`), `sessionId`, `apiKey`.
