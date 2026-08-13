---
name: codex-cli
description: Drive the installed Codex CLI directly when the user explicitly wants the raw `codex` binary, the minimal `codex-cli` skill, or native CLI-only Codex work without Router job tracking. Do not use this skill when `codex-router` is installed or the user asks for `/codex-router:*`, managed jobs, status/result/cancel, context packs, or orphan recovery — defer to that plugin.
---

# Codex CLI

Operate Codex like a careful human CLI user. Let the installed `codex` binary own authentication, configuration, models, sessions, tools, plugins, and execution. Do not recreate those features in the outer harness.

## Prefer Codex Router When Present

If the `codex-router` plugin is installed in this session, or the user asks for `/codex-router:*`, Router-managed jobs, `/codex-router:status`, `/codex-router:result`, `/codex-router:cancel`, context packs, rescue, or orphan recovery, stop using this skill and follow `codex-router` instead. This skill is only for explicit raw-CLI work.

## Boundary

- Outer harness and inner Codex are separate agents and tool layers.
- Satisfy requests for Codex search, MCP, plugins, skills, browser, tools, or subagents inside Codex.
- Do not silently replace failed Codex work with outer-agent work.
- Do not claim durable background tracking, orphan recovery, or cross-session cancellation. This skill invokes native processes only.
- Preserve user changes and inspect the resulting diff before reporting success.

## Preflight

Probe only what the request needs:

```bash
codex --version
codex <command> --help
codex debug models
codex features list
codex mcp list
codex plugin list
```

If `codex` is unavailable, stop and report that fact. If authentication or configuration fails, run `codex doctor` and return its remediation; do not invent an alternate login flow.

Treat CLI help and the live model catalog as authoritative over this skill. Flag locations and available commands change over time.

## Resolve Models and Effort

Do not hardcode aliases. Read `codex debug models`, whose current output contains `.models[]` records with slugs, display names, visibility, supported reasoning levels, and speed tiers.

When the user names a model or shorthand such as `sol`, `terra`, `luna`, or `spark`:

1. Match it case-insensitively against the live slug and display name.
2. Require one visible match.
3. Verify the requested reasoning effort appears in `supported_reasoning_levels[].effort`.
4. Verify requested speed tiers appear in the model's advertised tiers.
5. Fail explicitly if a requirement is unavailable; do not silently downgrade.

When the user says `best` or `strongest`, choose the highest-priority visible model satisfying the requested effort and tier. When no model is requested, inherit Codex configuration instead of adding `-m`.

Build explicit controls before the subcommand:

```bash
codex -m <MODEL_SLUG> \
  -c 'model_reasoning_effort="<EFFORT>"' \
  -c 'service_tier="fast"' \
  <subcommand> ...
```

Include only controls the user requested or the task genuinely requires.

## Choose the Native Surface

| Intent | Native surface | Permission boundary |
| --- | --- | --- |
| Analyze, diagnose, research | `codex exec` | `-s read-only -a never` |
| Implement or modify files | `codex exec` | `-s workspace-write -a never` |
| Review changes | `codex review` | `-s read-only -a never` |
| Continue noninteractive work | `codex exec resume` | Preserve the original boundary |
| Search the web | Put global `--search` before `exec`, or use interactive Codex | Match analyze/write intent |
| Use Codex-native tools/plugins/MCP | Verify availability, then direct Codex in the prompt | Match analyze/write intent |
| Interactive steering or TUI-only behavior | Interactive `codex` in a real PTY | Choose explicitly |
| Unmodeled CLI functionality | Inspect help and invoke the native subcommand | Do not invent flags |

Use `-a never` for noninteractive runs so an inner process cannot hang waiting for approval. Sandbox denial should fail and return evidence. Never use `--dangerously-bypass-approvals-and-sandbox` unless the user explicitly requests it and the outer environment provides equivalent containment.

## Pass Prompts Safely

Prefer stdin so arbitrary prompt text is not interpolated into a shell command. Use a single-quoted, collision-resistant heredoc delimiter when the harness lacks a direct stdin channel.

Read-only analysis:

```bash
codex -m <MODEL_SLUG> \
  -c 'model_reasoning_effort="<EFFORT>"' \
  -s read-only -a never exec - <<'CODEX_PROMPT_7F3A'
<task and output contract>
CODEX_PROMPT_7F3A
```

Write-capable execution:

