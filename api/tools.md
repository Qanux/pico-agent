# Tools

## `AgentTool` — the core interface

```typescript
import type { AgentTool } from "pico-agent";
import { z } from "zod";

interface AgentTool<TParameters extends z.ZodType = z.ZodType, TDetails = any> extends Tool<TParameters> {
	name: string;                        // what the model calls
	description: string;                 // what the model reads
	parameters: TParameters;             // zod schema for arguments
	label: string;                       // human-readable UI label
	prepareArguments?: (args: unknown) => z.output<TParameters>;   // compat shim before validation
	execute: (
		toolCallId: string,
		params: z.output<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	replay?: "never" | "safe";           // recovery policy for unknown-outcome effects
	executionMode?: "sequential" | "parallel";   // per-tool concurrency override
}
```

Throw on failure — the loop converts throws into `isError` tool results. `onUpdate` streams partial results into `tool_execution_update` events.

### Custom tool example

```typescript
import { z, type AgentTool } from "pico-agent";

const echo: AgentTool<z.ZodObject<{ msg: z.ZodString }>> = {
	name: "echo",
	label: "echo",
	description: "echoes the message back",
	parameters: z.object({ msg: z.string() }),
	async execute(toolCallId, params, signal) {
		if (signal?.aborted) throw new Error("aborted");
		const { msg } = params;
		return { content: [{ type: "text", text: `echo:${msg}` }], details: {} };
	},
};
```

Tool schemas are **zod** (pi used typebox): `z.toJSONSchema` builds the model-visible declarations, and arguments are validated and coerced with the same observable contract as pi's validator.

## Built-in harness tools

Four tools built on `ExecutionEnv`; bind one env and adapt them into core tools:

```typescript
import {
	createBashTool, createReadTool, createWriteTool, createEditTool,
	harnessToolToAgentTool, NodeExecutionEnv,
} from "pico-agent";

const env = new NodeExecutionEnv({ cwd: "/tmp" });
const toolContext = { env };
const tools = [
	harnessToolToAgentTool(createBashTool(), toolContext),
	harnessToolToAgentTool(createReadTool(), toolContext),
	harnessToolToAgentTool(createWriteTool(), toolContext),
	harnessToolToAgentTool(createEditTool(), toolContext),
];
```

### `createBashTool(options?)`

```typescript
const bash = createBashTool();
// model calls:
// { "command": "ls -la", "timeoutMs": 10000, "workdir": "src/", "netfail": "ignore" }
```

Input schema: `{ command: string, timeoutMs?: number, workdir?: string, netfail?: "fail" | "ignore" }`. Executes through the env's shell; output truncation configurable via options.

### `createReadTool(options?)`

```typescript
const read = createReadTool();
// model calls:
// { "path": "src/index.ts" }            whole file
// { "path": "big.log", "offset": 100, "limit": 50 }
```

Text files by default; images route through an injectable `ReadImageProcessor`.

### `createWriteTool()`

```typescript
// model calls: { "path": "out/result.txt", "content": "…" }
```

### `createEditTool()`

```typescript
// model calls: { "path": "src/api.ts", "edits": [
//   { "oldText": "const port = 3000", "newText": "const port = 8080" } ] }
```

One or more targeted old/new text pairs per call, each matched against the original file (not incrementally); backed by `diff`. A legacy single-edit shape (`oldText`/`newText` at the top level) is normalized before execution.

## `ExecutionEnv` / `NodeExecutionEnv`

The policy seam the harness tools execute against: `{ cwd, shell, fs }` capabilities.

```typescript
import { NodeExecutionEnv } from "pico-agent";

const env = new NodeExecutionEnv({ cwd: process.cwd() });
```

`NodeExecutionEnv` is the only shipped implementation. The interface exists so hosts can substitute sandboxes, remote execution, or virtual filesystems without touching the tools. `harnessToolToAgentTool(tool, toolContext)` bridges the harness's wider `execute` (which receives `ExecutionToolContext`) to the core `AgentTool.execute`.
