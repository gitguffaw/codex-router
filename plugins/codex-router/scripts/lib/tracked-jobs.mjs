import fs from "node:fs";
import process from "node:process";

import { getProcessStartTime } from "./process.mjs";
import { finalizeJob, resolveJobLogFile } from "./state.mjs";

const DEFAULT_JOB_HEARTBEAT_INTERVAL_MS = 15_000;

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
export const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
export const TERMINAL_JOB_STATUSES = new Set([
  "completed",
  "completed-with-warnings",
  "blocked",
  "failed",
  "interrupted",
  "cancelled"
]);
export const SESSION_ENDED_MESSAGE = "Job failed: its Claude session ended before the job completed.";
export const ORPHANED_JOB_MESSAGE =
  "Job runtime exited without recording a result. Marked failed by orphan detection.";

export function nowIso() {
  return new Date().toISOString();
}

export function isActiveJobStatus(status) {
  return ACTIVE_JOB_STATUSES.has(status);
}

export function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

function phaseForJobStatus(status) {
  switch (status) {
    case "completed":
    case "completed-with-warnings":
      return "done";
    case "blocked":
      return "blocked";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

function normalizeExecutionJobStatus(execution) {
  if (TERMINAL_JOB_STATUSES.has(execution?.jobStatus)) {
    return execution.jobStatus;
  }
  if (execution?.exitStatus === 0) {
    return Array.isArray(execution.warnings) && execution.warnings.length > 0 ? "completed-with-warnings" : "completed";
  }
  return "failed";
}

function redactSecrets(value) {
  return String(value ?? "")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "sk-REDACTED")
    .replace(/(OPENAI_API_KEY=)[^\s]+/g, "$1REDACTED")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1REDACTED");
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = redactSecrets(message).trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${redactSecrets(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    // Commit the progress patch to both records under one lock. Skip a job that
    // is gone or already terminal so a late progress event can never resurrect
    // a missing job or split a record a cancel just finalized.
    finalizeJob(workspaceRoot, jobId, ({ entry }) =>
      entry && isActiveJobStatus(entry.status) ? patch : null
    );
  };
}

export function buildAdoptedResultPatch(stored) {
  return {
    status: stored.status,
    phase: stored.phase ?? null,
    pid: null,
    completedAt: stored.completedAt ?? null,
    ...(stored.threadId ? { threadId: stored.threadId } : {}),
    ...(stored.errorMessage ? { errorMessage: stored.errorMessage } : {})
  };
}

export function claimJobRunning(workspaceRoot, runningRecord) {
  return finalizeJob(
    workspaceRoot,
    runningRecord.id,
    ({ entry }) => (entry && isTerminalJobStatus(entry.status) ? null : runningRecord),
    { allowInsert: true, insertBase: runningRecord, storedFallback: runningRecord }
  );
}

export function writeJobHeartbeat(workspaceRoot, runningRecord, heartbeatAt = nowIso()) {
  return finalizeJob(
    workspaceRoot,
    runningRecord.id,
    ({ entry }) =>
      entry &&
      isActiveJobStatus(entry.status) &&
      entry.pid === runningRecord.pid &&
      entry.processStartTime === runningRecord.processStartTime
        ? { heartbeatAt }
        : null,
    { storedFallback: runningRecord }
  );
}

export function completeTrackedJob(workspaceRoot, runningRecord, execution, options = {}) {
  const completionStatus = normalizeExecutionJobStatus(execution);
  const completionPhase = phaseForJobStatus(completionStatus);
  const completedAt = nowIso();
  const job = options.job ?? runningRecord;
  return finalizeJob(
    workspaceRoot,
    runningRecord.id,
    ({ entry }) => {
      if (entry && !isActiveJobStatus(entry.status)) {
        return null;
      }
      return {
        $file: {
          ...runningRecord,
          status: completionStatus,
          threadId: execution.threadId ?? null,
          turnId: execution.turnId ?? null,
          pid: null,
          phase: completionPhase,
          heartbeatAt: completedAt,
          completedAt,
          result: execution.payload,
          rendered: execution.rendered,
          warnings: execution.warnings ?? []
        },
        $index: {
          status: completionStatus,
          threadId: execution.threadId ?? null,
          turnId: execution.turnId ?? null,
          summary: execution.summary,
          phase: completionPhase,
          pid: null,
          heartbeatAt: completedAt,
          completedAt,
          model: execution.model ?? job.model ?? null,
          effort: execution.effort ?? job.effort ?? null,
          serviceTier: execution.serviceTier ?? job.serviceTier ?? null,
          warnings: execution.warnings ?? []
        }
      };
    },
    { allowInsert: true, insertBase: runningRecord, storedFallback: runningRecord }
  );
}

export function failTrackedJob(workspaceRoot, runningRecord, errorMessage, options = {}) {
  const completedAt = nowIso();
  return finalizeJob(
    workspaceRoot,
    runningRecord.id,
    ({ entry, stored }) => {
      if (entry && !isActiveJobStatus(entry.status)) {
        return null;
      }
      const base = stored ?? runningRecord;
      const failurePatch = {
        status: "failed",
        phase: "failed",
        errorMessage,
        pid: null,
        heartbeatAt: completedAt,
        completedAt
      };
      return {
        $file: {
          ...base,
          ...failurePatch,
          logFile: options.logFile ?? runningRecord.logFile ?? base.logFile ?? null
        },
        $index: failurePatch
      };
    },
    { allowInsert: true, insertBase: runningRecord, storedFallback: runningRecord }
  );
}

export function failQueuedLaunch(workspaceRoot, jobId, errorMessage) {
  return finalizeJob(workspaceRoot, jobId, ({ entry, stored }) => {
    // A late spawn 'error' must not fail a worker that already claimed
    // running, or overwrite a first-terminal result already on disk.
    if (!entry || entry.status !== "queued") {
      return null;
    }
    if (stored && stored.status && stored.status !== "queued") {
      return null;
    }
    return {
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt: nowIso()
    };
  });
}

export function finalizeCancelJob(workspaceRoot, jobId, { existing = {}, job = {} } = {}) {
  const completedAt = nowIso();
  const cancelPatch = {
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user.",
    cancelledAt: completedAt
  };
  return finalizeJob(
    workspaceRoot,
    jobId,
    ({ entry, stored }) => {
      if (stored && isTerminalJobStatus(stored.status)) {
        return buildAdoptedResultPatch(stored);
      }
      if (entry && isTerminalJobStatus(entry.status)) {
        return buildAdoptedResultPatch(entry);
      }
      return cancelPatch;
    },
    { storedFallback: { ...existing, ...job } }
  );
}

export function tombstoneSessionJob(workspaceRoot, job) {
  return finalizeJob(
    workspaceRoot,
    job.id,
    ({ entry, stored }) => {
      if (!entry || isTerminalJobStatus(entry.status)) {
        return null;
      }
      if (stored && isTerminalJobStatus(stored.status)) {
        return null;
      }
      return {
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage: SESSION_ENDED_MESSAGE,
        completedAt: nowIso()
      };
    },
    { storedFallback: job }
  );
}

export function finalizeOrphanedJob(workspaceRoot, job) {
  return finalizeJob(
    workspaceRoot,
    job.id,
    ({ stored }) => {
      if (stored && isTerminalJobStatus(stored.status)) {
        return buildAdoptedResultPatch(stored);
      }
      return {
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage: ORPHANED_JOB_MESSAGE,
        completedAt: nowIso()
      };
    },
    {
      guard: ({ entry }) => entry != null && isActiveJobStatus(entry.status),
      storedFallback: job
    }
  );
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  const startedAt = nowIso();
  const runningRecord = {
    ...job,
    status: "running",
    startedAt,
    heartbeatAt: startedAt,
    phase: "starting",
    pid: process.pid,
    processStartTime: getProcessStartTime(process.pid),
    logFile: options.logFile ?? job.logFile ?? null
  };

  // Claim the job under the lock. If it was cancelled (or otherwise finalized)
  // before this runtime got going, back off without running — never resurrect a
  // terminal job to "running". allowInsert recovers a missing index entry.
  const startOutcome = claimJobRunning(job.workspaceRoot, runningRecord);
  if (!startOutcome.applied) {
    return null;
  }

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_JOB_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimer =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          try {
            writeJobHeartbeat(job.workspaceRoot, runningRecord);
          } catch {
            // Heartbeats are advisory activity telemetry. Lock contention or a
            // transient state write must never terminate the actual worker.
          }
        }, heartbeatIntervalMs)
      : null;
  heartbeatTimer?.unref?.();

  try {
    const execution = await runner();
    completeTrackedJob(job.workspaceRoot, runningRecord, execution, { job });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    failTrackedJob(job.workspaceRoot, runningRecord, errorMessage, {
      logFile: options.logFile ?? job.logFile ?? null
    });
    throw error;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}
