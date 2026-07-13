---
name: platform
layer: kernel
system: platform
kind: component
mold: system-card
---

# System: platform

## Promise
The platform's (claude-code's) primitives are understood and used ONE way, and all
platform coupling is quarantined here — every other system stays portable.
Consumers: mechanism authors (which form to use), any future platform swap (the
coupling inventory).

## Mechanisms
None yet — this system defines forms and owns wiring; concrete hooks/skills/agents
are mechanisms OF the systems that use them.

## Components
- `.claude/settings.json` — in-repo wiring (checker hook + event log)
- `.claude/hooks/hooks.json` — plugin-shipped wiring (checker hook, warn only)
- `.claude/.claude-plugin/plugin.json` — the plugin manifest (the `.claude/` dir IS the plugin)
- per-primitive usage standards — planned; authored via the forge as needed
  (`unenforced: tracked here until they exist`)

## Concepts
hook · skill · agent · command · script · worktree · subagent · guide

## Invariants
- physical layout is platform-shaped (`.claude/skills/` etc.); a piece's system is
  declared in frontmatter, never implied by its folder — enforcer: checker `FM_CLASS`
- wiring changes pass `claude plugin validate` — enforcer: CI plugin job
- no other system's content references claude-code specifics beyond the type names —
  `unenforced: review at the gate`
