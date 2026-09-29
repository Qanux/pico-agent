/**
 * Provider smoke test (no API keys needed): every vendored provider factory
 * resolves, its model catalog loads, and every adapter module imports cleanly.
 * Run: node examples/verify-providers.ts
 */
import { createModels } from "../src/index.ts";
import {
	anthropicProvider,
	deepseekProvider,
	googleProvider,
	minimaxCnProvider,
	minimaxProvider,
	moonshotaiCnProvider,
	moonshotaiProvider,
	openaiProvider,
	qwenTokenPlanCnProvider,
	qwenTokenPlanIndividualProvider,
	qwenTokenPlanProvider,
	xaiProvider,
	xiaomiProvider,
	xiaomiTokenPlanAmsProvider,
	xiaomiTokenPlanCnProvider,
	xiaomiTokenPlanSgpProvider,
	zaiCodingCnProvider,
	zaiProvider,
} from "../src/index.ts";

// Force adapter modules to load (providers reference them lazily).
await import("../src/ai/api/anthropic-messages.ts");
await import("../src/ai/api/openai-completions.ts");
await import("../src/ai/api/openai-responses.ts");
await import("../src/ai/api/google-generative-ai.ts");

const providers = {
	anthropic: anthropicProvider,
	openai: openaiProvider,
	google: googleProvider,
	xai: xaiProvider,
	zai: zaiProvider,
	"zai-coding-cn": zaiCodingCnProvider,
	minimax: minimaxProvider,
	"minimax-cn": minimaxCnProvider,
	moonshotai: moonshotaiProvider,
	"moonshotai-cn": moonshotaiCnProvider,
	xiaomi: xiaomiProvider,
	"xiaomi-token-plan-cn": xiaomiTokenPlanCnProvider,
	"xiaomi-token-plan-sgp": xiaomiTokenPlanSgpProvider,
	"xiaomi-token-plan-ams": xiaomiTokenPlanAmsProvider,
	"qwen-token-plan": qwenTokenPlanProvider,
	"qwen-token-plan-cn": qwenTokenPlanCnProvider,
	"qwen-token-plan-individual": qwenTokenPlanIndividualProvider,
	deepseek: deepseekProvider,
};

let failures = 0;
const models = createModels();
for (const [id, factory] of Object.entries(providers)) {
	try {
		const provider = factory();
		models.setProvider(provider);
		const chat = provider.getModels().filter((m) => m.type !== "image" && m.type !== "classifier");
		const first = chat[0];
		if (!first) throw new Error("no chat models in catalog");
		const resolved = models.getModel(id, first.id);
		if (!resolved) throw new Error(`getModel(${id}, ${first.id}) returned undefined`);
		console.log(
			`ok  ${id.padEnd(24)} ${String(chat.length).padStart(3)} chat models  e.g. ${first.id} (ctx ${first.contextWindow ?? "?"})`,
		);
	} catch (error) {
		failures++;
		console.log(`FAIL ${id}: ${error instanceof Error ? error.message : error}`);
	}
}
console.log(failures === 0 ? `\nALL ${Object.keys(providers).length} PROVIDERS OK` : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
