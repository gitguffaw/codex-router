import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex-router");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /--config <key=value>/);
  assert.match(source, /--enable <feature>/);
  assert.match(source, /--disable <feature>/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /If the raw arguments include both `--wait` and `--background`, stop with an error/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /normally uses native review and does not support staged-only review or unstaged-only review/i);
  assert.match(source, /promotes focused requests to its `adversarial-review` subcommand/i);
  assert.match(source, /Do not pass `--search`, `--docs`, `--tool`, or `--parallel`/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\].*\[focus \.\.\.\]/);
  assert.match(source, /--config <key=value>/);
  assert.match(source, /--enable <feature>/);
  assert.match(source, /--disable <feature>/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /If the raw arguments include both `--wait` and `--background`, stop with an error/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/codex-router:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can take extra focus text after the flags/i);
  assert.match(source, /focused `\/codex-router:review` requests are promoted to this same companion path/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "analyze.md",
    "cancel.md",
    "cli.md",
    "exec.md",
    "models.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("analyze and exec commands route through codex-router runtime", () => {
  const analyze = read("commands/analyze.md");
  const exec = read("commands/exec.md");

  assert.match(analyze, /codex-companion\.mjs" analyze "\$ARGUMENTS"/);
  assert.match(analyze, /read-only/i);
  assert.match(analyze, /context pack/i);
  assert.match(analyze, /--docs/);
  assert.match(analyze, /--tool <capability>/);
  assert.match(analyze, /--parallel/);
  assert.match(analyze, /--config <key=value>/);
  assert.match(analyze, /--enable <feature>/);
  assert.match(analyze, /--disable <feature>/);
  assert.match(analyze, /Codex-side routing directives/i);
  assert.match(analyze, /\[--wait\|--background\]/);
  assert.match(analyze, /await-result/);
  assert.match(analyze, /run_in_background:\s*true/);
  assert.match(analyze, /one concise terminal-status notification/i);
  assert.match(analyze, /does not inject the full Codex result/i);
  assert.match(exec, /codex-companion\.mjs" exec "\$ARGUMENTS"/);
  assert.match(exec, /only policy-routed analyze\/exec write-capable entrypoint/i);
  assert.match(exec, /`\/codex-router:rescue` is a separate task path/i);
  assert.match(exec, /context pack/i);
  assert.match(exec, /--docs/);
  assert.match(exec, /--tool <capability>/);
  assert.match(exec, /--parallel/);
  assert.match(exec, /--config <key=value>/);
  assert.match(exec, /--enable <feature>/);
  assert.match(exec, /--disable <feature>/);
  assert.match(exec, /Codex-side routing directives/i);
  assert.match(exec, /\[--wait\|--background\]/);
  assert.match(exec, /await-result/);
  assert.match(exec, /run_in_background:\s*true/);
  assert.match(exec, /one concise terminal-status notification/i);
  assert.match(exec, /does not inject the full Codex result/i);
});

test("cli command exposes raw Codex CLI escape hatch", () => {
  const source = read("commands/cli.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /codex-companion\.mjs" cli "\$ARGUMENTS"/);
  assert.match(source, /features list/);
  assert.match(source, /mcp list/);
  assert.match(source, /plugin list/);
  assert.match(source, /installed CLI's current flags/i);
  assert.match(source, /without a Router release/i);
  assert.match(source, /Return stdout and stderr verbatim/i);
  assert.match(readme, /### `\/codex-router:cli`/);
  assert.match(readme, /\/codex-router:cli features list/);
  assert.match(readme, /\/codex-router:cli app-server --help/);
  assert.match(readme, /raw Codex CLI escape hatch/i);
});

test("models command exposes the live Codex model catalog", () => {
  const source = read("commands/models.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /codex-companion\.mjs" models "\$ARGUMENTS"/);
  assert.match(source, /\[--all\] \[--json\]/);
  assert.match(source, /effective default model/i);
  assert.match(source, /supported effort levels/i);
  assert.match(source, /live catalog's descriptions of those effort levels/i);
  assert.match(source, /hidden catalog entries/i);
  assert.match(source, /every additional service tier advertised by each model/i);
  assert.match(source, /aliases derived from the current visible catalog/i);
  assert.match(source, /Do not summarize or condense it/i);
  assert.match(readme, /### `\/codex-router:models`/);
  assert.match(readme, /\/codex-router:models --json/);
  assert.match(readme, /`--all` includes hidden catalog entries/i);
});

test("README explains catalog-driven model, effort, and service-tier selection", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(readme, /Choose a model, reasoning effort, and service tier/i);
  assert.match(readme, /Every `models` invocation reads `codex debug models`/i);
  assert.match(readme, /Omit model flags.*inherit the active Codex configuration/i);
  assert.match(readme, /`--model <selector>`.*exact live slug or a short alias shown by `models`/i);
  assert.match(readme, /`--best`.*highest-priority visible model/i);
  assert.match(readme, /catalog priority, not a benchmark/i);
  assert.match(readme, /`--spark`.*Compatibility shorthand for `--model spark`/i);
  assert.match(readme, /not a Router-maintained allowlist/i);
  assert.match(readme, /New levels work without a Router release/i);
  assert.match(readme, /`--service-tier <tier>`.*tier shown by `models`/i);
  assert.match(readme, /`--fast` does not lower the effort level/i);
  assert.match(readme, /Rescue accepts `--model <selector>` and `--effort`, but it does not perform `--best` or service-tier/i);
  assert.match(readme, /`-c`\/`--config <key=value>` forwards arbitrary Codex configuration keys without a Router allowlist/i);
  assert.match(readme, /`\/codex-router:cli --help`/i);
  assert.match(readme, /Per-run Router flags take precedence over those defaults/i);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Codex's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Regression for #234: `Skill(codex-router:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose ("Route this
  // request to the `codex-router:codex-rescue` subagent") while running under
  // `context: fork` — forked general-purpose subagents do not expose the
  // `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "codex-router:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(codex-router:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <selector>/);
  assert.match(rescue, /--effort <level>/);
  assert.match(rescue, /--config <key=value>/);
  assert.match(rescue, /--enable <feature>/);
  assert.match(rescue, /--disable <feature>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /run the `codex-router:codex-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward either flag to `task`/i);
  assert.match(rescue, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /Codex config controls/i);
  assert.match(rescue, /Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort/i);
  assert.match(rescue, /Preserve exact selectors and aliases such as `spark`.*live catalog/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Codex companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after successful output/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(rescue, /both `--background` and `--wait`.*stop with an error/i);
  assert.match(rescue, /subagent must always invoke the internal `task --watch` mode/i);
  assert.match(rescue, /timeout ends only the watcher/i);
  assert.match(agent, /Always use internal `task --watch`/i);
  assert.match(agent, /Never add `--background`/i);
  assert.match(agent, /lifetime equals the watcher lifetime, not the worker lifetime/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific reasoning effort/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `spark` or another alias shown by `models`, pass that selector through with `--model`/i);
  assert.match(agent, /If the user asks for a concrete model name such as `gpt-5\.4-mini`, pass it through with `--model`/i);
  assert.match(agent, /Codex config controls/i);
  assert.match(agent, /Return the stdout of the `codex-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call expires after reporting `Codex rescue started as <job-id>`/i);
  assert.match(agent, /If the Bash call fails before a job id is reported or Codex cannot be invoked, return nothing/i);
  assert.match(agent, /gpt-5-4-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Codex prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /only job is to invoke `task --watch` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave `--effort` unset unless the user explicitly requests a specific effort/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Preserve model selectors and aliases such as `spark`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Always call internal `task --watch` without `--background`/i);
  assert.match(runtimeSkill, /watcher may expire, but the active worker must continue/i);
  assert.match(runtimeSkill, /If the forwarded request includes `-c`\/`--config`, `--enable`, or `--disable`, pass those controls through to `task`/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: pass through the requested level.*Do not maintain a fixed list/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If Bash expires after reporting `Codex rescue started as <job-id>`/i);
  assert.match(runtimeSkill, /If the Bash call fails before a job id is reported or Codex cannot be invoked, return nothing/i);
  assert.match(readme, /`codex-router:codex-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model` or `--effort`, Codex chooses its own defaults/i);
  assert.match(readme, /\/codex-router:rescue --model <selector-from-models> --effort <level-from-models>/i);
  assert.doesNotMatch(readme, /\/codex-router:rescue --best/i);
  assert.doesNotMatch(readme, /gpt-5\.4-mini/);
  assert.match(readme, /aliases such as `spark` resolve from the live model catalog/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /### `\/codex-router:setup`/);
  assert.match(readme, /### `\/codex-router:review`/);
  assert.match(readme, /### `\/codex-router:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/codex-router:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/codex-router:rescue`/);
  assert.match(readme, /### `\/codex-router:status`/);
  assert.match(readme, /### `\/codex-router:result`/);
  assert.match(readme, /### `\/codex-router:cancel`/);
});

test("result and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gpt-5-4-prompting/SKILL.md");
  const promptRecipes = read("skills/gpt-5-4-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task --watch "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(setup, /stale or unsupported.*\/codex-router:models/i);
  assert.match(readme, /!codex login/);
  assert.match(readme, /install or upgrade Codex for you/i);
  assert.match(readme, /!codex login --device-auth/);
  assert.match(readme, /!codex login --with-api-key/);
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  assert.match(readme, new RegExp(`## What's New In ${expectedVersion.replace(/\./g, "\\.")}`));
  assert.match(readme, /One host surface, depending on how you want to use Codex Router/i);
  assert.match(readme, /If you are upgrading an existing Claude Code install/i);
  assert.match(readme, /\/codex-router:setup --enable-review-gate/);
  assert.match(readme, /\/codex-router:setup --disable-review-gate/);
});
