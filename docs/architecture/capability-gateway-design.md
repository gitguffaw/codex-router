---
title: Codex Capability Gateway Clean-Sheet Design
status: proposed
date: 2026-07-11
---

# Codex Capability Gateway Clean-Sheet Design

## Executive decision

Build Codex Router as a local capability gateway backed by a durable execution supervisor.

- A signed Rust binary provides daemon and CLI modes.
- One per-user supervisor owns all durable state and child processes.
- SQLite in WAL mode provides the local transactional store.
- Each managed execution attempt owns one isolated Codex app-server process.
- Write-capable jobs run in isolated workspaces and apply through a journaled compare-and-swap operation.
- A versioned local API is the fundamental integration contract.
- An MCP server exposes that API to agent harnesses.
- Claude Code, AGY, and future integrations are thin host adapters.
- One executable policy definition generates routing behavior, prompts, schemas, and documentation.
- A lossless native bridge provides immediate access to unmodeled Codex behavior.

This is a modular monolith. It is not a microservice system.

## Architectural goals

### Quality

- Preserve Codex-native capability behavior and typed events.
- Make permissions, routing, output, and review gates mechanically enforceable.
- Use strict types and runtime schemas at every boundary.
- Make write results independently verifiable and safely applicable.
- Keep one source of truth for policy and command compatibility.

### Scalability

- Support multiple host sessions and bounded concurrent jobs without unbounded process creation.
- Allow immutable read work to run concurrently.
- Serialize or isolate write work by workspace.
- Provide backpressure, fairness, priorities, pagination, artifact retention, and event streaming.
- Permit a future distributed control plane without changing host contracts.

### Reliability

- Give every job and child process one authoritative owner.
- Make every accepted request idempotent.
- Persist every state transition before acknowledgement.
- Confirm cancellation and termination rather than infer them from signal delivery.
- Recover deterministically from supervisor, worker, app-server, storage, and workspace failures.
- Never overwrite a changed live workspace.

## System context

```text
Claude Code plugin ─┐
AGY skill/plugin ───┼── Host adapter ── Versioned local API ── Router supervisor
Generic MCP host ───┤                                          │
CLI/SDK client ─────┘                                          ├─ Capability registry
                                                               ├─ Policy planner
                                                               ├─ Durable job service
                                                               ├─ Scheduler and leases
                                                               ├─ Execution capsules
                                                               ├─ Workspace transactions
                                                               ├─ Model/capability catalog
                                                               └─ Telemetry and diagnostics
                                                                        │
                                                                   SQLite/WAL
```

## Suggested repository structure

```text
apps/
  codex-router/                 CLI and daemon entry point
crates/
  router-domain/               Job, attempt, event, lease, and state-machine types
  router-application/          Submit, watch, cancel, recover, and apply use cases
  router-api/                  Versioned RPC server/client and schemas
  router-store-sqlite/         Transactions, migrations, integrity, and backups
  router-scheduler/            Queueing, fairness, priorities, and workspace leases
  router-execution/            Process containment and execution capsules
  codex-protocol/              Generated app-server protocol bindings
  workspace-transaction/       Isolated workspaces, patch capture, apply, rollback
  router-policy/               Policy compilation and immutable RunPlan generation
  router-observability/        Events, metrics, tracing, and diagnostics
adapters/
  claude-code/                 Plugin, skill, hooks, MCP configuration, rendering
  agy/                         Skill/plugin and rendering
  mcp/                         Universal MCP tool and resource surface
policy/                        Versioned declarative policy manifests and templates
schemas/                       API, event, result, policy, and artifact schemas
tests/                         Contract, compatibility, fault, security, and soak tests
```

Rust is selected for native cross-platform process containment, strongly typed state machines, deterministic resource ownership, and self-contained signed distribution. Host integrations may use small scripts or Markdown, but contain no routing or lifecycle logic.

## Fundamental API

Define a real `v1` API before implementing host adapters.

### Job methods

- `jobs.submit(RunSpec)`
- `jobs.get(jobId)`
- `jobs.list(filter, cursor)`
- `jobs.watch(jobId, afterSequence)`
- `jobs.cancel(jobId, expectedVersion)`
- `jobs.apply(jobId, expectedWorkspaceRevision)`
- `jobs.retry(jobId, expectedVersion)` when retry safety is proven

### Session methods

- `sessions.open`
- `sessions.heartbeat`
- `sessions.close`
- `sessions.detachJob` when policy explicitly permits work to outlive the host session

### Discovery and operations

- `capabilities.get`
- `models.list`
- `policy.explain`
- `health.get`
- `diagnostics.export`
- `native.invoke`
- `native.openTerminal`

### RunSpec

A `RunSpec` includes:

