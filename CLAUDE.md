# Soter Harness (kernel)

This repo IS the harness: the kernel systems, molds, and light wiring that make
Claude work consistently and help build more of itself — plus the declared add-ons
that stack on top. Generic pieces (kernel · core) stay generic; org- or vendor-specific
pieces live here too, declared `layer: context` or `layer: automation` (ADR-0012).
Docs: `README.md` (the map) · `.claude/LEXICON.md` (terms + classification) ·
`.claude/systems/` (one card per system) · `.claude/RUBRIC.md` (quality bar) ·
`decisions/` (why things are the way they are).

## Always / Never

- ALWAYS start a new harness piece by copying its mold from `.claude/templates/`.
- ALWAYS declare classification frontmatter (`layer · system · kind · mold`) on
  durable content pieces; the checker validates all four.
- ALWAYS pass every item of `.claude/RUBRIC.md` before merging a new or changed piece.
- ALWAYS get a human okay before a harness change lands — normally a PR; the sole
  exception is an ADR recording a decision the human just accepted in-session (that
  approval IS the gate; see `/writing-adrs`). Never self-merge unreviewed work.
- ALWAYS record decision rationale as an ADR in `decisions/` — never inline it.
- ALWAYS use the LEXICON's term for a concept; NEVER introduce a synonym.
- ALWAYS give a new guide an exclusion clause and ≥3 eval cases (one a pressure case).
- NEVER write a script when prose can do the job; when code is truly needed, extend
  the one shared checker — never add a per-rule script.
- Generic pieces (kernel · core) stay generic; org- or vendor-specific pieces are
  declared `layer: context` or `layer: automation` and live as modular add-ons (ADR-0012).
- NEVER exceed the budgets: this file < 200 lines; a guide body < 500 lines;
  a description ≤ 1024 chars.
- NEVER let a failing eval or checker merge; fix the piece or fix the mold.
- NEVER edit an Accepted ADR (supersede it).
- If work here starts feeling like maintaining machinery instead of using it, STOP
  and flag it — that is the failure signal.

## Guide index

<!-- One line per promoted guide. Staged guides are deliberately not indexed;
     the full invocable list is `ls .claude/skills/`. -->
- `/forge` — authors a new harness piece through the loop: mold → evals →
  checks → gate. Always user-invoked.
- `/writing-adrs` — records a durable decision as an ADR in `decisions/`. Always
  user-invoked. (ADR-0018)
- `/reviewing-a-repo` — ingests a code repo into Notion as a tooling page + curated
  feature cards, human-gated. Always user-invoked (side-effecting). (ADR-0024)
- `/capturing-a-feature` — captures one idea as a Feature Board card: why in
  Description, template-shaped body. Always user-invoked (side-effecting). (ADR-0025)
- `/running-evals` — runs an eval scenario as a fresh-context, write-contained
  subagent; verdicts from artifacts, goldens recorded. Always user-invoked
  (side-effecting). (ADR-0033)
- `/pushing-to-notion` — pushes a structured artifact to a Notion database as a new
  typed page, human-confirmed before the write. Always user-invoked (side-effecting). (ADR-0039)
- `/updating-a-notion-page` — updates an existing Notion page fetch-merge-write,
  named properties only, human-confirmed. Always user-invoked (side-effecting). (ADR-0040)
- `/auditing-a-schema-doc` — audits a schema doc + targets mirror against the live
  DB, drift reconciled through a human gate. Always user-invoked (side-effecting). (ADR-0041)
- `/capturing-a-task` — captures an actionable item as a [DB] Tasks row, relations
  resolved never fabricated, confirmed before the write. Always user-invoked
  (side-effecting). (ADR-0042)

## Layout

**`.claude/` = the harness** (ships and runs): `systems/` one card per system ·
`templates/` molds · `skills/` guides · `standards/` the bar · `evals/` cases ·
`rules/` always-on · `scripts/` the one checker · `LEXICON.md` · `RUBRIC.md`.
**Root = the workshop** (for humans): `README.md` the map · `decisions/` ADRs ·
this file. The plugin root IS `.claude/`. A piece's system is declared in its
frontmatter — never implied by its folder.

## Check anything

`node .claude/scripts/check.mjs --all` (same check CI runs) · `--selftest` proves
the checker itself.
