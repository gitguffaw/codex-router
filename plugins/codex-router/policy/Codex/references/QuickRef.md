# Codex CLI Quick Reference

LAST VERIFIED:
- `codex-cli 0.124.0`
- `2026-04-24`

PREFLIGHT:
- `codex --help`
- `codex <cmd> --help`
- `codex debug models`
- `codex mcp list`
- `codex features list`
- `~/.codex/config.toml`
- fallback only if needed: `~/.codex/models_cache.json`

LAST OBSERVED LOCAL DEFAULTS:
- `model = "gpt-5.5"`
- `model_reasoning_effort = "xhigh"`
- `service_tier = "fast"`

LAST OBSERVED LISTED MODEL IDS:
- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.3-codex`
- `gpt-5.3-codex-spark`
- `gpt-5.2`

MODEL / REASONING FACTS:
- `model_reasoning_effort` values come from each model's live `supported_reasoning_levels` entry
- reasoning levels are model-dependent and may be added without a Router release
- model availability, priority, aliases, and service tiers are account/runtime dependent
- `codex debug models` is the preferred source for the current model catalog
- use `~/.codex/models_cache.json` only as fallback local state when `codex debug models` is unavailable
- do not hard-code a permanent default model in this skill
- choose the highest-priority visible model compatible with the user's requested service tier
- when the user asks for the highest reasoning, use that selected model's deepest advertised effort
- do not invent a speed-tier ranking; the live catalog does not define one
- prefer a requested service tier on the highest-priority compatible model over assuming mini/spark is faster

TOP-LEVEL:
- `codex`
- `codex exec`
- `codex review`
- `codex apply`
- `codex resume`
- `codex fork`
- `codex cloud`
- `codex mcp`
- `codex marketplace`
- `codex mcp-server`
- `codex app`
- `codex app-server`
- `codex exec-server`
- `codex sandbox`
- `codex features`
- `codex completion`
- `codex debug`

INTERACTIVE FLAGS:
- `-m <MODEL_ID>`
- `-c 'model_reasoning_effort="<EFFORT_FROM_LIVE_CATALOG>"'`
- `-c 'service_tier="<SERVICE_TIER_FROM_LIVE_CATALOG>"'`
- `--search`
- `-s`, `--sandbox`
- `-a`, `--ask-for-approval`
- `--full-auto`
- `-C`, `--cd`
- `--add-dir`
- `--enable`, `--disable`
- `-p`, `--profile`
- `-i`, `--image`

EXEC FLAGS:
- `-m <MODEL_ID>`
- `-c 'model_reasoning_effort="<EFFORT_FROM_LIVE_CATALOG>"'`
- `-c 'service_tier="<SERVICE_TIER_FROM_LIVE_CATALOG>"'`
- `-s`, `--sandbox`
- `--full-auto`
- `-C`, `--cd`
- `--skip-git-repo-check`
- `--ephemeral`
- `--json`
- `-o`, `--output-last-message`
- `--output-schema`
- `--add-dir`
- `--enable`, `--disable`

EXEC FACTS:
- no `-a` / `--ask-for-approval`
- no `--search`
- `--full-auto` is available
- working directory flag is `-C` / `--cd`
- no `--path`

REVIEW FLAGS:
- `-c 'model="<MODEL_ID>"'`
- `-c 'model_reasoning_effort="<EFFORT_FROM_LIVE_CATALOG>"'`
- `-c 'service_tier="<SERVICE_TIER_FROM_LIVE_CATALOG>"'`
- `--uncommitted`
- `--base`
- `--commit`
- `--title`

REVIEW FACTS:
- model override patterns:
  - `codex -m <MODEL_ID> review ...`
  - `codex review -c 'model="<MODEL_ID>"' ...`
- no `-m` after the `review` subcommand
- no `--full-auto`
- no `-o`

DOCS / TOOL FACTS:
- Prefer `openaiDeveloperDocs` for OpenAI/Codex topics when configured
- Prefer official OpenAI docs through Codex web search when `openaiDeveloperDocs` is absent
- Use `context7` or another configured docs MCP for third-party docs
- Plugins can be invoked by plain-language request or explicit `@plugin_or_skill`

MARKETPLACE:

```bash
codex marketplace add <SOURCE>
```

MCP:

```bash
codex mcp list
codex mcp get <name>
codex mcp add <name> --url https://mcp.example.com/mcp
codex mcp remove <name>
codex mcp login <name>
codex mcp logout <name>
codex mcp-server
```

LAST OBSERVED INNER TOOL SURFACE:
- MCP servers: `context7`, `playwright`, `figma`, `linear`, `cloudflare-api`
- command-style tool endpoints: `computer-use`, `playwright`
- enabled plugin families in config: `github@openai-curated`, `linear@openai-curated`, `cloudflare@openai-curated`, `computer-use@openai-bundled`

SUBAGENT FACTS:
- OpenAI docs: subagents are enabled by default and only spawn when explicitly asked
- last observed local feature state: `multi_agent` is `stable`

CLOUD:

```bash
codex cloud
codex cloud exec --env <ENV_ID> "<task>"
codex cloud status <TASK_ID>
codex cloud diff <TASK_ID>
codex cloud apply <TASK_ID>
codex apply <TASK_ID>
```

CLOUD FACT:
- `codex cloud exec` requires `--env`

CONFIG:
- `~/.codex/config.toml`
- `codex debug models`
- `~/.codex/models_cache.json` is local cache state; prefer `codex debug models` when available
