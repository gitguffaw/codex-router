---
description: Run a Codex Router code review against local git state
argument-hint: '[--background] [--base <ref>] [--scope auto|working-tree|branch] [--best|--spark|--model <selector>] [--service-tier <tier>|--fast] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Codex review through the shared built-in reviewer.
Native review does not accept focus text. If the user supplied focus instructions, stop and tell them to use `/codex-router:adversarial-review` instead of inventing a promotion.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.
- Do not pass `--search`, `--docs`, `--tool`, or `--parallel`. Those analyze/exec routing directives are unsupported on review and the companion runtime fails them explicitly.

Execution mode rules:
- Do not forward `--wait` to the companion. Foreground is the default. `--wait` is only valid on `/codex-router:status`.
- If `$ARGUMENTS` includes `--wait`, strip it before invoking the companion.
- If the raw arguments include `--background`, do not ask. Run the companion in the foreground so it can detach the tracked worker.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly, except strip `--wait`.
- Do not strip `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- Preserve `-c`/`--config`, `--enable`, and `--disable`; the companion runtime passes them to Codex.
- The companion runtime parses `--background`. `--background` enqueues a detached tracked worker the same way analyze and exec do.
- `/codex-router:review` uses native review and does not support staged-only review or unstaged-only review.
- Extra focus text is an error. Tell the user to run `/codex-router:adversarial-review` with that focus.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow (only when `--background` is present):

1. Run the same companion command in the foreground. It detaches the Codex worker and returns a launch stub containing the exact job id.
2. Extract that exact job id from stdout.
3. Launch the completion watcher as a Claude background Bash task:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" await-result "${jobId}"`,
  description: "Codex review completion",
  run_in_background: true
})
```

4. Do not call `BashOutput` or wait for the watcher. Return the original launch stdout verbatim.

The watcher emits one concise terminal-status notification. It does not inject the full Codex result; `/codex-router:result <job-id>` remains the full-output surface.
