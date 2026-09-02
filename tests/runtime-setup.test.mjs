import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { loadBrokerSession } from "../plugins/codex-router/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex-router/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex-router");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

test("setup reports ready when fake codex is installed and authenticated", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, loadBrokerSession(workspace) ? "shared" : "direct");
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("setup reports stale chatgpt model pins before the first run", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "unsupported-config-model");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.model.configuredModel, "gpt-5.4");
  assert.equal(payload.model.supported, false);
  assert.equal(payload.model.fallbackModel, "gpt-5.5");
  assert.match(payload.model.detail, /not in the live catalog/i);
  assert.match(payload.nextSteps.join("\n"), /model = "gpt-5.5"/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task falls back to the live chatgpt default when the configured model pin is stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "unsupported-config-model");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--json", "check stale model fallback"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, "gpt-5.5");

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.lastTurnStart.model, "gpt-5.5");
});

test("task rejects an explicit unavailable model before launch", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--model", "missing-model", "check invalid explicit model"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-model.*not available/i);
});

test("analyze runs read-only with context-pack metadata", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "analyze", "--json", "inspect cache behavior"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "analyze");
  assert.equal(payload.workflow, "Analyze");
  assert.equal(payload.contextPack.id.startsWith("ctx-"), true);
  assert.match(payload.rawOutput, /Handled the requested task/);

  const stateDir = resolveStateDir(repo);
  const routerState = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(routerState.jobs[0].write, false);
  assert.equal(routerState.jobs[0].contextPackId, payload.contextPack.id);
  assert.ok(routerState.jobs[0].policyHash);
});

function assertExecCatalogControlsReachAppServer(tierArgs) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [
    SCRIPT,
    "exec",
    "--json",
    "--best",
    "--effort",
    "xhigh",
    ...tierArgs,
    "fix cache behavior"
  ], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "exec");
  assert.equal(payload.workflow, "Exec");
  assert.equal(payload.model, "gpt-5.5");
  assert.equal(payload.effort, "xhigh");
  assert.equal(payload.serviceTier, "fast");

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.deepEqual(state.appServerArgs, [
    "app-server",
    "-c",
    "service_tier=\"fast\"",
    "-c",
    "model_reasoning_effort=\"xhigh\""
  ]);
  assert.equal(state.lastTurnStart.model, "gpt-5.5");
  assert.equal(state.lastTurnStart.effort, "xhigh");

  const stateDir = resolveStateDir(repo);
  const routerState = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(routerState.jobs[0].model, "gpt-5.5");
  assert.equal(routerState.jobs[0].effort, "xhigh");
  assert.equal(routerState.jobs[0].serviceTier, "fast");
  assert.equal(routerState.jobs[0].write, true);
  assert.ok(routerState.jobs[0].contextPackId);
  assert.ok(routerState.jobs[0].policyHash);
}

test("exec is write-capable and --best --xhigh --fast starts app-server with config overrides", () => {
  assertExecCatalogControlsReachAppServer(["--fast"]);
});

test("exec is write-capable and catalog-driven service tiers reach app-server config", () => {
  assertExecCatalogControlsReachAppServer(["--service-tier", "fast"]);
});

test("task without --write stays read-only; task --write is write-capable", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const readOnly = run("node", [SCRIPT, "task", "--json", "diagnose only"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(readOnly.status, 0, readOnly.stderr);
  const readOnlyState = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(readOnlyState.jobs[0].write, false);

  const writeRepo = makeTempDir();
  const writeBin = makeTempDir();
  installFakeCodex(writeBin);
  initGitRepo(writeRepo);
  const writeCapable = run("node", [SCRIPT, "task", "--write", "--json", "apply the fix"], {
    cwd: writeRepo,
    env: buildEnv(writeBin)
  });
  assert.equal(writeCapable.status, 0, writeCapable.stderr);
  const writeState = JSON.parse(fs.readFileSync(path.join(resolveStateDir(writeRepo), "state.json"), "utf8"));
  assert.equal(writeState.jobs[0].write, true);
});

test("analyze --background enqueues a router job with analyze metadata", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);

  const launched = run("node", [SCRIPT, "analyze", "--background", "--json", "inspect cache behavior"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.match(launchPayload.jobId, /^analyze-/);
  assert.equal(launchPayload.status, "queued");
  assert.equal(launchPayload.title, "Codex Analyze");

  const waitedStatus = run("node", [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.status, "completed");
  assert.equal(waitedPayload.job.kindLabel, "analyze");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.kind, "analyze");
  assert.equal(resultPayload.storedJob.result.mode, "analyze");
  assert.equal(resultPayload.storedJob.result.workflow, "Analyze");
  assert.equal(resultPayload.storedJob.result.contextPack.id.startsWith("ctx-"), true);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<structured_output_contract>/);
});

