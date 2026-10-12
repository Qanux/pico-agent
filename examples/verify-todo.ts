/**
 * Todo tool regression, keyless like the subagent verify.
 *
 * A scripted model drives the `todo` tool through the real agent loop; the
 * session round-trip drives it through the real session store. Asserts:
 *   A (replace + list): a full plan round-trips to the model, every result's
 *      details carry the full-list snapshot.
 *   B (update + demote): status transitions work, promoting a step demotes
 *      every other in_progress step in the same call, and — the load-bearing
 *      property — earlier details snapshots are never mutated by later calls.
 *   C (add + clear): ids are sequential, clear empties and resets them.
 *   D (re-plan): replace reassigns ids 1..n, echoes the explanation, and keeps
 *      only the first in_progress entry.
 *   E (error paths): missing arguments, unknown ids, and the maxItems cap all
 *      return an error text and leave the list unchanged.
 *   F (readTodoState): the latest details snapshot wins, and the returned
 *      state is a detached copy.
 *   G (session round-trip): save → load → readTodoState → createTodoTool
 *      restores the same list into a fresh agent.
 *   H (instance isolation): two tools never share state; initialState seeds a
 *      fresh tool and is deep-copied.
 *   I (schema-invalid action): the loop's argument validation rejects an
 *      unknown action before execute; the error result carries no snapshot
 *      and readTodoState ignores it. (The error text is zod's —
 *      the predecessor asserted typebox/AJV wording here.)
 * Run: node examples/verify-todo.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	EventStream,
	createSessionStore,
	createTodoTool,
	createUnavailableModel,
	readTodoState,
	TODO_TOOL_GUIDANCE,
	type AgentMessage,
	type AgentModel,
	type AssistantMessage,
	type StreamFn,
	type TodoDetails,
	type TodoState,
	type TodoToolInput,
} from "pico-agent";

let failures = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

const fakeModel: AgentModel = { ...createUnavailableModel(), id: "mock", provider: "mock" };

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		api: "langchain-scripted",
		provider: "mock",
		model: "mock",
		usage: {
			input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		content,
		stopReason,
	};
}

function pushScriptedReply(stream: EventStream<never, never>, message: AssistantMessage) {
	// Scripted events intentionally don't match the real event union (the loop
	// only reads what it needs); push through an untyped alias so the mismatch
	// lives in exactly one place.
	const push = (event: unknown) => stream.push(event as never);
	void (async () => {
		push({ type: "start", partial: message });
		push({ type: "message", message });
		push({ type: "done", message, stopReason: message.stopReason });
		stream.end();
	})();
}

function newStream() {
	return new EventStream<never, never>(
		(e) => (e as { type: string }).type === "done" || (e as { type: string }).type === "error",
		(e) =>
			(e as { type: string }).type === "done"
				? ((e as { message: AssistantMessage }).message as unknown as never)
				: e,
	);
}

/** One `todo` tool call per request, then a final text answer. */
function scriptedStream(calls: TodoToolInput[], finalText: string): StreamFn {
	let requestNo = 0;
	return (_model, _context, opts) => {
		requestNo++;
		const stream = newStream();
		if (opts?.signal?.aborted) {
			pushScriptedReply(stream, reply([], "aborted"));
			return stream as never;
		}
		const message =
			requestNo <= calls.length
				? reply(
						// Tool-call arguments are JsonObject; the typed input crosses that
						// boundary through one cast, like the untyped stream push above.
						[{ type: "toolCall", id: `t${requestNo}`, name: "todo", arguments: calls[requestNo - 1] as never }],
						"toolUse",
					)
				: reply([{ type: "text", text: finalText }], "stop");
		pushScriptedReply(stream, message);
		return stream as never;
	};
}

function todoAgent(calls: TodoToolInput[], finalText: string) {
	const tool = createTodoTool();
	const agent = new Agent({
		initialState: { systemPrompt: "todo verify", model: fakeModel, tools: [tool] },
		streamFn: scriptedStream(calls, finalText),
	});
	return { agent, tool };
}

