---
name: template
layer: kernel
system: template
kind: component
mold: system-card
---

# System: template

## Promise
Every piece starts as a copy of a mold — shape is guaranteed by instantiation,
not policing. Consumers: authors (human or agent), the forge, the checker.

## Mechanisms
- **scaffold** — reads: the piece's mold · produces: a new piece skeleton ·
  runs-when: authoring starts (forge step "Draft") · invariants: never freehand;
  hints deleted when filled. (Realized today as a forge step, not a separate file.)

## Components
- `.claude/templates/mold.md` — the mold-for-molds (the one bootstrap)
- `.claude/templates/system-card.md` · `how-to-guide.md` · `house-rule.md` ·
  `eval-case.md` · `adr.md` · `standard.md` — one mold per piece shape

## Concepts
mold · shape · hint

## Invariants
- filled pieces contain no hints or placeholders — enforcer: checker `PLACEHOLDER`
- every durable content piece names its mold — enforcer: checker `FM_CLASS`
- a mold wears the mold-for-molds' shape — enforcer: checker `MOLD_SHAPE`
