---
description: Run a policy-backed write-capable Codex execution job
argument-hint: '[--background] [--search] [--best|--spark|--model <model>] [--fast] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a Codex Router exec job through the shared runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- This is the only V1 command that intentionally starts write-capable Codex work.
- Keep all user prompt text inside the companion runtime arguments; do not reinterpret or implement it in Claude.
- The companion runtime records the selected policy, mode, modifiers, and model controls in a context pack.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" exec "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is.
