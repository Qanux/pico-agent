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

## 子代理（subagent）

`src/agent/harness/tools/subagent.ts`（pico-agent 原创代码，放在 vendored 工具目录里
便于发现）提供 `createSubagentTool()`：一个
`subagent` 工具，一次调用扇出多个并行子代理。每个子代理是一个全新的 `Agent`，
继承父代理**当前**工具集但剔除 subagent 工具本身（不可递归 spawn），且上下文为空——
只有子代理的最终消息（头部截断）会回到父代理，中间工具输出不进入父台账：

```typescript
const subagent = createSubagentTool({
	getTools: () => [bash, read, write, edit],   // 父代理当前工具；每次调用时解析
	createAgent: ({ tools, systemPrompt }) =>
		new Agent({ initialState: { systemPrompt, model, tools }, streamFn }),
	maxConcurrent: 4,        // 单次工具调用允许的子代理硬上限（默认 4）
	maxOutputChars: 20_000,  // 每个子代理最终消息的头部截断预算（默认 20k）
	maxTurns: 50,            // 每个子代理的轮次上限（默认 50，0 关闭）
	inactivityTimeoutMs: 300_000, // 不活跃看门狗（默认 5 分钟，0 关闭）
});
const agent = new Agent({ initialState: { systemPrompt, model, tools: [bash, read, write, edit, subagent] }, streamFn });
```

模型按每个子代理一条自包含 prompt 传入（schema 默认引导：2 条；用户显式要求更多时才
增加，受 `maxConcurrent` 硬上限约束）。子代理并发运行，工具调用阻塞到全部完成；父代理
的 abort 信号会级联中止所有子代理。结果合并为一个 tool result，附每个子代理的用量行
（token / 工具调用数 / 轮次 / 耗时）；失败或被中止的子代理以失败小节呈现，不会拖垮整次调用。
无密钥回归验证见 `examples/verify-subagent.ts`。

### 卡死子代理的守卫（双闸门）

两个互相独立的工厂级闸门约束"永远跑不完"的子代理：

- **`maxTurns`**（默认 50，0 关闭）：中止失控的工具马拉松。按已完成的助手轮次
  （`turn_end` 事件）计数，且只有当到达上限的那一轮仍带工具调用时才击杀——
  不带工具调用的一轮是子代理在自然收尾，永远不算违规。
- **`inactivityTimeoutMs`**（默认 300000，0 关闭）：中止"完全沉默"。看门狗在
  spawn 时上膛，任何子代理事件（模型增量、工具开始/更新/结束）都会重置时钟；
  挂死的 provider 调用或永不返回的工具会触发它，而"慢但在动"的子代理会不断
  重置时钟、永远不会被杀。

击杀路径（两个闸门相同）：子代理被 abort，其循环在任何后续工具动作之前结束，
`prompt()` 正常 resolve 而不是挂死。击杀原因会写进该子代理的 FAILED 小节标题；
上报的最终消息会跳过空的合成中止标记，回溯到子代理真实的最后一句话（遗言不丢）。
两个闸门都依赖协作式 abort——完全无视 abort 信号的宿主工具或流函数仍可能挂死
子代理，父代理运行自身的 abort 仍是最后手段。
`examples/verify-subagent.ts` 的场景 F/G/H 对两个闸门做无密钥回归。

## 与上游的关系

与上游 pi 的差异（删除了什么、哪些是原创代码、vendor 说明）统一见
[MODIFICATIONS.md](MODIFICATIONS.md)（全英文）。

## 目录结构

```
src/
├── index.ts              公共 API（本文件所述全部导出）
├── adapt.ts              harness 工具 → 核心 AgentTool 适配器
├── compaction.ts         autoCompaction()——自动上下文压缩（原创代码）
├── agent/                agent 核心（5 文件）+ harness 工具（含原创 subagent 工具）/env/utils
├── ai/                   pi-ai 切片（types/models/auth + 4 种适配器 + 18 个 provider）
└── support/              chord-context / telemetry / json-value 精简副本
examples/
├── verify-tools.ts       无 key 自检（write→read→edit→bash 走真实循环）
├── verify-compaction.ts  无 key 压缩回归（膨胀→触发→收缩→软顶不破）
├── verify-subagent.ts    无 key subagent 回归（扇出/继承/硬顶/截断/卡死守卫）
├── mini-agent.ts         真实模型单轮示例
└── multi-turn.ts         真实模型交互式多轮 REPL（上下文跨轮保留）
```
