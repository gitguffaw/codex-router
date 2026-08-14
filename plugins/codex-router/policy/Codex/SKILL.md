---
name: Codex
description: Drive local Codex CLI as Claude's inner coding and analysis agent, with explicit control over model selection, reasoning, web search, Codex-native MCP/plugin/tool use, bounded execution, review, and parallel sessions. Trigger when Claude should delegate to Codex instead of relying only on Claude's own tools.
---

# Codex

## Purpose

Use this skill to make Claude operate Codex the way a strong human operator would: pick the right outcome mode, choose the launch surface, set model and reasoning explicitly when needed, and direct inner Codex to use its own search, MCP, plugin, skill, and tool surfaces.

## Boundary

- Outer Claude and inner Codex are different tool layers.
- If the task says to use Codex search, Codex MCP, Codex plugins, Codex skills, Codex marketplace, or Codex-native tools, satisfy that inside the launched Codex session.
- Do not silently substitute Claude's own web tools or MCP tools when the request is explicitly about inner Codex capability.
- Use Claude's own tools only for maintaining this skill, validating local Codex state, or when inner Codex capability is unavailable and that fallback is explicitly acceptable.

## Last Verified

- Verified against `codex-cli 0.124.0`.
- Verified on `2026-04-24`.

## Last Observed Local State

- Configured model in `~/.codex/config.toml`: `gpt-5.5`
- Configured reasoning effort in `~/.codex/config.toml`: `xhigh`
- Configured service tier in `~/.codex/config.toml`: `fast`
- Observed listed model IDs from `codex debug models` on this machine:
  - `gpt-5.5`
  - `gpt-5.4`
  - `gpt-5.4-mini`
  - `gpt-5.3-codex`
  - `gpt-5.3-codex-spark`
  - `gpt-5.2`
- Observed inner tool surface on this machine:
  - `context7`
  - `playwright`
  - `figma`
  - `linear`
  - `cloudflare-api`
  - `computer-use`
- Treat these as machine-local observations, not universal Codex contract.

## Preflight

When model choice, reasoning, tool availability, docs source, or feature availability matters, probe current Codex state first.

- `codex --help`
- `codex <cmd> --help`
- `codex debug models`
- `codex mcp list`
- `codex features list`
- `~/.codex/config.toml`
- If `codex debug models` is unavailable, inspect `~/.codex/config.toml` and `~/.codex/models_cache.json` as fallback local state.
- For OpenAI/Codex docs work, prefer `openaiDeveloperDocs` if available. If not, prefer official OpenAI docs through Codex web search before falling back to third-party docs MCPs.

## Model Selection Policy

Do not encode a permanent default model in this skill. Codex model IDs, aliases, account access, service tiers, and reasoning support move over time.

- If the user names a model, use that model only after confirming it is currently available. If unavailable, say so and choose a nearby available model only when the user's intent is clear.
- If the user does not name a model, inherit the local Codex config/runtime default. This lets `~/.codex/config.toml`, profiles, and future Codex migrations do their job.
- If the user asks for the best, strongest, highest-thinking, or highest-speed Codex, resolve the model at launch time from `codex debug models` and `~/.codex/config.toml`; fall back to `~/.codex/models_cache.json` only when the CLI lacks the debug command.
- Choose the highest-priority visible model compatible with the user's requested service tier. When the user asks for the highest reasoning, use that selected model's deepest advertised effort. Do not invent a speed-tier ranking; the live catalog does not define one. Do not pin that choice in reusable guidance.
- Prefer the requested service tier on the highest-priority compatible model instead of assuming a mini/spark model is faster. Use mini/spark only when the user explicitly prioritizes a smaller or lightweight model.
- When overriding explicitly, use separate config overrides such as `-m <MODEL_ID> -c 'model_reasoning_effort="<EFFORT_FROM_LIVE_CATALOG>"' -c 'service_tier="<SERVICE_TIER_FROM_LIVE_CATALOG>"'`.

## Primary Modes

- `Analyze`: reduce uncertainty, compare options, inspect repo facts
- `Exec`: produce a change or deliverable
- `Review`: findings only, no edits
- `Parallel`: explicit multi-agent or round-robin work inside Codex

## Modifiers

Apply zero or more modifiers to the primary mode.

- `Model`: use `-m <MODEL_ID>` where supported after resolving the current model from user intent, config, or `codex debug models`. For `review`, use `codex -m <MODEL_ID> review ...` or `codex review -c 'model="<MODEL_ID>"' ...`.
- `Reasoning`: use `-c 'model_reasoning_effort="<EFFORT_FROM_LIVE_CATALOG>"'`. Do not maintain a fixed effort enum; choose and validate levels from `codex debug models` at launch time.
- `SpeedTier`: use `-c 'service_tier="<SERVICE_TIER_FROM_LIVE_CATALOG>"'` when the user requests a service tier and the current account/model advertises it.
- `WebSearch`: interactive `codex --search` only. `codex exec` does not support `--search`.
- `DocsMCP`: use inner Codex docs tooling. Prefer `openaiDeveloperDocs` for OpenAI/Codex topics when present. Use third-party docs MCPs such as `context7` for non-OpenAI docs.
- `ToolDirective`: resolve the inner capability class first: `mcp`, `bundled tool`, or `plugin/skill`. Name the resolved class explicitly in the prompt.
- `PluginSpecific`: when a specific plugin or bundled skill matters, prefer explicit `@plugin_or_skill` invocation. Plain-language requests are acceptable when Codex should choose the tool.
- `Sandbox`: use `-s <MODE>` or `--full-auto` where supported.
- `Approval`: use `-a <POLICY>` on interactive runs only.

