/**
 * Subagent tool regression, keyless like the compaction verify.
 *
 * The parent model is scripted to call the `subagent` tool; each child agent
 * runs on its own scripted model that calls the inherited `echo` tool once and
 * then answers. Asserts the agreed behaviors:
 *   A (fan-out of 2): children inherit the parent tools minus the subagent
 *      tool, run concurrently, the parent's next request happens only after
 *      every child finished, both final messages (plus usage lines) merge into
 *      one tool result, children actually execute the inherited tool, children
 *      get the subagent system prompt (budget rule appended). Child 0's report
 *      exceeds maxOutputChars: the correction cycle makes it write the full
 *      report to the dictated file and answer with a summary plus the verified
 *      path.
 *   B (single prompt): no minimum — one subagent works.
 *   C (hard cap): 3 prompts against maxConcurrent 2 fail fast with an error
 *      tool result and the parent loop continues.
 *   D (factory crash): a host createAgent that throws mid-batch must not
 *      reject the whole call — the surviving child's result still returns.
 *   E (surrogate cut): the FAILED head excerpt of a never-compliant child
 *      never splits a UTF-16 surrogate pair.
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
 *   M (write failure self-heal): the first write to the dictated report path
 *      fails; the child sees the tool error and retries inside its own loop —
 *      no harness fallback exists — then complies.
 *   N (shortened-but-no-file): a within-budget reply that neither writes the
 *      file nor references the path is not compliance; the round-2 corrective
 *      diagnoses both problems and the child then complies.
 *   P (exhaustion): a child that never complies is FAILED after 2 correction
 *      rounds, with no report file ever created.
 *   Q (boundary): a final message exactly at maxOutputChars never triggers
 *      correction.
 *   R (path rules): dictated paths are file-safe-sanitized, unique per child,
 *      and each file carries its own child's verbatim report. The corrected
 *      outcome's details fields are asserted on the parent's toolResult.
 *   S (turn cap during correction): a child that stalls in a correction
 *      round with tool calls is still killed by maxTurns — the guard beats
 *      the budget cycle, and the budget reason never appears.
 *   T (parent abort during correction): a child hung in a correction round
 *      is aborted through the parent's signal; the call resolves FAILED
 *      (aborted), no report file exists, and the budget reason never
 *      appears.
 *   U (empty report file): a child that writes an EMPTY file at the
 *      dictated path and claims compliance fails the stat check; round 2
 *      diagnoses exactly the empty-file problem and a real write complies.
 * Run: node examples/verify-subagent.ts
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
	Agent,
	EventStream,
	createSubagentTool,
	createUnavailableModel,
	type AgentEvent,
	type AgentMessage,
	type AgentModel,
	type AgentTool,
	type AssistantMessage,
	type StreamFn,
	type SubagentChildInfo,
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

function lastUserText(context: unknown): string {
	const messages = (context as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }).messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "user") continue;
		return message.content
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
	}
	return "";
}

/** The report path dictated by a corrective message, as the child sees it. */
function dictatedPathOf(context: unknown): string | undefined {
	return lastUserText(context).match(/(\S*subagent-outputs\/\S+\.md)/)?.[1];
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
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
	/** Correction-round behavior when the final message exceeds the budget. */
	correction?: {
		/** Answer every corrective with the same over-budget final — never complies. */
		never?: boolean;
		/** Answer this many correctives with a short reply that neither writes the file nor references the path. */
		disobedientShortReplies?: number;
		/** Content written to the dictated file (defaults to finalText). */
		reportContent?: string;
		/** Stall every corrective round with echo tool calls instead of writing (maxTurns bait). */
		stallWithToolCalls?: boolean;
		/** Go silent on the first corrective-round request until aborted (parent-abort bait). */
		hangInCorrection?: boolean;
		/** Write an empty file first and claim compliance, then write the real report after round 2. */
		emptyWriteThenClaim?: boolean;
	};
}

