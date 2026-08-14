import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCatalogAliasMap,
  parseModelCatalog,
  resolveModelControls
} from "../plugins/codex-router/scripts/lib/model-resolution.mjs";

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
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" }
      ],
      additional_speed_tiers: ["fast"]
    },
    {
      slug: "gpt-6-codex-spark",
      visibility: "list",
      priority: 10,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
      additional_speed_tiers: []
    }
  ]
});

test("--best --xhigh --fast resolves the highest-priority visible fast-capable model", () => {
  const result = resolveModelControls({ best: true, fast: true, effort: "xhigh" }, { catalog });
  assert.equal(result.model, "gpt-5.5");
  assert.equal(result.effort, "xhigh");
  assert.equal(result.serviceTier, "fast");
  assert.deepEqual(result.configOverrides, {
    service_tier: "fast",
    model_reasoning_effort: "xhigh"
  });
});

test("new effort levels and service tiers work directly from future catalog data", () => {
  const futureCatalog = parseModelCatalog({
    models: [
      {
        slug: "gpt-7-nova",
        aliases: ["frontier"],
        visibility: "list",
        priority: 0,
        supported_reasoning_levels: [{ effort: "future-depth" }],
        additional_speed_tiers: ["turbo"]
      }
    ]
  });
  const result = resolveModelControls(
    { best: true, effort: "future-depth", serviceTier: "turbo" },
    { catalog: futureCatalog }
  );
  assert.equal(result.model, "gpt-7-nova");
  assert.equal(result.effort, "future-depth");
  assert.equal(result.serviceTier, "turbo");
  assert.deepEqual(result.configOverrides, {
    service_tier: "turbo",
    model_reasoning_effort: "future-depth"
  });
  assert.equal(resolveModelControls({ model: "frontier" }, { catalog: futureCatalog }).model, "gpt-7-nova");
});

test("explicit unavailable model fails clearly", () => {
  assert.throws(
    () => resolveModelControls({ model: "missing-model" }, { catalog }),
    /missing-model.*not available/
  );
});

test("explicit models reject effort and service-tier values absent from their live entry", () => {
  assert.throws(
    () => resolveModelControls({ model: "spark", effort: "ultra" }, { catalog }),
    /does not support reasoning effort "ultra"/
  );
  assert.throws(
    () => resolveModelControls({ model: "spark", serviceTier: "fast" }, { catalog }),
    /does not support service_tier="fast"/
  );
});

test("spark maps only when the spark model is available", () => {
  const result = resolveModelControls({ spark: true }, { catalog });
  assert.equal(result.model, "gpt-6-codex-spark");
});

test("hidden models are ignored for --best unless explicitly requested", () => {
  const result = resolveModelControls({ best: true }, { catalog });
  assert.equal(result.model, "gpt-5.5");

  const explicit = resolveModelControls({ model: "hidden-best" }, { catalog });
  assert.equal(explicit.model, "hidden-best");
});

test("no model flags inherit Codex config while preserving effort config override", () => {
  const result = resolveModelControls({ effort: "future-depth" }, { catalog });
  assert.equal(result.model, null);
  assert.equal(result.resolvedFrom, "codex-config");
  assert.deepEqual(result.configOverrides, {
    model_reasoning_effort: "future-depth"
  });
});

test("model and effort controls are normalized at the resolver boundary", () => {
  const result = resolveModelControls({ model: " spark ", effort: " LOW " }, { catalog });
  assert.equal(result.model, "gpt-6-codex-spark");
  assert.equal(result.effort, "low");
  assert.deepEqual(result.configOverrides, {
    model_reasoning_effort: "low"
  });
});

test("--fast is a compatibility alias for the live fast service tier", () => {
  const result = resolveModelControls({ best: true, fast: true }, { catalog });
  assert.equal(result.serviceTier, "fast");
  assert.deepEqual(result.configOverrides, { service_tier: "fast" });
  assert.throws(
    () => resolveModelControls({ fast: true, serviceTier: "turbo" }, { catalog }),
    /--fast cannot be combined with service tier "turbo"/
  );
});

test("--fast plus serviceTier fast is allowed", () => {
  const result = resolveModelControls({ best: true, fast: true, serviceTier: "fast" }, { catalog });
  assert.equal(result.model, "gpt-5.5");
  assert.equal(result.serviceTier, "fast");
  assert.deepEqual(result.configOverrides, { service_tier: "fast" });
});

