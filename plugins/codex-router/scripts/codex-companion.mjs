#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

import { hasLeadingHelpFlag, splitRawArgumentString } from "./lib/args.mjs";
import {
  getCodexAuthStatus,
  getCodexAvailability,
  getCodexDefaultModelStatus,
  getCodexModelsReport,
  getSessionRuntimeStatus
} from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  handleAwaitResultCommand,
  handleCancelCommand,
  handleResultCommand,
  handleStatusCommand,
  handleTaskResumeCandidateCommand
} from "./lib/job-commands.mjs";
import { readStoredJob } from "./lib/job-control.mjs";
import {
  COMMAND_SPECS,
  launchTrackedCommand,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace
} from "./lib/launch.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import { executeStoredRequest } from "./lib/run-command.mjs";
import { getConfig, setConfig } from "./lib/state.mjs";
import { createTrackedProgress } from "./lib/detached-launch.mjs";
import { runTrackedJob } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { renderModelsReport, renderSetupReport } from "./lib/render.mjs";

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
    "  node scripts/codex-companion.mjs analyze [--background] [--search] [--docs] [--tool <capability>] [--parallel] [--best|--spark|--model <selector>] [--service-tier <tier>|--fast] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>] [prompt]",
  exec:
    "  node scripts/codex-companion.mjs exec [--background] [--search] [--docs] [--tool <capability>] [--parallel] [--best|--spark|--model <selector>] [--service-tier <tier>|--fast] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>] [prompt]",
  review:
    "  node scripts/codex-companion.mjs review [--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--best|--spark|--model <selector>] [--service-tier <tier>|--fast] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>]",
  "adversarial-review":
    "  node scripts/codex-companion.mjs adversarial-review [--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--best|--spark|--model <selector>] [--service-tier <tier>|--fast] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>] [focus text]",
  task:
    "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <selector>] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>] [prompt]",
  status: "  node scripts/codex-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
  "await-result": "  node scripts/codex-companion.mjs await-result <job-id> [--timeout-ms <ms>] [--json]",
  result: "  node scripts/codex-companion.mjs result [job-id] [--json]",
  cancel: "  node scripts/codex-companion.mjs cancel [job-id] [--json]",
  cli: "  node scripts/codex-companion.mjs cli <codex args...>"
};

const COMMAND_HELP_NOTES = {
  analyze: [
    "  Foreground is the default. Pass --background to detach a tracked worker.",
    "  --wait is only valid on status. Options are parsed only before the prompt begins. Use -- to end options."
  ],
  exec: [
    "  Foreground is the default. Pass --background to detach a tracked worker.",
    "  --wait is only valid on status. Options are parsed only before the prompt begins. Use -- to end options."
  ],
  task: [
    "  Foreground is the default. Pass --background to detach a tracked worker.",
    "  --wait is only valid on status. Options are parsed only before the prompt begins. Use -- to end options."
  ],
  review: [
    "  Foreground is the default. Pass --background to detach a tracked worker.",
    "  Focus text is not accepted; use adversarial-review for steered review. Use -- to end options."
  ],
  "adversarial-review": [
    "  Foreground is the default. Pass --background to detach a tracked worker.",
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
    () => executeStoredRequest(storedJob, request, progress),
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

  if (COMMAND_SPECS[subcommand]) {
    await launchTrackedCommand(subcommand, argv);
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "models":
      await handleModels(argv);
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
