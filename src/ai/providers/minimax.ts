// Vendored from earendil-works/pi v0.87.1 (MIT): packages/ai/src/providers/minimax.ts
// https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/providers/minimax.ts

import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MINIMAX_MODELS } from "./minimax.models.ts";

export function minimaxProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "minimax",
		name: "MiniMax",
		baseUrl: "https://api.minimax.io/anthropic",
		auth: { apiKey: envApiKeyAuth("MiniMax API key", ["MINIMAX_API_KEY"]) },
		models: Object.values(MINIMAX_MODELS),
		api: anthropicMessagesApi(),
	});
}
