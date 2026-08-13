---
title: Codex Router Architecture Retrospective
status: complete
date: 2026-07-11
repository_head_reviewed: 3f85d7770b0c22edc59eea140018ea822aa5cd21
---

# Codex Router Architecture Retrospective

## Purpose

This document records what the repository history and current implementation teach us about building Codex Router again from scratch. It is evidence for the clean-sheet design, not criticism of the work required to make the present runtime reliable.

Quality, scalability, and reliability are treated as hard priorities over cost, difficulty, schedule, and backward compatibility.

## Review scope

The review covered:

- All 68 commits reachable after fetching all local and remote refs.
- Both pull requests in `gitguffaw/codex-router`, in all states.
- The 26 imported commits from `openai/codex-plugin-cc`.
- All 25 upstream pull requests referenced by the 25 imported post-initial commit subjects. Upstream `#234` is an issue; the corresponding pull request is `#235`.
- The current source tree, policy, documentation, tests, build, CI, release metadata, and package surfaces.
- Current official Codex documentation for app-server, SDK, plugins, permissions, and configuration.

The review does not claim coverage of unrelated, abandoned, private, deleted, or never-merged upstream work that did not produce a reachable imported commit.

## Repository facts

| Measure | Result |
| --- | --- |
| Reachable commits | 68 |
| Imported upstream commits | 26 |
| Fork-era commits | 42 |
| Merge commits | 2 |
| Current-repository pull requests | 2, both merged |
| Upstream referenced pull requests reviewed | 25 |
| Local tags | 13 |
| Current package version | 2.4.0 |
| `v2.4.0` tag | Missing |
| Contributors by display identity | 12 |
| Fork-era commits by Jeremy Neal | 42 of 42 |
| Subject-classified corrective/fix commits | 33 of 68 |
| Current tests | 183 passing |

The current clean checkout passed:

- `npm test`: 183 passed, 0 failed.
- `npm run lint`.
- `npm run check-version`.
- `npm run build` against regenerated app-server types.

## Evolution timeline

### Phase 1: upstream foundation

The first 26 commits, from 2026-03-30 through 2026-04-18, came from `openai/codex-plugin-cc`.

The initial commit `c69527e` introduced 58 files and approximately 9,718 lines. Rapid follow-up work corrected:

- Windows `.cmd`, Git Bash, and shell behavior.
- Test checkout path assumptions and timing flakiness.
- Session-scoped resume and cancellation.
- Authentication readiness.
- Large review diffs and untracked content.
- Shell interpolation and quoting.
- Skill/agent recursion.
- Version metadata drift.

CI arrived after ten commits rather than being present at the initial architecture boundary.

### Phase 2: Router v1 fork

The fork began at upstream commit `807e03a`. Commit `adcc308` introduced the Router product in a single 76-file change, adding policy-backed modes, analyze/exec routing, model controls, and context packs around the inherited runtime.

Subsequent work simplified commands, added job metadata and lifecycle states, widened the feature surface, and released v1.0.5.

The original brainstorm deliberately chose “fork first” to gain a working execution layer quickly while keeping a future sibling extraction possible. The repository has now accumulated enough evidence to exercise that escape hatch.

### Phase 3: multi-host v2

Six commits added the AGY bundle, refreshed product documentation, implemented live model discovery, and corrected focused review behavior.

This phase established the correct product direction: Codex Router is a portable delegation contract with more than one host adapter. The architecture, however, remained organized around the inherited Claude Code companion runtime.

### Phase 4: broker and process hardening

The 2.2.0 through 2.3.1 work repaired failures created by detached process and shared-broker ownership:

- `2178146`: idle timeout, spawn lock, PID plus start-time identity, and termination escalation after approximately 2,020 orphaned Node processes were observed.
- `65d2a6f`: corrected misuse of `ChildProcess.killed`, which records signal delivery rather than confirmed exit.
- `b6bb569`: state locking, atomic file replacement, turn-death detection, hermetic tests, lint, broader type checking, and hardened CI.
- `92ba371`: corrected process-group escalation when the leader exited before children.
- `95a4ec6` and `29abc06`: bounded and session-scoped the stop-review gate.

### Phase 5: job state and session teardown hardening

The work after v2.3.1 is the clearest architecture signal. Twelve authored commits consisted of eleven fixes and one release commit.

Important fixes included:

- `f103c7e`: orphan reconciliation and serialized terminal transitions.
- `1d2e2e1`: first-terminal-wins across owner completion and cancellation.
- `dfaaef5`: serialized start/progress writes and recovery from active-job pruning.
- `183e71c`: orphan reconciliation in stop, resume, and session-end paths.
- `9e14c57`: Windows process identity proof.
- `4a45812`: persist-before-spawn and reduced PID-reuse signalling window.
- `2f58eb5`: session tombstones preventing post-session write-job resurrection.
- `542db8d`: asynchronous spawn failure handling.
- `9fd0c26`: fresh-state session-end rescans and pre-spawn launcher orphan detection.

The apparent 2.4.0 release commit was followed by three additional corrections found through three rounds of review. This shows that green tests and a release-shaped diff were insufficient to prove lifecycle correctness under the existing process model.

## Pull-request evidence

### Current repository PR #1

