/**
 * Minimal real-model agent using the vendored SDK.
 * Requires DEEPSEEK_API_KEY. Run: npm run demo
 */
import { Agent, autoCompaction, harnessToolToAgentTool } from "../src/index.ts";
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

const env = new NodeExecutionEnv({ cwd: "/tmp" });
const toolContext = { env };

const agent = new Agent({
	initialState: {
		systemPrompt:
			"You are a coding assistant. Use the tools (read/write/edit/bash) to inspect and modify the working directory. Answer in Chinese.",
		model,
		// Enable thinking: deepseek-flash supports "low" | "high" | "max"
		thinkingLevel: "high",
		tools: [
			harnessToolToAgentTool(createReadTool(), toolContext),
			harnessToolToAgentTool(createWriteTool(), toolContext),
			harnessToolToAgentTool(createEditTool(), toolContext),
			harnessToolToAgentTool(createBashTool(), toolContext),
		],
	},
	streamFn: models.streamSimple.bind(models),
	// Auto context compaction (default cap: 128K tokens).
	...autoCompaction(models, { model }),
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

await agent.prompt("What files are in the current working directory? Pick one, read it, and summarize its contents.");
console.log();
