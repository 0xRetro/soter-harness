---
name: reviewing-a-repo
description: >-
  Turns a code repo into Notion records — a tooling page plus human-curated feature
  cards; existing entries updated, not duplicated. Use to ingest, review, or "suck
  in" a repo into Notion. Not for non-repo sources, write mechanics
  (/pushing-to-notion, /updating-a-notion-page), or defining a feature
  (/defining-a-feature).
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
   user-facing capability someone would put on a roadmap — FLEX: where exactly the
   altitude line falls, bounded by: coarser than per-file/route/service, finer than
   the whole product; the human redraws it at step 5. If the tool already has a Feature
   Board, calibrate granularity against its existing cards.
4. **De-dup against Notion.** Search for the tooling page (by Name / GitHub url) and, if
   it has a Feature Board, its existing cards. Mark each candidate NEW vs EXISTING. For a
   tool that ALREADY exists, do step 6 (resolve its board) first, then de-dup against
   that board's real cards — the order inverts for existing tools.
5. **Intake gate — the load-bearing step.** Present the tooling page + the candidate
   feature list (new vs existing, granularity visible) and let the human CURATE: which
   become cards, at what altitude, at what status (default `Planned`; e.g. `Completed`
   for a shipped repo's built capabilities), which are noise. NOTHING is written before
   this okay.
   This is ingestion's "nothing enters without an intake gate" invariant — a DISTINCT
   checkpoint from the per-write confirms inside the bindings (it curates *selection and
   altitude*, not write mechanics; the downstream confirms don't replace it).
6. **Resolve the board.** Find or create the tooling page in [DB] Tooling; find or create
   that tool's Feature Board; get its `data_source_id`. (Feature boards are per tooling
   entry — containment is the card's link to its tooling page.)
7. **Land the approved set — delegate the shaping.** Each approved NEW feature goes through
   `/capturing-a-feature` (target = the tool's Feature Board) — that guide is the single
   card-shaping authority (properties AND the template-shaped body); don't re-shape cards
   here. Then fill the tooling page's own body sections (its template: Vision · Use Cases ·
   How it works · Capabilities by area · Team · Related Resources) with derivable facts —
   Team from git history, Use Cases / How it works / Capabilities from the code review
   (Capabilities links the landed cards, ✅ built / ⬜ planned), Resources from the repo +
   prod URLs. What isn't derivable stays visibly placeholder — say so when reporting.
   An EXISTING page is RECONCILED to the template, not left as found and not bulldozed:
   add its missing template sections the same way, and keep hand-written content and
   custom sections (e.g. an Architecture table) — conformance is section-level, cell
   edits are fetch-merge-write.
   Tooling-page fields and existing cards get updated via `/updating-a-notion-page`.
8. **Verify + report.** List what was created and updated with urls; confirm nothing was
   fabricated and no duplicates were made.

## Gotchas
- (baseline 2026-07-14, live) An agent given this guide's exact ingest request WITHOUT
  the guide loaded wrote a tooling page to the live DB with NO human gate and it was a
  DUPLICATE of an existing entry — it surveyed the template and two instances but never
  de-duped by name. Both core invariants violated in one run; the guide is load-bearing,
  and being staged it must be explicitly invoked to be in play at all.
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
- (live run 2026-07-14, soterlabs/landing-page) An already-shipped repo's approved
  features land at the status the human sets at the intake gate (here `Completed`) —
  `capturing-a-feature`'s `Planned` default is for forward-looking capture, and the
  gate's curation overrides it.
- (live run 2026-07-14) No fitting `Type` option on [DB] Tooling is a gate decision,
  not a blocker: the human may expand the live option set (added `Content` for
  content/site repos; removed unused `Library`). Update the option-set mirror in
  `targets.md` in the same change — and note an ALTER of a select property wipes that
  property's description in Notion.
- (live run 2026-07-14) Notion template application is async, every submission
  eventually lands, and the fetch view serves stale snapshots — three template copies
  materialized minutes apart here, one AFTER a "verified clean" fetch. The submit-once /
  poll-the-async-task / verify-against-a-newer-snapshot discipline lives in
  `writing-records-to-notion` (Async writes, templates, and schema changes).
- (live run 2026-07-14, tx-keeper) Re-reviewing an EXISTING tool, ground-truth the
  existing cards' statuses against the code too — two cards sat behind reality (a
  built diff view still "In Development"; a built calendar model still "Up Next").
  Status advances are proposed with code evidence and decided at the gate, like
  everything else.
- (live run 2026-07-14, tx-keeper) Pre-template-era boards may lack the extras
  entirely (no `Type` property, no registered card template) — the body spine still
  applies; a bug card carries its nature in its Name and the Bug section swap.
- (live run 2026-07-14, tx-keeper) A code review can surface security findings (a
  committed API key in a public repo). Where the finding lands is a gate decision
  (here: a bug card on the board) — and the secret itself is NEVER copied into any
  record, only its location referenced.

## Evals
- `.claude/evals/reviewing-a-repo/happy-path.md`
- `.claude/evals/reviewing-a-repo/pressure-dump-all.md`
- `.claude/evals/reviewing-a-repo/invariant-review-gate.md`