test("empty model and effort controls inherit Codex config without catalog lookup", () => {
  const result = resolveModelControls({ model: " ", effort: " " }, { catalog: [] });
  assert.equal(result.model, null);
  assert.equal(result.effort, null);
  assert.equal(result.resolvedFrom, "codex-config");
  assert.deepEqual(result.configOverrides, {});
});

function listedModel(slug, extras = {}) {
  return {
    slug,
    visibility: "list",
    priority: 10,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
    additional_speed_tiers: [],
    ...extras
  };
}

function aliasesFor(catalog, slug) {
  return buildCatalogAliasMap(catalog).get(slug) ?? [];
}

function assertAliasMapAgreesWithResolver(catalog) {
  for (const [slug, aliases] of buildCatalogAliasMap(catalog)) {
    for (const alias of aliases) {
      assert.equal(resolveModelControls({ model: alias }, { catalog }).model, slug);
    }
  }
}

test("duplicate suffix aliases are not exposed and reject explicit selectors", () => {
  const catalog = parseModelCatalog({
    models: [
      listedModel("gpt-6-codex-spark", { priority: 10 }),
      listedModel("gpt-7-codex-spark", { priority: 20, aliases: ["nova"] })
    ]
  });

  assert.deepEqual(aliasesFor(catalog, "gpt-6-codex-spark"), []);
  assert.deepEqual(aliasesFor(catalog, "gpt-7-codex-spark"), ["nova"]);
  assert.throws(
    () => resolveModelControls({ model: "spark" }, { catalog }),
    /ambiguous.*gpt-6-codex-spark.*gpt-7-codex-spark/
  );
  assert.throws(
    () => resolveModelControls({ spark: true }, { catalog }),
    /ambiguous.*spark/
  );
  assert.equal(resolveModelControls({ model: "gpt-6-codex-spark" }, { catalog }).model, "gpt-6-codex-spark");
  assert.equal(resolveModelControls({ model: "nova" }, { catalog }).model, "gpt-7-codex-spark");
  assertAliasMapAgreesWithResolver(catalog);
});

test("duplicate explicit aliases are not exposed and reject explicit selectors", () => {
  const catalog = parseModelCatalog({
    models: [
      listedModel("gpt-6-alpha", { priority: 8, aliases: ["frontier"] }),
      listedModel("gpt-7-beta", { priority: 12, aliases: ["frontier"] })
    ]
  });

  assert.deepEqual(aliasesFor(catalog, "gpt-6-alpha"), ["alpha"]);
  assert.deepEqual(aliasesFor(catalog, "gpt-7-beta"), ["beta"]);
  assert.throws(
    () => resolveModelControls({ model: "frontier" }, { catalog }),
    /ambiguous.*gpt-6-alpha.*gpt-7-beta/
  );
  assert.equal(resolveModelControls({ model: "alpha" }, { catalog }).model, "gpt-6-alpha");
  assert.equal(resolveModelControls({ model: "beta" }, { catalog }).model, "gpt-7-beta");
  assertAliasMapAgreesWithResolver(catalog);
});

test("exact slugs win over aliases, including hidden exact slugs", () => {
  const catalog = parseModelCatalog({
    models: [
      listedModel("spark", { visibility: "hidden", priority: -1 }),
      listedModel("gpt-6-codex-spark", { priority: 10, aliases: ["hidden-best"] }),
      listedModel("hidden-best", { visibility: "hidden", priority: -2 })
    ]
  });

  assert.deepEqual(aliasesFor(catalog, "gpt-6-codex-spark"), []);
  assert.equal(resolveModelControls({ model: "spark" }, { catalog }).model, "spark");
  assert.equal(resolveModelControls({ spark: true }, { catalog }).model, "spark");
  assert.equal(resolveModelControls({ model: "hidden-best" }, { catalog }).model, "hidden-best");
  assert.equal(
    resolveModelControls({ model: "gpt-6-codex-spark" }, { catalog }).model,
    "gpt-6-codex-spark"
  );
  assertAliasMapAgreesWithResolver(catalog);
});

