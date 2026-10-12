/**
 * Utility-layer regression: ai/transcript replay helpers, json repair and
 * streaming parse, truncation math, shell output capture views, the chord
 * context primitives, token estimation, and validation coercion edge cases.
 * Pure functions — no LLM, no filesystem.
 *
 *   A json: repairJson escapes raw control characters, doubles invalid
 *     escapes, fixes a trailing lone backslash; parseJsonWithRepair
 *     round-trips; parseStreamingJson completes partials and never throws.
 *   B truncate: utf8ByteLength multibyte, formatSize tiers, truncateHead
 *     (head-keep, line limit, byte limit, oversized first line),
 *     truncateTail (tail-keep, partial line), truncateLine suffix.
 *   C output capture: snapshot text/totals, tail vs head retention, control
 *     character sanitization, spill path metadata, update diff kinds
 *     (replace/append/slide/metadata).
 *   D chord context: value chaining and shadowing, abort signal
 *     combining/clearing, withCancel independence, awaitWithContext
 *     resolution and abort rejection.
 *   E transcript: normalizeContext folding, initial/current system message
 *     replay with sections and tool deltas, collapseSystemMessages,
 *     getToolStateChanges add/remove/redefine, declarationsEqual JSON
 *     Schema comparison, toolJsonSchema dual form.
 *   F estimate: chars/4 token math, image block estimate, usage-anchored
 *     context estimate with stale-usage disqualification.
 *   G text: contentText join/skip, system message text rendering, section
 *     update rendering.
 *   H validation: coercion matrix (number/boolean/string/null, nested,
 *     arrays, unions), optional-null drop, error message shape with path and
 *     received-arguments echo, unknown tool error.
 * Run: node examples/verify-utils.ts
 */
import { z } from "zod";
import {
	BACKGROUND_CONTEXT,
	calculateContextTokens,
	contentText,
	createContextKey,
	createInitialSystemMessage,
	collapseSystemMessages,
	DEFAULT_MAX_LINES,
	declarationsEqual,
	estimateContextTokens,
	estimateMessageTokens,
	formatSize,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getDeclaredTools,
	getInitialSystemMessage,
	getSystemMessageText,
	getToolStateChanges,
	normalizeContext,
	OutputCapture,
	parseJsonWithRepair,
	parseStreamingJson,
	renderSystemMessageUpdate,
	repairJson,
	sanitizeShellOutput,
	applyShellOutputUpdate,
	toToolDeclaration,
	toolJsonSchema,
	truncateHead,
	truncateLine,
	truncateTail,
	utf8ByteLength,
	validateToolArguments,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
	awaitWithContext,
	BACKGROUND_CONTEXT as CTX,
	type Message,
	type ShellOutputUpdate,
	type ShellOutputView,
	type SystemMessage,
	type Tool,
	type ToolCall,
} from "pico-agent";

let failures = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

// ---- Scenario A: json repair and streaming parse ----
{
	console.log("--- scenario A: json repair ---");
	const rawControl = '{"text":"line1\nline2\ttab"}';
	check(JSON.parse(repairJson(rawControl)).text === "line1\nline2\ttab", "A: raw control characters escaped inside strings");
	const badEscape = '{"path":"C:\\Users\\x"}';
	const parsedBad = JSON.parse(repairJson(badEscape)) as { path: string };
	check(parsedBad.path === "C:\\Users\\x", `A: invalid escape doubled (${parsedBad.path})`);
	check(repairJson('{"a":"x\\') === '{"a":"x\\\\', "A: trailing lone backslash doubled");
	check((parseJsonWithRepair('{"b":"x\ty"}') as { b: string }).b === "x\ty", "A: parseJsonWithRepair repairs then parses");
	let threw = false;
	try {
		parseJsonWithRepair("not json at all");
	} catch {
		threw = true;
	}
	check(threw, "A: parseJsonWithRepair still throws on unrepairable input");

	check(parseStreamingJson('{"a":1,"b":2}').b === 2, "A: complete JSON parses directly");
	check(parseStreamingJson('{"a":1,"b":').a === 1, "A: partial JSON yields the completed prefix");
	check((parseStreamingJson('{"a":[1,2') as { a: unknown[] }).a.length === 2, "A: partial array yields completed elements");
	check(parseStreamingJson("").a === undefined && parseStreamingJson(undefined).b === undefined, "A: empty input yields empty object");
	check(parseStreamingJson("{invalid").a === undefined, "A: garbage yields empty object instead of throwing");
	check(parseStreamingJson('{"a":"unfinished\\nstr').a === "unfinished\nstr", "A: partial string with raw newline repaired and completed");
}

