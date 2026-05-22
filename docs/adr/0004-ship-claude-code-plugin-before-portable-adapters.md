---
status: accepted
date: 2026-05-21
---

# Ship the Claude Code plugin before portable adapters

Codex Router 1.0.4 is scoped to shipping the Claude Code plugin. The portable-core direction remains accepted, but OpenClaw, Hermes, Codex-to-Codex adapters, and Core API hardening are post-ship roadmap work rather than release blockers.

## Consequences

- The 1.0.4 release bar is passing tests, correct metadata, accurate README, intact install/setup flows, working job controls, and preserved provenance/license notices.
- `docs/core-api.md` and additional host adapters should not block this release.
- Future host adapter work should build on the accepted Core API direction from ADR 0003.
