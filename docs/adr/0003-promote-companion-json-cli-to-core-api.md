---
status: accepted
date: 2026-05-21
---

# Promote the companion JSON CLI to the Core API

The existing `codex-companion.mjs --json` command surface is already the practical runtime boundary for setup, analyze, exec, review, task, status, result, and cancel. Rather than extracting a new core first, we will treat the companion JSON CLI as Codex Router Core API v1 and harden it as a host-facing contract.

## Consequences

- Host adapters should prefer `--json` and treat human-rendered output as adapter/UI text.
- Core API shapes should be documented, versioned, and covered by contract tests.
- Claude-specific leakage in state environment names, rendered follow-up commands, and docs should be isolated from the Core API over time.
