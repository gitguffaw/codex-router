# Verification Report: QNT-142–QNT-150

- **Repo:** `codex-router` @ commit `8394296` (`@compound/codex-router-plugin-cc` v2.3.1)
- **Date:** 2026-07-08
- **Method:** End-to-end checks against code, runtime, and tests (not docs alone)
- **Final gate:** `npm run build` (exit 0) and `npm test` (147 pass, 0 fail)
- **Git:** No commits made; all fixes left uncommitted in the working tree

---

## QNT-142 — Create tracked `codex-router` plugin bundle and implementation tree

**Verdict: PASS**

### Evidence
- Tracked tree under `plugins/codex-router/` with real substance (not placeholder-only):
  - `commands/` (11 slash commands)
  - `scripts/` (`codex-companion.mjs`, broker, hooks, `lib/*`)
  - `hooks/`, `policy/`, `prompts/`, `schemas/`, `skills/`, `agents/`
  - `.claude-plugin/plugin.json`, `CHANGELOG.md`, `LICENSE`, `NOTICE`
- Marketplace points at `./plugins/codex-router` (`.claude-plugin/marketplace.json`).
- `plugins/codex/` exists only as a **gitignored** generated leftover (`.gitignore` line for `plugins/codex/`); it is not the product tree.
- Root `skills/codex-router/` + `.agy/plugin.json` provide AGY host packaging.

### Fixes
None.

---

## QNT-143 — Rename package, manifests, and user-facing commands from `codex` to `codex-router`

**Verdict: FIXED**

### Evidence
- Package name: `@compound/codex-router-plugin-cc` (`package.json`).
- Plugin/marketplace names: `codex-router` / displayName `Codex Router`.
- User-facing commands are `/codex-router:*` in README, command files, skill, and tests.
- Remaining “Codex” / “upstream” mentions are CLI binary names, provenance (`NOTICE`), or domain terms (intentional).

### Gap found
- App-server client identity still advertised as `"Codex Plugin"`.

### Fixes
- `plugins/codex-router/scripts/lib/app-server.mjs`: `DEFAULT_CLIENT_INFO.title` → `"Codex Router"`.

---

## QNT-144 — Repair app-server schema drift so the baseline build passes again

**Verdict: PASS**

### Evidence
- `npm run build` succeeds (prebuild regenerates types into `plugins/codex-router/.generated/app-server-types`, then `tsc -p tsconfig.app-server.json`).
- Grep over repo source for `@ts-ignore` / `@ts-expect-error` / `as any` around app-server protocol: **no matches**.
- `requestAttestation` is a real field on generated `InitializeCapabilities` and is set explicitly to `false` in `app-server.mjs` (typed `InitializeCapabilities`, not suppressed).
- `ThreadStartParams` is imported from generated types and narrowed in `app-server-protocol.d.ts` via `Omit<..., "persistExtendedHistory">` (schema-grounded).

### Protocol notes (out of scope / follow-up)
- Generated `ThreadStartParams` no longer includes `persistExtendedHistory` / `persistFullHistory`; the protocol wrapper already omits the legacy field. Fake fixture still guards experimental history flags for regression safety.
- No new hand-waved suppressions introduced.

### Fixes
None.

---

## QNT-145 — Reconcile AGY/Core API product claims with the assets that actually exist

**Verdict: FIXED**

### Audit of claims vs tree

| Claim (old CONTEXT.md) | Actual assets |
| --- | --- |
| Claude Code host adapter | Present: `plugins/codex-router/` commands, hooks, `codex-router:codex-rescue` agent |
| Antigravity host adapter | Present: `.agy/plugin.json` + `skills/codex-router/SKILL.md` calling companion runtime |
| Codex Router Core as host-independent contract | Present as companion runtime under `plugins/codex-router/scripts/` |
| Core API as “versioned host-facing JSON command contract” | **Overclaim.** No separate versioned JSON-RPC Core API package. Hosts call `codex-companion.mjs` CLI; structured I/O is `--json` stdout plus on-disk job/context-pack records |

