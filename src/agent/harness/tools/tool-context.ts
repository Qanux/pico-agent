// Vendored from earendil-works/pi v0.87.1 (MIT): packages/agent/src/harness/tools/tool-context.ts
// https://github.com/earendil-works/pi/blob/v0.87.1/packages/agent/src/harness/tools/tool-context.ts

import type { ExecutionEnv } from "../types.ts";

/** Filesystem and shell context required by the built-in execution tools. */
export interface ExecutionToolContext {
	env: ExecutionEnv;
}