/**
 * Skills regression, keyless. Asserts the loader, parser, renderer, and the
 * lookup/invocation helpers:
 *   A (discovery): user and project roots, project-wins on name collision,
 *      name defaults to the directory name, hidden directories ignored,
 *      missing roots are empty-not-error, extra files ignored, paths absolute.
 *   B (parsing): bare/quoted single-line descriptions, | and > block scalars
 *      (chomping indicators |-/>- and combined |2- included), CRLF files, a
 *      block scalar followed by another key, an indented --- inside a block
 *      scalar staying content, whitespace-only name/description rejected,
 *      unknown keys and nested maps ignored, unterminated frontmatter and a
 *      missing description are errors that skip only that skill.
 *   C (rendering): exact XML block shape, XML escaping, deterministic name
 *      sorting, disableModelInvocation excluded, empty list renders "".
 *   D (lookup/invocation): findSkill exact match including hidden skills,
 *      invokeSkill returns the body as the prompt, unknown names undefined.
 *   E (agent wiring): the rendered block appended to a systemPrompt is
 *      visible to the model — the transcript context the stream function
 *      receives carries it in the leading system message.
 *   F (demo skill): this repo's examples/skills/pdf/SKILL.md parses and
 *      renders — guards the demo's own format.
 *   G (filesystem layout): same-root duplicate names error deterministically
 *      (first by path wins), symlinked skill directories load, broken
 *      symlinks are skipped silently, an unreadable SKILL.md (e.g. a
 *      directory) reports the read failure instead of "no SKILL.md", and the
 *      same directory passed as both roots scans once.
 * Run: node examples/verify-skills.ts
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	EventStream,
	createUnavailableModel,
	findSkill,
	invokeSkill,
	loadSkills,
	skillPromptSection,
	type AgentModel,
	type AssistantMessage,
	type StreamFn,
	type TranscriptContext,
} from "pico-agent";

let failures = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failures++;
};

async function makeSkillsRoot(prefix: string, skills: Record<string, string | undefined>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `pico-skills-${prefix}-`));
	for (const [dir, frontmatterAndBody] of Object.entries(skills)) {
		if (frontmatterAndBody === undefined) {
			await mkdir(join(root, dir), { recursive: true });
			continue;
		}
		await mkdir(join(root, dir), { recursive: true });
		await writeFile(join(root, dir, "SKILL.md"), frontmatterAndBody, "utf8");
	}
	return root;
}

// ---- Scenario A: discovery ----
{
	console.log("--- scenario A: discovery ---");
	const userRoot = await makeSkillsRoot("user", {
		shared: "---\ndescription: user version\n---\nuser body",
		useronly: "---\ndescription: lives in user root\n---\nuser-only body",
	});
	const projectRoot = await makeSkillsRoot("project", {
		shared: "---\ndescription: project version wins\n---\nproject body",
		projectonly: "---\ndescription: lives in project root\n---\nproject-only body",
		noname: "---\ndescription: name defaults to directory\n---\nbody",
		".hidden": "---\ndescription: must be ignored\n---\nbody",
		emptydir: undefined,
		withextrafiles: "---\ndescription: extra files ignored\n---\nbody",
	});
	await writeFile(join(projectRoot, "withextrafiles", "helper.sh"), "echo hi", "utf8");
	try {
		const { skills, errors } = await loadSkills({ project: projectRoot, user: userRoot });
		const names = skills.map((skill) => skill.name);
		check(
			names.join(",") === "noname,projectonly,shared,useronly,withextrafiles",
			"A: both roots loaded, sorted by name, hidden dir ignored",
		);
		const shared = findSkill(skills, "shared");
		check(shared?.description === "project version wins", "A: project root wins a name collision");
		check(findSkill(skills, "noname") !== undefined, "A: missing name defaults to the directory name");
		check(
			skills.every((skill) => skill.filePath.startsWith("/")),
			"A: file paths are absolute",
		);
		check(
			errors.length === 1 && errors[0]!.path === join(projectRoot, "emptydir") && errors[0]!.reason.includes("no SKILL.md"),
			"A: a directory without SKILL.md is reported, not silently dropped",
		);
		const missing = await loadSkills({ project: join(projectRoot, "does-not-exist"), user: join(userRoot, "also-missing") });
		check(missing.skills.length === 0 && missing.errors.length === 0, "A: missing roots are empty, not errors");
	} finally {
		await rm(userRoot, { recursive: true, force: true });
		await rm(projectRoot, { recursive: true, force: true });
	}
}

// ---- Scenario B: frontmatter parsing ----
{
	console.log("--- scenario B: frontmatter parsing ---");
	const root = await makeSkillsRoot("parse", {
		quoted: '---\nname: "quoted name"\ndescription: "a quoted description"\n---\nbody quoted',
		literal: "---\ndescription: |\n  first line\n  second line\n---\nbody literal",
		folded: "---\ndescription: >\n  folded into\n  one line\n---\nbody folded",
		chompliteral: "---\ndescription: |-\n  chomped literal\n---\nbody",
		chompfolded: "---\ndescription: >-\n  chomped folded\n---\nbody",
		comboidx: "---\ndescription: |2-\n  indented chomp\n---\nbody",
		crlf: "---\r\nname: crlf\r\ndescription: windows line endings\r\n---\r\nbody crlf",
		blockthenkey: "---\ndescription: |\n  block desc\nname: after-block\n---\nbody",
		blockhr:
			"---\ndescription: |\n  Generates skills. Format:\n  ---\n  name: x\n  description: y\n  ---\n  Write it like that.\n---\nreal body",
		descblank: '---\ndescription: "   "\n---\nbody',
		nameblank: '---\nname: "   "\ndescription: real desc\n---\nbody',
		unknownkeys:
			'---\nname: unk\nmetadata:\n  author: Someone\n  version: "1.0"\nlicense: MIT\ndescription: has other keys too\n---\nbody unknown',
		unterminated: "---\nname: broken\ndescription: never closed",
		nofm: "# just markdown, no frontmatter\nbody",
		nodesc: "---\nname: descless\n---\nbody",
	});
	try {
		const { skills, errors } = await loadSkills({ project: root, user: join(root, "missing") });
		check(findSkill(skills, "quoted name")?.description === "a quoted description", "B: quoted values unquoted");
		check(findSkill(skills, "literal")?.description === "first line\nsecond line", "B: | block scalar keeps line breaks");
		check(findSkill(skills, "folded")?.description === "folded into one line", "B: > block scalar folds to spaces");
		check(findSkill(skills, "chompliteral")?.description === "chomped literal", "B: |- chomping indicator parses as a block scalar");
		check(findSkill(skills, "chompfolded")?.description === "chomped folded", "B: >- chomping indicator parses as a block scalar");
		check(findSkill(skills, "comboidx")?.description === "indented chomp", "B: combined |2- indicator parses as a block scalar");
		check(
			findSkill(skills, "crlf")?.description === "windows line endings" && findSkill(skills, "crlf")?.content === "body crlf",
			"B: CRLF files parse like LF files",
		);
		check(
			findSkill(skills, "after-block")?.description === "block desc" && findSkill(skills, "after-block")?.name === "after-block",
			"B: a block scalar ends at the next top-level key",
		);
		check(
			findSkill(skills, "blockhr")?.description ===
				"Generates skills. Format:\n---\nname: x\ndescription: y\n---\nWrite it like that." &&
				findSkill(skills, "blockhr")?.content === "real body",
			"B: an indented --- inside a block scalar is content, not a delimiter",
		);
		check(
			findSkill(skills, "nameblank")?.description === "real desc",
			"B: a whitespace-only name falls back to the directory name",
		);
		check(
			findSkill(skills, "unk")?.description === "has other keys too",
			"B: unknown keys and nested maps ignored without breaking the parse",
		);
		check(findSkill(skills, "literal")?.content === "body literal", "B: body is everything after the closing ---");
		const reasons = new Map(errors.map((error) => [error.path, error.reason]));
		check(
			reasons.get(join(root, "descblank", "SKILL.md"))?.includes("description") === true,
			"B: a whitespace-only description is rejected like a missing one",
		);
		check(
			reasons.get(join(root, "unterminated", "SKILL.md"))?.includes("not closed") === true,
			"B: unterminated frontmatter is an error",
		);
		check(
			reasons.get(join(root, "nofm", "SKILL.md"))?.includes("frontmatter") === true,
			"B: a file without frontmatter is an error",
		);
		check(
			reasons.get(join(root, "nodesc", "SKILL.md"))?.includes("description") === true,
			"B: a missing description is an error (a skill must be discoverable)",
		);
		check(skills.length === 11 && errors.length === 4, "B: bad files skip only themselves");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

// ---- Scenario C: prompt rendering ----
{
	console.log("--- scenario C: prompt rendering ---");
	const skills = [
		{ name: "zeta", description: "last alphabetically", content: "z", filePath: "/skills/zeta/SKILL.md" },
		{ name: "alpha", description: 'first & <fast>, triggers like "make a PDF"', content: "a", filePath: "/skills/alpha/SKILL.md" },
		{ name: "hidden", description: "not model-visible", content: "h", filePath: "/skills/hidden/SKILL.md", disableModelInvocation: true },
	];
	const section = skillPromptSection(skills);
	check(
		section.startsWith("<skills>\n") &&
			section.includes('<skill name="alpha" path="/skills/alpha/SKILL.md">\n    first &amp; &lt;fast&gt;, triggers like "make a PDF"\n  </skill>'),
		"C: exact XML entry shape with escaping",
	);
	check(section.indexOf('name="alpha"') < section.indexOf('name="zeta"'), "C: entries sorted by name");
	check(!section.includes("hidden"), "C: disableModelInvocation skills excluded");
	check(
		section.endsWith("</skills>\nBefore using a skill, read its SKILL.md at the listed path with the read tool and follow it completely."),
		"C: block ends with the read-first instruction",
	);
	check(skillPromptSection([]) === "", "C: empty list renders an empty string (safe to append)");
	check(skillPromptSection(skills) === skillPromptSection([...skills].reverse()), "C: rendering is order-independent");
}

// ---- Scenario D: lookup and explicit invocation ----
{
	console.log("--- scenario D: lookup and invocation ---");
	const skills = [
		{ name: "pdf", description: "pdf work", content: "PDF INSTRUCTIONS", filePath: "/skills/pdf/SKILL.md" },
		{ name: "secret", description: "hidden", content: "SECRET INSTRUCTIONS", filePath: "/skills/secret/SKILL.md", disableModelInvocation: true },
	];
	check(findSkill(skills, "pdf")?.filePath === "/skills/pdf/SKILL.md", "D: findSkill matches exactly");
	check(findSkill(skills, "secret") !== undefined, "D: findSkill reaches hidden skills");
	check(findSkill(skills, "PDF") === undefined, "D: matching is case-sensitive (names are exact)");
	const invocation = invokeSkill(skills, "secret");
	check(invocation?.prompt === "SECRET INSTRUCTIONS" && invocation.skill.name === "secret", "D: invokeSkill returns the body as the prompt");
	check(invokeSkill(skills, "nope") === undefined, "D: unknown name returns undefined");
}

// ---- Scenario E: the block is model-visible through a real Agent ----
{
	console.log("--- scenario E: agent wiring smoke ---");
	const root = await makeSkillsRoot("agent", {
		pdf: "---\ndescription: pdf production for tests\n---\nreal skill body",
	});
	try {
		const { skills } = await loadSkills({ project: root, user: join(root, "missing") });
		const fakeModel: AgentModel = { ...createUnavailableModel(), id: "mock", provider: "mock" };
		let seenSystemPrompt = "";
		const stream: StreamFn = (_model, context: TranscriptContext) => {
			const first = context.messages[0] as { role: string; content: unknown } | undefined;
			if (first?.role !== "system") seenSystemPrompt = "";
			else if (typeof first.content === "string") seenSystemPrompt = first.content;
			else if (Array.isArray(first.content))
				seenSystemPrompt = first.content
					.map((block) => (block as { text?: string }).text ?? "")
					.join("\n");
			else seenSystemPrompt = "";
			const reply: AssistantMessage = {
				role: "assistant",
				api: "langchain-scripted",
				provider: "mock",
				model: "mock",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				timestamp: Date.now(),
				content: [{ type: "text", text: "seen" }],
				stopReason: "stop",
			};
			const events = new EventStream<never, never>(
				(e) => (e as { type: string }).type === "done",
				() => undefined as never,
			);
			void (async () => {
				events.push({ type: "start", partial: reply } as never);
				events.push({ type: "message", message: reply } as never);
				events.push({ type: "done", message: reply, stopReason: "stop" } as never);
				events.end();
			})();
			return events as never;
		};
		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a test agent.\n" + skillPromptSection(skills),
				model: fakeModel,
				tools: [],
			},
			streamFn: stream,
		});
		await agent.prompt("hello");
		check(
			seenSystemPrompt.includes("<skills>") &&
				seenSystemPrompt.includes('name="pdf"') &&
				seenSystemPrompt.includes("read its SKILL.md"),
			"E: the stream function saw the skills block in the system message",
		);
		check(seenSystemPrompt.startsWith("You are a test agent."), "E: the block appends to, not replaces, the base prompt");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

// ---- Scenario F: this repo's demo skill stays valid ----
{
	console.log("--- scenario F: demo skill ---");
	const { skills, errors } = await loadSkills({ project: join(import.meta.dirname, "skills") });
	check(errors.length === 0, "F: the demo skill parses without errors");
	const pdf = findSkill(skills, "pdf");
	check(
		pdf !== undefined &&
			pdf.description.includes("PDF") &&
			pdf.content.includes("pandoc") &&
			pdf.filePath.endsWith(join("examples", "skills", "pdf", "SKILL.md")),
		"F: the demo pdf skill loads with name, description, and routed body",
	);
	check(invokeSkill(skills, "pdf") !== undefined, "F: the demo skill is explicitly invocable");
}

// ---- Scenario G: filesystem layout edges ----
{
	console.log("--- scenario G: filesystem layout ---");
	const root = await makeSkillsRoot("fs", {
		"dup-a": "---\nname: twin\ndescription: first by path\n---\nA",
		"dup-b": "---\nname: twin\ndescription: second by path\n---\nB",
	});
	// SKILL.md occupied by a directory: readFile fails with EISDIR, not ENOENT.
	await mkdir(join(root, "curious", "SKILL.md"), { recursive: true });
	// A real skill outside the root, linked in (explicit name: the default
	// would be the link's directory name).
	const outside = await makeSkillsRoot("outside", { real: "---\nname: linked\ndescription: via symlink\n---\nlinked" });
	await symlink(join(outside, "real"), join(root, "linked-skill"));
	// A broken symlink — skipped silently.
	await symlink(join(root, "does-not-exist"), join(root, "broken-link"));
	try {
		const { skills, errors } = await loadSkills({ project: root, user: join(root, "missing") });
		check(
			findSkill(skills, "twin")?.description === "first by path" &&
				errors.some((error) => error.reason.includes("duplicate skill name") && error.path.endsWith(join("dup-b", "SKILL.md"))),
			"G: same-root duplicate names error; the first by path wins deterministically",
		);
		check(findSkill(skills, "linked")?.description === "via symlink", "G: a symlinked skill directory loads");
		check(
			errors.some((error) => error.path === join(root, "curious") && error.reason.includes("cannot read SKILL.md")),
			"G: an unreadable SKILL.md reports the read failure, not 'no SKILL.md'",
		);
		check(
			skills.length === 2 && !errors.some((error) => error.path.includes("broken-link")),
			"G: a broken symlink is skipped silently",
		);
		const sameRoots = await loadSkills({ project: root, user: root });
		check(
			sameRoots.skills.length === skills.length && sameRoots.errors.length === errors.length,
			"G: the same directory as both roots scans once (no phantom duplicates)",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
}

console.log(failures === 0 ? "\nSKILLS VERIFY OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
