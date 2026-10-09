# pico-agent

Read this in [简体中文](README.zh-CN.md)

Minimal agent runtime SDK extracted from [earendil-works/pi](https://github.com/earendil-works/pi) (source-level vendoring, MIT license, see `LICENSE`).

**Zero `@earendil-works/*` npm dependencies.** Three parts:

| Part | Source | Contents |
|------|--------|----------|
| `src/agent/` | `packages/agent/src` core layer | Agent loop (`agent-loop.ts`), `Agent` class, types |
| `src/agent/harness/` | `packages/agent/src/harness` tool subset | bash / read / write / edit tools + `NodeExecutionEnv` |
| `src/ai/` | `packages/ai/src` slice | types, streaming, models/auth + 18 providers (4 protocol adapters) |

## Supported providers (18)

| Provider | Factory | Environment variable | Protocol |
|----------|---------|----------------------|----------|
| Anthropic | `anthropicProvider()` | `ANTHROPIC_API_KEY` | anthropic-messages |
| OpenAI | `openaiProvider()` | `OPENAI_API_KEY` | openai-responses |
| Google Gemini | `googleProvider()` | `GEMINI_API_KEY` | google-generative-ai |
| xAI (Grok) | `xaiProvider()` | `XAI_API_KEY` | openai-responses |
| Zhipu GLM | `zaiProvider()` | `ZAI_API_KEY` | openai-completions |
| Zhipu GLM Coding CN | `zaiCodingCnProvider()` | `ZAI_CODING_CN_API_KEY` | openai-completions |
| MiniMax | `minimaxProvider()` | `MINIMAX_API_KEY` | anthropic-messages |
| MiniMax CN | `minimaxCnProvider()` | `MINIMAX_CN_API_KEY` | anthropic-messages |
| Moonshot Kimi | `moonshotaiProvider()` | `MOONSHOT_API_KEY` | openai-completions |
| Moonshot Kimi CN | `moonshotaiCnProvider()` | `MOONSHOT_API_KEY` | openai-completions |
| Xiaomi MiMo | `xiaomiProvider()` | `XIAOMI_API_KEY` | openai-completions |
| MiMo Token Plan CN/SGP/AMS | `xiaomiTokenPlanCn/Sgp/AmsProvider()` | `XIAOMI_TOKEN_PLAN_CN_API_KEY` etc. | openai-completions |
| Tongyi Qwen Token Plan | `qwenTokenPlanProvider()` | `QWEN_TOKEN_PLAN_API_KEY` | openai-completions |
| Qwen Token Plan CN | `qwenTokenPlanCnProvider()` | `QWEN_TOKEN_PLAN_CN_API_KEY` | openai-completions |
| Qwen Token Plan Individual | `qwenTokenPlanIndividualProvider()` | `QWEN_TOKEN_PLAN_API_KEY` | openai-completions |
| DeepSeek | `deepseekProvider()` | `DEEPSEEK_API_KEY` | openai-completions |

Note: the xAI OAuth login flow is not vendored (API key auth works); model catalogs are a snapshot from extraction time.

Support modules (`src/support/`) are slim built-in copies of the chord Context (121 lines) and the pi-telemetry contract (~50 lines).

## Quick start

Node >= 22.19 (runs `.ts` natively, no build step):

```bash
npm install
npm run verify            # keyless end-to-end self-checks (tools + compaction, scripted model)
npm run verify:providers  # catalog/adapter smoke test for all 18 providers (no key needed)
npm run demo              # real-model example (requires DEEPSEEK_API_KEY)
```

## Usage

Full API reference (every export, signatures, defaults, per-module files with
example code): [api/](api/README.md).

```typescript
import {
	Agent,
	harnessToolToAgentTool,
	createModels,
	anthropicProvider,
	createBashTool,
	createReadTool,
	createWriteTool,
	createEditTool,
	NodeExecutionEnv,
} from "./src/index.ts";

// 1. Model (API key is read from the ANTHROPIC_API_KEY environment variable)
const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");

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
	streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
	if (event.type === "tool_execution_start") console.log(`\n[tool] ${event.toolName}`);
});

await agent.prompt("Take a look at what's in this directory");
```

Custom tools need no adapter — just a plain object satisfying the `AgentTool` interface:

```typescript
const myTool = {
	name: "list_files",
	label: "list_files",
	description: "List files in a directory",
	parameters: Type.Object({ path: Type.Optional(Type.String()) }),
	async execute(_id, { path = "." }) {
		const entries = await readdir(path, { withFileTypes: true });
		return { content: [{ type: "text", text: entries.map((e) => e.name).join("\n") }], details: {} };
	},
};
```

## Adaptation seams (all in `AgentLoopConfig`)

- `transformContext` — transform the context before each LLM call (trim history, inject RAG)
- `prepareRequest` / `prepareNextTurn` — swap model / thinking level per turn
- `beforeToolCall` (can intercept) / `afterToolCall` (can rewrite results)
- `finishTurn` — return `{ action: "continue" | "end" }` to control loop lifetime
- `agent.steer()` / `agent.followUp()` — interject mid-run / append after a stop
- `agent.state.tools = [...]` — swap the tool set at any time (the loop declares the delta automatically)

## Auto context compaction

`src/compaction.ts` (original pico-agent code) provides `autoCompaction()`: spread its hooks
next to `streamFn` and the context is compacted automatically before every LLM call —
covering tool marathons inside a single `prompt()`, multi-turn sessions, and mid-session
model swaps:

```typescript
const agent = new Agent({
	initialState: { systemPrompt, model, tools },
	streamFn: models.streamSimple.bind(models),
	...autoCompaction(models, {
		model,                       // kept fresh via prepareRequest afterwards
		maxContextTokens: 200_000,   // optional; default 131_072 (128K)
		threshold: 0.75,             // trigger fraction of the effective window
		keepRecentTurns: 6,          // recent assistant turns kept verbatim
		onCompaction: (s) => console.log(`[compact] ${s.before} -> ${s.after}`),
	}),
});
```

Effective window = `min(maxContextTokens ?? 131_072, model.contextWindow ?? 131_072)` —
the default cap is 128K; raise `maxContextTokens` for large-window models. The cut sits
right before an assistant message, so toolCall/toolResult pairs are never split.
Compaction is request-scoped: the durable transcript (`agent.state.messages`) keeps the
full record and is never rewritten — once a summary exists, every outgoing request is a
derived view (leading system messages, summary, kept tail), never the raw history, so
requests stay inside the window even while the cooldown delays the next fold-in.
Summarization is incremental (a running summary plus only-new material) with a
read/write/edit file ledger carried across compactions; if the kept tail alone still
exceeds half the window, old tool results are stubbed out as a hard safety net.

## Subagents

`src/agent/harness/tools/subagent.ts` (original pico-agent code, placed among the vendored
tools) provides `createSubagentTool()`: a
single `subagent` tool that fans out to parallel child agents. Each child is a fresh
`Agent` with the parent's current tools minus the subagent tool itself (no recursive
spawning) and an empty context — only the child's final message flows back to the
parent, head-truncated, so intermediate tool output never enters the parent transcript:

