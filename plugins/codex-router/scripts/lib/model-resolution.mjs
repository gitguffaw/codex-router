import { spawnSync } from "node:child_process";

export function parseModelCatalog(raw) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const models = Array.isArray(parsed?.models) ? parsed.models : [];
  return models.filter((model) => model && typeof model.slug === "string");
}

export function readModelCatalog(cwd, options = {}) {
  const runner = options.runner ?? spawnSync;
  const result = runner("codex", ["debug", "models"], {
    cwd,
    env: options.env,
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail ? `Unable to read Codex model catalog: ${detail}` : "Unable to read Codex model catalog.");
  }

  return parseModelCatalog(result.stdout);
}

function supportsEffort(model, effort) {
  if (!effort) {
    return true;
  }
  return (model.supported_reasoning_levels ?? []).some(
    (entry) => typeof entry?.effort === "string" && entry.effort.trim().toLowerCase() === effort
  );
}

export function listModelServiceTiers(model) {
  return [
    ...new Set(
      (model?.additional_speed_tiers ?? [])
        .filter((tier) => typeof tier === "string" && tier.trim())
        .map((tier) => tier.trim().toLowerCase())
    )
  ];
}

function supportsServiceTier(model, serviceTier) {
  return !serviceTier || listModelServiceTiers(model).includes(serviceTier);
}

function isVisible(model) {
  return model.visibility === "list";
}

function priority(model) {
  return Number.isFinite(model.priority) ? model.priority : Number.MAX_SAFE_INTEGER;
}

function byPriority(left, right) {
  return priority(left) - priority(right) || left.slug.localeCompare(right.slug);
}

export function catalogModelAliases(model) {
  const slug = typeof model?.slug === "string" ? model.slug.trim().toLowerCase() : "";
  const suffix = slug.split("-").at(-1) ?? "";
  const explicitAliases = Array.isArray(model?.aliases) ? model.aliases : [];
  return [
    ...new Set(
      [...explicitAliases, suffix]
        .filter((alias) => typeof alias === "string")
        .map((alias) => alias.trim().toLowerCase())
        .filter((alias) => /^[a-z][a-z0-9._-]*$/.test(alias))
    )
  ];
}

function visibleAliasMatches(catalog, alias) {
  return catalog
    .filter(isVisible)
    .filter((model) => catalogModelAliases(model).includes(alias))
    .sort(byPriority);
}

function exactCatalogSlugs(catalog) {
  return new Set(catalog.map((model) => String(model?.slug ?? "").trim().toLowerCase()).filter(Boolean));
}

export function buildCatalogAliasMap(catalog) {
  const aliases = new Map();
  const exactSlugs = exactCatalogSlugs(catalog);
  for (const model of catalog.filter(isVisible).sort(byPriority)) {
    for (const alias of catalogModelAliases(model)) {
      const matches = visibleAliasMatches(catalog, alias);
      // Expose a short alias only when it identifies exactly one visible model
      // and does not collide with a different exact slug, including hidden slugs.
      if (matches.length !== 1 || (exactSlugs.has(alias) && model.slug.toLowerCase() !== alias)) {
        continue;
      }
      aliases.set(model.slug, [...(aliases.get(model.slug) ?? []), alias]);
    }
  }
  return aliases;
}

function findModel(catalog, selector) {
  const normalized = String(selector ?? "").trim().toLowerCase();
  const exact = catalog.find((model) => model.slug.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }

  const matches = visibleAliasMatches(catalog, normalized);
  if (matches.length > 1) {
    const slugs = matches.map((model) => model.slug).join(", ");
    throw new Error(
      `Requested Codex model selector "${String(selector).trim()}" is ambiguous; it matches visible models ${slugs}. Use an exact slug.`
    );
  }
  return matches[0] ?? null;
}

function chooseBest(catalog, { effort = null, serviceTier = null } = {}) {
  const candidates = catalog
    .filter(isVisible)
    .filter((model) => supportsEffort(model, effort))
    .filter((model) => supportsServiceTier(model, serviceTier))
    .sort(byPriority);
  return candidates[0] ?? null;
}

export function normalizeModelControl(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

export function normalizeEffortControl(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalized;
}

export function normalizeServiceTierControl(serviceTier) {
  if (serviceTier == null) {
    return null;
  }
  const normalized = String(serviceTier).trim().toLowerCase();
  return normalized || null;
}

export function resolveModelControls(input = {}, options = {}) {
  const model = normalizeModelControl(input.model);
  const effort = normalizeEffortControl(input.effort);
  const explicitServiceTier = normalizeServiceTierControl(input.serviceTier);
  if (input.fast && explicitServiceTier && explicitServiceTier !== "fast") {
    throw new Error(`--fast cannot be combined with service tier "${explicitServiceTier}".`);
  }
  const serviceTier = input.fast ? "fast" : explicitServiceTier;

  const needsCatalog = Boolean(model || input.spark || input.best || serviceTier);
  const catalog = options.catalog ?? (needsCatalog ? readModelCatalog(options.cwd ?? process.cwd(), options) : []);
  let selected = null;

  if (model) {
    selected = findModel(catalog, model);
    if (!selected) {
      throw new Error(`Requested Codex model or dynamic alias "${model}" is not available in \`codex debug models\`.`);
    }
  } else if (input.spark) {
    selected = findModel(catalog, "spark");
    if (!selected) {
      throw new Error("Spark alias requested, but no visible model in `codex debug models` currently exposes that alias.");
    }
  } else if (input.best || serviceTier) {
    selected = chooseBest(catalog, { effort, serviceTier });
    if (!selected) {
      const qualifier = serviceTier ? ` with service tier "${serviceTier}"` : "";
      throw new Error(`No visible Codex model${qualifier} supports the requested controls.`);
    }
  }

  // Inherited-model runs have no selected catalog entry and forward any nonempty
  // effort for Codex to validate against the effective configured model.
  if (selected && effort && !supportsEffort(selected, effort)) {
    throw new Error(`Model ${selected.slug} does not support reasoning effort "${effort}".`);
  }

  if (selected && serviceTier && !supportsServiceTier(selected, serviceTier)) {
    throw new Error(`Model ${selected.slug} does not support service_tier="${serviceTier}".`);
  }

  return {
    model: selected?.slug ?? null,
    effort,
    serviceTier,
    configOverrides: {
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      ...(effort ? { model_reasoning_effort: effort } : {})
    },
    resolvedFrom: selected ? "catalog" : "codex-config",
    selectedModel: selected
  };
}
