---
title: Claude Code Installation and User Experience
status: proposed
date: 2026-07-11
---

# Claude Code Installation and User Experience

## Goal

A Claude Code user installs one plugin and can then ask Claude naturally to use Codex capabilities. MCP is the tool transport beneath the experience; it is not vocabulary the user must normally understand.

The canonical example is:

> Use Codex sol at xhigh effort to review the PR before submitting it. Do not submit until Codex reports no blocking findings.

## Plugin package

```text
codex-router/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json
├── skills/
│   ├── codex/
│   │   └── SKILL.md
│   ├── review/
│   │   └── SKILL.md
│   └── pr-gate/
│       └── SKILL.md
├── hooks/
│   └── hooks.json
├── bin/
│   └── codex-router
└── README.md
```

The components have narrow responsibilities:

- `.claude-plugin/plugin.json`: identity, version, and distribution metadata.
- `.mcp.json`: starts the plugin-provided Router MCP server.
- `skills/codex`: teaches Claude when the user is requesting Codex generally.
- `skills/review`: maps review language into the typed review capability.
- `skills/pr-gate`: defines review-before-submit behavior and failure handling.
- `hooks/hooks.json`: optionally enforces durable project gates before PR creation.
- `bin/codex-router`: signed launcher for the local gateway/supervisor.

Claude Code plugins support bundled skills, agents, hooks, MCP servers, and executables. Plugin-provided MCP tools are automatically namespaced and visible in the `/mcp` panel.

## Installation

### Marketplace installation

Inside Claude Code:

```text
/plugin marketplace add gitguffaw/codex-router
/plugin install codex-router@codex-router
/reload-plugins
```

Then:

```text
/codex-router:setup
```

Setup performs:

1. Install or start the signed Router supervisor.
2. Verify executable signature and version compatibility.
3. Verify Codex availability and authentication.
4. Inspect the live provider, model, effort, tier, and capability catalog.
5. Verify the plugin-provided MCP server connection.
6. Confirm workspace permissions and trust.
7. Report exact remediation commands for anything unavailable.

The user can inspect the underlying MCP connection with:

```text
/mcp
```

### Installation scope

- **User scope:** recommended for an individual who wants Codex in every project.
- **Project scope:** recommended when a team wants the plugin and project policy declared in the repository.
- **Local scope:** useful for development and evaluation in one checkout.

Project-scoped MCP activation still follows Claude Code workspace-trust and approval rules. A cloned repository cannot silently approve its own MCP server.

### Local development

During development, load the adapter directly:

```bash
claude --plugin-dir ./adapters/claude-code
```

The production marketplace package must use a pinned, verified Router artifact. It must not use an unpinned `npx -y` download at every Claude session.

## Invocation styles

### Natural language

Preferred:

> Use Codex sol at xhigh effort to review the PR before submitting it. Do not submit until Codex reports no blocking findings.

Other examples:

> Ask Codex to analyze the cache design in read-only mode.

> Continue the most recent Codex thread for this workspace.

> Have Codex implement this in an isolated worktree, verify it, and return the patch without applying it.

> Use the native Codex CLI for this command because Router does not expose it yet.

### Deterministic skills

```text
/codex-router:review --target pr --model sol --effort xhigh --gate
/codex-router:analyze --model best --effort xhigh <request>
/codex-router:exec --isolate --verify --review <request>
/codex-router:status
/codex-router:result <job-id>
/codex-router:cancel <job-id>
/codex-router:native <codex arguments>
```

These commands are user conveniences over the same typed API. They do not invoke a separate runtime path.

### MCP tool calls

Claude normally calls the tools automatically. Representative tools are:

- `codex_capabilities`
- `codex_models`
- `codex_submit`
- `codex_review`
- `codex_watch`
- `codex_result`
- `codex_cancel`
- `codex_apply`
- `codex_native`

Claude Code will expose plugin-bundled tool names in a form similar to:

```text
mcp__plugin_codex-router_gateway__review
```

The exact namespaced identifier is used in skill allowlists, permission rules, and hook matchers, but users should not need to type it.

## Detailed PR-review flow

Given:

> Use Codex sol at xhigh effort to review the PR before submitting it. Do not submit until Codex reports no blocking findings.

Claude performs the following workflow.

### 1. Interpret intent

The review skill recognizes:

- Specialist: Codex.
- Model selector: `sol` alias.
- Reasoning effort: `xhigh`.
- Target: the current pull request or prospective pull request.
- Gate: no blocking findings.
- Ordering: review must precede submission.

### 2. Resolve the review subject

- If the current branch already has a PR, use its exact base and head.
- Otherwise, resolve the default base branch and construct the prospective PR subject from committed branch changes plus policy-approved working changes.
- Record base SHA, head SHA, working-tree inputs, and a canonical diff digest.

Ambiguous base selection is an error requiring explicit user direction. Router does not guess when multiple plausible targets exist.

### 3. Negotiate capabilities

