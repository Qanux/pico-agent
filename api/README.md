# pico-agent API

Reference for the public API — everything exported from `src/pico.ts`. One file per module, each with illustrative code.

Import style throughout: `import { Agent, ... } from "pico-agent"` (or `from "../src/pico.ts"` in-repo). Runtime: Node.js ≥ 22.19 with native TypeScript (`.ts` imports, no build step).

## Index

| File | Module |
|---|---|
| [agent.md](agent.md) | `Agent` class — constructor, methods, options, state, events |
| [loop.md](loop.md) | Headless loop functions — `agentLoop`, `runAgentLoop`, `AgentLoopConfig` |
| [streaming.md](streaming.md) | `StreamFn` contract, LangChain bridge, default stream fn, `streamProxy` |
| [ai.md](ai.md) | Model layer — `AgentModel`, LangChain factories, bridge, clamps, message types |
| [tools.md](tools.md) | `AgentTool` interface, built-in bash/read/write/edit, `ExecutionEnv` |
| [compaction.md](compaction.md) | `autoCompaction` — automatic context compaction |
| [subagent.md](subagent.md) | `createSubagentTool` — parallel fan-out, stuck-child guards, final-message budget |
| [todo.md](todo.md) | `createTodoTool` — self-managed todo list with transcript-backed state |
| [skills.md](skills.md) | `loadSkills` — progressive-disclosure SKILL.md loading and prompt rendering |
| [session.md](session.md) | `createSessionStore` — save / restore / list / delete snapshots |
| [context.md](context.md) | chord `Context` primitives subset |

## Conventions

**Errors.** Tool failures become `isError` tool results (throw inside `execute`); provider failures surface as an assistant message with `stopReason: "error"` plus `errorMessage`; the session store throws `SessionError` with a machine-readable `code`:

```typescript
import { SessionError } from "pico-agent";

try {
	const agent = await store.restore(ref, init);
} catch (error) {
	if (error instanceof SessionError && error.code === "model_unresolved") {
		// no builtin catalog exists — pass init.model or init.resolveModel
	}
}
```

**Abort.** Cooperative everywhere. `agent.abort()` signals the active provider call and every running tool execution; well-behaved tools and stream functions stop and the run ends with a synthetic `stopReason: "aborted"` assistant message.

**Models.** There is no provider registry. One `AgentModel` per conversation (a LangChain chat model plus catalog metadata), created by a factory and wrapped once by `createModelStreamFn()` — see [ai.md](ai.md).

**Keyless verification.** `npm run verify` runs eleven regression suites (tools, compaction, session, subagent, todo, bridge, core, env, utils, proxy, skills) on scripted models — no API keys, no network. Real-model examples: `npm run demo`, `npm run chat`, `npm run skill-demo`.

**No `@earendil-works/*` dependencies.** The agent core and harness are vendored from pi v0.87.1 (MIT). The provider catalog of the predecessor is replaced by `@langchain/*` chat models. Original pico-agent additions: the LangChain bridge, compaction, subagent tool, todo tool, session persistence, skills.
