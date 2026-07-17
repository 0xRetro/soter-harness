# Soter Harness (kernel)

This repository contains a working Claude-oriented prototype and the
provider-neutral Soter target implementation. The target has five layers:
kernel, core, context, automation, and integration. Codex and Claude are hosts,
not layers.

Target source of truth: `README.md` · `ARCHITECTURE.md` · `CONTRACTS.md` ·
`soter/`. The `.claude/` tree remains the legacy implementation and compatibility
bridge until its artifacts are explicitly migrated or retired. `decisions/` is a
historical archive, not mandatory ceremony for target development.

## Always / Never

- For a legacy `.claude/` piece, start from its `.claude/templates/` mold and
  declare classification frontmatter (`layer · system · kind · mold`). For a
  target piece, start from its versioned contract and owning pack manifest.
- ALWAYS pass every item of `.claude/RUBRIC.md` before merging a new or changed piece.
- ALWAYS get a human okay before a harness change lands — normally a PR. Never
  self-merge unreviewed work.
- ALWAYS make a target change explain itself through its contract, scenario,
  migration entry, verification evidence, and git history. Create a separate
  decision note only for a rare cross-cutting choice described by
  `ARCHITECTURE.md`; do not create an ADR by default.
- ALWAYS use the LEXICON's term for a concept; NEVER introduce a synonym.
- ALWAYS give a new guide an exclusion clause and ≥3 eval cases (one a pressure case).
- NEVER add a per-rule validation script. Extend the legacy shared checker for
  legacy rules, the Kernel verifier for target governance, or a versioned Core
  operation for portable runtime behavior.
- Generic pieces (kernel · core) stay generic; domain meaning belongs to context,
  outcomes belong to automation, and provider behavior belongs to integration.
- `.soter/state` is private ignored runtime state. Resume pending provider work
  from its exact checkpoint ID; never stage or reconstruct it from chat memory.
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
- `/writing-adrs` — legacy ADR workflow; use only when the user explicitly asks
  to add to the historical decision format.
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
- `/promoting-pieces` — walks the promotion decision for a staged piece: real-use
  evidence from artifacts, then an index entry; side-effecting guides never auto-fire.
  Always user-invoked (side-effecting). (ADR-0056)

## Layout

**`.claude/` = the working prototype** (ships and runs): `systems/` one card per system ·
`templates/` molds · `skills/` guides · `standards/` the bar · `evals/` cases ·
`rules/` always-on · `scripts/` the one checker · `LEXICON.md` · `RUBRIC.md`.
**`soter/` = the target implementation:** versioned contracts · packs ·
capabilities · configurations · scenarios · migrations · target Kernel · Core
operations and fixtures.
**Root = the workshop:** architecture docs · the historical `decisions/` archive ·
host projections such as this file and `AGENTS.md`. The Claude plugin root remains
`.claude/` during migration.

## Check anything

`node .claude/scripts/check.mjs --all` protects the legacy implementation.
`node soter/kernel/verify.mjs` protects the target contracts and reports
valid/ready/verified/healthy separately. `node soter/core/cli.mjs fixtures
--check` proves the checked-in Core lock and preflight evidence are current. CI
runs all three boundaries during migration.
