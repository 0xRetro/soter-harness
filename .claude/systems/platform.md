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
- `.claude/settings.json` — in-repo wiring (Bash guard + checker hook; event log retired, ADR-0035)
- `.claude/hooks/hooks.json` — plugin-shipped wiring, always at parity with
  settings.json: same guard and checker hook (ADR-0034)
- `.claude/.claude-plugin/plugin.json` — the plugin manifest (the `.claude/` dir IS the
  plugin); carries no version while the harness is internal — every commit ships (ADR-0034)
- `.claude/rules/parallel-sessions.md` — the multi-session operating rule: one
  session = one worktree = one branch; root checkout parked on main (ADR-0027)
- per-primitive usage standards — planned; authored via the forge as needed
  (`unenforced: tracked here until they exist`)

## Concepts
hook · skill · agent · command · script · worktree · subagent · session · guide

## Invariants
- physical layout is platform-shaped (`.claude/skills/` etc.); a piece's system is
  declared in frontmatter, never implied by its folder — enforcer: checker `FM_CLASS`
- wiring changes pass `claude plugin validate` — enforcer: CI plugin job
- plugin wiring ships every in-repo hook and nothing more — enforcer: checker `HOOK_PARITY`
- no other system's content references claude-code specifics beyond the type names —
  `unenforced: review at the gate`
