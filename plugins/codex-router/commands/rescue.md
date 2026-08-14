---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <selector>] [--effort <level>] [-c|--config <key=value>] [--enable <feature>] [--disable <feature>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex-router:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex-router:codex-rescue"`), forwarding the raw user request as the prompt.
`codex-router:codex-rescue` is a subagent, not a skill — do not call `Skill(codex-router:codex-rescue)` (no such skill) or `Skill(codex-router:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
For foreground execution, the final user-visible response must be Codex's output verbatim. For background execution, the launch acknowledgement may be concise; when the subagent completion arrives, surface Codex's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes both `--background` and `--wait`, stop with an error and do not invoke the subagent.
- If the request includes `--background`, run the `codex-router:codex-rescue` subagent in the background.
- If the request includes `--wait`, run the `codex-router:codex-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` control only whether Claude Code runs the subagent in the background or foreground. Do not forward either flag to `task`, and do not treat them as part of the natural-language task text.
- The subagent must always invoke the internal `task --watch` mode. That mode launches a detached tracked worker, captures its exact job id, and watches only that authorized job.
- A Bash or subagent timeout ends only the watcher. It must never cancel, kill, or mark the detached Codex worker failed while the tracked job remains active.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- `-c`/`--config`, `--enable`, and `--disable` are Codex config controls. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --watch ...` and return that command's stdout as-is when the watcher reaches a terminal job state.
- Never let the subagent add `--background` to `task`; `--watch` owns the detached-worker lifecycle.
- Return the Codex companion stdout verbatim to the user when the watched job finishes.
- Do not paraphrase, summarize, rewrite, or add commentary before or after successful output.
- If the Bash watcher expires after printing `Codex rescue started as <job-id>`, report that exact id and `/codex-router:result <job-id>`; state that the active job was not cancelled. Do not start another job.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex-router:status`, fetch `/codex-router:result`, call `/codex-router:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. Preserve exact selectors and aliases such as `spark`; the runtime resolves them against the live catalog.
- Preserve `-c`/`--config`, `--enable`, and `--disable` when the user explicitly supplies them.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex-router:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.
