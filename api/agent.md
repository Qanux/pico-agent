# Agent core

The prompt → LLM → tool loop engine. One `Agent` instance per conversation; each `prompt()` runs turns until the model stops issuing tool calls.

## Construction

```typescript
import {
	Agent,
	createModels,
	anthropicProvider,
	createBashTool,
	createReadTool,
	harnessToolToAgentTool,
	NodeExecutionEnv,
} from "pico-agent";

const models = createModels();
models.setProvider(anthropicProvider());            // register the providers you use
const model = models.getModel("anthropic", "claude-sonnet-4-5")!;

const env = new NodeExecutionEnv({ cwd: "/tmp" });
const toolContext = { env };
const tools = [
	harnessToolToAgentTool(createReadTool(), toolContext),
	harnessToolToAgentTool(createBashTool(), toolContext),
];

const agent = new Agent({
	initialState: {
		systemPrompt: "You are a coding assistant.",
		model,                        // required for real use
		thinkingLevel: "high",        // "off" | "minimal" | "low" | "medium" | "high" | ...
		tools,
	},
	streamFn: models.streamSimple.bind(models),  // the provider request function
});

await agent.prompt("List the files in /tmp and read the first one.");
```

`initialState.systemPrompt` and `initialState.tools` are encoded into the transcript's leading **system message** — they are not stored separately. Supplying `initialState.messages` that already starts with a system message (e.g. a restored session) skips that seeding.

## Methods

### `prompt()` — run the loop

```typescript
await agent.prompt("What files are here?");                        // string
await agent.prompt("Describe this image.", [imageContent]);        // string + images
await agent.prompt({ role: "user", content: "hi", timestamp: Date.now() }); // AgentMessage
```

Throws if a run is already active — use `steer()` / `followUp()` to queue instead.

### `continue()` — resume from the transcript tail

```typescript
// After restoring a session saved mid-turn (unpaired tool calls were repaired
// at save time), or after manually appending a user message:
await agent.continue();
```

The last transcript message must be a user or toolResult message.

### `steer()` / `followUp()` — queue while running

```typescript
agent.subscribe(async (event) => {
	if (event.type === "turn_end") {
		// Mid-run course correction — delivered into the CURRENT run:
		agent.steer({ role: "user", content: "also check /var/log", timestamp: Date.now() });
		// Or queue for AFTER the current run:
		agent.followUp({ role: "user", content: "now summarize", timestamp: Date.now() });
	}
});
await agent.prompt("audit the system");
```

Queue semantics: `agent.steeringMode = "all"` delivers every queued message; `"one-at-a-time"` (default) keeps only the latest. Same for `followUpMode`.

### `abort()` — cancel the active run

```typescript
const controller = new AbortController();
setTimeout(() => agent.abort(), 30_000);   // hard 30s budget
await agent.prompt("long-running task");
```

Signals the active stream call and every running tool execution. The run ends with a synthetic assistant message with `stopReason: "aborted"` (cooperative — tools and stream functions must honor `agent.signal`).

### `subscribe()` — observe events

```typescript
const unsubscribe = agent.subscribe((event) => {
	switch (event.type) {
		case "message_update":
			if (event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			}
			break;
		case "tool_execution_start":
			console.log(`[tool] ${event.toolName}`, event.args);
			break;
		case "tool_execution_end":
			if (event.isError) console.error(`[tool] ${event.toolName} failed`);
			break;
		case "agent_end":
			console.log("\nusage:", JSON.stringify(/* from last assistant message */ {}));
			break;
	}
	unsubscribe();   // the listener may unsubscribe itself
});
```

### `state` — the `AgentState` snapshot

```typescript
const { messages, model, thinkingLevel, tools } = agent.state;
console.log(agent.state.systemPrompt);        // replayed from transcript system messages

// Mid-session swaps are first-class:
agent.state.model = otherModel;
agent.state.thinkingLevel = "low";
agent.state.tools = [read, write];            // assigning copies the array; the diff vs the
                                              // transcript's declared tools is announced to the
                                              // model via a system message automatically
```

`agent.state.messages` **is** the session format — `serializeSession` (see [session.md](session.md)) persists it verbatim.

## `AgentOptions`

Everything the constructor accepts. `initialState` + `streamFn` are the essentials.

| Option | Type | Description |
|---|---|---|
| `initialState` | `AgentInitialState` | Seeds `AgentState`: `systemPrompt`, `model`, `thinkingLevel`, `tools`, `messages`. |
| `streamFn` | `StreamFn` | Provider request function (see [streaming.md](streaming.md)). Typed as required; at runtime an omitted `streamFn` falls back to the module default (`setDefaultStreamFn`). |
| `convertToLlm` | `(messages: AgentMessage[]) => Message[]` | Transcript → provider messages. Default: identity filter over the four roles. |
| `transformContext` | `(messages, signal?) => Promise<AgentMessage[]>` | Runs before every request. Where `autoCompaction` hooks in. |
| `getApiKey` | `(provider: string) => string \| undefined \| Promise<...>` | Key resolution per provider. |
| `beforeToolCall` / `afterToolCall` | hooks | Intercept tool executions (allow/deny/modify). |
| `prepareRequest` | hook | Inspect/modify the outgoing request (post-transform). |
| `prepareNextTurn` / `prepareNextTurnWithContext` | hooks | Inject turn updates between turns. |
| `finishTurn` | hook | Called after each completed turn. |
| `onPayload` / `onResponse` / `onProviderStreamEvent` | hooks | Raw provider wire-level observability. |
| `steeringMode` / `followUpMode` | `QueueMode` | Queue semantics: `"all"` or `"one-at-a-time"`; default `"one-at-a-time"`. |
| `sessionId` | `string` | Echoed to providers supporting it. |
| `thinkingBudgets` | `ThinkingBudgets` | Per-level token budgets when the model needs explicit budgets. |
| `transport` | `Transport` | Custom fetch layer; default `"auto"`. |
| `maxRetryDelayMs` | `number` | Cap for provider-requested retry delays (default 60000; 0 = unlimited). Retries themselves are opt-in — see `retryProviderRequest` in [ai.md](ai.md). |
| `toolExecution` | `ToolExecutionMode` | Default tool concurrency: `"sequential"` or `"parallel"`; default `"parallel"`. |

## `AgentEvent` variants

| Variant | Payload highlights |
|---|---|
| `agent_start` / `agent_end` | `agent_end` carries the final `messages`. |
| `turn_start` / `turn_end` | `turn_end` carries the assistant `message` + its `toolResults`. |
| `message_start` / `message_update` / `message` | Streaming deltas: `text_delta`, `thinking_delta`, tool-call frames. |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | `toolCallId`, `toolName`, `args`, `isError`. |
| `queue_status_changed` | Queued steering/follow-ups changed. |