### Decision (recorded in CONTEXT.md)
**Narrow the docs until a true Core API exists.** Do not invent a Core API package in this pass.

### Fixes
- `CONTEXT.md` (gitignored internal planning file): replaced **Core API** with **Companion Command Surface**; redefined **Codex Router Core** as the companion runtime; added explicit QNT-145 product-boundary decision.
- `README.md` (tracked): same host-contract narrowing so the decision is visible in git.

### Follow-up implementation (concrete, not implied)
1. If a host-facing Core API is still desired: design a versioned JSON command schema (methods, params, result envelopes) under something like `plugins/codex-router/schemas/core-api.v1.json`, implement a thin dispatcher over existing companion handlers, and add contract tests.
2. Until then, all adapters must keep calling `plugins/codex-router/scripts/codex-companion.mjs`.

---

## QNT-146 — Vendor canonical policy docs and define the context-pack contract

**Verdict: PASS**

### Evidence
- Policy SOT tracked at `plugins/codex-router/policy/Codex/` (`SKILL.md`, `Workflows/*`, `references/*`).
- Context-pack contract in `plugins/codex-router/scripts/lib/context-pack.mjs` (`version: 1`):
  - `mode`, `workflow`, `modifiers`, `userRequest`, `prompt`
  - `constraints`, `nonGoals`, `decision`
  - `policyHash` + per-file `policyFiles[].sha256`
  - persisted under workspace state `context-packs/<id>.json`
- Job-level evidence that policy drove routing:
  - Jobs store `contextPackId` and `policyHash` (`createCompanionJob` in `codex-companion.mjs`)
  - Runtime tests assert `contextPack.id` / `policyHash` on analyze/exec jobs (`tests/runtime-setup.test.mjs`, `tests/context-pack.test.mjs`)

### Fixes
None required for the contract itself; test assertions for job `write`/`contextPackId`/`policyHash` strengthened under QNT-150.

---

## QNT-147 — Implement `/codex-router:analyze` as the read-only routed turn mode

**Verdict: PASS**

### Evidence
- Command: `plugins/codex-router/commands/analyze.md` → `codex-companion.mjs analyze`.
- Runtime: `buildRouterRequest({ mode: "analyze" })` sets `sandbox: "read-only"`, `write: false`, `launchSurface: "appServerTurn"`, workflow `Analyze`.
- Path uses shared turn start (`runAppServerTurn`) with analyze context pack / non-goal “Do not edit files from analyze mode.”
- Tests: `tests/router.test.mjs` (“analyze is read-only app-server turn”), `tests/runtime-setup.test.mjs` (“analyze runs read-only with context-pack metadata”, job `write: false`).

### Fixes
None.

---

## QNT-148 — Implement `/codex-router:exec` as the only write-capable route

**Verdict: FIXED**

### Evidence
- Router modes: only `exec` sets `write: true` / `workspace-write` (`router.mjs`); analyze is read-only; review/task are not router modes.
- Command path: `/codex-router:exec` → `handleRouterTurn(..., "exec")`.
- Background/status/result/cancel/resume: shared tracked-job machinery used by exec/task; covered by runtime job/result tests.
- Boundary leaks checked:
  - **Rescue:** separate `task` path; subagent defaults to `task --write` for fix work (`agents/codex-rescue.md`). Not a silent leak of the analyze/exec router — intentional second path.
  - **CLI:** raw `codex` passthrough, documented escape hatch, not job-tracked write routing.

### Gap found
- Docs claimed exec was “the only V1 command that intentionally starts write-capable Codex work” while rescue defaults to `--write`. Criterion requires rescue/cli to be documented/gated, not ignored.

### Fixes
- `plugins/codex-router/commands/exec.md` and `README.md`: clarify exec is the only **policy-routed analyze/exec** write entrypoint; rescue is a separate gated `task --write` path; cli is raw escape hatch.
- Tests:
  - `tests/router.test.mjs`: assert non-exec modes cannot be write router modes.
  - `tests/runtime-setup.test.mjs`: assert `task` write defaults (`false` without `--write`, `true` with `--write`) and exec/analyze job write flags.

