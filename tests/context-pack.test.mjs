import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { createContextPack } from "../plugins/codex-router/scripts/lib/context-pack.mjs";
import { makeTempDir } from "./helpers.mjs";

test("context pack records policy hash, workflow, request, modifiers, and non-goals", () => {
  const workspace = makeTempDir();
  const pack = createContextPack(workspace, {
    mode: "analyze",
    workflow: "Analyze",
    userRequest: "inspect cache behavior",
    prompt: "routed prompt",
    modifiers: ["webSearch"],
    decision: { sandbox: "read-only" },
    nonGoals: ["Do not edit files."]
  });

  assert.match(pack.id, /^ctx-/);
  assert.ok(pack.policyHash);
  const stored = JSON.parse(fs.readFileSync(pack.file, "utf8"));
  assert.equal(stored.workflow, "Analyze");
  assert.equal(stored.userRequest, "inspect cache behavior");
  assert.deepEqual(stored.modifiers, ["webSearch"]);
  assert.deepEqual(stored.nonGoals, ["Do not edit files."]);
  assert.ok(stored.policyFiles.some((file) => file.path === "SKILL.md"));
});

test("context pack ids change with request data while policy hash remains stable", () => {
  const workspace = makeTempDir();
  const first = createContextPack(workspace, {
    mode: "analyze",
    workflow: "Analyze",
    userRequest: "inspect cache behavior",
    prompt: "first routed prompt",
    modifiers: ["webSearch"]
  });
  const second = createContextPack(workspace, {
    mode: "analyze",
    workflow: "Analyze",
    userRequest: "inspect cache behavior differently",
    prompt: "second routed prompt",
    modifiers: ["webSearch"]
  });

  assert.notEqual(first.id, second.id);
  assert.equal(first.policyHash, second.policyHash);
  assert.ok(fs.existsSync(first.file));
  assert.ok(fs.existsSync(second.file));
});
