---
name: standards
layer: kernel
system: standards
kind: component
mold: system-card
---

# System: standards

## Promise
One explicit bar for "good" — quality, naming, budgets, prescriptiveness — so review
is a checklist, not taste. Consumers: authors (while writing), reviewers (at the
gate), the checker (the mechanical ⚙ items).

## Mechanisms
None of its own — delegated mechanisms only (ADR-0045): the mechanical items run
inside enforcement's checker; the judgment items run at governance's human gate.

## Components
- `.claude/RUBRIC.md` — THE checklist every piece clears (includes the naming and
  budget standards as sections; split them out only when a second consumer needs
  them separately) (singleton)
- `.claude/standards/degrees-of-freedom.md` — how tightly to specify a step
  (narrow bridge → exact · open field → heuristics)

## Concepts
budget · degree of freedom · flex point · rubric

## Invariants
- budgets are law: CLAUDE.md < 200 lines · guide body < 500 · description ≤ 1024 —
  enforcer: checker `BUDGET_*` + `DESC_*`
- names lowercase-hyphenated, no vague or reserved words — enforcer: checker `NAME_LINT`
- every piece clears the rubric before merge — enforcer: the human gate