- Idempotency key.
- Canonical workspace identity and workspace revision.
- Host and session identity.
- Requested capability or managed workflow.
- Permission profile.
- Prompt or content-addressed prompt reference.
- Policy version and hash.
- Model selector, effort, and service tier.
- Requested tools and capability constraints.
- Foreground, background, or explicitly detached ownership.
- Deadline and retry policy.
- Retention and privacy classification.
- Output contract.
- For write work, isolation, verification, review, and apply requirements.

### Error envelope

Every error contains:

```text
code
category
message
retryable
requestId
jobId
attemptId
details
```

Stable codes distinguish invalid requests, policy denial, unsupported capabilities, unavailable dependencies, protocol incompatibility, workspace drift, lease expiry, resource exhaustion, execution failure, corrupt storage, cancellation, interruption, and internal faults.

Unknown fields and options fail validation except inside an explicitly versioned extension or native payload.

## Capability model

The gateway maintains a dynamic registry assembled from:

- The installed Codex runtime and app-server protocol.
- Live model and effort discovery.
- Provider and authentication state.
- Configured MCP servers, tools, connectors, and permission profiles.
- Host rendering and interaction capabilities.
- Router-managed capabilities such as durable background jobs and transactional apply.
- Public app or cloud APIs where available.

Each capability record declares:

- Identifier and version.
- Provider surface.
- Input and output schemas.
- Permission requirements.
- Whether it is managed, native, handoff-only, experimental, or unavailable.
- Streaming and approval behavior.
- Host rendering requirements.
- Compatibility range and feature flags.

The registry is dynamic. Host adapters should support capability change notifications rather than require reinstalling when the gateway gains a tool.

## Provider selection

Use the narrowest provider that preserves requested behavior:

- App-server for threads, turns, native reviews, approvals, streaming items, interruption, and rich client functionality.
- Codex SDK or noninteractive mode for simple automation where it improves reliability without losing needed behavior.
- Codex MCP server when Codex is one specialist in a broader orchestrated workflow.
- App/cloud integration only where a supported public interface exists.
- Native CLI bridge when managed parity is unavailable.

Do not implement implicit fallback that changes semantics. Provider selection is recorded in the immutable execution plan and exposed through `policy.explain`.

## Policy and planning

Create one versioned declarative policy manifest defining:

- Workflows and capability mappings.
- Permission profiles.
- Supported modifiers and incompatibilities.
- Model selection constraints.
- Prompt templates.
- Output contracts.
- Retry and deadline rules.
- Verification and review gates.
- Workspace isolation and apply behavior.
- Retention and privacy rules.

A pure planner maps:

```text
RunSpec + capability registry + model catalog + workspace facts + policy
```

to an immutable, content-addressed `RunPlan`.

Prompts, CLI help, adapter skill instructions, JSON Schemas, policy documentation, and context-pack hashes are generated from or checked against this manifest. A routed capability can never omit one of its policy inputs from provenance.

Timestamps are metadata and must not affect content-addressed policy or context identities.

## State model

### Public job states

```text
queued -> running -> succeeded
                  -> blocked
                  -> failed
                  -> cancelled
                  -> interrupted
```

Preparation, verification, review, apply, and cleanup are internal phases. Warnings are structured outcome data rather than a separate lifecycle state.

### Jobs and attempts

A job is the durable user request and outcome. An attempt is one execution of that job.

- Read-only jobs may receive a new attempt after a safe infrastructure failure.
- Write jobs may retry while isolated and before an ambiguous apply.
- No retry occurs after an ambiguous live-workspace apply until the apply journal is resolved.

### Store tables

- `jobs`: durable user-visible identity and terminal outcome.
- `attempts`: runtime metadata and attempt outcome.
- `job_events`: append-only, monotonically sequenced audit and progress stream.
- `leases`: session, workspace, worker, and apply ownership.
- `artifacts`: content-addressed prompts, policies, outputs, logs, patches, and receipts.
- `idempotency_keys`: retry-safe command acceptance.
- `review_receipts`: verdicts bound to exact artifact digests.
- `apply_journals`: live-workspace compare-and-swap and recovery state.
- `schema_migrations`: deterministic migration history.

Only the supervisor writes durable state. Workers emit authenticated events. Transitions use a row version or fencing token inside one database transaction.

### Durability

- WAL journaling.
- Foreign keys and check constraints.
- Full synchronous durability appropriate to the platform.
- Startup integrity checks.
- Rolling, tested backups.
- Explicit migrations and rollback compatibility.
- Store corruption produces `STORE_CORRUPT`, quarantine, and diagnostic instructions; it never becomes an empty default state.

## Scheduling and concurrency

The scheduler provides:

