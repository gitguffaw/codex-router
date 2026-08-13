import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex-cli");
const SKILL_FILE = path.join(PLUGIN_ROOT, "skills", "codex-cli", "SKILL.md");

function listFiles(root, current = root) {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(current, entry.name);
    return entry.isDirectory() ? listFiles(root, absolute) : [path.relative(root, absolute)];
  });
}

test("minimal Codex CLI plugin contains one skill and no runtime surfaces", () => {
  assert.deepEqual(listFiles(PLUGIN_ROOT).sort(), [
    ".claude-plugin/plugin.json",
    "skills/codex-cli/SKILL.md",
    "skills/codex-cli/agents/openai.yaml"
  ]);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
  );
  assert.equal(manifest.name, "codex-cli");

  const skill = fs.readFileSync(SKILL_FILE, "utf8");
  assert.match(skill, /Drive the installed Codex CLI directly/);
  assert.match(skill, /Prefer Codex Router When Present/);
  assert.match(skill, /defer to that plugin/i);
  assert.match(skill, /follow `codex-router` instead/);
  assert.match(skill, /codex debug models/);
  assert.match(skill, /codex review --base/);
  assert.doesNotMatch(skill, /review --(?:uncommitted|base <BASE_BRANCH>|commit <SHA>) -/);
  assert.match(skill, /reject a custom `\[PROMPT\]`/);
  assert.match(skill, /-s read-only -a never/);
  assert.match(skill, /-s workspace-write -a never/);
  assert.match(skill, /review the PR before submitting/i);
  assert.doesNotMatch(skill, /codex-companion|app-server-broker|session-lifecycle-hook/);
});

test("marketplace publishes the minimal Codex CLI plugin beside Codex Router", () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8")
  );
  const entry = marketplace.plugins.find((plugin) => plugin.name === "codex-cli");

  assert.ok(entry);
  assert.equal(entry.source, "./plugins/codex-cli");
  assert.match(entry.description, /single skill/i);
  assert.match(entry.description, /no companion runtime/i);

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /\/plugin install codex-cli@codex-router/);
  assert.match(readme, /Do not install `codex-cli` beside `codex-router`/);
  assert.match(readme, /defers to `codex-router`/);
  assert.match(readme, /Use the raw Codex CLI with sol at xhigh effort to review the PR before submitting it/);
});

function tryCodexHelp(args) {
  const result = spawnSync("codex", args, {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return `${result.stdout}\n${result.stderr}`;
}

const liveTopHelp = tryCodexHelp(["--help"]);

test("codex-cli recipes match the live Codex help contract when available", { skip: !liveTopHelp }, () => {
  const skill = fs.readFileSync(SKILL_FILE, "utf8");
  assert.match(liveTopHelp, /^\s+exec\b/m);
  assert.match(liveTopHelp, /^\s+review\b/m);
  assert.match(liveTopHelp, /^\s+debug\b/m);
  assert.match(liveTopHelp, /^\s+features\b/m);
  assert.match(liveTopHelp, /^\s+mcp\b/m);
  assert.match(liveTopHelp, /^\s+plugin\b/m);
  assert.match(liveTopHelp, /--search/);
  assert.match(liveTopHelp, /-m, --model/);
  assert.match(liveTopHelp, /-s, --sandbox/);
  assert.match(liveTopHelp, /-a, --ask-for-approval/);

  const execHelp = tryCodexHelp(["exec", "--help"]);
  assert.ok(execHelp, "codex exec --help should be available when top-level help is");
  assert.match(execHelp, /^\s+resume\b/m);

  const reviewHelp = tryCodexHelp(["review", "--help"]);
  assert.ok(reviewHelp, "codex review --help should be available when top-level help is");
  assert.match(reviewHelp, /--uncommitted/);
  assert.match(reviewHelp, /--base/);
  assert.match(reviewHelp, /--commit/);

  const debugHelp = tryCodexHelp(["debug", "--help"]);
  assert.ok(debugHelp, "codex debug --help should be available when top-level help is");
  assert.match(debugHelp, /^\s+models\b/m);

  const featuresHelp = tryCodexHelp(["features", "--help"]);
  assert.ok(featuresHelp, "codex features --help should be available when top-level help is");
  assert.match(featuresHelp, /^\s+list\b/m);

  assert.match(skill, /codex debug models/);
  assert.match(skill, /codex features list/);
  assert.match(skill, /codex mcp list/);
  assert.match(skill, /codex plugin list/);
  assert.match(skill, /codex exec resume --last/);
  assert.match(skill, /review --uncommitted/);
  assert.match(skill, /review --base/);
  assert.match(skill, /review --commit/);
  assert.match(skill, /--search/);
  assert.match(skill, /-s read-only -a never/);
  assert.match(skill, /-s workspace-write -a never/);
});
