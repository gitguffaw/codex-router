import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getProcessStartTime } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-router");
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_FILE_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const STATE_LOCK_TIMEOUT_MS = 2000;
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_STALE_MS = 10000;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: 0o700 });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireStateLock(cwd) {
  const lockFile = path.join(resolveStateDir(cwd), STATE_LOCK_FILE_NAME);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });

  // The lock must appear with its full ownership record in one atomic step, so a
  // contender can never observe a half-written lock and reclaim it while the
  // owner is still acquiring. Hardlinking a pre-written owner file gives us
  // atomic create-with-content; linkSync fails with EEXIST when contended.
  // The record carries pid + process start time so reclaim can distinguish the
  // original holder from an unrelated process that reused its PID.
  const nonce = randomBytes(8).toString("hex");
  const token = JSON.stringify({
    pid: process.pid,
    startTime: getProcessStartTime(process.pid),
    nonce
  });
  const ownerFile = `${lockFile}.owner-${process.pid}-${nonce}`;
  fs.writeFileSync(ownerFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });

  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  try {
    for (;;) {
      try {
        fs.linkSync(ownerFile, lockFile);
        return { lockFile, ownerFile, token };
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }

      let holderToken = null;
      let holderMtimeMs = Number.POSITIVE_INFINITY;
      try {
        holderToken = fs.readFileSync(lockFile, "utf8").trim();
        holderMtimeMs = fs.statSync(lockFile).mtimeMs;
      } catch {
        // The lock vanished between linkSync and the probe — retry immediately.
        continue;
      }

      const aged = Date.now() - holderMtimeMs > STATE_LOCK_STALE_MS;
      let holder = null;
      try {
        holder = JSON.parse(holderToken);
      } catch {
        holder = null;
      }

      let stale;
      if (!holder || !Number.isFinite(holder.pid) || holder.pid <= 0) {
        // Malformed or legacy lock: reclaim only after it has sat unchanged
        // past the stale threshold.
        stale = aged;
      } else {
        let holderDead = false;
        try {
          process.kill(holder.pid, 0);
        } catch (probeError) {
          holderDead = probeError?.code !== "EPERM";
        }
        if (holderDead) {
          stale = true;
        } else {
          // The PID exists, but it may be an unrelated process that reused it.
          // Compare recorded vs current process start time: a mismatch proves
          // reuse (reclaim now); a match proves the original holder is alive
          // (never steal, no matter how old the lock is). When identity cannot
          // be verified on either side, never steal a possibly-live holder —
          // failing the acquisition loudly is recoverable, silently corrupting
          // state under a live writer is not.
          const currentStartTime = getProcessStartTime(holder.pid);
          if (holder.startTime && currentStartTime) {
            stale = holder.startTime !== currentStartTime;
          } else {
            stale = false;
          }
        }
      }

      if (stale) {
        // Re-verify the lock is still the one we probed before reclaiming, so
        // we never delete a lock a different contender just acquired.
        try {
          if (fs.readFileSync(lockFile, "utf8").trim() === holderToken) {
            fs.unlinkSync(lockFile);
          }
        } catch {
          // Lock changed or vanished — loop and re-evaluate.
        }
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the Codex Router state lock.");
      }
      sleepSync(STATE_LOCK_RETRY_MS);
    }
  } catch (error) {
    try {
      fs.unlinkSync(ownerFile);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
}

function releaseStateLock(lock) {
  try {
    // Only remove the lock if we still own it; a stale-reclaim by another
    // process must never be compounded by us deleting their lock.
    if (fs.readFileSync(lock.lockFile, "utf8").trim() === lock.token) {
      fs.unlinkSync(lock.lockFile);
    }
  } catch {
    // Already removed or reclaimed.
  }
  try {
    fs.unlinkSync(lock.ownerFile);
  } catch {
    // Already removed.
  }
}

function withStateLock(cwd, fn) {
  const lock = acquireStateLock(cwd);
  try {
    return fn();
  } finally {
    releaseStateLock(lock);
  }
}

function saveStateLocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  const stateFile = resolveStateFile(cwd);
  const tempFile = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tempFile, `${JSON.stringify(nextState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, stateFile);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateLocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateLocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function assertValidJobId(jobId) {
  if (!/^[a-z][a-z0-9-]*-[a-z0-9-]+$/.test(String(jobId ?? ""))) {
    throw new Error(`Invalid Codex Router job id: ${jobId}`);
  }
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

// Atomically move a job to a terminal state in BOTH the state index and the
// per-job file. EVERY terminal transition — the owning runtime's own
// completion/failure as well as cancel commands and orphan reconciliation —
// must go through here. Deciding from the entry/file and then writing them as
// separate unlocked steps lets writers interleave and split the index from the
// stored result; doing both under this lock makes the two records move as one.
//
// `patchOrFn` may be a patch object or a function of ({ entry, stored })
// evaluated under the lock. The decision may return:
//   - a plain patch  → merged into both the index entry and the job file;
//   - `{ $index, $file }` → distinct payloads for the index and the job file
//     (used by the owner, whose full `rendered` result belongs only in the
//     file, never bloating the shared index);
//   - `null`/`undefined` → veto: nothing is written (first-terminal-wins, so a
//     late owner completion never overwrites a cancellation, and vice versa).
//
// `options.guard` can veto from the same under-lock view; `options.storedFallback`
// seeds the job file when none exists yet.
//
// By default a job with no index entry is NOT written: for cancel/reconcile,
// patching only the job file would recreate a dangling file the index no longer
// tracks. The owning runtime is authoritative for its own job, so it passes
// `options.allowInsert` (with `options.insertBase`) to re-add an entry the
// pruner evicted mid-run, rather than silently dropping its own result.
export function finalizeJob(cwd, jobId, patchOrFn, options = {}) {
  assertValidJobId(jobId);
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const index = state.jobs.findIndex((job) => job.id === jobId);
    const entry = index === -1 ? null : state.jobs[index];
    const jobFile = resolveJobFile(cwd, jobId);
    let stored = null;
    if (fs.existsSync(jobFile)) {
      try {
        stored = readJobFile(jobFile);
      } catch {
        stored = null;
      }
    }

    if ((entry == null && !options.allowInsert) || (options.guard && !options.guard({ entry, stored }))) {
      return { applied: false, inserted: false, patch: null, entry, stored };
    }

    const decision = typeof patchOrFn === "function" ? patchOrFn({ entry, stored }) : patchOrFn;
    if (decision == null) {
      return { applied: false, inserted: false, patch: null, entry, stored };
    }

    const split = decision.$index !== undefined || decision.$file !== undefined;
    const indexPatch = split ? decision.$index ?? {} : decision;
    const filePatch = split ? decision.$file ?? {} : decision;

    const timestamp = nowIso();
    if (index === -1) {
      state.jobs.unshift({
        id: jobId,
        createdAt: timestamp,
        ...(options.insertBase ?? {}),
        ...indexPatch,
        updatedAt: timestamp
      });
    } else {
      state.jobs[index] = {
        ...entry,
        ...indexPatch,
        updatedAt: timestamp
      };
    }
    writeJobFile(cwd, jobId, { ...(stored ?? options.storedFallback ?? {}), ...filePatch });
    saveStateLocked(cwd, state);
    return { applied: true, inserted: index === -1, patch: indexPatch, entry, stored };
  });
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  assertValidJobId(jobId);
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  // Write via temp + atomic rename so a process killed mid-write (e.g. a
  // worker SIGKILLed by cancel while flushing its result) can never leave a
  // torn, unparseable job file that destroys a previously-good record.
  const tempFile = `${jobFile}.tmp-${process.pid}`;
  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, jobFile);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  assertValidJobId(jobId);
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  assertValidJobId(jobId);
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
