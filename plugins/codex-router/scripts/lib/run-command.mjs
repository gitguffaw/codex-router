import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  getCodexAvailability,
  parseStructuredOutput,
  readOutputSchema,
  runAppServerReview,
  runAppServerTurn
} from "./codex.mjs";
import {
  filterJobsForCurrentSession,
  isTaskJob,
  listReconciledJobs,
  sortJobsNewestFirst
} from "./job-control.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./git.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./prompts.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderTaskResult
} from "./render.mjs";
import { isActiveJobStatus, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

export function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

export function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex-router:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }
  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }
  return null;
}

export function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `The built-in reviewer does not support custom focus text. Run the companion adversarial-review command with this focus instead: ${focusText.trim()}`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This review target is not supported by the built-in reviewer. Run the companion adversarial-review command for custom targeting.");
  }

  return nativeTarget;
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

export function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listReconciledJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentSession(jobs, { env: process.env });
  const activeTask = visibleJobs.find((job) => isTaskJob(job) && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex-router:status before continuing it.`);
  }

  const trackedTask = visibleJobs.find((job) => isTaskJob(job) && job.threadId && !isActiveJobStatus(job.status)) ?? null;
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

export function resolveRunner(job, request = {}) {
  if (request.runner === "native" || request.runner === "steered" || request.runner === "turn") {
    return request.runner;
  }
  if (job.jobClass === "native-review") {
    return "native";
  }
  if (job.command === "adversarial-review" || job.kind === "adversarial-review") {
    return "steered";
  }
  if (job.jobClass === "review") {
    return request.reviewName === "Adversarial Review" ? "steered" : "native";
  }
  return "turn";
}

export async function executeNativeReview(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewTarget = validateNativeReviewRequest(target, focusText);
  const result = await runAppServerReview(request.cwd, {
    target: reviewTarget,
    model: request.model,
    configOverrides: request.configOverrides,
    configArgs: request.configArgs,
    onProgress: request.onProgress
  });
  const reviewName = request.reviewName ?? "Review";
  const payload = {
    review: reviewName,
    target,
    contextPack: request.contextPack ?? null,
    mode: "review",
    serviceTier: request.serviceTier ?? null,
    threadId: result.threadId,
    sourceThreadId: result.sourceThreadId,
    codex: {
      status: result.status,
      jobStatus: result.jobStatus,
      turnStatus: result.turnStatus,
      stderr: result.stderr,
      stdout: result.reviewText,
      reasoning: result.reasoningSummary,
      warnings: result.warnings
    }
  };
  const rendered = renderNativeReviewResult(
    {
      status: result.status,
      stdout: result.reviewText,
      stderr: result.stderr
    },
    { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
  );

  return {
    exitStatus: result.status,
    jobStatus: result.jobStatus,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
    jobTitle: `Codex ${reviewName}`,
    targetLabel: target.label,
    model: request.model ?? null,
    effort: request.effort ?? null,
    serviceTier: request.serviceTier ?? null,
    warnings: result.warnings ?? []
  };
}

export async function executeSteeredReview(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Adversarial Review";
  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    configOverrides: request.configOverrides,
    configArgs: request.configArgs,
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    contextPack: request.contextPack ?? null,
    mode: "review",
    serviceTier: request.serviceTier ?? null,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      jobStatus: result.jobStatus,
      turnStatus: result.turnStatus,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary,
      warnings: result.warnings
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    jobStatus: result.jobStatus,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    targetLabel: context.target.label,
    model: request.model ?? null,
    effort: request.effort ?? null,
    serviceTier: request.serviceTier ?? null,
    warnings: result.warnings ?? []
  };
}

export async function executeTurnRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = request.taskMetadata ?? buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    configOverrides: request.configOverrides,
    configArgs: request.configArgs,
    onProgress: request.onProgress,
    persistThread: request.persistThread !== false,
    threadName: resumeThreadId
      ? null
      : request.threadName ?? buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult({
    rawOutput,
    failureMessage
  });
  const payload = {
    status: result.status,
    jobStatus: result.jobStatus,
    turnStatus: result.turnStatus,
    threadId: result.threadId,
    mode: request.mode ?? "task",
    workflow: request.workflow ?? null,
    modifiers: request.modifiers ?? [],
    contextPack: request.contextPack ?? null,
    model: request.model ?? null,
    effort: request.effort ?? null,
    serviceTier: request.serviceTier ?? null,
    configArgs: request.configArgs ?? [],
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    warnings: result.warnings
  };

  return {
    exitStatus: result.status,
    jobStatus: result.jobStatus,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    write: Boolean(request.write),
    contextPackId: request.contextPack?.id ?? null,
    model: request.model ?? null,
    effort: request.effort ?? null,
    serviceTier: request.serviceTier ?? null,
    warnings: result.warnings ?? []
  };
}

export async function executeStoredRequest(job, request, progress) {
  const runner = resolveRunner(job, request);
  const withProgress = { ...request, onProgress: progress };
  if (runner === "native") {
    return executeNativeReview(withProgress);
  }
  if (runner === "steered") {
    return executeSteeredReview(withProgress);
  }
  return executeTurnRun(withProgress);
}

export { STOP_REVIEW_TASK_MARKER };
