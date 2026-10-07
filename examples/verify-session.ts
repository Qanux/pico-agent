/**
 * Session persistence regression, keyless like the subagent verify.
 *
 *   A roundtrip: save → fresh store instance restore → the very next model
 *      request contains the saved history (proof the model sees the memory,
 *      not just that state was restored).
 *   B dangling repair: a transcript ending in an unpaired toolCall gets a
 *      synthetic error toolResult placed right after the assistant message;
 *      save/load preserves it and the restored agent's next request carries it.
 *   C model resolution: init.model override wins; init.resolveModel works; an
 *      unknown id with no override → model_unresolved; a real catalog id
 *      resolves through the bundled provider registry.
 *   D ref loop: repeated saves never overwrite (same-second -2 suffix),
 *      list() derives label/time from filenames, latest() is the newest,
 *      withStats enriches refs from file content, a fresh store restores by
 *      listed ref, and explicit-path saves refuse to overwrite.
 *   E bad files: version 99 → bad_version; garbage JSON and a missing
 *      messages array → corrupt; absent file → not_found.
 *   F stats: message and toolCall counts are exact, approxTokens positive.
 *   G delete: file removed, list() drops it, load → not_found, second delete
 *      → not_found by default, ignoreMissing idempotent.
 *   H escape guard: a ref with file "../evil.json" is rejected (corrupt) by
 *      load AND delete with no filesystem side effect on a real decoy file;
 *      clear() removes only first-level *.json/*.tmp in its directory.
 * Run: node examples/verify-session.ts
 */
import { stat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	EventStream,
	SessionError,
	createSessionStore,
	restoreAgent,
	serializeSession,
	type AgentMessage,
	type AssistantMessage,
	type SessionRef,
	type StreamFn,
} from "../src/index.ts";

let failures = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

const fakeModel = { id: "mock", api: "anthropic-messages", provider: "mock", contextWindow: 1_000_000 } as never;

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "mock",
		model: "mock",
		usage: {
			input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		content,
		stopReason,
	};
}

function pushScriptedReply(stream: EventStream<never, never>, message: AssistantMessage) {
	// Scripted events intentionally don't match the real event union (the loop
	// only reads what it needs); push through an untyped alias so the mismatch
	// lives in exactly one place.
	const push = (event: unknown) => stream.push(event as never);
	void (async () => {
		push({ type: "start", partial: message });
		push({ type: "message", message });
		push({ type: "done", message, stopReason: message.stopReason });
		stream.end();
	})();
}

function newStream() {
	return new EventStream<never, never>(
		(e) => (e as { type: string }).type === "done" || (e as { type: string }).type === "error",
		(e) =>
			(e as { type: string }).type === "done"
				? ((e as { message: AssistantMessage }).message as unknown as never)
				: e,
	);
}

/** A streamFn with a fixed answer that optionally records each request's full message list. */
function scriptedStreamFn(
	respond: () => AssistantMessage,
	onRequest?: (requestMessages: AgentMessage[]) => void,
): StreamFn {
	return (_model, context) => {
		onRequest?.(context.messages as AgentMessage[]);
		const stream = newStream();
		pushScriptedReply(stream, respond());
		return stream as never;
	};
}

const stopAnswer = () => reply([{ type: "text", text: "ok" }], "stop");

async function expectSessionError(code: string, run: () => unknown, label: string): Promise<void> {
	try {
		await run();
		check(false, `${label} (no error thrown)`);
	} catch (error) {
		const got = error instanceof SessionError ? error.code : `${String(error)}`.slice(0, 60);
		check(error instanceof SessionError && error.code === code, `${label} (got ${got})`);
	}
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pico-session-verify-"));
}

async function conversationalAgent(systemPrompt: string): Promise<Agent> {
	const agent = new Agent({
		initialState: { systemPrompt, model: fakeModel, tools: [] },
		streamFn: scriptedStreamFn(stopAnswer),
	});
	await agent.prompt(`question-for-${systemPrompt}`);
	return agent;
}

