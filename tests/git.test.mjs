import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "../plugins/codex-router/scripts/lib/git.mjs";
import { resolveWorkspaceRoot } from "../plugins/codex-router/scripts/lib/workspace.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

const gitModuleHref = new URL("../plugins/codex-router/scripts/lib/git.mjs", import.meta.url).href;

function probeEnsureGitRepository(cwd, env = {}) {
  const result = run(process.execPath, ["--input-type=module", "-e", `
    import { ensureGitRepository } from ${JSON.stringify(gitModuleHref)};
    try {
      const root = ensureGitRepository(process.env.PROBE_CWD);
      console.log(JSON.stringify({ threw: false, root }));
    } catch (error) {
      console.log(JSON.stringify({ threw: true, message: error.message }));
    }
  `], {
    env: {
      ...process.env,
      ...env,
      PROBE_CWD: cwd
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext reports an unrelated history instead of a raw merge-base exit", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "--orphan", "unrelated"], { cwd });
  fs.writeFileSync(path.join(cwd, "other.js"), "console.log('v2');\n");
  run("git", ["add", "other.js"], { cwd });
  run("git", ["commit", "-m", "orphan"], { cwd });

  assert.throws(
    () => collectReviewContext(cwd, resolveReviewTarget(cwd, {})),
    /No merge base between HEAD and main\. Pass --base <ref> or use --scope working-tree\./
  );
  assert.throws(
    () => collectReviewContext(cwd, resolveReviewTarget(cwd, { base: "nope" })),
    /Not a valid object name nope/
  );

  const workingTree = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));
  assert.equal(workingTree.mode, "working-tree");
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test("collectReviewContext falls back to lightweight context for larger adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.match(context.collectionGuidance, /read-only git commands/i);
  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext falls back to lightweight context for oversized single-file diffs", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext keeps untracked file content in lightweight working tree context", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});

test("ensureGitRepository does not report a missing directory as a missing git binary", () => {
  const missing = path.join(makeTempDir(), "missing");

  assert.throws(
    () => ensureGitRepository(missing),
    { message: `Directory does not exist: ${missing}` }
  );
  assert.equal(resolveWorkspaceRoot(missing), missing);
});

test("ensureGitRepository does not treat a non-directory cwd as an empty repository root", () => {
  const filePath = path.join(makeTempDir(), "not-a-directory");
  fs.writeFileSync(filePath, "x\n");

  assert.throws(
    () => ensureGitRepository(filePath),
    /Unable to run git .*ENOTDIR/
  );
  assert.equal(resolveWorkspaceRoot(filePath), filePath);
});

test("ensureGitRepository reports a signalled rev-parse instead of a missing repository", () => {
  const bin = makeTempDir();
  writeExecutable(path.join(bin, "git"), "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\n");
  const cwd = makeTempDir();

  const probed = probeEnsureGitRepository(cwd, {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`
  });

  assert.equal(probed.threw, true);
  assert.match(probed.message, /git rev-parse --show-toplevel: signal=SIGTERM/);
});

test("ensureGitRepository still tells a non-repository to run inside git", () => {
  const cwd = makeTempDir();

  assert.throws(
    () => ensureGitRepository(cwd),
    { message: "This command must run inside a Git repository." }
  );
  assert.equal(resolveWorkspaceRoot(cwd), cwd);
});

test("ensureGitRepository still reports a missing git binary when the directory exists", () => {
  const cwd = makeTempDir();
  const probed = probeEnsureGitRepository(cwd, { PATH: makeTempDir() });

  assert.deepEqual(probed, {
    threw: true,
    message: "git is not installed. Install Git and retry."
  });
});
