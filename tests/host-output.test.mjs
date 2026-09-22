import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanCodexStderr,
  hostFailureText,
  hostStderrLine,
  isHostSuppressedProgressLine
} from "../plugins/codex-router/scripts/lib/host-output.mjs";

test("startup stderr keeps a blocking Codex auth failure and drops MCP connection noise", () => {
  const stderr = [
    "MCP server cloudflare-docs failed to connect: not connected",
    "WARNING: proceeding, even though we could not update PATH: /usr/bin",
    "mcp startup: linear did not connect",
    "this mcp didn't connect",
    "Server linear is not connected",
    "MCP server notion failed: reauthenticationRequired",
    "authentication expired; run codex login"
  ].join("\n");

  assert.equal(cleanCodexStderr(stderr), "authentication expired; run codex login");
});

test("host failure text drops launch details and non-blocking startup errors", () => {
  assert.equal(hostFailureText("Starting Codex task thread."), "");
  assert.equal(hostFailureText("Thread ready (thr_1)."), "");
  assert.equal(hostFailureText("Turn started (turn_1)."), "");
  assert.equal(hostFailureText("MCP server cloudflare-docs did not connect"), "");
  assert.equal(hostFailureText("WARNING: proceeding, even though we could not update PATH: /usr/bin"), "");
  assert.equal(hostFailureText("model_instructions_file is deprecated"), "model_instructions_file is deprecated");
  assert.equal(hostFailureText("The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."), "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.");
  assert.equal(hostFailureText("Codex error: authentication expired; run codex login"), "Codex error: authentication expired; run codex login");
});

test("status progress hides launch details and MCP startup failures", () => {
  assert.equal(isHostSuppressedProgressLine("Starting Codex Review."), true);
  assert.equal(isHostSuppressedProgressLine("Thread ready (thr_1)."), true);
  assert.equal(isHostSuppressedProgressLine("Turn started (turn_1)."), true);
  assert.equal(isHostSuppressedProgressLine("MCP server cloudflare-docs did not connect"), true);
  assert.equal(isHostSuppressedProgressLine("Server linear is not connected"), true);
  assert.equal(isHostSuppressedProgressLine("Reviewer started: current changes"), false);
  assert.equal(isHostSuppressedProgressLine("Codex error: authentication expired; run codex login"), false);
});

test("the only ready startup line sent to the caller is Codex is ready", () => {
  assert.equal(hostStderrLine({ hostMessage: "Codex is ready." }), "Codex is ready.");
  assert.equal(hostStderrLine({ hostMessage: "Thread ready (thr_1)." }), "");
  assert.equal(hostStderrLine({ hostMessage: "MCP server cloudflare-docs did not connect" }), "");
  assert.equal(hostStderrLine({ hostMessage: "Codex error: authentication expired; run codex login" }), "Codex error: authentication expired; run codex login");
  assert.equal(hostStderrLine({ message: "Turn started (turn_1)." }), "");
});
