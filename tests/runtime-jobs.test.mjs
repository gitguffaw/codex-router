import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";
import { finalizeJob, listJobs, resolveJobFile, resolveStateDir, saveState } from "../plugins/codex-router/scripts/lib/state.mjs";
import {
  claimJobRunning,
  completeTrackedJob,
  createJobProgressUpdater,
  failQueuedLaunch,
  failTrackedJob,
  runTrackedJob
} from "../plugins/codex-router/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex-router");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

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

function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("task --background enqueues a detached worker and await-result emits one concise completion nudge", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const jobId = launched.stdout.match(/\b(task-[a-z0-9-]+)\b/)?.[1];
  assert.match(jobId ?? "", /^task-/);
  assert.match(launched.stdout, /Full output will not appear automatically/i);
  assert.match(launched.stdout, new RegExp(`/codex-router:result ${jobId}`));
  assert.match(launched.stdout, /Ending the originating session marks the job failed/i);

  const notification = run(
    "node",
    [SCRIPT, "await-result", jobId, "--timeout-ms", "15000"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(notification.status, 0, notification.stderr);
  assert.equal(
    notification.stdout,
    `Codex job ${jobId} finished with status completed. Run /codex-router:result ${jobId} to view the full result.\n`
  );
  assert.doesNotMatch(notification.stdout, /Handled the requested task/);

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("task --watch returns the detached worker's final output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  initGitRepo(repo);

  const watched = run("node", [SCRIPT, "task", "--watch", "inspect the failure"], {
    cwd: repo,
    env: buildEnv(binDir),
    timeout: 15_000
  });

  assert.equal(watched.status, 0, watched.stderr);
  assert.match(watched.stderr, /Codex rescue started as task-[a-z0-9-]+/);
  assert.match(watched.stdout, /Handled the requested task/);
  assert.doesNotMatch(watched.stdout, /started in the background/);
});

test("task --watch leaves its detached worker running when the watcher is terminated", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);

  // POSIX host timeouts typically terminate the watcher's whole process group.
  // Isolate the watcher so that group kill cannot reach the separately detached
  // worker. Windows has no equivalent group-kill API here, so fall back to the
  // watcher PID.
  const isolateWatcherGroup = process.platform !== "win32";
  const watcher = spawn("node", [SCRIPT, "task", "--watch", "--write", "finish after the watcher exits"], {
    cwd: repo,
    env: buildEnv(binDir),
    windowsHide: true,
    detached: isolateWatcherGroup
  });
  t.after(() => {
    if (watcher.exitCode !== null || watcher.signalCode !== null) {
      return;
    }
    try {
      if (isolateWatcherGroup) {
        process.kill(-watcher.pid, "SIGKILL");
      } else {
        watcher.kill("SIGKILL");
      }
    } catch {
      // Watcher already exited.
    }
  });
  let watcherStderr = "";
  watcher.stderr.setEncoding("utf8");
  watcher.stderr.on("data", (chunk) => {
    watcherStderr += chunk;
  });
  // Drain stdout so a successful watcher can never block on a full pipe while
  // this regression test is arranging the forced watcher exit.
  watcher.stdout.resume();
  const watcherClosed = new Promise((resolve) => {
    watcher.on("close", (status, signal) => resolve({ status, signal }));
  });

  const jobId = await waitFor(
    () => watcherStderr.match(/Codex rescue started as (task-[a-z0-9-]+)/)?.[1] ?? null,
    { timeoutMs: 15_000 }
  );
  const activeBeforeTimeout = await waitFor(
    () => {
      const job = listJobs(repo).find((entry) => entry.id === jobId);
      return job?.status === "running" ? job : null;
    },
    { timeoutMs: 15_000 }
  );
  assert.notEqual(activeBeforeTimeout.pid, watcher.pid, "the watcher must not own the worker process");

  if (isolateWatcherGroup) {
    process.kill(-watcher.pid, "SIGTERM");
  } else {
    watcher.kill("SIGTERM");
  }
  const watcherExit = await watcherClosed;
  if (isolateWatcherGroup) {
    assert.equal(watcherExit.signal, "SIGTERM");
  }

  const activeAfterTimeout = listJobs(repo).find((entry) => entry.id === jobId);
  assert.equal(activeAfterTimeout?.status, "running", "watcher expiration must not finalize the active job");
  assert.equal(activeAfterTimeout?.pid, activeBeforeTimeout.pid, "the detached worker identity must remain unchanged");
  assert.doesNotThrow(
    () => process.kill(activeBeforeTimeout.pid, 0),
    "the detached worker must survive watcher process-group termination"
  );

  const completed = await waitFor(
    () => {
      const job = listJobs(repo).find((entry) => entry.id === jobId);
      return job?.status === "completed" ? job : null;
    },
    { timeoutMs: 15_000 }
  );
  assert.equal(completed.pid, null);

  const result = run("node", [SCRIPT, "result", jobId], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("review with focus text promotes to adversarial review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Codex Adversarial Review/);
  assert.match(result.stdout, /Missing empty-state guard/);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /User focus: focus on auth/);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review rejects analyze/exec routing directives instead of treating them as focus text", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  for (const flag of ["--docs", "--search", "--parallel", "--tool"]) {
    const args = flag === "--tool" ? [SCRIPT, "review", "--tool", "mcp:playwright"] : [SCRIPT, "review", flag];
    const result = run("node", args, {
      cwd: repo,
      env: buildEnv(binDir)
    });
    assert.equal(result.status > 0, true, `expected failure for ${flag}`);
    assert.match(result.stderr, /does not support --(docs|search|parallel|tool)/i);
    assert.match(result.stderr, /Use \/codex-router:analyze or \/codex-router:exec/i);
  }
});

