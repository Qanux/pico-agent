/**
 * Keyless compaction regression: a scripted model bloats tool results until the
 * auto-compactor (tiny window) must fire. The fake server meters PHYSICAL
 * content like a real provider, so meter/view divergence (requests silently
 * carrying the full history) fails the assertions instead of masking it.
 *
 * Scenario A: marathon, keepRecentTurns=1 — compaction fires, every request
 *   stays inside the window, every post-compaction request carries the
 *   summary, the transcript stays valid, the file ledger survives.
 * Scenario B: keepRecentTurns=6 — the hard-elision safety net stubs old tool
 *   results when the kept tail alone exceeds half the window.
 * Scenario C: direct hook calls — the incremental summary cache survives
 *   appends and REBUILDS when state.messages is replaced (JSON round-trip).
 * Run: node examples/verify-compaction.ts
 */
import { Type } from "typebox";
import { Agent, EventStream, autoCompaction } from "../src/index.ts";
import type { AgentMessage, AgentTool, AssistantMessage, StreamFn } from "../src/index.ts";
import { estimateMessageTokens } from "../src/ai/utils/estimate.ts";

const WINDOW = 2_000;
const BLOAT_CHARS = 2_400; // ~600 tokens per tool result at 4 chars/token
const STUB_TEXT = "[compacted: tool output omitted]";

let failures = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

interface RequestRecord {
	physical: number;
	hasSummary: boolean;
	hasStub: boolean;
	summaryContent?: string;
}

/** Physical token count of what would actually be serialized for the provider. */
function physicalTokens(messages: readonly unknown[]): number {
	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message as never);
	return tokens;
}

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

const fakeModel = { id: "mock", api: "anthropic-messages", provider: "mock", contextWindow: 1_000_000 } as never;
const fakeModels = {} as never; // scenario tests always override the summarizer

function bloatTool(): AgentTool<any, any> {
	return {
		name: "read",
		label: "read",
		description: "returns a big payload",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `payload for ${(params as { path: string }).path}: ${"x".repeat(BLOAT_CHARS)}` }],
				details: {},
			} as never;
		},
	};
}

/** Scripted streamFn: steps by REQUEST ordinal (the compacted view drops old
 * assistants, so counting them loops forever) and reports physical usage back,
 * the way a real provider would. */
function scriptedStreamFn(totalTurns: number, requests: RequestRecord[], compactionRequestNo: { value: number }): StreamFn {
	let requestNo = 0;
	return (_model, context) => {
		requestNo++;
		const physical = physicalTokens(context.messages);
		const summaryMessage = context.messages.find(
			(m) => m.role === "system" && typeof (m as { content?: unknown }).content === "string" && (m as { content: string }).content.includes("auto-compacted"),
		) as { content: string } | undefined;
		const hasSummary = summaryMessage !== undefined;
		const summaryContent = summaryMessage?.content;
		const hasStub = context.messages.some(
			(m) => m.role === "toolResult" && (m as { content: Array<{ type: string; text?: string }> }).content.some((b) => b.text === STUB_TEXT),
		);
		requests.push({ physical, hasSummary, hasStub, summaryContent });
		if (hasSummary && compactionRequestNo.value === 0) compactionRequestNo.value = requestNo;

		const step = requestNo;
		const stream = new EventStream<never, never>(
			(e) => (e as { type: string }).type === "done" || (e as { type: string }).type === "error",
			(e) => ((e as { type: string }).type === "done" ? (e as { message: AssistantMessage }).message : e),
		);
		const message = step < totalTurns
			? reply([{ type: "toolCall", id: `t${step}`, name: "read", arguments: { path: `file-${step}.txt` } }], "toolUse", physical)
			: reply([{ type: "text", text: `completed after ${totalTurns} turns` }], "stop", physical);
		void (async () => {
			stream.push({ type: "start" } as never);
			stream.push({ type: "message", message } as never);
			stream.push({ type: "done", message, stopReason: message.stopReason } as never);
			stream.end();
		})();
		return stream as never;
	};
}

/** Every toolResult must answer a toolCall still present, and vice versa. */
function checkPairs(label: string, messages: readonly AgentMessage[]) {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const m of messages) {
		if (m.role === "assistant") {
			for (const b of (m as Extract<AgentMessage, { role: "assistant" }>).content) {
				if (b.type === "toolCall") calls.add(b.id);
			}
		}
		if (m.role === "toolResult") results.add((m as unknown as { toolCallId: string }).toolCallId);
	}
	const orphanResults = [...results].filter((id) => !calls.has(id));
	const unansweredCalls = [...calls.keys()].filter((id) => !results.has(id));
	check(orphanResults.length === 0 && unansweredCalls.length === 0, `${label} (orphans: ${orphanResults.length}, unanswered: ${unansweredCalls.length})`);
}

