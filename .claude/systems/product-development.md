---
name: product-development
layer: context
system: product-development
kind: component
mold: system-card
---

# System: product-development

## Promise
Carry a captured use-case to a shipped feature, tracked lightly. Each feature is a
**feature record** (a card) linked to a **project page** (its spec); work moves through
the **feature lifecycle** — capture → define → build → review → ship. Consumers: the
team tracking what is being built and why; the publishing binding that mirrors records
and pages into Notion. Deliberately lightweight — self-directed, no forced gates.

## Mechanisms
- **capturing** — reads: a raw idea/use-case · produces: a schema-shaped feature record
  (status = capture) with the use-case captured first-class and a project page linked ·
  runs-when: a user invokes `/capturing-a-feature` · invariants: the use-case is
  captured before anything else; owner resolved (never silently blank); project page
  linked before the record lands.
- The later stages (defining, reviewing, shipping) become guides forged as the process
  firms up. Pushing records and pages out lives in the publishing system, not here.

## Components
- `.claude/skills/capturing-a-feature/SKILL.md` — the capture-stage guide. Notion
  targets for the cards and project pages live in the publishing binding's `targets.md`.

## Concepts
feature record · project page · feature lifecycle

## Invariants
- every feature record links to its project page — `unenforced: runtime/gate (lightweight)`
- the lifecycle stage is tracked on the record — `unenforced: runtime`
- records and pages reach Notion through the publishing binding, never a bespoke push — enforcer: (gate) + the publishing system
