---
status: accepted
date: 2026-05-19
---

# Accept upstream provenance while continuing Codex Router development

Codex Router began from OpenAI's Codex plugin implementation as a bootstrap path, even though the project-specific routing concept and policy layer existed before that code was adopted. We will continue from the current codebase, preserve required Apache-2.0/OpenAI attribution for upstream-derived parts, and treat upstream as provenance rather than an ongoing tracking-fork commitment.

## Consequences

- We do not release just because OpenAI updates its plugin.
- We change upstream-derived runtime code when Codex Router behavior, compatibility, or user needs require it.
- A clean independent rewrite remains available if future distribution, branding, licensing, or ownership concerns outweigh the cost of rebuilding the runtime.
