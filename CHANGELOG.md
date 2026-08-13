# Changelog

Public release history for Codex Router is tracked in the plugin changelog at [plugins/codex-router/CHANGELOG.md](./plugins/codex-router/CHANGELOG.md).

## Latest

- [2.4.1](./plugins/codex-router/CHANGELOG.md#241): detached rescue workers that survive watcher expiration, exact-job completion notifications, heartbeat-backed job recovery, uncapped job retention, consistent wait/background flags, and safe command-specific help.
- [2.4.0](./plugins/codex-router/CHANGELOG.md#240): explicit review-directive rejection, corrected write-boundary docs, orphaned-job reconciliation, serialized job start/progress writes, Windows process-identity proof, and worker-launch race closure.
- [2.3.1](./plugins/codex-router/CHANGELOG.md#231): identity-checked SIGKILL escalation, atomic per-session stop-gate counters, and prompt test-broker reaping.
- [2.3.0](./plugins/codex-router/CHANGELOG.md#230): identity-based state locking with atomic writes, mid-turn app-server death detection, cancel SIGKILL escalation, hermetic tests, lint/type coverage, and hardened CI.
- [2.2.0](./plugins/codex-router/CHANGELOG.md#220): fix orphaned broker process accumulation with idle timeout, PID verification, spawn locking, and SIGKILL escalation.
- [2.1.1](./plugins/codex-router/CHANGELOG.md#211): bugfix for focused `/codex-router:review` requests promoting directly to adversarial review without recursive slash-command invocation.
- [2.1.0](./plugins/codex-router/CHANGELOG.md#210): live model catalog discovery, stale default-model recovery, AGY parity updates, and release-surface documentation/test coverage.
- [2.0.0](./plugins/codex-router/CHANGELOG.md#200): first public release line for the Codex Router Claude Code plugin and AGY bundle.