async function runAgentScenario(
	label: string,
	totalTurns: number,
	keepRecentTurns: number,
): Promise<{ requests: RequestRecord[]; compactionRequestNo: number; finalMessages: AgentMessage[] }> {
	const requests: RequestRecord[] = [];
	const compactionRequestNo = { value: 0 };
	let summarizeCalls = 0;
	let lastSummary = "";
	const compaction = autoCompaction(fakeModels, {
		model: fakeModel,
		maxContextTokens: WINDOW,
		keepRecentTurns,
		threshold: 0.75,
		onCompaction: (stats) => {
			const tag = stats.skipped ? `skip:${stats.skipped}` : `${stats.before}->${stats.after}`;
			console.log(`       [${label}] onCompaction ${tag} (summarize #${summarizeCalls})`);
		},
		summarize: async (span, _model, prior) => {
			summarizeCalls++;
			lastSummary = `${prior ? prior + " " : ""}Summary of ${span.length} more messages.`;
			return lastSummary;
		},
	});

	const agent = new Agent({
		initialState: { systemPrompt: "You are a verification agent.", model: fakeModel, tools: [bloatTool()] },
		streamFn: scriptedStreamFn(totalTurns, requests, compactionRequestNo),
		...compaction,
	});
	await agent.prompt("Run the bloat loop.");

	check(summarizeCalls >= 1, `${label}: summarizer invoked (${summarizeCalls}x)`);
	const finalAssistant = agent.state.messages
		.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
		.at(-1);
	check(finalAssistant?.content.some((b) => b.type === "text" && b.text.includes("completed")) === true, `${label}: task completed`);
	return { requests, compactionRequestNo: compactionRequestNo.value, finalMessages: agent.state.messages };
}

// ---- Scenario A: marathon, tight keep — the window must hold at every request ----
{
	console.log("--- scenario A: marathon, keepRecentTurns=1 ---");
	const { requests, compactionRequestNo, finalMessages } = await runAgentScenario("A", 9, 1);
	check(compactionRequestNo > 0, `A: compaction fired (first view at request ${compactionRequestNo})`);
	check(requests.every((r) => r.physical <= WINDOW), `A: every request inside window (peak ${Math.max(...requests.map((r) => r.physical))} <= ${WINDOW})`);
	const post = requests.slice(compactionRequestNo - 1);
	check(post.every((r) => r.hasSummary), `A: every post-compaction request carries the summary (${post.length} requests)`);
	check(post.some((r) => r.summaryContent?.includes("file-")), "A: views carry the file ledger");
	checkPairs("A: transcript pairs intact", finalMessages);
}

// ---- Scenario B: wide keep — the elision safety net must engage ----
{
	console.log("--- scenario B: marathon, keepRecentTurns=6 ---");
	const { requests, compactionRequestNo, finalMessages } = await runAgentScenario("B", 14, 6);
	check(compactionRequestNo > 0, `B: compaction fired (first view at request ${compactionRequestNo})`);
	const post = requests.slice(compactionRequestNo - 1);
	check(post.every((r) => r.hasSummary), `B: every post-compaction request carries the summary (${post.length} requests)`);
	check(post.every((r) => r.physical <= WINDOW), `B: post-compaction requests inside window (peak ${Math.max(0, ...post.map((r) => r.physical))} <= ${WINDOW})`);
	check(post.some((r) => r.hasStub), `B: elision safety net stubbed old tool results (${post.filter((r) => r.hasStub).length} requests)`);
	checkPairs("B: transcript pairs intact", finalMessages);
}

// ---- Scenario C: incremental cache survives appends, rebuilds on replacement ----
{
	console.log("--- scenario C: cache pinning across state reassignment ---");
	let summarizeCalls = 0;
	const spanSizes: number[] = [];
	const hooks = autoCompaction(fakeModels, {
		model: fakeModel,
		maxContextTokens: WINDOW,
		keepRecentTurns: 2,
		threshold: 0.75,
		cooldownRequests: 1, // fold new material in on the very next call
		summarize: async (span) => {
			summarizeCalls++;
			spanSizes.push(span.length);
			return `Summary of ${span.length} messages.`;
		},
	});
	hooks.prepareRequest({ model: fakeModel } as never);

	const cycle = (n: number, inputTokens: number): AgentMessage[] => [
		reply([{ type: "toolCall", id: `t${n}`, name: "read", arguments: { path: `file-${n}.txt` } }], "toolUse", inputTokens),
		{
			role: "toolResult",
			toolCallId: `t${n}`,
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(BLOAT_CHARS) }],
			timestamp: Date.now(),
		} as AgentMessage,
	];
	const base: AgentMessage[] = [
		{ role: "system", content: "sys", timestamp: Date.now() },
		{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() },
		...cycle(1, 100), ...cycle(2, 100), ...cycle(3, 100), ...cycle(4, 100), ...cycle(5, 1_800),
	];

	const v1 = await hooks.transformContext([...base]);
	check(v1.some((m) => m.role === "system" && (m as { content: unknown }).content instanceof String === false && String((m as { content: unknown }).content).includes("auto-compacted")), "C: first trigger compacted");

	const v2 = await hooks.transformContext([...base, ...cycle(6, 1_900)]);
	check(summarizeCalls === 2 && spanSizes[1] < spanSizes[0], `C: append folded incrementally (spans ${spanSizes.join(", ")})`);

	const cloned = JSON.parse(JSON.stringify([...base, ...cycle(6, 1_900), ...cycle(7, 2_000)])) as AgentMessage[];
	const v3 = await hooks.transformContext(cloned);
	check(summarizeCalls === 3 && spanSizes[2] > spanSizes[1], `C: replaced state rebuilt cache from scratch (spans ${spanSizes.join(", ")})`);
	checkPairs("C: rebuilt view pairs intact", v3);
	check(v3.some((m) => m.role === "system" && String((m as { content: unknown }).content).includes("auto-compacted")), "C: rebuilt view carries summary");
}

console.log(failures === 0 ? "\nCOMPACTION VERIFY OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
