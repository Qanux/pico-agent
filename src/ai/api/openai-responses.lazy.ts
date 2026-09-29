// Vendored from earendil-works/pi v0.87.1 (MIT): packages/ai/src/api/openai-responses.lazy.ts
// https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/api/openai-responses.lazy.ts

import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAIResponsesApi = (): ProviderStreams => lazyApi(() => import("./openai-responses.ts"));