test("exec --background enqueues a write-capable router job with exec metadata", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);

  const launched = run("node", [SCRIPT, "exec", "--background", "--json", "--best", "--effort", "xhigh", "--fast", "fix cache behavior"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.match(launchPayload.jobId, /^exec-/);
  assert.equal(launchPayload.status, "queued");
  assert.equal(launchPayload.title, "Codex Exec");

  const waitedStatus = run("node", [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.status, "completed");
  assert.equal(waitedPayload.job.kindLabel, "exec");
  assert.equal(waitedPayload.job.write, true);
  assert.equal(waitedPayload.job.model, "gpt-5.5");
  assert.equal(waitedPayload.job.effort, "xhigh");
  assert.equal(waitedPayload.job.serviceTier, "fast");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.kind, "exec");
  assert.equal(resultPayload.storedJob.result.mode, "exec");
  assert.equal(resultPayload.storedJob.result.workflow, "Exec");
  assert.equal(resultPayload.storedJob.result.contextPack.id.startsWith("ctx-"), true);
  assert.equal(resultPayload.storedJob.model, "gpt-5.5");
  assert.equal(resultPayload.storedJob.effort, "xhigh");
  assert.equal(resultPayload.storedJob.serviceTier, "fast");

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<completion_contract>/);
});

test("Codex-native routing modifiers reach the app-server prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "analyze", "--json", "--docs", "--tool", "mcp:playwright", "--parallel", "inspect current docs"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.modifiers, ["docsMcp", "tool:mcp:playwright", "parallel"]);

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.match(state.lastTurnStart.prompt, /<docs_mcp>/);
  assert.match(state.lastTurnStart.prompt, /openaiDeveloperDocs/);
  assert.match(state.lastTurnStart.prompt, /<tool_directive>/);
  assert.match(state.lastTurnStart.prompt, /mcp:playwright/);
  assert.match(state.lastTurnStart.prompt, /<parallel_work>/);
});

test("router commands pass Codex config controls to app-server startup", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run(
    "node",
    [
      SCRIPT,
      "analyze",
      "--json",
      "-c",
      'model_verbosity="high"',
      "--enable",
      "multi_agent",
      "--disable",
      "memories",
      "inspect config passthrough"
    ],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.configArgs, ['model_verbosity="high"', "features.multi_agent=true", "features.memories=false"]);

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(state.appServerArgs, [
    "app-server",
    "-c",
    'model_verbosity="high"',
    "-c",
    "features.multi_agent=true",
    "-c",
    "features.memories=false"
  ]);
});

test("cli subcommand passes raw arguments to the local Codex binary", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "cli", "features list"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /multi_agent stable true/);
  assert.match(result.stdout, /plugins stable true/);
});

test("models reports the live visible Codex catalog and effective default", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "unsupported-config-model");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "models", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.includeHidden, false);
  assert.deepEqual(payload.catalog, {
    source: "codex debug models",
    includeHidden: false,
    total: 4,
    visible: 3,
    hidden: 1
  });
  assert.equal(payload.defaultModel.configuredModel, "gpt-5.4");
  assert.equal(payload.defaultModel.effectiveModel, "gpt-5.5");
  assert.equal(payload.defaultModel.source, "fallback");
  assert.deepEqual(
    payload.models.map((model) => model.slug),
    ["gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex-spark"]
  );
  assert.deepEqual(payload.models[0].efforts, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(payload.models[0].reasoningLevels[0], {
    effort: "low",
    description: "Fast responses with lighter reasoning"
  });
  assert.deepEqual(payload.models[0].serviceTiers, ["fast"]);
  assert.equal(payload.models[0].supportsFastTier, true);
  assert.deepEqual(payload.models[2].aliases, ["spark"]);
  assert.match(payload.nextSteps.join("\n"), /remove the model pin/i);
});

test("models --all includes hidden catalog entries", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "models", "--all", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.includeHidden, true);
  assert.equal(payload.models[0].slug, "hidden-model");
  assert.equal(payload.models[0].visibility, "hidden");
});
