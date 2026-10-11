// Original to the pico-agent extraction of earendil-works/pi v0.87.1 — placed among the
// harness tools for discoverability, but NOT part of the v0.87.1 vendoring (see MODIFICATIONS.md).
// The state-in-details pattern follows pi's example extension
// packages/coding-agent/examples/extensions/todo.ts: every result snapshots the full
// list into `details` (host-visible, never sent to the model), so persistence and
// session restore are "replay the transcript" — no side files, no extra events.

import { Type, type Static } from "typebox";
import { StringEnum, type TextContent } from "../../../ai/index.ts";
import type { AgentMessage, AgentTool } from "../../types.ts";

const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

const todoSchema = Type.Object(
	{
		action: StringEnum(["list", "add", "update", "replace", "clear"] as const, {
			description: "What to do with the todo list",
		}),
		text: Type.Optional(Type.String({ description: "Item text (for add)" })),
		id: Type.Optional(Type.Number({ description: "Item id (for update)" })),
		status: Type.Optional(StringEnum(TODO_STATUSES, { description: "New status (for update)" })),
		items: Type.Optional(
			Type.Array(
				Type.Object({
					text: Type.String({ description: "Step text: short and imperative" }),
					status: Type.Optional(StringEnum(TODO_STATUSES, { description: "Defaults to pending" })),
				}),
				{ description: "The complete new list (for replace); ids are reassigned 1..n" },
			),
		),
		explanation: Type.Optional(Type.String({ description: "Why the plan changed (for replace)" })),
	},
	{},
);

export type TodoToolInput = Static<typeof todoSchema>;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
	id: number;
	/** Short imperative step text. */
	text: string;
	status: TodoStatus;
}

/** Full todo state — the shape snapshotted into every result's `details`. */
export interface TodoState {
	items: TodoItem[];
	/** Id the next `add` will use. */
	nextId: number;
}

export type TodoAction = "list" | "add" | "update" | "replace" | "clear";

/**
 * Structured per-call record in the tool result `details`: the full-list
 * snapshot after the call (never a delta), so hosts rendering a todo panel and
 * {@link readTodoState} replaying history both just take the latest one.
 */
export interface TodoDetails {
	action: TodoAction;
	/** Complete list after this call. */
	items: TodoItem[];
	nextId: number;
	/** Present when the action was rejected; the list is unchanged. */
	error?: string;
	/** The rationale a model supplied with a `replace` call. */
	explanation?: string;
}

/** Optional system-prompt addendum teaching when and how to use the todo tool. */
export const TODO_TOOL_GUIDANCE = [
	"## Todo lists",
	"",
	"You have a `todo` tool for tracking multi-step work. Create a plan with `replace` before starting any non-trivial task, mark each step `completed` as you finish it, and keep exactly one step `in_progress` at a time — never start the next step while the previous one is unfinished.",
	"Re-plan with `replace` (including an `explanation` of what changed and why) whenever the approach turns out to be wrong, and append newly discovered steps with `add`.",
	"Do not pad simple single-step work with filler steps, do not restate the whole list in your replies, and keep each step short (5-10 words) and imperative.",
].join("\n");

const DEFAULT_MAX_ITEMS = 100;

function isTodoSnapshot(value: unknown): value is { items: TodoItem[]; nextId: number } {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { items?: unknown; nextId?: unknown };
	return Array.isArray(candidate.items) && typeof candidate.nextId === "number";
}

/**
 * Read the current todo state from a message history: the latest `todo` tool
 * result's `details` snapshot wins. Pure and side-effect free — the source for
 * `createTodoTool({ initialState })` after a session restore, and a pull-style
 * view for hosts (e.g. an HTTP `GET /todos`).
 *
 * Returns a deep copy: callers cannot mutate a past tool result through it.
 */
export function readTodoState(messages: readonly AgentMessage[]): TodoState | undefined {
	let state: TodoState | undefined;
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "todo") continue;
		if (!isTodoSnapshot(message.details)) continue;
		state = {
			items: message.details.items.map((item) => ({ ...item })),
			nextId: message.details.nextId,
		};
	}
	return state;
}

export interface TodoToolOptions {
	/**
	 * Seed state, e.g. `readTodoState(snapshot.messages)` after a session
	 * restore. Deep-copied; later mutations of the input do not affect the tool.
	 */
	initialState?: TodoState;
	/** Rejection threshold for `add`/`replace` list length. Default 100. */
	maxItems?: number;
}

/**
 * A todo-list tool the model manages itself: `list` reads the full list,
 * `add`/`update`/`clear` edit it incrementally, and `replace` submits a
 * complete new plan (with an `explanation`) for mid-task re-planning.
 *
 * State authority lives in the transcript, not in this object: every call
 * returns the full-list snapshot in the result's `details` (host-visible, not
 * sent to the model), so `readTodoState` rebuilds the list from message
 * history and session persistence carries it for free. The model's own view
 * is its past calls plus `list` on demand.
 *
 * State is per-instance: call `createTodoTool()` once per agent. In particular,
 * the subagent tool passes the parent's tools to children — sharing one
 * instance across a parent and its children would let them stomp each other's
 * list; give children their own instance instead.
 *
 * At most one item is `in_progress`: `update` demotes the others when one is
 * promoted, and `replace` keeps only the first `in_progress` entry. Rejected
 * calls (missing arguments, unknown id, blank step text, over the item cap)
 * return an error text and leave the list unchanged.
 */
