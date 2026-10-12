/**
 * Agent facade + loop regression for the surfaces the other suites do not
 * touch: steering/follow-up queues, queue modes, abort through the facade,
 * before/afterToolCall hooks, finishTurn decisions, prepareNextTurn /
 * prepareRequest updates (including a mid-run model swap), parallel vs
 * sequential tool execution, truncated tool-call batches, unknown tools,
 * validation coercion, reset, and the re-entrancy guard.
 *
 *   A steering: a message queued mid-turn is injected as a user message
 *     before the next request and the model sees it.
 *   B queue modes: one-at-a-time spreads two steering messages over two
 *     turns; "all" delivers both in one turn.
 *   C followUp: queued before the run, drained only when the agent would
 *     otherwise stop (after the tool turn), and the loop continues with it.
 *   D finishTurn continue: forces exactly one context-only extra request.
 *   E finishTurn end: stops right after a tool turn, no second request.
 *   F abort: a hung stream aborted through Agent.abort() produces an
 *     aborted assistant turn, waitForIdle resolves, and the agent accepts a
 *     new prompt afterwards.
 *   G re-entrancy: prompt() during a run throws; the run finishes cleanly.
 *   H beforeToolCall block: the tool never executes, an error tool result
 *     carries the reason, the loop continues.
 *   I afterToolCall override: content/details are replaced field-by-field.
 *   J sequential vs parallel tool execution order (timeline overlap).
 *   K unknown tool: becomes an isError tool result, run continues.
 *   L validation coercion: string "5"→5, 1→true, optional null dropped.
 *   M prepareRequest model swap: the second request runs on the new model.
 *   N prepareNextTurn message injection: lands in the transcript and the
 *     next request.
 *   O length stop: tool calls fail as truncated instead of executing.
 *   P reset: transcript collapses to the baseline system message; a fresh
 *     prompt works.
 * Run: node examples/verify-core.ts
 */
import { z } from "zod";
import {
	Agent,
	EventStream,
	createUnavailableModel,
	type AgentMessage,
	type AgentModel,
	type AgentTool,
	type AssistantMessage,
	type BeforeToolCallContext,
	type StreamFn,
} from "pico-langchain";

let failures = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

const fakeModel: AgentModel = { ...createUnavailableModel(), id: "mock", provider: "mock" };
const otherModel: AgentModel = { ...createUnavailableModel(), id: "mock-b", provider: "mock" };

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

interface RequestRecord {
	requestNo: number;
	messages: AgentMessage[];
	modelId: string;
}

/** A scripted streamFn with an explicit per-request script and request log. */
function scriptedRequests(
	script: (requestNo: number, messages: AgentMessage[]) => AssistantMessage,
	log?: RequestRecord[],
): StreamFn {
	let requestNo = 0;
	return (model, context) => {
		requestNo++;
		log?.push({ requestNo, messages: context.messages as AgentMessage[], modelId: model.id });
		const stream = newStream();
		pushScriptedReply(stream, script(requestNo, context.messages as AgentMessage[]));
		return stream as never;
	};
}

const userTexts = (messages: readonly AgentMessage[]): string[] =>
	messages
		.filter((m): m is Extract<AgentMessage, { role: "user" }> => m.role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("")));

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	return messages.filter((m): m is AssistantMessage => m.role === "assistant").at(-1);
}

const echoTool = (log: string[] = []): AgentTool => ({
	name: "echo",
	label: "echo",
	description: "echo",
	parameters: z.object({ msg: z.string() }),
	async execute(_toolCallId, params) {
		const msg = (params as { msg: string }).msg;
		log.push(msg);
		return { content: [{ type: "text", text: `echo:${msg}` }], details: { msg } };
	},
});

