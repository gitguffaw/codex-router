---
description: Run a policy-backed write-capable Codex execution job
argument-hint: '[--background] [--search] [--docs] [--tool <capability>] [--parallel] [--best|--spark|--model <model>] [--fast] [--effort <none|minimal|low|medium|high|xhigh>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>] [prompt]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a Codex Router exec job through the shared runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- This is the only policy-routed analyze/exec write-capable entrypoint (`mode=exec`, sandbox workspace-write).
- `/codex-router:rescue` is a separate task path: it may write only when the rescue subagent forwards `task --write` (default for fix work; read-only when the user asks for diagnosis-only).
- `/codex-router:cli` is a raw Codex CLI escape hatch and is not job-tracked write routing.
- Keep all user prompt text inside the companion runtime arguments; do not reinterpret or implement it in Claude.
- The companion runtime records the selected policy, mode, modifiers, and model controls in a context pack.
- `--search`, `--docs`, `--tool`, and `--parallel` are Codex-side routing directives. Preserve them exactly; the companion runtime turns them into explicit inner-Codex instructions.
- `-c`/`--config`, `--enable`, and `--disable` are Codex config controls. Preserve them exactly.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" exec "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is.
