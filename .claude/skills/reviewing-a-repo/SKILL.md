---
name: reviewing-a-repo
description: >-
  Reviews a code repository and turns it into standardized Notion records — a
  tooling page plus feature cards — with granularity and selection curated by a
  human before anything is written, and existing entries updated rather than duplicated.
  Use when the user wants to ingest, review, or "suck in" a repo into Notion as features
  and a tooling page. Not for non-repo sources, not for the Notion write mechanics
  themselves (those are /pushing-to-notion and /updating-a-notion-page), and not for
  defining an already-captured feature (/defining-a-feature).
disable-model-invocation: true
layer: automation
system: ingestion
kind: component
mold: how-to-guide
---

# Reviewing a repo

## Goal
A repo becomes a standardized tooling page + a curated set of feature cards in Notion —
the human chose what enters and at what altitude, nothing was fabricated, and existing
entries were updated, not duplicated.

## Use when / don't use when
- Use when: ingesting a repo into Notion as a tooling page + feature cards.
- Not for: non-repo sources; the Notion write mechanics (`/pushing-to-notion`,
  `/updating-a-notion-page`); shaping a single feature card (that is `/capturing-a-feature`,
  which this delegates to per approved card); defining an already-captured feature
  (`/defining-a-feature`).

## Steps
1. **Read the code, not just the README.** README drifts from reality (baseline: three
   integrations existed in `src/` but not the README). Read the README AND the source
   tree (services, entities, routes) to find real capabilities.
2. **Gather real metadata — never fabricate.** `git remote get-url origin` for the
   GitHub field; the tool name. ASK the human for Owner, Prod URL, `Type` (the [DB]
   Tooling enum), and `Status` — do not guess these (baseline fabricated Status/Type).
   Leave a field blank rather than invent it. This ask survives a "don't ask me / just
   do it" instruction — blank beats invented.
3. **Draft the tooling page + candidate features at ONE altitude.** A feature = a
   user-facing capability someone would put on a roadmap — not per-file/route/service
   (too fine), not the whole product (too coarse). If the tool already has a Feature
   Board, calibrate granularity against its existing cards.
4. **De-dup against Notion.** Search for the tooling page (by Name / GitHub url) and, if
   it has a Feature Board, its existing cards. Mark each candidate NEW vs EXISTING. For a
   tool that ALREADY exists, do step 6 (resolve its board) first, then de-dup against
   that board's real cards — the order inverts for existing tools.
5. **Intake gate — the load-bearing step.** Present the tooling page + the candidate
   feature list (new vs existing, granularity visible) and let the human CURATE: which
   become cards, at what altitude, which are noise. NOTHING is written before this okay.
   This is ingestion's "nothing enters without an intake gate" invariant — a DISTINCT
   checkpoint from the per-write confirms inside the bindings (it curates *selection and
   altitude*, not write mechanics; the downstream confirms don't replace it).
6. **Resolve the board.** Find or create the tooling page in [DB] Tooling; find or create
   that tool's Feature Board; get its `data_source_id`. (Feature boards are per-tooling —
   the card's board is its project link.)
7. **Land the approved set — delegate the shaping.** Each approved NEW feature goes through
   `/capturing-a-feature` (target = the tool's Feature Board) — that guide is the single
   card-shaping authority; don't re-shape cards here. Tooling-page fields and existing
   cards get updated via `/updating-a-notion-page`.
8. **Verify + report.** List what was created and updated with urls; confirm nothing was
   fabricated and no duplicates were made.

## Gotchas
- (baseline) Review the CODE — the README omitted three real integrations; a
  README-only pass under-counts capabilities.
- (baseline) Don't fabricate Status/Type/Owner/GitHub — gather (`git remote`) or ask;
  blank beats invented.
- (baseline) Granularity is curated by the human at step 5 — propose at capability
  altitude, let the human draw the feature-vs-noise line. Don't dump 30 stubs.
- (baseline) Boards are per-tooling — create/find the tool's board before its cards
  (the chicken-and-egg); don't push cards to a global board.
- (baseline) De-dup before create — match on Name/GitHub; existing → update, never a
  second copy.

## Evals
- `.claude/evals/reviewing-a-repo/happy-path.md`
- `.claude/evals/reviewing-a-repo/pressure-dump-all.md`
- `.claude/evals/reviewing-a-repo/invariant-review-gate.md`
