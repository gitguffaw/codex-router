import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";
import { loadBrokerSession } from "../plugins/codex-router/scripts/lib/broker-lifecycle.mjs";
import { getProcessStartTime } from "../plugins/codex-router/scripts/lib/process.mjs";
import {
  finalizeJob,
  resolveJobFile,
  resolveStateDir,
  saveState
} from "../plugins/codex-router/scripts/lib/state.mjs";
import { isTerminalJobStatus } from "../plugins/codex-router/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex-router");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
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

function runStopHookAsync(cwd, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [STOP_HOOK], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
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
        config: { stopReviewGate: false },
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
  const startOutcome = finalizeJob(
    repo,
    "review-running",
    ({ entry }) => (entry && isTerminalJobStatus(entry.status) ? null : runningRecord),
    { allowInsert: true, insertBase: runningRecord, storedFallback: runningRecord }
  );
  assert.equal(startOutcome.applied, false);
  const finalState = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(finalState.jobs.find((job) => job.id === "review-running").status, "failed");
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/codex-router:status/i);
  assert.match(blocked.stderr, /\/codex-router:cancel task-live/i);
});

test("stop hook reconciles a dead running task before checking for active jobs", () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const deadProcess = run(process.execPath, ["-e", "process.exit(0)"], { cwd: repo });
  assert.equal(deadProcess.status, 0, deadProcess.stderr);

  const stateDir = resolveStateDir(repo);
  const logFile = path.join(stateDir, "jobs", "task-orphan.log");
  const job = {
    id: "task-orphan",
    status: "running",
    phase: "running",
    title: "Codex Task",
    jobClass: "task",
    sessionId: "sess-current",
    pid: deadProcess.pid,
    processStartTime: "recorded-dead-process-start",
    logFile,
    createdAt: "2026-03-18T15:32:00.000Z",
    updatedAt: "2026-03-18T15:33:00.000Z"
  };
  saveState(repo, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [job]
  });
  fs.writeFileSync(logFile, "running\n", "utf8");
  fs.writeFileSync(resolveJobFile(repo, job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");

  const result = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo, session_id: "sess-current" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.doesNotMatch(result.stderr, /still running/i);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].pid, null);
  assert.match(state.jobs[0].errorMessage, /orphan detection/i);

  const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(repo, job.id), "utf8"));
  assert.equal(storedJob.status, "failed");
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
      config: { stopReviewGate: false },
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

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/codex-router:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

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

test("stop hook stops blocking after three consecutive blocks in one stop chain", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const hookInput = (stopHookActive) =>
    JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-cap",
      stop_hook_active: stopHookActive,
      last_assistant_message: "I completed the refactor and updated the retry logic."
    });

  // First stop attempt of the chain (stop_hook_active absent) blocks.
  const first = run("node", [STOP_HOOK], { cwd: repo, env: buildEnv(binDir), input: hookInput(false) });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).decision, "block");

  // Second and third attempts (continuing due to the stop hook) still block.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const blocked = run("node", [STOP_HOOK], { cwd: repo, env: buildEnv(binDir), input: hookInput(true) });
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.equal(JSON.parse(blocked.stdout).decision, "block");
  }

  // Fourth attempt hits the cap: the stop is allowed and the unresolved
  // findings are downgraded to a stderr note.
  const capped = run("node", [STOP_HOOK], { cwd: repo, env: buildEnv(binDir), input: hookInput(true) });
  assert.equal(capped.status, 0, capped.stderr);
  assert.equal(capped.stdout.trim(), "");
  assert.match(capped.stderr, /reached its cap of 3 consecutive blocks/i);
  assert.match(capped.stderr, /Codex stop-time review found issues/i);

  // A fresh stop chain (stop_hook_active absent) starts blocking again.
  const fresh = run("node", [STOP_HOOK], { cwd: repo, env: buildEnv(binDir), input: hookInput(false) });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).decision, "block");
});

test("stop hook tracks block chains per session so concurrent sessions do not reset each other", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const hookInput = (sessionId, stopHookActive) =>
    JSON.stringify({
      cwd: repo,
      session_id: sessionId,
      stop_hook_active: stopHookActive,
      last_assistant_message: "I completed the refactor."
    });

  const runHook = (sessionId, stopHookActive) =>
    run("node", [STOP_HOOK], { cwd: repo, env: buildEnv(binDir), input: hookInput(sessionId, stopHookActive) });

  // Session A blocks three times; session B's interleaved blocks must not
  // reset A's chain.
  assert.equal(JSON.parse(runHook("sess-a", false).stdout).decision, "block");
  assert.equal(JSON.parse(runHook("sess-b", false).stdout).decision, "block");
  assert.equal(JSON.parse(runHook("sess-a", true).stdout).decision, "block");
  assert.equal(JSON.parse(runHook("sess-b", true).stdout).decision, "block");
  assert.equal(JSON.parse(runHook("sess-a", true).stdout).decision, "block");

  // Session A's fourth attempt hits its own cap despite B's interleaving.
  const cappedA = runHook("sess-a", true);
  assert.equal(cappedA.stdout.trim(), "");
  assert.match(cappedA.stderr, /reached its cap of 3 consecutive blocks/i);

  // Session B is unaffected by A's cap: it has blocked twice, so it blocks
  // once more before hitting its own cap.
  assert.equal(JSON.parse(runHook("sess-b", true).stdout).decision, "block");
  const cappedB = runHook("sess-b", true);
  assert.equal(cappedB.stdout.trim(), "");
  assert.match(cappedB.stderr, /reached its cap of 3 consecutive blocks/i);
});

test("stop hook preserves concurrent per-session chain updates after delayed reviews", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const hookInput = (sessionId) =>
    JSON.stringify({
      cwd: repo,
      session_id: sessionId,
      last_assistant_message: `I completed the refactor for ${sessionId}.`
    });

  const [first, second] = await Promise.all([
    runStopHookAsync(repo, env, hookInput("sess-a")),
    runStopHookAsync(repo, env, hookInput("sess-b"))
  ]);

  for (const result of [first, second]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision, "block");
  }

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.config.stopReviewGateChains["sess-a"].blocks, 1);
  assert.equal(state.config.stopReviewGateChains["sess-b"].blocks, 1);
});