function todoDetails(messages: readonly AgentMessage[]): TodoDetails[] {
	const snapshots: TodoDetails[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "todo") continue;
		snapshots.push(message.details as unknown as TodoDetails);
	}
	return snapshots;
}

function todoTexts(messages: readonly AgentMessage[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "todo") continue;
		for (const block of (message as { content: Array<{ type: string; text?: string }> }).content) {
			if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
		}
	}
	return texts;
}

function finalTextOf(messages: readonly AgentMessage[]): string {
	const last = messages.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant").at(-1);
	return (
		last?.content.find((block): block is { type: "text"; text: string } => block.type === "text")?.text ?? ""
	);
}

function todoResults(messages: readonly AgentMessage[]): Array<{ text: string; isError: boolean; details: unknown }> {
	const results: Array<{ text: string; isError: boolean; details: unknown }> = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "todo") continue;
		const text = message.content.find((block): block is { type: "text"; text: string } => block.type === "text")?.text ?? "";
		results.push({ text, isError: message.isError, details: message.details });
	}
	return results;
}

const statusOf = (details: TodoDetails) => details.items.map((item) => item.status);
const idsOf = (details: TodoDetails) => details.items.map((item) => item.id);

// ---- Scenario A: replace builds a plan, list reads it back ----
{
	console.log("--- scenario A: replace + list ---");
	const { agent } = todoAgent(
		[
			{
				action: "replace",
				items: [
					{ text: "read the config", status: "completed" },
					{ text: "patch the parser", status: "in_progress" },
					{ text: "run the tests" },
				],
			},
			{ action: "list" },
		],
		"A done",
	);
	await agent.prompt("plan the work");

	const details = todoDetails(agent.state.messages);
	const texts = todoTexts(agent.state.messages);
	check(details.length === 2, "A: both calls produced todo results");
	check(
		details[0] !== undefined &&
			details[0].action === "replace" &&
			details[0].items.length === 3 &&
			idsOf(details[0]).join(",") === "1,2,3" &&
			statusOf(details[0]).join(",") === "completed,in_progress,pending" &&
			details[0].nextId === 4,
		"A: replace snapshot carries the full list with statuses and ids",
	);
	check(
		texts[1] !== undefined && texts[1].includes("1/3 completed") && texts[1].includes("[x] #1: read the config") &&
			texts[1].includes("[>] #2: patch the parser") && texts[1].includes("[ ] #3: run the tests"),
		"A: list renders progress markers and text",
	);
	check(finalTextOf(agent.state.messages).includes("A done"), "A: agent finished normally");
}

// ---- Scenario B: update transitions, auto-demote, snapshot immutability ----
{
	console.log("--- scenario B: update + single in_progress ---");
	const { agent } = todoAgent(
		[
			{
				action: "replace",
				items: [{ text: "step one" }, { text: "step two" }, { text: "step three" }],
			},
			{ action: "update", id: 2, status: "in_progress" },
			{ action: "update", id: 3, status: "in_progress" },
			{ action: "list" },
		],
		"B done",
	);
	await agent.prompt("work the plan");

	const details = todoDetails(agent.state.messages);
	const texts = todoTexts(agent.state.messages);
	check(
		texts[2] !== undefined && texts[2].includes("Marked #3 in_progress (demoted #2 to pending)"),
		"B: promoting #3 reports the demotion of #2",
	);
	check(
		texts[3] !== undefined && texts[3].includes("[>] #3: step three") && texts[3].includes("[ ] #2: step two"),
		"B: the final list shows exactly one in_progress",
	);
	check(
		details[3] !== undefined && statusOf(details[3]).join(",") === "pending,pending,in_progress",
		"B: last snapshot records the demoted state",
	);
	// The load-bearing property: past snapshots must never change retroactively,
	// or readTodoState's last-wins replay and every host panel would lie.
	check(
		details[1] !== undefined &&
			details[1].items[1]?.status === "in_progress" &&
			details[0] !== undefined &&
			details[0].items.every((item) => item.status === "pending"),
		"B: earlier snapshots still show the state at their own point in time",
	);
}

