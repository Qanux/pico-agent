# pico-agent

Minimal agent runtime SDK — the pico agent runtime with the LLM substrate
replaced by **LangChain chat models**. Core agent code (loop, harness,
message model) is vendored from
[earendil-works/pi](https://github.com/earendil-works/pi) v0.87.1
(source-level, MIT license, see `LICENSE`); auto-compaction, session
persistence, subagents, and the todo tool are original to this SDK; the
provider layer is new: any LangChain chat model plugs in through a stream
bridge that keeps pi's message model and event protocol byte-compatible.

TypeScript, Node >= 22.19 running `.ts` natively, no build step. Import
everything from the package name:

```ts
import { Agent, createModelStreamFn } from "pico-agent";
```

Three parts:

| Part | Origin | Contents |
|------|--------|----------|
| `src/agent/` | pi `packages/agent/src` core layer, verbatim port | Agent loop (`agent-loop.ts`), `Agent` class, `streamProxy`, types |
| `src/agent/harness/` | pi harness subset (verbatim) + original tools | bash / read / write / edit + `NodeExecutionEnv` (pi); subagent + todo tools (original) |
| `src/ai/` | pi-ai slice (verbatim) + new bridge | pi message model, transcript repair, clamps/budgets; the LangChain stream bridge and model factories |

## Models

There is no provider catalog. An `AgentModel` wraps one LangChain chat model
plus the metadata the loop needs (id, provider, context window); four
factories cover the wire protocols pi shipped adapters for:

| Factory | LangChain class | Use for |
|---------|-----------------|---------|
| `createOpenAIModel` | `ChatOpenAI` | OpenAI and any OpenAI-compatible endpoint (`baseURL`: DeepSeek, GLM, Kimi, Qwen, xAI, …) |
| `createOpenAIResponsesModel` | `ChatOpenAIResponses` | OpenAI Responses API |
| `createAnthropicModel` | `ChatAnthropic` | Anthropic Messages API |
| `createGoogleModel` | `ChatGoogleGenerativeAI` | Google Gemini |

Any other `BaseChatModel` (including your own subclass) works — assign it to
`AgentModel.chat`. `createScriptedModel({ responses })` replays scripted
`AssistantMessage`s for keyless tests; `createUnavailableModel()` is the
placeholder. Reasoning levels arrive per request as `reasoning`, thinking
budgets and maxTokens are clamped exactly like pi's `simple-options`.

## Quick start

```bash
npm install
npm run verify   # 366 keyless checks: ten suites, no API keys needed
npm run demo     # real-model example (requires DEEPSEEK_API_KEY)
```

## Usage

```ts
import {
	Agent,
	createModelStreamFn,
	createOpenAIModel,
	harnessToolToAgentTool,
	createBashTool,
	createReadTool,
	createWriteTool,
	createEditTool,
	NodeExecutionEnv,
} from "pico-agent";

// 1. Model: any OpenAI-compatible endpoint, or the Anthropic/Google factories
const model = createOpenAIModel({
	model: "deepseek-chat",
	baseURL: "https://api.deepseek.com",
	apiKey: process.env.DEEPSEEK_API_KEY,
});

// 2. Tools: harness tool + execution env → core AgentTool
const env = new NodeExecutionEnv({ cwd: process.cwd() });
const toolContext = { env };

// 3. Agent: a single prompt() runs the LLM → tools → LLM loop to completion
const agent = new Agent({
	initialState: {
		systemPrompt: "You are a coding assistant.",
		model,
		tools: [
			harnessToolToAgentTool(createReadTool(), toolContext),
			harnessToolToAgentTool(createWriteTool(), toolContext),
			harnessToolToAgentTool(createEditTool(), toolContext),
			harnessToolToAgentTool(createBashTool(), toolContext),
		],
	},
	streamFn: createModelStreamFn(),
});

agent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
	if (event.type === "tool_execution_start") console.log(`\n[tool] ${event.toolName}`);
});

await agent.prompt("Take a look at what's in this directory");
```

Custom tools need no adapter — just a plain object satisfying the `AgentTool`
interface. Tool schemas are **zod** (pi used typebox), validated and coerced
with the same observable contract as pi's validator:

```ts
import { z } from "zod";

const myTool = {
	name: "list_files",
	label: "list_files",
	description: "List files in a directory",
	parameters: z.object({ path: z.string().optional() }),
	async execute(_id, { path = "." }) {
		const entries = await readdir(path, { withFileTypes: true });
		return { content: [{ type: "text", text: entries.map((e) => e.name).join("\n") }], details: {} };
	},
};
```

Keyless testing: `createScriptedModel` replays scripted `AssistantMessage`s
at the model layer, so tests exercise the real bridge without API keys:

```ts
const agent = new Agent({
	initialState: {
		systemPrompt: "plan",
		model: createScriptedModel({ id: "mock", responses: [/* AssistantMessages, tool calls included */] }),
		tools,
	},
	streamFn: createModelStreamFn(),
});
```

## Adaptation seams (all in `AgentLoopConfig`)

- `transformContext` — transform the context before each LLM call (trim history, inject RAG)
- `prepareRequest` / `prepareNextTurn` — swap model / thinking level per turn
- `beforeToolCall` (can intercept) / `afterToolCall` (can rewrite results)
- `finishTurn` — return `{ action: "continue" | "end" }` to control loop lifetime
- `agent.steer()` / `agent.followUp()` — interject mid-run / append after a stop
- `agent.state.tools = [...]` — swap the tool set at any time (the loop declares the delta automatically)

## Auto context compaction

`src/compaction.ts` (original code, no pi counterpart) provides
`autoCompaction()`: spread its hooks next to `streamFn` and the context is
compacted automatically before every LLM call — covering tool marathons
inside a single `prompt()`, multi-turn sessions, and mid-session model swaps:

```ts
const agent = new Agent({
	initialState: { systemPrompt, model, tools },
	streamFn: createModelStreamFn(),
	...autoCompaction({
		model,                       // kept fresh via prepareRequest afterwards
		maxContextTokens: 200_000,   // optional; default 131_072 (128K)
		threshold: 0.75,             // trigger fraction of the effective window
		keepRecentTurns: 6,          // recent assistant turns kept verbatim
		onCompaction: (s) => console.log(`[compact] ${s.before} -> ${s.after}`),
	}),
});
```

Effective window = `min(maxContextTokens ?? 131_072, model.contextWindow ?? 131_072)` —
the default cap is 128K; raise `maxContextTokens` for large-window models. The
cut sits right before an assistant message, so toolCall/toolResult pairs are
never split. Compaction is request-scoped: the durable transcript
(`agent.state.messages`) keeps the full record and is never rewritten — once a
summary exists, every outgoing request is a derived view (leading system
messages, summary, kept tail), never the raw history, so requests stay inside
the window even while the cooldown delays the next fold-in. Summarization is
incremental (a running summary plus only-new material) with a read/write/edit
file ledger carried across compactions; if the kept tail alone still exceeds
half the window, old tool results are stubbed out as a hard safety net. The
summarizer calls `model.chat.invoke` through the same transcript conversion
as the bridge; override `summarize` to change it.

## Subagents

`src/agent/harness/tools/subagent.ts` (original code, no pi counterpart)
provides `createSubagentTool()`: a single `subagent` tool that fans out to
parallel child agents. Each child is a fresh `Agent` with the parent's
current tools minus the subagent tool itself (no recursive spawning) and an
empty context — only the child's final message flows back to the parent,
head-truncated, so intermediate tool output never enters the parent
transcript:

```ts
const subagent = createSubagentTool({
	getTools: () => [bash, read, write, edit],   // parent's current tools; resolved per call
	createAgent: ({ tools, systemPrompt }) =>
		new Agent({ initialState: { systemPrompt, model, tools }, streamFn }),
	maxConcurrent: 4,        // hard cap on subagents per tool call (default 4)
	maxOutputChars: 20_000,  // head-truncation budget per child (default 20k)
	maxTurns: 50,            // turn cap per child (default 50, 0 disables)
	inactivityTimeoutMs: 300_000, // inactivity watchdog (default 5 min, 0 disables)
});
const agent = new Agent({ initialState: { systemPrompt, model, tools: [bash, read, write, edit, subagent] }, streamFn });
```

The model passes one self-contained prompt per subagent (schema default
guidance: 2, more only when the user asks; enforced cap `maxConcurrent`).
Children run concurrently, the tool call blocks until all of them finish, and
the parent's abort signal aborts every child. Results merge into one tool
result with per-child usage lines (tokens / tool calls / turns / duration); a
failed or aborted child is reported as a failed section instead of failing
the whole call.

### Stuck-child guards

Two independent factory-level gates bound a child that never finishes on its
own:

- **`maxTurns`** (default 50, 0 disables) aborts a runaway tool marathon. It
  counts completed assistant turns (`turn_end` events) and kills only when
  the capped turn still issues tool calls — a turn without tool calls is the
  child finishing naturally and never counts as a violation.
- **`inactivityTimeoutMs`** (default 300000, 0 disables) aborts total silence:
  a wall-clock watchdog armed at spawn and reset by every child event (model
  deltas, tool starts/updates/ends). A hung provider call or a
  never-settling tool fires it; a slow-but-alive child keeps resetting the
  clock and is never killed.

Kill path (both gates): the child is aborted, its loop ends before any
further tool work, and `prompt()` resolves instead of hanging. The kill
reason labels that child's FAILED section, and the reported final message
skips the empty synthetic abort marker and returns the child's last real
words. Both gates rely on cooperative abort — a host-supplied tool or stream
function that ignores the abort signal can still hang a child; the parent
run's own abort remains the escape hatch.

### Observing children

`onChildEvent(child, event)` streams every child's run to the host live —
thinking deltas, tool executions, turn boundaries, the same `AgentEvent`
vocabulary as `agent.subscribe()`, so one renderer serves parent and
children. Each delivery is stamped `{ toolCallId, prompt, index, total }`,
grouping concurrent children under the parent's `subagent` tool call; the
`createAgent` factory receives the same fields. Read-only side channel:
nothing observed enters the parent context, and there is no steering or
abort handle.

## Session persistence

`src/session.ts` (original code, no pi counterpart) saves an agent's
transcript as an immutable snapshot file and revives it in any later process:

```ts
import { createSessionStore } from "pico-agent";

const store = createSessionStore();            // default dir: .pico/sessions/
const ref = await store.save(agent, { label: "audit" });   // JSON, atomic write, never overwrites
// ... later, in another process:
const agent2 = await store.restore(ref, {     // or store.restore("<path>.json", ...)
	tools: [bash, read, write, edit],          // runtime objects are never persisted — the host rewires them
	streamFn: createModelStreamFn(),
	// model?: ...  resolveModel?: ...          // snapshot stores only a model id; resolution order:
});                                            // init.model > init.resolveModel > SessionError("model_unresolved")
await agent2.prompt("continue where we left off");
```

`ref` is a small serializable key (`id` / `label` / `savedAt` / `file` /
`stats`) — persist it anywhere; files are only the default backend. `list()`
/ `latest()` give the `--continue`-style UX, `delete(ref, { ignoreMissing })`
and `clear()` are the garbage collectors. A transcript saved mid-turn
(unpaired tool calls) is repaired at save time with synthetic error tool
results, so every snapshot on disk loads as a valid request. Unknown-file
tolerance: version-gated (`bad_version`), JSON failures map to `corrupt`,
missing files to `not_found`.

Because LangChain models are host-constructed with credentials, there is no
builtin catalog to resolve model ids from on restore — supply `model` or
`resolveModel`, or restore throws `SessionError("model_unresolved")`.

**Security note**: transcripts contain everything the tools read (possibly
secrets) — add the default directory (`.pico/sessions/`) to `.gitignore`,
sanitize before distributing snapshots, and encrypt the JSON yourself when
needed.

## Todo lists

`src/agent/harness/tools/todo.ts` (original code, no pi counterpart)
provides `createTodoTool()`: a `todo` tool the model manages itself.
`replace` submits a whole plan (with an `explanation` when re-planning),
`add`/`update`/`clear` edit it, `list` reads it back; at most one step is
`in_progress` (promotion demotes the others in the same call).

State lives in the transcript: every result snapshots the full list into
`details` (host-visible, never sent to the model), so `readTodoState(messages)`
rebuilds it from history and session persistence carries it for free:

```ts
import { createTodoTool, readTodoState } from "pico-agent";

const agent = new Agent({ initialState: { systemPrompt, model, tools: [createTodoTool()] }, streamFn });
// ... later:
const snapshot = await store.load(ref);
const restored = await store.restore(ref, {
	tools: [createTodoTool({ initialState: readTodoState(snapshot.messages) })],
	model, streamFn,
});
```

Hosts render live progress from `tool_execution_end` events
(`event.result.details.items`) or pull with `readTodoState(agent.state.messages)`;
append the exported `TODO_TOOL_GUIDANCE` to the system prompt for stricter
usage rules. State is per-instance — one tool per agent (a parent and its
subagent children must not share one).

## Remote runs (proxy)

`streamProxy` (pi's proxy stream function, ported) moves the LLM calls to a
server that manages auth and providers — pass it as `streamFn`. The request
body carries only the model's catalog metadata (the LangChain chat model
handle never crosses the wire) and the serializable options; the server's
SSE event stream is reconstructed into pi's streaming protocol client-side:

```ts
const agent = new Agent({
	initialState: { systemPrompt, model, tools },
	streamFn: (model, context, options) =>
		streamProxy(model, context, { ...options, authToken, proxyUrl: "https://genai.example.com" }),
});
```

A clean EOF without a terminal event surfaces as an error instead of hanging;
aborts propagate; partial tool-call JSON parses incrementally.

## Testing

```
npm run verify   # 366 checks, ten keyless suites
```

`verify-tools` drives the real bash/read/write/edit tools through the real
loop over the real LangChain bridge (scripted model); `verify-compaction`
(marathon in-window / elision net / incremental cache rebuild), `verify-session`
(round-trip, repair, resolution, bad files, escape guard), `verify-subagent`
(fan-out, caps, watchdogs, observability, async containment), `verify-todo`
(actions, snapshots, isolation, replay). `verify-bridge` covers the
substrate specific to this rebuild: transcript mapping, event protocol,
streaming `tool_call_chunks` reassembly, abort, bindTools JSON-Schema
declarations, model factories, `transformMessages` repair, clamps and
budgets.

Four adversarial suites cover the remaining surfaces: `verify-core` (facade
and loop: queues, abort, hooks, model hot-swap, execution modes, truncated
batches, coercion, reset), `verify-env` (`NodeExecutionEnv` and the built-in
tools without an LLM), `verify-utils` (JSON repair, truncation math,
output-capture, chord context, transcript replay, estimation, validation),
`verify-proxy` (`streamProxy` end-to-end against a local SSE mock server).

## Relationship to upstream pi

What is vendored from pi v0.87.1, ported verbatim (behavior identical,
see file headers for provenance):

- **Agent core** — `agent-loop.ts` (steering/follow-up queues, prepare hooks,
  `finishTurn`, sequential/parallel tool batches, truncated-batch handling),
  the `Agent` facade, `StreamFn` contract, `proxy.ts`.
- **Harness** — bash / read / write / edit tools, `NodeExecutionEnv`
  (process trees, spill files, output capture, error codes), truncate /
  output-capture / edit-diff utilities, the chord context and telemetry
  slices.
- **Message model** — types, transcript replay, estimate, json repair,
  event streams, plus pi-ai's `transform-messages` (cross-model
  thinking/signature handling, orphaned toolCall synthesis, image downgrade,
  ID normalization) and `simple-options` (maxTokens context clamp, thinking
  budgets) — the bridge runs both on every request, exactly where pi's
  adapters did.

