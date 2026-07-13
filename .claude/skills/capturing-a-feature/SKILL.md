---
name: capturing-a-feature
description: >-
  Turns a raw idea or use-case into a consistently-shaped feature record — the value
  captured first-class, an owner resolved, and a project page linked — ready to land as
  a Notion card at the capture stage of the feature lifecycle. Use when the user wants
  to capture a new feature, log an idea, or start tracking something to build. Not for
  later lifecycle stages (define, build, review, ship), not for Notion push mechanics
  (that is /pushing-to-notion), and not for content unrelated to features.
disable-model-invocation: true
layer: context
system: product-development
kind: component
mold: how-to-guide
---

# Capturing a feature

## Goal
A raw idea becomes a feature record shaped the same way every time — its use-case
captured as a first-class field, an owner resolved, and a project page linked — sitting
at lifecycle stage `capture`, ready to land as a Notion card.

## Use when / don't use when
- Use when: turning a new idea, request, or use-case into a tracked feature.
- Not for: later lifecycle stages — define, build, review, ship (separate guides,
  forthcoming); the mechanics of writing to Notion (`/pushing-to-notion`); anything
  that isn't a feature.

## Steps
1. **Capture the use-case first — the "why."** State the value it creates or the
   problem it removes, as its own field. Do this before naming or anything else: without
   the guide the "why" is the thing that gets lost (baseline). If the user gave only a
   solution, ask what value it delivers. FLEX (bulk/under a clock): infer a provisional
   why per item and flag it for a quick confirm — one batched "one line of why each"
   question. Never defer the why to "later"; later is exactly when it's lost.
2. **Name the feature.** Concise, and distinct from the use-case (the why is not the name).
3. **Resolve the owner.** Ask if not given — never leave it silently blank (baseline gap).
   A visibly-flagged "unresolved" owner is acceptable AT capture (that isn't silent);
   resolve it before the feature leaves the capture stage.
4. **Link a project page.** Link an existing project page, or create one. A feature
   record MUST link its project page (system invariant) — do not land a record without it.
   For a batch, one shared project page may satisfy the link for all of them — link, do
   not spawn a throwaway page per card (that's the machinery smell).
5. **Shape to the `feature-cards` schema** (`.claude/skills/pushing-to-notion/targets.md`):
   `Name` → title · `Use case` → rich_text · `Status` → status = `capture` · `Owner` →
   people · `Project` → url. Set status to `capture`.
6. **Land it.** Hand the shaped record to `/pushing-to-notion` (target `feature-cards`)
   to create the card. If Notion isn't connected yet, present the complete structured
   record and note it's pending push — never invent a local storage location.
7. **Verify.** The record has a use-case, an owner, and a project-page link, and
   status = `capture`. Report the created card url (or that it's pending push).

## Gotchas
- (baseline) Without this guide an agent drops the record in an arbitrary location,
  loses the "why," leaves owner/project blank, and violates the project-link invariant
  at birth. Steps 1, 3, 4, and 6 each close one of those.
- (baseline) The `feature-cards` schema originally had no use-case field, so the value
  was improvised prose that a strict schema pass would drop. It is now a first-class
  `Use case` property — capture it there, not in freeform notes.
- Never create the record without a project page — the system invariant requires the link.
- (pressure) Under a bulk rush the temptation is to drop the why and spawn a page per
  card. Hold both lines: infer-and-flag the why, share one project page for the batch.

## Evals
- `.claude/evals/capturing-a-feature/happy-path.md`
- `.claude/evals/capturing-a-feature/pressure-batch-skip.md`
- `.claude/evals/capturing-a-feature/invariant-project-link.md`