// ---- Scenario B: truncation math ----
{
	console.log("--- scenario B: truncation ---");
	check(utf8ByteLength("中文") === 6 && utf8ByteLength("abc") === 3, "B: utf8ByteLength counts multibyte runes");
	check(formatSize(512) === "512B" && formatSize(2048) === "2.0KB" && formatSize(3 * 1024 * 1024) === "3.0MB", "B: formatSize tiers");

	const small = truncateHead("a\nb\nc");
	check(small.truncated === false && small.content === "a\nb\nc" && small.totalLines === 3, "B: under-limit content passes through");

	const lines = Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n");
	const byLines = truncateHead(lines, { maxLines: 4, maxBytes: 1000 });
	check(
		byLines.truncated === true && byLines.truncatedBy === "lines" && byLines.content === "L0\nL1\nL2\nL3" && byLines.totalLines === 10,
		"B: truncateHead keeps the first lines under a line limit",
	);

	const wide = Array.from({ length: 4 }, () => "x".repeat(30)).join("\n");
	const byBytes = truncateHead(wide, { maxLines: 10, maxBytes: 65 });
	check(
		byBytes.truncated === true &&
			byBytes.truncatedBy === "bytes" &&
			byBytes.content === `${"x".repeat(30)}\n${"x".repeat(30)}` &&
			byBytes.outputBytes === 61,
		"B: truncateHead stops before exceeding the byte budget",
	);

	const hugeFirst = truncateHead("y".repeat(100), { maxLines: 5, maxBytes: 50 });
	check(
		hugeFirst.truncated === true && hugeFirst.firstLineExceedsLimit === true && hugeFirst.content === "",
		"B: oversized first line flagged with empty content",
	);

	const tail = truncateTail("L0\nL1\nL2\nL3\nL4", { maxLines: 2, maxBytes: 1000 });
	check(tail.truncated === true && tail.content === "L3\nL4", "B: truncateTail keeps the last lines");

	const tailPartial = truncateTail("y".repeat(100), { maxLines: 2, maxBytes: 50 });
	check(
		tailPartial.truncated === true && tailPartial.lastLinePartial === true && tailPartial.content.length === 50,
		"B: truncateTail returns a byte-aligned partial line",
	);

	const cut = truncateLine("a".repeat(600));
	check(cut.wasTruncated === true && cut.text.endsWith("... [truncated]") && cut.text.length === 500 + "... [truncated]".length, "B: truncateLine caps at 500 chars with suffix");
	check(truncateLine("short").wasTruncated === false, "B: truncateLine passes short lines through");
	check(DEFAULT_MAX_LINES === 2000, "B: default line limit is 2000");
}

