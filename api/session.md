# Session persistence

Save an agent's transcript as an immutable snapshot file; revive it in any later process. Three types and one facade: `SessionSnapshot` (pure-data restorable state), `SessionRef` (a small serializable key returned by `save`), `SessionStore` (a stateless facade over one directory).

## Lifecycle

```typescript
// ---- process 1: run, then save ----
import { Agent, createSessionStore } from "pico-agent";

const agent = new Agent({ initialState: { systemPrompt, model, tools }, streamFn });
await agent.prompt("start the audit");

const store = createSessionStore();                       // default dir: <cwd>/.pico/sessions
const ref = await store.save(agent, { label: "audit" });  // JSON file, atomic write, never overwrites
// Persist `ref` anywhere — a database, a queue message, a config file. It is pure JSON.

// ---- process 2 (any time later): restore, continue ----
const store2 = createSessionStore();                      // same default dir
const agent2 = await store2.restore(ref, {                // or restore("<path>.json", ...)
	tools,                                                 // runtime objects are never persisted
	streamFn,                                              // the host rewires them
	// model,        // optional: override the snapshot's model id
	// resolveModel, // optional: custom resolution for it
});
await agent2.prompt("continue where we left off");
```

The snapshot's transcript **is** `agent.state.messages` verbatim (including the leading system message that carries the system prompt and tool declarations). Restore is zero conversion: `initialState.messages = snapshot.messages`.

## `SessionStore` methods

```typescript
const store = createSessionStore({ dir: "/data/sessions" });   // default: <cwd>/.pico/sessions
```

| Method | Description |
|---|---|
| `save(agent, { label?, path? })` | Serialize + write. Filename `<YYYYMMDD-HHmmss>-<slug>.json` (slug from label: lowercase `[a-z0-9-]`, ≤40 chars; a label that slugs to nothing — e.g. non-Latin scripts — falls back to the bare stamp, the label itself stays inside the JSON). Same-second collisions get `-2`, `-3`, …; snapshots are immutable, `save` never overwrites. Explicit `path` writes exactly that file (must not exist) and bypasses the directory convention. Atomic via `.tmp` + rename. |
| `load(refOrPath)` | Read + validate one snapshot. A `SessionRef` resolves by bare filename inside `store.dir`; a string with a path separator is an explicit path; a bare string resolves in `store.dir`. |
| `restore(refOrPath, init)` | `load` + `restoreAgent`. |
| `list({ withStats? })` | All snapshots, newest first. Default reads filenames only (time and label parse from the name); `withStats: true` parses files for stats. |
| `latest()` | The newest snapshot; throws `not_found` on an empty store — the `--continue` UX. |
| `delete(refOrPath, { ignoreMissing? })` | Remove one file (plus its exact-basename `.details.json` sidecar). Throws `not_found` by default; `ignoreMissing: true` is idempotent for cleanup scripts. Returns the ref it deleted. |
| `clear()` | Delete every first-level `*.json` / `*.tmp` in the dir (also sweeps stale atomic-write leftovers); returns the session count. |

### `list` / `latest` / `delete` / `clear`

```typescript
const newest = await store.latest();
console.log(newest.id, newest.savedAt, newest.label);

for (const ref of await store.list()) {
	if (ref.label === "scratch") await store.delete(ref, { ignoreMissing: true });
}

// Keep only the 5 newest (prune policy is three lines, not an API):
const all = await store.list();
for (const ref of all.slice(5)) await store.delete(ref, { ignoreMissing: true });
```

## Pure layer (no filesystem)

Hosts that persist snapshots themselves (own database, object storage) skip the store entirely:

```typescript
import { serializeSession, restoreAgent } from "pico-agent";

const snapshot = serializeSession(agent, { label: "audit" });
// ...host stores JSON.stringify(snapshot) anywhere...
const revived = restoreAgent(JSON.parse(text) as typeof snapshot, { tools, streamFn });
```

`serializeSession` repairs interrupted runs at save time: every unpaired toolCall gets a synthetic error toolResult ("session saved mid-turn: this tool call was interrupted and was not executed") placed right after its assistant message — so every snapshot on disk loads as a valid provider request, and repeated serialization of the same state is byte-identical.

## `AgentInit` — what restore rewires

`Omit<AgentOptions, "initialState" | "streamFn">` plus:

```typescript
const agent2 = restoreAgent(snapshot, {
	tools,          // required — AgentTool[]
	streamFn,       // required — the provider request function
	model,          // optional — overrides snapshot.model (highest priority)
	resolveModel,   // optional — (id: string) => Model<any> | undefined
	thinkingLevel,  // optional — overrides snapshot.thinkingLevel
	// every other AgentOption passes through untouched (compaction, hooks, ...)
});
```

No `systemPrompt`: it is encoded in the transcript's leading system message; passing it again would seed a duplicate.

Model resolution chain: `init.model` → `init.resolveModel(snapshot.model)` → the bundled provider catalogs → `SessionError("model_unresolved")`.

## Errors — `SessionError extends Error { code }`

```typescript
import { SessionError } from "pico-agent";

try {
	await store.restore(ref, init);
} catch (error) {
	if (!(error instanceof SessionError)) throw error;
	switch (error.code) {
		case "not_found":        // file/directory absent
		case "bad_version":      // snapshot written by a newer pico-agent — upgrade
		case "corrupt":          // invalid JSON / wrong shape / tampered ref.file
		case "model_unresolved": // model id resolved to nothing; pass init.model
	}
}
```

A tampered `SessionRef.file` (any `/`, `\`, or `..`) is rejected with `corrupt` **before** any filesystem access — a poisoned ref cannot make `load`/`delete` touch files outside the store directory.

## Snapshot shape (version 1)

```jsonc
{
	"version": 1,
	"id": "20261007-143012-audit",
	"label": "audit",
	"savedAt": "2026-10-07T14:30:12.345Z",
	"model": "claude-sonnet-4-5",       // id only; re-resolved at restore
	"thinkingLevel": "high",
	"parentId": null,                    // reserved for forks; always null in v1
	"stats": { "messages": 42, "toolCalls": 17, "approxTokens": 31000 },
	"messages": [ /* agent.state.messages verbatim */ ]
}
```

Unknown fields are ignored on load (old archives keep working). `SNAPSHOT_VERSION` is exported.

**Security**: transcripts contain everything tools read — possibly secrets. `.gitignore` the default directory (`.pico/sessions/`), sanitize before distributing snapshots, and encrypt the JSON yourself when needed (it is plain data).
