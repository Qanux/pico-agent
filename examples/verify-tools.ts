/**
 * End-to-end verification without an API key: a scripted LangChain chat model
 * (createScriptedModel) drives the real vendored tools (write → read → edit →
 * bash) through the real agent loop over the real stream bridge
 * (createModelStreamFn) — unlike pico-agent's hand-rolled scripted StreamFn,
 * every request here crosses the LangChain boundary.
 * Run: node examples/verify-tools.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	createModelStreamFn,
	createScriptedModel,
	harnessToolToAgentTool,
	type AssistantMessage,
	type ToolCall,
} from "pico-langchain";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	NodeExecutionEnv,
} from "pico-langchain";

const workspace = mkdtempSync(join(tmpdir(), "pico-lc-verify-"));
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
		api: "langchain-scripted",
		provider: "scripted",
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
	const calls: Array<{ id: string; name: string; arguments: ToolCall["arguments"] }> = [
		{ id: "t1", name: "write", arguments: { path: "notes.txt", content: "alpha\nbeta\n" } },
		{ id: "t2", name: "read", arguments: { path: "notes.txt" } },
		{ id: "t3", name: "edit", arguments: { path: "notes.txt", edits: [{ oldText: "beta", newText: "beta-edited" }] } },
		{ id: "t4", name: "bash", arguments: { command: "cat notes.txt && ls" } },
	];
	if (step < calls.length) {
		return {
			...baseMessage(),
			content: [{ type: "toolCall", ...calls[step]! }],
			stopReason: "toolUse",
		};
	}
	return {
		...baseMessage(),
		usage: {
			input: 17, output: 9, cacheRead: 4, cacheWrite: 2, totalTokens: 26,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [{ type: "text", text: "All four tools executed successfully." }],
		stopReason: "stop",
	};
}

const model = createScriptedModel({
	id: "mock",
	responses: [planForStep(0), planForStep(1), planForStep(2), planForStep(3), planForStep(4)],
});

const agent = new Agent({
	initialState: {
		systemPrompt: "You are a verification agent.",
		model,
		tools,
	},
	streamFn: createModelStreamFn(),
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

const finalAssistant = agent.state.messages
	.filter((m): m is AssistantMessage => m.role === "assistant")
	.at(-1);
const finalUsageOk =
	finalAssistant?.usage.input === 17 &&
	finalAssistant?.usage.output === 9 &&
	finalAssistant?.usage.cacheRead === 4 &&
	finalAssistant?.usage.cacheWrite === 2 &&
	finalAssistant?.model === "mock";

const ok =
	events.join(",") === "write,read,edit,bash" &&
	finalFile === "alpha\nbeta-edited\n" &&
	!events.some((e) => e.includes("ERROR")) &&
	finalUsageOk === true;

rmSync(workspace, { recursive: true, force: true });
console.log(ok ? "\nVERIFY OK" : "\nVERIFY FAILED");
process.exit(ok ? 0 : 1);
