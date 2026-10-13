// pico-agent: skills — progressive-disclosure skill loading and prompt rendering.
//
// Original to this SDK (the pi counterpart lives in pi's coding-agent
// application layer; only the Skill type surface is vendored in the harness).
//
// Model: SKILL.md files under skills roots expose name + description + path
// in the system prompt (an agentskills.io-style XML block); the full body is
// NOT injected — the model reads it with the read tool when it decides to use
// the skill, so N skills cost N short prompt lines, not N documents.

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Skill } from "./agent/harness/types.ts";

/** Skills roots to scan. Both are optional; missing roots load nothing. */
export interface SkillDirs {
	/** Project-level root. Default: `.pico/skills` under the process cwd. */
	project?: string;
	/** User-level root. Default: `~/.pico/skills`. */
	user?: string;
}

/** One skill that was skipped, and why. Loading never throws for a bad file. */
export interface SkillLoadError {
	/** The path that failed (a SKILL.md, or a directory missing one). */
	path: string;
	/** Human-readable reason: read failure, bad frontmatter, missing description. */
	reason: string;
}

export interface SkillLoadResult {
	/** Successfully parsed skills, sorted by name (deterministic output). */
	skills: Skill[];
	/** Everything skipped, in scan order. */
	errors: SkillLoadError[];
}

/** Result of an explicit skill invocation. */
export interface SkillInvocation {
	/** The matched skill. */
	skill: Skill;
	/** The skill's full instructions — use as the prompt for one agent turn. */
	prompt: string;
}

interface ParsedFrontmatter {
	name?: string;
	description?: string;
}

/** Join block-scalar lines: strip each line's leading whitespace, keep breaks for `|`, fold to spaces for `>`. */
function foldBlock(lines: string[], literal: boolean): string {
	return lines
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(literal ? "\n" : " ");
}

/**
 * Minimal frontmatter parser: `---`-delimited block of `key: value` lines.
 * Handles single-line values (quoted or bare), `|` (literal) and `>`
 * (folded) block scalars for `description` — chomping and explicit-indent
 * indicators (`|-`, `>+`, `|2`, `|2-`) included — and ignores every other
 * key, including indented continuation lines under unknown keys (nested
 * maps). CRLF and LF line endings are treated alike. Delimiters must sit at
 * column 0, so an indented `---` inside a block scalar is content, not a
 * closing marker (matching YAML).
 */
function parseFrontmatter(text: string): { parsed: ParsedFrontmatter; body: string } | { error: string } {
	// Split on CRLF too: JS regex `.` does not match "\r", so an unnormalized
	// CRLF line would fail every key match. Strip a leading BOM the same way.
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	const isDelimiter = (line: string) => /^---\s*$/.test(line);
	if (!isDelimiter(lines[0] ?? "")) return { error: "file must start with a --- frontmatter block" };
	const parsed: ParsedFrontmatter = {};
	let blockKey: "description" | null = null;
	let blockLiteral = false;
	let blockLines: string[] = [];
	let end = -1;
	const closeBlock = () => {
		if (blockKey !== null) parsed.description = foldBlock(blockLines, blockLiteral);
		blockKey = null;
		blockLines = [];
	};
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (isDelimiter(line)) {
			end = i;
			break;
		}
		if (/^\s/.test(line)) {
			if (blockKey !== null) blockLines.push(line);
			continue;
		}
		// A block scalar ends at the first non-indented line; fold it in.
		closeBlock();
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (match === null) continue;
		const key = match[1]!;
		const value = match[2]!.trim();
		if (key === "name") parsed.name = unquote(value);
		else if (key === "description") {
			// `|`/`>` with optional chomping ("-"/"+") and explicit-indent
			// indicators in either order (`|-`, `|2`, `|2-`, `|-2`).
			if (/^[|>](?:[+-]\d*|\d*[+-]?)$/.test(value)) {
				blockKey = "description";
				blockLiteral = value.startsWith("|");
			} else {
				parsed.description = unquote(value);
			}
		}
		// Every other top-level key is ignored (metadata, license, version…).
	}
	if (end === -1) return { error: "frontmatter block is not closed with ---" };
	closeBlock();
	return { parsed, body: lines.slice(end + 1).join("\n").trim() };
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}

