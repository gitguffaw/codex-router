import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import { createContextPack } from "./context-pack.mjs";
import { createTrackedProgress, enqueueBackgroundTask } from "./detached-launch.mjs";
import { readStdinIfPiped } from "./fs.mjs";
import { ensureGitRepository, resolveReviewTarget } from "./git.mjs";
import { waitForExactJobSnapshot } from "./job-commands.mjs";
import { readStoredJob } from "./job-control.mjs";
import { applyInheritedModelFallback, resolveModelControls } from "./model-resolution.mjs";
import {
  getCodexDefaultModelStatus
} from "./codex.mjs";
import { buildRouterRequest } from "./router.mjs";
import {
  buildTaskRunMetadata,
  ensureCodexAvailable,
  executeStoredRequest,
  shorten,
  validateNativeReviewRequest
} from "./run-command.mjs";
import { generateJobId } from "./state.mjs";
import { createJobRecord, runTrackedJob } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { renderStoredJobResult } from "./render.mjs";

const TURN_ONLY_ROUTER_DIRECTIVES = new Set(["search", "docs", "tool", "parallel"]);

const SHARED_ALIAS_MAP = { m: "model", c: "config" };
const SHARED_ARRAY_OPTIONS = ["config", "enable", "disable"];
const SHARED_MODEL_VALUES = ["model", "effort", "service-tier", "cwd"];
const SHARED_EXEC_BOOL = ["json", "background", "wait", "best", "fast", "spark"];

export const COMMAND_SPECS = {
  analyze: {
    command: "analyze",
    jobClass: "turn",
    runner: "turn",
    prefix: "analyze",
    write: false,
    parse: {
      valueOptions: [...SHARED_MODEL_VALUES, "prompt-file", "tool"],
      arrayOptions: SHARED_ARRAY_OPTIONS,
      booleanOptions: [...SHARED_EXEC_BOOL, "search", "docs", "parallel", "resume-last", "resume", "fresh"],
      aliasMap: SHARED_ALIAS_MAP,
      stopAtPositional: true
    }
  },
  exec: {
    command: "exec",
    jobClass: "turn",
    runner: "turn",
    prefix: "exec",
    write: true,
    parse: {
      valueOptions: [...SHARED_MODEL_VALUES, "prompt-file", "tool"],
      arrayOptions: SHARED_ARRAY_OPTIONS,
      booleanOptions: [...SHARED_EXEC_BOOL, "search", "docs", "parallel", "resume-last", "resume", "fresh"],
      aliasMap: SHARED_ALIAS_MAP,
      stopAtPositional: true
    }
  },
  review: {
    command: "review",
    jobClass: "native-review",
    runner: "native",
    prefix: "review",
    write: false,
    reviewName: "Review",
    rejectFocus: true,
    parse: {
      valueOptions: [...SHARED_MODEL_VALUES, "base", "scope"],
      arrayOptions: SHARED_ARRAY_OPTIONS,
      booleanOptions: [...SHARED_EXEC_BOOL, "search", "docs", "parallel", "tool"],
      aliasMap: SHARED_ALIAS_MAP,
      stopAtPositional: true
    }
  },
  "adversarial-review": {
    command: "adversarial-review",
    jobClass: "turn",
    runner: "steered",
    prefix: "review",
    write: false,
    reviewName: "Adversarial Review",
    parse: {
      valueOptions: [...SHARED_MODEL_VALUES, "base", "scope"],
      arrayOptions: SHARED_ARRAY_OPTIONS,
      booleanOptions: [...SHARED_EXEC_BOOL, "search", "docs", "parallel", "tool"],
      aliasMap: SHARED_ALIAS_MAP,
      stopAtPositional: true
    }
  },
  task: {
    command: "task",
    jobClass: "turn",
    runner: "turn",
    prefix: "task",
    allowWatch: true,
    persistThread: true,
    parse: {
      valueOptions: ["model", "effort", "cwd", "prompt-file"],
      arrayOptions: SHARED_ARRAY_OPTIONS,
      booleanOptions: [...SHARED_EXEC_BOOL, "write", "resume-last", "resume", "fresh", "watch"],
      aliasMap: SHARED_ALIAS_MAP,
      stopAtPositional: true
    }
  }
};

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

export function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

export function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

