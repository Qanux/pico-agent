/**
 * Multi-turn conversational agent: one Agent instance, many prompt() calls.
 * Context accumulates in agent.state.messages across turns — no manual history passing.
 * Toolset includes the subagent tool (max 3 parallel subagents per call, children
 * inherit this agent's toolset minus the subagent tool and its 200K compaction window).
 * Requires DEEPSEEK_API_KEY. Run: npm run chat
 */
import * as readline from "node:readline/promises";
import { Agent, autoCompaction, createSubagentTool, harnessToolToAgentTool } from "../src/index.ts";
import { createModels, deepseekProvider } from "../src/index.ts";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	NodeExecutionEnv,
} from "../src/index.ts";

if (!process.env.DEEPSEEK_API_KEY) {
	console.error("Set DEEPSEEK_API_KEY first (or run `npm run verify` for the no-key check).");
	process.exit(1);
}

const models = createModels();
models.setProvider(deepseekProvider());
const model = models.getModel("deepseek", "deepseek-flash");
if (!model) throw new Error("Model not found: deepseek/deepseek-flash");

const env = new NodeExecutionEnv({ cwd: process.cwd() });
const toolContext = { env };

const baseTools = [
	harnessToolToAgentTool(createReadTool(), toolContext),
	harnessToolToAgentTool(createWriteTool(), toolContext),
	harnessToolToAgentTool(createEditTool(), toolContext),
	harnessToolToAgentTool(createBashTool(), toolContext),
];

// Shared compaction settings. Children inherit the parent's context window — the
// subagent tool itself defines no window of its own.
const compactionOptions = {
	model,
	maxContextTokens: 200_000,
	onCompaction: (s: { before: number; after: number; droppedMessages: number; skipped?: string }) =>
		console.log(
			`\n[compact] ${s.before} -> ${s.after} tokens (${s.droppedMessages} msgs${s.skipped ? `, skipped: ${s.skipped}` : ""})`,
		),
};

// At most 3 subagents per subagent tool call; each child runs with the parent's
// current tools minus the subagent tool, a fresh context, and the same compaction.
const subagent = createSubagentTool({
	getTools: () => [...baseTools, subagent],
	createAgent: ({ tools, systemPrompt }) =>
		new Agent({
			initialState: { systemPrompt, model, thinkingLevel: "high", tools },
			streamFn: models.streamSimple.bind(models),
			...autoCompaction(models, {
				...compactionOptions,
				// Distinguish child compaction from the parent's in the console log.
				onCompaction: (s) => console.log(`\n[compact·sub] ${s.before} -> ${s.after} tokens (${s.droppedMessages} msgs)`),
			}),
		}),
	maxConcurrent: 3,
});

// ONE agent for the whole session. The transcript lives in agent.state.messages
// and carries across prompt() calls — creating a new Agent per turn resets it.
const agent = new Agent({
	initialState: {
		systemPrompt:
			"You are a coding assistant working in the current directory. Use the tools to inspect and modify files. Answer in Chinese.",
		model,
		thinkingLevel: "high",
		tools: [...baseTools, subagent],
	},
	streamFn: models.streamSimple.bind(models),
	// Auto context compaction: effective window 200K (trigger at 75% = 150K).
	...autoCompaction(models, compactionOptions),
});

agent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
		process.stderr.write(event.assistantMessageEvent.delta);
	}
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
	if (event.type === "tool_execution_start") {
		console.log(`\n[tool] ${event.toolName} ${JSON.stringify(event.args)}`);
	}
	if (event.type === "tool_execution_end" && event.isError) {
		console.log(`[tool] ${event.toolName} errored`);
	}
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let turn = 0;
try {
	while (true) {
		const line = (await rl.question(`\n[turn ${++turn} · ${agent.state.messages.length} msgs] > `)).trim();
		if (!line) continue;
		if (line === "exit" || line === "quit") break;
		if (line === "abort") {
			agent.abort();
			continue;
		}
		// Runs the full LLM↔tool loop to completion; context is kept for the next turn.
		// If you need to interject while this await is in flight, use agent.steer();
		// to queue the next turn before the current one finishes, use agent.followUp().
		await agent.prompt(line);
	}
} finally {
	rl.close();
}
