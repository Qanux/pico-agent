// Original to the pico-agent extraction of earendil-works/pi v0.87.1 — new module, not vendored

/**
 * Session persistence: save an Agent's transcript as an immutable snapshot
 * file, then load or restore it in any later process.
 *
 * Three types and one facade:
 * - {@link SessionSnapshot}: pure-data, fully restorable state (JSON).
 * - {@link SessionRef}: a small serializable key returned by `save()`; hosts
 *   may persist it anywhere. Files are only the default backend.
 * - {@link SessionStore} ({@link createSessionStore}): a stateless facade over
 *   one directory — save / load / restore / list / latest / delete / clear.
 *
 * Snapshots are immutable: `save()` never overwrites. The filename is the
 * index (`<YYYYMMDD-HHmmss>-<slug>.json`); `ref.file` is always a bare file
 * name resolved against the store directory.
 */

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Agent, type AgentOptions } from "./agent/agent.ts";
import type { AgentMessage, AgentTool, StreamFn, ThinkingLevel } from "./agent/types.ts";
import { createModels, type Message, type Model, type MutableModels } from "./ai/index.ts";
import { estimateContextTokens } from "./ai/utils/estimate.ts";
import { anthropicProvider } from "./ai/providers/anthropic.ts";
import { openaiProvider } from "./ai/providers/openai.ts";
import { googleProvider } from "./ai/providers/google.ts";
import { xaiProvider } from "./ai/providers/xai.ts";
import { zaiProvider } from "./ai/providers/zai.ts";
import { zaiCodingCnProvider } from "./ai/providers/zai-coding-cn.ts";
import { minimaxProvider } from "./ai/providers/minimax.ts";
import { minimaxCnProvider } from "./ai/providers/minimax-cn.ts";
import { moonshotaiProvider } from "./ai/providers/moonshotai.ts";
import { moonshotaiCnProvider } from "./ai/providers/moonshotai-cn.ts";
import { xiaomiProvider } from "./ai/providers/xiaomi.ts";
import { xiaomiTokenPlanCnProvider } from "./ai/providers/xiaomi-token-plan-cn.ts";
import { xiaomiTokenPlanSgpProvider } from "./ai/providers/xiaomi-token-plan-sgp.ts";
import { xiaomiTokenPlanAmsProvider } from "./ai/providers/xiaomi-token-plan-ams.ts";
import { qwenTokenPlanProvider } from "./ai/providers/qwen-token-plan.ts";
import { qwenTokenPlanCnProvider } from "./ai/providers/qwen-token-plan-cn.ts";
import { qwenTokenPlanIndividualProvider } from "./ai/providers/qwen-token-plan-individual.ts";
import { deepseekProvider } from "./ai/providers/deepseek.ts";

export const SNAPSHOT_VERSION = 1;

/** Message and tool-call counts plus a context-size estimate for "does it fit model X" checks. */
export interface SessionStats {
	messages: number;
	toolCalls: number;
	approxTokens: number;
}

/**
 * Round-trip key returned by `save()`: small, pure JSON, persistable anywhere.
 * `file` is always a bare file name resolved against the store directory that
 * produced it.
 */
export interface SessionRef {
	id: string;
	label?: string;
	savedAt: string;
	file: string;
	stats?: SessionStats;
}

/** Fully restorable session state. Unknown fields are ignored, not rejected. */
export interface SessionSnapshot {
	version: typeof SNAPSHOT_VERSION;
	id: string;
	label?: string;
	savedAt: string;
	/** Model id only; re-resolved at restore (see {@link AgentInit}). */
	model: string;
	thinkingLevel: ThinkingLevel;
	/** Reserved for fork lineage; always null in v1. */
	parentId: string | null;
	stats: SessionStats;
	/**
	 * `agent.state.messages` verbatim, including the leading system message
	 * that carries the system prompt and tool declarations, and any synthetic
	 * tool results added for interrupted tool calls (see module docs).
	 */
	messages: AgentMessage[];
}

export type SessionErrorCode = "not_found" | "bad_version" | "corrupt" | "model_unresolved";