// ---- Scenario C: output capture ----
{
	console.log("--- scenario C: output capture ---");
	const capture = new OutputCapture({ limits: { maxLines: 3, maxBytes: 1000, retain: "tail" } }, CTX, {
		onError: () => {},
	});
	capture.push("one\ntwo\n");
	capture.push("three\nfour\n");
	const snap = capture.snapshot();
	check(snap.text === "two\nthree\nfour" && snap.truncation.truncated === true && snap.truncation.totalLines === 4,
		`C: tail retention keeps last lines with totals (${JSON.stringify(snap.text)})`);
	capture.dispose();

	const head = new OutputCapture({ limits: { maxLines: 2, maxBytes: 1000, retain: "head" } }, CTX, { onError: () => {} });
	head.push("a\nb\nc\n");
	const headSnap = head.snapshot();
	check(headSnap.text === "a\nb" && headSnap.truncation.totalLines === 3, "C: head retention keeps first lines");
	head.dispose();

	check(sanitizeShellOutput("vis\x00ible\x07").includes("visible") && !sanitizeShellOutput("x\x00y").includes("\x00"), "C: control characters sanitized");

	const updates: ShellOutputUpdate[] = [];
	const flushing = new OutputCapture({ limits: { maxLines: 10, maxBytes: 1000 } }, CTX, {
		onUpdate: (update) => updates.push(update),
		onError: () => {},
	});
	flushing.push("hello\n");
	flushing.flush();
	check(updates.length >= 1 && (updates[0]?.kind === "replace" || updates[0]?.kind === "append"), "C: flush emits at least one update");
	flushing.setSpillPath("/tmp/spill-test.log");
	const spillUpdate = updates[updates.length - 1] as
		| { kind: string; metadata?: { spillPath?: string }; output?: { spillPath?: string } }
		| undefined;
	check(
		spillUpdate?.metadata?.spillPath === "/tmp/spill-test.log" || spillUpdate?.output?.spillPath === "/tmp/spill-test.log",
		`C: setSpillPath flushes with the spill path in metadata (${spillUpdate?.kind})`,
	);
	flushing.dispose();

	const base: ShellOutputView = {
		text: "aaabbb",
		truncation: { truncated: false, truncatedBy: null, totalLines: 1, totalBytes: 6, outputLines: 1, outputBytes: 6, lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 10, maxBytes: 1000 },
	};
	const metaOf = (totalLines: number) => ({ truncation: { ...base.truncation, totalLines } });
	const appended = applyShellOutputUpdate(base, { kind: "append", text: "ccc", metadata: metaOf(2) });
	check(appended.text === "aaabbbccc", "C: append update concatenates");
	const slid = applyShellOutputUpdate(base, { kind: "slide", drop: 3, text: "xyz", metadata: metaOf(3) });
	check(slid.text === "bbbxyz", "C: slide update drops the prefix");
	const meta = applyShellOutputUpdate(base, { kind: "metadata", metadata: metaOf(9) });
	check(meta.text === "aaabbb" && meta.truncation.totalLines === 9, "C: metadata update keeps text");
	const replaced = applyShellOutputUpdate(undefined, { kind: "replace", output: { ...base, text: "fresh" } });
	check(replaced.text === "fresh", "C: replace update swaps the view");
}

