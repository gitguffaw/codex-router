# Parallel

## ENTER

- Task decomposes cleanly.
- Independent passes improve speed, coverage, or confidence.
- Codex should act as a second brain with multiple lanes.
- Round-robin challenge/synthesis is useful.

## AVOID

- Tight coupling.
- Small bounded edits.
- Constant synchronization would dominate.

## OPTIONAL CONTROLS

- `Model`
- `Reasoning`
- `Search`
- `DocsMCP`
- `ToolDirective`

## DEFAULT LAUNCH

Interactive Codex:

```bash
codex "<prompt>"
```

Interactive Codex with search/model/reasoning:

```bash
codex --search -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' "<prompt>"
codex --search -m <MODEL_ID> -c 'model_reasoning_effort="xhigh"' -c 'service_tier="fast"' "<prompt>"
```

Resolve `<MODEL_ID>` from user intent, local config, or `codex debug models`; do not reuse stale historical model IDs.

Then explicitly instruct Codex to use multiple agents and define:

- lane ownership
- merge contract
- final artifact shape

## PROMPT SHAPE

```text
Use multiple agents.
Task: <goal>
Split:
- lane 1: <owner + scope>
- lane 2: <owner + scope>
- lane 3: <owner + scope>
Merge:
- combine outputs into one report
- remove duplicates
- prioritize by impact
- recommend one next action
Constraints:
- <constraint>
```

## ROUND-ROBIN SHAPE

```text
Use multiple agents for a round-robin discussion.
Roles:
- proposer: strongest practical approach
- skeptic: failure modes, migration risk, hidden cost
- synthesizer: final recommendation, tradeoffs, next step
Ground all claims in this repository and current context.
```

## EXIT

- Consolidated result.
- One next mode:
  - `Analyze`
  - `Exec`
  - `Review`

## Examples

```bash
codex --search -m <MODEL_ID> -c 'service_tier="fast"' "Use multiple agents for a round-robin discussion. Roles: proposer, skeptic, synthesizer. Task: compare architecture options using current external info and this repository. Merge: one recommendation, key tradeoffs, and next action."
```

## Current Facts

- OpenAI docs say subagents are enabled by default and Codex only spawns them when explicitly asked.
- Last observed local feature state: `codex features list` reports `multi_agent` as `stable`.