export class SessionError extends Error {
	public readonly code: SessionErrorCode;
	constructor(code: SessionErrorCode, message: string) {
		super(message);
		this.name = "SessionError";
		this.code = code;
	}
}

/**
 * What {@link restoreAgent} reconnects to the revived transcript. The snapshot
 * stores no runtime objects — tools, streaming, and hooks are the host's to
 * rewire. `systemPrompt` is intentionally absent: it is encoded in the
 * transcript's leading system message, and passing it again would seed a
 * duplicate.
 */
export type AgentInit = Omit<AgentOptions, "initialState" | "streamFn"> & {
	tools: AgentTool<any>[];
	streamFn: StreamFn;
	/** Overrides the snapshot's model id. Highest priority. */
	model?: Model<any>;
	/** Custom resolution for the snapshot's model id. */
	resolveModel?: (modelId: string) => Model<any> | undefined;
	/** Overrides the snapshot's thinkingLevel. */
	thinkingLevel?: ThinkingLevel;
};

export interface SessionStoreOptions {
	/** Directory for snapshot files. Default: `<cwd>/.pico/sessions`. */
	dir?: string;
}

export interface SessionStore {
	/** Directory this store manages. */
	readonly dir: string;
	/**
	 * Serialize `agent` and write it as a new immutable snapshot file. Never
	 * overwrites: same-second saves of the same agent get a `-2` filename
	 * suffix. With `path`, writes that exact file instead (must not already
	 * exist); the returned ref then carries its basename, so restore it by
	 * path string or via a store on that directory.
	 */
	save(agent: Agent, opts?: { label?: string; path?: string }): Promise<SessionRef>;
	/** Read and validate one snapshot. Accepts a ref or a path. */
	load(refOrPath: SessionRef | string): Promise<SessionSnapshot>;
	/** Load then revive: `restoreAgent(await load(...), init)`. */
	restore(refOrPath: SessionRef | string, init: AgentInit): Promise<Agent>;
	/**
	 * All snapshots in the directory, newest first. Default reads only
	 * directory names (time and label come from the filename);
	 * `{ withStats: true }` also parses each file for stats.
	 */
	list(opts?: { withStats?: boolean }): Promise<SessionRef[]>;
	/** The newest snapshot. Throws `not_found` when the directory has none. */
	latest(): Promise<SessionRef>;
	/**
	 * Delete one snapshot file (and its exact-basename `.details.json`
	 * sidecar, should one exist later). Throws `not_found` by default;
	 * `ignoreMissing` makes it idempotent for cleanup scripts.
	 */
	delete(refOrPath: SessionRef | string, opts?: { ignoreMissing?: boolean }): Promise<SessionRef>;
	/** Delete every `*.json` / `*.tmp` in the directory (first level only); returns the session count removed. */
	clear(): Promise<number>;
}

const INTERRUPTED_TOOL_RESULT_TEXT =
	"session saved mid-turn: this tool call was interrupted and was not executed";

/** `<YYYYMMDD-HHmmss>` in local time — the chronological filename prefix. */
function formatStamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

/** Label → filename slug: lowercase, `[a-z0-9-]` runs, ≤40 chars, no edge dashes. */
function slugify(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
}

/**
 * Append a synthetic error toolResult after the owning assistant message for
 * every toolCall id with no matching toolResult anywhere in the transcript.
 * Done once at save so every persisted snapshot loads as a valid request;
 * restoring never mutates. Insertion directly after the assistant message
 * covers both the tail case (a run interrupted mid-turn) and hand-edited
 * mid-history gaps.
 */
function repairDanglingToolCalls(messages: readonly AgentMessage[]): AgentMessage[] {
	const resolved = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") resolved.add(message.toolCallId);
	}

	let repairedAny = false;
	const repaired: AgentMessage[] = [];
	for (const message of messages) {
		repaired.push(message);
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || resolved.has(block.id)) continue;
			repairedAny = true;
			repaired.push({
				role: "toolResult",
				toolCallId: block.id,
				toolName: block.name,
				content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
				isError: true,
				// The owning assistant message's timestamp: deterministic, so
				// serializing the same state twice is byte-identical.
				timestamp: message.timestamp,
			});
		}
	}
	return repairedAny ? repaired : messages.slice();
}

