// pico-langchain: write tool.
//
// Ported from earendil-works/pi v0.87.1 (MIT): packages/agent/src/harness/tools/write.ts
// https://github.com/earendil-works/pi/blob/v0.87.1/packages/agent/src/harness/tools/write.ts
// Schema substrate swapped: typebox → zod. Logic is unchanged.

import { z } from "zod";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const writeSchema = z.object({
	path: z.string().describe("Path to the file to write (relative or absolute)"),
	content: z.string().describe("Content to write to the file"),
});

export type WriteToolInput = z.output<typeof writeSchema>;

export function createWriteTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof writeSchema,
	undefined
> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(_toolCallId, { path, content }, _onUpdate, { env }, _invocation, context) {
			const absolutePath = await resolveToolPath(env, path, context);
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					getOrThrow(await env.writeFile(absolutePath, content, context));
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					return {
						content: [{ type: "text", text: `Successfully wrote to ${path}` }],
						details: undefined,
					};
				},
				context,
			);
		},
	};
}
