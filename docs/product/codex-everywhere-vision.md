---
title: Codex Everywhere Product Vision
status: proposed
date: 2026-07-11
---

# Codex Everywhere Product Vision

## Product statement

Codex Router should make Codex-native capabilities available from different agent harnesses with minimal friction while preserving Codex behavior, safety boundaries, and fidelity.

In short:

> Codex everywhere, with native semantics preserved.

The product is not merely a better background-job runner and not a small collection of generic `analyze`, `exec`, and `review` commands. It is a capability gateway through which Claude Code, AGY, and future harnesses can discover and invoke what Codex can do.

## User outcome

After installing one host integration, a user should be able to say:

> Use Codex sol at xhigh effort to review the PR before submitting it. Do not submit until Codex reports no blocking findings.

The host should then:

1. Recognize that Codex is the requested specialist.
2. Resolve `sol` through the live Codex model catalog.
3. Validate that the resolved model supports `xhigh`.
4. Determine the exact proposed or existing pull-request diff.
5. Invoke a native, read-only Codex review.
6. Preserve progress, findings, reasoning metadata, and thread identity.
7. Prevent submission when the review fails its gate.
8. Invalidate the review if the reviewed diff changes.
9. Submit only after a current review receipt proves the required verdict.

The same natural-language intent should work in every supported harness. Host-specific commands remain useful deterministic shortcuts, but they do not define the product boundary.

## Principles

### Capability parity over command parity

The project should expose Codex capabilities rather than forcing every capability into a fixed list of Router commands. A new Codex feature should become reachable through capability discovery or lossless native access before Router has a polished first-class workflow for it.

### Native semantics over lowest-common-denominator abstraction

Normalize infrastructure concerns such as lifecycle, identity, permissions, errors, persistence, and events. Preserve capability-specific Codex payloads and behavior wherever possible.

For example, a typed app-server item should not be prematurely reduced to a log line. Hosts may render it differently, but the gateway retains the lossless event.

### Managed integration and lossless native access

Every capability belongs to one of two categories:

- **Managed:** typed, durable, observable, policy-controlled, and portable across supported hosts.
- **Native bridge:** minimally transformed access to Codex CLI or protocol behavior that Router does not yet model, with explicit guarantees and limitations.

The native bridge is a compatibility valve, not an embarrassment. Codex will evolve faster than Router, and users should not have to wait for a Router release to try a new Codex feature.

### No silent degradation

If a model, effort level, tool, connector, review target, or other capability is unavailable, Router reports that precisely. It does not silently choose a weaker model, substitute a different tool, or let the outer host perform work that was delegated to Codex.

### Mechanical safety boundaries

Read-only and write-capable work must be separated by permissions and execution isolation, not only by prompt language. Review receipts, workspace fingerprints, leases, and apply journals make quality guarantees enforceable.

### One durable owner

Every accepted job and child process has one authoritative owner. Host adapters do not own lifecycle semantics, and workers do not mutate durable state directly.

## What “effortless” means

For a user:

1. Install one plugin or adapter.
2. Complete one setup check.
3. Continue using existing Codex authentication and configuration.
4. Ask naturally for Codex by name.
5. Receive host-native progress, approvals, results, and resumable identity.
6. Get an exact explanation or lossless handoff when a capability cannot cross the host boundary.

The user should not need to know whether a request was satisfied through app-server, the Codex SDK, Codex as an MCP server, a cloud interface, or the native CLI bridge.

## Capability sources

Codex functionality currently spans several surfaces:

| Source | Appropriate use |
| --- | --- |
| Codex app-server | Deep integration: threads, turns, streaming items, approvals, interruption, native review, models, and capability discovery |
| Codex SDK or noninteractive CLI | Coding-focused automation when the richer app-server client lifecycle is unnecessary |
| Codex MCP server | Using Codex as a specialist inside a broader agent orchestration |
| Codex CLI/TUI | Interactive and newly released behavior not yet represented through a managed gateway capability |
| Codex app or cloud APIs | App-only, cloud, connector, browser, automation, or visualization behavior when a public integration surface exists |

Router should not pretend that every app feature is publicly programmable. Capability negotiation must distinguish supported, unavailable, and handoff-only functionality.

## Capability negotiation

Every host adapter can ask the gateway what is available in the current environment. A representative response might include:

```text
threads.start             supported
threads.resume            supported
turns.steer               supported
turns.interrupt           supported
reviews.native            supported
tools.webSearch           supported
tools.browser             unavailable
connectors.googleDrive    unavailable
jobs.background           supported by gateway
terminal.interactive      handoff-only
```

The answer depends on the installed Codex runtime, authentication, provider, workspace policy, host capabilities, and configured tools.

## Host integration model

“Adapter” means the host-specific layer connecting an agent harness to the capability gateway. MCP is the preferred universal adapter mechanism, but it is not the whole system.

Supported adapter forms include:

- MCP server for tool discovery and invocation.
- Native plugin for richer commands, skills, hooks, progress, permissions, and installation.
- Skill teaching a host how to choose and compose gateway tools.
- CLI client for shell-capable environments without MCP.
- SDK client for applications embedding Router programmatically.

The fundamental contract is a versioned local API. MCP exposes agent-friendly tools over that API. Native plugins add host-specific user experience without reimplementing Router semantics.

## Primary user journeys

### Review before pull-request submission

The user asks Claude to use a named Codex model and effort level to review the exact proposed PR. Router returns a structured verdict and a review receipt bound to the base SHA, head SHA, and diff digest. A changed diff invalidates the receipt.

### Delegate implementation

The user asks a host to have Codex implement a bounded change. Router creates an isolated workspace, runs Codex with the correct permission profile, verifies the result, performs independent review, and applies the result only if the live workspace still matches the captured baseline.

### Continue Codex work across hosts

A Codex thread started from Claude Code can be resumed from AGY or another harness using stable Router and Codex thread identities, subject to permissions and workspace access.

### Reach a new Codex feature immediately

When Router does not yet have a managed representation, the host uses the native bridge. Router audits the invocation and preserves output where possible, while clearly stating which lifecycle or safety guarantees do not apply.

## Non-goals

- Reimplement the Codex model or replace the Codex runtime.
- Hide capability unavailability through host-side substitution.
- Force app-only features through invented APIs.
- Build a lowest-common-denominator agent protocol.
- Create distributed microservices for a primarily local product without a demonstrated reliability or scalability benefit.
- Preserve every historical command or implementation detail when it conflicts with the north star.

## Product success criteria

- A user can invoke Codex naturally from every supported harness.
- Managed capabilities preserve Codex-native behavior and structured events.
- New Codex capabilities are discoverable without changing each adapter.
- No accepted job loses its terminal result.
- No write-capable process continues without a valid lease.
- Cancellation and session revocation are confirmed, not assumed.
- A review gate is tied to the exact reviewed artifact.
- A workspace apply cannot overwrite a changed baseline.
- Unavailable capabilities fail explicitly.
- Host adapters remain small enough to test exhaustively against the same conformance suite.

## Related documents

- [Architecture retrospective](../architecture/architecture-retrospective.md)
- [Capability gateway clean-sheet design](../architecture/capability-gateway-design.md)
- [Claude Code installation and user experience](../architecture/claude-code-experience.md)