/**
 * Capture an Agent as a pure-data snapshot. Interrupted tool calls get
 * synthetic error results (see {@link repairDanglingToolCalls}); the returned
 * messages array never aliases live agent state.
 */
export function serializeSession(agent: Agent, opts?: { label?: string }): SessionSnapshot {
	const label = opts?.label?.trim() ? opts.label.trim() : undefined;
	const now = new Date();
	// A label that slugs to nothing (e.g. non-Latin scripts) falls back to the
	// bare stamp — "…-.json" would be invisible to the filename index regex.
	const slug = label !== undefined ? slugify(label) : "";
	const id = formatStamp(now) + (slug !== "" ? `-${slug}` : "");
	const messages = repairDanglingToolCalls(agent.state.messages);
	const toolCalls = messages.reduce(
		(count, message) =>
			message.role === "assistant"
				? count + message.content.filter((block) => block.type === "toolCall").length
				: count,
		0,
	);
	return {
		version: SNAPSHOT_VERSION,
		id,
		...(label !== undefined ? { label } : {}),
		savedAt: now.toISOString(),
		model: agent.state.model.id,
		thinkingLevel: agent.state.thinkingLevel,
		parentId: null,
		stats: {
			messages: messages.length,
			toolCalls,
			approxTokens: estimateContextTokens(messages as Message[]).tokens,
		},
		messages,
	};
}

let builtinModels: MutableModels | undefined;

/**
 * Last-resort model resolution: the static catalogs of every bundled
 * provider. Built lazily on the first unresolved id; providers that fail to
 * construct in this environment are skipped.
 */
function lookupBuiltinModel(modelId: string): Model<any> | undefined {
	if (!builtinModels) {
		builtinModels = createModels();
		for (const factory of [
			anthropicProvider,
			openaiProvider,
			googleProvider,
			xaiProvider,
			zaiProvider,
			zaiCodingCnProvider,
			minimaxProvider,
			minimaxCnProvider,
			moonshotaiProvider,
			moonshotaiCnProvider,
			xiaomiProvider,
			xiaomiTokenPlanCnProvider,
			xiaomiTokenPlanSgpProvider,
			xiaomiTokenPlanAmsProvider,
			qwenTokenPlanProvider,
			qwenTokenPlanCnProvider,
			qwenTokenPlanIndividualProvider,
			deepseekProvider,
		]) {
			try {
				builtinModels.setProvider(factory());
			} catch {
				// Unavailable in this environment; its models just stay unresolved.
			}
		}
	}
	return builtinModels.getModels().find((model) => model.id === modelId);
}

/**
 * Revive a snapshot into a fresh Agent. Model resolution:
 * `init.model` > `init.resolveModel(snapshot.model)` > the bundled provider
 * catalogs > throws `model_unresolved`. `init.thinkingLevel` overrides the
 * snapshot value; every other AgentOption passes through untouched.
 */
export function restoreAgent(snapshot: SessionSnapshot, init: AgentInit): Agent {
	const { tools, streamFn, model, resolveModel, thinkingLevel, ...rest } = init;
	const resolvedModel = model ?? resolveModel?.(snapshot.model) ?? lookupBuiltinModel(snapshot.model);
	if (!resolvedModel) {
		throw new SessionError(
			"model_unresolved",
			`Model "${snapshot.model}" from session ${snapshot.id} resolved to nothing; ` +
				`pass init.model or init.resolveModel to override it.`,
		);
	}
	return new Agent({
		...rest,
		streamFn,
		initialState: {
			messages: snapshot.messages.slice(),
			model: resolvedModel,
			thinkingLevel: thinkingLevel ?? snapshot.thinkingLevel,
			tools,
		},
	});
}

/** Valid snapshot filenames: `<YYYYMMDD-HHmmss>-<slug>.json` (slug optional). */
const FILE_NAME_RE = /^(\d{8}-\d{6})(?:-(.+))?\.json$/;

/**
 * Sort key matching save order: the stamp first, then the collision suffix.
 * Plain string order would rank "alpha-2.json" before "alpha.json" ("-" sorts
 * below "."), making latest() pick the older save on same-second collisions.
 * The unsuffixed base is the first save, so it sorts below any suffix.
 */
