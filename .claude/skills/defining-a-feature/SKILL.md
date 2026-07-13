---
name: defining-a-feature
description: >-
  Defines a captured feature — clarifies what it actually is, its scope (in and out),
  and how you'll know it's done — and appends that definition to the feature card's
  Description without touching the why or the status. Use when the user wants to define,
  scope, flesh out, or specify a feature that's already been captured (a Planned card).
  Not for capturing a brand-new feature (that is /capturing-a-feature), not for later
  build/ship stages, and not for advancing the card's status.
disable-model-invocation: true
layer: context
system: product-development
kind: component
mold: how-to-guide
---

# Defining a feature

## Goal
A captured (Planned) feature gains a clear definition — what it is, what's in and out of
scope, and its "done when" — appended to its card's Description, with the why preserved
and the status left at Planned.

## Use when / don't use when
- Use when: a captured feature needs defining — scope, boundaries, acceptance.
- Not for: capturing a new feature (`/capturing-a-feature`); build/review/ship stages;
  advancing status (defining does NOT move it off Planned — that happens when build starts).

## Steps
1. **Find the card.** Locate the feature card on its tool's Feature Board (by name/id).
   Its board tells you which tool it belongs to — containment is the link to the
   tooling page.
   If you were handed only a name, confirm the owning board/tool at fetch time before
   writing — don't guess which board it lives on.
2. **Write the definition.** Pin down: what it actually is (one clear sentence), scope
   (in / out), and the acceptance test ("done when …"). If the tool/fit is unclear, ask
   — don't invent which tool it serves.
3. **Append it to the card's Description** via `/updating-a-notion-page` (fetch-merge-write):
   the definition is added AFTER the existing why — the why is never replaced or dropped.
4. **Leave the status at Planned.** Defining clarifies; it does not advance the lifecycle
   (that is a separate, later transition when build actually starts).
5. **Verify.** The Description now holds both the original why and the new definition, and
   Status is still Planned.

## Gotchas
- The card has only Name/Description/Status — the definition lives in Description,
  appended to the why. Use the update binding's fetch-merge-write so the why survives.
- Defining is not starting: resist advancing status to Up Next/In Development here —
  that's the build stage's move (per the product-development status rule).
- Don't guess which tool a feature serves — containment (the board it lives in) is the
  only link to its tool; if it's unknown, ask rather than filing it under the wrong board.

## Evals
- `.claude/evals/defining-a-feature/happy-path.md`
- `.claude/evals/defining-a-feature/pressure-advance-status.md`
- `.claude/evals/defining-a-feature/invariant-preserve-why.md`
