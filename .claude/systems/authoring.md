---
name: authoring
layer: kernel
system: authoring
kind: component
mold: system-card
---

# System: authoring

## Promise
New harness pieces are born through the loop — mold → evals → checks → gate — never
freehand. Consumers: anyone extending the harness; every other kernel system (the
loop exercises them all).

## Mechanisms
- **forge** — reads: the molds, the lexicon registry, the rubric, neighbors'
  exclusion clauses · produces: a staged piece + its eval cases + recorded gotchas ·
  runs-when: the user invokes `/forge` (never auto) · invariants: baseline (RED)
  before drafting; never merges its own output; lands staged.

## Components
- `.claude/skills/forge/SKILL.md` — the loop, end to end
- `.claude/rules/authoring.md` — the always-on authoring house rules

## Concepts
piece · the loop · exclusion clause · gotcha

## Invariants
- every piece starts from its mold — enforcer: checker `FM_CLASS` (mold field) + `PLACEHOLDER`
- a piece ships with its evals — enforcer: checker `EVALS_MIN`
- the kernel is validated when the forge authors one new piece through the whole loop —
  `unenforced: the seal test, run explicitly`
