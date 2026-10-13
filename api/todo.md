# Todo tool — `createTodoTool`

A self-managed todo list: one `todo` tool the model drives itself. The model plans multi-step work, marks steps as it goes, and re-plans mid-task; hosts render progress from events or pull it on demand. State is transcript-backed — persistence and session restore need no side files.

```typescript
import { Agent, createTodoTool } from "pico-agent";

const agent = new Agent({
	initialState: {
		systemPrompt,
		model,
		tools: [createTodoTool(), ...harnessTools],
	},
	streamFn,
});
```

That single line is the whole integration: the tool's `description` teaches the model when and how to use it. Optionally append the exported guidance snippet to the system prompt for Codex-style rules:

```typescript
systemPrompt: basePrompt + "\n\n" + TODO_TOOL_GUIDANCE;
```

## Actions

| Action | Parameters | Effect |
|---|---|---|
| `list` | — | Render the full list: `2/4 completed` plus one line per item |
| `add` | `text` | Append an item (`pending`, next sequential id) |
| `update` | `id`, `status` | Set one item's status; promoting to `in_progress` demotes every other `in_progress` item in the same call |
| `replace` | `items`, `explanation?` | Submit a complete new plan: ids are reassigned `1..n`, only the first `in_progress` entry survives, the explanation is echoed |
| `clear` | — | Empty the list and reset id assignment |

Statuses are `pending` / `in_progress` / `completed`. Model-visible rendering:

```typescript
// todo({ action: "list" }) returns:
// 1/3 completed
// [x] #1: read the config
// [>] #2: patch the parser
// [ ] #3: run the tests
```

`replace` is the re-planning path — the model submits the whole new list whenever the approach changes, with the reason:

```typescript
// todo({ action: "replace", explanation: "split testing into two steps", items: [
//   { text: "write tests", status: "in_progress" },
//   { text: "run them" },
// ] })
// → "Replaced with 2 item(s) — split testing into two steps"
```

Rejected calls (missing arguments, unknown id, blank step text, over `maxItems`) return an `Error: …` text and leave the list unchanged — they do not throw, so a slip never fails the run. Schema-invalid calls (e.g. an unknown `action`) are rejected earlier, by the loop's argument validation: they become `isError` tool results that carry no snapshot, and `readTodoState` ignores them.

## State, persistence, restore

The authoritative copy of the list lives in the transcript: every result snapshots the full list into `details` (structured, host-visible, never sent to the model). `readTodoState` replays a message history and returns the latest snapshot:

```typescript
import { readTodoState } from "pico-agent";

// Pull-style view (e.g. an HTTP GET /todos):
const state = readTodoState(agent.state.messages);
if (state) renderPanel(state.items);
```

Snapshots are immutable copies — later calls never mutate earlier results, so last-wins replay is sound, and the returned state is detached (mutating it cannot reach the transcript).

Because session snapshots store messages verbatim, the save → restore loop closes with three lines:

```typescript
import { createSessionStore, createTodoTool, readTodoState } from "pico-agent";

const store = createSessionStore({ dir: ".pico/sessions" });
const ref = await store.save(agent, { label: "auth-refactor" });

const snapshot = await store.load(ref);
const restored = await store.restore(ref, {
	tools: [createTodoTool({ initialState: readTodoState(snapshot.messages) }), ...harnessTools],
	model,          // no builtin catalog — pass the model (see session.md)
	streamFn,
});
// The restored agent's next `list` shows the same items and statuses.
```

## Host-side rendering

Push: `tool_execution_end` for `toolName === "todo"` carries the full result, `details` included:

```typescript
agent.subscribe((event) => {
	if (event.type === "tool_execution_end" && event.toolName === "todo" && !event.isError) {
		renderPanel(event.result.details.items); // full-list snapshot after the call
	}
});
```

Pull: `readTodoState(agent.state.messages)` on demand.

## Options

```typescript
createTodoTool({
	initialState: readTodoState(snapshot.messages), // seed after a restore (deep-copied)
	maxItems: 100, // rejection threshold for add/replace; default 100
});
```

## Design notes

- **Single `in_progress`.** Enforced by the harness, not the model's discipline: `update` demotes the others when one is promoted, `replace` keeps only the first.
- **Per-instance state.** `createTodoTool()` once per agent. The subagent tool passes the parent's tools to children — sharing one instance would let children stomp the parent's list; give children their own.
- **Token economy.** `details` never enters the model's context; the model's own view is its past calls plus `list` on demand, and result texts are terse by design.

## Exports

`createTodoTool`, `readTodoState`, `TODO_TOOL_GUIDANCE`, `TodoItem`, `TodoStatus`, `TodoState`, `TodoAction`, `TodoDetails`, `TodoToolInput`, `TodoToolOptions`.