// ---- Scenario A: steering lands as a user message before the next request ----
{
	console.log("--- scenario A: steering injection ---");
	const requests: RequestRecord[] = [];
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [] },
		streamFn: () => newStream() as never, // replaced below; the tool closure needs the agent
	});
	const slowTool: AgentTool = {
		name: "slow",
		label: "slow",
		description: "slow",
		parameters: z.object({}),
		async execute() {
			agent.steer({ role: "user", content: "STEER-MID-TURN", timestamp: Date.now() });
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	};
	agent.streamFunction = scriptedRequests(
		(requestNo) =>
			requestNo === 1
				? reply([{ type: "toolCall", id: "t1", name: "slow", arguments: {} }], "toolUse")
				: reply([{ type: "text", text: "final" }], "stop"),
		requests,
	);
	agent.state.tools = [slowTool];
	await agent.prompt("go");
	check(
		requests.length === 2 &&
			requests[1]!.messages.some((m) => m.role === "user" && JSON.stringify(m).includes("STEER-MID-TURN")),
		"A: steering message reached the next request's transcript",
	);
	check(
		lastAssistant(agent.state.messages)?.content.some((b) => b.type === "text" && b.text === "final") === true,
		"A: run finished normally after steering",
	);
}

// ---- Scenario B: queue modes one-at-a-time vs all ----
{
	console.log("--- scenario B: queue drain modes ---");
	const runMode = async (mode: "one-at-a-time" | "all") => {
		const requests: RequestRecord[] = [];
		let steered = false;
		const agent = new Agent({
			initialState: { systemPrompt: "s", model: fakeModel, tools: [] },
			steeringMode: mode,
			streamFn: scriptedRequests((requestNo) => reply([{ type: "text", text: `r${requestNo}` }], "stop"), requests),
			finishTurn: (turn) => {
				// Queue both messages once, during the first turn's settlement.
				if (!steered && turn.message.role === "assistant") {
					steered = true;
					agent.steer({ role: "user", content: "S1", timestamp: Date.now() });
					agent.steer({ role: "user", content: "S2", timestamp: Date.now() });
				}
				return undefined;
			},
		});
		await agent.prompt("go");
		return requests.map((r) => userTexts(r.messages).join("|"));
	};
	const oneByOne = await runMode("one-at-a-time");
	check(
		oneByOne.length === 3 && oneByOne[1]!.endsWith("S1") && !oneByOne[1]!.includes("S2") && oneByOne[2]!.endsWith("S2"),
		`B: one-at-a-time spreads messages across turns (${JSON.stringify(oneByOne)})`,
	);
	const allAtOnce = await runMode("all");
	check(
		allAtOnce.length === 2 && allAtOnce[1]!.endsWith("S1|S2"),
		`B: "all" delivers both messages in one turn (${JSON.stringify(allAtOnce)})`,
	);
}

// ---- Scenario C: followUp drains only when the agent would stop ----
{
	console.log("--- scenario C: followUp ---");
	const requests: RequestRecord[] = [];
	const echo = echoTool();
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [echo] },
		streamFn: scriptedRequests(
			(requestNo) =>
				requestNo === 1
					? reply([{ type: "toolCall", id: "t1", name: "echo", arguments: { msg: "x" } }], "toolUse")
					: reply([{ type: "text", text: "final" }], "stop"),
			requests,
		),
	});
	agent.followUp({ role: "user", content: "FOLLOW-UP", timestamp: Date.now() });
	await agent.prompt("go");
	const firstSeen = requests.findIndex((r) => userTexts(r.messages).includes("FOLLOW-UP"));
	check(
		requests.length === 3 && firstSeen === 2,
		`C: follow-up waited for the tool turn, then ran as its own turn (seen at request ${firstSeen} of ${requests.length})`,
	);
	check(
		lastAssistant(agent.state.messages)?.content.some((b) => b.type === "text" && b.text === "final") === true,
		"C: run completed after the follow-up",
	);
}

// ---- Scenario D: finishTurn continue forces one context-only request ----
{
	console.log("--- scenario D: finishTurn continue ---");
	const requests: RequestRecord[] = [];
	let continuations = 0;
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [] },
		streamFn: scriptedRequests((requestNo) => reply([{ type: "text", text: `r${requestNo}` }], "stop"), requests),
		finishTurn: () => (continuations++ < 1 ? { action: "continue" } : undefined),
	});
	await agent.prompt("go");
	check(
		requests.length === 2 && requests[1]!.messages.length === requests[0]!.messages.length + 1,
		`D: exactly one extra context-only request (${requests.length} requests)`,
	);
}