```typescript
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

The model passes one self-contained prompt per subagent (schema default guidance: 2,
more only when the user asks; enforced cap `maxConcurrent`). Children run concurrently,
the tool call blocks until all of them finish, and the parent's abort signal aborts
every child. Results merge into one tool result with per-child usage lines
(tokens / tool calls / turns / duration); a failed or aborted child is reported as a failed
section instead of failing the whole call. Verified keyless by `examples/verify-subagent.ts`.

### Stuck-child guards

Two independent factory-level gates bound a child that never finishes on its own:

- **`maxTurns`** (default 50, 0 disables) aborts a runaway tool marathon. It counts
  completed assistant turns (`turn_end` events) and kills only when the capped turn
  still issues tool calls — a turn without tool calls is the child finishing
  naturally and never counts as a violation.
- **`inactivityTimeoutMs`** (default 300000, 0 disables) aborts total silence: a
  wall-clock watchdog armed at spawn and reset by every child event (model deltas,
  tool starts/updates/ends). A hung provider call or a never-settling tool fires it;
  a slow-but-alive child keeps resetting the clock and is never killed.

Kill path (both gates): the child is aborted, its loop ends before any further tool
work, and `prompt()` resolves instead of hanging. The kill reason labels that child's
FAILED section, and the reported final message skips the empty synthetic abort marker
and returns the child's last real words. Both gates rely on cooperative abort — a
host-supplied tool or stream function that ignores the abort signal can still hang a
child; the parent run's own abort remains the escape hatch. Scenarios F/G/H of
`examples/verify-subagent.ts` regress both gates keylessly.

### Observing children

`onChildEvent(child, event)` streams every child's run to the host live —
thinking deltas, tool executions, turn boundaries, the same `AgentEvent`
vocabulary as `agent.subscribe()`, so one renderer serves parent and children.
Each delivery is stamped `{ toolCallId, prompt, index, total }`, grouping
concurrent children under the parent's `subagent` tool call; the `createAgent`
factory receives the same fields. Read-only side channel: nothing observed
enters the parent context, and there is no steering or abort handle.
Scenarios J/K of `examples/verify-subagent.ts` regress it keylessly.

## Session persistence

`src/session.ts` (original pico-agent code) saves an agent's
transcript as an immutable snapshot file and revives it in any later process:

```typescript
import { createSessionStore } from "pico-agent";

