---
name: capturing-a-feature
description: >-
  Turns a raw idea or use-case into a Feature Board card — the "why" captured in the
  card's Description, at status Planned — landing on the real board, not an invented
  location. Use when the user wants to capture a new feature, log an idea, or start
  tracking something to build. Not for later lifecycle stages (Up Next, In Development,
  Completed), not for Notion push mechanics (that is /pushing-to-notion), and not for
  content unrelated to features.
disable-model-invocation: true
layer: context
system: product-development
kind: component
mold: how-to-guide
---

# Capturing a feature

## Goal
A raw idea becomes a Feature Board card shaped the same way every time — its "why"
captured in Description, at status `Planned` — landing on the real board, not an
invented location.

## Use when / don't use when
- Use when: turning a new idea, request, or use-case into a tracked feature.
- Not for: later lifecycle stages — Up Next, In Development, Completed (separate guides,
  forthcoming); the mechanics of writing to Notion (`/pushing-to-notion`); anything
  that isn't a feature.

## Steps
1. **Capture the "why" first.** State the value it creates or the problem it removes.
   This goes in the card's `Description` — the Feature Board has no separate field for
   it, so if you skip it here it is lost (baseline). If the user gave only a solution,
   ask what value it delivers. FLEX (bulk/under a clock): infer a provisional why per
   item and flag it for a quick confirm — one batched "one line of why each" question.
   Never defer the why to "later"; later is exactly when it's lost.
2. **Name the feature.** Concise, and distinct from the why (the why is not the name).
3. **Shape to the real `feature-cards` schema**
   (`.claude/skills/pushing-to-notion/targets.md`): `Name` → title · `Description` →
   text (the why) · `Status` → status = `Planned`. (Owner and the owning tool live on
   the project page in [DB] Tooling, not on the card — note the tool in Description if
   it matters, or capture/link a project page separately.)
4. **Land it on the Feature Board.** Hand the card to `/pushing-to-notion` (target
   `feature-cards`) to create it. Never invent a local storage location.
5. **Verify.** The card has the why in Description and status = `Planned`; report the
   created card url.

## Gotchas
- (baseline) Without this guide an agent drops the record in an arbitrary location and
  loses the "why." Steps 1 and 4 close those.
- (live test 2026-07-12) The real Feature Board has only `Name` / `Description` /
  `Status` — no Use-case, Owner, or Project field. The why goes in `Description`; the
  owner and owning tool live on the project page ([DB] Tooling), not the card. An
  earlier draft invented those fields; pushing against the live schema corrected it —
  re-fetch the schema, don't trust an old assumption.
- (pressure) Under a bulk rush the temptation is to drop the why. Hold that line:
  infer-and-flag the why for each; status stays `Planned`.

## Evals
- `.claude/evals/capturing-a-feature/happy-path.md`
- `.claude/evals/capturing-a-feature/pressure-batch-skip.md`
- `.claude/evals/capturing-a-feature/invariant-why-in-description.md`
