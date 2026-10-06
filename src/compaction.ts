/**
 * pico-agent addition (original code, not vendored from pi): automatic context
 * compaction. See MODIFICATIONS.md for the full list of deviations from upstream.
 *
 * Usage: spread the returned hooks into the Agent config.
 *
 *   const agent = new Agent({
 *     initialState: { ... },
 *     streamFn: models.streamSimple.bind(models),
 *     ...autoCompaction(models, { maxContextTokens: 200_000 }),
 *   });
 *
 * effectiveWindow = min(maxContextTokens ?? 131_072, model.contextWindow ?? 131_072).
 * The default cap is 128K; pass a larger maxContextTokens (or the model's own
 * contextWindow) to use the full window of large-context models.
 *
 * Compaction is request-scoped: state.messages is the durable transcript and
 * keeps growing; every LLM request carries a derived view ([leading systems,
 * summary, kept tail]). Once a summary exists, every request is derived from
 * it — the token meter (last usage + appends after it) describes the view, not
 * the physical array, so returning the raw array on a skip path would send the
 * full history to the provider while the meter reports the small view.
 */

import type { AgentLoopConfig, AgentMessage, PrepareRequestContext } from "./agent/types.ts";
import type { Message, Model, Models } from "./ai/index.ts";
import { contentText } from "./ai/index.ts";
import { estimateContextTokens } from "./ai/utils/estimate.ts";

/** Default context cap: 128K. Applies when maxContextTokens is unset and when
 * a model object carries no contextWindow metadata. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 131_072;

export interface CompactionStats {
	/** Estimated context tokens before compaction. */
	before: number;
	/** Estimated context tokens after compaction (of the served view). */
	after: number;
	/** Number of transcript messages replaced by the summary. */
	droppedMessages: number;
	/** When set, compaction was skipped: no new summary was produced, and the
	 * previously derived view was re-served (or, before the first compaction,
	 * the context passed through unchanged). */
	skipped?: "span-too-small" | "cooldown" | "summarize-failed";
	/** Error message when skipped === "summarize-failed". */
	error?: string;
}

export interface AutoCompactionOptions {
	/** Fallback model used before the first request runs (prepareRequest keeps
	 * this fresh afterwards, covering mid-session model swaps). */
	model?: Model<any>;
	/** Optional context cap. Default 131_072 (128K). */
	maxContextTokens?: number;
	/** Fraction of the effective window that triggers compaction. Default 0.75. */
	threshold?: number;
	/** Recent assistant turns (an assistant message plus its tool results)
	 * kept verbatim. Cutting happens right before an assistant message, so a
	 * toolCall/toolResult pair can never be split. Default 6. */
	keepRecentTurns?: number;
	/** Skip the first compaction when the compactable span is below this
	 * fraction of the window — nothing to gain. Default 0.15. */
	minCompactableRatio?: number;
	/** Output cap for the summarization request. Default 4096. */
	maxSummaryTokens?: number;
	/** Minimum transformContext invocations between two summarize attempts.
	 * This only delays folding new material into the summary: while it counts
	 * down, above-threshold requests still receive the last compacted view
	 * (summary + unf summarized tail), never the full history. Default 3. */
	cooldownRequests?: number;
	/** Called on every trigger attempt, including skips. */
	onCompaction?: (stats: CompactionStats) => void;
	/** Override the summarizer (tests, custom pipelines). Receives only the
	 * messages summarized since the last compaction, the prior running summary
	 * (if any), and must return the new full summary text. */
	summarize?: (span: readonly AgentMessage[], model: Model<any>, priorSummary?: string) => Promise<string>;
}

export interface AutoCompactionHooks {
	transformContext: NonNullable<AgentLoopConfig["transformContext"]>;
	prepareRequest: (request: PrepareRequestContext) => void;
}

const SUMMARIZE_SYSTEM_PROMPT = [
	"Summarize the following agent conversation excerpt for continuity.",
	"Include: decisions made, files read or modified, commands and their outcomes,",
	"current task state, and open next steps. Be dense and factual.",
	"Write the summary in the same language as the conversation.",
].join(" ");