// ---- Scenario D: chord context ----
{
	console.log("--- scenario D: chord context ---");
	const keyA = createContextKey<string>("verify.a");
	const keyB = createContextKey<number>("verify.b");
	const ctx = withContextValue(keyB, 2, withContextValue(keyA, "one", BACKGROUND_CONTEXT));
	check(ctx.value(keyA) === "one" && ctx.value(keyB) === 2 && BACKGROUND_CONTEXT.value(keyA) === undefined,
		"D: values chain and lookups miss on unrelated keys");
	const shadowed = withContextValue(keyA, "two", ctx);
	check(shadowed.value(keyA) === "two" && ctx.value(keyA) === "one", "D: later values shadow without mutating parents");
	check(BACKGROUND_CONTEXT.abortSignal === undefined, "D: background context carries no signal");

	const parent = new AbortController();
	const child = new AbortController();
	const combined = withAbortSignal(child.signal, withAbortSignal(parent.signal, BACKGROUND_CONTEXT));
	child.abort();
	check(combined.abortSignal?.aborted === true && parent.signal.aborted === false, "D: withAbortSignal combines; child abort does not abort parent");
	const cleared = withoutAbortSignal(withAbortSignal(parent.signal, BACKGROUND_CONTEXT));
	check(cleared.abortSignal === undefined, "D: withoutAbortSignal strips cancellation");

	const { context: cancelCtx, cancel } = withCancel(BACKGROUND_CONTEXT);
	cancel("done");
	check(cancelCtx.abortSignal?.aborted === true, "D: withCancel yields an independently cancellable context");

	const value = await awaitWithContext(Promise.resolve(42), BACKGROUND_CONTEXT);
	check(value === 42, "D: awaitWithContext passes values through");
	const rejector = new AbortController();
	const waiter = awaitWithContext(new Promise(() => {}), withAbortSignal(rejector.signal, BACKGROUND_CONTEXT));
	rejector.abort();
	let aborted = false;
	await waiter.catch((error: unknown) => {
		aborted = error instanceof Error || error instanceof DOMException;
	});
	check(aborted, "D: awaitWithContext rejects its waiter on abort");
	let immediate = false;
	await awaitWithContext(Promise.resolve(1), withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT)).catch(() => {
		immediate = true;
	});
	check(immediate, "D: pre-aborted context rejects immediately");
}

// ---- Scenario E: transcript replay ----
{
	console.log("--- scenario E: transcript replay ---");
	const toolA: Tool = { name: "alpha", description: "a", parameters: z.object({ x: z.number() }) };
	const toolB: Tool = { name: "beta", description: "b", parameters: z.object({ y: z.string() }) };

	const none = createInitialSystemMessage(undefined, []);
	check(none === undefined, "E: empty prompt and tools produce no system message");
	const seed = createInitialSystemMessage("Be brief.", [toolA]);
	check(seed?.role === "system" && seed.content === "Be brief." && seed.toolsAdded?.length === 1, "E: initial system message carries prompt and tools");

	const normalized = normalizeContext({ systemPrompt: "P", tools: [toolA], messages: [{ role: "user", content: "hi", timestamp: 1 }] });
	check(
		normalized.messages.length === 2 && normalized.messages[0]?.role === "system" && normalized.messages[1]?.role === "user",
		"E: normalizeContext folds prompt and tools into a leading system message",
	);
	const bare = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
	check(bare.messages.length === 1 && bare.messages[0]?.role === "user", "E: normalizeContext adds nothing when bare");

	const transcript: Message[] = [
		{ role: "system", content: "base", toolsAdded: [toolA], timestamp: 0 },
		{ role: "user", content: "q", timestamp: 1 },
		{ role: "system", content: "addendum", sections: { style: "terse", gone: null }, toolsAdded: [toolB], timestamp: 2 },
	];
	check(getInitialSystemMessage(transcript)?.content === "base", "E: getInitialSystemMessage returns the leading system message");

	const current = getCurrentSystemMessage(transcript);
	check(
		current?.content === "base\n\naddendum" && current.sections?.style === "terse" && current.sections?.gone === undefined,
		"E: replay appends content and patches sections (null removes)",
	);
	const names = getCurrentTools(transcript).map((t) => t.name);
	check(names.length === 2 && names.includes("alpha") && names.includes("beta"), "E: replay unions tool deltas in order");
	const removalTranscript: SystemMessage[] = [
		{ role: "system", content: "", toolsAdded: [toolA, toolB], timestamp: 0 },
		{ role: "system", content: "", toolsRemoved: [{ name: "alpha" }], timestamp: 1 },
	];
	const removed = getCurrentTools(removalTranscript).map((t) => t.name);
	check(removed.length === 1 && removed[0] === "beta", "E: toolsRemoved wins over earlier toolsAdded");

	const prompt = getCurrentSystemPrompt(transcript);
	check(prompt.includes("base") && prompt.includes("addendum") && prompt.includes("terse"), "E: getCurrentSystemPrompt renders content and sections");

	const collapsed = collapseSystemMessages(normalizeContext({ messages: [...transcript] }));
	check(
		collapsed.messages.filter((m) => m.role === "system").length === 1 && collapsed.messages[0]?.role === "system",
		"E: collapseSystemMessages leaves exactly one leading system message",
	);

	const declaredTranscript: SystemMessage[] = [{ role: "system", content: "", toolsAdded: [toolA], timestamp: 0 }];
	const declared = getDeclaredTools(declaredTranscript);
	check(declared.length === 1 && declared[0]?.name === "alpha", "E: getDeclaredTools collects definitions");

	const changed = getToolStateChanges([toolA], [toolA, toolB]);
	check(
		changed.toolsAdded.map((t) => t.name).join(",") === "beta" && changed.toolsRemoved.length === 0,
		"E: state change detects pure additions",
	);
	const redefined: Tool = { name: "alpha", description: "a2", parameters: z.object({ x: z.number() }) };
	const redefine = getToolStateChanges([toolA], [redefined]);
	check(
		redefine.toolsRemoved.some((t) => t.name === "alpha") && redefine.toolsAdded.some((t) => t.name === "alpha"),
		"E: a changed definition is a removal plus an addition",
	);
	check(declarationsEqual(toolA, { ...toolA }), "E: identical declarations compare equal");
	check(!declarationsEqual(toolA, redefined), "E: changed descriptions compare unequal");

	const stripped = toToolDeclaration({ ...toolA, label: "extra" } as Tool & { label: string });
	check(!("label" in stripped) && stripped.name === "alpha", "E: toToolDeclaration strips non-declaration fields");
	const plainSchema = { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false };
	check(toolJsonSchema(plainSchema) === plainSchema, "E: toolJsonSchema passes plain JSON Schema through by identity");
	check(toolJsonSchema(z.object({ n: z.number() })).type === "object", "E: toolJsonSchema converts zod to JSON Schema");
}

