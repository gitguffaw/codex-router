# Codex Router

Use Codex from Claude Code or Antigravity (`agy`) with policy-backed routing, model selection, code reviews, and delegated tasks.

Codex Router extends OpenAI's Codex plugin behavior with the `codex-router` command namespace for Claude Code and ships an AGY skill bundle for Antigravity. It preserves bundled Codex policy docs as the source of truth for mode selection, modifier behavior, model/reasoning/tier controls, and Codex-native tool boundaries.

Host adapters (Claude Code slash commands and the AGY skill) call the companion CLI at `plugins/codex-router/scripts/codex-companion.mjs`. Structured job and context-pack records are written on disk; there is no separate versioned host-facing JSON-RPC Core API beyond that companion surface and its `--json` outputs.

## What's New In 2.4.0

- `/codex-router:review` and `/codex-router:adversarial-review` now reject the analyze/exec routing directives (`--search`, `--docs`, `--tool`, `--parallel`) with an explicit error instead of silently treating them as focus text.
- The write boundary is documented and tested precisely: `exec` is the only policy-routed write-capable entrypoint, `rescue` writes only through its separate `task --write` path, and `cli` is a raw escape hatch outside job-tracked routing.
- Orphaned jobs reconcile everywhere: the stop-time review gate, `task --resume-last`, and session-end teardown now finalize dead-runtime orphans to failed instead of treating them as running.
- Session end tombstones its remaining active jobs instead of deleting them, so a not-yet-verifiable worker backs off at startup rather than resurrecting its job and continuing write-capable work after the session ended.
- Job start and progress writes are serialized on the state lock, closing races where a concurrent cancel could resurrect a job or a pruned index entry could discard a finished result.
- Windows gains real process-identity proof (`Win32_Process.CreationDate`), so teardown verifies a worker's identity immediately before terminating it — rather than signalling a process that merely reused its PID — and the worker-launch race on slow identity probes is closed. (The residual window between that check and signal delivery is inherent to signalling by PID and is minimized, not eliminated.)
- See [2.3.1](./plugins/codex-router/CHANGELOG.md#231) for the identity-checked SIGKILL escalation, bounded stop-gate, and broker-reaping work this builds on.

See [CHANGELOG.md](./CHANGELOG.md) for public release history.

## What You Get

- `/codex-router:analyze` for policy-backed read-only Codex analysis
- `/codex-router:exec` for policy-backed write-capable Codex execution
- `/codex-router:review` for a normal read-only Codex review
- `/codex-router:adversarial-review` for a steerable challenge review
- `/codex-router:models` for the live Codex model catalog, effort support, and effective default
- `/codex-router:rescue`, `/codex-router:status`, `/codex-router:result`, and `/codex-router:cancel` to delegate work and manage background jobs
- `/codex-router:cli` as a raw Codex CLI escape hatch for features that are not first-class router commands
- an Antigravity `codex-router` skill that calls the same companion runtime

## Requirements

- **A Codex-ready auth or provider setup.**
  - Most users use a ChatGPT subscription (incl. Free) or an OpenAI API key. Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
  - If your local Codex config points at a provider that does not require OpenAI authentication, Codex Router uses that same provider configuration instead of forcing ChatGPT or API-key login.
- **Node.js 18.18 or later**
- **One host surface, depending on how you want to use Codex Router**
  - **Claude Code with plugin support** for the slash-command plugin surface
  - **Antigravity CLI (`agy`)** for the AGY skill bundle

## Install In Claude Code

In Claude Code, add this repository as a plugin marketplace:

```bash
/plugin marketplace add gitguffaw/codex-router
```

Install the plugin:

```bash
/plugin install codex-router@codex-router
```

Reload plugins:

```bash
/reload-plugins
```

Check your local Codex setup:

```bash
/codex-router:setup
```

`/codex-router:setup` will tell you whether Codex is ready. It checks both that the local `codex` binary exists and that the installed Codex runtime has the app-server support this plugin requires. If Codex is missing and npm is available, it can offer to install or upgrade Codex for you.

Inspect the live model catalog and available reasoning levels:

```bash
/codex-router:models
```

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

If browser login is blocked, retry with:

```bash
!codex login --device-auth
!codex login --with-api-key
```

### Local Checkout

To test from a local checkout instead of GitHub:

```bash
git clone https://github.com/gitguffaw/codex-router.git
cd codex-router
```

Then, inside Claude Code:

```bash
/plugin marketplace add /path/to/codex-router
/plugin install codex-router@codex-router
/reload-plugins
/codex-router:setup
```

If you are upgrading an existing Claude Code install, rerun:

```bash
/plugin install codex-router@codex-router
/reload-plugins
```

## Install In Antigravity (`agy`)

Codex Router ships an Antigravity plugin bundle for users who want AGY to delegate work to Codex through the same companion runtime.

Clone the repo, then install the AGY bundle from the checkout:

```bash
git clone https://github.com/gitguffaw/codex-router.git
cd codex-router
agy plugin install ./.agy
```

The AGY bundle exposes a `codex-router` skill. That skill routes through:

```bash
node <codex-router-checkout>/plugins/codex-router/scripts/codex-companion.mjs
```

In AGY itself, prefer asking the `codex-router` skill to run setup or models for you. Use the raw companion commands below when you want to inspect the runtime directly from the shell. When AGY relays setup output, the skill translates Claude Code-specific follow-up commands into equivalent shell commands for you.

From the cloned `codex-router` checkout itself, run setup like this:

```bash
node "./plugins/codex-router/scripts/codex-companion.mjs" setup
```

When using the skill from a different project directory, set `CODEX_ROUTER_ROOT` to the cloned `codex-router` checkout so AGY can find the companion runtime:

```bash
export CODEX_ROUTER_ROOT=/path/to/codex-router
```

Then run setup from that external project directory:

```bash
node "$CODEX_ROUTER_ROOT/plugins/codex-router/scripts/codex-companion.mjs" setup
```

Inspect the live Codex model catalog before choosing a model or effort level:

```bash
node "$CODEX_ROUTER_ROOT/plugins/codex-router/scripts/codex-companion.mjs" models
```

If setup warns that a configured Codex model pin is stale for the current ChatGPT-backed session, use `models` to see the effective default, supported effort levels, `fast` tier availability, and the current `spark` target before delegating work.

To uninstall the AGY bundle:

```bash
agy plugin uninstall codex-router
```

If you are upgrading an existing AGY install from a local checkout, reinstall the bundle from the updated checkout so AGY picks up the new skill instructions:

```bash
agy plugin install ./.agy
```

The AGY bundle does not register a separate MCP server. It teaches AGY to call the existing Codex Router runtime, which already uses the local Codex CLI and app-server integration.

## Antigravity Quick Start

After installing the AGY bundle, open AGY in the project you want Codex to inspect and ask it to use the `codex-router` skill.

Example prompts:

```text
Use codex-router to show me which Codex models and effort levels are available here.
Use codex-router to review this repository with Codex.
Use codex-router to run that review in the background, then show me the latest status and result.
Use codex-router to ask Codex to investigate the failing test.
Use codex-router to run a read-only Codex analysis of the cache design.
Use codex-router to tell me whether setup is ready here, and if not, what exact shell command I should run next.
```

For work outside the `codex-router` checkout, keep `CODEX_ROUTER_ROOT` set so the skill can find the companion runtime.

## Claude Code Quick Start

After installing in Claude Code, you should see:

- the slash commands listed below
- the `codex-router:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex-router:models
/codex-router:review --background
/codex-router:status
/codex-router:result
```

For implementation work, hand a bounded task to Codex:

```bash
/codex-router:exec --background fix the failing test with the smallest safe change
/codex-router:status
/codex-router:result
```

## Usage

### `/codex-router:models`

Shows the live Codex model catalog for this machine, including which effort levels each model supports, whether the `fast` service tier is available, and what the plugin will treat as the effective default model.

Examples:

```bash
/codex-router:models
/codex-router:models --all
/codex-router:models --json
```

Effective default behavior:

- if no default model is pinned, Codex Router reports the current recommended live default
- if a pinned default model is unavailable in a ChatGPT-authenticated session, default-inheriting runs fall back to the live recommended default
- if a pinned default model is unavailable in a non-ChatGPT or custom-provider setup, Codex Router reports the configured pin and does not silently override it
- `--all` includes hidden catalog entries in addition to the normal visible model list

Use it when you want:

- the current list of selectable Codex models
- the supported effort levels for each model
- confirmation that a default model pin is still valid
- the `spark` alias target

### `/codex-router:analyze`

Runs a read-only Codex analysis job with the vendored Codex policy context recorded in a job context pack.

Examples:

```bash
/codex-router:analyze --best --effort xhigh --fast inspect the caching design
/codex-router:analyze --search compare this repository against the latest upstream docs
/codex-router:analyze --docs inspect the current React docs and compare them to this implementation
/codex-router:analyze --tool mcp:playwright inspect the running app behavior
/codex-router:analyze --parallel compare the main architecture options
```

`--search` is a prompt-level routing hint. Codex Router adds web-search instructions to the Codex prompt, but it does not run web search itself and does not pass a dedicated search flag through the Codex app server. Treat search-dependent output as best effort and ask Codex for sources when current external facts matter.

### `/codex-router:exec`

Runs a direct write-capable Codex execution job. Use this when you explicitly want Codex to make a bounded implementation change through the policy-routed `exec` mode. Read-only commands such as `/codex-router:analyze` and `/codex-router:review` do not edit files. `/codex-router:rescue` is a separate task path that defaults to `task --write` for fix work (and stays read-only when you ask for diagnosis-only). `/codex-router:cli` is a raw escape hatch and is not job-tracked write routing.

Examples:

```bash
/codex-router:exec --best --effort xhigh --fast fix the failing cache test
/codex-router:exec --background implement the smallest safe fix
/codex-router:exec --tool mcp:playwright fix the UI bug after inspecting the app
/codex-router:exec --docs update this integration against the current upstream SDK docs
```

### Codex-Native Modifiers

Codex Router keeps `--search`, `--docs`, `--tool <capability>`, and `--parallel` open as Codex-side routing directives.

These modifiers are passed into the Codex prompt with explicit instructions. They do not cause Claude to substitute its own web, docs, MCP, plugin, or subagent tools.

- `--search` asks inner Codex to use web search when current external facts matter.
- `--docs` asks inner Codex to use docs tooling such as `openaiDeveloperDocs` or configured docs MCPs.
- `--tool <capability>` names a specific inner Codex capability, such as `mcp:playwright`, `mcp:context7`, `bundled_tool:computer-use`, or `plugin_or_skill:<name>`.
- `--parallel` asks Codex to use subagents or multiple internal lanes when useful, then return one merged answer or implementation summary.

For Codex capabilities that are not naturally analyze/exec/review/rescue jobs, use [`/codex-router:cli`](#codex-routercli).

First-class Codex jobs also accept repeatable Codex config controls:

```bash
/codex-router:exec -c 'model_verbosity="high"' --enable multi_agent --disable memories fix the bug
```

Those values are passed to `codex app-server` as `-c <key=value>` before the run starts. High-level router flags such as `--effort` and `--fast` still work and intentionally win if they set the same config key.

### `/codex-router:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. By default it is not steerable. If you add focus text after the flags, the runtime promotes the request to [`/codex-router:adversarial-review`](#codex-routeradversarial-review) so the focus instructions are honored.

Examples:

```bash
/codex-router:review
/codex-router:review --base main
/codex-router:review --background
/codex-router:review --background fact-check the runbooks against upstream repository behavior
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex-router:status`](#codex-routerstatus) to check on the progress and [`/codex-router:cancel`](#codex-routercancel) to cancel the ongoing task.

`--search`, `--docs`, `--tool`, and `--parallel` are not supported on review. The companion runtime rejects them explicitly; use [`/codex-router:analyze`](#codex-routeranalyze) or [`/codex-router:exec`](#codex-routerexec) for those Codex-native routing directives. `--search` remains supported on analyze/exec turn modes only.

### `/codex-router:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex-router:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`, and it is the canonical command for focus text after the flags. `/codex-router:review` with focus text is promoted to this same path.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex-router:adversarial-review
/codex-router:adversarial-review --base main challenge whether this was the right caching and retry design
/codex-router:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex-router:rescue`

Hands a task to Codex through the `codex-router:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex-router:rescue investigate why the tests started failing
/codex-router:rescue fix the failing test with the smallest safe patch
/codex-router:rescue --resume apply the top fix from the last run
/codex-router:rescue --best --effort medium investigate the flaky integration test
/codex-router:rescue --model spark fix the issue quickly
/codex-router:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

### `/codex-router:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex-router:status
/codex-router:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex-router:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex-router:result
/codex-router:result task-abc123
```

### `/codex-router:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex-router:cancel
/codex-router:cancel task-abc123
```

### `/codex-router:cli`

Runs an arbitrary Codex CLI command through the local `codex` binary.

Use this as the escape hatch for Codex surfaces that do not have a first-class router command yet:

```bash
/codex-router:cli features list
/codex-router:cli mcp list
/codex-router:cli plugin list
/codex-router:cli doctor
/codex-router:cli cloud status <task-id>
/codex-router:cli resume <session-id>
```

For normal delegated work, prefer `/codex-router:analyze`, `/codex-router:exec`, `/codex-router:review`, `/codex-router:adversarial-review`, or `/codex-router:rescue` because those commands preserve job tracking, cancellation, context packs, and result rendering.

### `/codex-router:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex-router:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex-router:setup --enable-review-gate
/codex-router:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex-router:review
```

### Hand A Problem To Codex

```bash
/codex-router:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex-router:adversarial-review --background
/codex-router:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex-router:status
/codex-router:result
```

## Codex Integration

Codex Router wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. Pick the model slug from the current live `/codex-router:models` report rather than hard-coding a historical example. For example, to pin the current preferred model from your live catalog on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "<pick a current slug from /codex-router:models>"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [review gate](#enabling-review-gate) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex-router:result` or `/codex-router:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, the default OpenAI-backed path is to sign in with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in.

If your local Codex setup already points at a provider that does not require OpenAI authentication, Codex Router uses that same provider configuration and `/codex-router:setup` can still report ready without `codex login`.

Run `/codex-router:setup` to check whether Codex is ready, and use `!codex login` only when setup says the active Codex path still needs OpenAI authentication. If browser login is blocked, use `!codex login --device-auth` or `!codex login --with-api-key`.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

## License and Attribution

Codex Router is licensed under the [Apache License 2.0](./LICENSE).

This repository includes code derived from OpenAI's `codex-plugin-cc` runtime and preserves the required OpenAI attribution in [NOTICE](./NOTICE) and [plugins/codex-router/NOTICE](./plugins/codex-router/NOTICE).

Codex Router is an independent project and is not affiliated with OpenAI or Anthropic. OpenAI, Codex, Anthropic, Claude, and Claude Code are trademarks of their respective owners.