- Bounded global concurrency.
- Admission control and backpressure.
- Fairness across host sessions.
- Explicit priorities.
- Per-workspace reader/writer leases.
- Multiple immutable read jobs in parallel.
- One live-workspace apply at a time.
- Isolated concurrent write execution where separate worktrees are safe.
- Resource limits per process and job.
- Deadlines and cancellation propagation.
- No direct-process fallback outside the scheduler.

Jobs that cannot start remain durably queued with an explicit reason and position. Queue state is observable rather than inferred from a spawned process.

## Process ownership

Remove the shared broker and detached worker model.

Each managed attempt owns one Codex process. The supervisor retains the actual OS process handle and places the process tree in a containment boundary:

- Linux: process group, parent-death handling, and pidfd where available.
- macOS: process group plus a watchdog/lifeline mechanism.
- Windows: Job Object with kill-on-close and owned process handles.

If the supervisor terminates, containment terminates its managed children. On restart, SQLite recovery decides whether an attempt is safely retryable or terminally interrupted. Stale PIDs are diagnostic evidence, never primary proof of ownership.

### Cancellation protocol

1. Atomically record `cancel_requested`.
2. Send Codex `turn/interrupt` where supported.
3. Wait a bounded grace period.
4. Terminate the owned process tree through the containment handle.
5. Confirm process exit.
6. Atomically record `cancelled` unless success committed first.

Signal delivery is not cancellation completion.

### Session shutdown

Session closure atomically revokes its lease and requests cancellation of session-scoped write jobs. Work may outlive a host session only when `RunSpec` explicitly grants detached ownership. This is never inferred from “background.”

## Transactional write execution

Direct live-workspace edits are not the default managed write path.

For `exec`:

1. Capture the baseline: HEAD, index, tracked hashes, untracked manifest, and relevant configuration.
2. Materialize an isolated worktree or overlay containing the intended baseline, including required dirty and untracked input.
3. Run Codex with workspace-write permission only inside the isolated workspace.
4. Capture file changes, commands, output, and the complete resulting patch.
5. Run configured verification.
6. Run an independent review in a fresh Codex thread or reviewer context.
7. Produce a review receipt bound to the exact patch digest.
8. Recheck the live workspace revision and content fingerprint.
9. Apply through a journaled compare-and-swap operation.
10. If the live workspace changed, preserve the patch and report `WORKSPACE_DRIFT` rather than overwrite.
11. Recover an interrupted apply by completing or rolling back from the journal.

An explicitly named unmanaged or in-place mode may exist, but its reduced guarantees must be visible and it must never masquerade as the default managed path.

## Review receipts and gates

A review receipt includes:

```yaml
subject:
  base_sha: <sha>
  head_sha: <sha>
  diff_digest: sha256:<digest>
review:
  model_selector: sol
  resolved_model: <live model id>
  effort: xhigh
  verdict: pass
  blocking_findings: 0
provider: codex-app-server
policy_version: <version>
completed_at: <timestamp>
```

Any change to the reviewed subject invalidates the receipt. A PR-create gate checks for a current receipt satisfying its configured model, effort, policy, and verdict requirements.

## Native bridge

The native bridge supports:

- Arbitrary Codex subcommands and flags.
- Interactive terminal handoff where the host supports it.
- Raw structured event forwarding where available.
- Explicit environment and permission boundaries.
- Invocation auditing and artifact capture where possible.
- Immediate access to new Codex features.

The bridge explicitly describes which managed guarantees do not apply. It does not silently turn native invocations into tracked managed jobs.

## Observability

Every command, job, attempt, Codex thread, turn, workspace transaction, review receipt, and apply operation receives correlation identifiers.

Structured events and metrics include:

- Queue delay and queue depth.
- Process startup and capability negotiation time.
- Turn and review duration.
- State-transition rejections.
- Lease expiry and recovery decisions.
- Cancellation latency and escalation.
- App-server exits and protocol errors.
- Retry decisions.
- Workspace drift and apply conflicts.
- Apply and rollback results.
- Store latency and integrity failures.
- Result size and retention actions.

`codex-router diagnose --bundle` produces a sanitized local diagnostic package containing versions, capability negotiation, health, recent event metadata, and logs.

Raw prompts, secrets, reasoning, and protocol payloads are not written to general logs by default.

## Security and privacy

- Validate peer identity on local IPC.
- Use socket-directory permissions on Unix and restricted named-pipe ACLs on Windows.
- Pass a minimal environment allowlist to Codex processes.
- Classify and validate privileged configuration overrides.
- Canonicalize workspace roots and prevent symlink/path escapes.
- Use explicit capability tokens for write, detach, and apply operations.
- Centralize structured redaction before persistence.
- Encrypt sensitive prompt/result artifacts with a per-install key protected by the OS credential store.
- Provide inspectable retention, export, and secure purge.
- Keep nonsensitive lifecycle metadata separate from encrypted content.
- Sign binaries and ship checksums, SBOMs, and provenance attestations.

