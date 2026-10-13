// pico-agent: subagent tool.
//
// Ported from the predecessor's extraction of earendil-works/pi v0.87.1 (placed
// among the harness tools, NOT part of the v0.87.1 vendoring).
// Schema substrate swapped: typebox → zod. Logic is unchanged.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Agent } from "../../agent.ts";
import type { AgentEvent, AgentMessage, AgentTool } from "../../types.ts";
import type { TextContent } from "../../../ai/types.ts";

const subagentSchema = z.object({
	prompts: z
		.array(
			z.string().describe("One self-contained task. The subagent cannot see this conversation."),
		)
		.min(1)
		.describe(
			"Independent tasks, one per subagent. They run in parallel and this call returns when all of them finish. Default to 2 entries; pass more only when the user explicitly asks for more.",
		),
});

export type SubagentToolInput = z.output<typeof subagentSchema>;

/** Per-subagent outcome recorded in the tool result `details`. */
export interface SubagentRunDetails {
	/** The prompt this subagent was spawned with. */
	prompt: string;
	/** False when the child aborted or ended with an error. */
	ok: boolean;
	/** Total tokens reported by the child's assistant messages. */
	tokens: number;
	/** Tool calls issued by the child. */
	toolCalls: number;
	/**
	 * Assistant turns the child completed (`turn_end` events; the synthetic
	 * abort marker emitted for a killed run does not count).
	 */
	turns: number;
	durationMs: number;
	/**
	 * True when the reported output is a head excerpt — FAILED sections only.
	 * Ok runs always carry the full budget-compliant final message.
	 */
	truncated: boolean;
	/** True when correction rounds ran and the child passed compliance. */
	corrected?: boolean;
	/** Correction rounds actually run when correction engaged (1-2). */
	correctionRounds?: number;
	/** The dictated report path when correction engaged. */
	reportPath?: string;
	/** Verified non-zero size of the report file, when it exists. */
	reportBytes?: number;
	/** Error message when `ok` is false. */
	error?: string;
}

/**
 * Build a fresh child agent. Called once per subagent, so each child gets its
 * own transcript. The host wires model, stream function, compaction, etc. The
 * attribution fields (`prompt`, `index`, `total`, `toolCallId`) identify the
 * child for logging/UI — they do not change what the child runs.
 */
export type SubagentAgentFactory = (init: {
	tools: AgentTool<any>[];
	systemPrompt: string;
	/** The task prompt this child will run. */
	prompt: string;
	/** 0-based position within the batch. */
	index: number;
	/** Number of prompts in the batch. */
	total: number;
	/** The parent's subagent tool-call id; matches `tool_execution_*` events in the parent's stream. */
	toolCallId: string;
}) => Agent;

/** Identifies which child an `onChildEvent` observation belongs to. */
export interface SubagentChildInfo {
	/**
	 * The parent's subagent tool-call id — the same id the parent's own event
	 * stream reports as `tool_execution_start`/`tool_execution_end` for the
	 * `subagent` tool, so host UIs can group children under their call.
	 */
	toolCallId: string;
	/** The task prompt this child was spawned with. */
	prompt: string;
	/** 0-based position within the batch. */
	index: number;
	/** Number of prompts in the batch. */
	total: number;
}

