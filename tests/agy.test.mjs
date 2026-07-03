import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Antigravity bundle exposes codex-router skill metadata", () => {
  const manifestPath = path.join(ROOT, ".agy", "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  assert.deepEqual(manifest, {
    name: "codex-router",
    version: packageJson.version
  });

  const skillsLink = path.join(ROOT, ".agy", "skills");
  const linkStats = fs.lstatSync(skillsLink);
  assert.equal(linkStats.isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(skillsLink), "../skills");

  const skillPath = path.join(ROOT, "skills", "codex-router", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");
  assert.match(skill, /^name: codex-router$/m);
  assert.match(skill, /codex-companion\.mjs/);
  assert.match(skill, /Do not run the raw `codex` CLI/i);
  assert.match(skill, /CODEX_ROUTER_ROOT/);
  assert.match(skill, /setup/);
  assert.match(skill, /models/);
  assert.match(skill, /status/);
  assert.match(skill, /result/);
  assert.match(skill, /cancel/);
  assert.match(skill, /stale model pin/i);
  assert.match(skill, /translate Claude Code-specific follow-up commands into AGY-safe equivalents/i);
  assert.match(skill, /translate `!codex login` to `codex login`/i);
  assert.match(skill, /codex login --device-auth/);
  assert.match(skill, /Do not turn a failed or incomplete Codex run into an Antigravity-side implementation attempt/i);
});

test("Antigravity documentation covers install, uninstall, and runtime boundaries", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const skill = fs.readFileSync(path.join(ROOT, "skills", "codex-router", "SKILL.md"), "utf8");

  assert.match(readme, /## Install In Antigravity \(`agy`\)/);
  assert.match(readme, /agy plugin install \.\/\.agy/);
  assert.match(readme, /agy plugin uninstall codex-router/);
  assert.match(readme, /## Antigravity Quick Start/);
  assert.match(readme, /CODEX_ROUTER_ROOT/);
  assert.match(readme, /codex-companion\.mjs" models/);
  assert.match(readme, /which Codex models and effort levels are available/i);
  assert.match(readme, /configured Codex model pin is stale/i);
  assert.match(readme, /If you are upgrading an existing AGY install/i);
  assert.match(readme, /One host surface/i);
  assert.match(readme, /In AGY itself, prefer asking the `codex-router` skill/i);
  assert.match(readme, /show me the latest status and result/i);
  assert.match(readme, /does not register a separate MCP server/i);

  assert.match(skill, /CODEX_ROUTER_ROOT/);
  assert.match(skill, /codex-companion\.mjs" models/);
  assert.match(skill, /what `spark` resolves to/i);
  assert.match(skill, /Do not run the raw `codex` CLI/i);
  assert.match(skill, /Do not turn a failed or incomplete Codex run into an Antigravity-side implementation attempt/i);
});

test("public release metadata and changelog versions are consistent and current", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "codex-router", ".claude-plugin", "plugin.json"), "utf8"));
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const rootChangelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const pluginChangelog = fs.readFileSync(path.join(ROOT, "plugins", "codex-router", "CHANGELOG.md"), "utf8");

  const expectedVersion = packageJson.version;
  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);

  assert.equal(marketplace.version, expectedVersion);
  assert.match(packageJson.description, /live model discovery/i);
  assert.match(packageJson.description, /AGY/i);

  assert.match(marketplace.description, /live model discovery/i);
  assert.match(marketplace.description, /AGY/i);
  assert.match(marketplace.metadata.description, /live model discovery/i);
  assert.match(marketplace.plugins[0].description, /live model discovery/i);
  assert.ok(marketplace.plugins[0].keywords.includes("agy"));
  assert.ok(marketplace.plugins[0].keywords.includes("models"));
  assert.ok(marketplace.plugins[0].tags.includes("agy"));
  assert.ok(marketplace.plugins[0].tags.includes("models"));

  assert.equal(pluginManifest.version, expectedVersion);
  assert.match(pluginManifest.description, /live model discovery/i);
  assert.ok(pluginManifest.keywords.includes("agy"));
  assert.ok(pluginManifest.keywords.includes("models"));

  assert.match(readme, /See \[CHANGELOG\.md\]/);
  assert.match(readme, new RegExp(`## What's New In ${expectedVersion.replace(/\./g, "\\.")}`));
  assert.doesNotMatch(readme, /gpt-5\.4-mini/);
  assert.match(rootChangelog, /## Latest/);
  assert.match(rootChangelog, new RegExp(`\\[${expectedVersion.replace(/\./g, "\\.")}\\]`));
  assert.match(rootChangelog, /\[2\.1\.0\]/);
  assert.match(pluginChangelog, new RegExp(`## ${expectedVersion.replace(/\./g, "\\.")}`));
  assert.match(pluginChangelog, /## 2\.1\.0/);
  assert.match(pluginChangelog, /AGY release parity/i);
});