test("adversarial review rejects analyze/exec routing directives", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--docs", "challenge auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support --docs/i);
  assert.match(result.stderr, /\/codex-router:adversarial-review/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review --background enqueues a detached tracked review job", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.match(launchPayload.jobId, /^review-/);
  assert.equal(launchPayload.status, "queued");
  assert.equal(launchPayload.title, "Codex Review");

  const waitedStatus = run("node", [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.status, "completed");
  assert.equal(waitedPayload.job.kindLabel, "review");
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/codex-router:status review-live`<br>`\/codex-router:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /Codex session ID: thr_1/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_1/);
  assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-adv-live",
            kind: "adversarial-review",
            status: "running",
            title: "Codex Adversarial Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_adv_live",
            summary: "Adversarial review current changes",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-adv",
            kind: "adversarial-review",
            status: "completed",
            title: "Codex Adversarial Review",
            jobClass: "review",
            threadId: "thr_adv_done",
            summary: "Adversarial review working tree diff",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  assert.match(result.stdout, /Codex session ID: thr_adv_live/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

function seedRunningJob(workspace, job) {
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, `${job.id}.log`);
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");

  const record = {
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    summary: "Investigate flaky test",
    logFile,
    createdAt: "2026-03-18T15:30:00.000Z",
    startedAt: "2026-03-18T15:30:01.000Z",
    updatedAt: "2026-03-18T15:30:02.000Z",
    ...job
  };

  fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [record] }, null, 2)}\n`,
    "utf8"
  );

  return { stateDir, jobsDir, logFile };
}

function spawnDeadPid() {
  const child = run("node", ["-e", "process.exit(0)"]);
  assert.equal(child.status, 0);
  assert.equal(Number.isFinite(child.pid), true);
  return child.pid;
}

test("status marks a running job failed when its runtime process is gone", () => {
  const workspace = makeTempDir();
  const { stateDir, jobsDir, logFile } = seedRunningJob(workspace, {
    id: "task-orphan",
    pid: spawnDeadPid()
  });

  const result = run("node", [SCRIPT, "status", "task-orphan", "--json"], { cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.status, "failed");
  assert.equal(payload.job.pid, null);
  assert.match(payload.job.errorMessage, /orphan detection/);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "failed");
  assert.match(state.jobs[0].errorMessage, /orphan detection/);

  const storedJob = JSON.parse(fs.readFileSync(path.join(jobsDir, "task-orphan.json"), "utf8"));
  assert.equal(storedJob.status, "failed");
  assert.match(fs.readFileSync(logFile, "utf8"), /orphan detection/);
});

test("status marks a running job failed when its pid was recycled by another process", { skip: process.platform === "win32" }, () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  writeExecutable(
    path.join(binDir, "ps"),
    "#!/bin/sh\nprintf '%s\\n' 'Sat Jul 11 12:00:00 2026'\n"
  );
  const { stateDir } = seedRunningJob(workspace, {
    id: "task-recycled",
    pid: process.pid,
    processStartTime: "Thu Jan  1 00:00:00 1970"
  });

  const result = run("node", [SCRIPT, "status", "task-recycled", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.status, "failed");
  assert.match(payload.job.errorMessage, /orphan detection/);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "failed");
});

test("orphan detection adopts a completed job file instead of marking the job failed", () => {
  const workspace = makeTempDir();
  const { stateDir, jobsDir } = seedRunningJob(workspace, {
    id: "task-done-late",
    pid: spawnDeadPid()
  });

  // The runtime completed the job and exited, but its state-index update never
  // landed: the job file carries the final result while state.json still says
  // "running".
  fs.writeFileSync(
    path.join(jobsDir, "task-done-late.json"),
    `${JSON.stringify(
      {
        id: "task-done-late",
        status: "completed",
        phase: "done",
        title: "Codex Task",
        threadId: "thr_late",
        completedAt: "2026-03-18T15:32:00.000Z",
        rendered: "All done.\n"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-done-late", "--json"], { cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.status, "completed");
  assert.equal(payload.job.threadId, "thr_late");
  assert.equal(payload.job.errorMessage ?? null, null);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "completed");
  assert.equal(state.jobs[0].completedAt, "2026-03-18T15:32:00.000Z");

  const storedJob = JSON.parse(fs.readFileSync(path.join(jobsDir, "task-done-late.json"), "utf8"));
  assert.equal(storedJob.status, "completed");
  assert.equal(storedJob.rendered, "All done.\n");
});