test("unambiguous version-shifted spark still resolves dynamically", () => {
  const catalog = parseModelCatalog({
    models: [listedModel("gpt-7-codex-spark", { priority: 15 })]
  });

  assert.deepEqual(aliasesFor(catalog, "gpt-7-codex-spark"), ["spark"]);
  assert.equal(resolveModelControls({ model: "spark" }, { catalog }).model, "gpt-7-codex-spark");
  assert.equal(resolveModelControls({ spark: true }, { catalog }).model, "gpt-7-codex-spark");
  assertAliasMapAgreesWithResolver(catalog);
});

test("--best skips higher-priority models that lack the requested effort or tier", () => {
  const catalog = parseModelCatalog({
    models: [
      listedModel("gpt-priority-incompatible", {
        priority: 0,
        supported_reasoning_levels: [{ effort: "low" }],
        additional_speed_tiers: []
      }),
      listedModel("gpt-compatible", {
        priority: 20,
        supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }],
        additional_speed_tiers: ["fast"]
      })
    ]
  });

  assert.equal(resolveModelControls({ best: true, effort: "xhigh" }, { catalog }).model, "gpt-compatible");
  assert.equal(resolveModelControls({ best: true, serviceTier: "fast" }, { catalog }).model, "gpt-compatible");
  const both = resolveModelControls({ best: true, effort: "xhigh", fast: true }, { catalog });
  assert.equal(both.model, "gpt-compatible");
  assert.equal(both.serviceTier, "fast");
});

test("--fast errors when no compatible visible or explicit model exists", () => {
  const catalog = parseModelCatalog({
    models: [
      listedModel("gpt-slow", { priority: 0, additional_speed_tiers: [] }),
      listedModel("hidden-fast", {
        visibility: "hidden",
        priority: -1,
        additional_speed_tiers: ["fast"]
      })
    ]
  });

  assert.throws(
    () => resolveModelControls({ fast: true }, { catalog }),
    /No visible Codex model with service tier "fast" supports the requested controls/
  );
  assert.throws(
    () => resolveModelControls({ model: "gpt-slow", fast: true }, { catalog }),
    /does not support service_tier="fast"/
  );
});

test("explicit-alias and derived-suffix mixed collisions are rejected", () => {
  const catalog = parseModelCatalog({
    models: [
      listedModel("gpt-6-codex-spark", { priority: 10 }),
      listedModel("gpt-7-alpha", { priority: 20, aliases: ["spark"] })
    ]
  });

  assert.deepEqual(aliasesFor(catalog, "gpt-6-codex-spark"), []);
  assert.deepEqual(aliasesFor(catalog, "gpt-7-alpha"), ["alpha"]);
  assert.throws(
    () => resolveModelControls({ model: "spark" }, { catalog }),
    /ambiguous.*gpt-6-codex-spark.*gpt-7-alpha/
  );
  assert.throws(
    () => resolveModelControls({ spark: true }, { catalog }),
    /ambiguous.*spark/
  );
  assert.equal(resolveModelControls({ model: "alpha" }, { catalog }).model, "gpt-7-alpha");
  assert.equal(resolveModelControls({ model: "gpt-6-codex-spark" }, { catalog }).model, "gpt-6-codex-spark");
  assertAliasMapAgreesWithResolver(catalog);
});

test("selected models accept only advertised efforts, including none", () => {
  assert.throws(
    () => resolveModelControls({ model: "gpt-5.5", effort: "none" }, { catalog }),
    /does not support reasoning effort "none"/
  );
  assert.throws(
    () => resolveModelControls({ best: true, effort: "none" }, { catalog }),
    /No visible Codex model supports the requested controls/
  );

  const inherited = resolveModelControls({ effort: "none" }, { catalog });
  assert.equal(inherited.model, null);
  assert.equal(inherited.resolvedFrom, "codex-config");
  assert.equal(inherited.effort, "none");
  assert.deepEqual(inherited.configOverrides, {
    model_reasoning_effort: "none"
  });

  const advertised = parseModelCatalog({
    models: [listedModel("gpt-none", { supported_reasoning_levels: [{ effort: "none" }] })]
  });
  const accepted = resolveModelControls({ model: "gpt-none", effort: "none" }, { catalog: advertised });
  assert.equal(accepted.model, "gpt-none");
  assert.equal(accepted.effort, "none");
  assert.deepEqual(accepted.configOverrides, {
    model_reasoning_effort: "none"
  });
});
