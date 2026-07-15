---
name: capturing-a-feature
description: >-
  Turns a raw idea or use-case into a Feature Board card — the why captured in
  Description, status Planned, on the real board. Use to capture a new feature, log an
  idea, or start tracking something to build. Not for later lifecycle stages, push
  mechanics (/pushing-to-notion), or non-features.
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
- Use when: turning a single new idea, request, or use-case into a tracked feature. This
  is the single card-shaping authority — bulk repo ingestion (`/reviewing-a-repo`)
  delegates each approved card here.
- Not for: bulk ingestion from a repo (that is `/reviewing-a-repo`, which calls this per
  card); later lifecycle stages — Up Next, In Development, Completed (separate guides,
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
3. **Shape to the board's live schema** (`feature-cards` in
   `.claude/skills/pushing-to-notion/targets.md`). The core every board shares:
   `Name` → title · `Description` → text (the why) · `Status` → status = `Planned`
   (a bulk ingestion's intake gate may explicitly curate a different status — e.g.
   `Completed` for already-shipped capabilities; that is the gate's call, never a
   silent default). A board may carry per-tool extras beyond the core (e.g.
   `Area`/`Priority`/`Type` selects) — fetch the specific board's schema and fill an
   extra only when the value is clear and matches a live option; otherwise leave it
   empty. (Owner and the owning tool live on the tooling page in [DB] Tooling, not on
   the card.)
4. **Shape the body per the BOARD'S OWN card template.** Fetch the board data source's
   `default_page_template` — live is the source of truth (ADR-0016); older boards carry
   their own section set (observed: Feature Description / User Story / Acceptance
   Criteria / Technical Notes / Decision Log on the Soter Notion board), and only when
   the board's template is the template-era default (or absent) does the harness spine
   apply: Summary · <section 2, by type> · Current state in code (file refs, or "not
   built yet") · Relationships (the tooling page; related cards) · Decisions & open
   questions. Section 2 swaps by card `Type` — Feature: **Behavior / Acceptance**
   (observable target criteria; check items that are already true) · Enhancement:
   **Current → Desired behavior** (and Relationships names the card it enhances) ·
   Bug: **Repro · Expected vs Actual** (Current state in code holds the suspected
   cause) · Content: **Scope** (checklist of the content pieces). On a custom-template
   board, map the same content into its analogous sections. Fill with gathered or
   derivable facts; a section you can't fill stays visibly empty. Write the body at
   create — never `apply_template` onto an existing card (the template's default
   properties clobber real values).
5. **Land it on the Feature Board.** Resolve the target tool's own board first —
   `feature-cards` is per tooling entry, resolved through the tool's tooling page
   (targets.md has the two-step rule), never a stored id. Then hand the card to
   `/pushing-to-notion` to create it. Never invent a local storage location.
6. **Verify.** The card has the why in Description, the expected status (`Planned`
   unless the gate curated otherwise), and a body following the card template's
   sections; report the created card url.

## Gotchas
- (baseline) Without this guide an agent drops the record in an arbitrary location and
  loses the "why." Steps 1 and 4 close those.
- (live test 2026-07-12) The real Feature Board has only `Name` / `Description` /
  `Status` — no Use-case, Owner, or Project field. The why goes in `Description`; the
  owner and owning tool live on the tooling page ([DB] Tooling), not the card. An
  earlier draft invented those fields; pushing against the live schema corrected it —
  re-fetch the schema, don't trust an old assumption.
- (pressure) Under a bulk rush the temptation is to drop the why. Hold that line:
  infer-and-flag the why for each; status stays `Planned`.
- (live survey 2026-07-13, 6 tooling entries) Board titles are unreliable both ways —
  most keep the duplicated "Feature Board Template" title, some are renamed ("Txn
  Keeper Features"). Identify a board only via the tooling page that embeds it
  (targets.md's resolution rule). And board schemas diverge: the Name/Description/
  Status core held everywhere, but Process Platform's board adds Area/Priority/Type —
  the 3-field shape is the floor, not the whole schema; fetch the board's live schema.
- (live run 2026-07-14, landing-page ingestion) Cards were created properties-only and
  landed with EMPTY bodies — the live `[Feature Template]` expects a five-section body
  (its callout at the time even named a card-body-filling skill that didn't exist here;
  the callout has since been removed and this guide's step 4 is the shape's home). The
  board's card template is part of the target contract: shape the body (step 4), don't
  stop at properties.
- (live run 2026-07-14) `apply_template` onto an existing card clobbers real property
  values with the template's defaults (Status=Planned · Priority=Next) — write the body
  content directly instead.

## Evals
- `.claude/evals/capturing-a-feature/happy-path.md`
- `.claude/evals/capturing-a-feature/pressure-batch-skip.md`
- `.claude/evals/capturing-a-feature/invariant-why-in-description.md`
- `.claude/evals/capturing-a-feature/type-swap-bug.md`