export interface SubagentToolOptions {
	/** Returns the parent's CURRENT tools; resolved on every tool call, not at factory time. */
	getTools: () => readonly AgentTool<any>[];
	/** Constructs the child agent from the inherited toolset and system prompt. */
	createAgent: SubagentAgentFactory;
	/** Hard cap on subagents per tool call. Default 4. */
	maxConcurrent?: number;
	/**
	 * Final-message budget per child, in characters. Default 20000. A child
	 * that ends naturally with a larger final message must, within 2
	 * correction rounds, write the complete report to a dictated path under
	 * `.pico/subagent-outputs/` and reply with only a summary plus the path;
	 * the report file's existence is verified. A child that never complies is
	 * failed — ok runs are never truncated. Keep the budget comfortably
	 * larger than a dictated report path, or compliance becomes unreachable.
	 */
	maxOutputChars?: number;
	/**
	 * Cap on completed assistant turns per child (one per `turn_end` event). When
	 * a turn that still issues tool calls reaches the cap, the child is aborted,
	 * bounding runaway tool marathons. A turn without tool calls is the child
	 * finishing naturally and is never counted as a violation. Default 50;
	 * 0 disables the gate.
	 */
	maxTurns?: number;
	/**
	 * Abort a child that produces no events at all (no model deltas, no tool
	 * activity) for this many milliseconds — a hung provider call or a tool that
	 * never settles. Any child event resets the clock, so a slow-but-alive child
	 * is never killed. Default 300000 (5 minutes); 0 disables the gate.
	 */
	inactivityTimeoutMs?: number;
	/** Child system prompt. Defaults to {@link DEFAULT_SUBAGENT_SYSTEM_PROMPT}; the final-message budget rule is appended to either. */
	systemPrompt?: string;
	/**
	 * Live read-only observation of every child's event stream — the same
	 * `AgentEvent` vocabulary as `agent.subscribe()`, so one renderer can serve
	 * the parent and the children. Called synchronously in arrival order,
	 * before guard processing for that event; must not throw, and keep it
	 * synchronous — a returned promise is never awaited (an observer must not
	 * delay the run), and its rejection is routed into the child's kill path
	 * (FAILED section) rather than crashing the process as an unhandled
	 * rejection. The `child` object is frozen. Observation only: nothing
	 * observed here enters the parent context, and the callback receives no
	 * handle to steer or abort a child.
	 */
	onChildEvent?: (child: SubagentChildInfo, event: AgentEvent) => void;
}

export const DEFAULT_SUBAGENT_SYSTEM_PROMPT = [
	"You are a subagent spawned by a parent agent to complete one self-contained task.",
	"You cannot see the parent's conversation; the task prompt is all the context you have.",
	"Work with the available tools, then report the result as your final message.",
	"The final message is the only part the parent will see — it must be a complete, self-contained answer.",
	"Intermediate tool output is discarded, so put everything the parent needs into that final message.",
].join(" ");

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_MAX_TURNS = 50;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 300_000;
const PROMPT_HEAD_CHARS = 160;
/** Correction rounds before a non-compliant child is failed. */
const CORRECTION_ROUNDS = 2;
/** Summary budget dictated in the corrective message. */
const SUMMARY_BUDGET_CHARS = 4_000;
/** Head excerpt of the last output shown in FAILED sections. */
const FAILED_HEAD_CHARS = 2_000;
/** Report files dictated by correction rounds live here, under the parent process's cwd. */
const SUBAGENT_OUTPUT_DIR = ".pico/subagent-outputs";

interface ChildOutcome {
	details: SubagentRunDetails;
	section: string;
}

function assistantMessages(messages: readonly AgentMessage[]) {
	return messages.filter((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant");
}

function finalText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = (message.content as Array<{ type: string; text?: string }>)
			.filter((block) => block.type === "text" && typeof block.text === "string" && block.text.length > 0)
			.map((block) => block.text)
			.join("\n");
		if (text.length > 0) return text;
	}
	return "";
}

function summarizeUsage(messages: readonly AgentMessage[]): { tokens: number; toolCalls: number } {
	let tokens = 0;
	let toolCalls = 0;
	for (const message of assistantMessages(messages)) {
		const usage = message.usage;
		tokens += usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		for (const block of message.content as Array<{ type: string }>) {
			if (block.type === "toolCall") toolCalls++;
		}
	}
	return { tokens, toolCalls };
}

function promptHead(prompt: string): string {
	return prompt.length > PROMPT_HEAD_CHARS ? `${prompt.slice(0, PROMPT_HEAD_CHARS)}…` : prompt;
}

