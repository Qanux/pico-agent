// Vendored from earendil-works/pi v0.87.1 (MIT): packages/agent/src/stream-fn.ts
// https://github.com/earendil-works/pi/blob/v0.87.1/packages/agent/src/stream-fn.ts

import type { StreamFn } from "./types.ts";

let defaultStreamFn: StreamFn | undefined;

/**
 * Configure the fallback used by Agent and low-level loops when callers omit streamFn.
 *
 * Hosts that provide a default model runtime can install its stream function here
 * without making pi-agent-core depend on a provider catalog or compatibility layer.
 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
	defaultStreamFn = streamFn;
}

export function getDefaultStreamFn(): StreamFn {
	if (!defaultStreamFn) {
		throw new Error("No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().");
	}
	return defaultStreamFn;
}
