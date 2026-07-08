#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs, setConfig } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CONSECUTIVE_BLOCKS = 3;
const CHAIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Copy the per-session chain map, dropping malformed entries and entries from
// long-gone sessions so the workspace config cannot accumulate stale chains.
function pruneChains(rawChains) {
  const chains = {};
  if (!rawChains || typeof rawChains !== "object") {
    return chains;
  }
  const cutoff = Date.now() - CHAIN_MAX_AGE_MS;
  for (const [key, entry] of Object.entries(rawChains)) {
    const blocks = Number(entry?.blocks);
    const updatedAt = Date.parse(entry?.updatedAt ?? "");
    if (Number.isFinite(blocks) && blocks > 0 && Number.isFinite(updatedAt) && updatedAt >= cutoff) {
      chains[key] = { blocks, updatedAt: entry.updatedAt };
    }
  }
  return chains;
}
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex-router:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /codex-router:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /codex-router:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (/** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task timed out after 15 minutes. Run /codex-router:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Codex review task failed: ${detail}`
        : "The stop-time Codex review task failed. Run /codex-router:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned invalid JSON. Run /codex-router:review --wait manually or bypass the gate."
    };
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /codex-router:status and use /codex-router:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  // Loop protection: Claude Code sets stop_hook_active when the session is
  // already continuing because a stop hook blocked. Track how many times this
  // chain has blocked and stop blocking after MAX_CONSECUTIVE_BLOCKS so a
  // nitpicking or flaky review can never trap the session in an endless
  // fix-review loop. A fresh stop attempt (stop_hook_active absent) resets
  // the chain. Chains are kept in a per-session map so concurrent sessions in
  // the same workspace cannot reset each other's counters.
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || "unknown-session";
  const chains = pruneChains(config.stopReviewGateChains);
  const priorBlocks = input.stop_hook_active ? Number(chains[sessionId]?.blocks) || 0 : 0;

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    if (input.stop_hook_active && priorBlocks >= MAX_CONSECUTIVE_BLOCKS) {
      delete chains[sessionId];
      setConfig(workspaceRoot, "stopReviewGateChains", chains);
      logNote(
        `Stop review gate reached its cap of ${MAX_CONSECUTIVE_BLOCKS} consecutive blocks and is letting the session stop. Unresolved review feedback: ${review.reason}`
      );
      logNote(runningTaskNote);
      return;
    }

    chains[sessionId] = { blocks: priorBlocks + 1, updatedAt: new Date().toISOString() };
    setConfig(workspaceRoot, "stopReviewGateChains", chains);
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  if (chains[sessionId]) {
    delete chains[sessionId];
    setConfig(workspaceRoot, "stopReviewGateChains", chains);
  }
  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
