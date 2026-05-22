---
status: accepted
date: 2026-05-21
---

# Define Codex Router as a portable core with host adapters

Codex Router is a host-independent delegation contract for making Codex work predictable: routing mode selection, model/effort/tier controls, context preservation, job tracking, status/result/cancel, resume behavior, and result handling. The Claude Code plugin is the first host adapter, not the product boundary.

## Consequences

- Core delegation semantics should not be hidden inside Claude Code slash-command behavior.
- New hosts such as OpenClaw, Hermes, or Codex itself should integrate through host adapters over the same core contract.
- Host adapters may differ in UX and invocation syntax, but they should not redefine routing modes, job lifecycle states, or result semantics.