```bash
codex -m <MODEL_SLUG> \
  -c 'model_reasoning_effort="<EFFORT>"' \
  -s workspace-write -a never exec - <<'CODEX_PROMPT_7F3A'
<task, completion contract, verification, and scope constraints>
CODEX_PROMPT_7F3A
```

Omit `-m` and effort config when they were not selected explicitly.

## Review

Select exactly one native target:

```bash
codex -m <MODEL_SLUG> -c 'model_reasoning_effort="<EFFORT>"' \
  -s read-only -a never review --uncommitted

codex -m <MODEL_SLUG> -c 'model_reasoning_effort="<EFFORT>"' \
  -s read-only -a never review --base <BASE_BRANCH>

codex -m <MODEL_SLUG> -c 'model_reasoning_effort="<EFFORT>"' \
  -s read-only -a never review --commit <SHA>
```

Current Codex CLI versions reject a custom `[PROMPT]` when `--uncommitted`, `--base`, or `--commit` selects a native review target, despite showing `[PROMPT]` in the usage line. Do not append prompt text or `-` to those commands.

When the user needs custom focus and an explicit target, use read-only `codex exec` and state the exact Git diff command or commit range to inspect. Label that result as a prompt-directed review rather than native `codex review`. Do not ask Codex to edit during either review path.

### Review Before PR Submission

When the user says “review the PR before submitting”:

1. Inspect `git status --short`, the current branch, and configured remotes.
2. If a PR already exists and `gh` is available, read its base branch with `gh pr view --json baseRefName,headRefOid`.
3. Otherwise resolve the intended base from explicit user input, remote HEAD, or repository convention. Ask when the target remains ambiguous.
4. Require a clean working tree for the final PR review. Review uncommitted work separately before the final branch review.
5. Run `codex review --base <BASE>` with the requested live-resolved model and effort.
6. Do not submit when blocking findings, an incomplete review, or a failed Codex invocation remains.
7. If authorized, address confirmed findings through Codex implementation work.
8. Re-run the full review after every change.
9. Create or update the PR only after the final review reports no blocking findings.

This is an in-session workflow gate, not a cryptographic receipt. Say so if the user asks for enforcement across sessions or tools.

For the request “use Codex sol xhigh to review the PR before submitting,” first resolve `sol` from the live catalog, verify `xhigh`, then use the resolved slug in the final `review --base` command.

## Search and Inner Tools

Current CLI versions accept global `--search` before `exec`:

```bash
codex --search -s read-only -a never exec -
```

Check help before use. When the user requests a named Codex MCP server, plugin, skill, browser, or other tool:

1. Probe the relevant Codex surface.
2. Name the requested inner capability explicitly in the prompt.
3. Tell Codex to fail explicitly if the inner capability is unavailable.
4. Do not substitute a similarly named outer-harness tool.

For parallel work, ask inner Codex to use its own subagents or lanes and return one reconciled result. Do not simulate Codex parallelism with outer agents unless the user requested outer orchestration.

## Continue Work

Continue the latest session in the current workspace:

```bash
codex exec resume --last - <<'CODEX_PROMPT_7F3A'
<delta instruction only>
CODEX_PROMPT_7F3A
```

Prefer an explicit session ID when multiple runs are plausible:

```bash
codex exec resume <SESSION_ID> -
```

Pass a new model only when the user explicitly requests a model switch. Preserve the original task's permission intent; do not resume a read-only investigation as write-capable work implicitly.

## Output and Failure Handling

- Return Codex's conclusion, findings, changed files, verification, and residual risks without erasing uncertainty.
- For reviews, present findings before summaries and preserve severity order.
- After write work, inspect `git status` and `git diff`; run appropriate verification when Codex did not already provide trustworthy evidence.
- If Codex changed files, say so explicitly.
- If Codex fails, report the actionable CLI error and stop. Continue with the outer agent only when the user explicitly permits fallback.
- If a background shell is requested, use the outer harness's process facility and retain its handle. Do not describe that as durable Router job management.

## Hard Rules

- Do not invent commands, flags, models, effort levels, tools, or capabilities.
- Do not embed untrusted prompt text into shell arguments.
- Do not confuse outer and inner tool layers.
- Do not silently downgrade model, effort, tier, target, or permission intent.
- Do not run review as write-capable work.
- Do not submit a PR after changes without re-running the requested review gate.
- Do not claim guarantees the native CLI and outer harness do not provide.
