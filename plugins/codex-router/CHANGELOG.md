# Changelog

## 2.4.0

- Detect orphaned Codex jobs: a tracked job whose runtime process has died (broker crash, machine sleep, temp-dir cleanup) is now marked `failed` the next time its status or result is read — and on the stop-review gate, task-resume, and session-end paths — by probing the recorded worker PID and its process start time, instead of reporting `running` indefinitely. Detection is read-time, so no background watchdog is required.
- Serialize every terminal job transition — the owning runtime's own completion/failure, `/codex-router:cancel`, and orphan reconciliation — through a single locked `finalizeJob` write with first-terminal-wins semantics, so the `state.json` index entry and the per-job record are always written together and cannot be left in disagreement: a cancel cannot overwrite a real completion, a late completion cannot overwrite a cancel, and neither writer updates one record without the other.
- Serialize the queued→running start write and progress updates through the same lock with terminal-absorbing semantics, so a job cancelled before or during its run is never resurrected to `running`; a worker whose job was already cancelled backs off instead of running.
- Write per-job records via temp-file + rename so a worker force-killed mid-write can never corrupt a previously good record.
- Preserve the result of a job the 50-entry pruner evicts mid-run: the owning runtime re-inserts its own completion instead of silently discarding it.
- Prove worker process identity on Windows via `Win32_Process.CreationDate` (PowerShell `Get-CimInstance`), matching the POSIX `ps lstart` check, so session-end teardown checks a worker's recorded identity immediately before signalling — terminating only a live process whose start time still matches, rather than one that reused its PID — while no longer leaking workers on platforms where identity was previously unavailable. The residual pid-recycle window between the check and signal delivery is inherent to signalling by PID and is minimized, not eliminated.
- Write a background task's queued record (with its request payload) before spawning the detached worker, so the worker always finds its request at startup; the worker records its own PID and start-time identity when it transitions to running. A worker spawn that fails (synchronously or via the child's async `error` event) finalizes the queued record to `failed` instead of crashing the CLI and stranding a PID-less job, and the queued record carries the launcher's own PID + start-time identity so orphan reconciliation can fail a pre-spawn record whose launcher died instead of skipping it forever.
- Tombstone a session's active jobs to `failed` at SessionEnd instead of removing their index entries: a surviving worker whose identity could not be verified now backs off at its queued→running start write, where a removed entry would have read as a pruner eviction and let the worker re-insert the job and continue write-capable work after its session ended. The teardown kill also re-reads the worker's identity under the state lock, so a worker that started while the session was ending is terminated with a verified identity, and the scan repeats from fresh state until quiescent so a job enqueued while teardown was running is still tombstoned.
- Reject the analyze/exec routing directives (`--search`, `--docs`, `--tool`, `--parallel`) on `review` and `adversarial-review` with an explicit error pointing at `/codex-router:analyze` and `/codex-router:exec`, instead of silently treating them as free-form focus text.
- Correct the write-boundary documentation: `/codex-router:exec` is the only policy-routed analyze/exec write-capable entrypoint, `/codex-router:rescue` is a separate task path that writes only via `task --write`, and `/codex-router:cli` is a raw escape hatch outside job-tracked routing. Tests now assert exec-exclusive write router modes, task `--write` gating, and recorded `write`/`contextPackId`/`policyHash` on analyze and exec jobs.
- Advertise the app-server client identity as "Codex Router" instead of the upstream "Codex Plugin", and narrow the README host-contract claim to the companion command surface (no separate versioned JSON-RPC Core API exists).

## 2.3.1

- Escalate cancellation to SIGKILL only when the recorded worker PID still has the same process start time, force-killing verified survivors without targeting a recycled PID or process group.
- Bound the stop-time review gate: honor `stop_hook_active` and cap consecutive blocks at three per stop chain, letting the session stop with the unresolved findings downgraded to a note instead of looping forever. Chains are updated from fresh locked state per session so concurrent sessions in one workspace cannot reset or overwrite each other's counters.
- Let short-lived callers shorten the broker idle timeout via `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS`; the test suite sets it to two seconds so `npm test` runs no longer leave dozens of broker and fixture processes alive for the ten-minute production default.

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
