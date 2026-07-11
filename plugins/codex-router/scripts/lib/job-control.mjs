import fs from "node:fs";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { getProcessStartTime } from "./process.mjs";
import { finalizeJob, getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { appendLogLine, isActiveJobStatus, isTerminalJobStatus, nowIso, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "interrupted":
      return "interrupted";
    case "completed":
    case "completed-with-warnings":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      isActiveJobStatus(job.status) || job.status === "failed" || job.status === "blocked" || job.status === "interrupted"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      isTerminalJobStatus(job.status)
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export const ORPHANED_JOB_MESSAGE =
  "Job runtime exited without recording a result. Marked failed by orphan detection.";

function isJobProcessAlive(pid, expectedStartTime, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const getProcessStartTimeImpl = options.getProcessStartTimeImpl ?? getProcessStartTime;

  try {
    killImpl(pid, 0);
  } catch (probeError) {
    if (probeError?.code !== "EPERM") {
      return false;
    }
  }

  // The PID exists, but it may be an unrelated process that reused it. A
  // recorded-vs-current start time mismatch proves reuse; when either side is
  // unknown, treat the job as alive — a false "dead" verdict would fail a
  // job that is still running, which is worse than delayed detection.
  if (expectedStartTime) {
    const currentStartTime = getProcessStartTimeImpl(pid);
    if (currentStartTime && currentStartTime !== expectedStartTime) {
      return false;
    }
  }
  return true;
}

// Patch that syncs a state-index entry to the terminal result its runtime
// recorded in the job file, instead of overwriting that result.
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

export function reconcileOrphanedJobs(workspaceRoot, jobs, options = {}) {
  return jobs.map((job) => {
    if (!isActiveJobStatus(job.status) || !Number.isFinite(job.pid)) {
      return job;
    }
    if (isJobProcessAlive(job.pid, job.processStartTime ?? null, options)) {
      return job;
    }

    // The pid is dead, so the owning runtime can write nothing further — but
    // a cancel command is still a live writer. The whole decision therefore
    // happens under finalizeJob's state lock, against the entry and job file
    // as they exist at that moment.
    const outcome = finalizeJob(
      workspaceRoot,
      job.id,
      ({ stored }) => {
        if (stored && isTerminalJobStatus(stored.status)) {
          // The runtime finished the job but died before its update reached
          // the state index — adopt the recorded result instead of inventing
          // a failure.
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

    if (!outcome.applied) {
      // Another writer (completion or cancel) finalized the job while we
      // probed — report their result, not ours.
      return outcome.entry ?? job;
    }
    if (outcome.patch.errorMessage === ORPHANED_JOB_MESSAGE) {
      appendLogLine(job.logFile, ORPHANED_JOB_MESSAGE);
    }
    return { ...job, ...outcome.patch };
  });
}

export function listReconciledJobs(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return reconcileOrphanedJobs(workspaceRoot, listJobs(workspaceRoot), options);
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /codex-router:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(
    filterJobsForCurrentSession(reconcileOrphanedJobs(workspaceRoot, listJobs(workspaceRoot), options), options)
  );
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => isActiveJobStatus(job.status))
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => !isActiveJobStatus(job.status)) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => !isActiveJobStatus(job.status) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reconcileOrphanedJobs(workspaceRoot, listJobs(workspaceRoot), options));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex-router:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const reconciled = reconcileOrphanedJobs(workspaceRoot, listJobs(workspaceRoot));
  const jobs = sortJobsNewestFirst(reference ? reconciled : filterJobsForCurrentSession(reconciled));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => isTerminalJobStatus(job.status)
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => isActiveJobStatus(job.status));
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex-router:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex-router:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => isActiveJobStatus(job.status));

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex-router:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