test("status leaves a running job untouched while its runtime process is alive", () => {
  const workspace = makeTempDir();
  const { stateDir } = seedRunningJob(workspace, {
    id: "task-alive",
    pid: process.pid
  });

  const result = run("node", [SCRIPT, "status", "task-alive", "--json"], { cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.status, "running");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("result surfaces the failure for an orphaned job instead of claiming it is still running", () => {
  const workspace = makeTempDir();
  seedRunningJob(workspace, {
    id: "task-orphan-result",
    pid: spawnDeadPid()
  });

  const result = run("node", [SCRIPT, "result", "task-orphan-result", "--json"], { cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.status, "failed");
  assert.match(payload.storedJob.errorMessage, /orphan detection/);
});

test("owner completion backs off when a cancel wins mid-run (first terminal state wins)", async () => {
  const workspace = makeTempDir();
  const jobId = "task-owner-race";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "queued", title: "Codex Task", jobClass: "task" }]
  });

  const job = { id: jobId, workspaceRoot: workspace, title: "Codex Task", jobClass: "task" };

  // The runner stands in for the Codex turn. It succeeds, but partway through a
  // concurrent cancel finalizes the job — exactly the window where the owning
  // runtime and cancel could otherwise both write the two records.
  const runner = async () => {
    finalizeJob(workspace, jobId, {
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      errorMessage: "Cancelled by user."
    });
    return {
      exitStatus: 0,
      payload: { ok: true },
      rendered: "Finished the task.\n",
      summary: "did the work",
      warnings: []
    };
  };

  await runTrackedJob(job, runner, {});

  const indexed = listJobs(workspace).find((entry) => entry.id === jobId);
  assert.equal(indexed.status, "cancelled");
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.rendered, undefined, "a cancelled job must not adopt the owner's late result");
});

test("owner completion commits both records atomically when it wins the race", async () => {
  const workspace = makeTempDir();
  const jobId = "task-owner-win";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "queued", title: "Codex Task", jobClass: "task" }]
  });

  const job = { id: jobId, workspaceRoot: workspace, title: "Codex Task", jobClass: "task" };
  await runTrackedJob(
    job,
    async () => ({
      exitStatus: 0,
      payload: { ok: true },
      rendered: "Finished the task.\n",
      summary: "did the work",
      warnings: []
    }),
    {}
  );

  const indexed = listJobs(workspace).find((entry) => entry.id === jobId);
  assert.equal(indexed.status, "completed");
  assert.equal(indexed.summary, "did the work");
  assert.equal(indexed.rendered, undefined, "the shared index must not carry the rendered result");
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(stored.status, "completed");
  assert.equal(stored.rendered, "Finished the task.\n");
});

test("active tracked jobs refresh a heartbeat without imposing a runtime deadline", async () => {
  const workspace = makeTempDir();
  const jobId = "task-heartbeat";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "queued", title: "Codex Task", jobClass: "task" }]
  });

  let firstHeartbeat = null;
  let refreshedHeartbeat = null;
  await runTrackedJob(
    { id: jobId, workspaceRoot: workspace, title: "Codex Task", jobClass: "task" },
    async () => {
      firstHeartbeat = listJobs(workspace).find((entry) => entry.id === jobId)?.heartbeatAt;
      refreshedHeartbeat = await waitFor(
        () => {
          const heartbeatAt = listJobs(workspace).find((entry) => entry.id === jobId)?.heartbeatAt;
          return heartbeatAt && heartbeatAt !== firstHeartbeat ? heartbeatAt : null;
        },
        { timeoutMs: 1000, intervalMs: 10 }
      );
      return { exitStatus: 0, payload: { ok: true }, rendered: "done\n", summary: "done", warnings: [] };
    },
    { heartbeatIntervalMs: 20 }
  );

  assert.ok(firstHeartbeat);
  assert.ok(refreshedHeartbeat);
  const completed = listJobs(workspace).find((entry) => entry.id === jobId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.pid, null);
  assert.ok(completed.heartbeatAt);
});

function assertReconstructedRunningRecord(stored, owner) {
  assert.equal(stored.id, owner.id);
  assert.equal(stored.status, "running");
  assert.equal(stored.title, owner.title);
  assert.equal(stored.jobClass, owner.jobClass);
  assert.equal(stored.summary, owner.summary);
  assert.equal(stored.workspaceRoot, owner.workspaceRoot);
  assert.equal(stored.pid, owner.pid);
  assert.equal(stored.processStartTime, owner.processStartTime);
  assert.equal(stored.startedAt, owner.startedAt);
  assert.ok(stored.heartbeatAt);
  assert.notEqual(Object.keys(stored).sort().join(","), "heartbeatAt");
}

test("heartbeat reconstructs a missing or corrupt job file with the complete running record", async () => {
  const workspace = makeTempDir();
  const jobId = "task-heartbeat-rebuild";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "queued", title: "Codex Task", jobClass: "task" }]
  });

  const job = {
    id: jobId,
    workspaceRoot: workspace,
    title: "Codex Task",
    jobClass: "task",
    summary: "Investigate flaky test"
  };

  await runTrackedJob(
    job,
    async () => {
      const jobFile = resolveJobFile(workspace, jobId);
      const owner = listJobs(workspace).find((entry) => entry.id === jobId);
      assert.equal(owner?.status, "running");

      for (const mutate of [
        () => {
          fs.unlinkSync(jobFile);
        },
        () => {
          fs.writeFileSync(jobFile, "{not-json", "utf8");
        }
      ]) {
        mutate();
        const stored = await waitFor(
          () => {
            if (!fs.existsSync(jobFile)) {
              return null;
            }
            try {
              const parsed = JSON.parse(fs.readFileSync(jobFile, "utf8"));
              return parsed.id === jobId && parsed.pid === owner.pid && parsed.heartbeatAt ? parsed : null;
            } catch {
              return null;
            }
          },
          { timeoutMs: 1000, intervalMs: 10 }
        );
        assertReconstructedRunningRecord(stored, owner);
      }

      return { exitStatus: 0, payload: { ok: true }, rendered: "done\n", summary: "done", warnings: [] };
    },
    { heartbeatIntervalMs: 20 }
  );
});

