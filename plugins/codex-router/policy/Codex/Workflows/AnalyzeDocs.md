# AnalyzeDocs

## KIND

- Modifier preset layered onto interactive `Analyze` or `Exec`.

## ENTER

- Inner Codex should retrieve docs/specs through its own MCP/tool surface.
- The docs source matters as much as the repo analysis.
- Claude must not substitute its own docs tool layer.

## AVOID

- General web search is the primary need: use `WebSearch`.
- No explicit docs tool is needed.
- A non-docs named tool dominates: use `ToolDirective`.

## PREFLIGHT

- Run `codex mcp list` before assuming a docs MCP exists.
- For OpenAI/Codex topics, prefer `openaiDeveloperDocs` when available.
- If `openaiDeveloperDocs` is unavailable, prefer official OpenAI docs through Codex web search before third-party docs MCPs.
- Use `context7` or another configured docs MCP for third-party libraries and frameworks.

## OPTIONAL CONTROLS

- `Model`
- `Reasoning`
- `InnerTool`

## DEFAULT LAUNCH

Interactive Codex with prompt-directed inner tool use:

```bash
codex "<prompt>"
```

Interactive Codex with explicit model and reasoning:

```bash
codex -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' "<prompt>"
codex -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' "<prompt>"
```

Resolve `<MODEL_ID>` from user intent, local config, or `codex debug models`; do not reuse stale historical model IDs.

## PROMPT SHAPE

```text
First confirm which docs source you are using.
If the topic is OpenAI/Codex and openaiDeveloperDocs is available, use it.
Otherwise use official OpenAI docs via web search or the configured third-party docs MCP.
Then inspect the current docs/spec for <TOPIC>.
Then analyze this repository.
Return:
- current docs facts
- relevant constraints
- repo impact
- recommended next action
```

## EXIT

- Return docs-grounded analysis tied to the repo.
- Preserve the primary mode. `AnalyzeDocs` changes the docs source, not the outcome mode.

## Examples

```bash
codex -m <MODEL_ID> "First verify whether openaiDeveloperDocs is configured. If the topic is OpenAI/Codex and that MCP is available, use it. Otherwise use official OpenAI docs via web search. Then analyze this repository. Return: current docs facts, relevant constraints, repo impact, recommended next action."
```
