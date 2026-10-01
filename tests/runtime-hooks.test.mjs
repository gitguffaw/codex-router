import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex-router/scripts/lib/broker-lifecycle.mjs";
import { getProcessStartTime } from "../plugins/codex-router/scripts/lib/process.mjs";
import {
  resolveStateDir,
  saveState
} from "../plugins/codex-router/scripts/lib/state.mjs";
import { claimJobRunning } from "../plugins/codex-router/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex-router");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

test("session end tombstones the ending session's active jobs so surviving workers back off", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  const sleeperStartTime = getProcessStartTime(sleeper.pid);
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {},
        jobs: [
          {
            id: "review-completed",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-running",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-current",
            pid: sleeper.pid,
            processStartTime: sleeperStartTime,
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);

  if (sleeperStartTime) {
    await waitFor(() => !isProcessAlive(sleeper.pid));
  } else {
    assert.equal(isProcessAlive(sleeper.pid), true);
  }

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(
    state.jobs.map((job) => job.id).sort(),
    ["review-completed", "review-other", "review-running"]
  );
  assert.equal(state.jobs.find((job) => job.id === "review-completed").status, "completed");
  const tombstoned = state.jobs.find((job) => job.id === "review-running");
  assert.equal(tombstoned.status, "failed");
  assert.equal(tombstoned.pid, null);
  assert.match(tombstoned.errorMessage, /session ended/i);
  const otherJob = state.jobs.find((job) => job.id === "review-other");
  assert.equal(otherJob.status, "completed");
  assert.equal(otherJob.logFile, otherSessionLog);

  // Tombstoned job artifacts are kept for inspection until an explicit
  // retention policy removes them.
  assert.equal(fs.existsSync(runningJobFile), true);
  assert.equal(fs.existsSync(runningLog), true);

  // Regression: a surviving worker's queued->running start write must back
  // off on the terminal tombstone. allowInsert recovers missing index entries;
  // session teardown must not look like state loss, or a write-capable worker would
  // re-insert its job and run after the session ended.
  const runningRecord = {
    id: "review-running",
    status: "running",
    sessionId: "sess-current",
    pid: 99999
  };
  const startOutcome = claimJobRunning(repo, runningRecord);
  assert.equal(startOutcome.applied, false);
  const finalState = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(finalState.jobs.find((job) => job.id === "review-running").status, "failed");
});

test(
  "session end terminates only jobs with a proven matching process identity",
  { skip: process.platform === "win32" },
  async (t) => {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    const matchingStartTime = "Sat Jul 11 12:00:00 2026";
    writeExecutable(
      path.join(binDir, "ps"),
      `#!/bin/sh\nprintf '%s\\n' '${matchingStartTime}'\n`
    );
    const matching = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: repo,
      detached: true,
      stdio: "ignore"
    });
    const mismatched = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: repo,
      detached: true,
      stdio: "ignore"
    });
    const missing = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: repo,
      detached: true,
      stdio: "ignore"
    });
    matching.unref();
    mismatched.unref();
    missing.unref();

    const children = [matching, mismatched, missing];
    t.after(() => {
      for (const child of children) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            // Ignore missing processes.
          }
        }
      }
    });

    saveState(repo, {
      version: 1,
      config: {},
      jobs: [
        {
          id: "task-matching",
          status: "running",
          sessionId: "sess-current",
          pid: matching.pid,
          processStartTime: matchingStartTime,
          updatedAt: "2026-03-18T15:35:00.000Z"
        },
        {
          id: "task-mismatched",
          status: "running",
          sessionId: "sess-current",
          pid: mismatched.pid,
          processStartTime: "Thu Jan  1 00:00:00 1970",
          updatedAt: "2026-03-18T15:34:00.000Z"
        },
        {
          id: "task-missing-start-time",
          status: "running",
          sessionId: "sess-current",
          pid: missing.pid,
          updatedAt: "2026-03-18T15:33:00.000Z"
        }
      ]
    });

    const result = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env: {
        ...process.env,
        CODEX_COMPANION_SESSION_ID: "sess-current",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
      },
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: "sess-current",
        cwd: repo
      })
    });

    assert.equal(result.status, 0, result.stderr);
    await waitFor(() => !isProcessAlive(matching.pid));
    assert.equal(isProcessAlive(mismatched.pid), true);
    assert.equal(isProcessAlive(missing.pid), true);

    const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
    assert.deepEqual(
      state.jobs.map((job) => job.id).sort(),
      ["task-matching", "task-mismatched", "task-missing-start-time"]
    );
    for (const job of state.jobs) {
      assert.equal(job.status, "failed", job.id);
      assert.equal(job.pid, null, job.id);
      assert.match(job.errorMessage, /session ended/i);
    }
  }
);

test(
  "session end tears down the broker only when its process identity matches",
  { skip: process.platform === "win32" },
  async (t) => {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    const matchingStartTime = "Sat Jul 11 12:00:00 2026";
    writeExecutable(path.join(binDir, "ps"), `#!/bin/sh\nprintf '%s\\n' '${matchingStartTime}'\n`);

    const matching = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: repo,
      detached: true,
      stdio: "ignore"
    });
    const mismatched = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: repo,
      detached: true,
      stdio: "ignore"
    });
    const missing = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: repo,
      detached: true,
      stdio: "ignore"
    });
    matching.unref();
    mismatched.unref();
    missing.unref();

    const children = [matching, mismatched, missing];
    t.after(() => {
      for (const child of children) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            // Ignore missing processes.
          }
        }
      }
    });

    const hookEnv = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
    };

    function endSession() {
      return run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
        cwd: repo,
        env: hookEnv,
        input: JSON.stringify({
          hook_event_name: "SessionEnd",
          session_id: "sess-broker",
          cwd: repo
        })
      });
    }

    saveBrokerSession(repo, {
      pid: mismatched.pid,
      startTime: "Thu Jan  1 00:00:00 1970"
    });
    const mismatchedResult = endSession();
    assert.equal(mismatchedResult.status, 0, mismatchedResult.stderr);
    assert.equal(isProcessAlive(mismatched.pid), true);
    assert.equal(loadBrokerSession(repo), null);

    saveBrokerSession(repo, { pid: missing.pid });
    const missingResult = endSession();
    assert.equal(missingResult.status, 0, missingResult.stderr);
    assert.equal(isProcessAlive(missing.pid), true);
    assert.equal(loadBrokerSession(repo), null);

    saveBrokerSession(repo, {
      pid: matching.pid,
      startTime: matchingStartTime
    });
    const matchingResult = endSession();
    assert.equal(matchingResult.status, 0, matchingResult.stderr);
    await waitFor(() => !isProcessAlive(matching.pid));
    assert.equal(loadBrokerSession(repo), null);
  }
);

test("commands lazily start and reuse one shared app-server after first use", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup reuses an existing shared app-server without starting another one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("status reports shared session runtime when a lazy broker is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
});

test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(targetWorkspace);
  fs.writeFileSync(path.join(targetWorkspace, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: targetWorkspace });
  run("git", ["commit", "-m", "init"], { cwd: targetWorkspace });
  fs.writeFileSync(path.join(targetWorkspace, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: targetWorkspace,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  const session = loadBrokerSession(targetWorkspace);
  assert.ok(session?.endpoint);

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace,
    env: buildEnv(binDir)
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, session.endpoint);
});