// ---- Scenario C: add is sequential, clear resets ----
{
	console.log("--- scenario C: add + clear ---");
	const { agent } = todoAgent(
		[
			{ action: "add", text: "step one" },
			{ action: "add", text: "  step two  " },
			{ action: "clear" },
			{ action: "add", text: "fresh start" },
			{ action: "list" },
		],
		"C done",
	);
	await agent.prompt("track things");

	const texts = todoTexts(agent.state.messages);
	const details = todoDetails(agent.state.messages);
	check(
		texts[0] === "Added #1: step one" && texts[1] === "Added #2: step two" && texts[2] === "Cleared 2 todo(s)",
		"C: add assigns sequential ids and trims text; clear reports the count",
	);
	check(
		texts[3] === "Added #1: fresh start",
		"C: clear resets id assignment",
	);
	check(
		texts[4] !== undefined && texts[4].includes("[ ] #1: fresh start") &&
			details[4] !== undefined && details[4].items.length === 1 && details[4].nextId === 2,
		"C: the list after clear contains only the fresh item",
	);
}

// ---- Scenario D: re-planning with replace ----
{
	console.log("--- scenario D: replace re-plans ---");
	const { agent } = todoAgent(
		[
			{
				action: "replace",
				items: [
					{ text: "old step one" },
					{ text: "old step two" },
					{ text: "old step three" },
					{ text: "old step four" },
				],
			},
			{
				action: "replace",
				explanation: "split testing into two steps",
				items: [
					{ text: "write tests", status: "in_progress" },
					{ text: "run them", status: "in_progress" },
				],
			},
		],
		"D done",
	);
	await agent.prompt("replan");

	const details = todoDetails(agent.state.messages);
	const texts = todoTexts(agent.state.messages);
	check(
		texts[1] === "Replaced with 2 item(s) — split testing into two steps",
		"D: replace result echoes the explanation",
	);
	check(
		details[1] !== undefined &&
			idsOf(details[1]).join(",") === "1,2" &&
			statusOf(details[1]).join(",") === "in_progress,pending" &&
			details[1].explanation === "split testing into two steps" &&
			details[1].nextId === 3,
		"D: ids are reassigned 1..n, only the first in_progress survives, details carry the explanation",
	);
	check(
		details[0] !== undefined && details[0].items.length === 4 && details[0].nextId === 5,
		"D: the pre-replan snapshot is preserved untouched",
	);

	// Blank step text is rejected like add does — a blank entry would render
	// as an invisible list item.
	const { agent: blankAgent } = todoAgent(
		[
			{ action: "replace", items: [{ text: "keep me" }] },
			{
				action: "replace",
				explanation: "oops",
				items: [{ text: "  " }, { text: "valid step" }],
			},
		],
		"D done",
	);
	await blankAgent.prompt("try a blank step");
	const blankTexts = todoTexts(blankAgent.state.messages);
	const blankDetails = todoDetails(blankAgent.state.messages);
	check(
		blankTexts[1] === "Error: items[0].text must be non-empty",
		"D: a blank replacement entry is rejected with its index",
	);
	check(
		blankDetails[1] !== undefined &&
			blankDetails[1].items.length === 1 &&
			blankDetails[1].items[0]?.text === "keep me",
		"D: the rejection leaves the previous list unchanged",
	);

	// Replacement text is trimmed like add.
	const { agent: trimAgent } = todoAgent(
		[{ action: "replace", items: [{ text: "  padded step  " }] }],
		"D done",
	);
	await trimAgent.prompt("trim it");
	check(
		todoTexts(trimAgent.state.messages)[0] === "Replaced with 1 item(s)" &&
			todoDetails(trimAgent.state.messages)[0]?.items[0]?.text === "padded step",
		"D: replacement step text is trimmed",
	);
}

