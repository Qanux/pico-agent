/**
 * Minimal real-model agent using the LangChain substrate.
 * Requires DEEPSEEK_API_KEY. Run: npm run demo
 */
import { Agent, autoCompaction, createModelStreamFn, createOpenAIModel, harnessToolToAgentTool } from "pico-langchain";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	NodeExecutionEnv,
} from "pico-langchain";

if (!process.env.DEEPSEEK_API_KEY) {
	console.error("Set DEEPSEEK_API_KEY first (or run `npm run verify` for the no-key check).");
	process.exit(1);
}

// pico-agent resolved this through its bundled provider catalog
// (createModels + deepseekProvider); here the LangChain chat model IS the
// catalog entry — any OpenAI-compatible endpoint, or any other
// @langchain/* chat model wrapped the same way.
const model = createOpenAIModel({
	model: "deepseek-chat",
	baseURL: "https://api.deepseek.com",
	apiKey: process.env.DEEPSEEK_API_KEY,
});

const env = new NodeExecutionEnv({ cwd: "/tmp" });
const toolContext = { env };

const agent = new Agent({
	initialState: {
		systemPrompt:
			"You are a coding assistant. Use the tools (read/write/edit/bash) to inspect and modify the working directory. Answer in Chinese.",
		model,
		// Forwarded per request as the reasoning call option by the bridge.
		thinkingLevel: "high",
		tools: [
			harnessToolToAgentTool(createReadTool(), toolContext),
			harnessToolToAgentTool(createWriteTool(), toolContext),
			harnessToolToAgentTool(createEditTool(), toolContext),
			harnessToolToAgentTool(createBashTool(), toolContext),
		],
	},
	streamFn: createModelStreamFn(),
	// Auto context compaction (default cap: 128K tokens).
	...autoCompaction({ model }),
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
