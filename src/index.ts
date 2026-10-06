// Original to the pico-agent extraction of earendil-works/pi v0.87.1 — assembled, not a verbatim upstream file
// https://github.com/earendil-works/pi/blob/v0.87.1/undefined

/**
 * pico-agent public API.
 *
 * Minimal standalone extraction of the pi agent runtime (MIT, earendil-works/pi):
 * - agent core: the prompt → LLM → tool → loop engine
 * - harness tools: bash / read / write / edit built on ExecutionEnv
 * - pi-ai slice: core types, streaming, models/auth + 18 providers over 4 adapters
 *
 * No @earendil-works/* npm dependencies.
 */

// ---- agent core ----
export type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentToolUpdateCallback,
	BeforeToolCallContext,
	BeforeToolCallResult,
	FinishTurn,
	PrepareNextTurnContext,
	PrepareNextTurnResult,
	PrepareRequest,
	PrepareRequestResult,
	QueueMode,
	StreamFn,
	ThinkingLevel,
	TransformContext,
} from "./agent/types.ts";
export { Agent } from "./agent/agent.ts";
export {
	agentLoop,
	agentLoopContinue,
	runAgentLoop,
	runAgentLoopContinue,
} from "./agent/agent-loop.ts";
export { getDefaultStreamFn, setDefaultStreamFn } from "./agent/stream-fn.ts";
export { streamProxy } from "./agent/proxy.ts";

// ---- harness built-in tools (bash/read/write/edit) ----
export {
	type BashExecution,
	type BashPrepare,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
} from "./agent/harness/tools/bash.ts";
export {
	createEditTool,
	type EditToolDetails,
	type EditToolInput,
} from "./agent/harness/tools/edit.ts";
export {
	createReadTool,
	type ReadImageProcessor,
	type ReadImageProcessorResult,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./agent/harness/tools/read.ts";
export type { ExecutionToolContext } from "./agent/harness/tools/tool-context.ts";
export { createWriteTool, type WriteToolInput } from "./agent/harness/tools/write.ts";
export type {
	AgentHarnessTool,
	AgentHarnessToolInvocation,
	ExecutionEnv,
	FileError,
	ExecutionError,
	Result,
	ShellOutputTruncation,
	ShellOutputView,
} from "./agent/harness/types.ts";
export { NodeExecutionEnv } from "./agent/harness/env/nodejs.ts";

// ---- harness → core adapter ----
export { harnessToolToAgentTool } from "./adapt.ts";

// ---- context primitives (vendored chord subset) ----
export {
	BACKGROUND_CONTEXT,
	awaitWithContext,
	createContextKey,
	TODO_CONTEXT,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
} from "./support/chord-context.ts";
export type { Context, ContextKey } from "./support/chord-context.ts";

// ---- pi-ai slice (types, streaming, models, auth, providers) ----
export * from "./ai/index.ts";
export { anthropicProvider } from "./ai/providers/anthropic.ts";
export { openaiProvider } from "./ai/providers/openai.ts";
export { googleProvider } from "./ai/providers/google.ts";
export { xaiProvider } from "./ai/providers/xai.ts";
export { zaiProvider } from "./ai/providers/zai.ts";
export { zaiCodingCnProvider } from "./ai/providers/zai-coding-cn.ts";
export { minimaxProvider } from "./ai/providers/minimax.ts";
export { minimaxCnProvider } from "./ai/providers/minimax-cn.ts";
export { moonshotaiProvider } from "./ai/providers/moonshotai.ts";
export { moonshotaiCnProvider } from "./ai/providers/moonshotai-cn.ts";
export { xiaomiProvider } from "./ai/providers/xiaomi.ts";
export { xiaomiTokenPlanCnProvider } from "./ai/providers/xiaomi-token-plan-cn.ts";
export { xiaomiTokenPlanSgpProvider } from "./ai/providers/xiaomi-token-plan-sgp.ts";
export { xiaomiTokenPlanAmsProvider } from "./ai/providers/xiaomi-token-plan-ams.ts";
export { qwenTokenPlanProvider } from "./ai/providers/qwen-token-plan.ts";
export { qwenTokenPlanCnProvider } from "./ai/providers/qwen-token-plan-cn.ts";
export { qwenTokenPlanIndividualProvider } from "./ai/providers/qwen-token-plan-individual.ts";
export { deepseekProvider } from "./ai/providers/deepseek.ts";

// ---- pico-agent addition: automatic context compaction ----
export {
	autoCompaction,
	DEFAULT_MAX_CONTEXT_TOKENS,
	type AutoCompactionHooks,
	type AutoCompactionOptions,
	type CompactionStats,
} from "./compaction.ts";

// ---- pico-agent addition: parallel subagent fan-out tool ----
export {
	createSubagentTool,
	DEFAULT_SUBAGENT_SYSTEM_PROMPT,
	type SubagentAgentFactory,
	type SubagentRunDetails,
	type SubagentToolInput,
	type SubagentToolOptions,
} from "./agent/harness/tools/subagent.ts";
