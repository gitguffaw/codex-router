# Changelog

## 2.3.0

- Serialize all state.json writers behind an identity-based lock: the lock record carries pid + process start time created atomically via hardlink, a live holder with matching identity is never stolen, dead or PID-reused holders are reclaimed immediately, and only malformed lock records with no identifiable owner age out. Writes now go through temp-file + rename so a crashed writer can no longer leave a torn state file.
- Reject a captured Codex turn when the app-server process or broker connection dies mid-turn instead of hanging forever, by racing the turn completion against the client's exit promise.
- Escalate `/codex-router:cancel` from SIGTERM to SIGKILL through `terminateWithEscalation()` so cancelled jobs that ignore SIGTERM are still terminated.
- Route the SessionEnd job cleanup through the locked `updateState` path so ending one Claude session can no longer drop jobs enqueued concurrently by another session.
- Make the test suite hermetic inside Claude Code and Codex sessions by scrubbing `CLAUDE*`/`CODEX*` environment variables at test-helper load, and add lock-contention regression tests (half-written lock, live holder, dead holder, PID reuse, unverifiable identity).
- Split the monolithic runtime test file into five files so `node --test` parallelizes across processes, roughly halving suite wall-clock time.
- Add ESLint (flat config) with a `npm run lint` script, expand TypeScript checking to every runtime module, and fix the issues both surfaced.
- Run CI on pushes to the default branch and manual dispatch in addition to pull requests, across a Node 18.18/22 matrix, with the Codex CLI install pinned to an exact version so upstream releases cannot break builds.

## 2.2.0

- Prevent orphaned broker processes from accumulating when the SessionEnd hook does not fire (crash, force-kill, or abrupt session termination).
- Add idle timeout (10 minutes default) to the broker process so it self-terminates when no clients are connected, eliminating the primary source of process leaks.
- Record process start time alongside PID in broker session state to detect stale entries pointing at recycled PIDs.
- Add exclusive lock file during broker spawn to prevent concurrent callers from racing to create duplicate brokers.
- Add SIGTERM-to-SIGKILL escalation in the app-server client close path and a new `terminateWithEscalation()` utility to ensure processes actually terminate during cleanup.
- Expose `--idle-timeout <ms>` on the broker CLI for shorter timeouts in tests.

## 2.1.1

- Fix focused `/codex-router:review` requests so extra focus text promotes directly to the adversarial review runtime path instead of failing native-review validation.
- Clarify review command docs so Claude preserves focus text and does not try to invoke the user-only `/codex-router:adversarial-review` slash command from inside another command.
- Add the app-server protocol type entries for `account/read` and `config/read` so release builds type-check against the current generated Codex API surface.

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
