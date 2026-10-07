# Modifications vs upstream pi

pico-agent is a source-level extraction of [earendil-works/pi](https://github.com/earendil-works/pi)
v0.87.1 (MIT). This file is the canonical list of what was removed, what is original
pico-agent code, and vendoring notes. The READMEs describe what the SDK is and how to
use it; provenance lives here.

## Extraction and provenance

- Extracted from pi v0.87.1 source; upstream updates do not flow in automatically
- Every vendored file carries a header comment linking to its exact upstream path at
  v0.87.1 — diff against it when syncing
- `src/ai/providers/data/*.json` are generated artifacts (from upstream `generate:models`);
  regenerate or hand-edit if the model lists go stale

## Removed from upstream

- The other 23 providers and 6 protocol adapters (bedrock / azure / mistral / codex /
  pi-messages / vertex); 18 providers across 4 adapters remain
- The harness session, compaction, and skills layers
- The coding-agent product layer: 8 product tools, extension system, TUI, session persistence
- The xAI OAuth login flow (API key auth works); model catalogs are a snapshot from
  extraction time

## Original pico-agent code (not present upstream)

Everything under `src/agent/` and `src/ai/` is vendored verbatim from v0.87.1 (modulo the
provenance headers), with one exception: `src/agent/harness/tools/subagent.ts` is original
pico-agent code placed among the tools for discoverability. Original to pico-agent:

| Path | What it is |
|------|-----------|
| `src/adapt.ts` | `harnessToolToAgentTool()` — bridges harness tools (6-arg `execute`) to the core 4-arg `AgentTool` interface |
| `src/compaction.ts` | `autoCompaction()` — automatic context compaction via `transformContext` + `prepareRequest` (see the README section "Auto context compaction"). Upstream ships compaction inside the harness session layer, which this extraction excludes |
| `src/agent/harness/tools/subagent.ts` | `createSubagentTool()` — a `subagent` tool that fans out to parallel child agents with the parent's tools minus itself; children run in fresh contexts and only their head-truncated final messages flow back (see the README section "Subagents"). The child context window is whatever the host's `createAgent` wires — typically the parent's compaction settings; the tool sets no window of its own. Includes two stuck-child guards: `maxTurns` (default 50, kills runaway tool marathons — only a capped turn that still issues tool counts as a violation) and `inactivityTimeoutMs` (default 5 min, kills total silence — any child event resets the clock); both kill via `child.abort()`, the kill reason labels the child's FAILED section, and the reported final message skips the empty synthetic abort marker and returns the child's last real words |
| `src/session.ts` | `createSessionStore()` / `serializeSession()` / `restoreAgent()` — session persistence: save an agent's transcript as an immutable snapshot file (`<YYYYMMDD-HHmmss>-<slug>.json`, atomic write, `-2` suffix on same-second collisions) and revive it in any later process; `save()` returns a small serializable `SessionRef`, `list()`/`latest()` index by filename, `delete`/`clear` are the garbage collectors. Unpaired tool calls in a mid-turn save are repaired at save time with synthetic error tool results, so every snapshot loads as a valid request. Model resolution at restore: `init.model` > `init.resolveModel` > the bundled provider catalogs > `SessionError("model_unresolved")`; tampered refs (non-bare `file`) are rejected before any filesystem access. README section "Session persistence" |
| `src/index.ts` | Public API assembly |
| `src/ai/index.ts` | Rewritten minimal barrel (upstream's re-exports pull in excluded adapters) |
| `src/support/` | Slim copies: chord `Context` (with `ContextKey` inlined from chord types), the `TelemetryContext` contract, `JsonValue` |

## Example-level additions

- `mini-agent.ts` — real-model one-shot example (DeepSeek + thinking + compaction)
- `multi-turn.ts` — real-model interactive REPL (multi-turn with retained context)
- `verify-compaction.ts` — keyless compaction regression (bloat → trigger → shrink → cap holds)
- `verify-subagent.ts` — keyless subagent regression (fan-out of 2, tool inheritance minus the subagent tool, concurrency ordering, parent waits for all children, result merging, output truncation, single-prompt call, hard-cap rejection, factory-crash resilience, surrogate-safe truncation, and the stuck-child guards: maxTurns kill on a looping child with no kill on a natural finish at the cap, inactivity kill on a hung tool and on a silent first request)
- `verify-session.ts` — keyless session persistence regression (save/restore roundtrip with the saved history visible in the restored agent's next request, dangling-toolCall repair at save time, model resolution chain incl. `model_unresolved` and the builtin catalog, ref loop with filename-derived `list()`/`latest()` and same-second `-2` suffixes, bad-file tolerance (`bad_version`/`corrupt`), stats, delete semantics with `ignoreMissing`, and the traversal-ref escape guard plus `clear()` staying inside its directory)

## External dependencies (8)

`typebox`, `diff`, `@anthropic-ai/sdk`, `openai`, `@google/genai`, `partial-json`,
`http-proxy-agent`, `https-proxy-agent`