// ---- Scenario E: finishTurn end stops after a tool turn ----
{
	console.log("--- scenario E: finishTurn end ---");
	const requests: RequestRecord[] = [];
	const echo = echoTool();
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [echo] },
		streamFn: scriptedRequests(
			() => reply([{ type: "toolCall", id: "t1", name: "echo", arguments: { msg: "x" } }], "toolUse"),
			requests,
		),
		finishTurn: () => ({ action: "end" }),
	});
	await agent.prompt("go");
	check(requests.length === 1, `E: no request after the end decision (${requests.length})`);
	check(
		agent.state.messages.filter((m) => m.role === "toolResult").length === 1,
		"E: the tool result still landed in the transcript",
	);
}

// ---- Scenario F: abort through the facade ----
{
	console.log("--- scenario F: abort ---");
	let callNo = 0;
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [] },
		streamFn: (_model, _context, opts) => {
			const stream = newStream();
			if (++callNo > 1) {
				// Later prompts get a normal answer.
				pushScriptedReply(stream, reply([{ type: "text", text: "recovered" }], "stop"));
				return stream as never;
			}
			// First call is a hung provider call: nothing arrives unless the
			// abort signal fires.
			opts?.signal?.addEventListener(
				"abort",
				() => pushScriptedReply(stream, reply([], "aborted")),
				{ once: true },
			);
			return stream as never;
		},
	});
	const events: string[] = [];
	agent.subscribe((event) => {
		events.push(event.type);
	});
	const run = agent.prompt("go");
	setTimeout(() => agent.abort(), 30);
	await run;
	await agent.waitForIdle();
	const lastMsg = lastAssistant(agent.state.messages);
	check(
		events.includes("agent_end") && lastMsg?.stopReason === "aborted",
		"F: aborted run ends with an aborted assistant turn",
	);
	check(agent.hasQueuedMessages() === false && agent.signal === undefined, "F: run state fully cleared");
	let secondWorked = false;
	try {
		await agent.prompt("again");
		secondWorked = true;
	} catch {
		secondWorked = false;
	}
	check(secondWorked, "F: the agent accepts a new prompt after an abort");
}

// ---- Scenario G: re-entrancy guard ----
{
	console.log("--- scenario G: re-entrancy ---");
	const busy = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [] },
		streamFn: () => {
			const stream = newStream();
			void (async () => {
				await new Promise((resolve) => setTimeout(resolve, 40));
				pushScriptedReply(stream, reply([{ type: "text", text: "ok" }], "stop"));
			})();
			return stream as never;
		},
	});
	const inFlight = busy.prompt("go");
	let threw = false;
	try {
		await busy.prompt("again");
	} catch (error) {
		threw = error instanceof Error && error.message.includes("already processing");
	}
	await inFlight;
	check(threw, "G: prompt() during an active run throws 'already processing'");
	check(busy.state.messages.at(-1)?.role === "assistant", "G: the original run completed normally");
}

// ---- Scenario H: beforeToolCall block ----
{
	console.log("--- scenario H: beforeToolCall block ---");
	const echoLog: string[] = [];
	const echo = echoTool(echoLog);
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [echo] },
		streamFn: scriptedRequests((requestNo) =>
			requestNo === 1
				? reply([{ type: "toolCall", id: "t1", name: "echo", arguments: { msg: "x" } }], "toolUse")
				: reply([{ type: "text", text: "final" }], "stop"),
		),
		beforeToolCall: async (context: BeforeToolCallContext) =>
			context.toolCall.name === "echo" ? { block: true, reason: "not allowed here" } : undefined,
	});
	await agent.prompt("go");
	const toolResult = agent.state.messages.find((m) => m.role === "toolResult");
	check(echoLog.length === 0, "H: the blocked tool never executed");
	check(
		toolResult !== undefined && toolResult.isError === true && JSON.stringify(toolResult).includes("not allowed here"),
		"H: the block reason became an error tool result",
	);
	check(
		lastAssistant(agent.state.messages)?.content.some((b) => b.type === "text" && b.text === "final") === true,
		"H: the loop continued after the block",
	);
}