What is original to this SDK (pi implements these at the application layer,
not in the extracted packages): `autoCompaction`, the session store, the
subagent tool, and the todo tool.

What differs from pi — exactly one layer was redesigned:

- **pi-ai's provider catalog** (18 provider factories over 4 wire adapters,
  with `createModels` auth/cache) becomes `AgentModel` + any LangChain chat
  model. The four factories map to the same four wire protocols; every other
  provider is an OpenAI-compatible `baseURL` away.
- **Transport knobs** move to where LangChain owns them: request/response
  observation (`onPayload`/`onResponse`/`onProviderStreamEvent`) is LangChain
  callbacks on the chat model; per-request retry/timeout
  (`maxRetryDelayMs`, transport options) is `{ timeoutMs, maxRetries,
  metadata }` harness options or chat-model constructor options; provider
  extras (cache retention, deferred mode, custom headers) are constructor
  options; `temperature` / `maxTokens` / `reasoning` still arrive per request
  via `StreamFnOptions`.
- **zod replaces typebox** for tool schemas (`z.toJSONSchema` builds the
  model-visible declarations, validated and coerced with pi's observable
  contract); `constrainedSampling: json_schema` crosses to `bindTools` as
  `strict: true`. Grammar variants (`openai_lark` / `openai_regex`) ride in
  OpenAI Responses tool payloads that LangChain's `bindTools` has no field
  for; the type is carried through so a host wrapping its own chat model can
  honor it.
