---
description: Run a policy-backed read-only Codex analysis job
argument-hint: '[--background] [--search] [--best|--spark|--model <model>] [--fast] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]'
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

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" analyze "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is.