// ---- Scenario I: afterToolCall overrides content/details ----
{
	console.log("--- scenario I: afterToolCall override ---");
	const echo = echoTool();
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [echo] },
		streamFn: scriptedRequests((requestNo) =>
			requestNo === 1
				? reply([{ type: "toolCall", id: "t1", name: "echo", arguments: { msg: "x" } }], "toolUse")
				: reply([{ type: "text", text: "final" }], "stop"),
		),
		afterToolCall: async (context) => {
			if (context.toolCall.name !== "echo") return undefined;
			return {
				content: [{ type: "text", text: "REWRITTEN" }],
				details: { rewritten: true },
			};
		},
	});
	await agent.prompt("go");
	const toolResult = agent.state.messages.find((m) => m.role === "toolResult");
	check(
		toolResult !== undefined &&
			toolResult.isError === false &&
			JSON.stringify(toolResult.content).includes("REWRITTEN") &&
			JSON.stringify(toolResult.details).includes("rewritten"),
		"I: afterToolCall replaced content and details",
	);
}

// ---- Scenario J: sequential vs parallel execution ----
{
	console.log("--- scenario J: execution modes ---");
	const runMode = async (mode: "sequential" | "parallel") => {
		const timeline: string[] = [];
		const slow: AgentTool = {
			name: "slow",
			label: "slow",
			description: "slow",
			parameters: z.object({ id: z.string() }),
			async execute(_toolCallId, params) {
				const id = (params as { id: string }).id;
				timeline.push(`start:${id}`);
				await new Promise((resolve) => setTimeout(resolve, 30));
				timeline.push(`end:${id}`);
				return { content: [{ type: "text", text: id }], details: {} };
			},
		};
		const agent = new Agent({
			initialState: { systemPrompt: "s", model: fakeModel, tools: [slow] },
			toolExecution: mode,
			streamFn: scriptedRequests((requestNo) =>
				requestNo === 1
					? reply(
							[
								{ type: "toolCall", id: "t1", name: "slow", arguments: { id: "a" } },
								{ type: "toolCall", id: "t2", name: "slow", arguments: { id: "b" } },
							],
							"toolUse",
						)
					: reply([{ type: "text", text: "final" }], "stop"),
			),
		});
		await agent.prompt("go");
		return timeline.join(",");
	};
	const sequential = await runMode("sequential");
	check(sequential === "start:a,end:a,start:b,end:b", `J: sequential runs one tool at a time (${sequential})`);
	const parallel = await runMode("parallel");
	check(parallel === "start:a,start:b,end:a,end:b", `J: parallel overlaps the two tools (${parallel})`);
}

// ---- Scenario K: unknown tool ----
{
	console.log("--- scenario K: unknown tool ---");
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [] },
		streamFn: scriptedRequests((requestNo) =>
			requestNo === 1
				? reply([{ type: "toolCall", id: "t1", name: "does-not-exist", arguments: {} }], "toolUse")
				: reply([{ type: "text", text: "recovered" }], "stop"),
		),
	});
	await agent.prompt("go");
	const toolResult = agent.state.messages.find((m) => m.role === "toolResult");
	check(
		toolResult !== undefined && toolResult.isError === true && JSON.stringify(toolResult).includes("not found"),
		"K: an unknown tool call becomes an error tool result",
	);
	check(
		lastAssistant(agent.state.messages)?.content.some((b) => b.type === "text" && b.text === "recovered") === true,
		"K: the run recovered after the unknown tool",
	);
}

// ---- Scenario L: validation coercion ----
{
	console.log("--- scenario L: coercion ---");
	const seen: unknown[] = [];
	const coercible: AgentTool = {
		name: "coercible",
		label: "coercible",
		description: "coercible",
		parameters: z.object({
			count: z.number(),
			flag: z.boolean(),
			label: z.string().optional(),
		}),
		async execute(_toolCallId, params) {
			seen.push(params);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [coercible] },
		streamFn: scriptedRequests((requestNo) =>
			requestNo === 1
				? reply(
						[
							{
								type: "toolCall",
								id: "t1",
								name: "coercible",
								arguments: { count: "5", flag: 1, label: null },
							},
						],
						"toolUse",
					)
				: reply([{ type: "text", text: "final" }], "stop"),
		),
	});
	await agent.prompt("go");
	check(
		seen.length === 1 &&
			(seen[0] as { count: number; flag: boolean }).count === 5 &&
			(seen[0] as { count: number; flag: boolean }).flag === true &&
			!("label" in (seen[0] as object)),
		`L: string→number, 1→true, optional null dropped (${JSON.stringify(seen[0])})`,
	);
}

