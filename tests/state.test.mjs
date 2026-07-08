import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";
import { getProcessStartTime } from "../plugins/codex-router/scripts/lib/process.mjs";
import { resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState } from "../plugins/codex-router/scripts/lib/state.mjs";

function writeLockFile(lockFile, holder) {
  fs.writeFileSync(lockFile, `${JSON.stringify(holder)}\n`, "utf8");
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);
  assert.equal(fs.existsSync(prunedJobFile), false);
  assert.equal(fs.existsSync(prunedLogFile), false);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("saveState does not reclaim a fresh half-written (empty) state lock", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, "state.lock");
  fs.writeFileSync(lockFile, "", "utf8");

  assert.throws(
    () => saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] }),
    /Timed out waiting for the Codex Router state lock/
  );
  assert.equal(fs.existsSync(lockFile), true);
  assert.equal(fs.existsSync(resolveStateFile(workspace)), false);
});

test("saveState waits while a live process holds the state lock", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, "state.lock");
  const holder = { pid: process.pid, startTime: getProcessStartTime(process.pid), nonce: "live-holder" };
  writeLockFile(lockFile, holder);

  assert.throws(
    () => saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] }),
    /Timed out waiting for the Codex Router state lock/
  );
  assert.equal(fs.readFileSync(lockFile, "utf8").trim(), JSON.stringify(holder));
});

test("saveState reclaims a state lock held by a dead process", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, "state.lock");

  const exited = run("node", ["-e", "process.exit(0)"]);
  writeLockFile(lockFile, { pid: exited.pid, startTime: null, nonce: "dead-holder" });

  const saved = saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });
  assert.equal(saved.jobs.length, 0);
  assert.equal(fs.existsSync(resolveStateFile(workspace)), true);
  assert.equal(fs.existsSync(lockFile), false);
});

test("saveState reclaims a malformed state lock once it ages past the stale threshold", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, "state.lock");
  fs.writeFileSync(lockFile, "not-a-lock-token", "utf8");
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile, past, past);

  const saved = saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });
  assert.equal(saved.jobs.length, 0);
  assert.equal(fs.existsSync(resolveStateFile(workspace)), true);
});

test("saveState immediately reclaims a lock whose live PID has a different start time (PID reuse)", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, "state.lock");
  writeLockFile(lockFile, { pid: process.pid, startTime: "Thu Jan  1 00:00:00 1970", nonce: "reused-pid" });

  const saved = saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });
  assert.equal(saved.jobs.length, 0);
  assert.equal(fs.existsSync(resolveStateFile(workspace)), true);
});

test("saveState never steals an aged lock whose holder is alive with a matching identity", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, "state.lock");
  const holder = { pid: process.pid, startTime: getProcessStartTime(process.pid), nonce: "long-holder" };
  writeLockFile(lockFile, holder);
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile, past, past);

  assert.throws(
    () => saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] }),
    /Timed out waiting for the Codex Router state lock/
  );
  assert.equal(fs.readFileSync(lockFile, "utf8").trim(), JSON.stringify(holder));
  assert.equal(fs.existsSync(resolveStateFile(workspace)), false);
});

test("saveState never steals an aged lock with a live PID when identity is unverifiable", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, "state.lock");
  const holder = { pid: process.pid, startTime: null, nonce: "unverifiable-holder" };
  writeLockFile(lockFile, holder);
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile, past, past);

  assert.throws(
    () => saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] }),
    /Timed out waiting for the Codex Router state lock/
  );
  assert.equal(fs.readFileSync(lockFile, "utf8").trim(), JSON.stringify(holder));
  assert.equal(fs.existsSync(resolveStateFile(workspace)), false);
});