## Testing strategy

### Unit and property testing

- Exhaustive state-transition table tests.
- Property tests for terminal absorption, idempotency, leases, retention, and review-receipt invalidation.
- Parser/schema tests proving unknown options cannot leak into prompts.
- Policy compiler and documentation-drift tests.

### Concurrency and fault testing

- Model-based submit/start/cancel/complete/session-close interleavings.
- Supervisor, worker, and Codex process termination at every boundary.
- Connection loss, delayed events, duplicate events, and reordered notifications.
- ENOSPC, permission loss, corrupted database, sleep/wake, and clock changes.
- Interrupted workspace apply and recovery.
- Resource-exhaustion and queue-backpressure tests.

### Protocol and compatibility testing

- Checked-in golden schemas for every API and event version.
- App-server compatibility tests against the pinned version and deliberately supported adjacent versions.
- JSONL and notification-order fuzzing.
- Real-Codex smoke tests alongside hermetic fixtures.
- A deliberate protocol-upgrade workflow that regenerates bindings, reviews the schema diff, and runs the full compatibility suite.

### Platform and host testing

- Required Linux, macOS, and Windows CI.
- Real process containment tests on each platform.
- Claude Code and AGY adapter conformance against the same gateway fixture.
- MCP discovery, permissions, reconnect, and dynamic capability tests.
- Long-duration multi-session soak tests with thousands of jobs and bounded resources.

### Quality gates

- Strict compiler and linter settings.
- Coverage and mutation thresholds.
- Independent approval for state, lifecycle, process, permission, protocol, and apply changes.
- Multi-round adversarial review for high-risk changes.
- No known failed tests or unchecked required soak tests at release.

## Release engineering

- Generate version metadata from one source.
- Build reproducibly for all supported platforms.
- Sign binaries and tags.
- Produce SBOM and provenance attestations.
- Test installation, upgrade, rollback, and package contents.
- Require a release tag matching the artifact version.
- Canary protocol and storage migrations before broad release.
- Retain backward-readable diagnostics and an export path through the supported rollback window.

## Migration roadmap

### 1. Specify invariants

Write ADRs for the API, state machine, process containment, workspace transaction, capability model, security model, compatibility policy, and SLOs. Convert current behavior into characterization tests.

### 2. Build the durable core beside the legacy runtime

Implement domain types, SQLite store, policy compiler, API, capability registry, and read-only import/inspection tooling. Do not dual-write.

### 3. Add read-only execution capsules

Route analyze and native review through supervised isolated app-server attempts. Shadow-compare lifecycle, event, and result behavior with the legacy runtime.

### 4. Cut over job management

Move submit, status, watch, result, cancel, session leases, model discovery, and recovery to the new API while preserving user-facing command names.

### 5. Add transactional exec

Implement isolated workspaces, verification, independent review, apply journals, conflict preservation, and recovery. Cut over write-capable work only after these are proven.

### 6. Add universal MCP and host adapters

Expose the capability API through MCP. Move Claude Code and AGY to generated adapter clients and conformance tests. Add the native bridge.

### 7. Harden release gates

Complete cross-platform fault injection, soak, security review, signed artifacts, and upgrade/rollback drills.

### 8. Retire the legacy runtime

Remove file locks, detached workers, the shared broker, PID reconciliation, duplicate state/result records, permissive parsing, and host-specific semantic branching after sustained shadow and canary success.

## Legacy import

The importer is idempotent and preserves original files untouched.

- Back up and hash each legacy state directory.
- Import index, job, context, log, and result artifacts into a separate database.
- Record ambiguities as migration events.
- Use explicit reconciliation rules when the index and per-job terminal records disagree.
- Never silently invent a terminal result.
- Make the old runtime read-only after cutover.
- Provide export tooling for rollback visibility.

## Open decisions

- Exact Rust RPC framework and wire framing for the local API.
- Whether the first managed provider directly implements app-server or wraps an official SDK where feature parity permits.
- Exact cross-platform workspace overlay mechanism for dirty and untracked inputs.
- Which artifact fields are encrypted by default and how recovery keys are handled.
- Default global and per-workspace concurrency limits.
- Which native bridge operations may receive partial managed lifecycle guarantees.
- Whether remote/distributed execution is an explicit future product or only an architectural compatibility constraint.

These decisions do not change the core direction: one durable supervisor, transactional state, capability negotiation, isolated attempts, thin adapters, and lossless Codex access.

## Official references

- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Codex SDK](https://developers.openai.com/codex/codex-sdk)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Codex plugin structure](https://developers.openai.com/codex/plugins/build)

## Related documents

- [Codex Everywhere product vision](../product/codex-everywhere-vision.md)
- [Architecture retrospective](./architecture-retrospective.md)
- [Claude Code installation and user experience](./claude-code-experience.md)
