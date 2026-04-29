# AnalyzeWeb

## KIND

- Modifier preset layered onto interactive `Analyze`, `Exec`, or `Parallel`.

## ENTER

- Codex itself must search the web.
- The answer depends on current external reality.
- Repo analysis or decision-making must be combined with live external research.

## AVOID

- Repo-only analysis is enough.
- The task is really documentation retrieval through inner Codex tooling: use `DocsMCP`.

## OPTIONAL CONTROLS

- `Model`
- `Reasoning`
- `Search` = required
- `Sandbox`

## DEFAULT LAUNCH

Interactive Codex with web search:

```bash
codex --search "<prompt>"
```

Interactive Codex with explicit model and reasoning:

```bash
codex --search -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' "<prompt>"
```

Resolve `<MODEL_ID>` from `codex debug models`. For speed, prefer `service_tier="fast"` on the strongest available model; choose mini/spark only when the user explicitly values fastest response, lower cost, or lightweight work over maximum capability. Do not assume `xhigh` support unless the live catalog confirms it.

`codex exec` does not support `--search`. If the primary mode is `Exec`, keep the mode but use interactive `codex --search`.

## PROMPT SHAPE

```text
Use web search.
Question: <what must be answered from current external sources>
Repo scope: <files/subsystem to compare against>
Return:
- current external facts
- relevant sources
- repo impact
- recommended next action
```

## EXIT

- Return current external facts tied back to the repo.
- Preserve the primary mode. `AnalyzeWeb` changes the launch surface, not the outcome mode.

## Examples

```bash
codex --search -m <MODEL_ID> -c 'service_tier="fast"' "Use web search. Question: What changed recently in the upstream auth API? Repo scope: auth client and refresh flow. Return: current external facts, relevant sources, repo impact, recommended next action."
```
