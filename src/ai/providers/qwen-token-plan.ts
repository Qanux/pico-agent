// Vendored from earendil-works/pi v0.87.1 (MIT): packages/ai/src/providers/qwen-token-plan.ts
// https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/providers/qwen-token-plan.ts

import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_TOKEN_PLAN_MODELS } from "./qwen-token-plan.models.ts";

export function qwenTokenPlanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-token-plan",
		name: "Qwen Token Plan",
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan API key", ["QWEN_TOKEN_PLAN_API_KEY"]) },
		models: Object.values(QWEN_TOKEN_PLAN_MODELS),
		api: openAICompletionsApi(),
	});
}