---

## QNT-149 — Implement `/codex-router:review` and fail clearly on unsupported directives

**Verdict: FIXED**

### Evidence (pre-fix gap)
- Review command is read-only (native `review/start` or adversarial turn with `sandbox: "read-only"`).
- `parseArgs` treated unknown flags as positionals, so `--docs` / `--search` / `--tool` / `--parallel` became focus text and silently promoted/ran review instead of failing.
- Reproduced via parse simulation: `--docs` → `positionals: ["--docs"]` focus `"--docs"`.

### Fixes
- `plugins/codex-router/scripts/codex-companion.mjs`: `rejectUnsupportedReviewDirectives()` fails explicitly for `--search|--docs|--tool|--parallel` on `review` and `adversarial-review`.
- Command docs + README document the rejection; `--search` remains on analyze/exec turn modes.
- Tests:
  - `tests/runtime-jobs.test.mjs`: review rejects each unsupported directive; adversarial-review rejects `--docs`.
  - `tests/commands.test.mjs`: review command text requires the directive prohibition.

### Command surface (v1 boundary)
- Review supports base/scope/wait/background/model controls; focus text promotes to adversarial-review; staged/unstaged scope rejected. Matches README + command files.

---

## QNT-150 — Expand tests and operational verification for router behavior

**Verdict: FIXED** (coverage already strong; gaps closed and suite green)

### Evidence
Router/behavior coverage present before this pass:
- Routing + safety: `tests/router.test.mjs`
- Context packs: `tests/context-pack.test.mjs`
- Model resolution: `tests/model-resolution.test.mjs`
- Command surface: `tests/commands.test.mjs`
- Jobs/status/result/cancel: `tests/runtime-jobs.test.mjs`, `tests/runtime-results.test.mjs`
- Analyze/exec/task runtime: `tests/runtime-setup.test.mjs`, `tests/runtime-task.test.mjs`
- Broker/hooks/state: `tests/runtime-hooks.test.mjs`, `tests/state.test.mjs`, `tests/broker-endpoint.test.mjs`
- AGY packaging: `tests/agy.test.mjs`

### Added in this pass
- Review unsupported-directive failures
- Stronger exec-only router-mode write assertions
- Task `--write` gating assertions
- Job-level `contextPackId` / `policyHash` / `write` assertions on analyze/exec

### Final suite
```text
npm run build  # exit 0
npm test       # 147 pass, 0 fail, duration ~43s
```
No hang observed; suite sets `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS=2000` for broker cleanup. Post-run check: no orphaned companion processes left by this verification.

### Fixes
Test + runtime changes listed under QNT-148/149 above.

---

## Working tree changes (uncommitted)

| Path | Why |
| --- | --- |
| `CONTEXT.md` | Narrow Core API claim; record QNT-145 decision |
| `README.md` | Write-boundary + review directive docs |
| `plugins/codex-router/scripts/lib/app-server.mjs` | Product identity title |
| `plugins/codex-router/scripts/codex-companion.mjs` | Reject unsupported review directives |
| `plugins/codex-router/commands/exec.md` | Write-boundary accuracy |
| `plugins/codex-router/commands/review.md` | Unsupported directives note |
| `plugins/codex-router/commands/adversarial-review.md` | Unsupported directives note |
| `tests/commands.test.mjs` | Doc/command assertions |
| `tests/router.test.mjs` | Exec-only write router modes |
| `tests/runtime-jobs.test.mjs` | Review directive rejection tests |
| `tests/runtime-setup.test.mjs` | Job write/context-pack + task write gating |
| `VERIFICATION-QNT.md` | This report |

---

## Summary

| Issue | Verdict |
| --- | --- |
| QNT-142 | PASS |
| QNT-143 | FIXED |
| QNT-144 | PASS |
| QNT-145 | FIXED |
| QNT-146 | PASS |
| QNT-147 | PASS |
| QNT-148 | FIXED |
| QNT-149 | FIXED |
| QNT-150 | FIXED |
