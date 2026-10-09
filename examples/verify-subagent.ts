/**
 * Subagent tool regression, keyless like the compaction verify.
 *
 * The parent model is scripted to call the `subagent` tool; each child agent
 * runs on its own scripted model that calls the inherited `echo` tool once and
 * then answers. Asserts the agreed behaviors:
 *   A (fan-out of 2): children inherit the parent tools minus the subagent
 *      tool, run concurrently, the parent's next request happens only after
 *      every child finished, both final messages (plus usage lines) merge into
 *      one tool result, oversized child output is head-truncated, children
 *      actually execute the inherited tool, children get the subagent system
 *      prompt.
 *   B (single prompt): no minimum — one subagent works.
 *   C (hard cap): 3 prompts against maxConcurrent 2 fail fast with an error
 *      tool result and the parent loop continues.
 *   D (factory crash): a host createAgent that throws mid-batch must not
 *      reject the whole call — the surviving child's result still returns.
 *   E (surrogate cut): head-truncation never splits a UTF-16 surrogate pair.
 *   F (turn cap): a child that keeps issuing tool calls forever is aborted at
 *      maxTurns; the kill reason labels the FAILED section and the parent
 *      still finishes. The loop emits one extra turn_end carrying an empty
 *      synthetic "aborted" message — it must not count as a turn.
 *   G (inactivity): a child whose tool never settles produces total silence;
 *      the watchdog aborts it, the abort reaches the hung tool's signal, and
 *      the parent still finishes.
 *   H (silent first request): a first request that yields no events at all
 *      (the hung-provider-call shape) is killed by the watchdog armed at
 *      spawn; the run ends without a second request.
 *   I (natural finish at the cap): a child whose final turn lands exactly on
 *      maxTurns has no tool calls in it — a normal finish, never a violation.
 *   J (observability): onChildEvent delivers every child's events with full
 *      attribution (prompt by index, total, the parent toolCallId), spanning
 *      agent_start → agent_end with tool executions and turn boundaries
 *      visible, while the parent transcript stays isolated; the createAgent
 *      factory receives the same attribution fields.
 *   K (killed child stream): a maxTurns-killed child's event stream is
 *      complete — the host sees all three tool executions, the synthetic
 *      aborted turn_end, and agent_end last.
 *   L (async callback containment): a host onChildEvent that returns a
 *      rejected promise (legal under TS's void-return rule) fails that child
 *      loudly in its FAILED section instead of becoming an unhandled
 *      rejection that crashes the process.
 * Run: node examples/verify-subagent.ts
 */
import { Type } from "typebox";
import {
	Agent,
	EventStream,
	createSubagentTool,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AssistantMessage,
	type StreamFn,
	type SubagentChildInfo,
} from "../src/index.ts";

let failures = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

const fakeModel = { id: "mock", api: "anthropic-messages", provider: "mock", contextWindow: 1_000_000 } as never;

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
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

function toolResultTexts(messages: readonly AgentMessage[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const block of (message as { content: Array<{ type: string; text?: string }> }).content) {
			if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
		}
	}
	return texts;
}

interface ChildScript {
	/** Marker embedded in the child's final message. */
	finalText: string;
	/** Delay before the child's first model reply, proving overlap. */
	delayMs: number;
	/** Tool the child calls on its first turn instead of `echo` (default "echo"). */
	toolName?: string;
	/** Never answer: every request issues another tool call (a runaway looper). */
	loop?: boolean;
	/** First request yields no events at all until aborted (a hung provider call). */
	silent?: boolean;
}

interface ScenarioResult {
	parentMessages: AgentMessage[];
	childToolsets: AgentTool<any>[][];
	childSystemPrompts: string[];
	childInits: Array<{ prompt: string; index: number; total: number; toolCallId: string }>;
	timeline: string[];
	echoLog: string[];
}

/**
 * Builds a parent whose first request calls the subagent tool with `prompts`;
 * each spawned child is driven by ChildScript in prompt order.
 */
