import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Claude Code and Codex sessions export CLAUDE*/CODEX* variables (for example
// CODEX_COMPANION_SESSION_ID and CLAUDE_PLUGIN_DATA) that change runtime behavior.
// Scrub them once at load so tests stay hermetic regardless of the invoking session;
// tests that need one set it explicitly on options.env or process.env.
for (const key of Object.keys(process.env)) {
  if (/^(CLAUDE|CODEX)/.test(key)) {
    delete process.env[key];
  }
}

// Set after the scrub so every spawned CLI (and hand-rolled `...process.env`
// spread) shortens the broker idle timeout: test brokers must exit seconds
// after the suite finishes, not linger for the ten-minute production default.
process.env.CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS = "2000";

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout,
    shell: process.platform === "win32" && !path.isAbsolute(command),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
