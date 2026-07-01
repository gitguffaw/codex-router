# Changelog

## 2.1.0

- Add `/codex-router:models` as a first-class live model catalog for Claude Code and AGY users, including supported effort levels, `fast` tier visibility, alias reporting, and effective default selection.
- Detect stale ChatGPT-backed default model pins during setup and route users to the live `models` surface instead of leaving model recovery implicit.
- Automatically fall back from an unavailable configured ChatGPT default model to the live recommended default for default-inheriting runs, while rejecting explicit unavailable model ids early.
- Expand AGY release parity so the `codex-router` skill, README guidance, and AGY tests cover `setup -> models -> delegated run`, stale-pin recovery, and model/effort discovery.
- Extend runtime and fixture coverage for live model catalog reporting, hidden-model visibility, stale default handling, shared broker reuse, and AGY docs protection.

## 2.0.0

Codex Router's first public release line starts at `2.0.0`. Earlier `1.0.x` metadata was internal release-candidate churn, not separate public releases.

- Add `/codex-router:*` commands for analyze, exec, review, adversarial review, rescue, status, result, cancel, and setup.
- Route analyze/exec work through Codex app-server turns with policy context packs, model controls, and job tracking.
- Record model controls and richer lifecycle states on job records.
- Add optional review gate support and Codex resume handoff details.
- Add an Antigravity (`agy`) plugin bundle that exposes a `codex-router` skill for the existing companion runtime.
- Preserve OpenAI Apache-2.0 attribution for upstream-derived plugin code.
