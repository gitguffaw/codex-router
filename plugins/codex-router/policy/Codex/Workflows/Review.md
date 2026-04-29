# Review

## ENTER

- Need findings, not edits.
- Review target is:
  - uncommitted changes
  - diff vs base branch
  - specific commit

## AVOID

- Same run should also implement fixes: use interactive Codex or `Exec`.
- Parallel concern-specific review would materially improve coverage: use `Parallel`.
- Search, docs retrieval, or inner tool use is required: use interactive `codex` and keep the output findings-only.

## OPTIONAL CONTROLS

- `Model`
- `Reasoning`

## DEFAULT LAUNCH

Current workspace:

```bash
codex review --uncommitted
```

Model and reasoning override:

```bash
codex -m <MODEL_ID> review --uncommitted
codex review -c 'model="<MODEL_ID>"' -c 'model_reasoning_effort="xhigh"' --uncommitted
codex review -c 'model="<MODEL_ID>"' -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' --uncommitted
```

Resolve `<MODEL_ID>` from user intent, local config, or `codex debug models`; do not reuse stale historical model IDs.

Focused review:

```bash
codex review --uncommitted "Focus on security, correctness, and missing error handling"
```

If interactive-only modifiers are required, use interactive `codex` and demand findings only.

## OUTPUT CONTRACT

- prioritized findings
- file paths
- concrete risk
- suggested fix direction

## POST

- Fix manually, or
- hand findings to `Exec`, or
- open interactive `codex` if one session should review then fix

## EXIT

- Findings accepted.
- Or re-route to `Parallel`.

## Examples

```bash
codex -m <MODEL_ID> review --uncommitted "Check for regressions, edge cases, and maintainability issues"
```

## Current Facts

- `codex review` is non-interactive.
- `codex review` accepts `-c`, but not `-m` after the subcommand.
- `codex review` supports `--uncommitted`, `--base`, `--commit`, and `--title`.
- `codex review` does not accept `--full-auto`.
- `codex review` does not accept `-o`.
