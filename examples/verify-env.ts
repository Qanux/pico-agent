/**
 * NodeExecutionEnv + built-in tool adversarial regression (no LLM involved;
 * tools are invoked directly through the harness six-arg execute).
 *
 *   A bash: stdout+stderr combined, non-zero exit, "(no output)", timeout,
 *     invalid timeouts, abort mid-run, pre-aborted signal, missing cwd.
 *   B bash truncation: 3000-line output tail-truncated with a "[Showing
 *     lines ...]" marker, spill file retains the complete output.
 *   C bash seams: commandPrefix prepend, prepare() hook mutation, initial
 *     empty onUpdate push.
 *   D env.exec direct: ok Result shape, exit code, aborted Result on signal.
 *   E env filesystem: readFile/writeFile/appendFile/exists/fileInfo/listDir/
 *     renameFile/remove/createDir/canonicalPath/createTempFile/readTextLines
 *     limits; error codes not_found / is_directory; unterminated final line
 *     via openTextLineReader; cleanup() kills a running child.
 *   F read tool: exact content, pagination hints, offset beyond EOF,
 *     line-limit truncation with continue hint, single-line byte-limit
 *     fallback, missing file, directory, PNG/JPEG/GIF/BMP image detection.
 *   G write tool: nested parent dirs, overwrite.
 *   H edit tool: not-found, ambiguous match, empty oldText, no-op edit,
 *     edits matched against the ORIGINAL (chained edit fails), overlapping
 *     edits, CRLF preservation, BOM preservation, JSON-string edits via
 *     prepareArguments, legacy single-edit input, directory target,
 *     diff/patch/firstChangedLine details.
 * Run: node examples/verify-env.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	BACKGROUND_CONTEXT,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	NodeExecutionEnv,
	withAbortSignal,
	type AgentHarnessTool,
	type AgentHarnessToolInvocation,
	type AgentToolResult,
	type Context,
	type ExecutionToolContext,
} from "pico-agent";

let failures = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

async function expectThrow(fn: () => Promise<unknown>, substring: string, label: string) {
	try {
		await fn();
		check(false, `${label} (did not throw)`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		check(message.includes(substring), `${label} (${JSON.stringify(message.slice(0, 120))})`);
	}
}

const workspace = mkdtempSync(join(tmpdir(), "pico-lc-env-"));
const env = new NodeExecutionEnv({ cwd: workspace });
const toolContext: ExecutionToolContext = { env };
const INVOCATION: AgentHarnessToolInvocation = {
	invocationId: "call-1",
	operationId: "verify",
	turnId: "verify",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

async function run(
	tool: AgentHarnessTool<ExecutionToolContext, z.ZodType, unknown>,
	params: unknown,
	context: Context = BACKGROUND_CONTEXT,
	onUpdate?: (partial: AgentToolResult<unknown>) => void,
): Promise<AgentToolResult<unknown>> {
	return tool.execute("call-1", params as never, onUpdate ?? (() => {}), toolContext, INVOCATION, context);
}

const bash = createBashTool();
const read = createReadTool();
const write = createWriteTool();
const edit = createEditTool();
const textOf = (result: AgentToolResult<unknown>): string =>
	result.content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");

// ---- Scenario A: bash basics and failure modes ----
{
	console.log("--- scenario A: bash basics ---");
	const hello = await run(bash, { command: "echo hello; echo err 1>&2" });
	check(hello.content[0]?.type === "text" && hello.content[0].text.includes("hello") && hello.content[0].text.includes("err"),
		"A: stdout and stderr are combined");
	await expectThrow(() => run(bash, { command: "exit 3" }), "Command exited with code 3", "A: non-zero exit code");
	const silent = await run(bash, { command: "true" });
	check(textOf(silent) === "(no output)", "A: empty output renders as (no output)");
	await expectThrow(() => run(bash, { command: "sleep 2", timeout: 0.3 }), "Command timed out after 0.3 seconds", "A: timeout kills the command");
	await expectThrow(() => run(bash, { command: "true", timeout: 0 }), "Invalid timeout: must be a finite number of seconds", "A: timeout 0 rejected");
	await expectThrow(() => run(bash, { command: "true", timeout: -1 }), "Invalid timeout: must be a finite number of seconds", "A: negative timeout rejected");
	await expectThrow(() => run(bash, { command: "true", timeout: 3e6 }), "Invalid timeout: maximum", "A: oversized timeout rejected");

	const controller = new AbortController();
	setTimeout(() => controller.abort(), 50);
	await expectThrow(
		() => run(bash, { command: "sleep 2" }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT)),
		"Command aborted",
		"A: mid-run abort surfaces as aborted",
	);
	const dead = new AbortController();
	dead.abort();
	await expectThrow(
		() => run(bash, { command: "true" }, withAbortSignal(dead.signal, BACKGROUND_CONTEXT)),
		"Command aborted",
		"A: pre-aborted signal refuses to spawn",
	);

	const nowhere = new NodeExecutionEnv({ cwd: join(workspace, "does-not-exist") });
	const nowhereContext: ExecutionToolContext = { env: nowhere };
	await expectThrow(
		() => createBashTool().execute("c", { command: "true" }, () => {}, nowhereContext, INVOCATION, BACKGROUND_CONTEXT),
		"Working directory does not exist",
		"A: missing cwd is a spawn error",
	);
}

// ---- Scenario B: truncation + spill ----
{
	console.log("--- scenario B: bash truncation ---");
	const result = await run(bash, { command: "seq 1 3000" });
	const details = result.details as
		| { truncation?: { truncated: boolean; truncatedBy: string; totalLines: number }; fullOutputPath?: string }
		| undefined;
	const text = textOf(result);
	check(
		text.includes("[Showing lines 1001-3000 of 3000. Full output:") && text.trimStart().startsWith("1001"),
		"B: output tail-truncated with a lines marker",
	);
	check(
		details?.truncation?.truncated === true && details.truncation.truncatedBy === "lines",
		"B: truncation details report truncatedBy lines",
	);
	const spillPath = details?.fullOutputPath;
	const spill = spillPath ? readFileSync(spillPath, "utf8") : "";
	check(spill.startsWith("1\n2\n") && spill.trimEnd().endsWith("3000"), "B: spill file keeps the complete output");
}

// ---- Scenario C: bash seams ----
{
	console.log("--- scenario C: bash seams ---");
	const prefixed = await run(createBashTool({ commandPrefix: "echo PREFIX-RAN" }), { command: "echo hi" });
	check(textOf(prefixed).includes("PREFIX-RAN") && textOf(prefixed).includes("hi"), "C: commandPrefix runs before the command");

	const seen: string[] = [];
	const prepared = await run(
		createBashTool({
			prepare: (execution) => {
				seen.push(execution.command);
				execution.command = "echo MUTATED";
			},
		}),
		{ command: "echo original" },
	);
	check(seen[0] === "echo original" && textOf(prepared).includes("MUTATED"), "C: prepare() sees and can rewrite the execution");

	const updates: Array<AgentToolResult<unknown>> = [];
	await run(bash, { command: "echo x" }, BACKGROUND_CONTEXT, (partial) => {
		updates.push(partial as AgentToolResult<unknown>);
	});
	check(updates.length >= 2 && updates[0]!.content.length === 0, `C: onUpdate pushes an initial empty snapshot (${updates.length} updates)`);
}

// ---- Scenario D: env.exec direct results ----
{
	console.log("--- scenario D: env.exec results ---");
	const okRun = await env.exec("echo direct", undefined, BACKGROUND_CONTEXT);
	check(okRun.ok && okRun.ok && okRun.value.exitCode === 0, "D: exec returns ok with exit code 0");
	const failRun = await env.exec("exit 7", undefined, BACKGROUND_CONTEXT);
	check(failRun.ok && failRun.value.exitCode === 7, "D: non-zero exit code is a result, not an error");
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 50);
	const abortedRun = await env.exec("sleep 2", undefined, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
	check(!abortedRun.ok && abortedRun.error.code === "aborted", "D: signal abort returns an aborted error result");
	const invalidRun = await env.exec("true", { timeout: Number.NaN }, BACKGROUND_CONTEXT);
	check(!invalidRun.ok && invalidRun.error.code === "timeout", "D: NaN timeout rejected with code timeout");
}

// ---- Scenario E: env filesystem surface ----
{
	console.log("--- scenario E: env filesystem ---");
	await env.writeFile("nested/deep/file.txt", "line1\nline2\nline3", BACKGROUND_CONTEXT);
	const readBack = await env.readTextFile("nested/deep/file.txt", BACKGROUND_CONTEXT);
	check(readBack.ok && readBack.value === "line1\nline2\nline3", "E: writeFile creates nested parents and reads back");
	await env.appendFile("nested/deep/file.txt", "\nline4", BACKGROUND_CONTEXT);
	const appended = await env.readTextFile("nested/deep/file.txt", BACKGROUND_CONTEXT);
	check(appended.ok && appended.value.endsWith("line4"), "E: appendFile extends content");
	const exists = await env.exists("nested/deep/file.txt", BACKGROUND_CONTEXT);
	check(exists.ok && exists.value === true, "E: exists true for a file");
	const missing = await env.exists("nope.txt", BACKGROUND_CONTEXT);
	check(missing.ok && missing.value === false, "E: exists false for a missing path");
	const info = await env.fileInfo("nested/deep/file.txt", BACKGROUND_CONTEXT);
	check(info.ok && info.value.kind === "file" && info.value.name === "file.txt", "E: fileInfo reports kind and name");
	const dirInfo = await env.fileInfo("nested", BACKGROUND_CONTEXT);
	check(dirInfo.ok && dirInfo.value.kind === "directory", "E: fileInfo reports directories");
	const dirError = await env.readTextFile("nested", BACKGROUND_CONTEXT);
	check(!dirError.ok && dirError.error.code === "is_directory", "E: reading a directory yields is_directory");
	const notFound = await env.readTextFile("missing.txt", BACKGROUND_CONTEXT);
	check(!notFound.ok && notFound.error.code === "not_found", "E: missing file yields not_found");
	const listed = await env.listDir("nested/deep", BACKGROUND_CONTEXT);
	check(listed.ok && listed.value.length === 1 && listed.value[0]!.name === "file.txt", "E: listDir returns entries");
	await env.renameFile("nested/deep/file.txt", "nested/deep/renamed.txt", BACKGROUND_CONTEXT);
	const renamedExists = await env.exists("nested/deep/renamed.txt", BACKGROUND_CONTEXT);
	check(renamedExists.ok && renamedExists.value === true, "E: renameFile moves the file");
	const lines = await env.readTextLines("nested/deep/renamed.txt", { maxLines: 2 }, BACKGROUND_CONTEXT);
	check(lines.ok && lines.value.length === 2 && lines.value[1] === "line2", "E: readTextLines honors maxLines");
	const zeroLines = await env.readTextLines("nested/deep/renamed.txt", { maxLines: 0 }, BACKGROUND_CONTEXT);
	check(zeroLines.ok && zeroLines.value.length === 0, "E: readTextLines maxLines 0 returns nothing");
	await env.writeFile("unterminated.txt", "a\nb", BACKGROUND_CONTEXT);
	const reader = await env.openTextLineReader("unterminated.txt", BACKGROUND_CONTEXT);
	const l1 = reader.ok ? await reader.value.readLine(BACKGROUND_CONTEXT) : undefined;
	const l2 = reader.ok ? await reader.value.readLine(BACKGROUND_CONTEXT) : undefined;
	const l3 = reader.ok ? await reader.value.readLine(BACKGROUND_CONTEXT) : undefined;
	if (reader.ok) await reader.value.close(BACKGROUND_CONTEXT);
	check(
		Boolean(
			reader.ok &&
				l1?.ok && l1.value?.text === "a" && l1.value.terminated === true &&
				l2?.ok && l2.value?.text === "b" && l2.value.terminated === false &&
				l3?.ok && l3.value === undefined,
		),
		"E: line reader flags the unterminated final line",
	);
	const canonical = await env.canonicalPath("nested/../nested", BACKGROUND_CONTEXT);
	check(canonical.ok && !canonical.value.includes(".."), "E: canonicalPath resolves symlinks and dots");
	const tempFile = await env.createTempFile({ prefix: "pico-", suffix: ".log" }, BACKGROUND_CONTEXT);
	check(tempFile.ok && tempFile.value.includes("pico-") && tempFile.value.endsWith(".log"), "E: createTempFile honors prefix and suffix");
	const dir = await env.createDir("made/up/dirs", { recursive: true }, BACKGROUND_CONTEXT);
	check(dir.ok, "E: createDir recursive");
	const removed = await env.remove("made", { recursive: true }, BACKGROUND_CONTEXT);
	check(removed.ok, "E: remove recursive");
	const stillThere = await env.exists("made", BACKGROUND_CONTEXT);
	check(stillThere.ok && stillThere.value === false, "E: removed path is gone");

	const cleanupStart = Date.now();
	const cleanupRun = env.exec("sleep 5", undefined, BACKGROUND_CONTEXT);
	setTimeout(() => {
		void env.cleanup(BACKGROUND_CONTEXT);
	}, 50);
	const afterCleanup = await cleanupRun;
	// A signal-killed child maps to the conventional 128+signal exit code
	// (SIGKILL → 137) as a normal result; the run must settle immediately.
	check(
		afterCleanup.ok && afterCleanup.value.exitCode === 137 && Date.now() - cleanupStart < 2000,
		`E: cleanup() kills a running child (exit ${afterCleanup.ok ? afterCleanup.value.exitCode : "?"})`,
	);
}

// ---- Scenario F: read tool ----
{
	console.log("--- scenario F: read tool ---");
	await run(write, { path: "plain.txt", content: "a\nb" });
	const plain = await run(read, { path: "plain.txt" });
	check(textOf(plain) === "a\nb", "F: exact content without trailing newline");

	await run(write, { path: "ten.txt", content: Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") });
	const page = await run(read, { path: "ten.txt", offset: 2, limit: 3 });
	check(
		textOf(page).startsWith("l2\nl3\nl4") && textOf(page).includes("[6 more lines in file. Use offset=5 to continue.]"),
		"F: offset/limit pagination shows the continue hint",
	);
	await expectThrow(() => run(read, { path: "ten.txt", offset: 99 }), "beyond end of file", "F: offset beyond EOF");

	await run(write, { path: "big.txt", content: Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`).join("\n") });
	const big = await run(read, { path: "big.txt" });
	const bigDetails = big.details as { truncation?: { truncated: boolean } } | undefined;
	check(
		textOf(big).startsWith("line-1") && textOf(big).includes("Showing lines 1-2000") && textOf(big).includes("Use offset=2001 to continue."),
		"F: line-limit truncation keeps the head and hints the next offset",
	);
	check(bigDetails?.truncation?.truncated === true, "F: read details carry truncation");

	await run(write, { path: "oneline.txt", content: "x".repeat(60 * 1024) });
	const huge = await run(read, { path: "oneline.txt" });
	check(textOf(huge).includes("exceeds") && textOf(huge).includes("sed -n '1p'"), "F: single oversized line falls back to the sed hint");

	await expectThrow(() => run(read, { path: "missing.txt" }), "ENOENT", "F: missing file throws");
	await expectThrow(() => run(read, { path: "nested" }), "EISDIR", "F: directory read throws");

	// Minimal-but-valid PNG: signature + IHDR chunk (13 bytes) + CRC.
	const pngBytes = new Uint8Array(33);
	pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	const view = new DataView(pngBytes.buffer);
	view.setUint32(8, 13, false);
	pngBytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
	view.setUint32(16, 1, false); // width
	view.setUint32(20, 1, false); // height
	pngBytes.set([8, 6, 0, 0, 0], 24); // bit depth, color type, compression, filter, interlace
	await env.writeFile("img.png", pngBytes, BACKGROUND_CONTEXT);
	const png = await run(read, { path: "img.png" });
	check(
		png.content.length === 2 &&
			png.content[0]?.type === "text" && png.content[0].text.includes("image/png") &&
			png.content[1]?.type === "image" && typeof png.content[1].data === "string",
		"F: PNG detected and returned as base64 image content",
	);
	await env.writeFile("img.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), BACKGROUND_CONTEXT);
	const jpg = await run(read, { path: "img.jpg" });
	check(textOf(jpg).includes("image/jpeg"), "F: JPEG magic detected");
	await env.writeFile("img.gif", new TextEncoder().encode("GIF89a......"), BACKGROUND_CONTEXT);
	const gif = await run(read, { path: "img.gif" });
	check(textOf(gif).includes("image/gif"), "F: GIF magic detected");
}

// ---- Scenario G: write tool ----
{
	console.log("--- scenario G: write tool ---");
	const first = await run(write, { path: "g/one.txt", content: "one" });
	check(textOf(first).includes("Successfully wrote to g/one.txt"), "G: nested write succeeds with confirmation");
	await run(write, { path: "g/one.txt", content: "two" });
	const back = await env.readTextFile("g/one.txt", BACKGROUND_CONTEXT);
	check(back.ok && back.value === "two", "G: second write overwrites");
}

// ---- Scenario H: edit tool ----
{
	console.log("--- scenario H: edit tool ---");
	const put = async (name: string, content: string) => {
		await run(write, { path: name, content });
		return name;
	};

	await put("e1.txt", "alpha\nbeta\n");
	await expectThrow(
		() => run(edit, { path: "e1.txt", edits: [{ oldText: "gamma", newText: "x" }] }),
		"Could not find the exact text in e1.txt",
		"H: not-found error names the file",
	);
	await put("e2.txt", "dup\ndup\n");
	await expectThrow(
		() => run(edit, { path: "e2.txt", edits: [{ oldText: "dup", newText: "x" }] }),
		"Found 2 occurrences of the text in e2.txt. The text must be unique",
		"H: ambiguous match refuses to edit",
	);
	await expectThrow(
		() => run(edit, { path: "e1.txt", edits: [{ oldText: "", newText: "x" }] }),
		"oldText must not be empty",
		"H: empty oldText rejected",
	);
	await expectThrow(
		() => run(edit, { path: "e1.txt", edits: [{ oldText: "alpha", newText: "alpha" }] }),
		"No changes made to e1.txt",
		"H: no-op edit rejected",
	);
	// Edits match the ORIGINAL content: the second edit targets text that only
	// exists after the first edit is applied, so it must fail.
	await expectThrow(
		() =>
			run(edit, {
				path: "e1.txt",
				edits: [
					{ oldText: "alpha", newText: "omega" },
					{ oldText: "omega", newText: "zeta" },
				],
			}),
		"Could not find edits[1]",
		"H: edits match the original, not incrementally",
	);
	await put("e3.txt", "abcd\n");
	await expectThrow(
		() =>
			run(edit, {
				path: "e3.txt",
				edits: [
					{ oldText: "abc", newText: "x" },
					{ oldText: "bcd", newText: "y" },
				],
			}),
		"edits[0] and edits[1] overlap",
		"H: overlapping edits rejected",
	);

	await put("crlf.txt", "one\r\ntwo\r\n");
	await run(edit, { path: "crlf.txt", edits: [{ oldText: "two", newText: "TWO" }] });
	const crlf = await env.readTextFile("crlf.txt", BACKGROUND_CONTEXT);
	const crlfValue = crlf.ok ? crlf.value : `<error: ${crlf.error.code}>`;
	check(crlfValue === "one\r\nTWO\r\n", `H: CRLF endings preserved (${JSON.stringify(crlfValue)})`);

	await put("bom.txt", "\uFEFFhello\n");
	await run(edit, { path: "bom.txt", edits: [{ oldText: "hello", newText: "world" }] });
	const bom = await env.readTextFile("bom.txt", BACKGROUND_CONTEXT);
	check(bom.ok && bom.value === "\uFEFFworld\n", "H: BOM preserved");

	await put("e4.txt", "keep old\n");
	const jsonEdits = edit.prepareArguments?.({ path: "e4.txt", edits: JSON.stringify([{ oldText: "old", newText: "new" }]) });
	await run(edit, jsonEdits);
	const e4 = await env.readTextFile("e4.txt", BACKGROUND_CONTEXT);
	check(e4.ok && e4.value === "keep new\n", "H: JSON-string edits accepted via prepareArguments");

	await put("e5.txt", "legacy body\n");
	const legacy = edit.prepareArguments?.({ path: "e5.txt", oldText: "legacy", newText: "modern" });
	await run(edit, legacy);
	const e5 = await env.readTextFile("e5.txt", BACKGROUND_CONTEXT);
	check(e5.ok && e5.value === "modern body\n", "H: legacy top-level oldText/newText coerced to edits");

	await expectThrow(() => run(edit, { path: "nested", edits: [{ oldText: "x", newText: "y" }] }), "Path is not a file", "H: directory target rejected");

	await put("e6.txt", "a\nb\nc\n");
	const detailed = await run(edit, { path: "e6.txt", edits: [{ oldText: "b", newText: "B" }] });
	const editDetails = detailed.details as { diff: string; patch: string; firstChangedLine?: number } | undefined;
	check(
		editDetails !== undefined &&
			editDetails.diff.includes("-2 b") && editDetails.diff.includes("+2 B") &&
			editDetails.patch.includes("--- e6.txt") && editDetails.patch.includes("+++ e6.txt") &&
			editDetails.firstChangedLine === 2,
		"H: details carry diff, unified patch, and first changed line",
	);
}

rmSync(workspace, { recursive: true, force: true });
console.log(failures === 0 ? "\nENV VERIFY OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
