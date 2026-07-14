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
**feature record** (a card) that lives in its tool's Feature Board — the board it lives
in IS its link to the **tooling page** (that [DB] Tooling entry), so containment is the
link, no relation property. Work moves through the real **feature lifecycle** — Planned
→ Up Next → In Development → Completed (or Canceled). Consumers: the team tracking what
is being built and why; the publishing binding that mirrors records into Notion.
Deliberately lightweight — self-directed, no forced gates. (Schemas mirror the live
Ozone HQ boards — fetch live; the verified schemas live in the publishing binding's
`targets.md`.) Decreed with the first add-on wave (ADR-0017; live-schema doctrine ADR-0014).

## Mechanisms
- **capturing** — reads: a raw idea/use-case · produces: a Feature Board card (Name +
  the why in Description + Status = Planned) · runs-when: a user invokes
  `/capturing-a-feature` · invariants: the why is captured into Description before
  anything else; the card is created on the Feature Board, never an invented location.
- **defining** — reads: a captured (Planned) card · produces: a scope/definition
  appended to the card's Description (why preserved) · runs-when: a user invokes
  `/defining-a-feature` · invariants: uses the publishing update binding
  (fetch-merge-write); leaves status at Planned (advancing is the build stage's move).
- The remaining stages (build/review/ship map onto the board's statuses) become guides
  forged as the process firms up. Pushing/updating live in the publishing system.

## Components
- `.claude/skills/capturing-a-feature/SKILL.md` — the capture-stage guide
- `.claude/skills/defining-a-feature/SKILL.md` — the define-stage guide. Notion targets
  for the cards and tooling pages live in the publishing binding's `targets.md`.

## Concepts
feature record · tooling page · feature lifecycle · Feature Board · containment

## Invariants
- the why lands in the card's Description, never dropped — enforcer: (gate) + `capturing-a-feature` step 1
- a feature card is created in its tool's Feature Board, not an invented location — enforcer: (gate)
- records reach Notion through the publishing bindings (the canonical rule; see the publishing card) — enforcer: (gate) + publishing
