import test from "node:test";
import assert from "node:assert/strict";

import { buildRouterRequest } from "../plugins/codex-router/scripts/lib/router.mjs";

test("analyze is read-only app-server turn", () => {
  const route = buildRouterRequest({ mode: "analyze", prompt: "inspect the cache path", options: {} });
  assert.equal(route.launchSurface, "appServerTurn");
  assert.equal(route.sandbox, "read-only");
  assert.equal(route.write, false);
  assert.equal(route.workflow, "Analyze");
});

test("exec is the only write-capable router mode in V1", () => {
  const route = buildRouterRequest({ mode: "exec", prompt: "fix the cache bug", options: {} });
  assert.equal(route.sandbox, "workspace-write");
  assert.equal(route.write, true);
  assert.equal(route.workflow, "Exec");
});

test("search modifies prompt without changing launch surface", () => {
  const route = buildRouterRequest({ mode: "analyze", prompt: "compare current docs", options: { search: true } });
  assert.deepEqual(route.modifiers, ["webSearch"]);
  assert.equal(route.launchSurface, "appServerTurn");
  assert.match(route.prompt, /<web_search>/);
});

test("exec search keeps write mode while constraining web use in the prompt", () => {
  const route = buildRouterRequest({ mode: "exec", prompt: "fix the docs integration", options: { search: true } });
  assert.equal(route.sandbox, "workspace-write");
  assert.equal(route.write, true);
  assert.deepEqual(route.modifiers, ["webSearch"]);
  assert.match(route.prompt, /Use Codex web search only where current external facts materially affect the implementation/);
});

test("router rejects empty prompts and unsupported modes", () => {
  assert.throws(() => buildRouterRequest({ mode: "analyze", prompt: "   ", options: {} }), /Provide a prompt/);
  assert.throws(() => buildRouterRequest({ mode: "parallel", prompt: "x", options: {} }), /Unsupported router mode/);
});

test("docs, tool, and parallel guardrails fail explicitly", () => {
  assert.throws(
    () => buildRouterRequest({ mode: "analyze", prompt: "x", options: { docs: true } }),
    /DocsMCP.*not enabled yet/
  );
  assert.throws(
    () => buildRouterRequest({ mode: "analyze", prompt: "x", options: { tool: "mcp:playwright" } }),
    /ToolDirective.*not enabled yet/
  );
  assert.throws(
    () => buildRouterRequest({ mode: "exec", prompt: "x", options: { parallel: true } }),
    /Parallel.*not enabled yet/
  );
});
