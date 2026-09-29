/**
 * End-to-end verification without an API key: a scripted "model" drives the
 * real vendored tools (write → read → edit → bash) through the real agent loop.
 * Run: npm run verify
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, harnessToolToAgentTool } from "../src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, StreamFn } from "../src/index.ts";
import { EventStream } from "../src/index.ts";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	NodeExecutionEnv,
} from "../src/index.ts";

const workspace = mkdtempSync(join(tmpdir(), "pi-mini-verify-"));
const env = new NodeExecutionEnv({ cwd: workspace });
const toolContext = { env };

const tools = [
	harnessToolToAgentTool(createWriteTool(), toolContext),
	harnessToolToAgentTool(createReadTool(), toolContext),
	harnessToolToAgentTool(createEditTool(), toolContext),
	harnessToolToAgentTool(createBashTool(), toolContext),
];

function baseMessage(): Omit<AssistantMessage, "content" | "stopReason"> {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

// Scripted plan: write file → read it → edit it → cat via bash → final answer.
function planForStep(step: number): AssistantMessage {
	const calls = [
		{ id: "t1", name: "write", arguments: { path: "notes.txt", content: "alpha\nbeta\n" } },
		{ id: "t2", name: "read", arguments: { path: "notes.txt" } },
		{ id: "t3", name: "edit", arguments: { path: "notes.txt", edits: [{ oldText: "beta", newText: "beta-edited" }] } },
		{ id: "t4", name: "bash", arguments: { command: "cat notes.txt && ls" } },
	];
	if (step < calls.length) {
		return {
			...baseMessage(),
			content: [{ type: "toolCall", ...calls[step] }],
			stopReason: "toolUse",
		};
	}
	return {
		...baseMessage(),
		content: [{ type: "text", text: "All four tools executed successfully." }],
		stopReason: "stop",
	};
}

const streamFn: StreamFn = (_model, context) => {
	const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
		(e) => e.type === "done" || e.type === "error",
		(e) => {
			if (e.type === "done") return e.message;
			if (e.type === "error") return e.error;
			throw new Error("unexpected event");
		},
	);
	const step = context.messages.filter((m) => m.role === "assistant").length;
	const message = planForStep(step);
	void (async () => {
		stream.push({ type: "start" });
		stream.push({ type: "message", message });
		stream.push({ type: "done", message, stopReason: message.stopReason });
		stream.end();
	})();
	return stream;
};

const fakeModel: unknown = { id: "mock", api: "anthropic-messages", provider: "mock" };

const agent = new Agent({
	initialState: {
		systemPrompt: "You are a verification agent.",
		model: fakeModel as never,
		tools,
	},
	streamFn,
});

const events: string[] = [];
agent.subscribe((event) => {
	if (event.type === "tool_execution_start") events.push(event.toolName);
	if (event.type === "tool_execution_end" && event.isError) events.push(`${event.toolName}!ERROR`);
});

await agent.prompt("Run the verification plan.");

console.log("tool order: ", events.join(" -> "));
console.log("transcript:", agent.state.messages.map((m) => m.role).join(" -> "));

const finalFile = readFileSync(join(workspace, "notes.txt"), "utf-8");
console.log("notes.txt after edit:\n" + finalFile);

const ok =
	events.join(",") === "write,read,edit,bash" &&
	finalFile === "alpha\nbeta-edited\n" &&
	!events.some((e) => e.includes("ERROR"));

rmSync(workspace, { recursive: true, force: true });
console.log(ok ? "\nVERIFY OK" : "\nVERIFY FAILED");
process.exit(ok ? 0 : 1);