- Query the live model catalog.
- Resolve `sol` to its current model identifier.
- Verify that the model is visible and supports `xhigh`.
- Verify that native review is available and read-only.
- Fail explicitly if any requirement is unavailable.

No weaker model, lower effort, prompt-based substitute, or outer-Claude review is chosen silently.

### 4. Submit the review

Conceptually, Claude calls:

```json
{
  "capability": "reviews.native",
  "target": {
    "type": "prospective_pull_request",
    "base": "auto"
  },
  "model": {
    "selector": "alias",
    "value": "sol"
  },
  "effort": "xhigh",
  "permissions": "read-only",
  "gate": {
    "require": "no_blocking_findings",
    "reviewAgainAfterChanges": true
  }
}
```

The MCP tool returns a durable job identifier immediately or waits when the expected duration fits the host tool budget. Claude uses `codex_watch` for longer work, so large reviews do not depend on one unbounded MCP response.

### 5. Handle the result

The structured result distinguishes:

- Clean.
- Findings with severity and exact locations.
- Blocked.
- Interrupted.
- Infrastructure or protocol failure.
- Capability or model mismatch.

If findings exist, Claude does not submit the PR. It reports them and, when the surrounding task authorizes implementation, fixes confirmed issues in the appropriate workspace.

### 6. Re-review after changes

Any change invalidates the earlier subject digest. Claude requests a new review against the exact new diff. Review loops are bounded by policy and surface unresolved findings rather than continuing indefinitely.

### 7. Produce a review receipt

A successful review stores a receipt such as:

```yaml
subject:
  base_sha: 81a26bf
  head_sha: d41c903
  diff_digest: sha256:0123456789abcdef
review:
  requested_model: sol
  resolved_model: gpt-5.6-sol
  effort: xhigh
  verdict: pass
  blocking_findings: 0
provider: codex-app-server
policy_version: 1
completed_at: 2026-07-11T15:42:10Z
```

The receipt is evidence, not just a status flag. It is cryptographically bound to the reviewed artifact.

### 8. Submit

Claude creates the PR only when the current subject still matches a qualifying receipt. If anything changed after review, the gate fails as stale and instructs Claude to review again.

## One-time instruction versus durable project rule

### One-time

Natural-language ordering in the current task is sufficient:

> Use Codex sol xhigh to review this PR. If it passes, submit it.

Claude follows the skill workflow, but the requirement is scoped to that task.

### Durable project gate

Enable a project rule:

```text
/codex-router:pr-gate enable --model sol --effort xhigh
```

Representative policy:

```yaml
gates:
  pull_request_create:
    require_codex_review:
      model: sol
      effort: xhigh
      verdict: no_blocking_findings
      subject_must_match: true
```

A `PreToolUse` hook inspects PR-creation operations, including:

- `gh pr create` through Bash.
- A GitHub MCP or connector pull-request creation tool.
- Other configured submission paths.

The hook asks Router for a current qualifying receipt. Missing, failed, mismatched, or stale evidence blocks the tool call with an exact remediation instruction.

The gate is checked against the artifact, not merely whether a review job ran recently.

## Permissions and trust

- Review and analyze tools are read-only by construction.
- Write tools require the managed write capability and workspace lease.
- Apply is separate from execution and requires a matching workspace revision.
- Native invocations declare their reduced guarantees.
- Plugin MCP tools follow Claude Code permission rules.
- Team project configuration cannot silently approve an untrusted MCP server.

## Failure behavior

Claude should report precise outcomes:

```text
Codex review did not run: alias `sol` is unavailable in the current catalog.
```

```text
Codex review is blocked: the resolved model does not support `xhigh`.
```

```text
PR submission is blocked: the qualifying review receipt covers diff
sha256:abc..., but the current diff is sha256:def.... Re-run the review.
```

```text
Codex review failed because its managed process exited. Job crx_123 is
terminally failed; Claude did not substitute its own review.
```

Failures never disappear into free-form prompt output.

## Host adapter conformance

The Claude adapter must prove:

- Natural-language requests activate the intended skill.
- Tool parameters preserve model, effort, target, and permission intent.
- MCP reconnect does not duplicate accepted jobs.
- Long reviews use durable job/watch semantics.
- Results render findings and failure categories accurately.
- Session closure revokes the correct leases.
- PR hooks match Bash and plugin-bundled GitHub tool names correctly.
- A changed diff invalidates review evidence.
- The adapter never performs Codex-delegated work itself after a Router failure.

The AGY and future adapters run equivalent conformance tests against the same gateway fixture.

## Official references

- [Create Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Install plugins and marketplaces](https://code.claude.com/docs/en/discover-plugins)
- [Claude Code MCP integration](https://code.claude.com/docs/en/mcp)
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)

## Related documents

- [Codex Everywhere product vision](../product/codex-everywhere-vision.md)
- [Architecture retrospective](./architecture-retrospective.md)
- [Capability gateway clean-sheet design](./capability-gateway-design.md)