test("heartbeat does not resurrect or overwrite a cancelled job", async () => {
  const workspace = makeTempDir();
  const jobId = "task-heartbeat-cancelled";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "queued", title: "Codex Task", jobClass: "task" }]
  });

  await runTrackedJob(
    { id: jobId, workspaceRoot: workspace, title: "Codex Task", jobClass: "task" },
    async () => {
      await waitFor(
        () => {
          const heartbeatAt = listJobs(workspace).find((entry) => entry.id === jobId)?.heartbeatAt;
          const startedAt = listJobs(workspace).find((entry) => entry.id === jobId)?.startedAt;
          return heartbeatAt && startedAt && heartbeatAt !== startedAt ? heartbeatAt : null;
        },
        { timeoutMs: 1000, intervalMs: 10 }
      );

      finalizeJob(workspace, jobId, {
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        errorMessage: "Cancelled by user."
      });

      const stateFile = path.join(resolveStateDir(workspace), "state.json");
      const jobFile = resolveJobFile(workspace, jobId);
      const frozenState = fs.readFileSync(stateFile, "utf8");
      const frozenJob = fs.readFileSync(jobFile, "utf8");

      await new Promise((resolve) => setTimeout(resolve, 160));

      assert.equal(fs.readFileSync(stateFile, "utf8"), frozenState);
      assert.equal(fs.readFileSync(jobFile, "utf8"), frozenJob);
      assert.equal(listJobs(workspace).find((entry) => entry.id === jobId)?.status, "cancelled");

      return { exitStatus: 0, payload: { ok: true }, rendered: "done\n", summary: "done", warnings: [] };
    },
    { heartbeatIntervalMs: 20 }
  );
});

test("heartbeat does not reinsert a missing index entry", async () => {
  const workspace = makeTempDir();
  const jobId = "task-heartbeat-missing-index";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "queued", title: "Codex Task", jobClass: "task" }]
  });

  await runTrackedJob(
    { id: jobId, workspaceRoot: workspace, title: "Codex Task", jobClass: "task" },
    async () => {
      await waitFor(
        () => {
          const heartbeatAt = listJobs(workspace).find((entry) => entry.id === jobId)?.heartbeatAt;
          const startedAt = listJobs(workspace).find((entry) => entry.id === jobId)?.startedAt;
          return heartbeatAt && startedAt && heartbeatAt !== startedAt ? heartbeatAt : null;
        },
        { timeoutMs: 1000, intervalMs: 10 }
      );

      saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });
      const stateFile = path.join(resolveStateDir(workspace), "state.json");
      const jobFile = resolveJobFile(workspace, jobId);
      const frozenState = fs.readFileSync(stateFile, "utf8");
      const frozenJob = fs.readFileSync(jobFile, "utf8");

      await new Promise((resolve) => setTimeout(resolve, 160));

      assert.equal(fs.readFileSync(stateFile, "utf8"), frozenState);
      assert.equal(fs.readFileSync(jobFile, "utf8"), frozenJob);
      assert.equal(
        listJobs(workspace).find((entry) => entry.id === jobId),
        undefined,
        "a heartbeat must not reinsert a vanished index entry"
      );

      return { exitStatus: 0, payload: { ok: true }, rendered: "done\n", summary: "done", warnings: [] };
    },
    { heartbeatIntervalMs: 20 }
  );
});

test("owner refuses to resurrect a job cancelled before it starts", async () => {
  const workspace = makeTempDir();
  const jobId = "task-precancelled";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "cancelled", phase: "cancelled", title: "Codex Task" }]
  });

  let ran = false;
  const result = await runTrackedJob(
    { id: jobId, workspaceRoot: workspace, title: "Codex Task" },
    async () => {
      ran = true;
      return { exitStatus: 0, payload: {}, rendered: "x\n", summary: "s", warnings: [] };
    },
    {}
  );

  assert.equal(ran, false, "the runner must not execute for an already-cancelled job");
  assert.equal(result, null);
  assert.equal(listJobs(workspace).find((entry) => entry.id === jobId).status, "cancelled");
});

test("owner re-inserts its result when the index entry disappears mid-run", async () => {
  const workspace = makeTempDir();
  const jobId = "task-missing-index";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "queued", title: "Codex Task", jobClass: "task" }]
  });

  const runner = async () => {
    // Simulate unexpected state loss while the job runs.
    saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });
    return { exitStatus: 0, payload: { ok: true }, rendered: "done\n", summary: "did the work", warnings: [] };
  };

  await runTrackedJob({ id: jobId, workspaceRoot: workspace, title: "Codex Task", jobClass: "task" }, runner, {});

  const indexed = listJobs(workspace).find((entry) => entry.id === jobId);
  assert.ok(indexed, "a completed result must be re-inserted, not silently discarded");
  assert.equal(indexed.status, "completed");
  assert.equal(indexed.summary, "did the work");
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(stored.rendered, "done\n");
});

