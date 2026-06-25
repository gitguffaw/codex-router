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
  assert.match(skill, /status/);
  assert.match(skill, /result/);
  assert.match(skill, /cancel/);
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
  assert.match(readme, /does not register a separate MCP server/i);

  assert.match(skill, /CODEX_ROUTER_ROOT/);
  assert.match(skill, /Do not run the raw `codex` CLI/i);
  assert.match(skill, /Do not turn a failed or incomplete Codex run into an Antigravity-side implementation attempt/i);
});
