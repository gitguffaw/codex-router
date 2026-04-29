---
date: 2026-04-29
topic: codex-router-plugin-fork
---

# Codex Router Plugin Fork

## What We're Building

Build a Claude Code plugin fork based on OpenAI's `codex-plugin-cc`, then extend it so our Codex skill's router becomes reliable, command-driven, resumable, and testable.

The goal is not to replace `Codex/SKILL.md`. The skill remains the canonical human-readable policy for mode selection, modifier behavior, model/reasoning/tier choices, Codex-native tool boundaries, and parallel role orchestration. The plugin turns that policy into executable command behavior.

## Why This Approach

We considered two paths:

- **Fork first:** Start from OpenAI's working plugin and adapt its runtime, commands, state handling, and app-server integration.
- **Sibling plugin:** Build a clean plugin from scratch next to OpenAI's implementation, borrowing patterns but owning every design choice.

The chosen path is **fork first** because reliability is the immediate gap. OpenAI already has a working execution layer: `codex app-server`, background jobs, status/result/cancel commands, persisted thread IDs, setup checks, and optional review hooks. We should learn from and reuse that machinery before deciding whether a clean sibling plugin is justified.

## Key Decisions

- **Preserve the skill as policy:** `Codex/SKILL.md`, `Codex/Workflows/*.md`, and `Codex/references/*.md` remain the source of truth for operator judgment.
- **Use OpenAI's runtime as the base:** Start by forking or copying `codex-plugin-cc` rather than recreating app-server integration from scratch.
- **Add a router layer:** Implement our modes and modifiers as machine-enforced command behavior: `Analyze`, `Exec`, `Review`, `Parallel`, `WebSearch`, `DocsMCP`, `ToolDirective`, `SpeedTier`, dynamic model resolution, and role/lane orchestration.
- **Make reliability mode-wide:** Background execution, progress, status, result, resume, cancel, setup, output rendering, and safety rules must work for every relevant mode, not just rescue/review.
- **Keep fork-vs-sibling reversible:** If the fork becomes too contorted, extract the proven pieces into a sibling plugin once the router shape is validated.

## Open Questions

- Should the first fork live inside this repo or as a separate repo/plugin package?
- Should the command surface prioritize explicit slash commands first, natural-language delegation later, or both from the start?
- How much of OpenAI's `codex-companion.mjs` should be preserved unchanged before introducing our router?
- Should dynamic model resolution call `codex debug models` directly, use app-server config APIs, or support both?
- Should review gates remain optional only, or should an after-`Exec` review hint/gate become part of the normal workflow?

## Next Steps

-> `/ce:plan` for implementation details.
