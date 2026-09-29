// Vendored from earendil-works/pi v0.87.1 (MIT): packages/ai/src/api/google-generative-ai.lazy.ts
// https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/api/google-generative-ai.lazy.ts

import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleGenerativeAIApi = (): ProviderStreams => lazyApi(() => import("./google-generative-ai.ts"));
