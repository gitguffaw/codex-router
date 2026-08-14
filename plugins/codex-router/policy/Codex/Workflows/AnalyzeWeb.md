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
codex --search -m <MODEL_ID> -c 'model_reasoning_effort="<EFFORT_FROM_LIVE_CATALOG>"' -c 'service_tier="<SERVICE_TIER_FROM_LIVE_CATALOG>"' "<prompt>"
```

Resolve `<MODEL_ID>`, `<EFFORT_FROM_LIVE_CATALOG>`, and `<SERVICE_TIER_FROM_LIVE_CATALOG>` from `codex debug models`. Choose the highest-priority visible model compatible with the user's requested service tier. When the user asks for the highest reasoning, use that selected model's deepest advertised effort. Do not invent a speed-tier ranking; the live catalog does not define one. Choose mini/spark only when the user explicitly values a smaller or lightweight model. Do not assume support for any effort or service tier unless the live catalog confirms it.

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
codex --search -m <MODEL_ID> -c 'service_tier="<SERVICE_TIER_FROM_LIVE_CATALOG>"' "Use web search. Question: What changed recently in the upstream auth API? Repo scope: auth client and refresh flow. Return: current external facts, relevant sources, repo impact, recommended next action."
```