function seedIndexedJobs(workspace, jobs) {
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });
  for (const job of jobs) {
    fs.writeFileSync(resolveJobFile(workspace, job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  }
}

test("failQueuedLaunch fails only a still-queued launch", () => {
  const workspace = makeTempDir();
  const queuedId = "task-queued-launch";
  const runningId = "task-running-launch";
  const cancelledId = "task-cancelled-launch";
  seedIndexedJobs(workspace, [
    {
      id: queuedId,
      status: "queued",
      phase: "queued",
      title: "Codex Task",
      jobClass: "task",
      pid: null
    },
    {
      id: runningId,
      status: "running",
      phase: "starting",
      title: "Codex Task",
      jobClass: "task",
      pid: 4242
    },
    {
      id: cancelledId,
      status: "cancelled",
      phase: "cancelled",
      title: "Codex Task",
      jobClass: "task",
      pid: null
    }
  ]);

  const queuedOutcome = failQueuedLaunch(workspace, queuedId, "Failed to launch the background task worker: spawn ENOENT");
  const runningOutcome = failQueuedLaunch(workspace, runningId, "Failed to launch the background task worker: spawn ENOENT");
  const cancelledOutcome = failQueuedLaunch(workspace, cancelledId, "Failed to launch the background task worker: spawn ENOENT");

  assert.equal(queuedOutcome.applied, true);
  assert.equal(listJobs(workspace).find((job) => job.id === queuedId).status, "failed");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, queuedId), "utf8")).status, "failed");

  assert.equal(runningOutcome.applied, false);
  const running = listJobs(workspace).find((job) => job.id === runningId);
  assert.equal(running.status, "running");
  assert.equal(running.pid, 4242);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, runningId), "utf8")).status, "running");

  assert.equal(cancelledOutcome.applied, false);
  assert.equal(listJobs(workspace).find((job) => job.id === cancelledId).status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, cancelledId), "utf8")).status, "cancelled");
});

test("claimJobRunning claims only a still-active launch", () => {
  const workspace = makeTempDir();
  const queuedId = "task-claim-queued";
  const cancelledId = "task-claim-cancelled";
  seedIndexedJobs(workspace, [
    {
      id: queuedId,
      status: "queued",
      phase: "queued",
      title: "Codex Task",
      jobClass: "task",
      pid: null
    },
    {
      id: cancelledId,
      status: "cancelled",
      phase: "cancelled",
      title: "Codex Task",
      jobClass: "task",
      pid: null
    }
  ]);

  const queuedOutcome = claimJobRunning(workspace, {
    id: queuedId,
    status: "running",
    phase: "starting",
    title: "Codex Task",
    jobClass: "task",
    pid: 4242,
    processStartTime: "start-4242"
  });
  const cancelledOutcome = claimJobRunning(workspace, {
    id: cancelledId,
    status: "running",
    phase: "starting",
    title: "Codex Task",
    jobClass: "task",
    pid: 4343,
    processStartTime: "start-4343"
  });

  assert.equal(queuedOutcome.applied, true);
  const claimed = listJobs(workspace).find((job) => job.id === queuedId);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.pid, 4242);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, queuedId), "utf8")).status, "running");

  assert.equal(cancelledOutcome.applied, false);
  assert.equal(listJobs(workspace).find((job) => job.id === cancelledId).status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, cancelledId), "utf8")).status, "cancelled");
});

test("claimJobRunning does not resurrect a stored terminal record when the index is still queued", () => {
  const workspace = makeTempDir();
  const jobId = "task-claim-split";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "queued", phase: "queued", title: "Codex Task", jobClass: "task" }]
  });
  fs.writeFileSync(
    resolveJobFile(workspace, jobId),
    `${JSON.stringify({ id: jobId, status: "cancelled", phase: "cancelled", title: "Codex Task" }, null, 2)}\n`,
    "utf8"
  );

  const outcome = claimJobRunning(workspace, {
    id: jobId,
    status: "running",
    phase: "starting",
    title: "Codex Task",
    jobClass: "task",
    pid: 88,
    processStartTime: "start-88"
  });

  assert.equal(outcome.applied, false);
  assert.equal(listJobs(workspace).find((job) => job.id === jobId).status, "queued");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8")).status, "cancelled");
});