- **Session model resolution** is host-side (`init.model` /
  `init.resolveModel`) because there is no builtin catalog to resolve ids
  from; unknown ids throw `SessionError("model_unresolved")`.

## Directory layout

```
src/
├── pico.ts              public API (everything described in this file)
├── adapt.ts             harness tool → core AgentTool adapter
├── compaction.ts        autoCompaction() — automatic context compaction (original)
├── session.ts           session snapshots / refs / store (original)
├── agent/               agent core (pi) + harness tools /env/utils
├── ai/                  pi message model + LangChain stream bridge + model factories
└── support/             chord-context / telemetry / json-value
examples/
├── verify-tools.ts       keyless self-check (write→read→edit→bash through the real bridge)
├── verify-compaction.ts  keyless compaction regression (bloat → trigger → shrink → cap holds)
├── verify-session.ts     keyless session persistence regression (roundtrip, repair, resolution)
├── verify-subagent.ts    keyless subagent regression (fan-out, inheritance, caps, guards)
├── verify-todo.ts        keyless todo tool regression (actions, demotion, immutability)
├── verify-bridge.ts      keyless bridge regression (mapping, events, chunks, abort, factories)
├── verify-core.ts        keyless loop/facade regression (queues, abort, hooks, execution modes)
├── verify-env.ts         keyless env/tool regression (bash failure modes, edit adversarial paths)
├── verify-utils.ts       keyless utility regression (json repair, truncation, capture, context)
├── verify-proxy.ts       keyless proxy regression (SSE mock server end-to-end)
├── mini-agent.ts         real-model one-shot example (DEEPSEEK_API_KEY)
└── multi-turn.ts         real-model interactive REPL (DEEPSEEK_API_KEY)
```
