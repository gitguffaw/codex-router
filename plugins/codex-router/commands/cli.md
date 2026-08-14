---
description: Run an arbitrary Codex CLI command through the local Codex binary
argument-hint: '<codex args...>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a raw Codex CLI command through the shared companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Use this for Codex features that are not first-class `codex-router` commands, such as:
- `--help` and `<command> --help` to inspect the installed CLI's current flags
- `features list`
- `mcp list`
- `plugin list`
- `doctor`
- `cloud status <task-id>`
- `resume <session-id>`

Do not rely on a copied Router list of raw Codex flags. Use the installed CLI help so newly added commands and options are visible without a Router release.

Do not use this command for normal delegated analyze/exec/review/rescue work when a first-class `/codex-router:*` command exists.
Do not launch a bare interactive Codex TUI unless the user explicitly asks for it and understands it may not return cleanly through Claude Code's command runner.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cli "$ARGUMENTS"
```

Return stdout and stderr verbatim, exactly as-is.
