// Vendored from earendil-works/pi v0.87.1 (MIT): packages/agent/src/harness/context.ts
// https://github.com/earendil-works/pi/blob/v0.87.1/packages/agent/src/harness/context.ts

import type { Context, ContextKey } from "../../support/json-value.ts";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	createContextKey,
	TODO_CONTEXT,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
} from "../../support/chord-context.ts";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "../../support/telemetry.ts";

export {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	type Context,
	type ContextKey,
	createContextKey,
	TODO_CONTEXT,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
};

const TELEMETRY_CONTEXT_KEY = createContextKey<TelemetryContext>("pi.telemetryContext");

/** Return the telemetry parent attached to a context, or the shared no-op parent. */
export function getTelemetryContext(context: Context): TelemetryContext {
	return context.value(TELEMETRY_CONTEXT_KEY) ?? NOOP_TELEMETRY_CONTEXT;
}

/** Derive a context whose telemetry children use the supplied parent or active span. */
export function withTelemetryContext(telemetryContext: TelemetryContext, context: Context): Context {
	return withContextValue(TELEMETRY_CONTEXT_KEY, telemetryContext, context);
}
