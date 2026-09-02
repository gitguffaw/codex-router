---
description: Run a policy-backed read-only Codex analysis job
argument-hint: '[--background] [--search] [--docs] [--tool <capability>] [--parallel] [--best|--spark|--model <selector>] [--service-tier <tier>|--fast] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>] [prompt]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a Codex Router analyze job through the shared runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- This command is read-only.
- Do not edit files, apply patches, or fix issues yourself.
- The companion runtime records the selected policy, mode, modifiers, and model controls in a context pack.
- `--search`, `--docs`, `--tool`, and `--parallel` are Codex-side routing directives. Preserve them exactly; the companion runtime turns them into explicit inner-Codex instructions.
- `-c`/`--config`, `--enable`, and `--disable` are Codex config controls. Preserve them exactly.
- Do not forward `--wait` to the companion. Foreground is the default. `--wait` is only valid on `/codex-router:status`.
- If `$ARGUMENTS` includes `--wait`, strip it before invoking the companion.

Foreground flow (the default):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" analyze "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is.

Background flow (only when `--background` is present):

1. Run the same companion command in the foreground. It detaches the Codex worker and returns a launch stub containing the exact job id.
2. Extract that exact job id from stdout.
3. Launch the completion watcher as a Claude background Bash task:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" await-result "${jobId}"`,
  description: "Codex analysis completion",
  run_in_background: true
})
```

4. Do not call `BashOutput` or wait for the watcher. Return the original launch stdout verbatim.

The watcher emits one concise terminal-status notification. It does not inject the full Codex result; `/codex-router:result <job-id>` remains the full-output surface.
