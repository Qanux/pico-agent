// Original to the pico-agent extraction of earendil-works/pi v0.87.1 — placed among the
// harness tools for discoverability, but NOT part of the v0.87.1 vendoring (see MODIFICATIONS.md)

import { Type, type Static } from "typebox";
import type { Agent } from "../../agent.ts";
import type { AgentMessage, AgentTool } from "../../types.ts";
import type { TextContent } from "../../../ai/index.ts";

const subagentSchema = Type.Object(
	{
		prompts: Type.Array(
			Type.String({
				description: "One self-contained task. The subagent cannot see this conversation.",
			}),
			{
				minItems: 1,
				description:
					"Independent tasks, one per subagent. They run in parallel and this call returns when all of them finish. Default to 2 entries; pass more only when the user explicitly asks for more.",
			},
		),
	},
	{},
);

export type SubagentToolInput = Static<typeof subagentSchema>;

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
	/** True when the final message was head-truncated to `maxOutputChars`. */
	truncated: boolean;
	/** Error message when `ok` is false. */
	error?: string;
}

/**
 * Build a fresh child agent. Called once per subagent, so each child gets its
 * own transcript. The host wires model, stream function, compaction, etc.
 */
export type SubagentAgentFactory = (init: {
	tools: AgentTool<any>[];
	systemPrompt: string;
}) => Agent;

export interface SubagentToolOptions {
	/** Returns the parent's CURRENT tools; resolved on every tool call, not at factory time. */
	getTools: () => readonly AgentTool<any>[];
	/** Constructs the child agent from the inherited toolset and system prompt. */
	createAgent: SubagentAgentFactory;
	/** Hard cap on subagents per tool call. Default 4. */
	maxConcurrent?: number;
	/** Head-truncation budget for each child's final message, in characters. Default 20000. */
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
	/** Child system prompt. Defaults to {@link DEFAULT_SUBAGENT_SYSTEM_PROMPT}. */
	systemPrompt?: string;
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

/**
 * Create the `subagent` tool: spawns one child agent per prompt, in parallel,
 * with the parent's current tools minus the subagent tool itself.
 *
 * Each child runs in a fresh, empty context and only its final message flows
 * back to the parent (head-truncated), so intermediate tool output never
 * enters the parent transcript. This call blocks until every child finishes;
 * the parent's abort signal aborts all children.
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
 */
export function createSubagentTool(options: SubagentToolOptions): AgentTool<typeof subagentSchema, SubagentRunDetails[]> {
	const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
	const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
	const systemPrompt = options.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT;
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
			"Subagents run in parallel and this call returns only when all of them finish. You receive just each subagent's final message (truncated) — intermediate tool output is discarded, which keeps your context small. " +
			`Default to 2 prompts; pass more only when the user explicitly asks for more (hard cap ${maxConcurrent}). ` +
			caps +
			"Only delegate mutually independent tasks: subagents run concurrently and will conflict if they touch the same files. " +
			"For a single-fact lookup you can answer with one tool call, do it yourself instead.",
		parameters: subagentSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
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
					let turns = 0;
					let child: Agent | undefined;
					try {
						child = options.createAgent({ tools: inherited, systemPrompt });
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
							armInactivity();
							if (event.type !== "turn_end") return;
							if (event.message.role === "assistant" && event.message.stopReason === "aborted") {
								// The loop emits one more turn_end carrying an empty synthetic
								// "aborted" assistant message when a run is killed mid-flight.
								// That marker is not a completed model turn — don't count it.
								return;
							}
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
						});
						armInactivity(); // covers a first request that never yields any event
						const onParentAbort = () => child?.abort();
						signal?.addEventListener("abort", onParentAbort, { once: true });
						// addEventListener does not fire for an already-aborted signal.
						if (signal?.aborted) onParentAbort();
						try {
							await child.prompt(prompt);
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
					const text = finalText(messages) || "(subagent produced no final message)";
					let cut = Math.min(text.length, maxOutputChars);
					// Never split a UTF-16 surrogate pair (emoji, rare CJK) at the cut.
					if (cut < text.length) {
						const codeBefore = text.charCodeAt(cut - 1);
						if (codeBefore >= 0xd800 && codeBefore <= 0xdbff) cut--;
					}
					const truncated = cut < text.length;
					const clipped = truncated
						? `${text.slice(0, cut)}\n[subagent output truncated: kept ${cut} of ${text.length} chars]`
						: text;

					const details: SubagentRunDetails = {
						prompt,
						ok: !failed,
						tokens,
						toolCalls,
						turns,
						durationMs,
						truncated,
						...(error !== undefined ? { error } : {}),
					};
					const status = failed ? `FAILED (${error})` : "ok";
					const section =
						`<subagent ${index + 1}/${prompts.length} ${status} — ${tokens} tokens, ${toolCalls} tool calls, ${turns} turns, ${(durationMs / 1000).toFixed(1)}s>\n` +
						`task: ${promptHead(prompt)}\n` +
						`${clipped}\n` +
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
