---
name: codex-router
description: Delegate Antigravity work to Codex through the codex-router companion runtime
---

# Codex Router for Antigravity

Use this skill when the user asks Antigravity to hand work to Codex, run a Codex review, ask Codex for analysis, or manage a delegated Codex job through `codex-router`.

## Runtime Contract

Do not run the raw `codex` CLI for delegated work unless the user explicitly asks for the raw CLI. Route through the codex-router companion runtime so jobs keep the same context packs, app-server transport, status/result tracking, cancellation, and review rendering as the Claude Code plugin.

The runtime entrypoint is:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" <command> [arguments...]
```

Find `<codex-router-checkout>` in this order:

1. If `CODEX_ROUTER_ROOT` is set, use it.
2. If the current workspace contains `plugins/codex-router/scripts/codex-companion.mjs`, use the current workspace root.
3. Otherwise, search upward from the current directory for `plugins/codex-router/scripts/codex-companion.mjs`.
4. If no checkout can be found, ask the user to set `CODEX_ROUTER_ROOT` to their cloned `codex-router` repository path.

Before the first delegated run in a new environment, check setup:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" setup
```

If setup reports that Codex is missing or unauthenticated, stop and ask the user to follow the reported setup step. Do not invent alternate authentication flows.

## Command Mapping

For read-only analysis:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" analyze "<prompt>"
```

For write-capable implementation work:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" exec "<prompt>"
```

For a standard review of the current repository:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" review
```

For a steerable challenge review:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" adversarial-review "<focus>"
```

For a long-running delegated task, prefer `task --background`:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" task --background "<prompt>"
```

For job management:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" status
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" result
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" cancel
```

Preserve user-supplied runtime controls and pass them through to the companion command:

- `--model <model>` or `--model spark`
- `--effort <none|minimal|low|medium|high|xhigh>`
- `-c` / `--config <key=value>`
- `--enable <feature>`
- `--disable <feature>`
- `--search`, `--docs`, `--tool <capability>`, and `--parallel` for `analyze` or `exec`

Map `spark` to the companion runtime unchanged; it normalizes the model alias.

## Output Handling

Return Codex Router output as-is when it is a review, result, status table, setup report, or failure message. Do not turn a failed or incomplete Codex run into an Antigravity-side implementation attempt.

If Codex Router reports review findings, present findings first and do not automatically fix them. Ask the user which findings, if any, they want addressed.

If Codex Router made edits, say so and report the touched files when the output provides them.