/** Result of the final-message budget enforcement, when it engaged. */
interface FinalMessageCorrection {
	/** Dictated absolute report path. */
	path: string;
	/** Unique report file name — the compliance locator. */
	fileName: string;
	/** Correction rounds actually run (1..CORRECTION_ROUNDS). */
	rounds: number;
	/** All three compliance conditions held on the last check. */
	compliant: boolean;
	/** Verified non-zero size of the report file, when it exists. */
	bytes?: number;
	/** False when a correction run ended abnormally (abort/error) before the rounds ran out. */
	endedNaturally: boolean;
}

function fileSafeId(id: string): string {
	const cleaned = id.replaceAll(/[^A-Za-z0-9_-]/g, "-");
	return cleaned.length > 0 ? cleaned : "call";
}

/** Largest cut ≤ limit that never splits a UTF-16 surrogate pair. */
function cutAtCharBoundary(text: string, limit: number): number {
	const cut = Math.min(text.length, limit);
	if (cut < text.length) {
		const codeBefore = text.charCodeAt(cut - 1);
		if (codeBefore >= 0xd800 && codeBefore <= 0xdbff) return cut - 1;
	}
	return cut;
}

/** Non-zero size of a regular file, or undefined when missing/empty/not a file. */
async function reportFileBytes(path: string): Promise<number | undefined> {
	try {
		const info = await stat(path);
		return info.isFile() && info.size > 0 ? info.size : undefined;
	} catch {
		return undefined;
	}
}

function correctiveMessage(
	state: { textChars: number; overBudget: boolean; mentionsPath: boolean; filePresent: boolean; instructed: boolean },
	reportPath: string,
	maxOutputChars: number,
): string {
	const problems = [
		state.overBudget ? `Your final message is ${state.textChars} characters, over the budget of ${maxOutputChars}.` : undefined,
		state.instructed && !state.mentionsPath ? "Your reply does not reference the report file." : undefined,
		state.filePresent ? undefined : "No non-empty file exists at the report path yet.",
	].filter((line): line is string => line !== undefined);
	return [
		"Your report does not satisfy the final-message budget rule:",
		...problems.map((line) => `- ${line}`),
		"",
		"Write the complete report to exactly this path with your write tool:",
		reportPath,
		"The write tool creates parent directories automatically. If the write fails, read the error, fix the cause, and retry.",
		"",
		"Then reply with ONLY:",
		`1. A summary of the report, at most ${SUMMARY_BUDGET_CHARS} characters.`,
		`2. This exact line: full report: ${reportPath}`,
	].join("\n");
}

/**
 * Final-message budget enforcement. Runs after a child finishes naturally:
 * an over-budget final message triggers up to {@link CORRECTION_ROUNDS}
 * correction rounds in the SAME transcript — the child must write the
 * complete report to the dictated path itself and reply with a summary plus
 * the path. Compliance = budget respected AND path referenced AND a verified
 * non-empty file (stat; content is not compared — the child owns the file).
 * Write failures are the child's to solve inside its own loop: a failed
 * write is an ordinary tool error it must react to, like any other tool
 * failure. Returns undefined when no correction was needed.
 */
