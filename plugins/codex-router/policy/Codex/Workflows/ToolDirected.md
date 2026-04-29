# ToolDirected

## KIND

- Modifier preset layered onto interactive `Analyze`, `Exec`, or `Parallel`.

## ENTER

- A named inner Codex MCP server, plugin, or tool must be used.
- The tool choice is part of the intent.
- Claude must direct inner Codex explicitly rather than substituting its own tools.

## AVOID

- Tool choice does not matter and repo-only analysis is enough.
- Findings only are needed and no interactive-only tool use is required.

## PREFLIGHT

- Resolve the capability class before launch: `mcp`, `bundled tool`, or `plugin/skill`.
- Run `codex mcp list` before assuming an MCP server exists.
- Check current config before assuming a bundled tool or plugin is enabled.
- If a specific plugin or bundled skill matters, prefer explicit `@plugin_or_skill` invocation.

## OPTIONAL CONTROLS

- `Model`
- `Reasoning`
- `Search`
- `Sandbox`

## DEFAULT LAUNCH

Interactive Codex:

```bash
codex "<prompt>"
```

Interactive Codex with explicit controls:

```bash
codex -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' --search "<prompt>"
codex -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' --search "<prompt>"
```

Resolve `<MODEL_ID>` from user intent, local config, or `codex debug models`; do not reuse stale historical model IDs.

Use `--search` only if Codex web search is also required.

## PROMPT SHAPE

```text
Capability: <mcp|bundled_tool|plugin_or_skill>:<NAME>
Goal: <what Codex must achieve>
Scope: <repo/page/system boundaries>
Return:
- what the tool found or did
- repo impact
- recommended next step
```

## EXIT

- Make tool use explicit in the result.
- Preserve the primary mode. `ToolDirected` changes the tool path, not the outcome mode.

## Examples

```bash
codex "Capability: mcp:playwright. First verify that the MCP server is available, then use it for this task. Goal: inspect the running app and identify the real UI failure. Scope: the local dev app and the files most likely involved. Return: what the tool found, repo impact, recommended next step."
```

```bash
codex "@<plugin_or_skill> Goal: perform the requested plugin-specific task and report the result, repo impact, and next step."
```