interface ScenarioResult {
	parentMessages: AgentMessage[];
	childToolsets: AgentTool[][];
	childSystemPrompts: string[];
	childInits: Array<{ prompt: string; index: number; total: number; toolCallId: string }>;
	timeline: string[];
	echoLog: string[];
	/** Every write attempt against a dictated path (failures included). */
	writeAttempts: string[];
	/** Successful writes only. */
	writeLog: string[];
	/** Corrective messages the children received, in order (consecutive duplicates collapsed). */
	correctives: string[];
	/** Temp cwd the dictated paths landed under (set by tempCwd). */
	tempDir?: string;
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
		extraChildTools?: AgentTool[];
		onChildEvent?: (child: SubagentChildInfo, event: AgentEvent) => void;
		/** Run under a temp cwd so dictated report paths land in a scratch dir. */
		tempCwd?: boolean;
		/** Number of fake-write attempts that fail with an error before one succeeds. */
		failingWrites?: number;
		/** The parent's subagent tool-call id (default "parent-t1"). */
		parentToolCallId?: string;
		/** Abort the parent run this many ms after it starts. */
		abortParentAfterMs?: number;
	},
): Promise<ScenarioResult> {
	const timeline: string[] = [];
	const echoLog: string[] = [];
	const writeAttempts: string[] = [];
	const writeLog: string[] = [];
	const correctives: string[] = [];
	const writtenPaths = new Set<string>();
	let failingWrites = options?.failingWrites ?? 0;
	const childToolsets: AgentTool[][] = [];
	const childSystemPrompts: string[] = [];
	const childInits: ScenarioResult["childInits"] = [];
	let childIndex = -1;

	const echo: AgentTool = {
		name: "echo",
		label: "echo",
		description: "echoes the message back",
		parameters: z.object({ msg: z.string() }),
		async execute(_toolCallId, params) {
			const msg = (params as { msg: string }).msg;
			echoLog.push(msg);
			return { content: [{ type: "text", text: `echo:${msg}` }], details: {} };
		},
	};

	const needsWrite = childScripts.some((script) => script.correction !== undefined);
	const fakeWrite: AgentTool = {
		name: "write",
		label: "write",
		description: "writes a file (test fake)",
		parameters: z.object({ path: z.string(), content: z.string() }),
		async execute(_toolCallId, params) {
			const { path, content } = params as { path: string; content: string };
			writeAttempts.push(path);
			if (failingWrites > 0) {
				failingWrites--;
				throw new Error("EACCES: permission denied (simulated)");
			}
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content);
			if (content.length > 0) writtenPaths.add(path);
			writeLog.push(path);
			return { content: [{ type: "text", text: `Successfully wrote to ${path}` }], details: {} };
		},
	};

	const createAgent = (init: {
		tools: AgentTool[];
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
		const script = childScripts[n]!;
		let requestNo = 0;
		let disobedientLeft = script.correction?.disobedientShortReplies ?? 0;
		let claimedEmpty = false;
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
			if (requestNo >= 3) {
				const corrective = lastUserText(_context);
				if (correctives.at(-1) !== corrective) correctives.push(corrective);
			}
			if (requestNo >= 3 && script.correction?.hangInCorrection) {
				// Hung model call inside a correction round: no events until the
				// abort signal fires, then the contract's aborted message.
				const fail = () => pushScriptedReply(stream, reply([], "aborted"));
				if (opts?.signal?.aborted) {
					fail();
					return stream as never;
				}
				opts?.signal?.addEventListener("abort", fail, { once: true });
				return stream as never;
			}
			const dictated = dictatedPathOf(_context);
			const written = dictated !== undefined && writtenPaths.has(dictated);
			const attempts = dictated === undefined ? 0 : writeAttempts.filter((p) => p === dictated).length;
			const toolName = script.toolName ?? "echo";
			let message: AssistantMessage;
			if (script.loop || requestNo === 1) {
				message = reply(
					[
						{
							type: "toolCall",
							id: `child-${n}-t${requestNo}`,
							name: toolName,
							arguments: { msg: `call-${n}` },
						},
					],
					"toolUse",
				);
			} else if (requestNo === 2 || script.correction?.never) {
				message = reply([{ type: "text", text: script.finalText }], "stop");
			} else if (disobedientLeft > 0) {
				disobedientLeft--;
				message = reply([{ type: "text", text: "shortened report without the file" }], "stop");
			} else if (script.correction?.stallWithToolCalls) {
				message = reply(
					[
						{
							type: "toolCall",
							id: `child-${n}-t${requestNo}`,
							name: toolName,
							arguments: { msg: `call-${n}` },
						},
					],
					"toolUse",
				);
			} else if (script.correction?.emptyWriteThenClaim && attempts === 1 && !claimedEmpty) {
				// The empty write happened; claim compliance once without a real report.
				claimedEmpty = true;
				message = reply([{ type: "text", text: `SUMMARY: the report is filed.\nfull report: ${dictated}` }], "stop");
			} else if (!written) {
				const firstWrite = attempts === 0;
				const content =
					firstWrite && script.correction?.emptyWriteThenClaim
						? ""
						: (script.correction?.reportContent ?? script.finalText);
				message = reply(
					[
						{
							type: "toolCall",
							id: `child-${n}-w${requestNo}`,
							name: "write",
							arguments: { path: dictated ?? "", content },
						},
					],
					"toolUse",
				);
			} else {
				message = reply([{ type: "text", text: `SUMMARY: the report is filed.\nfull report: ${dictated}` }], "stop");
			}
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
		getTools: () => [echo, ...(needsWrite ? [fakeWrite] : []), ...(options?.extraChildTools ?? []), subagent],
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
	const parentStream: StreamFn = (_model, _context) => {
		parentRequestNo++;
		timeline.push(`parent-req:${parentRequestNo}`);
		const stream = newStream();
		const message =
			parentRequestNo === 1
				? reply(
						[
							{
								type: "toolCall",
								id: options?.parentToolCallId ?? "parent-t1",
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
	let tempDir: string | undefined;
	const prevCwd = process.cwd();
	if (options?.tempCwd) {
		tempDir = await mkdtemp(join(tmpdir(), "pico-subagent-verify-"));
		process.chdir(tempDir);
	}
	const abortTimer =
		options?.abortParentAfterMs !== undefined ? setTimeout(() => parent.abort(), options.abortParentAfterMs) : undefined;
	try {
		await parent.prompt(`Run ${label}.`);
	} finally {
		if (abortTimer !== undefined) clearTimeout(abortTimer);
		if (tempDir !== undefined) process.chdir(prevCwd);
	}

	return {
		parentMessages: parent.state.messages,
		childToolsets,
		childSystemPrompts,
		childInits,
		timeline,
		echoLog,
		writeAttempts,
		writeLog,
		correctives,
		...(tempDir !== undefined ? { tempDir } : {}),
	};
}

// ---- Scenario A: fan-out of 2, one child over budget (correction path) ----
{
	console.log("--- scenario A: two parallel subagents, one over budget ---");
	const bigReport = `REPORT-A ${"a".repeat(3_000)}`;
	const summary = "SUMMARY: the report is filed.";
	let tempDir: string | undefined;
	try {
		const r = await runScenario(
			"A",
			["TASK-A with a long report", "TASK-B quick"],
			[
				{ finalText: bigReport, delayMs: 120, correction: {} },
				{ finalText: "RESULT-FOR-B", delayMs: 10 },
			],
			{ maxOutputChars: 400, tempCwd: true },
		);
		tempDir = r.tempDir;
		const texts = toolResultTexts(r.parentMessages);
		const subagentResult = texts.find((text) => text.includes("<subagent"));
		const reportPath = subagentResult?.match(/(\S*subagent-outputs\/\S+\.md)/)?.[1];

		check(
			r.childToolsets.length === 2 &&
				r.childToolsets.every((set) => set.some((tool) => tool.name === "echo") && !set.some((tool) => tool.name === "subagent")),
			"A: children inherit parent tools minus the subagent tool",
		);
		check(
			r.childSystemPrompts.every((prompt) => prompt.includes("subagent") && prompt.includes("Final-message budget")),
			"A: children run with the subagent system prompt (budget rule appended)",
		);
		check(
			r.timeline.indexOf("child-req:1:1") !== -1 && r.timeline.indexOf("child-req:0:2") !== -1
				? r.timeline.indexOf("child-req:1:1") < r.timeline.indexOf("child-req:0:2")
				: false,
			"A: children ran concurrently (child 1 started before child 0 finished)",
		);
		check(
			r.timeline.indexOf("parent-req:2") > r.timeline.lastIndexOf("child-req:0:4") &&
				r.timeline.indexOf("parent-req:2") > r.timeline.lastIndexOf("child-req:1:2"),
			"A: parent continued only after every child finished (including correction rounds)",
		);
		check(
			subagentResult !== undefined && subagentResult.includes(summary) && subagentResult.includes("RESULT-FOR-B"),
			"A: tool result merges the corrected summary and the small child report",
		);
		check(
			subagentResult !== undefined && subagentResult.includes("[report verified:") && subagentResult.includes("bytes]"),
			"A: oversized child complied — verified report line present",
		);
		check(
			reportPath !== undefined && (await fileExists(reportPath)) && (await readFile(reportPath, "utf8")) === bigReport,
			"A: the full report landed verbatim at the dictated path",
		);
		const toolResult = r.parentMessages.find(
			(m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult" && m.toolName === "subagent",
		);
		const detailsList = toolResult?.details as
			| Array<{ ok: boolean; corrected?: boolean; correctionRounds?: number; reportPath?: string; reportBytes?: number }>
			| undefined;
		check(
			detailsList !== undefined &&
				detailsList.length === 2 &&
				detailsList[0]!.ok === true &&
				detailsList[0]!.corrected === true &&
				detailsList[0]!.correctionRounds === 1 &&
				detailsList[0]!.reportPath === reportPath &&
				detailsList[0]!.reportBytes === bigReport.length &&
				detailsList[1]!.ok === true &&
				detailsList[1]!.corrected === undefined,
			"A: correction outcomes recorded in toolResult details (corrected/rounds/path/bytes)",
		);
		check(
			subagentResult !== undefined && subagentResult.includes("tokens,") && subagentResult.includes("tool calls,"),
			"A: per-subagent usage lines present",
		);
		check(r.echoLog.includes("call-0") && r.echoLog.includes("call-1"), "A: children executed the inherited echo tool");

		const finalAssistant = r.parentMessages
			.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
			.at(-1);
		check(finalAssistant?.content.some((b) => b.type === "text" && b.text.includes("A done")) === true, "A: parent task completed");
	} finally {
		if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
	}
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

// ---- Scenario E: the FAILED head excerpt never splits a surrogate pair ----
{
	console.log("--- scenario E: surrogate-safe FAILED head excerpt ---");
	// A never-compliant child: every correction round answers with the same
	// over-budget final, so the child is failed and its last output shown as
	// a labeled head excerpt. text = "a" + 1500 emoji = 3001 UTF-16 units; a
	// naive cut at 2000 lands mid-pair (position 1999 is a high surrogate),
	// so the cut must snap back to 1999.
	const { parentMessages, tempDir } = await runScenario(
		"E",
		["TASK-EMOJI"],
		[{ finalText: `a${"😀".repeat(1500)}`, delayMs: 5, correction: { never: true } }],
		{ maxOutputChars: 100, tempCwd: true },
	);
	try {
		const texts = toolResultTexts(parentMessages);
		const section = texts.find((text) => text.includes("<subagent"));
		check(
			section !== undefined && section.includes("FAILED (ignored the final-message budget after 2 correction rounds)"),
			"E: never-compliant child failed with the budget reason",
		);
		check(
			section !== undefined &&
				section.includes("last output (head 1999 of 3001 chars):") &&
				section.includes("a😀") &&
				section.includes("…"),
			"E: head excerpt snapped back to a code-point boundary (1999 of 3001)",
		);
		check(
			section !== undefined && section.includes("4 turns"),
			"E: correction-round turns are counted (4 total)",
		);
	} finally {
		if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
	}
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
	const hang: AgentTool = {
		name: "hang",
		label: "hang",
		description: "never settles until aborted",
		parameters: z.object({}),
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

// ---- Scenario M: a write failure is solved inside the child's own loop ----
{
	console.log("--- scenario M: write fails once, child retries itself ---");
	// The first write to the dictated path throws EACCES. The loop surfaces it
	// as an error tool result; the child sees the error on its next request
	// and re-issues the write, which succeeds. No harness fallback exists —
	// compliance is reached entirely inside the child's loop.
	const bigReport = `REPORT-M ${"m".repeat(600)}`;
	const { parentMessages, timeline, writeAttempts, writeLog, tempDir } = await runScenario(
		"M",
		["TASK-FLAKY-WRITE"],
		[{ finalText: bigReport, delayMs: 5, correction: {} }],
		{ maxOutputChars: 200, failingWrites: 1, tempCwd: true },
	);
	try {
		const texts = toolResultTexts(parentMessages);
		const section = texts.find((text) => text.includes("<subagent"));
		const path = section?.match(/(\S*subagent-outputs\/\S+\.md)/)?.[1];
		check(
			section !== undefined && !section.includes("FAILED") && section.includes("[report verified:"),
			"M: child overcame the failed write and complied",
		);
		check(writeAttempts.length === 2 && writeLog.length === 1, "M: two write attempts, one success");
		check(timeline.includes("child-req:0:5"), "M: the retry happened inside the child's loop (5 requests)");
		check(
			path !== undefined && (await fileExists(path)) && (await readFile(path, "utf8")) === bigReport,
			"M: the full report landed at the dictated path",
		);
	} finally {
		if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
	}
}

// ---- Scenario N: shortening without writing is not compliance ----
{
	console.log("--- scenario N: shortened reply without the file gets a second correction ---");
	// Correction round 1: the child answers within budget but neither writes
	// the file nor references the path. The round-2 corrective must diagnose
	// exactly those two problems; the child then writes and complies.
	const bigReport = `REPORT-N ${"n".repeat(600)}`;
	const { parentMessages, timeline, correctives, tempDir } = await runScenario(
		"N",
		["TASK-SHORTEN-NO-FILE"],
		[{ finalText: bigReport, delayMs: 5, correction: { disobedientShortReplies: 1 } }],
		{ maxOutputChars: 200, tempCwd: true },
	);
	try {
		const texts = toolResultTexts(parentMessages);
		const section = texts.find((text) => text.includes("<subagent"));
		check(
			correctives.length === 2 &&
				correctives[0]!.includes("over the budget of 200") &&
				correctives[0]!.includes("Write the complete report"),
			"N: round-1 corrective stated the budget violation and the fix",
		);
		check(
			correctives[1]!.includes("does not reference the report file") &&
				correctives[1]!.includes("No non-empty file exists"),
			"N: round-2 corrective diagnosed the missing file and missing path reference",
		);
		check(
			section !== undefined && !section.includes("FAILED") && section.includes("[report verified:"),
			"N: child complied on the second round",
		);
		check(
			timeline.includes("child-req:0:5") && !timeline.includes("child-req:0:6"),
			"N: five requests — echo, over-budget final, disobedient reply, write, summary",
		);
	} finally {
		if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
	}
}

// ---- Scenario P: exhausted corrections fail the child without any file ----
{
	console.log("--- scenario P: exhausted corrections fail the child ---");
	const { parentMessages, tempDir } = await runScenario(
		"P",
		["TASK-NEVER"],
		[{ finalText: `REPORT-P ${"p".repeat(500)}`, delayMs: 5, correction: { never: true } }],
		{ maxOutputChars: 200, tempCwd: true },
	);
	try {
		const texts = toolResultTexts(parentMessages);
		const section = texts.find((text) => text.includes("<subagent"));
		let outputsDirExists = false;
		try {
			await stat(join(tempDir!, ".pico", "subagent-outputs"));
			outputsDirExists = true;
		} catch {
			/* expected: never created */
		}
		check(
			section !== undefined && section.includes("FAILED (ignored the final-message budget after 2 correction rounds)"),
			"P: FAILED with the exhaustion reason",
		);
		check(!outputsDirExists, "P: no report file was ever created");
		check(
			parentMessages
				.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
				.at(-1)
				?.content.some((b) => b.type === "text" && b.text.includes("P done")) === true,
			"P: parent finished after the failed child",
		);
	} finally {
		if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
	}
}

// ---- Scenario Q: exactly at budget never triggers correction ----
{
	console.log("--- scenario Q: boundary — exactly at budget ---");
	const exact = "x".repeat(50);
	const { parentMessages, timeline, tempDir } = await runScenario(
		"Q",
		["TASK-EXACT"],
		[{ finalText: exact, delayMs: 5 }],
		{ maxOutputChars: 50, tempCwd: true },
	);
	try {
		const texts = toolResultTexts(parentMessages);
		const section = texts.find((text) => text.includes("<subagent"));
		check(
			section !== undefined && !section.includes("FAILED") && section.includes(exact) && !section.includes("[report verified:"),
			"Q: exactly-at-budget final returned whole, no correction",
		);
		check(!timeline.includes("child-req:0:3"), "Q: no third request — correction never engaged");
	} finally {
		if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
	}
}

// ---- Scenario R: dictated paths are sanitized, unique, and verbatim ----
{
	console.log("--- scenario R: path sanitization and per-child reports ---");
	const report0 = `REPORT-R0 ${"r".repeat(400)}`;
	const report1 = `REPORT-R1 ${"s".repeat(400)}`;
	const { parentMessages, tempDir } = await runScenario(
		"R",
		["TASK-R0", "TASK-R1"],
		[
			{ finalText: report0, delayMs: 40, correction: { reportContent: report0 } },
			{ finalText: report1, delayMs: 5, correction: { reportContent: report1 } },
		],
		{ maxOutputChars: 200, tempCwd: true, parentToolCallId: "call/with spaces+odd" },
	);
	try {
		const texts = toolResultTexts(parentMessages);
		const section = texts.find((text) => text.includes("<subagent"));
		const paths = [...(section ?? "").matchAll(/(\S*subagent-outputs\/\S+\.md)/g)].map((match) => match[1]!);
		const files = [...new Set(paths)];
		check(files.length === 2, "R: two distinct report paths for two children");
		check(
			files.every((path) => /call-with-spaces-odd-[12]-\d+\.md$/.test(path)),
			"R: toolCallId sanitized to a file-safe unique name per child",
		);
		const contents = await Promise.all([...files].sort().map((path) => readFile(path, "utf8")));
		check(contents.includes(report0) && contents.includes(report1), "R: each dictated file carries its own child's verbatim report");
	} finally {
		if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
	}
}

// ---- Scenario S: maxTurns still guards during a correction round ----
{
	console.log("--- scenario S: turn cap fires inside the correction cycle ---");
	// The child goes over budget, then stalls the correction round with tool
	// calls instead of writing. maxTurns 3 kills it on the third tool-carrying
	// turn; the guard's reason labels the section and the budget reason never
	// appears — the correction cycle never outlives the guards.
	const { parentMessages, timeline, tempDir } = await runScenario(
		"S",
		["TASK-STALL"],
		[{ finalText: `REPORT-S ${"s".repeat(500)}`, delayMs: 0, correction: { stallWithToolCalls: true } }],
		{ maxOutputChars: 200, maxTurns: 3, tempCwd: true },
	);
	try {
		const texts = toolResultTexts(parentMessages);
		const section = texts.find((text) => text.includes("<subagent"));
		check(
			section !== undefined && section.includes("FAILED (subagent exceeded maxTurns=3)") && !section.includes("final-message budget"),
			"S: the turn cap beat the correction cycle; budget reason absent",
		);
		check(timeline.includes("child-req:0:4") && !timeline.includes("child-req:0:5"), "S: one post-kill contract request, no second correction round");
	} finally {
		if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
	}
}

// ---- Scenario T: the parent's abort reaches a child hung in a correction round ----
{
	console.log("--- scenario T: parent abort during a correction round ---");
	// The child goes over budget, then its first correction-round request goes
	// fully silent. The parent run is aborted 80ms in: the signal must reach
	// the child, the whole call resolves (no hang), the section is FAILED
	// (aborted), and no report file exists.
	const { parentMessages, tempDir } = await runScenario(
		"T",
		["TASK-HUNG-CORRECTION"],
		[{ finalText: `REPORT-T ${"t".repeat(500)}`, delayMs: 0, correction: { hangInCorrection: true } }],
		{ maxOutputChars: 200, tempCwd: true, abortParentAfterMs: 80 },
	);
	try {
		const texts = toolResultTexts(parentMessages);
		const section = texts.find((text) => text.includes("<subagent"));
		let outputsDirExists = false;
		try {
			await stat(join(tempDir!, ".pico", "subagent-outputs"));
			outputsDirExists = true;
		} catch {
			/* expected: never created */
		}
		check(
			section !== undefined && section.includes("FAILED (aborted)") && !section.includes("final-message budget"),
			"T: hung correction round aborted by the parent; budget reason absent",
		);
		check(!outputsDirExists, "T: no report file was created");
		check(
			parentMessages
				.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
				.at(-1) !== undefined,
			"T: the parent run resolved (prompt returned, no hang)",
		);
	} finally {
		if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
	}
}

// ---- Scenario U: an empty report file is not compliance ----
{
	console.log("--- scenario U: empty file fails the stat check ---");
	// The child writes an EMPTY file at the dictated path and claims
	// compliance with a path-bearing summary. The stat check (size > 0)
	// rejects it; round 2 must diagnose ONLY the empty-file problem (the
	// budget and the path reference were fine), and a real write then
	// complies.
	const bigReport = `REPORT-U ${"u".repeat(600)}`;
	const { parentMessages, correctives, tempDir } = await runScenario(
		"U",
		["TASK-EMPTY-FILE"],
		[{ finalText: bigReport, delayMs: 5, correction: { emptyWriteThenClaim: true } }],
		{ maxOutputChars: 200, tempCwd: true },
	);
	try {
		const texts = toolResultTexts(parentMessages);
		const section = texts.find((text) => text.includes("<subagent"));
		const path = section?.match(/(\S*subagent-outputs\/\S+\.md)/)?.[1];
		check(
			correctives.length === 2 &&
				correctives[1]!.includes("No non-empty file exists at the report path yet.") &&
				!correctives[1]!.includes("does not reference the report file") &&
				!correctives[1]!.includes("over the budget"),
			"U: round-2 corrective diagnosed exactly the empty file",
		);
		check(
			section !== undefined && !section.includes("FAILED") && section.includes("[report verified:"),
			"U: the real write complied on round 2",
		);
		check(
			path !== undefined && (await readFile(path, "utf8")) === bigReport,
			"U: the dictated file ended up with the verbatim report",
		);
	} finally {
		if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
	}
}

console.log(failures === 0 ? "\nSUBAGENT VERIFY OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