// ---- Scenario M: prepareRequest model swap ----
{
	console.log("--- scenario M: model swap ---");
	const requests: RequestRecord[] = [];
	const echo = echoTool();
	let calls = 0;
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [echo] },
		streamFn: scriptedRequests(
			(requestNo) =>
				requestNo === 1
					? reply([{ type: "toolCall", id: "t1", name: "echo", arguments: { msg: "x" } }], "toolUse")
					: reply([{ type: "text", text: "final" }], "stop"),
			requests,
		),
		prepareRequest: () => (++calls === 2 ? { model: otherModel } : undefined),
	});
	await agent.prompt("go");
	check(
		requests.length === 2 && requests[0]!.modelId === "mock" && requests[1]!.modelId === "mock-b",
		`M: the second request ran on the swapped model (${requests.map((r) => r.modelId).join(",")})`,
	);
}

// ---- Scenario N: prepareNextTurn message injection ----
{
	console.log("--- scenario N: prepareNextTurn injection ---");
	const requests: RequestRecord[] = [];
	let injected = false;
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [] },
		streamFn: scriptedRequests((requestNo) => reply([{ type: "text", text: `r${requestNo}` }], "stop"), requests),
		prepareNextTurn: () => {
			if (injected) return undefined;
			injected = true;
			return { messages: [{ role: "user", content: "INJECTED-BY-HOST", timestamp: Date.now() }] };
		},
		finishTurn: () => (injected ? undefined : { action: "continue" }),
	});
	await agent.prompt("go");
	check(
		requests.length === 2 && requests[1]!.messages.some((m) => JSON.stringify(m).includes("INJECTED-BY-HOST")),
		"N: injected message landed in the transcript and the next request",
	);
}

// ---- Scenario O: length stop fails the tool batch ----
{
	console.log("--- scenario O: length stop ---");
	const echoLog: string[] = [];
	const echo = echoTool(echoLog);
	const agent = new Agent({
		initialState: { systemPrompt: "s", model: fakeModel, tools: [echo] },
		streamFn: scriptedRequests((requestNo) =>
			requestNo === 1
				? reply([{ type: "toolCall", id: "t1", name: "echo", arguments: { msg: "x" } }], "length")
				: reply([{ type: "text", text: "final" }], "stop"),
		),
	});
	await agent.prompt("go");
	const toolResult = agent.state.messages.find((m) => m.role === "toolResult");
	check(echoLog.length === 0, "O: the truncated tool call never executed");
	check(toolResult !== undefined && toolResult.isError === true, "O: the truncated call became an error tool result");
	check(
		lastAssistant(agent.state.messages)?.content.some((b) => b.type === "text" && b.text === "final") === true,
		"O: the loop continued after the failed batch",
	);
}

// ---- Scenario P: reset ----
{
	console.log("--- scenario P: reset ---");
	const echo = echoTool();
	const agent = new Agent({
		initialState: { systemPrompt: "BASELINE-SYSTEM", model: fakeModel, tools: [echo] },
		streamFn: scriptedRequests(() => reply([{ type: "text", text: "ok" }], "stop")),
	});
	await agent.prompt("first conversation");
	agent.steer({ role: "user", content: "queued", timestamp: Date.now() });
	agent.followUp({ role: "user", content: "queued-fu", timestamp: Date.now() });
	agent.reset();
	check(
		agent.state.messages.length === 1 &&
			agent.state.messages[0]?.role === "system" &&
			JSON.stringify(agent.state.messages[0]).includes("BASELINE-SYSTEM"),
		"P: reset kept only the baseline system message",
	);
	check(!agent.hasQueuedMessages(), "P: reset cleared the queues");
	let ok = false;
	try {
		await agent.prompt("second conversation");
		ok = true;
	} catch {
		ok = false;
	}
	check(ok, "P: a fresh prompt runs after reset");
}

console.log(failures === 0 ? "\nCORE VERIFY OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
