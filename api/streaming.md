# Streaming

## `StreamFn` — the provider contract

One function per host; the agent calls it once per turn.

```typescript
type StreamFn = (
	model: Model<any>,
	context: TranscriptContext,   // { systemPrompt?, tools?, messages }
	options?: SimpleStreamOptions,
) => Promise<EventStream<ProviderEvent, AssistantMessage>>;
```

The returned `EventStream` ends with either an error event or a `done` event whose value is the final `AssistantMessage` (carrying `usage` and `stopReason`).

### Real provider wiring

```typescript
import { createModels, deepseekProvider } from "pico-agent";

const models = createModels();
models.setProvider(deepseekProvider());
const streamFn = models.streamSimple.bind(models);   // that's the whole StreamFn
```

### Scripted (keyless) — tests and fixtures

The pattern every `examples/verify-*.ts` suite uses: push a synthetic assistant message through an `EventStream`.

```typescript
import { EventStream, type AssistantMessage, type StreamFn } from "pico-agent";

const fakeModel = { id: "mock", api: "anthropic-messages", provider: "mock" } as never;

function scriptedStreamFn(message: AssistantMessage): StreamFn {
	return async (_model, _context, opts) => {
		const stream = new EventStream<never, never>(
			(e) => (e as { type: string }).type === "done",
			(e) => (e as { message: AssistantMessage }).message as never,
		);
		// Abort contract: honor the signal by ending with stopReason "aborted".
		if (opts?.signal?.aborted) {
			return stream as never;
		}
		const push = (event: unknown) => stream.push(event as never);
		push({ type: "start", partial: message });
		push({ type: "message", message });
		push({ type: "done", message, stopReason: message.stopReason });
		stream.end();
		return stream as never;
	};
}
```

The same result with zero wiring: the bundled `fauxProvider` (see [ai.md](ai.md)).

**Abort contract**: on `options.signal` abort, end the stream with an empty assistant message with `stopReason: "aborted"` — the loop never pre-checks the signal between turns, the stream function owns this path.

## Default stream function

```typescript
import { getDefaultStreamFn, setDefaultStreamFn } from "pico-agent";

setDefaultStreamFn(models.streamSimple.bind(models));
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

## `SimpleStreamOptions` (highlights)

`apiKey`, `signal`, `maxTokens`, `temperature`, `samplingParams`, `timeoutMs`, `headers`, `fetch`, `transport`, `maxRetries`, `maxRetryDelayMs`, `onPayload`, `onResponse`, `onProviderStreamEvent`, `sessionId`, `metadata`, `cacheRetention`.
