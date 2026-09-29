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
full record and is never rewritten — only outgoing requests carry the compacted view.
Summarization is incremental (a running summary plus only-new material) with a
read/write/edit file ledger carried across compactions.

## Relationship to upstream

- Extracted from pi v0.87.1 source; upstream updates do not flow in automatically
- Every vendored file carries a header comment linking to its exact upstream path at v0.87.1 — diff against it when syncing
- Removed: the other 23 providers, 6 protocol adapters (bedrock/azure/mistral/codex/pi-messages/vertex), the harness session/compaction/skills layers, and the coding-agent product layer (8 product tools, extension system, TUI, session persistence)
- `src/ai/providers/data/*.json` are generated artifacts (from upstream `generate:models`); regenerate or hand-edit if the model lists go stale
- 8 external dependencies: `typebox`, `diff`, `@anthropic-ai/sdk`, `openai`, `@google/genai`, `partial-json`, `http-proxy-agent`, `https-proxy-agent`

## Modifications vs upstream pi

Everything under `src/agent/` and `src/ai/` is vendored verbatim from v0.87.1 (modulo the
provenance headers). Code original to pico-agent, not present upstream:

| Path | What it is |
|------|-----------|
| `src/adapt.ts` | `harnessToolToAgentTool()` — bridges harness tools (6-arg `execute`) to the core 4-arg `AgentTool` interface |
| `src/compaction.ts` | `autoCompaction()` — automatic context compaction via `transformContext` + `prepareRequest` (see above). Upstream ships compaction inside the harness session layer, which this extraction excludes |
| `src/index.ts` | Public API assembly |
| `src/ai/index.ts` | Rewritten minimal barrel (upstream's re-exports pull in excluded adapters) |
| `src/support/` | Slim copies: chord `Context` (with `ContextKey` inlined from chord types), the `TelemetryContext` contract, `JsonValue` |

Plus, at the example level: `mini-agent.ts` (DeepSeek + thinking + compaction),
`multi-turn.ts` (interactive REPL), `verify-compaction.ts` (keyless compaction regression).

## Directory layout

```
src/
├── index.ts              public API (everything described in this file)
├── adapt.ts              harness tool → core AgentTool adapter
├── compaction.ts         autoCompaction() — automatic context compaction (original code)
├── agent/                agent core (5 files) + harness tools/env/utils
├── ai/                   pi-ai slice (types/models/auth + 4 adapters + 18 providers)
└── support/              slim copies of chord-context / telemetry / json-value
examples/
├── verify-tools.ts       keyless self-check (write→read→edit→bash through the real loop)
├── verify-compaction.ts  keyless compaction regression (bloat → trigger → shrink → cap holds)
├── mini-agent.ts         real-model one-shot example
└── multi-turn.ts         real-model interactive REPL (multi-turn with retained context)
```