// ---- Scenario E: error paths leave the list unchanged ----
{
	console.log("--- scenario E: error paths ---");
	const tool = createTodoTool();
	const call = (params: TodoToolInput) => tool.execute("e", params);
	const listState = async () => (await call({ action: "list" })).details.items.length;

	const noText = await call({ action: "add" });
	const unknownId = await call({ action: "update", id: 99, status: "completed" });
	const noStatus = await call({ action: "update", id: 1 });
	const noItems = await call({ action: "replace" });
	check(
		noText.content[0]?.type === "text" && noText.content[0].text === "Error: text required for add" &&
			noText.details.error === "text required" &&
			noStatus.details.error === "id and status required for update" &&
			noItems.details.error === "items required for replace",
		"E: missing arguments produce error texts and error details",
	);
	check(
		unknownId.content[0]?.type === "text" && unknownId.content[0].text === "Error: #99 not found" &&
			(await listState()) === 0,
		"E: unknown id is rejected without touching the list",
	);

	await call({ action: "add", text: "one" });
	await call({ action: "add", text: "two" });
	const capped = createTodoTool({ maxItems: 2 });
	await capped.execute("e", { action: "add", text: "one" });
	await capped.execute("e", { action: "add", text: "two" });
	const third = await capped.execute("e", { action: "add", text: "three" });
	const bigReplace = await capped.execute("e", {
		action: "replace",
		items: [{ text: "a" }, { text: "b" }, { text: "c" }],
	});
	check(
		third.content[0]?.type === "text" && third.content[0].text === "Error: todo list is full (maxItems=2)" &&
			bigReplace.details.error === "replacement has 3 items, exceeding maxItems=2",
		"E: maxItems caps both add and replace",
	);
	const cappedList = await capped.execute("e", { action: "list" });
	check(cappedList.details.items.length === 2, "E: the capped list stayed at two items");
}

// ---- Scenario F: readTodoState replays the transcript ----
{
	console.log("--- scenario F: readTodoState ---");
	const { agent } = todoAgent(
		[
			{ action: "replace", items: [{ text: "alpha" }, { text: "beta" }] },
			{ action: "add", text: "gamma" },
		],
		"F done",
	);
	await agent.prompt("build history");

	const state = readTodoState(agent.state.messages);
	check(
		state !== undefined &&
			state.items.length === 3 &&
			state.items.map((item) => item.text).join(",") === "alpha,beta,gamma" &&
			state.items[2]?.id === 3 &&
			state.nextId === 4,
		"F: the latest details snapshot wins",
	);
	check(readTodoState([]) === undefined, "F: no todo results means no state");

	// Detached copy: mutating the returned state must not reach the transcript.
	if (state) {
		state.items[0]!.status = "completed";
		state.items.pop();
	}
	const reread = readTodoState(agent.state.messages);
	check(
		reread !== undefined && reread.items.length === 3 && reread.items[0]?.status === "pending",
		"F: the returned state is a detached copy",
	);
}

