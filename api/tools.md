# Tools

## `AgentTool` — the core interface

```typescript
import type { AgentTool } from "pico-agent";

interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	name: string;                        // what the model calls
	description: string;                 // what the model reads
	parameters: TSchema;                 // typebox schema for arguments
	label: string;                       // human-readable UI label
	prepareArguments?: (args: unknown) => Static<TParameters>;   // compat shim before validation
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	replay?: "never" | "safe";           // recovery policy for unknown-outcome effects
	toolExecution?: "sequential" | "parallel";   // per-tool concurrency override
}
```

Throw on failure — the loop converts throws into `isError` tool results. `onUpdate` streams partial results into `tool_execution_update` events.

### Custom tool example

```typescript
import { Type, type AgentTool } from "pico-agent";

const echo: AgentTool<any, any> = {
	name: "echo",
	label: "echo",
	description: "echoes the message back",
	parameters: Type.Object({ msg: Type.String() }),
	async execute(toolCallId, params, signal) {
		if (signal?.aborted) throw new Error("aborted");
		const { msg } = params as { msg: string };
		return { content: [{ type: "text", text: `echo:${msg}` }], details: {} };
	},
};
```

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
// model calls: { "path": "src/api.ts", "content": "…full new content…",
//                "edits": [{ "oldText": "v1", "newText": "v2" }] }
```

Structured edits (old/new text pairs) backed by `diff`; the accepted arguments are normalized before execution.

## `ExecutionEnv` / `NodeExecutionEnv`

The policy seam the harness tools execute against: `{ cwd, shell, fs }` capabilities.

```typescript
import { NodeExecutionEnv } from "pico-agent";

const env = new NodeExecutionEnv({ cwd: process.cwd() });
```

`NodeExecutionEnv` is the only shipped implementation. The interface exists so hosts can substitute sandboxes, remote execution, or virtual filesystems without touching the tools. `harnessToolToAgentTool(tool, toolContext)` bridges the harness's 6-arg `execute` (which receives `ExecutionToolContext`) to the core 4-arg `AgentTool.execute`.
