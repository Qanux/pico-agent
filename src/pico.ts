// pico-agent public API.
//
// Same surface as the predecessor's extraction of pi v0.87.1, with the LLM
// substrate swapped for LangChain:
// - agent core: the prompt → LLM → tool → loop engine (pi's loop, verbatim)
// - harness tools: bash / read / write / edit built on ExecutionEnv
// - LangChain model layer: AgentModel + the StreamFn bridge replacing pi-ai's
//   provider catalog (18 providers over 4 adapters there; any
//   @langchain/* chat model here)
//
// pico's src/index.ts also exported PrepareNextTurnResult /
// PrepareRequestResult / TransformContext / snapshotMessages — symbols that no
// longer exist in its own modules (a stale index); they are intentionally not
// reproduced.

// ---- agent core ----
export type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentRequestUpdate,
	AgentState,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentToolUpdateCallback,
	AgentTurnContext,
	AgentTurnDecision,
	BeforeToolCallContext,
	BeforeToolCallResult,
	FinishTurn,
	PrepareNextTurnContext,
	PrepareRequest,
	PrepareRequestContext,
	QueueMode,
	StreamFn,
	ThinkingLevel,
	ToolExecutionMode,
} from "./agent/types.ts";
export { Agent, type AgentInitialState, type AgentOptions } from "./agent/agent.ts";
export {
	agentLoop,
	agentLoopContinue,
	runAgentLoop,
	runAgentLoopContinue,
	type AgentEventSink,
} from "./agent/agent-loop.ts";
export { getDefaultStreamFn, setDefaultStreamFn } from "./agent/stream-fn.ts";
export { streamProxy, type ProxyAssistantMessageEvent, type ProxyStreamOptions } from "./agent/proxy.ts";

// ---- LangChain model layer (replaces the pi-ai provider catalog) ----
export {
	type AgentModel,
	type AnthropicModelOptions,
	assistantToChunk,
	createAnthropicModel,
	createGoogleModel,
	type GoogleModelOptions,
	type OpenAIModelOptions,
	createOpenAIModel,
	createOpenAIResponsesModel,
	type ScriptedModelOptions,
	createScriptedModel,
	createUnavailableModel,
} from "./ai/models.ts";
export {
	createModelStreamFn,
	transcriptToLangChainMessages,
	type StreamFnOptions,
} from "./ai/langchain-stream.ts";
export { transformMessages } from "./ai/transform-messages.ts";
export {
	clampMaxTokensToContext,
	clampReasoning,
	clampThinkingBudgetToAnswerRoom,
	DEFAULT_THINKING_BUDGETS,
	adjustMaxTokensForThinking,
	type ThinkingBudgets,
	thinkingBudgetForLevel,
	MIN_ANSWER_TOKENS,
} from "./ai/simple-options.ts";

// ---- ai slice: message model, events, tokens, validation ----
export type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	ModelThinkingLevel,
	StopReason,
	SystemMessage,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
	ConstrainedSamplingConfig,
	GrammarFormat,
	GrammarVariants,
	ToolReference,
	ToolResultMessage,
	TranscriptContext,
	Usage,
	UserMessage,
} from "./ai/types.ts";
export { type ContextUsageEstimate, calculateContextTokens, estimateContextTokens, estimateMessageTokens } from "./ai/estimate.ts";
export {
	EventStream,
	AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "./ai/event-stream.ts";
export { contentText, getSystemMessageText, renderSystemMessageUpdate } from "./ai/text.ts";
export { parseStreamingJson, parseJsonWithRepair, repairJson } from "./ai/json-parse.ts";
export {
	collapseSystemMessages,
	createInitialSystemMessage,
	declarationsEqual,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getDeclaredTools,
	getInitialSystemMessage,
	getToolStateChanges,
	normalizeContext,
	toToolDeclaration,
	toolJsonSchema,
	type ToolStateChanges,
	type TranscriptMessages,
} from "./ai/transcript.ts";
export { validateToolArguments, validateToolCall } from "./ai/validation.ts";

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
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	AgentHarnessTool,
	AgentHarnessToolContextSource,
	AgentHarnessToolInvocation,
	AgentHarnessToolUpdateCallback,
	AgentHarnessToolUpdateOptions,
	ExecutionEnv,
	ExecutionError,
	FileError,
	FileInfo,
	FileKind,
	FileErrorCode,
	PromptTemplate,
	Result,
	Shell,
	ShellExecOptions,
	ShellExecResult,
	ShellOutputCaptureOptions,
	ShellOutputLimits,
	ShellOutputMetadata,
	ShellOutputRetention,
	ShellOutputTruncation,
	ShellOutputUpdate,
	ShellOutputView,
	Skill,
	TextLine,
	TextLineReader,
} from "./agent/harness/types.ts";
export { NodeExecutionEnv } from "./agent/harness/env/nodejs.ts";
export { err, getOrThrow, getOrUndefined, ok, toError, CompactionError, BranchSummaryError } from "./agent/harness/types.ts";

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
export { getTelemetryContext, withTelemetryContext } from "./agent/harness/context.ts";
export type { TelemetryContext, TelemetrySpan } from "./support/telemetry.ts";

// ---- automatic context compaction ----
export {
	autoCompaction,
	DEFAULT_MAX_CONTEXT_TOKENS,
	type AutoCompactionHooks,
	type AutoCompactionOptions,
	type CompactionStats,
} from "./compaction.ts";

// ---- parallel subagent fan-out tool ----
export {
	createSubagentTool,
	DEFAULT_SUBAGENT_SYSTEM_PROMPT,
	type SubagentAgentFactory,
	type SubagentChildInfo,
	type SubagentRunDetails,
	type SubagentToolInput,
	type SubagentToolOptions,
} from "./agent/harness/tools/subagent.ts";

// ---- self-managed todo list tool ----
export {
	createTodoTool,
	readTodoState,
	TODO_TOOL_GUIDANCE,
	type TodoAction,
	type TodoDetails,
	type TodoItem,
	type TodoState,
	type TodoStatus,
	type TodoToolInput,
	type TodoToolOptions,
} from "./agent/harness/tools/todo.ts";

// ---- session persistence ----
export {
	createSessionStore,
	restoreAgent,
	serializeSession,
	SessionError,
	SNAPSHOT_VERSION,
	type AgentInit,
	type SessionErrorCode,
	type SessionRef,
	type SessionSnapshot,
	type SessionStats,
	type SessionStore,
	type SessionStoreOptions,
} from "./session.ts";

// ---- harness utils ----
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateTail,
	utf8ByteLength,
	formatSize,
	truncateLine,
} from "./agent/harness/utils/truncate.ts";
export {
	applyShellOutputUpdate,
	OUTPUT_MIN_EMIT_INTERVAL_MS,
	OUTPUT_TARGET_BYTES_PER_SECOND,
	OutputCapture,
	sanitizeShellOutput,
} from "./agent/harness/utils/output-capture.ts";
export { AdaptivePublisher } from "./agent/harness/utils/adaptive-publisher.ts";
export { resolveToolPath, resolveReadToolPath } from "./agent/harness/tools/path-utils.ts";
