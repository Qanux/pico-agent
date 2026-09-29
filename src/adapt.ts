// Original to the pico-agent extraction of earendil-works/pi v0.87.1 — bridges harness tools to the core AgentTool interface
// https://github.com/earendil-works/pi/blob/v0.87.1/undefined

import type { AgentTool } from "./agent/types.ts";
import type { AgentHarnessTool, AgentHarnessToolInvocation } from "./agent/harness/types.ts";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "./support/chord-context.ts";
import type { ExecutionToolContext } from "./agent/harness/tools/tool-context.ts";

/**
 * Adapt a harness-native tool (bash/read/write/edit, six-arg execute with
 * toolContext + Context) to the core AgentTool shape consumed by `Agent`.
 *
 * The core AbortSignal is mapped onto the chord context's abortSignal so the
 * tool's cooperative cancellation checks keep working. Harness-only features
 * (durable replay memos, checkpoints) are stubbed out.
 */
export function harnessToolToAgentTool<TContext extends ExecutionToolContext>(
	tool: AgentHarnessTool<TContext, any, any>,
	toolContext: TContext,
): AgentTool<any, any> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			const invocation: AgentHarnessToolInvocation = {
				invocationId: toolCallId,
				operationId: "agent",
				turnId: "agent",
				getMemo: async () => undefined,
				setMemo: async () => {},
			};
			let context: Context = BACKGROUND_CONTEXT;
			if (signal) context = withAbortSignal(signal, context);
			return tool.execute(
				toolCallId,
				params as never,
				(partialResult) => onUpdate?.(partialResult as never),
				toolContext,
				invocation,
				context,
			);
		},
	};
}
