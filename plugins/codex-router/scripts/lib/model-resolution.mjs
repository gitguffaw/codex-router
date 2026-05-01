import { spawnSync } from "node:child_process";

const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const SPARK_MODEL = "gpt-5.3-codex-spark";

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
  if (!effort || effort === "none") {
    return true;
  }
  return (model.supported_reasoning_levels ?? []).some((entry) => entry?.effort === effort);
}

function supportsFastTier(model) {
  return (model.additional_speed_tiers ?? []).includes("fast");
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

function findModel(catalog, slug) {
  return catalog.find((model) => model.slug === slug) ?? null;
}

function chooseBest(catalog, { effort = null, fast = false } = {}) {
  const candidates = catalog
    .filter(isVisible)
    .filter((model) => supportsEffort(model, effort))
    .filter((model) => !fast || supportsFastTier(model))
    .sort(byPriority);
  return candidates[0] ?? null;
}

function validateEffort(effort, original = effort) {
  if (effort && !VALID_EFFORTS.has(effort)) {
    throw new Error(`Unsupported reasoning effort "${original}". Use one of: none, minimal, low, medium, high, xhigh.`);
  }
}

export function normalizeModelControl(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return normalized.toLowerCase() === "spark" ? SPARK_MODEL : normalized;
}

export function normalizeEffortControl(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  validateEffort(normalized, effort);
  return normalized;
}

export function resolveModelControls(input = {}, options = {}) {
  const model = normalizeModelControl(input.model);
  const effort = normalizeEffortControl(input.effort);

  const needsCatalog = Boolean(model || input.spark || input.best || input.fast);
  const catalog = options.catalog ?? (needsCatalog ? readModelCatalog(options.cwd ?? process.cwd(), options) : []);
  let selected = null;

  if (model) {
    selected = findModel(catalog, model);
    if (!selected) {
      throw new Error(`Requested Codex model "${model}" is not available in \`codex debug models\`.`);
    }
  } else if (input.spark) {
    selected = findModel(catalog, SPARK_MODEL);
    if (!selected) {
      throw new Error(`Spark alias requested, but ${SPARK_MODEL} is not available in \`codex debug models\`.`);
    }
  } else if (input.best || input.fast) {
    selected = chooseBest(catalog, { effort, fast: Boolean(input.fast) });
    if (!selected) {
      const qualifier = input.fast ? " fast-capable" : "";
      throw new Error(`No visible${qualifier} Codex model supports the requested controls.`);
    }
  }

  if (selected && effort && !supportsEffort(selected, effort)) {
    throw new Error(`Model ${selected.slug} does not support reasoning effort "${effort}".`);
  }

  if (selected && input.fast && !supportsFastTier(selected)) {
    throw new Error(`Model ${selected.slug} does not support service_tier="fast".`);
  }

  return {
    model: selected?.slug ?? null,
    effort,
    serviceTier: input.fast ? "fast" : null,
    configOverrides: {
      ...(input.fast ? { service_tier: "fast" } : {}),
      ...(effort ? { model_reasoning_effort: effort } : {})
    },
    resolvedFrom: selected ? "catalog" : "codex-config",
    selectedModel: selected
  };
}
