# Analyze

## ENTER

- Repo-grounded unknowns remain.
- Root cause is unclear.
- Multiple implementation paths exist.

## AVOID

- The task is bounded and should produce a concrete result or diff: use `Exec`.
- The output should be findings only: use `Review`.
- Explicit multi-agent or round-robin work would improve the answer: use `Parallel`.

## MODIFIERS

- Add `WebSearch` if current external information must be gathered by Codex.
- Add `DocsMCP` if docs/specs should be pulled through inner Codex tooling.
- Add `ToolDirective` if a named inner MCP server, bundled tool, plugin, or skill must be used.
- Add `Model`, `Reasoning`, or `Sandbox` when they matter.

## DEFAULT LAUNCH

One-shot read-only pass:

```bash
codex exec -s read-only "<prompt>"
```

Interactive pass when steering or interactive-only modifiers matter:

```bash
codex -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' "<prompt>"
codex -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' "<prompt>"
```

Resolve `<MODEL_ID>` from user intent, local config, or `codex debug models`; do not reuse stale historical model IDs.

Use interactive `codex` instead of `codex exec` when `WebSearch`, `DocsMCP`, or `ToolDirective` is active.

## PROMPT SHAPE

```text
Question: <what must be answered>
Scope: <repo area, files, subsystem>
Output:
- facts
- options
- tradeoffs
- likely files
- recommendation
Next decision: <what Claude will do after Codex responds>
```

## EXIT

- Reduce uncertainty.
- Emit exactly one next mode:
  - `Exec`
  - `Review`
  - `Parallel`

## Examples

```bash
codex exec -s read-only "Question: Compare two plausible ways to add refresh-token rotation here. Scope: auth subsystem. Output: facts, options, tradeoffs, likely files, recommendation. Next decision: choose implementation path."
```

```bash
codex -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' "Question: Why could this caching bug occur in the current architecture? Scope: cache and request pipeline. Output: facts, likely causes, evidence to inspect, recommendation. Next decision: decide whether to patch or redesign."
```