async function scenarioA() {
	const dir = await tempDir();
	try {
		const first = await conversationalAgent("sysA");
		const ref = await createSessionStore({ dir }).save(first, { label: "Round Trip!" });
		check(/^\d{8}-\d{6}-round-trip\.json$/.test(ref.file), `A: ref.file is the indexed filename (${ref.file})`);
		check(ref.stats?.messages === first.state.messages.length, "A: ref.stats mirrors the transcript size");

		// A fresh store instance stands in for a new process on the same directory.
		const requests: string[] = [];
		const restored = await createSessionStore({ dir }).restore(ref, {
			tools: [],
			model: fakeModel,
			streamFn: scriptedStreamFn(
				() => reply([{ type: "text", text: "SECOND-ANSWER-XYZ" }], "stop"),
				(messages) => requests.push(JSON.stringify(messages)),
			),
		});
		await restored.prompt("continue");
		check(
			requests[0]?.includes("question-for-sysA") === true && requests[0]?.includes("ok") === true,
			"A: restored agent's next request carries the saved history",
		);
		check(
			restored.state.messages.some((m) => m.role === "assistant" && JSON.stringify(m).includes("SECOND-ANSWER-XYZ")),
			"A: the restored conversation continues from the snapshot",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function scenarioB() {
	const dangling = new Agent({
		initialState: { systemPrompt: "sysB", model: fakeModel, tools: [] },
		streamFn: scriptedStreamFn(stopAnswer),
	});
	dangling.state.messages = [
		{ role: "system", content: "sysB", timestamp: 0 },
		{ role: "user", content: "run the tool", timestamp: 1 },
		reply([{ type: "toolCall", id: "call-dangling-1", name: "echo", arguments: { msg: "x" } }], "toolUse"),
	];

	const snapshot = serializeSession(dangling, { label: "dangling" });
	const repaired = snapshot.messages.filter((m) => m.role === "toolResult");
	const first = repaired[0] as { toolCallId: string; isError: boolean } | undefined;
	check(
		repaired.length === 1 && first?.toolCallId === "call-dangling-1" && first.isError,
		"B: the unpaired toolCall gets exactly one synthetic error result",
	);
	check(
		JSON.stringify(repaired[0]).includes("interrupted"),
		"B: the synthetic result explains the interruption",
	);
	check(snapshot.messages[3]?.role === "toolResult", "B: it sits right after the owning assistant message");

	const requests: string[] = [];
	const restored = restoreAgent(snapshot, {
		tools: [],
		model: fakeModel,
		streamFn: scriptedStreamFn(stopAnswer, (messages) => requests.push(JSON.stringify(messages))),
	});
	await restored.prompt("next");
	check(
		requests[0]?.includes("interrupted") === true && requests[0]?.includes("call-dangling-1") === true,
		"B: the restored agent's next request contains the repair",
	);

	const dir = await tempDir();
	try {
		const store = createSessionStore({ dir });
		const ref = await store.save(dangling, { label: "dangling" });
		const loaded = await store.load(ref);
		check(
			JSON.stringify(loaded.messages) === JSON.stringify(snapshot.messages),
			"B: save/load preserves the repaired transcript byte-for-byte",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function scenarioC() {
	const base = serializeSession(await conversationalAgent("sysC"));
	const unknown = { ...base, model: "no-such-model-anywhere" };
	const noop = scriptedStreamFn(() => reply([], "stop"));

	check(
		restoreAgent(unknown, { tools: [], streamFn: noop, model: fakeModel }).state.model.id === "mock",
		"C: init.model overrides the snapshot model",
	);
	check(
		restoreAgent(unknown, { tools: [], streamFn: noop, resolveModel: () => fakeModel }).state.model.id === "mock",
		"C: init.resolveModel resolves the snapshot model",
	);
	await expectSessionError(
		"model_unresolved",
		() => restoreAgent(unknown, { tools: [], streamFn: noop }),
		"C: unknown id with no override → model_unresolved",
	);
	const catalogModel = restoreAgent({ ...base, model: "deepseek-flash" }, { tools: [], streamFn: noop }).state.model;
	check(
		catalogModel.provider === "deepseek" && catalogModel.id === "deepseek-flash",
		"C: a real catalog id resolves through the bundled registry",
	);
}

async function scenarioD() {
	const dir = await tempDir();
	try {
		const agent = await conversationalAgent("sysD");
		const store = createSessionStore({ dir });
		const ref1 = await store.save(agent, { label: "alpha" });
		const ref2 = await store.save(agent, { label: "alpha" });
		check(ref1.file !== ref2.file, "D: repeated saves never overwrite");
		if (ref1.file.slice(0, 15) === ref2.file.slice(0, 15)) {
			check(/-2\.json$/.test(ref2.file), `D: same-second collision gets the -2 suffix (${ref2.file})`);
		}

		const listed = await store.list();
		check(listed.length === 2, "D: list() sees both snapshots");
		check(listed.every((r) => typeof r.label === "string" && r.label.startsWith("alpha")), "D: labels parse from filenames");
		check((await store.latest()).file === ref2.file, "D: latest() is the newest save");

		const restored = await createSessionStore({ dir }).restore(listed[1]!, { tools: [], model: fakeModel, streamFn: scriptedStreamFn(stopAnswer) });
		check(
			restored.state.messages.some((m) => m.role === "user"),
			"D: a fresh store restores by a ref that came from list()",
		);

		const withStats = await store.list({ withStats: true });
		check(
			withStats.every((r) => r.stats !== undefined && r.stats.messages > 0),
			"D: withStats enriches refs from file content",
		);

		const explicit = join(dir, "custom", "manual.json");
		check(
			(await store.save(agent, { label: "manual", path: explicit })).file === "manual.json"
				&& (await pathExists(explicit)),
			"D: explicit-path save writes exactly that file",
		);
		let refused = false;
		try {
			await store.save(agent, { path: explicit });
		} catch {
			refused = true;
		}
		check(refused, "D: explicit-path save refuses to overwrite an existing file");

		const cn = await store.save(agent, { label: "审计" });
		check(
			/^\d{8}-\d{6}\.json$/.test(cn.file),
			`D: a non-ASCII label slugs to nothing and falls back to the bare stamp (${cn.file})`,
		);
		check((await store.list()).some((r) => r.file === cn.file), "D: the bare-stamp snapshot stays visible to list()");
		check((await store.load(cn)).label === "审计", "D: the original label survives inside the snapshot");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function scenarioE() {
	const dir = await tempDir();
	try {
		await writeFile(join(dir, "20260101-000001-v99.json"), JSON.stringify({ version: 99, messages: [] }));
		await writeFile(join(dir, "20260101-000002-garbage.json"), "{not json");
		await writeFile(join(dir, "20260101-000003-nomsg.json"), JSON.stringify({ version: 1 }));
		await writeFile(join(dir, "20260101-000004-nomodel.json"), JSON.stringify({ version: 1, messages: [] }));
		const store = createSessionStore({ dir });
		await expectSessionError("bad_version", () => store.load("20260101-000001-v99.json"), "E: version 99 → bad_version");
		await expectSessionError("corrupt", () => store.load("20260101-000002-garbage.json"), "E: garbage JSON → corrupt");
		await expectSessionError("corrupt", () => store.load("20260101-000003-nomsg.json"), "E: missing messages array → corrupt");
		await expectSessionError("corrupt", () => store.load("20260101-000004-nomodel.json"), "E: missing model id → corrupt");
		await expectSessionError("not_found", () => store.load("20260101-000099-missing.json"), "E: absent file → not_found");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function scenarioF() {
	const agent = new Agent({
		initialState: { systemPrompt: "sysF", model: fakeModel, tools: [] },
		streamFn: scriptedStreamFn(stopAnswer),
	});
	agent.state.messages = [
		{ role: "system", content: "sysF", timestamp: 0 },
		{ role: "user", content: "use tools", timestamp: 1 },
		reply(
			[
				{ type: "toolCall", id: "f-1", name: "echo", arguments: { msg: "a" } },
				{ type: "toolCall", id: "f-2", name: "echo", arguments: { msg: "b" } },
			],
			"toolUse",
		),
		{ role: "toolResult", toolCallId: "f-1", toolName: "echo", content: [{ type: "text", text: "r1" }], isError: false, timestamp: 2 },
		{ role: "toolResult", toolCallId: "f-2", toolName: "echo", content: [{ type: "text", text: "r2" }], isError: false, timestamp: 3 },
		reply([{ type: "text", text: "done" }], "stop"),
	];
	const { stats } = serializeSession(agent);
	check(stats.messages === 6, `F: messages count (${stats.messages})`);
	check(stats.toolCalls === 2, `F: toolCalls count (${stats.toolCalls})`);
	check(stats.approxTokens > 0, "F: approxTokens positive");
}

async function scenarioG() {
	const dir = await tempDir();
	try {
		const store = createSessionStore({ dir });
		const ref = await store.save(await conversationalAgent("sysG"), { label: "gone" });
		check((await store.delete(ref)).file === ref.file, "G: delete returns what it deleted");
		check((await store.list()).length === 0, "G: list() drops the deleted session");
		await expectSessionError("not_found", () => store.load(ref), "G: load after delete → not_found");
		await expectSessionError("not_found", () => store.delete(ref), "G: delete again → not_found by default");
		check((await store.delete(ref, { ignoreMissing: true })).file === ref.file, "G: ignoreMissing is idempotent");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function scenarioH() {
	const dir = await tempDir();
	// Outside the store dir, so the finally must clean it up separately.
	const decoy = join(dir, "..", "pico-session-evil-decoy.json");
	try {
		const store = createSessionStore({ dir });
		// A real file outside the store directory; a tampered ref must not reach it.
		await writeFile(decoy, JSON.stringify({ version: 1, messages: [] }));
		const evilRef: SessionRef = { id: "evil", savedAt: new Date().toISOString(), file: "../pico-session-evil-decoy.json" };
		await expectSessionError("corrupt", () => store.load(evilRef), "H: traversal ref rejected by load");
		await expectSessionError("corrupt", () => store.delete(evilRef), "H: traversal ref rejected by delete");
		check(await pathExists(decoy), "H: rejected refs leave the outside file untouched");

		const savedFile = (await store.save(await conversationalAgent("sysH"), { label: "sweep" })).file;
		await writeFile(join(dir, "notes.txt"), "keep me");
		await writeFile(join(dir, "20260101-000000-leftover.json.tmp"), "stale atomic-write leftover");
		const cleared = await store.clear();
		check(cleared === 1, `H: clear() counts only sessions (${cleared})`);
		check(!(await pathExists(join(dir, savedFile))), "H: the session file is gone");
		check(!(await pathExists(join(dir, "20260101-000000-leftover.json.tmp"))), "H: stale .tmp leftovers are swept");
		check(await pathExists(join(dir, "notes.txt")), "H: non-session files in dir survive clear()");
		check(await pathExists(decoy), "H: files outside dir survive clear()");
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(decoy, { force: true });
	}
}

async function main() {
	await scenarioA();
	await scenarioB();
	await scenarioC();
	await scenarioD();
	await scenarioE();
	await scenarioF();
	await scenarioG();
	await scenarioH();
	console.log(failures === 0 ? "\nAll session persistence checks passed." : `\n${failures} check(s) failed.`);
	process.exitCode = failures === 0 ? 0 : 1;
}

await main();
