/**
 * Skills demo, keyless: loads this repo's example skill, renders the
 * system-prompt block, and shows an explicit invocation. The full Agent
 * integration is two lines, printed at the end.
 * Run: node examples/skill-demo.ts
 */
import { findSkill, invokeSkill, loadSkills, skillPromptSection } from "pico-agent";

const { skills, errors } = await loadSkills({ project: "examples/skills" });
for (const error of errors) console.error(`skill skipped: ${error.path} — ${error.reason}`);

console.log(`loaded ${skills.length} skill(s): ${skills.map((skill) => skill.name).join(", ")}`);
console.log("\n--- system-prompt block (append to your systemPrompt) ---\n");
console.log(skillPromptSection(skills));

const invocation = invokeSkill(skills, "pdf");
console.log('\n--- invokeSkill(skills, "pdf") — prompt head ---\n');
console.log(invocation === undefined ? "(not found)" : `${invocation.prompt.slice(0, 400)}…`);

console.log(`\nfindSkill(skills, "pdf") → ${findSkill(skills, "pdf")?.filePath ?? "(not found)"}`);
console.log("\n--- the whole Agent integration ---\n");
console.log(`const systemPrompt = basePrompt + "\\n" + skillPromptSection(skills);`);
console.log("const agent = new Agent({ initialState: { systemPrompt, model, tools }, streamFn });");
console.log("// That's it: the model now sees the skill list and reads SKILL.md files itself.");
