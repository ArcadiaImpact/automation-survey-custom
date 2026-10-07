const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const root = __dirname;
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(`${root}/content.js`, "utf8"), sandbox);

const C = sandbox.window.CONTENT;
const html = fs.readFileSync(`${root}/index.html`, "utf8");
const inlineScript = html.match(/<script>\s*(const C = window\.CONTENT;[\s\S]*?)<\/script>/);
assert.ok(inlineScript, "survey inline script should be present");
assert.doesNotThrow(() => new vm.Script(inlineScript[1]));

assert.deepEqual(Array.from(C.about.jobTitle.options), [
  "Fellow",
  "Member of Technical Staff",
  "Research Lead",
  "Programme Manager",
  "Senior Leadership",
]);
assert.deepEqual(Array.from(C.about.roleType.options), [
  "Technical AI Safety",
  "Policy / Governance",
  "Field-building",
  "Grant-making",
]);
assert.equal(C.tasks.length, 6);
assert.equal(C.tasks[0].name, "Conceptual / strategy work, idea generation");
assert.equal(C.tasks[0].detail, "Reading relevant literature, papers, etc.");
assert.deepEqual(Array.from(C.hours.eraHeaders), [
  "Without AI assistance",
  "Using AI tools from 1 year ago",
  "Using current AI tools",
  "Projection 6 months from now",
]);
assert.match(C.hours.preamble.join(" "), /Pick one recent project to anchor your answers/);
assert.doesNotMatch(C.hours.preamble.join(" "), /GPT-5 Codex/);
assert.ok(C.hours.preamble.includes("For each category below, think about the related tasks you completed as part of that project."));
assert.doesNotMatch(C.hours.preamble.join(" "), /For example: literature review/);
assert.deepEqual(Array.from(C.hours.instructions), [
  "How many active hours would you have spent doing the same task to the same quality without AI assistance?",
  "How many active hours would you have spent doing the same task to the same quality using AI models/tools from 1 year ago?",
  "How many active hours do you spend on it now, using current AI tools?",
  "How many active hours do you predict you’ll spend on it 6 months from now?",
]);
assert.deepEqual(Array.from(C.hours.oneYearAgoGuide), [
  "Available 1 year ago: Cursor, Claude Code, GPT-5, GPT-5 Codex, Sonnet 4.5, and Haiku 4.5.",
  "Out of scope: Claude Opus 4.5, GPT-5.1, Gemini 3, and Grok 4.1 were released after October 2025.",
]);
assert.equal(C.optional.questions.length, 0);

assert.match(html, /id="jobTitle"/);
assert.match(html, /id="roleType"/);
assert.doesNotMatch(html, /id="hardais"/);
assert.doesNotMatch(html, /id="frac"/);
assert.match(html, /const rowIsBlank = ERAS\.every/);
assert.match(html, /const numberOrNull = id => val\(id\)==="" \? null : Number\(val\(id\)\)/);
assert.doesNotMatch(html, /placeholder="\$\{C\.hours\.cellPlaceholder\}" required/);
assert.match(html, /id="hoursInstructions"/);
assert.match(html, /class="info-tip"/);
assert.match(html, /class="tip-list"/);
assert.match(html, /<td class="taskname">\$\{t\.name\}<small>\$\{t\.detail\}<\/small><\/td>` \+ ERAS/);
assert.match(html, /<script src="persistence\.js"><\/script>/);
assert.match(html, /id="saveStatus"/);
assert.match(html, /id="website"/);
assert.match(html, /function buildSnapshot\(status\)/);
assert.match(html, /function queueDraftSave\(\)/);
assert.match(html, /window\.addEventListener\("online"/);
assert.match(html, /document\.addEventListener\("visibilitychange"/);
assert.doesNotMatch(C.intro.paragraphs.join(" "), /partial answers are saved/i);

assert.equal(typeof C.submit.saving, "string");
assert.equal(typeof C.submit.saved, "string");
assert.equal(typeof C.submit.savedOffline, "string");

console.log("Survey content and structure checks passed.");
