---
title: Codex Router Plugin Fork
type: feat
status: active
date: 2026-04-29
origin: docs/brainstorms/2026-04-29-codex-router-plugin-fork-brainstorm.md
---

# Codex Router Plugin Fork

## Overview

Build a private fork of OpenAI `codex-plugin-cc` as `codex-router`, preserving the local Codex skill docs as canonical policy and turning that policy into tested runtime behavior.

V1 is reliable core plus hard routing guardrails: implement `Analyze`, `Exec`, `Review`, model/effort/tier resolution, context preservation, setup/status/result/cancel/resume, and app-server hardening. `WebSearch` is supported for app-server turns. `DocsMCP`, `ToolDirective`, and `Parallel` are parsed and must either route safely or fail with explicit diagnostics.

## Proposed Solution

Fork OpenAI `codex-plugin-cc` at `807e03ac9d5aa23bc395fdec8c3767500a86b3cf` into a separate private repo named `codex-router`. Rename the plugin namespace from `codex` to `codex-router` to avoid conflicts with the upstream plugin.

Vendor `Codex/SKILL.md`, `Codex/Workflows/*.md`, and `Codex/references/*.md` into the plugin repo as canonical policy docs. Add a runtime router and context-pack layer that records which policy was selected for every job.

## Technical Approach

- Preserve OpenAI's app-server runtime, job tracking, setup, status/result/cancel, resume, and optional hook structure.
- Add router commands for `/codex-router:analyze`, `/codex-router:exec`, and `/codex-router:review`.
- Add deterministic model controls: `--model`, `--effort`, `--best`, `--fast`, and `--spark`.
- Resolve dynamic model choices from `codex debug models`.
- Apply `service_tier="fast"` through app-server startup config for fast-tier jobs.
- Add context packs containing policy excerpt, selected workflow, user request, mode/modifier decision, non-goals, relevant constraints, and policy hash.
- Keep review gates optional. After write-capable exec, render a review hint instead of blocking by default.

## Acceptance Criteria

- [ ] Plugin namespace is `codex-router`.
- [ ] `Analyze` is read-only and uses app-server `turn/start`.
- [ ] `Exec` is write-capable only through `/codex-router:exec`.
- [ ] `Review` remains strictly read-only and uses app-server `review/start` where possible.
- [ ] `--search` works for app-server turn modes without routing through unsupported `codex exec --search`.
- [ ] `--docs`, `--tool`, and `--parallel` fail clearly in V1 unless safe routing is implemented.
- [ ] Every job records structured state, model, effort, service tier, context-pack ID, and policy hash.
- [ ] Result states are structured: queued, running, completed, completed-with-warnings, blocked, failed, interrupted, and cancelled.
- [ ] Tests cover router behavior, model resolution, context packs, safety rules, and operational failure modes.

## Sources & References

- Origin brainstorm: [docs/brainstorms/2026-04-29-codex-router-plugin-fork-brainstorm.md](../brainstorms/2026-04-29-codex-router-plugin-fork-brainstorm.md)
- Local policy: [Codex/SKILL.md](../../Codex/SKILL.md)
- OpenAI Codex plugin: https://github.com/openai/codex-plugin-cc
- OpenAI Codex app-server docs: https://developers.openai.com/codex/app-server
- OpenAI Codex config docs: https://developers.openai.com/codex/config-reference
