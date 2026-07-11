import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";
import { finalizeJob, listJobs, resolveJobFile, resolveStateDir, saveState } from "../plugins/codex-router/scripts/lib/state.mjs";
import { createJobProgressUpdater, runTrackedJob } from "../plugins/codex-router/scripts/lib/tracked-jobs.mjs";

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

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
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

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
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
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.codex.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Codex Status/);
  assert.match(status.stdout, /Codex Review/);
  assert.match(status.stdout, /completed/);
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

test("owner re-inserts its result when the pruner evicts the job mid-run", async () => {
  const workspace = makeTempDir();
  const jobId = "task-evicted";
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: jobId, status: "queued", title: "Codex Task", jobClass: "task" }]
  });

  const runner = async () => {
    // Simulate the 50-job pruner evicting this job while it runs.
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
