#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { hasLeadingHelpFlag, parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getCodexDefaultModelStatus,
    getCodexModelsReport,
    getSessionRuntimeStatus,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { createContextPack } from "./lib/context-pack.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  filterJobsForCurrentClaudeSession,
  findLatestResumableTaskJob,
  getCurrentClaudeSessionId,
  handleAwaitResultCommand,
  handleCancelCommand,
  handleResultCommand,
  handleStatusCommand,
  handleTaskResumeCandidateCommand,
  waitForExactJobSnapshot
} from "./lib/job-commands.mjs";
import { applyInheritedModelFallback, resolveModelControls } from "./lib/model-resolution.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { buildRouterRequest } from "./lib/router.mjs";
import { generateJobId, getConfig, setConfig } from "./lib/state.mjs";
import {
  listReconciledJobs,
  readStoredJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { createTrackedProgress, enqueueBackgroundTask } from "./lib/detached-launch.mjs";
import {
  createJobRecord,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderModelsReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
/** Router directives supported on analyze/exec turn modes only. */
const TURN_ONLY_ROUTER_DIRECTIVES = new Set(["search", "docs", "tool", "parallel"]);

const PUBLIC_COMMANDS = [
  "setup",
  "models",
  "analyze",
  "exec",
  "review",
  "adversarial-review",
  "task",
  "status",
  "result",
  "cancel",
  "cli"
];

const COMMAND_USAGE = {
  setup: "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
  models: "  node scripts/codex-companion.mjs models [--all] [--json]",
  analyze:
    "  node scripts/codex-companion.mjs analyze [--wait|--background] [--search] [--docs] [--tool <capability>] [--parallel] [--best|--spark|--model <selector>] [--service-tier <tier>|--fast] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>] [prompt]",
  exec:
    "  node scripts/codex-companion.mjs exec [--wait|--background] [--search] [--docs] [--tool <capability>] [--parallel] [--best|--spark|--model <selector>] [--service-tier <tier>|--fast] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>] [prompt]",
  review:
    "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--best|--spark|--model <selector>] [--service-tier <tier>|--fast] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>]",
  "adversarial-review":
    "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--best|--spark|--model <selector>] [--service-tier <tier>|--fast] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>] [focus text]",
  task:
    "  node scripts/codex-companion.mjs task [--wait|--background] [--write] [--resume-last|--resume|--fresh] [--model <selector>] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>] [prompt]",
  status: "  node scripts/codex-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
  "await-result": "  node scripts/codex-companion.mjs await-result <job-id> [--timeout-ms <ms>] [--json]",
  result: "  node scripts/codex-companion.mjs result [job-id] [--json]",
  cancel: "  node scripts/codex-companion.mjs cancel [job-id] [--json]",
  cli: "  node scripts/codex-companion.mjs cli <codex args...>"
};

const COMMAND_HELP_NOTES = {
  analyze: [
    "  Leading --wait and --background are mutually exclusive execution flags.",
    "  Options are parsed only before the prompt begins. Use -- to end options."
  ],
  exec: [
    "  Leading --wait and --background are mutually exclusive execution flags.",
    "  Options are parsed only before the prompt begins. Use -- to end options."
  ],
  task: [
    "  Leading --wait and --background are mutually exclusive execution flags.",
    "  Options are parsed only before the prompt begins. Use -- to end options."
  ],
  review: [
    "  Leading --wait and --background are mutually exclusive execution flags.",
    "  Options are parsed only before focus text begins. Use -- to end options."
  ],
  "adversarial-review": [
    "  Leading --wait and --background are mutually exclusive execution flags.",
    "  Options are parsed only before focus text begins. Use -- to end options."
  ],
  "await-result": [
    "  Internal host-tracked completion watcher. Not a user-facing slash command.",
    "  Emits one terminal-status nudge. Full output stays on the result command."
  ]
};

function printUsage(command) {
  const lines = ["Usage:"];
  if (command && COMMAND_USAGE[command]) {
    lines.push(COMMAND_USAGE[command]);
    lines.push(...(COMMAND_HELP_NOTES[command] ?? []));
  } else {
    for (const name of PUBLIC_COMMANDS) {
      lines.push(COMMAND_USAGE[name]);
    }
  }
  console.log(lines.join("\n"));
}

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

function hasHelpFlag(argv) {
  return hasLeadingHelpFlag(normalizeArgv(argv));
}

function validateExecutionModeFlags(options = {}) {
  if (options.background && options.wait) {
    throw new Error("Choose either --background or --wait, not both.");
  }
}

/**
 * Review modes do not support analyze/exec routing directives. Fail explicitly
 * instead of treating flags such as `--docs` as free-form focus text.
 * @param {object} options
 * @param {string} commandLabel
 */
function rejectUnsupportedReviewDirectives(options, commandLabel) {
  for (const rawKey of TURN_ONLY_ROUTER_DIRECTIVES) {
    if (options[rawKey]) {
      throw new Error(
        `${commandLabel} does not support --${rawKey}. ` +
          "Use /codex-router:analyze or /codex-router:exec for Codex-native routing directives " +
          "(--search, --docs, --tool, --parallel). " +
          "Focus text for steerable review is plain language after the flags, not those directives."
      );
    }
  }
}

function handleCliCommand(argv) {
  const tokens = normalizeArgv(argv);
  if (tokens.length === 0) {
    throw new Error("Provide Codex CLI arguments, for example: /codex-router:cli features list");
  }

  const result = spawnSync("codex", tokens, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    input: readStdinIfPiped() || undefined,
    shell: process.platform === "win32",
    windowsHide: true
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
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

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function asArray(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function collectConfigArgs(options = {}) {
  return [
    ...asArray(options.config),
    ...asArray(options.enable).map((feature) => `features.${feature}=true`),
    ...asArray(options.disable).map((feature) => `features.${feature}=false`)
  ].filter((value) => String(value ?? "").trim());
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function applyDefaultModelFallback(cwd, modelControls) {
  return applyInheritedModelFallback(modelControls, {
    cwd,
    loadDefaultModelStatus: () => getCodexDefaultModelStatus(cwd)
  });
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const modelStatus = await getCodexDefaultModelStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (modelStatus.supported === false) {
    nextSteps.push(
      modelStatus.recommendedModel
        ? `Update the active Codex model pin to \`model = "${modelStatus.recommendedModel}"\`, or remove the \`model\` line so Codex can use its current default.`
        : "Remove the active Codex `model` pin so Codex can use its current default."
    );
    nextSteps.push("Run `/codex-router:models` to inspect the live model catalog and available effort levels.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex-router:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    model: modelStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

async function handleModels(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const report = await getCodexModelsReport(cwd, {
    env: process.env,
    includeHidden: Boolean(options.all)
  });
  outputResult(options.json ? report : renderModelsReport(report), options.json);
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

function ensureCodexAvailable(cwd) {
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

function validateNativeReviewRequest(target, focusText) {
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

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listReconciledJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex-router:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      configOverrides: request.configOverrides,
      configArgs: request.configArgs,
      onProgress: request.onProgress
    });
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
      jobClass: "review",
      targetLabel: target.label,
      model: request.model ?? null,
      effort: request.effort ?? null,
      serviceTier: request.serviceTier ?? null,
      warnings: result.warnings ?? []
    };
  }

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
    jobClass: "review",
    targetLabel: context.target.label,
    model: request.model ?? null,
    effort: request.effort ?? null,
    serviceTier: request.serviceTier ?? null,
    warnings: result.warnings ?? []
  };
}


async function executeTaskRun(request) {
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
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
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
    jobClass: "task",
    write: Boolean(request.write),
    contextPackId: request.contextPack?.id ?? null,
    model: request.model ?? null,
    effort: request.effort ?? null,
    serviceTier: request.serviceTier ?? null,
    warnings: result.warnings ?? []
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function effectiveReviewName(requestedReviewName, focusText) {
  if (requestedReviewName === "Review" && focusText.trim()) {
    return "Adversarial Review";
  }
  return requestedReviewName;
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
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

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex-router:status ${payload.jobId} for progress. Full output will not appear automatically; run /codex-router:result ${payload.jobId} after completion. Ending the originating session marks the job failed.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (kind === "analyze" || kind === "exec") {
    return kind;
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({
  prefix,
  kind,
  title,
  workspaceRoot,
  jobClass,
  summary,
  write = false,
  contextPack = null,
  model = null,
  effort = null,
  serviceTier = null
}) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    model,
    effort,
    serviceTier,
    contextPackId: contextPack?.id ?? null,
    policyHash: contextPack?.policyHash ?? null
  });
}

function buildTaskJob(workspaceRoot, taskMetadata, write, model = null, effort = null) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write,
    model,
    effort,
    serviceTier: null
  });
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function companionScriptPath() {
  return path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
}

function enqueueCompanionJob(cwd, job, request) {
  return enqueueBackgroundTask({
    cwd,
    job,
    request,
    scriptPath: companionScriptPath()
  });
}

async function dispatchTrackedRun({ options, cwd, job, request, runner }) {
  if (options.background) {
    ensureCodexAvailable(cwd);
    const { payload } = enqueueCompanionJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => runner({ ...request, onProgress: progress }), {
    json: options.json
  });
}

async function handleReviewCommand(argv, config) {
  const commandLabel =
    config.reviewName === "Adversarial Review" ? "/codex-router:adversarial-review" : "/codex-router:review";

  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "effort", "service-tier"],
    arrayOptions: ["config", "enable", "disable"],
    booleanOptions: ["json", "background", "wait", "best", "fast", "spark", "search", "docs", "parallel", "tool"],
    aliasMap: {
      m: "model",
      c: "config"
    },
    stopAtPositional: true
  });
  validateExecutionModeFlags(options);
  rejectUnsupportedReviewDirectives(options, commandLabel);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const requestedModelControls = resolveModelControls({
    model: options.model,
    effort: options.effort,
    best: Boolean(options.best),
    fast: Boolean(options.fast),
    spark: Boolean(options.spark),
    serviceTier: options["service-tier"]
  }, { cwd });
  const { modelControls, modelWarning } = await applyDefaultModelFallback(cwd, requestedModelControls);
  const configArgs = collectConfigArgs(options);
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });
  const reviewName = effectiveReviewName(config.reviewName, focusText);

  if (reviewName === config.reviewName) {
    config.validateRequest?.(target, focusText);
  }
  const contextPack = createContextPack(workspaceRoot, {
    mode: "review",
    workflow: reviewName,
    userRequest: focusText,
    prompt: focusText,
    modifiers: [],
    decision: {
      target: target.label,
      model: modelControls.model,
      effort: modelControls.effort,
      serviceTier: modelControls.serviceTier,
      configArgs
    },
    nonGoals: ["Do not edit files from review mode."]
  });
  const metadata = buildReviewJobMetadata(reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary,
    contextPack,
    model: modelControls.model,
    effort: modelControls.effort,
    serviceTier: modelControls.serviceTier
  });
  if (modelWarning && !options.json) {
    process.stderr.write(`${modelWarning}\n`);
  }
  if (options.background) {
    ensureGitRepository(cwd);
  }
  const request = {
    cwd,
    base: options.base,
    scope: options.scope,
    model: modelControls.model,
    effort: modelControls.effort,
    configOverrides: modelControls.configOverrides,
    configArgs,
    serviceTier: modelControls.serviceTier,
    contextPack,
    focusText,
    reviewName
  };
  await dispatchTrackedRun({
    options,
    cwd,
    job,
    request,
    runner: executeReviewRun
  });
}

