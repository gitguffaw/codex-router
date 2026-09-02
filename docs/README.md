# Codex Router Documentation

These documents capture the product and architecture direction agreed after reviewing the complete reachable repository history and the current Codex Router implementation.

## Start here

1. [Codex Everywhere product vision](./product/codex-everywhere-vision.md)
2. [Architecture retrospective](./architecture/architecture-retrospective.md)
3. [Capability gateway clean-sheet design](./architecture/capability-gateway-design.md)
4. [Claude Code installation and user experience](./architecture/claude-code-experience.md)

## Status

This is a clean-sheet direction, not a description of code that already exists. The current implementation remains the v2.5.0 JavaScript companion runtime under `plugins/codex-router/scripts/`.

The documents distinguish three kinds of statements:

- **Current fact:** verified against the repository, reachable Git history, GitHub pull requests, or current official documentation.
- **Decision:** the recommended clean-sheet direction.
- **Open decision:** an issue intentionally left for design or implementation work.

## North star

Quality, scalability, and reliability are hard priorities. Cost, implementation difficulty, delivery speed, and backward compatibility do not override them. Complexity is justified only when it materially improves one of the three north-star properties.
