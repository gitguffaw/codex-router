---
description: Show the live Codex model catalog for this machine, including effort support and the effective default
argument-hint: '[--all] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" models "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- the effective default model and how it was chosen
- the recommended model from the live catalog
- each model's supported effort levels
- the live catalog's descriptions of those effort levels when provided
- whether `--all` revealed hidden catalog entries
- every additional service tier advertised by each model, including `fast` when present
- aliases derived from the current visible catalog, such as `spark`
- any warnings about stale or unsupported default model pins