## Launch Rule

Mode expresses outcome shape. Modifiers decide the actual launch surface.

- Use `codex exec` for bounded local execution when no interactive-only modifier is required.
- Use `codex review` for findings-only review when no interactive-only modifier is required.
- Use interactive `codex` when steering matters or when `WebSearch`, `DocsMCP`, `ToolDirective`, `PluginSpecific`, or explicit subagent prompting is required.
- Do not force `codex exec` or `codex review` if the requested Codex capability only exists in an interactive session.

## Router

- IF current external information must be gathered by Codex THEN primary mode `Analyze` plus `WebSearch`
- IF docs/specs must be retrieved through inner Codex tooling THEN primary mode `Analyze` or `Exec` plus `DocsMCP`
- IF a named inner MCP server, bundled tool, plugin, or skill must be used THEN keep the primary mode and add `ToolDirective`
- IF repo-grounded unknowns dominate THEN primary mode `Analyze`
- IF the task is bounded and should produce a result or diff THEN primary mode `Exec`
- IF output should be findings only THEN primary mode `Review`
- IF the task benefits from explicit subagents or round-robin challenge THEN primary mode `Parallel`

## Routing Bias

- Prefer interactive Codex whenever explicit model choice, explicit reasoning override, search, inner-tool direction, or subagent orchestration materially affects the result.
- Prefer `Exec` when the job is truly bounded and one-shot.
- Prefer `Review` for critique without edits.
- Prefer `Parallel` when Codex should act as a second brain with multiple lanes.
- Prefer Codex-native search/MCP/plugins over outer-Claude substitutes when the user wants Codex capability specifically.

## Claude Contract

- Specify the primary mode first.
- Add modifiers explicitly when they matter.
- Probe current Codex state before assuming models, MCP servers, plugins, or tools exist.
- Tell inner Codex which tool layer to use when specificity matters.
- Inspect the resulting diff, findings, or synthesis after Codex returns.
- Re-route if the task changes shape mid-stream.

## Hard Rules

- Do not invent flags or model IDs.
- Do not confuse outer Claude tools with inner Codex tools.
- Do not hide model, reasoning, search, or tool choices when they are part of the user's intent.
- Do not present machine-local observations as universal Codex contract.
- Do not pin historical model IDs in reusable examples unless the point is explicit reproducibility.
- Do not force `Exec` or `Review` when the task really needs an interactive Codex session.
- Do not use `Review` when the expectation is immediate implementation.
- Do not use `Parallel` unless the prompt explicitly asks Codex to spawn subagents.
- Do not claim support for any reasoning level unless the live catalog or verified local behavior supports it.

## Secondary Surfaces

- `codex cloud`: remote/offloaded execution, separate from the normal local delegation loop
- `codex mcp`: manage Codex MCP endpoints
- `codex marketplace`: manage Codex plugin marketplaces
- `codex mcp-server`: expose Codex itself as an MCP server

Keep these available, but use them intentionally.

## Mode Index

- `Analyze`: `Workflows/Analyze.md`
- `Exec`: `Workflows/Exec.md`
- `Review`: `Workflows/Review.md`
- `Parallel`: `Workflows/Parallel.md`

## Modifier Presets

- `WebSearch`: `Workflows/AnalyzeWeb.md`
- `DocsMCP`: `Workflows/AnalyzeDocs.md`
- `ToolDirective`: `Workflows/ToolDirected.md`

## Examples

**Example 1**
```text
Task: "Use Codex with the fastest suitable available model to search the web for the latest API changes, then compare them to this repo."
Route: Analyze + WebSearch
Controls: resolve current model + search + optional fast service tier
```

**Example 2**
```text
Task: "Use Codex and its own docs MCP to verify the current Codex docs, then recommend the best implementation path here."
Route: Analyze + DocsMCP
Controls: prefer openaiDeveloperDocs for OpenAI/Codex topics
```

**Example 3**
```text
Task: "Use Codex and its own Playwright tooling to inspect the running app and patch the bug."
Route: Exec + ToolDirective
Controls: interactive Codex; resolve capability class first
```

**Example 4**
```text
Task: "Implement this feature with Codex using the strongest available model, highest supported reasoning, and fast service tier."
Route: Exec
Controls: resolve current model + reasoning override + optional speed tier
```

**Example 5**
```text
Task: "Use Codex as a second brain to argue both sides of this architecture choice before we code."
Route: Parallel + optional WebSearch
Controls: multi-agent interactive session, optional search/model/effort
```

## References

- `references/QuickRef.md`
- `references/LaunchPatterns.md`
- `Workflows/*.md`
