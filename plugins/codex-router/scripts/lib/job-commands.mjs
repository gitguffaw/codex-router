import process from "node:process";
import path from "node:path";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import { interruptAppServerTurn } from "./codex.mjs";
import {
  buildExactJobSnapshot,
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  filterJobsForCurrentSession,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./job-control.mjs";
import { terminateWithEscalation } from "./process.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderStatusReport,
  renderStoredJobResult
} from "./render.mjs";
import { listJobs } from "./state.mjs";
import { appendLogLine, finalizeCancelJob, isActiveJobStatus, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// Long-running Codex jobs routinely exceed the old four-minute default. Keep
// an explicit timeout so an abandoned waiter eventually exits, but make the
// default comfortably longer than Claude Code's 15-minute Stop-hook window.
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_AWAIT_RESULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

export function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

export function filterJobsForCurrentClaudeSession(jobs) {
  return filterJobsForCurrentSession(jobs, { env: process.env });
}

export function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        !isActiveJobStatus(job.status)
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  const buildSnapshot = options.exactReference ? buildExactJobSnapshot : buildSingleJobSnapshot;
  const snapshotOptions = options.exactReference ? { authorize: options.authorize } : {};
  let snapshot = buildSnapshot(cwd, reference, snapshotOptions);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
    snapshot = buildSnapshot(cwd, reference, snapshotOptions);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

export function waitForExactJobSnapshot(cwd, jobId, options = {}) {
  return waitForSingleJobSnapshot(cwd, jobId, {
    timeoutMs: options.timeoutMs ?? DEFAULT_AWAIT_RESULT_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs,
    exactReference: true,
    authorize: jobBelongsToCurrentSession
  });
}

function jobBelongsToCurrentSession(job) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return true;
  }
  return job.sessionId === sessionId;
}

function missingJobError(reference) {
  return new Error(`No job found for "${reference}". Run /codex-router:status to list known jobs.`);
}

function renderCompletionNudge(job) {
  return `Codex job ${job.id} finished with status ${job.status}. Run /codex-router:result ${job.id} to view the full result.\n`;
}

export async function handleStatusCommand(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

export async function handleAwaitResultCommand(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw new Error("`await-result` requires a job id.");
  }

  // Resolve the exact index entry and authorize before reconciliation on every
  // poll. A Claude-owned notifier must never inspect, mutate, or wake its
  // session for another session's job in the same repo. Other-session ids use
  // the same not-found error so existence is not leaked.
  const snapshot = await waitForExactJobSnapshot(cwd, reference, {
    timeoutMs: options["timeout-ms"],
    pollIntervalMs: options["poll-interval-ms"]
  });
  if (!jobBelongsToCurrentSession(snapshot.job)) {
    throw missingJobError(reference);
  }

  if (snapshot.waitTimedOut) {
    throw new Error(`Timed out waiting for Codex job ${snapshot.job.id}; it is still ${snapshot.job.status}.`);
  }

  const payload = {
    jobId: snapshot.job.id,
    status: snapshot.job.status,
    resultCommand: `/codex-router:result ${snapshot.job.id}`
  };
  outputCommandResult(payload, renderCompletionNudge(snapshot.job), options.json);
}

export function handleResultCommand(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

export function handleTaskResumeCandidateCommand(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

export async function handleCancelCommand(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  await terminateWithEscalation(job.pid ?? Number.NaN, {
    processStartTime: existing.processStartTime ?? job.processStartTime ?? null
  });

  const outcome = finalizeCancelJob(workspaceRoot, job.id, { existing, job });

  const finalStatus = outcome.applied ? outcome.patch.status : outcome.entry?.status ?? job.status;
  const cancelled = finalStatus === "cancelled";
  if (cancelled) {
    appendLogLine(job.logFile, "Cancelled by user.");
  }

  const nextJob = {
    ...job,
    ...(outcome.applied ? outcome.patch : outcome.entry ?? {})
  };

  const payload = {
    jobId: job.id,
    status: finalStatus,
    title: job.title,
    cancelled,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}
