# Changelog

## 2.0.0

Codex Router's first public release line starts at `2.0.0`. Earlier `1.0.x` metadata was internal release-candidate churn, not separate public releases.

- Add `/codex-router:*` commands for analyze, exec, review, adversarial review, rescue, status, result, cancel, and setup.
- Route analyze/exec work through Codex app-server turns with policy context packs, model controls, and job tracking.
- Record model controls and richer lifecycle states on job records.
- Add optional review gate support and Codex resume handoff details.
- Add an Antigravity (`agy`) plugin bundle that exposes a `codex-router` skill for the existing companion runtime.
- Preserve OpenAI Apache-2.0 attribution for upstream-derived plugin code.
