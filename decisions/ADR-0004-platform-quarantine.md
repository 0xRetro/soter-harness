# ADR-0004: Platform primitives are forms, not systems

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
An early kernel draft listed claude-code hooks/skills/agents/orchestration as
sibling systems. That groups by delivery-form, which the classification rule
forbids; no surveyed project treats primitives as top-level systems — analyses
model them as one extension layer, and the cleanest designs quarantine platform
specificity behind one seam.

## Decision
One platform system owns everything claude-code-specific: the wiring, the plugin
manifest, per-primitive usage standards, and the concept definitions (hook, skill,
agent, command, script, worktree, subagent). A concrete hook or skill file is a
mechanism or component OF the system whose promise it keeps. Physical layout stays
platform-shaped (`.claude/skills/` etc.); a piece's system is declared in
frontmatter, never implied by its folder.

## Consequences
Every other system stays portable; a platform swap has one named seam. Orchestration
remains a usage standard, not a system, until real mechanisms exist to group.
Revisit if a primitive accrues genuine mechanisms and a distinct promise of its own.