test("claimJobRunning does not re-insert a missing index over a stored terminal record", () => {
  const workspace = makeTempDir();
  const jobId = "task-claim-missing";
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });
  fs.mkdirSync(path.dirname(resolveJobFile(workspace, jobId)), { recursive: true });
  fs.writeFileSync(
    resolveJobFile(workspace, jobId),
    `${JSON.stringify(
      {
        id: jobId,
        status: "failed",
        phase: "failed",
        title: "Codex Task",
        errorMessage: "Job failed: its Claude session ended before the job completed."
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const outcome = claimJobRunning(workspace, {
    id: jobId,
    status: "running",
    phase: "starting",
    title: "Codex Task",
    jobClass: "task",
    pid: 99,
    processStartTime: "start-99"
  });

  assert.equal(outcome.applied, false);
  assert.equal(listJobs(workspace).find((job) => job.id === jobId), undefined);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8")).status, "failed");
});

test("completeTrackedJob completes only a still-active job", () => {
  const workspace = makeTempDir();
  const runningId = "task-complete-running";
  const cancelledId = "task-complete-cancelled";
  seedIndexedJobs(workspace, [
    {
      id: runningId,
      status: "running",
      phase: "starting",
      title: "Codex Task",
      jobClass: "task",
      pid: 4242
    },
    {
      id: cancelledId,
      status: "cancelled",
      phase: "cancelled",
      title: "Codex Task",
      jobClass: "task",
      pid: null
    }
  ]);

  const runningOutcome = completeTrackedJob(
    workspace,
    {
      id: runningId,
      status: "running",
      phase: "starting",
      title: "Codex Task",
      jobClass: "task",
      pid: 4242,
      processStartTime: "start-4242"
    },
    { exitStatus: 0, payload: { ok: true }, rendered: "done\n", summary: "did the work", warnings: [] }
  );
  const cancelledOutcome = completeTrackedJob(
    workspace,
    {
      id: cancelledId,
      status: "running",
      phase: "starting",
      title: "Codex Task",
      jobClass: "task",
      pid: 4343,
      processStartTime: "start-4343"
    },
    { exitStatus: 0, payload: { ok: true }, rendered: "done\n", summary: "too late", warnings: [] }
  );

  assert.equal(runningOutcome.applied, true);
  const completed = listJobs(workspace).find((job) => job.id === runningId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.pid, null);
  assert.equal(completed.summary, "did the work");
  const storedCompleted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, runningId), "utf8"));
  assert.equal(storedCompleted.status, "completed");
  assert.equal(storedCompleted.rendered, "done\n");
  assert.equal(storedCompleted.pid, null);

  assert.equal(cancelledOutcome.applied, false);
  assert.equal(listJobs(workspace).find((job) => job.id === cancelledId).status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, cancelledId), "utf8")).status, "cancelled");
});

test("completeTrackedJob does not overwrite a stored terminal record", () => {
  const workspace = makeTempDir();
  const splitId = "task-complete-split";
  const missingId = "task-complete-missing";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: splitId, status: "running", phase: "starting", title: "Codex Task", jobClass: "task", pid: 88 }]
  });
  fs.writeFileSync(
    resolveJobFile(workspace, splitId),
    `${JSON.stringify({ id: splitId, status: "cancelled", phase: "cancelled", title: "Codex Task" }, null, 2)}\n`,
    "utf8"
  );
  fs.mkdirSync(path.dirname(resolveJobFile(workspace, missingId)), { recursive: true });
  fs.writeFileSync(
    resolveJobFile(workspace, missingId),
    `${JSON.stringify(
      {
        id: missingId,
        status: "failed",
        phase: "failed",
        title: "Codex Task",
        errorMessage: "Job failed: its Claude session ended before the job completed."
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const splitOutcome = completeTrackedJob(
    workspace,
    {
      id: splitId,
      status: "running",
      phase: "starting",
      title: "Codex Task",
      jobClass: "task",
      pid: 88,
      processStartTime: "start-88"
    },
    { exitStatus: 0, payload: { ok: true }, rendered: "done\n", summary: "too late", warnings: [] }
  );
  const missingOutcome = completeTrackedJob(
    workspace,
    {
      id: missingId,
      status: "running",
      phase: "starting",
      title: "Codex Task",
      jobClass: "task",
      pid: 99,
      processStartTime: "start-99"
    },
    { exitStatus: 0, payload: { ok: true }, rendered: "done\n", summary: "too late", warnings: [] }
  );

  assert.equal(splitOutcome.applied, false);
  assert.equal(listJobs(workspace).find((job) => job.id === splitId).status, "running");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, splitId), "utf8")).status, "cancelled");

  assert.equal(missingOutcome.applied, false);
  assert.equal(listJobs(workspace).find((job) => job.id === missingId), undefined);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, missingId), "utf8")).status, "failed");
});

test("failTrackedJob fails only a still-active job", () => {
  const workspace = makeTempDir();
  const runningId = "task-fail-running";
  const cancelledId = "task-fail-cancelled";
  seedIndexedJobs(workspace, [
    {
      id: runningId,
      status: "running",
      phase: "starting",
      title: "Codex Task",
      jobClass: "task",
      pid: 4242
    },
    {
      id: cancelledId,
      status: "cancelled",
      phase: "cancelled",
      title: "Codex Task",
      jobClass: "task",
      pid: null
    }
  ]);

  const runningOutcome = failTrackedJob(workspace, {
    id: runningId,
    status: "running",
    phase: "starting",
    title: "Codex Task",
    jobClass: "task",
    pid: 4242,
    processStartTime: "start-4242"
  }, "runner threw");
  const cancelledOutcome = failTrackedJob(workspace, {
    id: cancelledId,
    status: "running",
    phase: "starting",
    title: "Codex Task",
    jobClass: "task",
    pid: 4343,
    processStartTime: "start-4343"
  }, "too late");

  assert.equal(runningOutcome.applied, true);
  const failed = listJobs(workspace).find((job) => job.id === runningId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.pid, null);
  assert.equal(failed.errorMessage, "runner threw");
  const storedFailed = JSON.parse(fs.readFileSync(resolveJobFile(workspace, runningId), "utf8"));
  assert.equal(storedFailed.status, "failed");
  assert.equal(storedFailed.errorMessage, "runner threw");
  assert.equal(storedFailed.pid, null);

  assert.equal(cancelledOutcome.applied, false);
  assert.equal(listJobs(workspace).find((job) => job.id === cancelledId).status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, cancelledId), "utf8")).status, "cancelled");
});