function nameOrderKey(fileName: string): [string, number] {
	const match = FILE_NAME_RE.exec(fileName);
	if (!match) return [fileName, 0];
	const suffixMatch = /-(\d+)$/.exec(match[2] ?? "");
	return [match[1]!, suffixMatch ? Number(suffixMatch[1]) : -1];
}

/** Rebuild an ISO timestamp from the filename's local-time stamp. */
function savedAtFromStamp(stamp: string): string {
	const date = new Date(
		Number(stamp.slice(0, 4)),
		Number(stamp.slice(4, 6)) - 1,
		Number(stamp.slice(6, 8)),
		Number(stamp.slice(9, 11)),
		Number(stamp.slice(11, 13)),
		Number(stamp.slice(13, 15)),
	);
	return date.toISOString();
}

function refFromFileName(fileName: string, fallbackSavedAt?: string): SessionRef {
	const match = FILE_NAME_RE.exec(fileName);
	const stem = fileName.replace(/\.json$/, "");
	if (!match) return { id: stem, savedAt: fallbackSavedAt ?? new Date(0).toISOString(), file: fileName };
	const label = match[2];
	return {
		id: stem,
		...(label !== undefined ? { label } : {}),
		savedAt: savedAtFromStamp(match[1]!),
		file: fileName,
	};
}

/**
 * Shared ref/path → file resolution for load / restore / delete.
 *
 * A string with a path separator is an explicit path (the caller's own
 * choice, anywhere on disk); a bare string resolves inside the store
 * directory. A ref's `file` must be a bare file name — `/`, `\`, and `..`
 * are rejected so a tampered ref can never point load/delete outside the
 * directory it came from.
 */
function resolveSessionFile(dir: string, refOrPath: SessionRef | string): string {
	if (typeof refOrPath === "string") {
		return refOrPath.includes("/") || refOrPath.includes("\\") ? resolve(refOrPath) : join(dir, refOrPath);
	}
	const file = refOrPath.file;
	if (file === "" || file === "." || file === ".." || file.includes("/") || file.includes("\\") || file.includes("..")) {
		throw new SessionError("corrupt", `SessionRef.file must be a bare file name, got "${file}"`);
	}
	return join(dir, file);
}

function parseSnapshot(text: string, origin: string): SessionSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new SessionError("corrupt", `Session file ${origin} is not valid JSON: ${String(error)}`);
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record !== "object" || record === null) {
		throw new SessionError("corrupt", `Session file ${origin} is not a session snapshot`);
	}
	// Version gate first: a future-version file must report bad_version, not
	// trip on whatever field layout that future version uses.
	if (record.version !== SNAPSHOT_VERSION) {
		if (typeof record.version === "number" && record.version > SNAPSHOT_VERSION) {
			throw new SessionError(
				"bad_version",
				`Session file ${origin} has version ${record.version}; this pico-agent reads version ${SNAPSHOT_VERSION}. Upgrade to load it.`,
			);
		}
		throw new SessionError("corrupt", `Session file ${origin} has invalid version ${String(record.version)}`);
	}
	if (!Array.isArray(record.messages)) {
		throw new SessionError("corrupt", `Session file ${origin} has no messages array`);
	}
	if (typeof record.model !== "string") {
		throw new SessionError("corrupt", `Session file ${origin} has no model id`);
	}
	return parsed as SessionSnapshot;
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

/** Write via `<file>.tmp` + rename so readers never see a half-written file. */
async function writeAtomic(target: string, data: string): Promise<void> {
	const tmp = `${target}.tmp`;
	await writeFile(tmp, data, "utf8");
	await rename(tmp, target);
}

/** The first free `<id>.json`, appending `-2`, `-3`, … on same-second collisions. */
async function allocateFileName(dir: string, id: string): Promise<{ fileName: string; id: string }> {
	if (!(await pathExists(join(dir, `${id}.json`)))) return { fileName: `${id}.json`, id };
	for (let suffix = 2; ; suffix++) {
		const suffixed = `${id}-${suffix}`;
		if (!(await pathExists(join(dir, `${suffixed}.json`)))) return { fileName: `${suffixed}.json`, id: suffixed };
	}
}