const store = createSessionStore();            // default dir: .pico/sessions/
const ref = await store.save(agent, { label: "audit" });   // JSON, atomic write, never overwrites
// ... later, in another process:
const agent2 = await store.restore(ref, {     // or store.restore("<path>.json", ...)
	tools: [bash, read, write, edit],          // runtime objects are never persisted — the host rewires them
	streamFn,
	// model?: ...  resolveModel?: ...          // snapshot stores only a model id; resolution order:
});                                            // init.model > init.resolveModel > bundled catalogs > SessionError
await agent2.prompt("continue where we left off");
```

`ref` is a small serializable key (`id` / `label` / `savedAt` / `file` / `stats`)
— persist it anywhere; files are only the default backend. `list()` / `latest()`
give the `--continue`-style UX, `delete(ref, { ignoreMissing })` and `clear()`
are the garbage collectors. A transcript saved mid-turn (unpaired tool calls)
is repaired at save time with synthetic error tool results, so every snapshot
on disk loads as a valid request. Unknown-file tolerance: version-gated
(`bad_version`), JSON failures map to `corrupt`, missing files to `not_found`.

**Security note**: transcripts contain everything the tools read (possibly
secrets) — add the default directory (`.pico/sessions/`) to `.gitignore`,
sanitize before distributing snapshots, and encrypt the JSON yourself when
needed. Verified keyless by `examples/verify-session.ts`.

## Relationship to upstream

See [MODIFICATIONS.md](MODIFICATIONS.md) for what was removed, what is original
pico-agent code, and vendoring notes (extraction provenance, generated artifacts,
dependencies).

## Directory layout

```
src/
├── index.ts              public API (everything described in this file)
├── adapt.ts              harness tool → core AgentTool adapter
├── compaction.ts         autoCompaction() — automatic context compaction (original code)
├── session.ts            session snapshots / refs / store — save, restore, list, delete (original code)
├── agent/                agent core (5 files) + harness tools (incl. the original subagent tool)/env/utils
├── ai/                   pi-ai slice (types/models/auth + 4 adapters + 18 providers)
└── support/              slim copies of chord-context / telemetry / json-value
examples/
├── verify-tools.ts       keyless self-check (write→read→edit→bash through the real loop)
├── verify-compaction.ts  keyless compaction regression (bloat → trigger → shrink → cap holds)
├── verify-subagent.ts    keyless subagent regression (fan-out, inheritance, cap, truncation, stuck-child guards)
├── verify-session.ts     keyless session persistence regression (roundtrip, dangling repair, model resolution, delete, escape guard)
├── mini-agent.ts         real-model one-shot example
└── multi-turn.ts         real-model interactive REPL (multi-turn with retained context)
```