const FILE_TOOL_NAMES = new Set(["read", "write", "edit"]);
const MAX_SERIALIZED_SPAN_CHARS = 120_000;
const MAX_TOOL_RESULT_HEAD_CHARS = 200;
const MAX_LEDGER_ENTRIES = 100;
const STUB_TEXT = "[compacted: tool output omitted]";

export function autoCompaction(models: Models, options: AutoCompactionOptions = {}): AutoCompactionHooks {
	const threshold = options.threshold ?? 0.75;
	// Keep at least the in-flight cycle: its tool results are the model's basis
	// for the next decision. Compacting them away makes a tool marathon thrash
	// (read -> compact -> forget -> re-read), and 0 would slice past the array
	// end and duplicate the whole transcript.
	const keepRecentTurns = Math.max(1, options.keepRecentTurns ?? 6);
	const minCompactableRatio = options.minCompactableRatio ?? 0.15;
	const maxSummaryTokens = options.maxSummaryTokens ?? 4096;
	const cooldown = options.cooldownRequests ?? 3;

	let currentModel = options.model;
	// Seeded at the cooldown so the very first trigger can fire immediately.
	let callsSinceCompaction = cooldown;
	const fileLedger = new Set<string>();
	// Incremental summarize cache: state.messages is append-only between calls,
	// so indices stay valid. summarizedUpTo is additionally pinned to the
	// message object it pointed at: if state.messages is reassigned (for
	// example through a JSON round-trip), the pin relocates or resets the cache
	// instead of silently summarizing the wrong span.
	let summarizedUpTo: number | undefined;
	let summaryBoundary: AgentMessage | undefined;
	let runningSummary: string | undefined;

	function effectiveWindow(): number {
		const cap = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
		const modelWindow = currentModel?.contextWindow ?? DEFAULT_MAX_CONTEXT_TOKENS;
		return Math.min(cap, modelWindow);
	}

	function reportSkipped(before: number, reason: CompactionStats["skipped"]): void {
		options.onCompaction?.({ before, after: before, droppedMessages: 0, skipped: reason });
	}

	/** Build the request view [leading systems, summary, tail from `cut` on),
	 * with the hard-elision safety net when it still exceeds half the window. */
	function buildView(messages: readonly AgentMessage[], prefixEnd: number, cut: number, summaryText: string): AgentMessage[] {
		const ledgerSection = fileLedger.size > 0
			? `\n\nFiles touched so far: ${[...fileLedger].slice(0, MAX_LEDGER_ENTRIES).join(", ")}`
			: "";
		// The summary message must carry a timestamp strictly NEWER than every
		// kept message: estimateContextTokens then treats the tail's usage.input
		// as stale (it described the pre-compaction prefix) and falls back to
		// estimation, keeping the meter honest after compaction. A plain
		// Date.now() can collide with messages created in the same millisecond,
		// so take the max and add one.
		let summaryTimestamp = Date.now();
		for (const message of messages) {
			const ts = (message as { timestamp?: number }).timestamp ?? 0;
			if (ts >= summaryTimestamp) summaryTimestamp = ts + 1;
		}
		const summaryMessage: AgentMessage = {
			role: "system",
			content: `# Conversation summary (auto-compacted)\n\n${summaryText}${ledgerSection}`,
			timestamp: summaryTimestamp,
		};
		let result: AgentMessage[] = [...messages.slice(0, prefixEnd), summaryMessage, ...messages.slice(cut)];
		if (estimateContextTokens(result as readonly Message[]).tokens > effectiveWindow() * 0.5) {
			result = elideOldToolResults(result, 2);
		}
		return result;
	}

	/** Fold the span (spanStart, cut) into the running summary and return the
	 * fresh view. On summarize failure, falls back to the last view when one
	 * exists, or passes the context through unchanged. */
	async function compact(
		messages: readonly AgentMessage[],
		before: number,
		prefixEnd: number,
		cut: number,
	): Promise<AgentMessage[]> {
		const spanStart = summarizedUpTo ?? prefixEnd;
		let summaryText: string;
		try {
			summaryText = options.summarize
				? await options.summarize(messages.slice(spanStart, cut), currentModel!, runningSummary)
				: await defaultSummarize(models, currentModel!, messages.slice(spanStart, cut), runningSummary, maxSummaryTokens);
		} catch (error) {
			// A failed summarization must not kill the run. Consume the cooldown
			// so the retry is throttled, and serve the last compacted view (or,
			// before the first compaction, the context as-is).
			callsSinceCompaction = 0;
			const message = error instanceof Error ? error.message : String(error);
			if (runningSummary !== undefined && summarizedUpTo !== undefined) {
				const view = buildView(messages, prefixEnd, summarizedUpTo, runningSummary);
				options.onCompaction?.({
					before,
					after: estimateContextTokens(view as readonly Message[]).tokens,
					droppedMessages: summarizedUpTo - prefixEnd,
					skipped: "summarize-failed",
					error: message,
				});
				return view;
			}
			options.onCompaction?.({ before, after: before, droppedMessages: 0, skipped: "summarize-failed", error: message });
			return [...messages];
		}
		updateLedger(messages.slice(spanStart, cut), fileLedger);
		runningSummary = summaryText;
		summarizedUpTo = cut;
		summaryBoundary = messages[cut];
		callsSinceCompaction = 0;
		const view = buildView(messages, prefixEnd, cut, summaryText);
		options.onCompaction?.({
			before,
			after: estimateContextTokens(view as readonly Message[]).tokens,
			droppedMessages: cut - prefixEnd,
		});
		return view;
	}

	return {
		prepareRequest(request) {
			currentModel = request.model;
		},

		async transformContext(messages) {
			callsSinceCompaction++;
			if (messages.length === 0 || !currentModel) return messages;

			const window = effectiveWindow();
			const before = estimateContextTokens(messages as readonly Message[]).tokens;
			const tripped = before >= window * threshold;

			// Partition: [leading system messages) [compactable span) [kept tail).
			// The cut sits right before an assistant message — user messages in the
			// span are compacted too, and tool pairs are never split. This keeps the
			// single-prompt tool marathon (one user message, many tool cycles)
			// compactable, which a user-turn-boundary cut would miss entirely.
			let prefixEnd = 0;
			while (prefixEnd < messages.length && messages[prefixEnd].role === "system") prefixEnd++;

			const assistantStarts: number[] = [];
			for (let i = prefixEnd; i < messages.length; i++) {
				if (messages[i].role === "assistant") assistantStarts.push(i);
			}

			// Validate the incremental cache against the live array before use.
			if (summarizedUpTo !== undefined && messages[summarizedUpTo] !== summaryBoundary) {
				const relocated = summaryBoundary !== undefined ? messages.indexOf(summaryBoundary) : -1;
				if (relocated >= prefixEnd) {
					summarizedUpTo = relocated;
				} else {
					summarizedUpTo = undefined;
					summaryBoundary = undefined;
					runningSummary = undefined;
				}
			}

			// Once a summary exists, every request view is derived from it. The
			// unf summarized tail rides along verbatim until the cooldown lets a
			// new fold-in happen.
			if (runningSummary !== undefined && summarizedUpTo !== undefined) {
				const foldInCut =
					assistantStarts.length > keepRecentTurns
						? assistantStarts[assistantStarts.length - keepRecentTurns]
						: undefined;
				if (tripped && callsSinceCompaction >= cooldown && foldInCut !== undefined && foldInCut > summarizedUpTo) {
					return compact(messages, before, prefixEnd, foldInCut);
				}
				const view = buildView(messages, prefixEnd, summarizedUpTo, runningSummary);
				if (tripped) {
					options.onCompaction?.({
						before,
						after: estimateContextTokens(view as readonly Message[]).tokens,
						droppedMessages: summarizedUpTo - prefixEnd,
						skipped: "cooldown",
					});
				}
				return view;
			}

			if (!tripped) return messages;
			if (assistantStarts.length <= keepRecentTurns) {
				reportSkipped(before, "span-too-small");
				return messages;
			}
			const cutIndex = assistantStarts[assistantStarts.length - keepRecentTurns];
			const compactable = messages.slice(prefixEnd, cutIndex);
			if (compactable.length === 0 || estimateContextTokens(compactable as readonly Message[]).tokens < window * minCompactableRatio) {
				reportSkipped(before, "span-too-small");
				return messages;
			}
			return compact(messages, before, prefixEnd, cutIndex);
		},
	};
}

