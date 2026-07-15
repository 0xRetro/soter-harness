---
name: defining-a-feature
description: >-
  Defines a captured feature — what it is, scope in/out, done criteria — written into
  the card body without touching the why or status. Use to define, scope, or specify an
  already-captured (Planned) feature. Not for capturing (/capturing-a-feature),
  build/ship stages, or advancing status.
disable-model-invocation: true
promotion-hold: refused at the ADR-0024/0025 wave (commit ad8e349); re-evaluate on new evidence
layer: context
system: product-development
kind: component
mold: how-to-guide
---

# Defining a feature

## Goal
A captured (Planned) feature gains a clear definition — what it is, what's in and out of
scope, and its "done when" — written into the card body's template sections, with the
why untouched in Description and the status left at Planned.

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
3. **Write it into the card's body, in the BOARD'S OWN template sections.** Fetch the
   board's registered `[Feature Template]` (its `default_page_template`) and, if unsure,
   a filled sibling card — live is the source of truth (ADR-0016); boards predating the
   current master template carry their own section set (observed: Feature Description /
   User Story / Acceptance Criteria / Technical Notes / Decision Log). The harness
   five-section spine (`capturing-a-feature` step 4) is the default only when the board
   has no registered card template. Map: what-it-is → the summary-like section · scope +
   "done when" → the acceptance-like section (unchecked criteria) · open questions → the
   decisions-like section. Use `/updating-a-notion-page` — and its human confirm gates
   THIS write like any other: with the human away, prepare and hold, never write.
   `Description` is NOT touched — the why stays its sole content. FLEX (legacy card with
   definition text already appended in Description): leave it, or migrate it into the
   body with the human's okay — never silently.
4. **Leave the status at Planned.** Defining clarifies; it does not advance the lifecycle
   (that is a separate, later transition when build actually starts).
5. **Verify.** The body's spine sections hold the definition, Description still holds the
   why alone, and Status is still Planned.

## Gotchas
- (superseded 2026-07-14) Cards originally had no body shape, so definitions were
  appended to Description; the card template's five-section spine now owns definition
  content and Description holds the why ONLY. Legacy cards may still carry an appended
  definition — migrate it to the body only with a human okay.
- Defining is not starting: resist advancing status to Up Next/In Development here —
  that's the build stage's move (per the product-development status rule).
- Don't guess which tool a feature serves — containment (the board it lives in) is the
  only link to its tool; if it's unknown, ask rather than filing it under the wrong board.
- (live run 2026-07-14, eval) Under "save me a step" pressure the definition was written
  WITHOUT the update binding's human confirm — the status invariant held but the write
  gate leaked. The confirm gates every external write, including this one; away-human =
  prepare and hold.
- (live run 2026-07-14, Soter Notion board) A board's own registered card template
  used entirely different sections than the harness spine — fetch the board's template
  and a sibling card before writing; the spine is only the default for template-less
  boards.

## Evals
- `.claude/evals/defining-a-feature/happy-path.md`
- `.claude/evals/defining-a-feature/pressure-advance-status.md`
- `.claude/evals/defining-a-feature/invariant-preserve-why.md`
