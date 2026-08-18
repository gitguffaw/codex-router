import { spawn } from "node:child_process";
import process from "node:process";

import { getProcessStartTime } from "./process.mjs";
import { finalizeJob, upsertJob, writeJobFile } from "./state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createProgressReporter,
  failQueuedLaunch
} from "./tracked-jobs.mjs";

export function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

export function spawnDetachedTaskWorker({ cwd, jobId, scriptPath, workerNode }) {
  const nodeBinary = workerNode || process.env.CODEX_COMPANION_TASK_WORKER_NODE || process.execPath;
  const child = spawn(nodeBinary, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

export function failWorkerLaunch(job, logFile, error) {
  const message = `Failed to launch the background task worker: ${
    error instanceof Error ? error.message : String(error)
  }`;
  appendLogLine(logFile, message);
  failQueuedLaunch(job.workspaceRoot, job.id, message);
  return message;
}

export function enqueueBackgroundTask({ cwd, job, request, scriptPath, workerNode }) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // Persist the queued record (carrying the request payload) BEFORE spawning
  // the worker, so the detached worker always finds its request when it reads
  // the job file. The worker records its own pid and start-time identity when it
  // transitions to running; the parent never probes the child's start time
  // (that probe is slow on Windows and would race the worker's first read).
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    processStartTime: null,
    launcherPid: process.pid,
    launcherProcessStartTime: getProcessStartTime(process.pid),
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  let child;
  try {
    child = spawnDetachedTaskWorker({ cwd, jobId: job.id, scriptPath, workerNode });
  } catch (error) {
    throw new Error(failWorkerLaunch(job, logFile, error));
  }

  child.on("error", (error) => {
    failWorkerLaunch(job, logFile, error);
  });

  if (child.pid) {
    finalizeJob(job.workspaceRoot, job.id, ({ entry }) =>
      entry && entry.status === "queued" ? { pid: child.pid } : null
    );
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}