async function enforceFinalMessageBudget(
	child: Agent,
	toolCallId: string,
	index: number,
	maxOutputChars: number,
	signal: AbortSignal | undefined,
): Promise<FinalMessageCorrection | undefined> {
	const naturalEnd = () => {
		const last = assistantMessages(child.state.messages).at(-1);
		return last !== undefined && last.stopReason === "stop";
	};
	// Correction targets runs that finished naturally over budget; guard and
	// error kills keep their own failure reporting.
	if (!naturalEnd()) return undefined;
	if (finalText(child.state.messages).length <= maxOutputChars) return undefined;

	const fileName = `${fileSafeId(toolCallId)}-${index + 1}-${Date.now()}.md`;
	const path = join(process.cwd(), SUBAGENT_OUTPUT_DIR, fileName);
	let rounds = 0;
	let bytes: number | undefined;
	let compliant = false;
	while (rounds < CORRECTION_ROUNDS && !compliant) {
		// The parent aborted between rounds: the child is idle, so child.abort()
		// was a no-op — never start another child run after the abort, or a
		// corrective round would outlive the parent's tool call.
		if (signal?.aborted) {
			return { path, fileName, rounds, compliant: false, bytes: await reportFileBytes(path), endedNaturally: false };
		}
		rounds++;
		const text = finalText(child.state.messages);
		const present = await reportFileBytes(path);
		await child.prompt(
			correctiveMessage(
				{
					textChars: text.length,
					overBudget: text.length > maxOutputChars,
					mentionsPath: text.includes(path) || text.includes(fileName),
					filePresent: present !== undefined,
					instructed: rounds > 1,
				},
				path,
				maxOutputChars,
			),
		);
		if (!naturalEnd()) return { path, fileName, rounds, compliant: false, bytes: present, endedNaturally: false };
		const corrected = finalText(child.state.messages);
		bytes = await reportFileBytes(path);
		compliant =
			corrected.length <= maxOutputChars &&
			(corrected.includes(path) || corrected.includes(fileName)) &&
			bytes !== undefined;
	}
	return { path, fileName, rounds, compliant, bytes, endedNaturally: true };
}

/**
 * Create the `subagent` tool: spawns one child agent per prompt, in parallel,
 * with the parent's current tools minus the subagent tool itself.
 *
 * Each child runs in a fresh, empty context and only its final message flows
 * back to the parent (budget-enforced — see "Final-message budget"), so
 * intermediate tool output never enters the parent transcript. This call
 * blocks until every child finishes; the parent's abort signal aborts all
 * children.
 *
 * Children do not get the subagent tool, so spawning never recurses.
 *
 * ## Stuck-child guards
 *
 * Two independent gates bound a child that never finishes on its own:
 *
 * - **`maxTurns`** (default 50, 0 disables): counts completed assistant turns
 *   (`turn_end` events). When a turn that still issues tool calls reaches the
 *   cap, the child is aborted — this bounds runaway tool marathons. A turn
 *   without tool calls is the child finishing naturally, so it never counts
 *   as a violation even at the cap.
 * - **`inactivityTimeoutMs`** (default 300000, 0 disables): a wall-clock
 *   watchdog armed at spawn and reset by EVERY child event (model deltas,
 *   tool starts/updates/ends). It fires only on total silence — a hung
 *   provider call or a tool that never settles — so a slow-but-alive child
 *   is never killed.
 *
 * Both gates kill via `child.abort()`: the child performs no further tool
 * work, the in-flight or next provider request aborts immediately per the
 * StreamFn contract and ends the run with an empty assistant message with
 * stopReason "aborted", so `prompt()` resolves instead of hanging. The kill
 * reason then labels that child's FAILED section, and the reported final
 * message skips the empty abort marker and walks back to the child's last
 * real words.
 *
 * Both gates rely on cooperative abort: a host-supplied tool or stream
 * function that ignores the abort signal can still hang a child (the parent
 * run's own abort remains the escape hatch).
 *
 * ## Final-message budget
 *
 * A child that ends naturally with a final message over `maxOutputChars`
 * enters correction rounds in its own transcript: it must write the
 * complete report to a dictated path under `.pico/subagent-outputs/`
 * (inside the parent process's cwd) and reply with only a summary plus
 * that path. Compliance requires all of: budget respected, path
 * referenced, and a verified non-empty report file (stat; content is not
 * compared — the child owns the file). Write failures are the child's to
 * solve inside its own loop: a failed write is an ordinary tool error it
 * must react to, like any other tool failure. After 2 failed corrections
 * the child is failed with "ignored the final-message budget" — ok runs
 * are never truncated: the oversized content either lives in the report
 * file or the child FAILED. A parent abort between rounds never starts
 * another child run (an idle child's abort is a no-op), and the outcome is
 * failed "aborted" instead.
 *
 * ## Observing children
 *
 * `onChildEvent(child, event)` is a live read-only side channel into every
 * child's event stream — the same `AgentEvent` vocabulary as
 * `agent.subscribe()`. Each delivery is stamped with {@link SubagentChildInfo}
 * (`toolCallId`/`prompt`/`index`/`total`), so concurrent children can be
 * attributed in logs/UIs and grouped under the parent's `tool_execution_*`
 * event for the subagent call. The `createAgent` factory receives the same
 * fields. Observation only: the channel carries nothing into the parent
 * context and hands back no steering or abort handle. The channel is
 * synchronous by contract: a returned promise is never awaited (observation
 * must not delay the run), and its rejection is routed into the child's
 * kill path instead of becoming an unhandled rejection.
 */
