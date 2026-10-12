/**
 * streamProxy end-to-end regression against a local node:http mock server —
 * the real fetch, SSE buffering, event reconstruction, and error paths, no
 * LLM involved.
 *
 *   A happy path: full event protocol (start, thinking, text, tool call with
 *     streamed partialJson, done with usage) reconstructs the assistant
 *     message; the request carries the model descriptor (never the LangChain
 *     handle), the context, and the serializable options.
 *   B chunk-split SSE: events split across TCP writes mid-token and a final
 *     event without trailing newline still parse.
 *   C premature EOF: clean close without a terminal event surfaces the
 *     "Connection closed by proxy server" error.
 *   D HTTP errors: non-200 with a JSON error body and with an unparseable
 *     body.
 *   E abort mid-stream: stall + AbortController → aborted error event.
 *   F text/thinking signatures and toolcall end merge (contentSignature →
 *     textSignature/thinkingSignature, toolcall_end overwrites partialJson).
 * Run: node examples/verify-proxy.ts
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	createUnavailableModel,
	streamProxy,
	type AgentModel,
	type AssistantMessage,
	type AssistantMessageEvent,
	type TranscriptContext,
} from "pico-langchain";

let failures = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

const fakeModel: AgentModel = { ...createUnavailableModel(), id: "mock-proxied", provider: "mock" };

const context: TranscriptContext = {
	messages: [
		{ role: "system", content: "sys", timestamp: 0 },
		{ role: "user", content: "hello", timestamp: 1 },
	],
} as TranscriptContext;

interface CapturedRequest {
	method: string | undefined;
	url: string | undefined;
	auth: string | string[] | undefined;
	contentType: string | string[] | undefined;
	body: {
		model: Record<string, unknown>;
		context: { messages: unknown[] };
		options: Record<string, unknown>;
	};
}

interface MockServer {
	server: Server;
	url: string;
	requests: CapturedRequest[];
}

async function startMock(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<MockServer> {
	const server = createServer((req, res) => handler(req, res));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${address.port}`, requests: [] };
}

function captureBody(server: MockServer, req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

/** Collect all events from a proxy stream plus its final result. */
async function drain(stream: { [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>; result(): Promise<AssistantMessage> }) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	return { events, result };
}

