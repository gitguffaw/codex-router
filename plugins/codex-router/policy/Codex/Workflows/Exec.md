# Exec

## ENTER

- Deliverable is concrete.
- Task is bounded.
- Acceptance criteria are known.
- Claude can inspect the result after execution.

## AVOID

- Unknowns still dominate: use `Analyze`.
- Only a review report is needed: use `Review`.
- Explicit multi-agent or round-robin work would improve coverage or speed: use `Parallel`.

## MODIFIERS

- `Model`
- `Reasoning`
- `Sandbox`
- `WebSearch`
- `DocsMCP`
- `ToolDirective`
- `PluginSpecific`

## DEFAULT LAUNCH

Write-capable bounded run:

```bash
codex exec --full-auto "<prompt>"
```

Model and reasoning override:

```bash
codex exec -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' --full-auto "<prompt>"
codex exec -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' --full-auto "<prompt>"
```

Resolve `<MODEL_ID>` from user intent, local config, or `codex debug models`; do not reuse stale historical model IDs.

Interactive deliverable when search or inner tool use is required:

```bash
codex --search -m <MODEL_ID> -c 'service_tier="fast"' "<prompt>"
```

Use interactive `codex` instead of `codex exec` when `WebSearch`, `DocsMCP`, `ToolDirective`, or `PluginSpecific` is active.

## PROMPT SHAPE

```text
Goal: <required change>
Scope: <files/directories/subsystem>
Constraints:
- <constraint>
- <constraint>
Validation:
- <test/lint/typecheck/manual check>
Non-goals:
- <explicitly excluded work>
```

## POST

- Read Codex final message.
- Inspect `git status`.
- Inspect `git diff`.
- Run requested validation locally if Codex did not.

## EXIT

- Accepted diff/result.
- Or re-route to:
  - `Analyze`
  - `Review`
  - `Parallel`

## Examples

```bash
codex exec -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' --full-auto "Goal: Add input validation to src/forms/Register.tsx. Scope: registration form only. Constraints: keep public API unchanged. Validation: pnpm test, pnpm lint. Non-goals: redesign form UX."
```

## Current Facts

- `codex exec` does not accept `-a` / `--ask-for-approval`.
- `codex exec` does not accept `--search`.
- `-C` / `--cd` is the working-directory flag.
- `--path` is not supported.
