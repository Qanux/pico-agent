# pico-agent

Read this in [English](README.md)

从 [earendil-works/pi](https://github.com/earendil-works/pi) 提取的最小 agent 运行时 SDK（源码级 vendor，MIT 协议，见 `LICENSE`）。

**零 `@earendil-works/*` npm 依赖。** 包含三部分：

| 部分 | 来源 | 内容 |
|------|------|------|
| `src/agent/` | `packages/agent/src` 核心层 | Agent 循环（`agent-loop.ts`）、`Agent` 类、类型 |
| `src/agent/harness/` | `packages/agent/src/harness` 工具子集 | bash / read / write / edit 四个工具 + `NodeExecutionEnv` |
| `src/ai/` | `packages/ai/src` 切片 | 类型、流式、models/auth + 18 个 provider（4 种协议适配器） |

## 支持的 provider（18 个）

| Provider | 工厂函数 | 环境变量 | 协议 |
|----------|---------|---------|------|
| Anthropic | `anthropicProvider()` | `ANTHROPIC_API_KEY` | anthropic-messages |
| OpenAI | `openaiProvider()` | `OPENAI_API_KEY` | openai-responses |
| Google Gemini | `googleProvider()` | `GEMINI_API_KEY` | google-generative-ai |
| xAI (Grok) | `xaiProvider()` | `XAI_API_KEY` | openai-responses |
| 智谱 GLM | `zaiProvider()` | `ZAI_API_KEY` | openai-completions |
| 智谱 GLM Coding CN | `zaiCodingCnProvider()` | `ZAI_CODING_CN_API_KEY` | openai-completions |
| MiniMax | `minimaxProvider()` | `MINIMAX_API_KEY` | anthropic-messages |
| MiniMax CN | `minimaxCnProvider()` | `MINIMAX_CN_API_KEY` | anthropic-messages |
| 月之暗面 Kimi | `moonshotaiProvider()` | `MOONSHOT_API_KEY` | openai-completions |
| 月之暗面 Kimi CN | `moonshotaiCnProvider()` | `MOONSHOT_API_KEY` | openai-completions |
| 小米 MiMo | `xiaomiProvider()` | `XIAOMI_API_KEY` | openai-completions |
| MiMo Token Plan CN/SGP/AMS | `xiaomiTokenPlanCn/Sgp/AmsProvider()` | `XIAOMI_TOKEN_PLAN_CN_API_KEY` 等 | openai-completions |
| 通义 Qwen Token Plan | `qwenTokenPlanProvider()` | `QWEN_TOKEN_PLAN_API_KEY` | openai-completions |
| Qwen Token Plan CN | `qwenTokenPlanCnProvider()` | `QWEN_TOKEN_PLAN_CN_API_KEY` | openai-completions |
| Qwen Token Plan 个人版 | `qwenTokenPlanIndividualProvider()` | `QWEN_TOKEN_PLAN_API_KEY` | openai-completions |
| DeepSeek | `deepseekProvider()` | `DEEPSEEK_API_KEY` | openai-completions |

注意：xAI 的 OAuth 登录流未搬入（API key 方式可用）；模型目录是提取时的快照。

支撑模块（`src/support/`）是 chord Context（121 行）和 pi-telemetry 契约（约 50 行）的精简内置副本。

## 快速开始

Node >= 22.19（`.ts` 原生直接运行，无需编译）：

```bash
npm install
npm run verify            # 无需 API key 的端到端自检（工具 + 压缩，脚本化模型驱动真实循环）
npm run verify:providers  # 18 个 provider 的目录/适配器冒烟测试（无需 key）
npm run demo              # 真实模型示例
```

## 用法

```typescript
import {
	Agent,
	harnessToolToAgentTool,
	createModels,
	anthropicProvider,
	createBashTool,
	createReadTool,
	createWriteTool,
	createEditTool,
	NodeExecutionEnv,
} from "./src/index.ts";

// 1. 模型（API key 从 ANTHROPIC_API_KEY 环境变量读取）
const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");

// 2. 工具：harness 工具 + 执行环境 → 核心 AgentTool
const env = new NodeExecutionEnv({ cwd: process.cwd() });
const toolContext = { env };

// 3. Agent：一次 prompt() 自动完成 LLM → 工具 → LLM 循环
const agent = new Agent({
	initialState: {
		systemPrompt: "You are a coding assistant.",
		model,
		tools: [
			harnessToolToAgentTool(createReadTool(), toolContext),
			harnessToolToAgentTool(createWriteTool(), toolContext),
			harnessToolToAgentTool(createEditTool(), toolContext),
			harnessToolToAgentTool(createBashTool(), toolContext),
		],
	},
	streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
	if (event.type === "tool_execution_start") console.log(`\n[tool] ${event.toolName}`);
});

await agent.prompt("看看这个目录里有什么");
```

自定义工具不需要适配器，直接写普通对象（满足 `AgentTool` 接口即可）：

```typescript
const myTool = {
	name: "list_files",
	label: "list_files",
	description: "List files in a directory",
	parameters: Type.Object({ path: Type.Optional(Type.String()) }),
	async execute(_id, { path = "." }) {
		const entries = await readdir(path, { withFileTypes: true });
		return { content: [{ type: "text", text: entries.map((e) => e.name).join("\n") }], details: {} };
	},
};
```

## 自适应接缝（都在 `AgentLoopConfig`）

- `transformContext` — 每次 LLM 调用前变换上下文（裁剪历史、注入 RAG）
- `prepareRequest` / `prepareNextTurn` — 每轮换模型 / 思考等级
- `beforeToolCall`（可拦截）/ `afterToolCall`（可改写结果）
- `finishTurn` — 返回 `{ action: "continue" | "end" }` 控制循环寿命
- `agent.steer()` / `agent.followUp()` — 运行中插话 / 停止后追加
- `agent.state.tools = [...]` — 随时换工具集（循环自动声明增量）

## 自动上下文压缩

`src/compaction.ts`（pico-agent 原创代码）提供 `autoCompaction()`：与 `streamFn` 并列展开
其钩子后，每次 LLM 调用前自动压缩上下文——覆盖单次 `prompt()` 内的工具马拉松、多轮长会话、
运行中换模型三个场景：

```typescript
const agent = new Agent({
	initialState: { systemPrompt, model, tools },
	streamFn: models.streamSimple.bind(models),
	...autoCompaction(models, {
		model,                       // 之后由 prepareRequest 持续刷新
		maxContextTokens: 200_000,   // 可选；默认 131_072（128K）
		threshold: 0.75,             // 达到有效窗口的比例阈值
		keepRecentTurns: 6,          // 最近 6 个 assistant 轮次原文保留
		onCompaction: (s) => console.log(`[compact] ${s.before} -> ${s.after}`),
	}),
});
```

有效窗口 = `min(maxContextTokens ?? 131_072, model.contextWindow ?? 131_072)`——默认上限
128K，大窗口模型请显式调高 `maxContextTokens`。切割点总在 assistant 消息紧前，
toolCall/toolResult 对绝不会被拆散。压缩是**请求级**的：持久台账
（`agent.state.messages`）保留完整记录、永不改写——一旦产生过摘要，之后每个请求
携带的都是派生视图（前导 system 消息 + 摘要 + 保留尾部），绝不回退为裸历史，
因此即使冷却期推迟了下一次折入，请求也始终在窗口内。摘要是增量的
（滚动摘要 + 只处理新增材料），并跨压缩维护读/写/改文件清单；若保留尾部自身
仍超过窗口一半，会硬省略较旧的工具输出作为最后的安全网。

## 与上游的关系

- 提取自 pi v0.87.1 源码；上游更新不会自动到达
- 每个 vendored 文件的头部注释都带有指向 v0.87.1 上游原始路径的链接——同步时可据此逐文件 diff
- 删掉的部分：其余 23 个 provider、6 个协议适配器（bedrock/azure/mistral/codex/pi-messages/vertex）、harness 会话/压缩/技能层、coding-agent 产品层（8 个产品工具、扩展系统、TUI、会话持久化）
- `src/ai/providers/data/*.json` 是生成物（上游 `generate:models` 产出），模型列表过时可重新生成或手改
- 外部依赖 8 个：`typebox`、`diff`、`@anthropic-ai/sdk`、`openai`、`@google/genai`、`partial-json`、`http-proxy-agent`、`https-proxy-agent`

## 相对上游 pi 的修改

`src/agent/` 与 `src/ai/` 下的所有文件均为 v0.87.1 逐字 vendor（仅多了出处头注释）。
以下为 pico-agent 原创代码，上游不存在：

| 路径 | 内容 |
|------|------|
| `src/adapt.ts` | `harnessToolToAgentTool()`——把 harness 工具（6 参 `execute`）桥接到核心 4 参 `AgentTool` 接口 |
| `src/compaction.ts` | `autoCompaction()`——基于 `transformContext` + `prepareRequest` 的自动上下文压缩（见上节）。上游的压缩在 harness 会话层内实现，而该层不在本提取范围内 |
| `src/index.ts` | 公共 API 组装 |
| `src/ai/index.ts` | 重写的最小 barrel（上游的重导出会拖入被排除的适配器） |
| `src/support/` | 精简副本：chord `Context`（`ContextKey` 从 chord types 内联）、`TelemetryContext` 契约、`JsonValue` |

示例层面的增补：`mini-agent.ts`（DeepSeek + 思考 + 压缩）、`multi-turn.ts`（交互式
REPL）、`verify-compaction.ts`（无 key 压缩回归）。

## 目录结构

```
src/
├── index.ts              公共 API（本文件所述全部导出）
├── adapt.ts              harness 工具 → 核心 AgentTool 适配器
├── compaction.ts         autoCompaction()——自动上下文压缩（原创代码）
├── agent/                agent 核心（5 文件）+ harness 工具/env/utils
├── ai/                   pi-ai 切片（types/models/auth + 4 种适配器 + 18 个 provider）
└── support/              chord-context / telemetry / json-value 精简副本
examples/
├── verify-tools.ts       无 key 自检（write→read→edit→bash 走真实循环）
├── verify-compaction.ts  无 key 压缩回归（膨胀→触发→收缩→软顶不破）
├── mini-agent.ts         真实模型单轮示例
└── multi-turn.ts         真实模型交互式多轮 REPL（上下文跨轮保留）
```