[PR #1: prevent orphaned broker processes](https://github.com/gitguffaw/codex-router/pull/1)

- Four head commits, 14 files, +231/-70.
- Merged in approximately 54 minutes.
- CI passed, but the body acknowledged 87/90 local tests and left the soak test incomplete.
- An automated review found that SIGKILL escalation was incorrectly gated on `ChildProcess.killed`; the fix landed before merge.
- No independent human approval was recorded.

Under the stated north star, known failing tests and an incomplete soak test would be a release blocker for process-lifecycle changes.

### Current repository PR #2

[PR #2: 2.4.0 job-state hardening](https://github.com/gitguffaw/codex-router/pull/2)

- Twelve head commits, 32 files, +2,073/-171.
- Merged in approximately 43 minutes.
- Node 18.18 and Node 22 CI passed.
- Automated GitHub review identified missing queued-worker identity.
- Router self-review found four confirmed issues over three rounds:
  - Write-capable work could resurrect after session end.
  - Asynchronous spawn failure could crash the launcher and strand a queued job.
  - Session teardown could miss a job enqueued after its stale snapshot.
  - Launcher death before worker PID registration could leave an unprobeable queued orphan.
- No independent human approval was recorded.

The review process added real value, but it happened inside a rapid self-authored and self-merged release. Lifecycle, state, permission, and process changes need independent approval and required multi-round adversarial review.

### Upstream PR themes

The 25 referenced upstream PRs repeatedly encountered:

- Windows process and shell semantics.
- Platform-dependent test assumptions.
- Cross-session implicit action selection.
- Compatibility fallbacks that caught too much.
- Shell interpolation risks.
- Large-diff prompt scaling and omitted untracked files.
- Skill/agent recursion.
- Temporary-file cleanup and version drift.

These are boundary problems. A rebuild must make command grammar, session identity, process ownership, capability negotiation, artifact limits, and release metadata first-class typed components.

## Current architecture

The current product contains:

1. Claude Code command Markdown, hooks, and rescue agent.
2. An AGY skill adapter.
3. A 1,228-line companion CLI composition root.
4. A 1,436-line app-server event/auth/model/thread module.
5. A shared broker plus direct-process fallback.
6. Workspace-scoped `state.json`, per-job JSON records and logs, and context-pack JSON.
7. Session and stop-review hooks.
8. Git review-context collection and result rendering.

The companion CLI and its `--json` output are the effective host contract; there is no published versioned Core API.

## What is strong and must be preserved

The reliability work produced excellent domain invariants:

- Explicit queued, running, and terminal lifecycle states.
- First-terminal-writer-wins semantics.
- Persist-before-spawn ordering.
- Worker self-identification.
- PID-reuse-safe signalling.
- Session-end tombstones.
- Orphan adoption before invented failure.
- Session-scoped implicit status, result, cancel, and resume.
- Read-only versus write-capable separation.
- Live provider and model discovery.
- Structured review results.
- Context and policy provenance.
- No silent host-side fallback for failed Codex work.

These should become formal, typed, mechanically tested invariants rather than remain implementation conventions.

## What the rebuild should replace

### Filesystem coordination as a transaction system

The job index and per-job record require synchronization across two files. Atomic rename prevents torn individual JSON files but does not make the multi-file transition power-loss transactional. State corruption is silently interpreted as empty state. There is no `fsync` or schema migration path.

Replace this with a transactional store and append-only event journal.

### Detached processes and PID ownership

Detached workers and brokers require orphan detection, process start-time probing, escalation, spawn locks, session rescans, and tombstones. PID identity is a fallback approximation, not durable ownership.

Replace this with a resident supervisor holding real OS process handles and containment boundaries.

### Shared broker as concurrency control

The broker supports one active stream and returns busy for another. Callers may then start unscheduled direct processes. This provides neither bounded concurrency nor backpressure.

Replace this with an explicit queue, fair scheduler, and per-workspace reader/writer leases.

### CLI output as an unversioned Core API

Only review output has a JSON Schema. Setup, models, job state, events, results, cancellation, and context packs have no published compatibility contract.

Replace this with versioned request, event, result, and error schemas.

### Permissive parsing and non-strict types

Unknown flags can become prompt text. TypeScript checking is deliberately non-strict. The review-directive bug was one consequence of this boundary.

Replace this with strict schemas, generated help, explicit passthrough only after `--`, and runtime validation at every persistence and protocol boundary.

### Duplicated policy

Policy exists across Markdown, hardcoded prompt strings, command docs, host skills, and context-pack hash lists. `Workflows/Parallel.md` is shipped but absent from the context-pack policy list even though parallel routing is supported.

Replace this with one executable policy manifest that generates prompts, docs, schemas, and adapter guidance.

## Quality and delivery gaps

The current test suite has strong behavioral regression coverage, but lacks:

- Measured coverage and mutation thresholds.
- Property and model-based concurrency testing.
- Crash and power-loss injection at every transition.
- Hung-but-alive worker detection.
- Long-duration multi-session soak tests.
- Real-Codex compatibility smoke tests.
- macOS and Windows CI.
- Security, dependency, and secret scanning.
- Reproducible signed release artifacts, SBOMs, and provenance.
- Required release-tag verification.

The repository also lacks a public architecture document, security policy, contribution guide, CODEOWNERS, and required independent review policy.

## Conclusion

Reliability was retrofitted after feature development. The resulting fixes provide the correct invariants, but they also demonstrate that distributed file-and-PID coordination is the wrong foundation.

The rebuild should retain the product knowledge, policy intent, live discovery, structured results, host parity, and accumulated tests. It should replace the execution foundation with one durable owner, typed contracts, transactional state, isolated attempts, explicit scheduling, and transactional workspace application.

## Related documents

- [Codex Everywhere product vision](../product/codex-everywhere-vision.md)
- [Capability gateway clean-sheet design](./capability-gateway-design.md)
- [Claude Code installation and user experience](./claude-code-experience.md)