const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n`;

// ---- Scenario A: happy path + request shape ----
{
	console.log("--- scenario A: happy path ---");
	const mock = await startMock(async (req, res) => {
		const raw = await captureBody(mock, req);
		mock.requests.push({
			method: req.method,
			url: req.url,
			auth: req.headers.authorization,
			contentType: req.headers["content-type"],
			body: JSON.parse(raw) as CapturedRequest["body"],
		});
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write(sse({ type: "start" }));
		res.write(sse({ type: "thinking_start", contentIndex: 0 }));
		res.write(sse({ type: "thinking_delta", contentIndex: 0, delta: "ponder" }));
		res.write(sse({ type: "thinking_end", contentIndex: 0, contentSignature: "sig-think" }));
		res.write(sse({ type: "text_start", contentIndex: 1 }));
		res.write(sse({ type: "text_delta", contentIndex: 1, delta: "Hello " }));
		res.write(sse({ type: "text_delta", contentIndex: 1, delta: "world" }));
		res.write(sse({ type: "text_end", contentIndex: 1, contentSignature: "sig-text" }));
		res.write(sse({ type: "toolcall_start", contentIndex: 2, id: "call-1", toolName: "echo" }));
		res.write(sse({ type: "toolcall_delta", contentIndex: 2, delta: '{"msg": "hi' }));
		// Space the second delta out so the consumer observes the intermediate
		// arguments snapshot (the partial object mutates in place).
		await new Promise((resolve) => setTimeout(resolve, 30));
		res.write(sse({ type: "toolcall_delta", contentIndex: 2, delta: ' there"}' }));
		res.write(
			sse({
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: { type: "toolCall", id: "call-1", name: "echo", arguments: { msg: "hi there" } },
			}),
		);
		res.write(
			sse({
				type: "done",
				reason: "toolUse",
				usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				providerThinkingLevel: "high",
			}),
		);
		res.end();
	});

	const stream = streamProxy(fakeModel, context, { authToken: "token-123", proxyUrl: mock.url, temperature: 0.5, maxTokens: 64, reasoning: "low", sessionId: "sess-1" });
	// The `partial` objects mutate as later events arrive, so snapshot streamed
	// tool arguments at each delta instead of reading events after the drain.
	const toolArgSnapshots: string[] = [];
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		if (event.type === "toolcall_delta") {
			toolArgSnapshots.push(JSON.stringify((event.partial.content[event.contentIndex] as { arguments?: unknown }).arguments));
		}
		events.push(event);
	}
	const result = await stream.result();
	const types = events.map((e) => e.type).join(",");
	check(
		types === "start,thinking_start,thinking_delta,thinking_end,text_start,text_delta,text_delta,text_end,toolcall_start,toolcall_delta,toolcall_delta,toolcall_end,done",
		`A: full event sequence replayed in order (${types})`,
	);
	check(
		result.stopReason === "toolUse" &&
			result.usage.input === 11 && result.usage.totalTokens === 18 && result.providerThinkingLevel === "high",
		"A: done event fills stopReason, usage, providerThinkingLevel",
	);
	const blocks = result.content;
	check(
		blocks[0]?.type === "thinking" && blocks[0].thinking === "ponder" && blocks[0].thinkingSignature === "sig-think",
		"A: thinking block reconstructed with signature",
	);
	check(
		blocks[1]?.type === "text" && blocks[1].text === "Hello world" && blocks[1].textSignature === "sig-text",
		"A: text block reconstructed with signature",
	);
	const toolBlock = blocks[2];
	check(
		toolBlock?.type === "toolCall" &&
			toolBlock.id === "call-1" && toolBlock.name === "echo" &&
			JSON.stringify(toolBlock.arguments) === JSON.stringify({ msg: "hi there" }) &&
			!("partialJson" in toolBlock),
		"A: tool call merged from deltas without partialJson residue",
	);
	// Incremental parse: after the first delta the arguments hold the partial prefix.
	check(
		toolArgSnapshots.length === 2 &&
			toolArgSnapshots[0] === JSON.stringify({ msg: "hi" }) &&
			toolArgSnapshots[1] === JSON.stringify({ msg: "hi there" }),
		`A: partial arguments parse incrementally during streaming (${toolArgSnapshots.join(" | ")})`,
	);

	const request = mock.requests[0]!;
	check(request.method === "POST" && request.url === "/api/stream", "A: POSTs to /api/stream");
	check(request.auth === "Bearer token-123" && request.contentType === "application/json", "A: auth and content-type headers");
	check(
		request.body.model.id === "mock-proxied" && request.body.model.contextWindow === fakeModel.contextWindow &&
			!JSON.stringify(request.body.model).includes("chat"),
		"A: model descriptor carries catalog metadata, never the ChatModel handle",
	);
	check(request.body.context.messages.length === 2, "A: transcript context forwarded");
	check(
		request.body.options.temperature === 0.5 && request.body.options.maxTokens === 64 &&
			request.body.options.reasoning === "low" && request.body.options.sessionId === "sess-1",
		"A: serializable options forwarded",
	);
	mock.server.close();
}

// ---- Scenario B: chunk-split SSE and missing trailing newline ----
{
	console.log("--- scenario B: split chunks ---");
	const payload = sse({ type: "start" }) + sse({ type: "text_start", contentIndex: 0 }) + sse({ type: "text_delta", contentIndex: 0, delta: "abc" });
	const mock = await startMock(async (_req, res) => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		// Split mid-token, then finish with a terminal event that has NO trailing
		// newline — exercises line buffering and the final decoder flush.
		for (let i = 0; i < payload.length; i += 7) {
			res.write(payload.slice(i, i + 7));
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		res.write(`data: ${JSON.stringify({ type: "done", reason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })}`);
		res.end();
	});
	const { events, result } = await drain(streamProxy(fakeModel, context, { authToken: "t", proxyUrl: mock.url }));
	check(
		events.length === 4 && events.map((e) => e.type).join(",") === "start,text_start,text_delta,done",
		"B: split chunks reassemble into complete events",
	);
	check(result.stopReason === "stop" && result.content[0]?.type === "text" && result.content[0].text === "abc",
		"B: unterminated final event still parsed after EOF flush");
	mock.server.close();
}

// ---- Scenario C: EOF without a terminal event ----
{
	console.log("--- scenario C: premature EOF ---");
	const mock = await startMock(async (_req, res) => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write(sse({ type: "start" }));
		res.write(sse({ type: "text_start", contentIndex: 0 }));
		res.end(); // dies mid-message without done/error
	});
	const { events, result } = await drain(streamProxy(fakeModel, context, { authToken: "t", proxyUrl: mock.url }));
	const errorEvent = events.find((e) => e.type === "error") as { reason: string; error: AssistantMessage } | undefined;
	check(
		errorEvent !== undefined && errorEvent.reason === "error" && result.stopReason === "error" &&
			result.errorMessage === "Connection closed by proxy server before the response completed",
		"C: clean EOF without a terminal event becomes a stream error",
	);
	mock.server.close();
}

// ---- Scenario D: HTTP error statuses ----
{
	console.log("--- scenario D: HTTP errors ---");
	const jsonMock = await startMock(async (_req, res) => {
		res.writeHead(503, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "model overloaded" }));
	});
	const jsonResult = await drain(streamProxy(fakeModel, context, { authToken: "t", proxyUrl: jsonMock.url }));
	check(
		jsonResult.result.stopReason === "error" && jsonResult.result.errorMessage === "Proxy error: model overloaded",
		"D: JSON error body surfaces as Proxy error",
	);
	jsonMock.server.close();

	const textMock = await startMock(async (_req, res) => {
		res.writeHead(500, { "Content-Type": "text/plain" });
		res.end("<html>boom</html>");
	});
	const textResult = await drain(streamProxy(fakeModel, context, { authToken: "t", proxyUrl: textMock.url }));
	check(
		textResult.result.stopReason === "error" && (textResult.result.errorMessage ?? "").includes("Proxy error: 500"),
		"D: unparseable body falls back to the status line",
	);
	textMock.server.close();
}

// ---- Scenario E: abort mid-stream ----
{
	console.log("--- scenario E: abort ---");
	const mock = await startMock(async (_req, res) => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write(sse({ type: "start" }));
		res.write(sse({ type: "text_start", contentIndex: 0 }));
		res.write(sse({ type: "text_delta", contentIndex: 0, delta: "partial" }));
		// Then stall forever.
	});
	const controller = new AbortController();
	const stream = streamProxy(fakeModel, context, { authToken: "t", proxyUrl: mock.url, signal: controller.signal });
	setTimeout(() => controller.abort(), 100);
	const { result } = await drain(stream);
	check(
		result.stopReason === "aborted",
		`E: client abort produces an aborted result (${result.stopReason})`,
	);
	mock.server.close();
}

console.log(failures === 0 ? "\nPROXY VERIFY OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