async function handleRouterTurn(argv, mode) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "service-tier", "cwd", "prompt-file", "tool"],
    arrayOptions: ["config", "enable", "disable"],
    booleanOptions: ["json", "background", "wait", "search", "docs", "parallel", "best", "fast", "spark", "resume-last", "resume", "fresh"],
    aliasMap: {
      m: "model",
      c: "config"
    },
    stopAtPositional: true
  });
  validateExecutionModeFlags(options);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  if (resumeLast && options.fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const requestedModelControls = resolveModelControls({
    model: options.model,
    effort: options.effort,
    best: Boolean(options.best),
    fast: Boolean(options.fast),
    spark: Boolean(options.spark),
    serviceTier: options["service-tier"]
  }, { cwd });
  const { modelControls, modelWarning } = await applyDefaultModelFallback(cwd, requestedModelControls);
  const configArgs = collectConfigArgs(options);
  const route = buildRouterRequest({
    mode,
    prompt,
    options,
    modelControls
  });
  const contextPack = createContextPack(workspaceRoot, {
    mode: route.mode,
    workflow: route.workflow,
    userRequest: route.userRequest,
    prompt: route.prompt,
    modifiers: route.modifiers,
    decision: {
      launchSurface: route.launchSurface,
      sandbox: route.sandbox,
      model: route.model,
      effort: route.effort,
      serviceTier: route.serviceTier,
      configArgs
    },
    nonGoals: route.write ? ["Do not perform unrelated refactors."] : ["Do not edit files from analyze mode."]
  });
  const taskMetadata = {
    title: route.title,
    summary: shorten(route.userRequest || route.title)
  };
  const job = createCompanionJob({
    prefix: mode,
    kind: mode,
    title: route.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write: route.write,
    contextPack,
    model: route.model,
    effort: route.effort,
    serviceTier: route.serviceTier
  });
  const request = {
    cwd,
    model: route.model,
    effort: route.effort,
    prompt: route.prompt,
    write: route.write,
    resumeLast,
    jobId: job.id,
    mode: route.mode,
    workflow: route.workflow,
    modifiers: route.modifiers,
    serviceTier: route.serviceTier,
    configOverrides: route.configOverrides,
    configArgs,
    contextPack,
    taskMetadata
  };
  if (modelWarning && !options.json) {
    process.stderr.write(`${modelWarning}\n`);
  }

  if (options.background) {
    requireTaskRequest(prompt, resumeLast);
  }
  await dispatchTrackedRun({
    options,
    cwd,
    job,
    request,
    runner: executeTaskRun
  });
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    arrayOptions: ["config", "enable", "disable"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "wait", "watch"],
    aliasMap: {
      m: "model",
      c: "config"
    },
    stopAtPositional: true
  });
  validateExecutionModeFlags(options);
  if (options.watch && (options.background || options.wait)) {
    throw new Error("Internal --watch cannot be combined with --background or --wait.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const configArgs = collectConfigArgs(options);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });
  const requestedModelControls = resolveModelControls({
    model: options.model,
    effort: options.effort
  }, { cwd });
  const { modelControls, modelWarning } = await applyDefaultModelFallback(cwd, requestedModelControls);
  const model = modelControls.model;
  const effort = modelControls.effort;
  if (modelWarning && !options.json) {
    process.stderr.write(`${modelWarning}\n`);
  }

  if (options.background || options.watch) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, model, effort);
    const request = {
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      configArgs
    };
    const { payload } = enqueueCompanionJob(cwd, job, request);
    if (options.watch) {
      // The watcher and worker have deliberately separate lifetimes. If the
      // host Bash call expires, it can terminate this process without sending
      // a signal to the detached worker. The exact job id remains available to
      // status/result and is the only record this watcher reconciles.
      process.stderr.write(
        `Codex rescue started as ${job.id}; watcher expiration will not cancel the active job.\n`
      );
      const snapshot = await waitForExactJobSnapshot(cwd, job.id);
      if (snapshot.waitTimedOut) {
        throw new Error(
          `Stopped watching Codex job ${job.id} after ${snapshot.timeoutMs}ms; ` +
            `it is still ${snapshot.job.status} and was not cancelled.`
        );
      }
      const storedJob = readStoredJob(workspaceRoot, job.id);
      outputResult(options.json ? { job: snapshot.job, storedJob } : renderStoredJobResult(snapshot.job, storedJob), options.json);
      return;
    }
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, model, effort);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        configArgs,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () => {
      const run = storedJob.jobClass === "review" ? executeReviewRun : executeTaskRun;
      return run({
        ...request,
        onProgress: progress
      });
    },
    { logFile }
  );
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  const helpAwareCommands = new Set([
    "setup",
    "models",
    "analyze",
    "exec",
    "review",
    "adversarial-review",
    "task",
    "status",
    "await-result",
    "result",
    "cancel"
  ]);
  if (helpAwareCommands.has(subcommand) && hasHelpFlag(argv)) {
    printUsage(subcommand);
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "models":
      await handleModels(argv);
      break;
    case "analyze":
      await handleRouterTurn(argv, "analyze");
      break;
    case "exec":
      await handleRouterTurn(argv, "exec");
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatusCommand(argv);
      break;
    case "await-result":
      await handleAwaitResultCommand(argv);
      break;
    case "result":
      handleResultCommand(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidateCommand(argv);
      break;
    case "cancel":
      await handleCancelCommand(argv);
      break;
    case "cli":
      handleCliCommand(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
