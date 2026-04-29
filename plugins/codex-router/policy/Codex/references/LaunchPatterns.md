# Codex Launch Patterns

Use these patterns when Claude should drive inner Codex with explicit controls.

## Preflight

```bash
codex --help
codex <cmd> --help
codex debug models
codex mcp list
codex features list
```

Probe current state before assuming models, MCP servers, plugins, or subagent behavior. If `codex debug models` is unavailable, use `~/.codex/config.toml` and `~/.codex/models_cache.json` as fallback local state.

## Model Resolution

Do not preserve a static default model in reusable launch patterns. Resolve model intent at launch time.

```bash
codex debug models
```

Use the local config/runtime default when the user does not care which model runs. When the user asks for "best", "highest think", or "highest speed", choose the strongest currently available listed model that supports the highest requested reasoning effort and, for speed, prefer `service_tier="fast"` on that model.

```bash
codex -m <MODEL_ID> -c 'model_reasoning_effort="<EFFORT>"' -c 'service_tier="fast"' "<prompt>"
```

Use mini/spark models only when the user explicitly prioritizes fastest response, lower cost, or lightweight work over maximum capability.

## Interactive Second Brain

```bash
codex "<prompt>"
codex -m <MODEL_ID> "<prompt>"
codex -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' "<prompt>"
codex -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' "<prompt>"
```

Use when steering matters or when model/effort choice is part of the task.

## Web Research Through Codex

```bash
codex --search "<prompt>"
codex --search -m <MODEL_ID> "<prompt>"
codex --search -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' "<prompt>"
```

Use when Codex itself must search the web.

## Docs Through Inner Codex Tooling

```bash
codex "First verify whether openaiDeveloperDocs is configured. If the topic is OpenAI/Codex and that MCP is available, use it. Otherwise use official OpenAI docs via web search. Then inspect the current docs for <TOPIC> and analyze this repository."
codex "Use your configured context7 MCP server to inspect the current docs for <THIRD_PARTY_TOPIC>, then analyze this repository."
```

Use when the docs retrieval should happen inside Codex, not Claude. Prefer `openaiDeveloperDocs` for OpenAI/Codex topics when available.

## Tool-Directed Codex

```bash
codex "Capability: mcp:playwright. First verify that the MCP server is available, then use it for this task. Goal: inspect the running app and identify the real UI failure."
codex "Capability: bundled_tool:computer-use. First verify that the tool is available, then use it for this task. Goal: navigate the desktop app and report the exact failing interaction."
codex "@<plugin_or_skill> <goal>"
```

Name the inner capability explicitly. Use plain-language requests when Codex should choose the installed tool. Use `@...` when a specific plugin or bundled skill matters.

## Bounded Execution

```bash
codex exec --full-auto "<prompt>"
codex exec -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' --full-auto "<prompt>"
```

Use when the task is concrete and should complete non-interactively.

## Findings-Only Review

```bash
codex review --uncommitted
codex -m <MODEL_ID> review --uncommitted "Focus on regressions, edge cases, and maintainability"
codex review -c 'model="<MODEL_ID>"' -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' --uncommitted "Focus on regressions, edge cases, and maintainability"
```

Use when critique is wanted without edits.

## Parallel Second Brain

```bash
codex "Use multiple agents. Task: <goal> ..."
codex --search -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' "Use multiple agents for a round-robin discussion. Task: <goal> ..."
```

Use when Codex should split work into concurrent lanes or debate roles. Codex only spawns subagents when explicitly asked.