test("failTrackedJob does not overwrite a stored terminal record", () => {
  const workspace = makeTempDir();
  const splitId = "task-fail-split";
  const missingId = "task-fail-missing";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: splitId, status: "running", phase: "starting", title: "Codex Task", jobClass: "task", pid: 88 }]
  });
  fs.writeFileSync(
    resolveJobFile(workspace, splitId),
    `${JSON.stringify({ id: splitId, status: "completed", phase: "done", title: "Codex Task" }, null, 2)}\n`,
    "utf8"
  );
  fs.mkdirSync(path.dirname(resolveJobFile(workspace, missingId)), { recursive: true });
  fs.writeFileSync(
    resolveJobFile(workspace, missingId),
    `${JSON.stringify(
      {
        id: missingId,
        status: "cancelled",
        phase: "cancelled",
        title: "Codex Task",
        errorMessage: "Cancelled by user."
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const splitOutcome = failTrackedJob(
    workspace,
    {
      id: splitId,
      status: "running",
      phase: "starting",
      title: "Codex Task",
      jobClass: "task",
      pid: 88,
      processStartTime: "start-88"
    },
    "runner threw"
  );
  const missingOutcome = failTrackedJob(
    workspace,
    {
      id: missingId,
      status: "running",
      phase: "starting",
      title: "Codex Task",
      jobClass: "task",
      pid: 99,
      processStartTime: "start-99"
    },
    "runner threw"
  );

  assert.equal(splitOutcome.applied, false);
  assert.equal(listJobs(workspace).find((job) => job.id === splitId).status, "running");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, splitId), "utf8")).status, "completed");

  assert.equal(missingOutcome.applied, false);
  assert.equal(listJobs(workspace).find((job) => job.id === missingId), undefined);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, missingId), "utf8")).status, "cancelled");
});

test("failQueuedLaunch does not clobber a stored running record when the index is still queued", () => {
  const workspace = makeTempDir();
  const jobId = "task-split-launch";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "queued", phase: "queued", title: "Codex Task", jobClass: "task" }]
  });
  fs.writeFileSync(
    resolveJobFile(workspace, jobId),
    `${JSON.stringify({ id: jobId, status: "running", phase: "starting", pid: 77, title: "Codex Task" }, null, 2)}\n`,
    "utf8"
  );

  const outcome = failQueuedLaunch(workspace, jobId, "Failed to launch the background task worker: spawn ENOENT");

  assert.equal(outcome.applied, false);
  assert.equal(listJobs(workspace).find((job) => job.id === jobId).status, "queued");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8")).status, "running");
});

test("progress updates never resurrect or split a cancelled job", () => {
  const workspace = makeTempDir();
  const jobId = "task-progress-cancelled";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "cancelled", phase: "cancelled", title: "Codex Task" }]
  });
  fs.writeFileSync(
    resolveJobFile(workspace, jobId),
    JSON.stringify({ id: jobId, status: "cancelled", phase: "cancelled" }, null, 2),
    "utf8"
  );

  const update = createJobProgressUpdater(workspace, jobId);
  update({ phase: "investigating", threadId: "thr_late" });

  const indexed = listJobs(workspace).find((entry) => entry.id === jobId);
  assert.equal(indexed.status, "cancelled");
  assert.equal(indexed.phase, "cancelled", "a late progress event must not overwrite a terminal phase");
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.phase, "cancelled");
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("await-result nudges for every terminal status without exposing stored output", () => {
  const terminalStatuses = [
    "completed",
    "completed-with-warnings",
    "blocked",
    "failed",
    "interrupted",
    "cancelled"
  ];

  for (const status of terminalStatuses) {
    const workspace = makeTempDir();
    const jobId = `task-${status}`;
    saveState(workspace, {
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: jobId,
          status,
          title: "Codex Task",
          sessionId: "session-a",
          rendered: "secret full output",
          createdAt: "2026-08-12T20:00:00.000Z",
          completedAt: "2026-08-12T20:01:00.000Z"
        }
      ]
    });

    const result = run("node", [SCRIPT, "await-result", jobId], {
      cwd: workspace,
      env: { ...process.env, CODEX_COMPANION_SESSION_ID: "session-a" }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      `Codex job ${jobId} finished with status ${status}. Run /codex-router:result ${jobId} to view the full result.\n`
    );
    assert.doesNotMatch(result.stdout, /secret full output/);
  }
});

test("await-result keeps completion nudges isolated to the originating Claude session", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-session-a",
        status: "completed",
        title: "Codex Task",
        sessionId: "session-a",
        createdAt: "2026-08-12T20:00:00.000Z",
        completedAt: "2026-08-12T20:01:00.000Z"
      },
      {
        id: "task-session-b",
        status: "completed",
        title: "Codex Task",
        sessionId: "session-b",
        createdAt: "2026-08-12T20:00:00.000Z",
        completedAt: "2026-08-12T20:01:00.000Z"
      },
      {
        id: "task-session-b-running",
        status: "running",
        title: "Codex Task",
        sessionId: "session-b",
        pid: 99999999,
        createdAt: "2026-08-12T20:00:00.000Z"
      }
    ]
  });

  const own = run("node", [SCRIPT, "await-result", "task-session-a"], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "session-a" }
  });
  const other = run("node", [SCRIPT, "await-result", "task-session-b"], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "session-a" }
  });

  assert.equal(own.status, 0, own.stderr);
  assert.equal((own.stdout.match(/finished with status/g) ?? []).length, 1);
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /No job found for "task-session-b"/i);
  assert.doesNotMatch(other.stderr, /belongs to a different Claude session/i);
  assert.equal(other.stdout, "");
  assert.equal(
    listJobs(workspace).find((job) => job.id === "task-session-b-running")?.status,
    "running",
    "watching session A must not reconcile or mutate session B"
  );
});

test("await-result times out on a still-active job without leaking stored output", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        sessionId: "session-a",
        rendered: "secret full output",
        createdAt: "2026-08-12T20:00:00.000Z",
        updatedAt: "2026-08-12T20:00:01.000Z"
      }
    ]
  });

  const result = run("node", [SCRIPT, "await-result", "task-live", "--timeout-ms", "50"], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "session-a" }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Timed out waiting for Codex job task-live/);
  assert.match(result.stderr, /still running/);
  assert.doesNotMatch(result.stdout, /secret full output/);
  assert.doesNotMatch(result.stderr, /secret full output/);
});

test("await-result --json emits only jobId, status, and resultCommand", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-json-shape",
        status: "completed",
        title: "Codex Task",
        sessionId: "session-a",
        rendered: "secret full output",
        createdAt: "2026-08-12T20:00:00.000Z",
        completedAt: "2026-08-12T20:01:00.000Z"
      }
    ]
  });

  const result = run("node", [SCRIPT, "await-result", "task-json-shape", "--json"], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "session-a" }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    jobId: "task-json-shape",
    status: "completed",
    resultCommand: "/codex-router:result task-json-shape"
  });
  assert.doesNotMatch(result.stdout, /secret full output/);
});

test("await-result without a Claude session id allows any job", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-agy",
        status: "completed",
        title: "Codex Task",
        sessionId: "session-a",
        createdAt: "2026-08-12T20:00:00.000Z",
        completedAt: "2026-08-12T20:01:00.000Z"
      }
    ]
  });

  const env = { ...process.env };
  delete env.CODEX_COMPANION_SESSION_ID;
  const result = run("node", [SCRIPT, "await-result", "task-agy"], {
    cwd: workspace,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex job task-agy finished with status completed/);
});

test("analyze and exec --background completion is visible through await-result", async () => {
  for (const { subcommand, prompt } of [
    { subcommand: "analyze", prompt: "inspect cache behavior" },
    { subcommand: "exec", prompt: "fix cache behavior" }
  ]) {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    installFakeCodex(binDir, "slow-task");
    initGitRepo(repo);

    const launched = run("node", [SCRIPT, subcommand, "--background", prompt], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    assert.equal(launched.status, 0, `${subcommand}: ${launched.stderr}`);
    const jobId = launched.stdout.match(new RegExp(`\\b(${subcommand}-[a-z0-9-]+)\\b`))?.[1];
    assert.match(jobId ?? "", new RegExp(`^${subcommand}-`));

    const notification = run("node", [SCRIPT, "await-result", jobId, "--timeout-ms", "15000"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    assert.equal(notification.status, 0, `${subcommand} await-result: ${notification.stderr}`);
    assert.equal(
      notification.stdout,
      `Codex job ${jobId} finished with status completed. Run /codex-router:result ${jobId} to view the full result.\n`
    );
    assert.doesNotMatch(notification.stdout, /Handled the requested task/);
  }
});

test("await-result still finds an active job after many newer jobs are recorded", () => {
  const workspace = makeTempDir();
  const completed = Array.from({ length: 50 }, (_, index) => ({
    id: `task-newer-${index}`,
    status: "completed",
    title: "Codex Task",
    sessionId: "session-a",
    createdAt: "2026-08-12T21:00:00.000Z",
    updatedAt: new Date(Date.UTC(2026, 7, 12, 21, 0, index)).toISOString()
  }));
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-old-running",
        status: "running",
        title: "Codex Task",
        sessionId: "session-a",
        rendered: "secret full output",
        createdAt: "2026-08-12T20:00:00.000Z",
        updatedAt: "2026-08-12T20:00:01.000Z"
      },
      ...completed
    ]
  });

  const indexed = listJobs(workspace);
  assert.equal(indexed.length, 51);
  assert.ok(indexed.some((job) => job.id === "task-old-running"));

  const result = run("node", [SCRIPT, "await-result", "task-old-running", "--timeout-ms", "40"], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "session-a" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Timed out waiting for Codex job task-old-running/);
  assert.doesNotMatch(result.stderr, /No job found/);
});

test("concurrent await-result watchers stay correlated and emit once per exact job", async () => {
  const workspace = makeTempDir();
  const jobs = [
    { id: "task-concurrent-a", finalStatus: "completed" },
    { id: "task-concurrent-b", finalStatus: "failed" }
  ];
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: jobs.map(({ id }) => ({
      id,
      status: "running",
      title: "Codex Task",
      sessionId: "session-a",
      createdAt: "2026-08-12T20:00:00.000Z"
    }))
  });

  const env = { ...process.env, CODEX_COMPANION_SESSION_ID: "session-a" };
  const watchers = jobs.map(({ id }) =>
    runAsync("node", [SCRIPT, "await-result", id, "--poll-interval-ms", "100", "--timeout-ms", "5000"], {
      cwd: workspace,
      env
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const { id, finalStatus } of jobs) {
    finalizeJob(workspace, id, {
      status: finalStatus,
      phase: finalStatus === "completed" ? "done" : "failed",
      completedAt: "2026-08-12T20:01:00.000Z"
    });
  }

  const results = await Promise.all(watchers);
  for (let index = 0; index < jobs.length; index += 1) {
    const { id, finalStatus } = jobs[index];
    const result = results[index];
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      `Codex job ${id} finished with status ${finalStatus}. Run /codex-router:result ${id} to view the full result.\n`
    );
    assert.equal((result.stdout.match(/finished with status/g) ?? []).length, 1);
    assert.doesNotMatch(result.stdout, new RegExp(jobs[1 - index].id));
  }
});

test("wait and background are mutually exclusive on every applicable companion command", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);

  for (const subcommand of ["task", "analyze", "exec", "review", "adversarial-review"]) {
    const result = run("node", [SCRIPT, subcommand, "--wait", "--background", "do work"], {
      cwd: workspace
    });
    assert.notEqual(result.status, 0, `${subcommand} unexpectedly succeeded`);
    assert.match(result.stderr, /Choose either --background or --wait, not both/i);
  }

  assert.equal(fs.existsSync(resolveStateDir(workspace)), false, "rejected execution flags must not create job state");
});
