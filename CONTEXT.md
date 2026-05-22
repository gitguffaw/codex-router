# Codex Router Plugin

This context defines the language for Codex Router as a portable Codex delegation contract with Claude Code as its first host adapter.

## Language

**Codex Router Plugin**:
A Claude Code plugin bundle that extends OpenAI's Codex plugin behavior with policy-backed routing and job management.
_Avoid_: standalone Codex CLI, replacement for Codex, upstream Codex plugin

**Codex Router Core**:
The host-independent delegation contract for routing, executing, tracking, and retrieving Codex work.
_Avoid_: Claude Code plugin, slash-command adapter

**Core API**:
The versioned host-facing JSON command contract exposed by the Codex Router Core.
_Avoid_: human-rendered command output, Claude slash-command text

**Host Adapter**:
A host-specific integration that translates an agent environment's commands or skills into the Codex Router Core contract.
_Avoid_: Codex Router Core, Codex CLI

**Adapter Contract**:
The minimum responsibility of a Host Adapter: call the Core API, preserve workspace/session identity, render host-native results, and avoid substituting host work for failed Codex work.
_Avoid_: host-specific routing semantics, fallback implementation by the host

**Host Agent**:
An agent environment that delegates work to Codex through Codex Router.
_Avoid_: Codex CLI, Codex model

**Upstream Codex Plugin**:
The OpenAI-provided Claude Code plugin that supplies the baseline Codex integration being extended.
_Avoid_: Codex Router Plugin, Codex CLI

**Codex CLI**:
The local OpenAI Codex command-line runtime invoked by the plugin.
_Avoid_: Claude Code, plugin runtime

**Upstream Provenance**:
The origin and attribution history of code or behavior borrowed from the upstream OpenAI plugin.
_Avoid_: product ownership, ongoing upstream tracking commitment

**Product Ownership**:
The project-specific judgment, workflows, policy, and user experience that define Codex Router as a product.
_Avoid_: model ownership, upstream copyright ownership

## Relationships

- The **Codex Router Plugin** is a **Host Adapter** for Claude Code
- A **Host Adapter** follows the **Adapter Contract**
- A **Host Adapter** exposes the **Codex Router Core** to a **Host Agent**
- The **Core API** is the stable contract a **Host Adapter** calls
- The **Codex Router Core** invokes the **Codex CLI**
- The **Codex Router Plugin** extends the **Upstream Codex Plugin**
- The **Codex Router Plugin** invokes the **Codex CLI**
- The **Codex Router Plugin** does not replace the **Codex CLI**
- **Upstream Provenance** does not negate **Product Ownership**

## Example dialogue

> **Dev:** "Is the **Codex Router Plugin** replacing OpenAI's Codex integration?"
> **Domain expert:** "No - it extends the **Upstream Codex Plugin** and invokes the **Codex CLI**."

> **Dev:** "Could another **Host Agent** use Codex Router without Claude Code?"
> **Domain expert:** "Yes - it would need its own **Host Adapter** for the **Codex Router Core** contract."

## Flagged ambiguities

- "plugin" can mean either the **Codex Router Plugin** or the **Upstream Codex Plugin** - resolved: use the specific term when the distinction matters.
- "own" can mean **Product Ownership**, model ownership, or copyright ownership of upstream-derived code - resolved: Codex Router accepts **Upstream Provenance** while retaining **Product Ownership** over its project-specific design.
