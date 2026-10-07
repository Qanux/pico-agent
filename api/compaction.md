# Auto context compaction

`autoCompaction` summarizes older turns when the estimated context crosses a threshold, keeping recent turns verbatim. It is a pair of agent hooks — spread the result into `AgentOptions`:

```typescript
import { Agent, autoCompaction, createModels, deepseekProvider } from "pico-agent";

const models = createModels();
models.setProvider(deepseekProvider());
const model = models.getModel("deepseek", "deepseek-flash")!;

const agent = new Agent({
	initialState: { systemPrompt: "You are a coding assistant.", model, tools },
	streamFn: models.streamSimple.bind(models),
	...autoCompaction(models, { model, maxContextTokens: 131_072 }),
});
```

Tool-call/result pairs are never split (cutting happens right before an assistant message); file-shaped tool output is stubbed, not carried into summaries; summaries accumulate as a running prior. Compaction runs inside `transformContext` before each request, so a restored oversized session (see [session.md](session.md)) compacts on its first prompt automatically.

## `autoCompaction(models: Models, options?: AutoCompactionOptions): AutoCompactionHooks`

Returns `{ transformContext, prepareRequest }` — the two fields to spread into `AgentOptions`.

### Options

| Option | Default | Description |
|---|---|---|
| `model` | — | Fallback model before the first request; kept fresh afterwards, covering mid-session model swaps. |
| `maxContextTokens` | `131_072` | Context cap. |
| `threshold` | `0.75` | Fraction of the effective window that triggers compaction. |
| `keepRecentTurns` | `6` | Recent assistant turns (plus their tool results) kept verbatim. |
| `minCompactableRatio` | `0.15` | Skip compaction when the compactable span is below this fraction of the window — nothing to gain. |
| `maxSummaryTokens` | `4096` | Output cap for the summarization request. |
| `cooldownRequests` | `3` | Min requests between two summarize attempts. While counting down, above-threshold requests still see the last compacted view (summary + unsummarized tail), never the full history. |
| `onCompaction` | — | `(stats: CompactionStats) => void` — fires on every trigger attempt, including skips. |
| `summarize` | — | Custom summarizer: `(span, model, priorSummary?) => Promise<string>`. Receives only the messages summarized since the last compaction; returns the new full summary. |

### Observing compactions

```typescript
const hooks = autoCompaction(models, {
	model,
	onCompaction: (stats) => console.log("[compaction]", JSON.stringify(stats)),
});
```

`CompactionStats` reports the trigger decision, token counts before/after, and the summarized span size. `DEFAULT_MAX_CONTEXT_TOKENS` (131072) is exported for reuse.

### Custom summarizer (tests / pipelines)

```typescript
const hooks = autoCompaction(models, {
	model,
	summarize: async (span, model, priorSummary) =>
		[priorSummary ?? "(no prior summary)", `+${span.length} more messages`].join("\n"),
});
```