async function loadRoot(rootInput: string, errors: SkillLoadError[]): Promise<Skill[]> {
	const root = resolve(rootInput); // Skill.filePath is documented as absolute.
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return []; // A missing root is a normal state, not an error.
	}
	const skills: Skill[] = [];
	// Sort by name: readdir order is arbitrary, and deterministic entries make
	// both same-root duplicate resolution and the errors array deterministic.
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		// Hidden directories (.git, .DS_Store droppings) are none of our business.
		if (entry.name.startsWith(".")) continue;
		const skillDir = join(root, entry.name);
		const skillPath = join(skillDir, "SKILL.md");
		// Symlinks to directories are a common install layout — follow them
		// (like pi's skill loader); broken links are skipped.
		let isDirectory = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			try {
				isDirectory = (await stat(skillDir)).isDirectory();
			} catch {
				continue;
			}
		}
		if (!isDirectory) continue;
		let text: string;
		try {
			text = await readFile(skillPath, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			errors.push({
				path: skillDir,
				reason: code === "ENOENT" ? "no SKILL.md in the skill directory" : `cannot read SKILL.md: ${code ?? String(error)}`,
			});
			continue;
		}
		const parsed = parseFrontmatter(text);
		if ("error" in parsed) {
			errors.push({ path: skillPath, reason: parsed.error });
			continue;
		}
		// A whitespace-only name falls back to the directory name (a quoted
		// "   " is not a name anyone can call); outer whitespace is trimmed.
		const parsedName = parsed.parsed.name?.trim() ?? "";
		const name = parsedName.length > 0 ? parsedName : entry.name;
		if (parsed.parsed.description === undefined || parsed.parsed.description.trim().length === 0) {
			// The description is the only model-visible discovery signal —
			// a skill without one cannot be discovered, so it is rejected.
			// (A quoted "   " is as invisible as no description at all.)
			errors.push({ path: skillPath, reason: "frontmatter must set a non-empty description" });
			continue;
		}
		skills.push({
			name,
			description: parsed.parsed.description,
			content: parsed.body,
			filePath: skillPath,
		});
	}
	// readdir order is arbitrary; sorting makes same-root duplicate-name
	// resolution in loadSkills deterministic (first by path wins, reported).
	skills.sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0,
	);
	return skills;
}

/**
 * Discover and parse skills. Scans the user root first, then the project
 * root; same-name skills across roots collide with project-wins precedence,
 * while the same name twice in ONE root is a configuration error (the first
 * by path loads, the duplicate lands in `errors`). One bad file never fails
 * the load — it lands in `errors` and the rest load.
 */
export async function loadSkills(dirs?: SkillDirs): Promise<SkillLoadResult> {
	const projectRoot = resolve(dirs?.project ?? join(process.cwd(), ".pico", "skills"));
	const userRoot = resolve(dirs?.user ?? join(homedir(), ".pico", "skills"));
	const errors: SkillLoadError[] = [];
	const byName = new Map<string, Skill>();
	const rootOf = new Map<string, string>(); // skill name → the root that contributed it
	// The same directory as both roots (e.g. running from $HOME, where
	// <cwd>/.pico/skills IS ~/.pico/skills) is one root: scanning it twice
	// would flag every skill as a same-root duplicate.
	const roots = userRoot === projectRoot ? [userRoot] : [userRoot, projectRoot];
	for (const root of roots) {
		for (const skill of await loadRoot(root, errors)) {
			if (rootOf.get(skill.name) === root) {
				errors.push({ path: skill.filePath, reason: `duplicate skill name "${skill.name}" in the same root` });
				continue;
			}
			rootOf.set(skill.name, root);
			byName.set(skill.name, skill);
		}
	}
	const skills = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return { skills, errors };
}

function escapeXmlAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Element text: quotes carry no meaning here, so they stay readable for the model. */
function escapeXmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Render the model-visible skills block for a system prompt: one short entry
 * per skill (name, path, description). The full instructions stay in the
 * SKILL.md files — the model reads one with the read tool when it decides to
 * use that skill. Skills with `disableModelInvocation` are excluded (they
 * remain reachable through {@link invokeSkill}). Returns "" for an empty or
 * fully hidden list, so appending is always safe.
 */
export function skillPromptSection(skills: readonly Skill[]): string {
	const visible = skills
		.filter((skill) => !skill.disableModelInvocation)
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	if (visible.length === 0) return "";
	const entries = visible.map(
		(skill) =>
			`  <skill name="${escapeXmlAttribute(skill.name)}" path="${escapeXmlAttribute(skill.filePath)}">\n    ${escapeXmlText(skill.description)}\n  </skill>`,
	);
	return [
		"<skills>",
		...entries,
		"</skills>",
		"Before using a skill, read its SKILL.md at the listed path with the read tool and follow it completely.",
	].join("\n");
}

/** Find a skill by exact name — includes skills hidden from the model. */
export function findSkill(skills: readonly Skill[], name: string): Skill | undefined {
	return skills.find((skill) => skill.name === name);
}

/**
 * Explicitly invoke a skill: its full instructions become the prompt for one
 * agent turn. This is the host-side path (command routing, `disableModelInvocation`
 * skills); model-side usage needs nothing — the model reads the file itself.
 * Returns undefined when the name matches no skill.
 */
export function invokeSkill(skills: readonly Skill[], name: string): SkillInvocation | undefined {
	const skill = findSkill(skills, name);
	return skill === undefined ? undefined : { skill, prompt: skill.content };
}
