# Loop functions

The headless engine under `Agent`. Reach for these directly when you orchestrate runs yourself; `Agent` wraps them with queueing, events, abort plumbing, and state.

## `agentLoop` / `agentLoopContinue` — event-stream variant

Returns an `EventStream<AgentEvent, AgentMessage[]>`: consume events as they happen, `await` the stream's result for the final transcript.

```typescript
import { agentLoop, EventStream, type AgentContext, type AgentLoopConfig } from "pico-agent";

const context: AgentContext = { systemPrompt: "You verify things.", tools: [], messages: [] };
const config: AgentLoopConfig = { model, /* ...SimpleStreamOptions */ };

const stream = agentLoop(
	[{ role: "user", content: "check the build", timestamp: Date.now() }], // prompts
	context,
	config,
	undefined,            // AbortSignal | undefined
	streamFn,             // your StreamFn
);
for await (const event of stream) {
	if (event.type === "turn_end") console.log("turn done");
}
const finalMessages = await stream.result();
```

`agentLoopContinue(context, config, signal, streamFn)` is the same without prompts — it continues from the existing `context.messages` tail (e.g. after repairing an interrupted turn).

## `runAgentLoop` / `runAgentLoopContinue` — awaitable variant

Same semantics, events pushed into your sink; resolves with the final transcript.

```typescript
import { runAgentLoop, type AgentEventSink } from "pico-agent";

const emit: AgentEventSink = (event) => {
	if (event.type === "tool_execution_end" && event.isError) {
		console.error("tool failed:", event.toolName);
	}
};

const messages = await runAgentLoop(
	prompts,   // AgentMessage[]
	context,
	config,
	emit,      // event sink
	signal,    // AbortSignal | undefined
	streamFn,
);
```

## `AgentLoopConfig`

`AgentLoopConfig extends SimpleStreamOptions` — the request options (`apiKey`, `signal`, `maxTokens`, `temperature`, `timeoutMs`, `headers`, `fetch`, …) plus:

| Field | Description |
|---|---|
| `model: Model<any>` | The model for the run. |
| `convertToLlm` | Transcript → provider messages. Must not throw; return a safe fallback instead. |
| `transformContext` | Rewrite the transcript before each request (compaction hooks in here). |
| `beforeToolCall` / `afterToolCall` | Tool interception. |
| `prepareRequest` / `prepareNextTurn` | Request inspection / between-turn injection. |
| `finishTurn` | After each completed turn. |

These are the documented "adaptation seams": every injectable step of the loop lives on `AgentLoopConfig`, and `AgentOptions` mirrors them 1:1 for the wrapped experience.
