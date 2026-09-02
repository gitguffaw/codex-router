# Codex Router

Use Codex from Claude Code or Antigravity (`agy`) with policy-backed routing, model selection, code reviews, and delegated tasks.

Codex Router extends OpenAI's Codex plugin behavior with the `codex-router` command namespace for Claude Code and ships an AGY skill bundle for Antigravity. It preserves bundled Codex policy docs as the source of truth for mode selection, modifier behavior, model/reasoning/tier controls, and Codex-native tool boundaries.

Host adapters (Claude Code slash commands and the AGY skill) call the companion CLI at `plugins/codex-router/scripts/codex-companion.mjs`. Structured job and context-pack records are written on disk; there is no separate versioned host-facing JSON-RPC Core API beyond that companion surface and its `--json` outputs.

## What's New In 2.4.2

- Model controls now come from the installed Codex catalog instead of Router-maintained enums or pinned aliases. Newly advertised model slugs, effort levels, aliases, and service tiers work without a Router release.
- `--effort <level>` accepts the selected model's live advertised values, including `max`, `ultra`, and future levels. Router validates explicit catalog selections without silently lowering the request.
- `--service-tier <tier>` supports any additional tier advertised by the selected model. `--fast` remains a convenience alias for `--service-tier fast`.
- Short values passed to `--model`, such as `sol`, `terra`, and `spark`, resolve dynamically from the visible catalog. `--spark` is the compatibility shorthand for `--model spark`. `--best` selects the highest-priority visible model compatible with the requested effort and service tier.
- `/codex-router:models` now reports live effort descriptions, additional service tiers, dynamic aliases, and the effective default so users can choose controls from current runtime facts.
- The command guide now explains every first-class Router surface with examples, distinguishes tracked policy routes from the raw CLI escape hatch, and documents persistent model/effort configuration.
- Raw CLI help remains available for Codex flags that Router does not yet model, while Router-owned safety, permission, and lifecycle flags stay explicit.
- See [2.4.1](./plugins/codex-router/CHANGELOG.md#241) for detached rescue workers, exact-job watcher reconciliation, uncapped job retention, and background completion notifications.

See [CHANGELOG.md](./CHANGELOG.md) for public release history.

## Minimal Codex CLI Skill

If you want a capable Claude Code harness to drive the installed `codex` binary directly, install the separate `codex-cli` plugin from this marketplace:

```bash
/plugin marketplace add gitguffaw/codex-router
/plugin install codex-cli@codex-router
/reload-plugins
```

`codex-cli` contains one skill and no companion runtime, hooks, broker, background-job store, or MCP server. It teaches Claude Code to inspect the live Codex CLI, resolve models and reasoning levels, choose native `codex exec`/`codex review`/interactive surfaces, preserve read/write boundaries, continue sessions, and keep Codex-native tools inside Codex.

Do not install `codex-cli` beside `codex-router` if you want natural-language Codex requests to keep using Router job tracking, context packs, and status/result/cancel. Prefer `/codex-router:*`, or disable `codex-cli`, while the Router plugin is active. If both plugins are installed, the `codex-cli` skill defers to `codex-router` whenever that plugin is available or the user asks for Router-managed work.

Example of an explicit raw-CLI request:

```text
Use the raw Codex CLI with sol at xhigh effort to review the PR before submitting it.
Do not submit until Codex reports no blocking findings.
```

The skill deliberately does not provide Router-managed detached jobs, cross-session status/result/cancel records, orphan recovery, stop hooks, or cryptographic review receipts. Use the full `codex-router` plugin when those guarantees are required.

## Which Command Should I Use?

Codex Router provides several entrypoints because asking a question, changing code, reviewing a diff, and managing a long-running job have different safety and output requirements. The command names are less important than the boundary each command establishes:

- **Policy-backed** means Codex Router gives Codex explicit, versioned instructions about read/write permissions, model controls, tool routing, and expected output. For analyze and exec jobs, it records those choices in a context pack so the run can be inspected later.
- **Read-only** means Codex may inspect the repository and reason about it, but it must not edit files. Use a write-capable command only when you actually want a patch.
- **Tracked job** means the run gets a job ID, persisted status, logs, and stored output. You can inspect it with `status`, retrieve it with `result`, or stop it with `cancel`.
- **Foreground** means the command waits and returns the final Codex output. **Background** means it returns a tracked job ID immediately; the full output remains behind `/codex-router:result`. Automatic originating-session completion watchers are installed specifically for Claude Code `analyze` and `exec`. Other surfaces use their documented host behavior and `/codex-router:result`.

### Quick chooser

| What you want | Use | Can it edit files? | What you get |
| --- | --- | --- | --- |
| Understand code, diagnose a problem, research an option, or compare approaches | `/codex-router:analyze` | No | A prompt-directed explanation or recommendation, recorded as a Router job |
| Ask Codex to implement a clearly bounded change | `/codex-router:exec` | Yes | Repository edits plus Codex's implementation and verification summary |
| Check the current Git diff for concrete defects before shipping | `/codex-router:review` | No | A conventional code review with prioritized findings tied to the selected Git scope |
| Challenge whether the implementation or architecture is the right approach | `/codex-router:adversarial-review` | No | A steerable review of assumptions, tradeoffs, failure modes, and alternatives |
| Hand Codex a problem to investigate or fix, with an easy path to resume the same task later | `/codex-router:rescue` | Only for explicit fix work | A tracked, resumable Codex task managed through the rescue subagent |
| See which Codex models and reasoning levels are actually available on this machine | `/codex-router:models` | No | The live catalog, supported effort levels, aliases, additional service tiers, and effective default |
| Inspect, wait for, retrieve, or stop a tracked job | `/codex-router:status`, `/codex-router:result`, or `/codex-router:cancel` | `/codex-router:cancel` only stops work | Job state, complete stored output, or cancellation of the exact active job |
| Check whether Codex Router is installed and authenticated, or configure the optional review gate | `/codex-router:setup` | It may offer installation or configuration changes | A readiness report and guided remediation |
| Use a Codex CLI feature that Router does not expose directly | `/codex-router:cli` | Depends on the raw command | Unmodified Codex CLI stdout/stderr without Router job tracking or policy routing |
| Use the same Router runtime from Antigravity rather than Claude Code | Antigravity `codex-router` skill | Depends on the selected Router mode | The same tracked jobs and stored results through an AGY-native skill |

### Analyze: answer a question without changing anything

Use `analyze` when the deliverable is understanding: a diagnosis, explanation, comparison, research result, or implementation recommendation. Codex can read the repository and, when requested, use its own search, documentation, MCP, plugin, or parallel-agent capabilities. It cannot apply the recommendation.

```bash
/codex-router:analyze explain why token refresh sometimes races with logout
/codex-router:analyze --docs compare this SDK integration with the current upstream documentation
/codex-router:analyze --parallel compare three ways to remove this database bottleneck
```

Choose `review` instead when you already have a Git diff and want defects found in that diff. Choose `exec` when you want Codex to make the change.

### Exec: make a bounded repository change

Use `exec` when you can describe the desired change and want Codex to implement it directly. It is the policy-routed write surface: Codex receives workspace-write permission, edits the current checkout, and reports what it changed and how it verified the result.

```bash
/codex-router:exec fix the token-refresh race with the smallest safe change and run the focused tests
/codex-router:exec --docs update this integration to the current SDK API
/codex-router:exec --background implement the approved migration and run the repository checks
```

Choose `rescue` instead when the task is exploratory ("figure this out and fix it"), when you may want to resume the same Codex thread, or when you want the rescue subagent to manage the handoff. Choose `exec` when the scope and expected implementation are already clear.

### Review: find defects in the code that changed

Use `review` for a normal pre-ship code review. Codex selects the working tree or compares the current branch with `--base <ref>`, then looks for correctness, reliability, security, and regression issues. It reports findings but does not fix them.

```bash
/codex-router:review
/codex-router:review --base main
/codex-router:review --base main --background
```

This is different from `analyze`: review is anchored to a Git change set and is optimized for actionable defects. Analyze is anchored to a question and can examine broader architecture or external information.

### Adversarial review: challenge the approach, not only the lines

Use `adversarial-review` when a conventional defect pass is not enough. “Adversarial” means Codex actively tries to disprove the chosen approach: it questions assumptions, identifies failure modes, weighs alternatives, and follows the focus text you provide. It remains read-only.

```bash
/codex-router:adversarial-review --base main challenge whether this queue design survives retries and partial failure
/codex-router:adversarial-review --background focus on data loss, rollback, and race conditions
```

A focused `/codex-router:review` request is an error. Native Codex review does not accept custom focus instructions; use `adversarial-review` for that.

### Rescue: hand Codex ownership of a problem

Use `rescue` when you want to delegate the problem rather than prescribe a known edit. The rescue subagent forwards the task to a detached, tracked Codex worker and watches that exact job. Diagnosis-only requests stay read-only; explicit fix requests allow Codex to edit. Follow-up requests can resume the same Codex thread.

```bash
/codex-router:rescue investigate why CI fails only on Windows
/codex-router:rescue fix the Windows-only failure and verify the patch
/codex-router:rescue --resume apply the safer option from the previous investigation
/codex-router:rescue --background investigate the intermittent production timeout
```

If the watcher expires, the active worker continues. Keep the reported job ID and use `status` or `result`; do not start a duplicate rescue job.

### Models: inspect availability before choosing one

Use `models` when you need facts about the local Codex installation rather than a Codex task. It queries the live catalog and tells you which models are visible, which effort levels and additional service tiers they support, the catalog's current descriptions of those effort levels, what dynamic aliases such as `spark` resolve to, and which model Router will use by default.

```bash
/codex-router:models
/codex-router:models --all
/codex-router:models --json
```

It does not analyze code, start a tracked job, or change model configuration.

### Choose a model, reasoning effort, and service tier

Model selection answers **which Codex model runs**. Reasoning effort answers **how much reasoning depth that model is asked to use**. A service tier requests an additional runtime class such as lower-latency capacity. These controls are independent: `--fast` does not lower the effort level, and raising effort does not make a model write-capable.

The installed Codex runtime is the source of truth. Every `models` invocation reads `codex debug models`; Router does not keep a second model registry or a fixed list of effort levels and service tiers. Start by inspecting that live catalog:

```bash
/codex-router:models
```

Then select a model in one of four ways:

| Selection | Meaning |
| --- | --- |
| Omit model flags | Inherit the active Codex configuration. If no model is pinned, Codex uses its current default. |
| `--model <selector>` | Use an exact live slug or a short alias shown by `models`. Aliases are derived from the current visible catalog instead of pinned to a versioned slug. |
| `--best` | Select the highest-priority visible model that satisfies the requested effort and service tier. This is catalog priority, not a benchmark of model intelligence. |
| `--spark` | Compatibility shorthand for `--model spark`; the `spark` alias resolves from the current catalog. |

Exact slugs always win, including an explicitly requested hidden model. Router displays and resolves a short alias only when it identifies exactly one visible model; if multiple visible models claim the same alias, the command fails and asks for an exact slug instead of silently choosing one.

Choose at most one explicit model selector per command: `--model`, `--spark`, or `--best`. `--service-tier` and `--fast` are compatible modifiers and may be combined with that selector. Used without another model selector, a service-tier request triggers compatible catalog selection. If explicit selectors are combined, an explicit `--model` takes precedence over `--spark`, which takes precedence over catalog selection with `--best` or a requested service tier.

`--best`, `--spark`, `--service-tier`, and `--fast` are supported by `analyze`, `exec`, `review`, and `adversarial-review`. Rescue accepts `--model <selector>` and `--effort`, but it does not perform `--best` or service-tier catalog selection.

#### Effort levels are live data

Choose reasoning effort with `--effort <level>`, using a value shown for the selected model by `models`. Names such as `low`, `medium`, `high`, `xhigh`, `max`, and `ultra` are examples observed in current catalogs, not a Router-maintained allowlist. New levels work without a Router release as soon as the installed Codex catalog advertises them.

Higher effort usually takes longer and consumes more model usage. It does not grant more tools or broader file permissions. When Router selects or receives an explicit catalog model, it validates the requested effort against that live model entry and fails rather than silently lowering it. When the model is inherited from Codex configuration, Router forwards the effort unchanged and Codex validates it against the effective model.

#### Service tiers are live data

Use `--service-tier <tier>` with a tier shown by `models`. Router validates it against the selected model's live `additional_speed_tiers` entry. `--fast` remains a convenience alias for `--service-tier fast`; it is not the only tier Router can understand. Used without another model selector, a service-tier request chooses the highest-priority visible model that supports that tier. If no compatible model exists, the command stops instead of silently dropping the request.

Copyable per-run recipes:

```bash
# Let Router choose the highest-priority compatible visible model from the live catalog.
/codex-router:analyze --best --effort medium explain the caching failure

# Choose an exact live model or displayed alias and one of its advertised efforts.
/codex-router:exec --model <selector-from-models> --effort <level-from-models> fix the race and run the tests

# Request the best model that supports both xhigh effort and the fast tier.
/codex-router:review --best --effort xhigh --fast --base main

# Future service tiers require no Router code change when the catalog advertises them.
/codex-router:adversarial-review --best --service-tier <tier-from-models> --base main challenge the migration design

# Rescue accepts an exact model or live alias; it does not accept --best.
/codex-router:rescue --model spark --effort low investigate the flaky test
```

When you omit `--effort`, Codex inherits `model_reasoning_effort` from the active configuration or uses the selected model's default. A per-run `--effort` overrides that setting for this job. Likewise, `--model`/`--best`/`--spark` override the configured model for this job without rewriting `config.toml`.

To set persistent defaults instead of repeating flags, configure `model` and `model_reasoning_effort` in your user or trusted-project [Codex configuration](#common-configurations). Per-run Router flags take precedence over those defaults. High-level flags such as `--effort` and `--service-tier` also take precedence over conflicting values supplied through `-c`/`--config`.

#### How Router stays compatible with new Codex flags

Router-owned flags such as `--background`, `--best`, and `--write` remain explicit because they control Router policy, permissions, and job lifecycle. Codex-owned values are open-ended:

- `-c`/`--config <key=value>` forwards arbitrary Codex configuration keys without a Router allowlist.
- `--enable <feature>` and `--disable <feature>` forward feature names without a Router allowlist.
- `/codex-router:cli --help` and `/codex-router:cli <command> --help` inspect the installed CLI's current flags.
- `/codex-router:cli <codex args...>` exposes new raw Codex commands and flags before Router has first-class policy handling for them.

Router does not blindly attach unknown CLI flags to policy-backed jobs. Some Codex flags change transport, sandbox, approval, or authentication behavior, so automatic forwarding could violate the read/write boundary promised by `analyze`, `exec`, and `review`.

### Status, result, and cancel: manage an existing job

These commands do not create new Codex work. They operate on jobs created by analyze, exec, review, adversarial review, rescue, or the companion runtime.

```bash
/codex-router:status                         # list this session's jobs
/codex-router:status task-abc123             # inspect one exact job
/codex-router:status task-abc123 --wait      # wait for that job to finish
/codex-router:result task-abc123             # retrieve its complete stored output
/codex-router:cancel task-abc123             # stop that exact active job
```

Prefer the explicit job ID whenever more than one job may be running. `status` is the progress surface; `result` is the full-output surface; `cancel` is the termination surface.

### Setup: verify that Router can run Codex

Use `setup` for installation and configuration, not for repository work. It checks the local Codex binary, app-server support, authentication or custom-provider readiness, and the optional stop-time review gate. When Codex is missing and npm is available, it can offer to install it.

```bash
/codex-router:setup
/codex-router:setup --enable-review-gate
/codex-router:setup --disable-review-gate
```

Run it when another command reports that Codex is unavailable or unauthenticated. It does not analyze the repository or create a normal tracked job.

### CLI: pass an unmodeled command directly to Codex

Use `cli` as the raw Codex CLI escape hatch when no first-class Router command represents the Codex feature you need. Router passes the remaining arguments to the local `codex` binary and returns its output verbatim.

```bash
/codex-router:cli --help
/codex-router:cli app-server --help
/codex-router:cli doctor
/codex-router:cli features list
/codex-router:cli mcp list
/codex-router:cli cloud status <task-id>
```

Raw CLI calls do not receive Router's analyze/exec policy context and are not Router-tracked jobs. Do not use `cli` as a substitute for `analyze`, `exec`, `review`, or `rescue` merely because it is more general.

### Antigravity: use the same runtime from AGY

Antigravity does not use the Claude Code slash commands. Its `codex-router` skill teaches AGY to call the same companion runtime, preserve read/write boundaries, capture exact job IDs, and retrieve stored results.

```text
Use the codex-router skill to ask Codex for a read-only analysis of the cache design.
Use the codex-router skill to have Codex implement and verify the approved cache fix.
Use the codex-router skill to review this branch against main.
```

This is a host adapter, not a separate Codex runtime or MCP server. Jobs launched through AGY use the same on-disk Router job model as jobs launched through Claude Code.

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

Shows the live Codex model catalog for this machine, including each model's advertised effort levels and descriptions, additional service tiers, dynamic short aliases, and what the plugin will treat as the effective default model.

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
- the supported effort levels and live descriptions for each model
- every additional service tier advertised by each model
- confirmation that a default model pin is still valid
- current short alias targets such as `sol`, `mini`, or `spark`

### `/codex-router:analyze`

Runs a read-only Codex analysis job with the vendored Codex policy context recorded in a job context pack.

Foreground is the default. Use `--background` to detach the Codex worker. `--wait` is not an execution mode on analyze; use `/codex-router:status <job-id> --wait` to block on a job. A background analysis installs a session-scoped completion notifier; the notification contains the terminal status and `/codex-router:result <job-id>`, not the full result.

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

Foreground is the default. Use `--background` to detach the Codex worker. `--wait` is not an execution mode on exec; use `/codex-router:status <job-id> --wait` to block on a job. A background execution installs a session-scoped completion notifier; the notification contains the terminal status and `/codex-router:result <job-id>`, while the full output stays out of context until you request it.

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

Use `--base <ref>` for branch review. It also supports `--background`. By default it is not steerable. Focus text after the flags is an error; use [`/codex-router:adversarial-review`](#codex-routeradversarial-review) when you have focus instructions.

Examples:

```bash
/codex-router:review
/codex-router:review --base main
/codex-router:review --background
/codex-router:adversarial-review --background fact-check the runbooks against upstream repository behavior
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex-router:status`](#codex-routerstatus) to check on the progress and [`/codex-router:cancel`](#codex-routercancel) to cancel the ongoing task.

`--search`, `--docs`, `--tool`, and `--parallel` are not supported on review. The companion runtime rejects them explicitly; use [`/codex-router:analyze`](#codex-routeranalyze) or [`/codex-router:exec`](#codex-routerexec) for those Codex-native routing directives. `--search` remains supported on analyze/exec turn modes only.

### `/codex-router:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex-router:review`, including `--base <ref>` for branch review.
It also supports `--background`, and it is the canonical command for focus text after the flags. `/codex-router:review` with focus text errors instead of silently becoming this command.

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
> Depending on the task and model, rescue work may take a long time. Use `--background` when you want to keep working in Claude Code while its watcher waits for the detached Codex worker.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. `--background` and `--wait` are mutually exclusive. Rescue defaults to a foreground watcher, but its tracked Codex worker is detached from Bash. The watcher follows only the exact authorized job id and returns Codex's final output when the job finishes. If Bash or the subagent watcher expires first, the active worker continues; use `/codex-router:status <job-id>` and `/codex-router:result <job-id>` later. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex-router:rescue investigate why the tests started failing
/codex-router:rescue fix the failing test with the smallest safe patch
/codex-router:rescue --resume apply the top fix from the last run
/codex-router:rescue --model <selector-from-models> --effort <level-from-models> investigate the flaky integration test
/codex-router:rescue --model spark fix the issue quickly
/codex-router:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- aliases such as `spark` resolve from the live model catalog rather than a pinned versioned slug
- follow-up rescue requests can continue the latest Codex task in the repo

### `/codex-router:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex-router:status
/codex-router:status task-abc123
/codex-router:status task-abc123 --wait
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

`status <job-id> --wait` waits up to 30 minutes by default; pass `--timeout-ms <ms>` to choose a different bound. Claude Code background analyze/exec commands install a separate session-scoped watcher, so jobs that run beyond the 15-minute Stop-hook window can still notify the originating session without blocking unrelated turns.

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

Background analyze/exec work sends a concise completion notification automatically. Background rescue uses a host watcher around a detached tracked worker, and background review uses the host background task's completion event. In every case, use `/codex-router:result <job-id>` when you want the stored full output; an expired rescue watcher does not cancel its active worker.

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
