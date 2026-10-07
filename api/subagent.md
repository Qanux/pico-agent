# Subagents

`createSubagentTool()` builds a single `subagent` tool that fans out to parallel child agents. Each child is a fresh `Agent` with the parent's current tools **minus the subagent tool itself** (no recursive spawning) and an empty context — only each child's head-truncated final message flows back, so intermediate tool output never enters the parent transcript.

```typescript
import { Agent, createSubagentTool } from "pico-agent";

const subagent = createSubagentTool({
	getTools: () => [bash, read, write, edit],   // parent's CURRENT tools; resolved per call
	createAgent: ({ tools, systemPrompt }) =>
		new Agent({ initialState: { systemPrompt, model, tools }, streamFn }),
	maxConcurrent: 4,              // hard cap on subagents per tool call (default 4)
	maxOutputChars: 20_000,        // head-truncation budget per child (default 20k)
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
<child's final message, head-truncated to maxOutputChars>
[usage: 3.1k tokens · 4 tool calls · 3 turns · 12.4s]

=== Subagent 2 (FAILED: exceeded maxTurns 50) ===
<child's last real message>
```

A failed, aborted, or killed child becomes a FAILED section — it never fails the whole call. Structured per-child data (status, usage, kill reason) rides in the tool result's `details` as `SubagentRunDetails`. The parent's abort cascades to all children.

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

## Exports

`createSubagentTool`, `SubagentToolOptions`, `SubagentAgentFactory`, `SubagentToolInput`, `SubagentRunDetails`, `DEFAULT_SUBAGENT_SYSTEM_PROMPT`.