export function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function asArray(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function collectConfigArgs(options = {}) {
  return [
    ...asArray(options.config),
    ...asArray(options.enable).map((feature) => `features.${feature}=true`),
    ...asArray(options.disable).map((feature) => `features.${feature}=false`)
  ].filter((value) => String(value ?? "").trim());
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

function rejectLaunchWait(options) {
  if (options.wait) {
    throw new Error("--wait is only valid on status. Foreground is the default; pass --background to detach.");
  }
}

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

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex-router:status ${payload.jobId} for progress. Full output will not appear automatically; run /codex-router:result ${payload.jobId} after completion. Ending the originating session marks the job failed.\n`;
}

async function applyDefaultModelFallback(cwd, modelControls) {
  return applyInheritedModelFallback(modelControls, {
    cwd,
    loadDefaultModelStatus: () => getCodexDefaultModelStatus(cwd)
  });
}

function createLaunchJob({ spec, title, summary, workspaceRoot, write, contextPack, model, effort, serviceTier }) {
  return createJobRecord({
    id: generateJobId(spec.prefix),
    command: spec.command,
    kind: spec.command,
    kindLabel: spec.command,
    title,
    workspaceRoot,
    jobClass: spec.jobClass,
    summary,
    write,
    model,
    effort,
    serviceTier,
    contextPackId: contextPack?.id ?? null,
    policyHash: contextPack?.policyHash ?? null
  });
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
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "codex-companion.mjs");
}

function enqueueCompanionJob(cwd, job, request) {
  return enqueueBackgroundTask({
    cwd,
    job,
    request,
    scriptPath: companionScriptPath()
  });
}

async function dispatchTrackedRun({ spec, options, cwd, job, request }) {
  if (options.watch) {
    if (!spec.allowWatch) {
      throw new Error(`--watch is only valid on task.`);
    }
    if (options.background) {
      throw new Error("Internal --watch cannot be combined with --background.");
    }
    ensureCodexAvailable(cwd);
    const { payload } = enqueueCompanionJob(cwd, job, request);
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
    const storedJob = readStoredJob(resolveWorkspaceRoot(cwd), job.id);
    outputResult(options.json ? { job: snapshot.job, storedJob } : renderStoredJobResult(snapshot.job, storedJob), options.json);
    return payload;
  }

  if (options.background) {
    ensureCodexAvailable(cwd);
    const { payload } = enqueueCompanionJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return payload;
  }

  await runForegroundCommand(job, (progress) => executeStoredRequest(job, { ...request, onProgress: progress }, progress), {
    json: options.json
  });
}

async function buildLaunchModel(cwd, options) {
  const requestedModelControls = resolveModelControls({
    model: options.model,
    effort: options.effort,
    best: Boolean(options.best),
    fast: Boolean(options.fast),
    spark: Boolean(options.spark),
    serviceTier: options["service-tier"]
  }, { cwd });
  return applyDefaultModelFallback(cwd, requestedModelControls);
}

function buildTurnLaunch(spec, { options, positionals, cwd, workspaceRoot, modelControls, configArgs }) {
  const prompt = readTaskPrompt(cwd, options, positionals);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  if (resumeLast && options.fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = spec.command === "task" ? Boolean(options.write) : spec.write;
  if (spec.command !== "task") {
    const route = buildRouterRequest({
      mode: spec.command,
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
    const job = createLaunchJob({
      spec,
      title: route.title,
      summary: shorten(route.userRequest || route.title),
      workspaceRoot,
      write: route.write,
      contextPack,
      model: route.model,
      effort: route.effort,
      serviceTier: route.serviceTier
    });
    const request = {
      cwd,
      command: spec.command,
      runner: spec.runner,
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
      persistThread: true,
      taskMetadata: {
        title: route.title,
        summary: shorten(route.userRequest || route.title)
      }
    };
    return { prompt, resumeLast, job, request, requirePrompt: true };
  }

  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });
  const job = createLaunchJob({
    spec,
    title: taskMetadata.title,
    summary: taskMetadata.summary,
    workspaceRoot,
    write,
    model: modelControls.model,
    effort: modelControls.effort,
    serviceTier: null
  });
  const request = {
    cwd,
    command: spec.command,
    runner: spec.runner,
    model: modelControls.model,
    effort: modelControls.effort,
    prompt,
    write,
    resumeLast,
    jobId: job.id,
    persistThread: true,
    configArgs,
    taskMetadata
  };
  return { prompt, resumeLast, job, request, requirePrompt: true };
}

function buildReviewLaunch(spec, { options, positionals, cwd, workspaceRoot, modelControls, configArgs }) {
  const commandLabel =
    spec.command === "adversarial-review" ? "/codex-router:adversarial-review" : "/codex-router:review";
  rejectUnsupportedReviewDirectives(options, commandLabel);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });
  if (spec.rejectFocus) {
    spec.runner === "native" && validateNativeReviewRequest(target, focusText);
  }
  const reviewName = spec.reviewName;
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
  const title = reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`;
  const job = createLaunchJob({
    spec,
    title,
    summary: `${reviewName} ${target.label}`,
    workspaceRoot,
    write: false,
    contextPack,
    model: modelControls.model,
    effort: modelControls.effort,
    serviceTier: modelControls.serviceTier
  });
  const request = {
    cwd,
    command: spec.command,
    runner: spec.runner,
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
  return { prompt: focusText, resumeLast: false, job, request, requirePrompt: false, ensureGitOnBackground: true };
}

export async function launchTrackedCommand(command, argv) {
  const spec = COMMAND_SPECS[command];
  if (!spec) {
    throw new Error(`Unsupported launch command "${command}".`);
  }
  const { options, positionals } = parseCommandInput(argv, spec.parse);
  rejectLaunchWait(options);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const { modelControls, modelWarning } = await buildLaunchModel(cwd, options);
  const configArgs = collectConfigArgs(options);
  if (modelWarning && !options.json) {
    process.stderr.write(`${modelWarning}\n`);
  }

  const built = spec.runner === "turn" && spec.command !== "adversarial-review"
    ? buildTurnLaunch(spec, { options, positionals, cwd, workspaceRoot, modelControls, configArgs })
    : buildReviewLaunch(spec, { options, positionals, cwd, workspaceRoot, modelControls, configArgs });

  if ((options.background || options.watch) && built.requirePrompt) {
    requireTaskRequest(built.prompt, built.resumeLast);
  }
  if ((options.background || options.watch) && built.ensureGitOnBackground) {
    ensureGitRepository(cwd);
  }

  await dispatchTrackedRun({
    spec,
    options,
    cwd,
    job: built.job,
    request: built.request
  });
}