async function runScenario(
	label: string,
	prompts: string[],
	childScripts: ChildScript[],
	options?: {
		maxConcurrent?: number;
		maxOutputChars?: number;
		failCreateAgentAt?: number;
		maxTurns?: number;
		inactivityTimeoutMs?: number;
		extraChildTools?: AgentTool<any>[];
		onChildEvent?: (child: SubagentChildInfo, event: AgentEvent) => void;
	},
): Promise<ScenarioResult> {
	const timeline: string[] = [];
	const echoLog: string[] = [];
	const childToolsets: AgentTool<any>[][] = [];
	const childSystemPrompts: string[] = [];
	const childInits: ScenarioResult["childInits"] = [];
	let childIndex = -1;

	const echo: AgentTool<any, any> = {
		name: "echo",
		label: "echo",
		description: "echoes the message back",
		parameters: Type.Object({ msg: Type.String() }),
		async execute(_toolCallId, params) {
			const msg = (params as { msg: string }).msg;
			echoLog.push(msg);
			return { content: [{ type: "text", text: `echo:${msg}` }], details: {} } as never;
		},
	};

	const createAgent = (init: {
		tools: AgentTool<any>[];
		systemPrompt: string;
		prompt: string;
		index: number;
		total: number;
		toolCallId: string;
	}) => {
		childIndex++;
		const n = childIndex;
		if (options?.failCreateAgentAt === n + 1) throw new Error("host factory crashed");
		childToolsets.push(init.tools);
		childSystemPrompts.push(init.systemPrompt);
		childInits.push({ prompt: init.prompt, index: init.index, total: init.total, toolCallId: init.toolCallId });
		const script = childScripts[n];
		let requestNo = 0;
		const childStream: StreamFn = (_model, _context, opts) => {
			requestNo++;
			timeline.push(`child-req:${n}:${requestNo}`);
			const stream = newStream();
			// Real provider streams honor the abort signal by ending with an empty
			// stopReason "aborted" assistant message (the StreamFn contract); the
			// loop itself never pre-checks the signal between turns. The guards
			// (scenarios F/G) kill via abort, so this path is load-bearing here.
			if (opts?.signal?.aborted) {
				pushScriptedReply(stream, reply([], "aborted"));
				return stream as never;
			}
			if (script.silent) {
				// Hung provider connection: no events at all. The watchdog armed at
				// spawn must fire; when the abort signal reaches the request, the
				// stream ends with an aborted message per the contract.
				const fail = () => pushScriptedReply(stream, reply([], "aborted"));
				opts?.signal?.addEventListener("abort", fail, { once: true });
				return stream as never;
			}
			const toolName = script.toolName ?? "echo";
			const message =
				script.loop || requestNo === 1
					? reply(
							[
								{
									type: "toolCall",
									id: `child-${n}-t${requestNo}`,
									name: toolName,
									arguments: { msg: `call-${n}` },
								},
							],
							"toolUse",
						)
					: reply([{ type: "text", text: script.finalText }], "stop");
			void (async () => {
				if (requestNo === 1) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
				pushScriptedReply(stream, message);
			})();
			return stream as never;
		};
		return new Agent({
			initialState: { systemPrompt: init.systemPrompt, model: fakeModel, tools: init.tools },
			streamFn: childStream,
		});
	};

	const subagent = createSubagentTool({
		getTools: () => [echo, ...(options?.extraChildTools ?? []), subagent],
		createAgent,
		...(options?.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
		...(options?.maxOutputChars !== undefined ? { maxOutputChars: options.maxOutputChars } : {}),
		...(options?.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
		...(options?.inactivityTimeoutMs !== undefined
			? { inactivityTimeoutMs: options.inactivityTimeoutMs }
			: {}),
		...(options?.onChildEvent !== undefined ? { onChildEvent: options.onChildEvent } : {}),
	});

	let parentRequestNo = 0;
	const parentRequestTimes: number[] = [];
	const parentStream: StreamFn = (_model, _context) => {
		parentRequestNo++;
		parentRequestTimes.push(Date.now());
		timeline.push(`parent-req:${parentRequestNo}`);
		const stream = newStream();
		const message =
			parentRequestNo === 1
				? reply(
						[
							{
								type: "toolCall",
								id: "parent-t1",
								name: "subagent",
								arguments: { prompts },
							},
						],
						"toolUse",
					)
				: reply([{ type: "text", text: `${label} done` }], "stop");
		pushScriptedReply(stream, message);
		return stream as never;
	};

	const parent = new Agent({
		initialState: { systemPrompt: "You are a verification agent.", model: fakeModel, tools: [echo, subagent] },
		streamFn: parentStream,
	});
	await parent.prompt(`Run ${label}.`);

	return {
		parentMessages: parent.state.messages,
		childToolsets,
		childSystemPrompts,
		childInits,
		timeline,
		echoLog,
	};
}

// ---- Scenario A: fan-out of 2, the default shape ----
{
	console.log("--- scenario A: two parallel subagents ---");
	const bigText = `RESULT-FOR-A ${"a".repeat(3_000)}`;
	const { parentMessages, childToolsets, childSystemPrompts, timeline, echoLog } = await runScenario(
		"A",
		["TASK-A with a long report", "TASK-B quick"],
		[
			{ finalText: bigText, delayMs: 120 },
			{ finalText: "RESULT-FOR-B", delayMs: 10 },
		],
		{ maxOutputChars: 400 },
	);

	const texts = toolResultTexts(parentMessages);
	const subagentResult = texts.find((text) => text.includes("<subagent"));

	check(
		childToolsets.length === 2 &&
			childToolsets.every((set) => set.some((tool) => tool.name === "echo") && !set.some((tool) => tool.name === "subagent")),
		"A: children inherit parent tools minus the subagent tool",
	);
	check(
		childSystemPrompts.every((prompt) => prompt.includes("subagent")),
		"A: children run with the subagent system prompt",
	);
	check(
		timeline.indexOf("child-req:1:1") !== -1 && timeline.indexOf("child-req:0:2") !== -1
			? timeline.indexOf("child-req:1:1") < timeline.indexOf("child-req:0:2")
			: false,
		"A: children ran concurrently (child 1 started before child 0 finished)",
	);
	check(
		timeline.indexOf("parent-req:2") > timeline.lastIndexOf("child-req:0:2") &&
			timeline.indexOf("parent-req:2") > timeline.lastIndexOf("child-req:1:2"),
		"A: parent continued only after every child finished",
	);
	check(
		subagentResult !== undefined && subagentResult.includes("RESULT-FOR-A") && subagentResult.includes("RESULT-FOR-B"),
		"A: tool result merges both subagent reports",
	);
	check(
		subagentResult !== undefined && subagentResult.includes("tokens,") && subagentResult.includes("tool calls,"),
		"A: per-subagent usage lines present",
	);
	check(
		subagentResult !== undefined && subagentResult.includes("[subagent output truncated: kept 400 of"),
		"A: oversized child output head-truncated",
	);
	check(echoLog.includes("call-0") && echoLog.includes("call-1"), "A: children executed the inherited echo tool");

	const finalAssistant = parentMessages
		.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
		.at(-1);
	check(finalAssistant?.content.some((b) => b.type === "text" && b.text.includes("A done")) === true, "A: parent task completed");
}

// ---- Scenario B: a single prompt is allowed (no minimum) ----
{
	console.log("--- scenario B: single subagent ---");
	const { parentMessages, childToolsets } = await runScenario(
		"B",
		["TASK-SOLO"],
		[{ finalText: "RESULT-SOLO", delayMs: 5 }],
	);

	const texts = toolResultTexts(parentMessages);
	check(childToolsets.length === 1, "B: exactly one child spawned");
	check(texts.some((text) => text.includes("RESULT-SOLO")), "B: single subagent result returned");
}

// ---- Scenario C: the hard cap fails fast ----
{
	console.log("--- scenario C: hard cap on concurrent subagents ---");
	const { parentMessages, childToolsets } = await runScenario(
		"C",
		["TASK-1", "TASK-2", "TASK-3"],
		[{ finalText: "never", delayMs: 0 }, { finalText: "never", delayMs: 0 }, { finalText: "never", delayMs: 0 }],
		{ maxConcurrent: 2 },
	);

	const texts = toolResultTexts(parentMessages);
	check(childToolsets.length === 0, "C: no child spawned when the cap is exceeded");
	check(texts.some((text) => text.includes("exceed the hard cap")), "C: cap violation returned an error tool result");
	const finalAssistant = parentMessages
		.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
		.at(-1);
	check(finalAssistant?.content.some((b) => b.type === "text" && b.text.includes("C done")) === true, "C: parent loop continued after the error");
}

// ---- Scenario D: a crashing host createAgent must not reject the batch ----
{
	console.log("--- scenario D: host factory crash mid-batch ---");
	const { parentMessages, childToolsets } = await runScenario(
		"D",
		["TASK-1", "TASK-2"],
		[
			{ finalText: "RESULT-D1", delayMs: 10 },
			{ finalText: "never", delayMs: 0 },
		],
		{ failCreateAgentAt: 2 },
	);

	const texts = toolResultTexts(parentMessages);
	const merged = texts.find((text) => text.includes("<subagent"));
	check(childToolsets.length === 1, "D: first child spawned, second factory call crashed");
	check(
		merged !== undefined && merged.includes("RESULT-D1") && merged.includes("host factory crashed"),
		"D: surviving child's result and the crashed section both returned (batch not rejected)",
	);
	check(
		!texts.some((text) => text.includes("Validation failed") || text.includes("exceed the hard cap")),
		"D: factory crash surfaced as a FAILED section, not a tool error",
	);
}

// ---- Scenario E: truncation never splits a UTF-16 surrogate pair ----
{
	console.log("--- scenario E: surrogate-safe truncation ---");
	// text = "ab" + 100 emoji = 202 UTF-16 units; a naive cut at 5 would land
	// between the high and low surrogate of the second emoji.
	const { parentMessages } = await runScenario(
		"E",
		["TASK-EMOJI"],
		[{ finalText: `ab${"😀".repeat(100)}`, delayMs: 5 }],
		{ maxOutputChars: 5 },
	);

	const texts = toolResultTexts(parentMessages);
	check(
		texts.some((text) => text.includes("ab😀\n[subagent output truncated: kept 4 of 202 chars]")),
		"E: cut snapped back to a code-point boundary (kept 4 of 202)",
	);
}

// ---- Scenario F: the turn cap kills a runaway tool looper ----
{
	console.log("--- scenario F: maxTurns guard on a looping child ---");
	// The child never answers — every request issues another echo call. With
	// maxTurns 3 the guard fires on turn_end of turn 3 (a turn that still
	// carries tool calls): the child is aborted, so no 4th tool turn happens.
	// The loop still invokes the stream once more; the abort-contract reply
	// ends the run with an empty "aborted" message, which must NOT count as
	// a turn (section reports "3 turns", not 4).
	const { parentMessages, echoLog, timeline } = await runScenario(
		"F",
		["TASK-LOOP"],
		[{ finalText: "never reached", delayMs: 0, loop: true }],
		{ maxTurns: 3 },
	);

	const texts = toolResultTexts(parentMessages);
	const section = texts.find((text) => text.includes("<subagent"));
	check(
		section !== undefined && section.includes("FAILED (subagent exceeded maxTurns=3)"),
		"F: kill reason labels the FAILED section",
	);
	check(
		section !== undefined && section.includes("3 tool calls, 3 turns"),
		"F: exactly 3 counted turns — the synthetic aborted turn_end is not counted",
	);
	check(echoLog.filter((msg) => msg === "call-0").length === 3, "F: the 4th tool round never executed");
	check(timeline.includes("child-req:0:4") && !timeline.includes("child-req:0:5"), "F: one post-kill request, then the run ended");
	check(
		parentMessages
			.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
			.at(-1)
			?.content.some((b) => b.type === "text" && b.text.includes("F done")) === true,
		"F: parent finished after the kill",
	);
}

// ---- Scenario G: the inactivity watchdog kills a silent hang ----
{
	console.log("--- scenario G: inactivity guard on a hung tool ---");
	// The child calls `hang`, which never settles until its abort signal fires.
	// After the last child event, 120ms of total silence must trigger the
	// watchdog: the child is aborted, the abort reaches the hung tool, and the
	// parent still finishes.
	let hangSettled = false;
	const hang: AgentTool<any, any> = {
		name: "hang",
		label: "hang",
		description: "never settles until aborted",
		parameters: Type.Object({}),
		execute(_toolCallId, _params, signal) {
			return new Promise((_resolve, reject) => {
				const fail = () => {
					hangSettled = true;
					reject(new Error("hang aborted"));
				};
				if (signal?.aborted) {
					fail();
					return;
				}
				signal?.addEventListener("abort", fail, { once: true });
			});
		},
	};

	const { parentMessages } = await runScenario(
		"G",
		["TASK-HANG"],
		[{ finalText: "never reached", delayMs: 0, toolName: "hang" }],
		{ inactivityTimeoutMs: 120, extraChildTools: [hang] },
	);

	const texts = toolResultTexts(parentMessages);
	const section = texts.find((text) => text.includes("<subagent"));
	check(
		section !== undefined && section.includes("FAILED (subagent inactive for 120ms)"),
		"G: watchdog reason labels the FAILED section",
	);
	check(hangSettled, "G: the abort reached the hung tool's signal");
	check(
		parentMessages
			.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
			.at(-1)
			?.content.some((b) => b.type === "text" && b.text.includes("G done")) === true,
		"G: parent finished after the kill",
	);
}

// ---- Scenario H: the watchdog armed at spawn covers a silent first request ----
{
	console.log("--- scenario H: inactivity guard on a silent first request ---");
	// The child's first request yields no events whatsoever — the realistic
	// shape of a hung provider connection, covered only by the initial watchdog
	// arm before prompt() starts. The kill ends the run with a single request.
	const { parentMessages, timeline } = await runScenario(
		"H",
		["TASK-SILENT"],
		[{ finalText: "never reached", delayMs: 0, silent: true }],
		{ inactivityTimeoutMs: 120 },
	);

	const texts = toolResultTexts(parentMessages);
	const section = texts.find((text) => text.includes("<subagent"));
	check(
		section !== undefined && section.includes("FAILED (subagent inactive for 120ms)"),
		"H: watchdog reason labels the FAILED section",
	);
	check(
		timeline.includes("child-req:0:1") && !timeline.includes("child-req:0:2"),
		"H: exactly one child request was made",
	);
	check(
		parentMessages
			.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
			.at(-1)
			?.content.some((b) => b.type === "text" && b.text.includes("H done")) === true,
		"H: parent finished after the kill",
	);
}

// ---- Scenario I: finishing naturally exactly at the turn cap is not a violation ----
{
	console.log("--- scenario I: natural finish at maxTurns ---");
	// Two-turn child (tool turn + answer turn) with maxTurns 2. Turn 2 carries
	// no tool calls, so even though turns reached the cap it is a natural
	// finish: no kill, no FAILED section, the result is delivered.
	const { parentMessages } = await runScenario(
		"I",
		["TASK-AT-CAP"],
		[{ finalText: "RESULT-AT-CAP", delayMs: 5 }],
		{ maxTurns: 2 },
	);

	const texts = toolResultTexts(parentMessages);
	const section = texts.find((text) => text.includes("<subagent"));
	check(
		section !== undefined && !section.includes("FAILED") && section.includes("RESULT-AT-CAP"),
		"I: child finishing naturally at the cap is ok",
	);
	check(section !== undefined && section.includes("2 turns"), "I: both turns counted");
}

// ---- Scenario J: onChildEvent observability ----
{
	console.log("--- scenario J: onChildEvent observability ---");
	const events: Array<{ child: SubagentChildInfo; event: AgentEvent }> = [];
	const { parentMessages, childInits } = await runScenario(
		"J",
		["TASK-J-ALPHA", "TASK-J-BETA"],
		[
			{ finalText: "RESULT-J-ALPHA", delayMs: 60 },
			{ finalText: "RESULT-J-BETA", delayMs: 5 },
		],
		{ onChildEvent: (child, event) => {
			// Try to corrupt attribution (a frozen object throws in strict mode;
			// if freeze ever disappears, the write succeeds and the attribution
			// check below fails on index 99).
			try {
				(child as unknown as { index: number }).index = 99;
			} catch {
				/* the expected outcome */
			}
			events.push({ child, event });
		} },
	);

	check(events.length > 0, "J: child events were delivered");
	check(
		events.every(
			({ child }) =>
				child.total === 2 &&
				child.toolCallId === "parent-t1" &&
				(child.index === 0 ? child.prompt === "TASK-J-ALPHA" : child.prompt === "TASK-J-BETA"),
		),
		"J: every event carries correct attribution (prompt by index, total, parent toolCallId)",
	);
	const alpha = events.filter(({ child }) => child.index === 0);
	const beta = events.filter(({ child }) => child.index === 1);
	check(
		alpha.length > 0 &&
			beta.length > 0 &&
			alpha[0]!.event.type === "agent_start" &&
			alpha.at(-1)!.event.type === "agent_end" &&
			beta[0]!.event.type === "agent_start" &&
			beta.at(-1)!.event.type === "agent_end",
		"J: each child's stream spans agent_start → agent_end",
	);
	check(
		alpha.some(({ event }) => event.type === "tool_execution_start") &&
			alpha.some(({ event }) => event.type === "tool_execution_end" && !event.isError),
		"J: child tool executions are visible",
	);
	check(
		alpha.some(({ event }) => event.type === "turn_end") && beta.some(({ event }) => event.type === "turn_end"),
		"J: turn boundaries are visible for both children",
	);
	check(
		childInits.length === 2 &&
			childInits.every((init) => init.total === 2 && init.toolCallId === "parent-t1") &&
			childInits.find((init) => init.index === 0)?.prompt === "TASK-J-ALPHA" &&
			childInits.find((init) => init.index === 1)?.prompt === "TASK-J-BETA",
		"J: the createAgent factory receives the same attribution fields",
	);
	check(
		!parentMessages.some((message) => message.role === "toolResult" && JSON.stringify(message).includes("echo:call-")),
		"J: intermediate child tool output still never enters the parent transcript",
	);
}

// ---- Scenario K: a killed child's event stream is complete ----
{
	console.log("--- scenario K: killed child's event stream ---");
	// The looping child from scenario F, observed through onChildEvent: the
	// host must see all three tool executions, the synthetic aborted turn_end
	// produced by the kill, and agent_end as the final event.
	const killed: Array<{ child: SubagentChildInfo; event: AgentEvent }> = [];
	await runScenario(
		"K",
		["TASK-K-LOOP"],
		[{ finalText: "never reached", delayMs: 0, loop: true }],
		{ maxTurns: 3, onChildEvent: (child, event) => killed.push({ child, event }) },
	);

	check(killed.length > 0, "K: events flowed for the killed child");
	check(
		killed.filter(({ event }) => event.type === "tool_execution_start").length === 3,
		"K: all three tool executions were visible before the kill",
	);
	check(
		killed.some(
			({ event }) => event.type === "turn_end" && (event.message as { stopReason?: string }).stopReason === "aborted",
		),
		"K: the host saw the synthetic aborted turn_end the kill produced",
	);
	check(killed.at(-1)?.event.type === "agent_end", "K: the stream ran to agent_end");
}

// ---- Scenario L: an async host callback's rejection is contained ----
{
	console.log("--- scenario L: async onChildEvent rejection is contained ---");
	// TypeScript's return-type-void rule lets an async callback satisfy the
	// signature. The returned promise is never awaited (an observer must not
	// delay or wedge the run), and its rejection is routed into the child's
	// kill path: the section fails with the observer's error while neither
	// the parent nor the process goes down. Reaching these assertions at all
	// proves containment.
	const { parentMessages } = await runScenario(
		"L",
		["TASK-L"],
		[{ finalText: "RESULT-L", delayMs: 5 }],
		{
			onChildEvent: (_child, event) => {
				if (event.type === "agent_start") return Promise.reject(new Error("async observer failed"));
			},
		},
	);
	const texts = toolResultTexts(parentMessages);
	const section = texts.find((text) => text.includes("<subagent"));
	check(
		section !== undefined && section.includes("FAILED (onChildEvent observer failed: async observer failed)"),
		"L: the async rejection surfaced in the child's FAILED section",
	);
	check(
		parentMessages
			.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
			.at(-1)
			?.content.some((b) => b.type === "text" && b.text.includes("L done")) === true,
		"L: parent finished after the observer failure",
	);
}

console.log(failures === 0 ? "\nSUBAGENT VERIFY OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
