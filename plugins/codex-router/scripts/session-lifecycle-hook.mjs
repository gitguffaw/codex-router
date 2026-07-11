#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessIfIdentityMatches, terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { finalizeJob, loadState, resolveStateFile } from "./lib/state.mjs";
import { isTerminalJobStatus, nowIso } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

export const SESSION_ENDED_MESSAGE = "Job failed: its Claude session ended before the job completed.";

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  // Re-scan from fresh state until quiescent: a launcher from this session
  // that persists its queued record after an earlier snapshot would otherwise
  // be missed, and its worker would run after the session ended. Bounded so a
  // pathological writer cannot keep the hook alive forever.
  const processed = new Set();
  for (let pass = 0; pass < 5; pass += 1) {
    const candidates = loadState(workspaceRoot).jobs.filter(
      (job) =>
        job.sessionId === sessionId &&
        (job.status === "queued" || job.status === "running") &&
        !processed.has(job.id)
    );
    if (candidates.length === 0) {
      break;
    }
    for (const job of candidates) {
      processed.add(job.id);
      tombstoneSessionJob(workspaceRoot, job);
    }
  }
}

function tombstoneSessionJob(workspaceRoot, job) {
  // Tombstone FIRST, under the state lock. The index entry must stay: a
  // worker's queued->running start write treats a MISSING entry as a pruner
  // eviction and re-inserts it (allowInsert), so removing the entry here
  // would let a not-yet-verifiable worker resurrect the job and run
  // write-capable work after its session ended. A terminal entry instead
  // makes that start write back off. First terminal state wins: an entry
  // that completed or was cancelled meanwhile is left untouched, and a
  // stored terminal record (owner finished, index write lost) is left for
  // read-time reconciliation to adopt.
  const outcome = finalizeJob(
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

  // Kill with the freshest identity recorded under the lock: a worker that
  // reached its start write recorded its own pid + start time there, which
  // the identity check can verify. Terminate only a process whose identity
  // still matches (alive AND same start time), so a recycled pid an
  // unrelated process inherited is never signalled. A worker with no
  // provable identity yet is left alone — the tombstone makes it back off
  // at its start write instead.
  const target = outcome.entry ?? job;
  try {
    terminateProcessIfIdentityMatches(target.pid ?? Number.NaN, target.processStartTime ?? null);
  } catch {
    // Ignore teardown failures during session shutdown.
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
