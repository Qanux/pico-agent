// Vendored from earendil-works/pi v0.87.1 (MIT): packages/ai/src/api/anthropic-messages.lazy.ts
// https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/api/anthropic-messages.lazy.ts

import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const anthropicMessagesApi = (): ProviderStreams => lazyApi(() => import("./anthropic-messages.ts"));