async function defaultSummarize(
	models: Models,
	model: Model<any>,
	span: readonly AgentMessage[],
	priorSummary: string | undefined,
	maxSummaryTokens: number,
): Promise<string> {
	const serialized = serializeSpan(span);
	const userText = priorSummary !== undefined
		? `Previous summary:\n${priorSummary}\n\nNew material to fold in:\n${serialized}`
		: serialized;
	const requestContext = {
		messages: [
			{ role: "system", content: SUMMARIZE_SYSTEM_PROMPT, timestamp: Date.now() },
			{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
		] as Message[],
	};
	const assistant = await models.completeSimple(model, requestContext, { maxTokens: maxSummaryTokens });
	const text = contentText(assistant.content).trim();
	if (!text) throw new Error("compaction: summarizer returned empty text");
	return text;
}

/** Serialize a span into flat text, with long tool outputs trimmed to heads. */
function serializeSpan(span: readonly AgentMessage[]): string {
	let text = "";
	for (const message of span) {
		text += serializeMessage(message) + "\n";
	}
	if (text.length > MAX_SERIALIZED_SPAN_CHARS) {
		// Keep the newest detail when the span is very large.
		text = "…[earlier excerpt truncated]…\n" + text.slice(text.length - MAX_SERIALIZED_SPAN_CHARS);
	}
	return text;
}

function serializeMessage(message: AgentMessage): string {
	switch (message.role) {
		case "system":
			return `[system] ${systemText(message)}`;
		case "user":
			return `[user] ${contentText((message as Extract<AgentMessage, { role: "user" }>).content)}`;
		case "toolResult": {
			// Keep a short head per result: the summarizer is asked for "commands
			// and their outcomes", which it cannot reconstruct from pure stubs.
			const text = contentText((message as Extract<AgentMessage, { role: "toolResult" }>).content).trim();
			const head = text.length > MAX_TOOL_RESULT_HEAD_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_HEAD_CHARS)}…` : text;
			return `[tool result] ${head || STUB_TEXT}`;
		}
		case "assistant": {
			const blocks = (message as Extract<AgentMessage, { role: "assistant" }>).content;
			const parts: string[] = [];
			for (const block of blocks) {
				if (block.type === "text") parts.push(block.text);
				else if (block.type === "toolCall") {
					const args = typeof block.arguments?.path === "string" ? ` path=${block.arguments.path}` : "";
					parts.push(`(called ${block.name}${args})`);
				}
				// thinking blocks are omitted: DeepSeek drops them on replay anyway
				// and Anthropic signatures cannot be replayed from a summary.
			}
			return `[assistant] ${parts.join(" ")}`;
		}
		default:
			return `[${String((message as { role?: string }).role ?? "message")}]`;
	}
}

function systemText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	return typeof content === "string" ? content : "[system message]";
}

/** Collect read/write/edit paths for the cross-compaction file ledger. */
function updateLedger(span: readonly AgentMessage[], ledger: Set<string>): void {
	for (const message of span) {
		if (message.role !== "assistant") continue;
		for (const block of (message as Extract<AgentMessage, { role: "assistant" }>).content) {
			if (block.type === "toolCall" && FILE_TOOL_NAMES.has(block.name)) {
				const path = (block.arguments as { path?: unknown } | undefined)?.path;
				if (typeof path === "string") ledger.add(path);
			}
		}
	}
}

/** Replace toolResult contents with one-line stubs outside the last N assistant
 * turns (an assistant message plus its tool results). */
function elideOldToolResults(messages: AgentMessage[], keepTurns: number): AgentMessage[] {
	// Walk backwards counting ASSISTANT turns, matching the cut rule above: a
	// toolResult's owning assistant comes after it and was already counted, so
	// keepTurns owners separate this result from the live decision loop.
	// Marathon tails contain no user messages, so counting user turns (an
	// earlier version) elided nothing exactly when it mattered most.
	let assistantTurnsSeen = 0;
	const elided: AgentMessage[] = new Array(messages.length);
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") assistantTurnsSeen++;
		if (message.role === "toolResult" && assistantTurnsSeen >= keepTurns) {
			elided[i] = {
				...message,
				content: [{ type: "text", text: STUB_TEXT }],
			} as AgentMessage;
		} else {
			elided[i] = message;
		}
	}
	return elided;
}