export function createSubagentTool(options: SubagentToolOptions): AgentTool<typeof subagentSchema, SubagentRunDetails[]> {
	const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
	const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
	const systemPrompt =
		(options.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT) +
		` Final-message budget: at most ${maxOutputChars} characters. A deliverable that does not fit must be written to a file with your write tool first; the final message then contains only a summary of the report and the file's path.`;
	const onChildEvent = options.onChildEvent;
	// Understate rather than overstate the cap: a model that designs prompts
	// for a longer window than the real one gets killed more, not less.
	const describeInactivity = (ms: number) =>
		ms >= 60_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`;
	const inactivityCap = `${describeInactivity(inactivityTimeoutMs)} of inactivity (any event resets the inactivity clock)`;
	const caps =
		maxTurns > 0 && inactivityTimeoutMs > 0
			? `Each subagent is capped at ${maxTurns} assistant turns and ${inactivityCap}; design prompts to finish well within both. `
			: maxTurns > 0
				? `Each subagent is capped at ${maxTurns} assistant turns; design prompts to finish well within that. `
				: inactivityTimeoutMs > 0
					? `Each subagent is capped at ${inactivityCap}. `
					: "";

	const tool: AgentTool<typeof subagentSchema, SubagentRunDetails[]> = {
		name: "subagent",
		label: "subagent",
			description:
				"Spawn independent subagents. Each subagent is a fresh agent with your tools (except this one) and an empty context; it cannot see this conversation, so each prompt must be self-contained. " +
				"Subagents run in parallel and this call returns only when all of them finish. You receive just each subagent's final message — intermediate tool output is discarded, which keeps your context small. " +
				"A report too large for the final-message budget is written to a file and reported as a summary plus the file path; read that file with limit/offset when you need the full report. " +
			`Default to 2 prompts; pass more only when the user explicitly asks for more (hard cap ${maxConcurrent}). ` +
			caps +
			"Only delegate mutually independent tasks: subagents run concurrently and will conflict if they touch the same files. " +
			"For a single-fact lookup you can answer with one tool call, do it yourself instead.",
		parameters: subagentSchema,
		async execute(toolCallId, params, signal, onUpdate) {
			const prompts = params.prompts;
			if (!Array.isArray(prompts) || prompts.length === 0) {
				throw new Error("subagent: prompts must contain at least one task");
			}
			if (prompts.length > maxConcurrent) {
				throw new Error(
					`subagent: ${prompts.length} prompts exceed the hard cap of ${maxConcurrent} concurrent subagents; run fewer at a time`,
				);
			}
			const inherited = options
				.getTools()
				.filter((candidate) => candidate !== tool && candidate.name !== tool.name);

			const outcomes = await Promise.all(
				prompts.map(async (prompt, index): Promise<ChildOutcome> => {
					// Promise.all starts the callbacks synchronously in order, so
					// factory calls line up with prompt order. The whole child
					// lifecycle stays inside try: a host createAgent/prompt crash
					// must not reject the batch — Promise.all would orphan the
					// already-spawned siblings (still running, results discarded).
					const startedAt = Date.now();
					let promptError: string | undefined;
					let killReason: string | undefined;
					let correction: FinalMessageCorrection | undefined;
					let turns = 0;
					let child: Agent | undefined;
					// Frozen: the same object is reused for every event of this child;
					// a host writing to it would corrupt all subsequent attribution.
					const info: SubagentChildInfo = Object.freeze({ toolCallId, prompt, index, total: prompts.length });
					try {
						child = options.createAgent({ tools: inherited, systemPrompt, prompt, index, total: prompts.length, toolCallId });
						// Inactivity watchdog: armed at spawn and re-armed on EVERY child
						// event, so it fires only on total silence (hung provider call,
						// tool that never settles) — a slow-but-alive child keeps resetting
						// it and is never killed.
						let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
						const clearInactivity = () => {
							if (inactivityTimer !== undefined) {
								clearTimeout(inactivityTimer);
								inactivityTimer = undefined;
							}
						};
						const armInactivity = () => {
							if (inactivityTimeoutMs <= 0) return;
							clearInactivity();
							inactivityTimer = setTimeout(() => {
								killReason = `subagent inactive for ${inactivityTimeoutMs}ms`;
								child?.abort();
							}, inactivityTimeoutMs);
						};
						// Turn cap: counts completed turns. "continues" means the turn
						// still issues tool calls AND is not an error turn (the loop
						// hard-exits on error without running its tools) — only such a
						// turn may be labeled a cap violation; a natural final turn
						// (no tool calls) at the cap is a normal finish.
						const unsubscribe = child.subscribe((event) => {
							// Host observation first, guard logic second: the callback sees
							// every event in arrival order, including the ones the guards
							// act on below — a host never misses an event because a gate
							// responded to it. The observation contract is synchronous,
							// but TypeScript's void-return rule lets an async callback
							// satisfy the signature anyway; such a promise is never
							// awaited (an observer must not delay the run — a
							// never-settling one would wedge the batch past every guard)
							// and never dropped (its rejection would crash the process as
							// an unhandled one) — its failure is routed into the kill
							// path, surfacing in that child's FAILED section. Guards
							// never wait on observers: they run synchronously below.
							const observed = onChildEvent?.(info, event) as void | Promise<void> | undefined;
							if (observed instanceof Promise) {
								observed.catch((error: unknown) => {
									if (killReason === undefined) {
										killReason = `onChildEvent observer failed: ${error instanceof Error ? error.message : String(error)}`;
									}
									// Idle-safe: abort() is a no-op when no run is active.
									child?.abort();
								});
							}
							armInactivity();
							// The loop emits one more turn_end carrying an empty synthetic
							// "aborted" assistant message when a run is killed mid-flight.
							// That marker is not a completed model turn — excluded here.
							if (
								event.type === "turn_end" &&
								!(event.message.role === "assistant" && event.message.stopReason === "aborted")
							) {
								turns++;
								const continues =
									event.message.role === "assistant" &&
									event.message.stopReason !== "error" &&
									(event.message.content as Array<{ type: string }>).some(
										(block) => block.type === "toolCall",
									);
								if (maxTurns > 0 && continues && turns >= maxTurns) {
									killReason = `subagent exceeded maxTurns=${maxTurns}`;
									child?.abort();
								}
							}
						});
						armInactivity(); // covers a first request that never yields any event
						const onParentAbort = () => child?.abort();
						signal?.addEventListener("abort", onParentAbort, { once: true });
						// addEventListener does not fire for an already-aborted signal.
						if (signal?.aborted) onParentAbort();
						try {
							await child.prompt(prompt);
							correction = await enforceFinalMessageBudget(child, toolCallId, index, maxOutputChars, signal);
							if (correction !== undefined && !correction.compliant && killReason === undefined) {
								// endedNaturally false without a parent abort means a guard or
								// stream failure already labeled the run — leave its reason be.
								if (signal?.aborted) killReason = "aborted";
								else if (correction.endedNaturally) {
									killReason = `ignored the final-message budget after ${correction.rounds} correction rounds`;
								}
							}
						} finally {
							signal?.removeEventListener("abort", onParentAbort);
							unsubscribe();
							clearInactivity();
						}
					} catch (error) {
						promptError = error instanceof Error ? error.message : String(error);
					}
					const durationMs = Date.now() - startedAt;

					const messages = child?.state.messages ?? [];
					const lastAssistant = assistantMessages(messages).at(-1);
					// A child that ran to completion always ends with stopReason "stop";
					// anything else ("aborted", "error", "length", ...) is a failed run.
					// killReason (a guard firing) beats the stopReason derivation so the
					// section says WHY the child was killed, not just "aborted".
					const failed =
						promptError !== undefined ||
						killReason !== undefined ||
						lastAssistant === undefined ||
						lastAssistant.stopReason !== "stop";
					const error =
						promptError ??
						killReason ??
						(lastAssistant === undefined
							? "child produced no assistant message"
							: lastAssistant.stopReason === "aborted"
								? "aborted"
								: lastAssistant.stopReason === "error"
									? (lastAssistant.errorMessage ?? "child turn ended with an error")
									: `child ended with stopReason ${lastAssistant.stopReason}`);
					const { tokens, toolCalls } = summarizeUsage(messages);
					let truncated = false;
					let body: string;
					if (failed) {
						// Failure reporting only: a bounded, labeled head of the child's
						// last real words. This is not a success-path substitute — an
						// ok run never goes through here.
						const lastWords = finalText(messages);
						if (lastWords.length > 0) {
							const cut = cutAtCharBoundary(lastWords, FAILED_HEAD_CHARS);
							truncated = cut < lastWords.length;
							body = `last output (head ${cut} of ${lastWords.length} chars):\n${lastWords.slice(0, cut)}${truncated ? "…" : ""}`;
						} else {
							body = "";
						}
					} else {
						// Never truncated on the success path: the natural final fit
						// the budget, or the corrected final passed all three
						// compliance conditions.
						const text = finalText(messages) || "(subagent produced no final message)";
						const verified =
							correction !== undefined && correction.compliant && correction.bytes !== undefined
								? `\n[report verified: ${correction.path}, ${correction.bytes} bytes]`
								: "";
						body = `${text}${verified}`;
					}

					const details: SubagentRunDetails = {
						prompt,
						ok: !failed,
						tokens,
						toolCalls,
						turns,
						durationMs,
						truncated,
						...(error !== undefined ? { error } : {}),
						...(correction !== undefined
							? {
									corrected: correction.compliant,
									correctionRounds: correction.rounds,
									reportPath: correction.path,
									...(correction.bytes !== undefined ? { reportBytes: correction.bytes } : {}),
								}
							: {}),
					};
					const status = failed ? `FAILED (${error})` : "ok";
					const section =
						`<subagent ${index + 1}/${prompts.length} ${status} — ${tokens} tokens, ${toolCalls} tool calls, ${turns} turns, ${(durationMs / 1000).toFixed(1)}s>\n` +
						`task: ${promptHead(prompt)}\n` +
						(body.length > 0 ? `${body}\n` : "") +
						`</subagent ${index + 1}/${prompts.length}>`;
					onUpdate?.({
						content: [{ type: "text", text: `subagent ${index + 1}/${prompts.length} ${status}` }],
						details: [details],
					});
					return { details, section };
				}),
			);

			const content: TextContent[] = [
				{ type: "text", text: outcomes.map((outcome) => outcome.section).join("\n\n") },
			];
			return { content, details: outcomes.map((outcome) => outcome.details) };
		},
	};
	return tool;
}
