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

If the user needs to see which Codex models and reasoning levels are currently selectable, or setup warns about a stale model pin, inspect the live model catalog:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" models
```

## Command Mapping

For live model and effort discovery:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" models
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" models --all
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" models --json
```

Use `models` when:

- the user asks which Codex models are currently available
- the user wants to know which effort levels or `fast` tier options exist
- the user wants to confirm what `spark` resolves to
- setup warns that a configured default model pin is stale or unsupported

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

For a long-running delegated `analyze`, `exec`, or `task` job, use `--background` only when Antigravity can also keep a harness-tracked completion watcher alive:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" analyze --background "<prompt>"
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" exec --background "<prompt>"
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" task --background "<prompt>"
```

Capture the exact job id from the launch output, then start this as a host-managed background command (not an untracked shell `&` process):

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" await-result "<exact-job-id>"
```

The watcher emits one concise terminal-status notification and leaves full output behind the companion `result` command:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" result "<exact-job-id>"
```

If the current Antigravity harness cannot surface completion from a tracked background command, use `--wait` instead of detaching silently.

For job management:

```bash
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" status
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" result
node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" cancel
```

`--wait` and `--background` are mutually exclusive on `task`, `analyze`, `exec`, `review`, and `adversarial-review`. `task`, `analyze`, and `exec` default to foreground when neither flag is present.

Preserve user-supplied runtime controls and pass them through to the companion command:

- `--model <model>` or `--model spark`
- `--effort <none|minimal|low|medium|high|xhigh>`
- `-c` / `--config <key=value>`
- `--enable <feature>`
- `--disable <feature>`
- `--search`, `--docs`, `--tool <capability>`, and `--parallel` for `analyze` or `exec` only; `review` and `adversarial-review` reject these directives with an explicit error, so do not forward them there

Map `spark` to the companion runtime unchanged; it normalizes the model alias.

If the user asks to choose a model or effort but has not named one, run `models` first instead of guessing from stale docs or memory.

## Output Handling

Return Codex Router output as-is when it is a review, result, status table, or models report. Do not turn a failed or incomplete Codex run into an Antigravity-side implementation attempt.

For setup reports or setup/auth failure messages, preserve the substance of the output but translate Claude Code-specific follow-up commands into AGY-safe equivalents before showing them to the user. In particular:

- translate `/codex-router:models` to `node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" models`
- translate `/codex-router:setup --enable-review-gate` and `/codex-router:setup --disable-review-gate` to the matching `node "<codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs" setup ...` commands
- translate `/codex-router:status` and `/codex-router:result` to the matching companion `status` and `result` commands
- translate `!codex login` to `codex login`
- preserve any `codex login --device-auth` or `codex login --with-api-key` guidance when browser login is blocked

Do not invent new remediation steps beyond those translations.

If Codex Router reports review findings, present findings first and do not automatically fix them. Ask the user which findings, if any, they want addressed.

If Codex Router made edits, say so and report the touched files when the output provides them.