// ---- Scenario F: token estimation ----
{
	console.log("--- scenario F: estimation ---");
	check(calculateContextTokens({ input: 3, output: 4, cacheRead: 5, cacheWrite: 6, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }) === 18, "F: calculateContextTokens sums components when totalTokens is zero");
	check(calculateContextTokens({ input: 3, output: 4, cacheRead: 5, cacheWrite: 6, totalTokens: 99, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }) === 99, "F: calculateContextTokens prefers reported totalTokens");

	const userMsg = { role: "user", content: "123456789", timestamp: 0 } as Message;
	check(estimateMessageTokens(userMsg) === 3, "F: user text estimated at 4 chars per token");
	const imgMsg = { role: "user", content: [{ type: "text", text: "" }, { type: "image", data: "", mimeType: "image/png" }], timestamp: 0 } as Message;
	check(estimateMessageTokens(imgMsg) === 1200, "F: image blocks estimated at 4800 chars");

	const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const anchored: Message[] = [
		{ role: "user", content: "0123456789", timestamp: 0 },
		{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "a", provider: "p", model: "m", usage, stopReason: "stop", timestamp: 1 },
		{ role: "user", content: "0123456789", timestamp: 2 },
	];
	const est = estimateContextTokens(anchored);
	check(est.usageTokens === 110 && est.trailingTokens === 3 && est.tokens === 113 && est.lastUsageIndex === 1, "F: context estimate anchors on the latest applicable usage");

	// A message inserted before the assistant but carrying a newer timestamp (a
	// compaction summary) disqualifies the assistant's usage as a prefix anchor.
	const stale: Message[] = [
		{ role: "user", content: "0123456789", timestamp: 9 },
		{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "a", provider: "p", model: "m", usage, stopReason: "stop", timestamp: 1 },
	];
	const staleEst = estimateContextTokens(stale);
	check(
		staleEst.usageTokens === 0 && staleEst.lastUsageIndex === null && staleEst.tokens === 4,
		"F: usage older than a later inserted prefix is disqualified",
	);
	const zeroUsage = { ...usage, input: 0, output: 0, totalTokens: 0 };
	const zeroEst = estimateContextTokens([
		{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "a", provider: "p", model: "m", usage: zeroUsage, stopReason: "stop", timestamp: 5 },
		{ role: "user", content: "0123456789", timestamp: 1 },
	]);
	check(zeroEst.usageTokens === 0 && zeroEst.lastUsageIndex === null, "F: all-zero usage is not an anchor");
}

