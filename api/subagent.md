# Subagents

`createSubagentTool()` builds a single `subagent` tool that fans out to parallel child agents. Each child is a fresh `Agent` with the parent's current tools **minus the subagent tool itself** (no recursive spawning) and an empty context — only each child's final message flows back, budget-enforced (below), so intermediate tool output never enters the parent transcript.

```typescript
import { Agent, createSubagentTool } from "pico-agent";

const subagent = createSubagentTool({
	getTools: () => [bash, read, write, edit],   // parent's CURRENT tools; resolved per call
	createAgent: ({ tools, systemPrompt }) =>
		new Agent({ initialState: { systemPrompt, model, tools }, streamFn }),
	maxConcurrent: 4,              // hard cap on subagents per tool call (default 4)
	maxOutputChars: 20_000,        // final-message budget per child (default 20k)
	maxTurns: 50,                  // turn cap per child (default 50, 0 disables)
	inactivityTimeoutMs: 300_000,  // inactivity watchdog (default 5 min, 0 disables)
	// systemPrompt: DEFAULT_SUBAGENT_SYSTEM_PROMPT,   // override if needed
});

const agent = new Agent({
	initialState: { systemPrompt, model, tools: [bash, read, write, edit, subagent] },
	streamFn,
});
```

## What the model passes

```json
{ "name": "subagent", "arguments": { "prompts": [
	"Audit the Linux kernel build system.",
	"Summarize the TLS handshake."
] } }
```

Schema guidance suggests 2 prompts by default (more only when the user asks), enforced by `maxConcurrent`. Children run concurrently; the tool call blocks until all of them finish.

## What flows back

One tool result merging every child, each with a usage line (tokens / tool calls / turns / duration):

```text
=== Subagent 1 (ok) ===
<child's final message — within budget, never truncated>
[usage: 3.1k tokens · 4 tool calls · 3 turns · 12.4s]

=== Subagent 2 (FAILED: exceeded maxTurns 50) ===
<head excerpt of the child's last real message>
```

A failed, aborted, or killed child becomes a FAILED section — it never fails the whole call. Structured per-child data (status, usage, kill reason, budget-correction details) rides in the tool result's `details` as `SubagentRunDetails`. The parent's abort cascades to all children.

## Final-message budget

A child that finishes naturally with a final message over `maxOutputChars` does **not** get truncated. It enters up to 2 correction rounds in its own transcript:

1. The tool dictates an absolute report path under `<cwd>/.pico/subagent-outputs/` (name derived from the tool call id, child index, and a timestamp).
2. The child must write the complete report to exactly that path with its own write tool — a failed write is an ordinary tool error the child reacts to and retries inside its own loop, like any other tool failure.
3. The child then replies with only a summary (≤4000 characters) plus the report path.

Compliance requires all of: budget respected, the path referenced in the reply, and a verified non-empty file at the path (`stat`; content is not compared — the child owns the file). A compliant reply replaces the oversized final message, so the parent receives the full report by location and a faithful summary. After 2 failed correction rounds the child is failed with reason "ignored the final-message budget" and its FAILED section carries a surrogate-safe head excerpt of the last output (2000 characters). A parent abort between rounds never starts a new corrective run — that child fails as aborted.

The budget rule is mandatory, not an option: the system prompt of every child carries it, so an ok result is always either within budget or backed by a report file on disk.

## Stuck-child guards

Two independent gates bound a child that never finishes on its own. Both kill via `child.abort()` and label the reason in the FAILED section:

| Option | Default | Kills when |
|---|---|---|
| `maxTurns` | `50` (`0` disables) | Runaway tool marathon: counts completed assistant turns (`turn_end` events); only a capped turn that **still issues tool calls** is a violation. A turn without tool calls is a natural finish — never a violation. |
| `inactivityTimeoutMs` | `300000` (`0` disables) | Total silence: no model deltas, no tool events for this long. A hung provider call or never-settling tool fires it; a slow-but-alive child keeps resetting the clock. |

Both gates rely on cooperative abort — a host tool or stream function that ignores the abort signal can still hang a child; the parent run's own abort remains the escape hatch.

```typescript
// Fast fact-finding configuration:
const quick = createSubagentTool({
	getTools: () => [read],
	createAgent,
	maxTurns: 8,                  // short leash
	inactivityTimeoutMs: 30_000,  // 30s silence = dead
});
```

## Observing children

`onChildEvent` is a live read-only side channel into every child's run — the same `AgentEvent` vocabulary as `agent.subscribe()`, so one renderer can serve the parent and the children. Each delivery is stamped with `SubagentChildInfo`:

```typescript
createSubagentTool({
	getTools: () => [read, bash],
	createAgent: ({ tools, systemPrompt }) =>
		new Agent({ initialState: { systemPrompt, model, tools }, streamFn }),
	onChildEvent: (child, event) => {
		// child = { toolCallId, prompt, index, total } — "who"
		// event  = the child's own AgentEvent            — "what happened"
		if (event.type === "tool_execution_start") {
			console.log(`[child ${child.index + 1}/${child.total}] ${event.toolName} ${JSON.stringify(event.args)}`);
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
			process.stderr.write(event.assistantMessageEvent.delta);
		}
	},
});
```

**Correlation.** The parent's own event stream reports `tool_execution_start { toolCallId, toolName: "subagent", args: { prompts } }` when a batch starts and the matching `tool_execution_end` when it finishes; every child event stamped with the same `toolCallId` belongs to that batch. Children never nest (no recursive spawning), so one id level suffices.

The `createAgent` factory receives the same fields (`prompt`, `index`, `total`, `toolCallId`) for hosts that wire per-child subscriptions themselves.

**Contract.**

- Synchronous, arrival order, invoked before guard processing for that event; must not throw. Keep it synchronous: a returned promise (legal under TypeScript's void-return rule) is never awaited — observation must not delay the run — and its rejection is routed into that child's kill path (`FAILED (onChildEvent observer failed: …)`), never an unhandled process crash.
- Complete: tool executions, turn boundaries, the synthetic aborted `turn_end` a guard kill produces, through `agent_end`. The `child` object is frozen.
- Read-only: nothing observed enters the parent context, and there is no handle to steer or abort a child. Hosts wanting a pull-style view (e.g. `GET /runs/:callId`) buffer events in the callback and serve their own state.

## Exports

`createSubagentTool`, `SubagentToolOptions`, `SubagentAgentFactory`, `SubagentChildInfo`, `SubagentToolInput`, `SubagentRunDetails`, `DEFAULT_SUBAGENT_SYSTEM_PROMPT`.
