/**
 * Keyless compaction regression: a scripted model bloats tool results until the
 * auto-compactor (tiny window) must fire. Asserts that compaction happened,
 * the soft cap held at every request, the transcript stayed valid (no orphan
 * tool results), the file ledger survived, and the task still completed.
 * Run: node examples/verify-compaction.ts
 */
import { Type } from "typebox";
import { Agent, EventStream, autoCompaction } from "../src/index.ts";
import type { AgentMessage, AgentTool, AssistantMessage, StreamFn } from "../src/index.ts";
import { estimateContextTokens } from "../src/ai/utils/estimate.ts";

const WINDOW = 2_000;
const BLOAT_CHARS = 2_400; // ~600 tokens per tool result at 4 chars/token
const TOTAL_TURNS = 9;

let peakRequestTokens = 0;
let lastRequestSummary: string | undefined;
const compactions: { before: number; after: number; dropped: number }[] = [];
let summarizeCalls = 0;
let summarizedPaths: string[] = [];

// A real tool whose result is huge on purpose.
const bloatTool: AgentTool<any, any> = {
	name: "read",
	label: "read",
	description: "returns a big payload",
	parameters: Type.Object({ path: Type.String() }),
	async execute(toolCallId, params) {
		return {
			content: [{ type: "text", text: `payload for ${(params as { path: string }).path}: ${"x".repeat(BLOAT_CHARS)}` }],
			details: {},
		} as never;
	},
};

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], inputTokens: number): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "mock",
		model: "mock",
		usage: {
			input: inputTokens, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		content,
		stopReason,
	};
}

const streamFn: StreamFn = (_model, context) => {
	// Simulate the server's accounting so the meter exercises its primary path.
	const inputTokens = estimateContextTokens(context.messages as never).tokens;
	peakRequestTokens = Math.max(peakRequestTokens, inputTokens);
	// Compaction is request-scoped: assert on what actually gets sent.
	const summary = context.messages.find(
		(m) => m.role === "system" && typeof (m as { content?: unknown }).content === "string" && (m as { content: string }).content.includes("auto-compacted"),
	) as { content: string } | undefined;
	if (summary) lastRequestSummary = summary.content;

	const step = context.messages.filter((m) => m.role === "assistant").length;
	const stream = new EventStream<never, never>(
		(e) => (e as { type: string }).type === "done" || (e as { type: string }).type === "error",
		(e) => ((e as { type: string }).type === "done" ? (e as { message: AssistantMessage }).message : e),
	);
	const message = step < TOTAL_TURNS
		? reply([{ type: "toolCall", id: `t${step + 1}`, name: "read", arguments: { path: `file-${step + 1}.txt` } }], "toolUse", inputTokens)
		: reply([{ type: "text", text: "All turns completed with compaction active." }], "stop", inputTokens);
	void (async () => {
		stream.push({ type: "start" } as never);
		stream.push({ type: "message", message } as never);
		stream.push({ type: "done", message, stopReason: message.stopReason } as never);
		stream.end();
	})();
	return stream as never;
};

const fakeModel = { id: "mock", api: "anthropic-messages", provider: "mock", contextWindow: 1_000_000 } as never;

const compaction = autoCompaction({ completeSimple: async () => reply([{ type: "text", text: "" }], "stop", 0) } as never, {
	model: fakeModel,
	maxContextTokens: WINDOW,
	keepRecentTurns: 1,
	threshold: 0.75,
	onCompaction: (stats) => {
		if (!stats.skipped) compactions.push({ before: stats.before, after: stats.after, dropped: stats.droppedMessages });
	},
	summarize: async (span, _model, prior) => {
		summarizeCalls++;
		summarizedPaths = span
			.flatMap((m) => (m.role === "assistant" ? (m as { content: Array<{ type: string; name?: string; arguments?: { path?: string } }> }).content : []))
			.filter((b) => b.type === "toolCall" && b.name === "read")
			.map((b) => b.arguments?.path ?? "?");
		return `${prior ? prior + " " : ""}Summary of ${span.length} more messages.`;
	},
});

const agent = new Agent({
	initialState: {
		systemPrompt: "You are a verification agent.",
		model: fakeModel,
		tools: [bloatTool],
	},
	streamFn,
	...compaction,
});

await agent.prompt("Run the bloat loop.");

// --- Assertions ---
let failures = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

const finalMessages = agent.state.messages;
const finalText = finalMessages
	.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
	.at(-1);

check(compactions.length >= 1, `compaction fired (${compactions.length}x)`);
check(compactions.every((c) => c.before > c.after), `every compaction shrank context (${compactions.map((c) => `${c.before}->${c.after}`).join(", ")})`);
check(peakRequestTokens <= WINDOW * 1.15, `request tokens stayed under soft cap (peak ${peakRequestTokens} <= ${Math.round(WINDOW * 1.15)})`);
check(summarizeCalls >= 1, `summarizer invoked (${summarizeCalls}x)`);
check(finalText?.content.some((b) => b.type === "text" && b.text.includes("completed")) === true, "task completed with final answer");
check(lastRequestSummary !== undefined && lastRequestSummary.includes("file-"), `requests carry summary with file ledger (last span had ${summarizedPaths.length} paths)`);

// Transcript validity: every toolResult must answer a toolCall still present,
// and every toolCall must have its toolResult (no orphans on either side).
const calls = new Map<string, string>();
const results = new Set<string>();
for (const m of finalMessages) {
	if (m.role === "assistant") {
		for (const b of (m as Extract<AgentMessage, { role: "assistant" }>).content) {
			if (b.type === "toolCall") calls.set(b.id, b.name);
		}
	}
	if (m.role === "toolResult") {
		results.add((m as unknown as { toolCallId: string }).toolCallId);
	}
}
const orphanResults = [...results].filter((id) => !calls.has(id));
const unansweredCalls = [...calls.keys()].filter((id) => !results.has(id));
check(orphanResults.length === 0 && unansweredCalls.length === 0, `transcript pairs intact (orphans: ${orphanResults.length}, unanswered: ${unansweredCalls.length})`);

console.log(failures === 0 ? "\nCOMPACTION VERIFY OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
