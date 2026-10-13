# Skills — `loadSkills`, `skillPromptSection`

Progressive-disclosure skill loading. Each skill is a directory with a `SKILL.md`: the system prompt gets only the skill's name, path, and description; the full instructions are read by the model with the read tool only when it decides to use the skill. Ten skills cost ten short prompt lines, not ten documents. No new tools are introduced — skills ride the read tool the agent already has.

## The SKILL.md format

```markdown
---
name: pdf                       # optional; defaults to the directory name
description: |                  # required, non-empty — the only discovery signal
  Build PDFs from Markdown or LaTeX, and process existing PDFs
  (extract, merge, split). Use when the final output is a PDF.
license: MIT                    # every other key is ignored (version, metadata, ...)
---

# PDF production

Instructions for the model start here, after the closing ---.
```

The frontmatter parser is deliberately minimal — no YAML dependency. It handles `key: value` lines (values may be quoted), `|` (literal, line breaks kept) and `>` (folded to spaces) block scalars for `description` — chomping and explicit-indent indicators in any combination (`|-`, `>+`, `|2`, `|2-`) included — reads CRLF and LF files alike, and ignores unknown keys including indented nested maps under them. Delimiters must sit at column 0, so an indented `---` inside a description block is content (matching YAML). A whitespace-only `name` falls back to the directory name; a whitespace-only `description` is rejected. A file that is not valid frontmatter, or has no non-empty `description`, is skipped with an error — a skill without a description cannot be discovered.

## Loading

```typescript
import { loadSkills } from "pico-agent";

const { skills, errors } = await loadSkills();
// defaults: project root ./.pico/skills, user root ~/.pico/skills

const { skills, errors } = await loadSkills({
	project: "examples/skills",   // optional override
	user: "/etc/pico/skills",     // optional override
});
```

- Two roots, both optional. A **missing root loads nothing** — an empty skills setup is a normal state, not an error. The same directory as both roots (e.g. running from `$HOME`, where `<cwd>/.pico/skills` is `~/.pico/skills`) is scanned once.
- Same-name skills across roots collide: the **project root wins** (specific beats general). The same name twice in **one** root is a configuration error: the first (by path) loads, the duplicate lands in `errors`.
- `skills` is sorted by name (deterministic prompts, stable tests).
- `errors` is `{ path, reason }[]` — a directory without a `SKILL.md`, an unreadable `SKILL.md` (reported with the OS error code), an unterminated frontmatter block, a missing description, a duplicate name. One bad file never fails the load; the rest load.
- Hidden directories (`.git`, …) and non-directories are skipped. Symlinked skill directories are followed (a common install layout); broken links are skipped silently.
- `skill.filePath` is absolute, so the model can read it from any cwd.

## Rendering into the system prompt

```typescript
import { Agent, skillPromptSection } from "pico-agent";

const { skills } = await loadSkills();
const agent = new Agent({
	initialState: {
		systemPrompt: basePrompt + "\n" + skillPromptSection(skills),
		model,
		tools: [read, write, bash, edit],
	},
	streamFn,
});
```

That is the whole integration. The rendered block:

```xml
<skills>
  <skill name="pdf" path="/abs/path/examples/skills/pdf/SKILL.md">
    Build PDFs from Markdown or LaTeX, and process existing PDFs (extract,
merge, split). Use when the final output is a PDF.
  </skill>
</skills>
Before using a skill, read its SKILL.md at the listed path with the read tool and follow it completely.
```

Entries are sorted by name and XML-escaped. Skills are **not enabled by default** — nothing loads or renders until the host calls `loadSkills` and appends `skillPromptSection`. An empty (or fully hidden) list renders `""`, so appending is always safe.

## Lookup and explicit invocation

```typescript
import { findSkill, invokeSkill } from "pico-agent";

const pdf = findSkill(skills, "pdf");        // exact, case-sensitive match | undefined
const invocation = invokeSkill(skills, "pdf");
if (invocation) {
	// invocation.skill     — the matched Skill
	// invocation.prompt    — the full SKILL.md body; use as the prompt for one
	//                        agent turn (host-side command routing, subagents)
	await worker.prompt(invocation.prompt);
}
```

Model-side usage needs none of this — the model sees the block and reads the file itself. `invokeSkill` is the host-side path: slash commands, pinned workflows, or dispatching a skill to a subagent.

## Hiding a skill from the model

`Skill.disableModelInvocation: true` excludes a skill from `skillPromptSection` while leaving it reachable through `findSkill`/`invokeSkill` — app-curated skills the host triggers deliberately. The file loader never sets it (a SKILL.md on disk is there to be discovered); hosts add it to loaded `Skill` objects or provide their own:

```typescript
const { skills } = await loadSkills();
const curated = skills.map((skill) =>
	skill.name === "internal-audit" ? { ...skill, disableModelInvocation: true } : skill,
);
```

## A runnable demo

`examples/skills/pdf/SKILL.md` is a complete skill (PDF production: pandoc/LaTeX routes, existing-PDF processing via pypdf), and `npm run skill-demo` exercises the whole path keylessly — load, render, invoke, and the Agent wiring. `examples/verify-skills.ts` covers the full matrix: discovery and precedence, frontmatter parsing, exact rendering, lookup, agent wiring, and the demo skill itself.

## Exports

`loadSkills`, `skillPromptSection`, `findSkill`, `invokeSkill`, `SkillDirs`, `SkillLoadResult`, `SkillLoadError`, `SkillInvocation` — plus the `Skill` type itself (see `types.ts`).
