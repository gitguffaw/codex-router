import test from "node:test";
import assert from "node:assert/strict";

import { parseModelCatalog, resolveModelControls } from "../plugins/codex-router/scripts/lib/model-resolution.mjs";

const catalog = parseModelCatalog({
  models: [
    {
      slug: "hidden-best",
      visibility: "hidden",
      priority: -1,
      supported_reasoning_levels: [{ effort: "xhigh" }],
      additional_speed_tiers: ["fast"]
    },
    {
      slug: "gpt-5.5",
      visibility: "list",
      priority: 0,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
      additional_speed_tiers: ["fast"]
    },
    {
      slug: "gpt-5.3-codex-spark",
      visibility: "list",
      priority: 10,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
      additional_speed_tiers: []
    }
  ]
});

test("--best --xhigh --fast resolves the strongest visible fast-capable model", () => {
  const result = resolveModelControls({ best: true, fast: true, effort: "xhigh" }, { catalog });
  assert.equal(result.model, "gpt-5.5");
  assert.equal(result.effort, "xhigh");
  assert.equal(result.serviceTier, "fast");
  assert.deepEqual(result.configOverrides, {
    service_tier: "fast",
    model_reasoning_effort: "xhigh"
  });
});

test("explicit unavailable model fails clearly", () => {
  assert.throws(
    () => resolveModelControls({ model: "missing-model" }, { catalog }),
    /missing-model.*not available/
  );
});

test("spark maps only when the spark model is available", () => {
  const result = resolveModelControls({ spark: true }, { catalog });
  assert.equal(result.model, "gpt-5.3-codex-spark");
});

test("hidden models are ignored for --best unless explicitly requested", () => {
  const result = resolveModelControls({ best: true }, { catalog });
  assert.equal(result.model, "gpt-5.5");

  const explicit = resolveModelControls({ model: "hidden-best" }, { catalog });
  assert.equal(explicit.model, "hidden-best");
});

test("no model flags inherit Codex config while preserving effort config override", () => {
  const result = resolveModelControls({ effort: "high" }, { catalog });
  assert.equal(result.model, null);
  assert.equal(result.resolvedFrom, "codex-config");
  assert.deepEqual(result.configOverrides, {
    model_reasoning_effort: "high"
  });
});

test("model and effort controls are normalized at the resolver boundary", () => {
  const result = resolveModelControls({ model: " spark ", effort: " LOW " }, { catalog });
  assert.equal(result.model, "gpt-5.3-codex-spark");
  assert.equal(result.effort, "low");
  assert.deepEqual(result.configOverrides, {
    model_reasoning_effort: "low"
  });
});

test("empty model and effort controls inherit Codex config without catalog lookup", () => {
  const result = resolveModelControls({ model: " ", effort: " " }, { catalog: [] });
  assert.equal(result.model, null);
  assert.equal(result.effort, null);
  assert.equal(result.resolvedFrom, "codex-config");
  assert.deepEqual(result.configOverrides, {});
});
