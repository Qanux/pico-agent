# pico-agent API

Reference for the public API — everything exported from `src/index.ts`. One file per module, each with illustrative code.

Import style throughout: `import { Agent, ... } from "pico-agent"` (or `from "../src/index.ts"` in-repo). Runtime: Node.js ≥ 22.19 with native TypeScript (`.ts` imports, no build step).

## Index

| File | Module |
|---|---|
| [agent.md](agent.md) | `Agent` class — constructor, methods, options, state, events |
| [loop.md](loop.md) | Headless loop functions — `agentLoop`, `runAgentLoop`, `AgentLoopConfig` |
| [streaming.md](streaming.md) | `StreamFn` contract, default stream fn, `streamProxy` |
| [tools.md](tools.md) | `AgentTool` interface, built-in bash/read/write/edit, `ExecutionEnv` |
| [compaction.md](compaction.md) | `autoCompaction` — automatic context compaction |
| [subagent.md](subagent.md) | `createSubagentTool` — parallel subagent fan-out + stuck-child guards |
| [session.md](session.md) | `createSessionStore` — save / restore / list / delete snapshots |
| [context.md](context.md) | chord `Context` primitives subset |
| [ai.md](ai.md) | AI slice — types, models registry, 18 providers, auth, utils |

## Conventions

**Errors.** Tool failures become `isError` tool results (throw inside `execute`); provider failures surface as an assistant message with `stopReason: "error"` plus `errorMessage`; the session store throws `SessionError` with a machine-readable `code`:

```typescript
import { SessionError } from "pico-agent";

try {
	const agent = await store.restore(ref, init);
} catch (error) {
	if (error instanceof SessionError && error.code === "model_unresolved") {
		// snapshot's model id is gone; re-restore with init.model
	}
}
```

**Abort.** Cooperative everywhere. `agent.abort()` signals the active provider call and every running tool execution; well-behaved tools and stream functions stop and the run ends with a synthetic `stopReason: "aborted"` assistant message.

**Keyless verification.** `npm run verify` runs four regression suites (tools, compaction, subagent, session) on scripted models — no API keys, no network. Real-model examples: `npm run demo` (needs `DEEPSEEK_API_KEY`), `npm run chat`.

**No `@earendil-works/*` dependencies.** The agent core and harness are vendored from pi v0.87.1 (MIT); the ai slice is a vendored subset. Original pico-agent additions: compaction, subagent tool, session persistence, the adapter layer.