// ---- Scenario G: session save/load round-trips the todo state ----
{
	console.log("--- scenario G: session round-trip ---");
	const dir = await mkdtemp(join(tmpdir(), "pico-lc-todo-verify-"));
	try {
		const first = todoAgent(
			[
				{ action: "replace", items: [{ text: "write the patch" }, { text: "run the tests" }, { text: "update docs" }] },
				{ action: "update", id: 1, status: "completed" },
			],
			"G done",
		);
		await first.agent.prompt("plan and start");

		const store = createSessionStore({ dir });
		const ref = await store.save(first.agent, { label: "todo roundtrip" });
		const snapshot = await store.load(ref);
		const state = readTodoState(snapshot.messages);
		check(
			state !== undefined &&
				state.items.length === 3 &&
				state.items[0]?.status === "completed" &&
				state.items[1]?.status === "pending" &&
				state.nextId === 4,
			"G: readTodoState rebuilds the list from the saved snapshot",
		);

		const restored = await store.restore(ref, {
			tools: [createTodoTool({ initialState: state })],
			model: fakeModel,
			streamFn: scriptedStream([{ action: "list" }], "restored"),
		});
		await restored.prompt("show the plan");
		const lastList = todoTexts(restored.state.messages).at(-1);
		check(
			lastList !== undefined && lastList.includes("1/3 completed") && lastList.includes("[x] #1: write the patch") &&
				lastList.includes("[ ] #3: update docs"),
			"G: the restored agent lists the same items and statuses",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// ---- Scenario H: per-instance state and initialState seeding ----
{
	console.log("--- scenario H: instance isolation ---");
	const toolA = createTodoTool();
	const toolB = createTodoTool();
	await toolA.execute("h", { action: "replace", items: [{ text: "only on A" }] });
	const bText = await toolB.execute("h", { action: "list" });
	const aText = await toolA.execute("h", { action: "list" });
	check(
		bText.content[0]?.type === "text" && bText.content[0].text === "No todos" &&
			aText.content[0]?.type === "text" && aText.content[0].text.includes("only on A"),
		"H: two tool instances never share state",
	);

	const seed: TodoState = { items: [{ id: 7, text: "seeded step", status: "in_progress" }], nextId: 8 };
	const seeded = createTodoTool({ initialState: seed });
	const seededText = await seeded.execute("h", { action: "list" });
	check(
		seededText.content[0]?.type === "text" && seededText.content[0].text.includes("[>] #7: seeded step"),
		"H: initialState seeds the list",
	);

	// Deep-copied input: mutating the caller's object after construction must
	// not reach the tool.
	seed.items[0]!.status = "completed";
	seed.items.push({ id: 8, text: "late arrival", status: "pending" });
	const afterMutation = await seeded.execute("h", { action: "list" });
	check(
		afterMutation.content[0]?.type === "text" &&
			afterMutation.content[0].text.includes("[>] #7: seeded step") &&
			!afterMutation.content[0].text.includes("late arrival"),
		"H: initialState is deep-copied at construction",
	);
}

// ---- Scenario I: schema-invalid actions never reach the tool ----
{
	console.log("--- scenario I: schema-invalid action ---");
	// The loop validates arguments against the tool schema before execute, so
	// an unknown action becomes an isError tool result from the harness — the
	// tool's switch can never observe it, and the error result carries no
	// snapshot for readTodoState to pick up.
	const bogus = { action: "bogus" } as unknown as TodoToolInput;
	const { agent } = todoAgent([{ action: "add", text: "real step" }, bogus, { action: "list" }], "I done");
	await agent.prompt("mix in an invalid action");

	const results = todoResults(agent.state.messages);
	check(
		results.length === 3 &&
			results[1] !== undefined &&
			results[1].isError &&
			results[1].text.includes("Validation failed") &&
			results[1].text.includes('Invalid option: expected one of'),
		"I: the bogus action is rejected by schema validation with an isError result",
	);
	const state = readTodoState(agent.state.messages);
	check(
		state !== undefined &&
			state.items.length === 1 &&
			state.items[0]?.text === "real step" &&
			finalTextOf(agent.state.messages).includes("I done"),
		"I: the snapshot-less error result is ignored and the run continues",
	);
}

check(
	TODO_TOOL_GUIDANCE.includes("replace") && TODO_TOOL_GUIDANCE.includes("in_progress"),
	"guidance: TODO_TOOL_GUIDANCE documents the tool's core actions",
);

console.log(failures === 0 ? "\nTODO VERIFY OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