export function createTodoTool(options: TodoToolOptions = {}): AgentTool<typeof todoSchema, TodoDetails> {
	const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
	let items: TodoItem[] = options.initialState ? options.initialState.items.map((item) => ({ ...item })) : [];
	let nextId = options.initialState?.nextId ?? 1;

	// Copy on every snapshot: the transcript owns past results, so later edits
	// must never show through an earlier details (readTodoState's last-wins
	// replay depends on snapshots being immutable).
	const snapshot = (action: TodoAction, extra?: { error?: string; explanation?: string }): TodoDetails => ({
		action,
		items: items.map((item) => ({ ...item })),
		nextId,
		...(extra?.error !== undefined ? { error: extra.error } : {}),
		...(extra?.explanation !== undefined ? { explanation: extra.explanation } : {}),
	});

	const render = (): string => {
		if (items.length === 0) return "No todos";
		const done = items.filter((item) => item.status === "completed").length;
		const lines = items.map((item) => {
			const mark = item.status === "completed" ? "x" : item.status === "in_progress" ? ">" : " ";
			return `[${mark}] #${item.id}: ${item.text}`;
		});
		return `${done}/${items.length} completed\n${lines.join("\n")}`;
	};

	const result = (text: string, details: TodoDetails): { content: TextContent[]; details: TodoDetails } => ({
		content: [{ type: "text", text }],
		details,
	});

	return {
		name: "todo",
		label: "Todo",
		description:
			"Manage the todo list for the current task. Actions: list (read the list), add (text), update (id + status), replace (the complete new list, with an explanation when the plan changed), clear. " +
			"Track multi-step work: create a plan before starting, mark each step completed before moving to the next, keep exactly one step in_progress (extras are demoted automatically), and re-plan with replace when the approach changes. " +
			"Skip this for trivial single-step work.",
		parameters: todoSchema,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list":
					return result(render(), snapshot("list"));

				case "add": {
					const text = params.text?.trim();
					if (!text) {
						return result("Error: text required for add", snapshot("add", { error: "text required" }));
					}
					if (items.length >= maxItems) {
						const error = `todo list is full (maxItems=${maxItems})`;
						return result(`Error: ${error}`, snapshot("add", { error }));
					}
					const item: TodoItem = { id: nextId++, text, status: "pending" };
					items.push(item);
					return result(`Added #${item.id}: ${item.text}`, snapshot("add"));
				}

				case "update": {
					if (params.id === undefined || params.status === undefined) {
						const error = "id and status required for update";
						return result(`Error: ${error}`, snapshot("update", { error }));
					}
					const item = items.find((candidate) => candidate.id === params.id);
					if (!item) {
						const error = `#${params.id} not found`;
						return result(`Error: ${error}`, snapshot("update", { error }));
					}
					item.status = params.status;
					// Single-item focus: promoting one step demotes every other
					// in_progress step in the same call, without a second round trip.
					const demoted =
						params.status === "in_progress"
							? items.filter((other) => other !== item && other.status === "in_progress")
							: [];
					for (const other of demoted) other.status = "pending";
					const note =
						demoted.length > 0
							? ` (demoted ${demoted.map((other) => `#${other.id}`).join(", ")} to pending)`
							: "";
					return result(`Marked #${item.id} ${item.status}${note}`, snapshot("update"));
				}

				case "replace": {
					if (!params.items) {
						const error = "items required for replace";
						return result(`Error: ${error}`, snapshot("replace", { error }));
					}
					if (params.items.length > maxItems) {
						const error = `replacement has ${params.items.length} items, exceeding maxItems=${maxItems}`;
						return result(`Error: ${error}`, snapshot("replace", { error }));
					}
					// Same text discipline as add: trimmed, never blank — a blank step
					// would render as an invisible list entry.
					const entries = params.items.map((entry) => ({ ...entry, text: entry.text.trim() }));
					const blankIndex = entries.findIndex((entry) => !entry.text);
					if (blankIndex !== -1) {
						const error = `items[${blankIndex}].text must be non-empty`;
						return result(`Error: ${error}`, snapshot("replace", { error }));
					}
					// A re-planned list is a fresh list: ids are reassigned 1..n, and
					// the single in_progress invariant holds here too (first wins).
					let inProgressUsed = false;
					items = entries.map((entry, index) => {
						let status = entry.status ?? "pending";
						if (status === "in_progress") {
							if (inProgressUsed) status = "pending";
							else inProgressUsed = true;
						}
						return { id: index + 1, text: entry.text, status };
					});
					nextId = items.length + 1;
					return result(
						`Replaced with ${items.length} item(s)${params.explanation ? ` — ${params.explanation}` : ""}`,
						snapshot("replace", params.explanation !== undefined ? { explanation: params.explanation } : {}),
					);
				}

				case "clear": {
					const count = items.length;
					items = [];
					nextId = 1;
					return result(`Cleared ${count} todo(s)`, snapshot("clear"));
				}
			}
		},
	};
}