// ---- Scenario G: text rendering ----
{
	console.log("--- scenario G: text rendering ---");
	check(contentText("plain") === "plain", "G: contentText passes strings through");
	check(contentText([{ type: "text", text: "a" }, { type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "b" }]) === "a\nb", "G: contentText joins text blocks and skips images");
	check(contentText([{ type: "text", text: "a" }, { type: "text", text: "b" }], " | ") === "a | b", "G: contentText honors the separator");

	const system: SystemMessage = { role: "system", content: "core", sections: { extra: "more", removed: null }, timestamp: 0 };
	check(getSystemMessageText(system) === "core\n\nmore", "G: system text renders content then live sections");
	const update = renderSystemMessageUpdate({ role: "system", content: "note", sections: { style: "terse", gone: null }, timestamp: 1 });
	check(
		update.includes("note") && update.includes('Updated system prompt section "style":') && update.includes('Removed system prompt section "gone".'),
		"G: update rendering frames section changes",
	);
}

// ---- Scenario H: validation coercion matrix ----
{
	console.log("--- scenario H: validation ---");
	const call = (arguments_: Record<string, unknown>): ToolCall => ({ type: "toolCall", id: "t", name: "matrix", arguments: arguments_ as ToolCall["arguments"] });
	const schema = z.object({
		n: z.number(),
		b: z.boolean(),
		s: z.string(),
		opt: z.string().optional(),
		arr: z.array(z.number()),
		u: z.union([z.string(), z.number()]),
	});
	const tool: Tool = { name: "matrix", description: "", parameters: schema };
	const out = validateToolArguments(tool, call({ n: "42", b: 1, s: 5, arr: ["1", "2"], u: "keep" })) as {
		n: number; b: boolean; s: string; arr: number[]; u: string | number; opt?: string;
	};
	check(
		out.n === 42 && out.b === true && out.s === "5" && out.arr.length === 2 && out.arr[1] === 2 && out.u === "keep" && !("opt" in out),
		`H: primitives, arrays coerced; union passthrough; optional dropped (${JSON.stringify(out)})`,
	);
	const nested = z.object({ inner: z.object({ deep: z.number() }) });
	const nestedOut = validateToolArguments({ name: "nested", description: "", parameters: nested }, call({ inner: { deep: "7" } })) as { inner: { deep: number } };
	check(nestedOut.inner.deep === 7, "H: nested objects coerce recursively");

	let message = "";
	try {
		validateToolArguments({ name: "broken", description: "", parameters: z.object({ n: z.number() }) }, call({ n: "not-a-number" }));
	} catch (error) {
		message = error instanceof Error ? error.message : "";
	}
	check(
		message.startsWith('Validation failed for tool "matrix":') && message.includes("n:") && message.includes("Received arguments:"),
		"H: failure message carries tool call name, issue path, and received echo",
	);
	const enumTool: Tool = { name: "picker", description: "", parameters: z.object({ mode: z.enum(["read", "write"]) }) };
	let enumMessage = "";
	try {
		validateToolArguments(enumTool, call({ mode: "execute" }));
	} catch (error) {
		enumMessage = error instanceof Error ? error.message : "";
	}
	check(enumMessage.includes('Invalid option') && enumMessage.includes('"read"'), "H: enum failures list valid options");
}

console.log(failures === 0 ? "\nUTILS VERIFY OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