/**
 * Create a stateless store facade over one directory. No locks: concurrent
 * writers to the same directory get unique filenames and atomic renames.
 */
export function createSessionStore(options?: SessionStoreOptions): SessionStore {
	const dir = options?.dir !== undefined ? resolve(options.dir) : join(process.cwd(), ".pico", "sessions");

	const store: SessionStore = {
		dir,

		async save(agent, saveOptions) {
			const snapshot = serializeSession(agent, { label: saveOptions?.label });
			let target: string;
			let id = snapshot.id;
			if (saveOptions?.path !== undefined) {
				target = resolve(saveOptions.path);
				if (await pathExists(target)) {
					throw new Error(`Refusing to overwrite existing session file: ${target}`);
				}
			} else {
				const allocated = await allocateFileName(dir, snapshot.id);
				id = allocated.id;
				target = join(dir, allocated.fileName);
			}
			await mkdir(dirname(target), { recursive: true });
			await writeAtomic(target, `${JSON.stringify({ ...snapshot, id }, null, "\t")}\n`);
			return {
				id,
				...(snapshot.label !== undefined ? { label: snapshot.label } : {}),
				savedAt: snapshot.savedAt,
				file: basename(target),
				stats: snapshot.stats,
			};
		},

		async load(refOrPath) {
			const target = resolveSessionFile(dir, refOrPath);
			let text: string;
			try {
				text = await readFile(target, "utf8");
			} catch {
				throw new SessionError("not_found", `No session file at ${target}`);
			}
			return parseSnapshot(text, target);
		},

		async restore(refOrPath, init) {
			return restoreAgent(await store.load(refOrPath), init);
		},

		async list(listOptions) {
			let entries: string[];
			try {
				entries = await readdir(dir);
			} catch {
				return []; // A missing directory is an empty store.
			}
			const names = entries.filter((name) => FILE_NAME_RE.test(name));
			names.sort((a, b) => {
				const [stampA, suffixA] = nameOrderKey(a);
				const [stampB, suffixB] = nameOrderKey(b);
				// Newest first; same-stamp ties fall back to the name so the order
				// never depends on readdir's OS-specific ordering.
				return stampB.localeCompare(stampA) || suffixB - suffixA || b.localeCompare(a);
			});
			const refs: SessionRef[] = [];
			for (const name of names) {
				const ref = refFromFileName(name);
				if (listOptions?.withStats) {
					try {
						const snapshot = parseSnapshot(await readFile(join(dir, name), "utf8"), name);
						ref.stats = snapshot.stats;
						if (snapshot.label !== undefined) ref.label = snapshot.label;
					} catch {
						// Unparseable content still lists by its filename index.
					}
				}
				refs.push(ref);
			}
			return refs;
		},

		async latest() {
			const refs = await store.list();
			if (refs.length === 0) throw new SessionError("not_found", `No sessions in ${dir}`);
			return refs[0]!;
		},

		async delete(refOrPath, deleteOptions) {
			const target = resolveSessionFile(dir, refOrPath);
			const info = await stat(target).catch(() => undefined);
			if (!info) {
				if (!deleteOptions?.ignoreMissing) {
					throw new SessionError("not_found", `No session file at ${target}`);
				}
				return refFromFileName(basename(target));
			}
			const ref = refFromFileName(
				basename(target),
				FILE_NAME_RE.test(basename(target)) ? undefined : info.mtime.toISOString(),
			);
			await unlink(target);
			const sidecar = `${target}.details.json`;
			if (await pathExists(sidecar)) await unlink(sidecar);
			return ref;
		},

		async clear() {
			let entries: Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return 0;
			}
			let deleted = 0;
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				if (entry.name.endsWith(".json")) {
					await unlink(join(dir, entry.name));
					deleted++;
				} else if (entry.name.endsWith(".tmp")) {
					await unlink(join(dir, entry.name)); // Atomic-write leftovers; not sessions.
				}
			}
			return deleted;
		},
	};

	return store;
}
