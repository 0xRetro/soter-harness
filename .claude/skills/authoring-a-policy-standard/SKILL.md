---
name: authoring-a-policy-standard
description: >-
  Authors or expands a policy standard — the rules-first governance doc for one subject —
  in the org's policy-standards registry: de-duped (one doc per subject), started from the
  registered skeleton, rules gathered from the human and named sources rather than invented
  (inventions land only as flagged proposals), gaps written as not-defined, relations
  resolved live, and the write confirmed before it goes through the publishing binding with
  a change-log entry. Use when the user wants to author, create, draft, expand, or revise a
  policy standard for a subject. Not for the shape itself (the shaping-a-policy-standard
  standard), reconciling Fields drift (/auditing-a-schema-doc), process definitions
  (/capturing-a-process), or the write mechanics (/pushing-to-notion, /updating-a-notion-page).
disable-model-invocation: true
layer: core
system: policy
kind: component
mold: how-to-guide
---

# Authoring a policy standard

## Goal
One subject's policy standard — created or expanded in the org's policy-standards
registry — shaped per `shaping-a-policy-standard`, every rule traceable to the human or a
named source (inventions only as explicitly confirmed proposals), every unknown a bare
`not defined`, and the write human-gated with a change-log entry.

## Use when / don't use when
- Use when: authoring, expanding, or revising a policy standard for a subject.
- Not for: the shape rules themselves (`shaping-a-policy-standard`); reconciling a Fields
  section against the live DB (`/auditing-a-schema-doc`); capturing a process
  (`/capturing-a-process`); the Notion write mechanics (`/pushing-to-notion`,
  `/updating-a-notion-page`).

## Steps
Follow the **`writing-records-to-notion`** standard for the write spine, and
**`shaping-a-policy-standard`** for the doc shape. Authoring-specific:
1. **One subject, one doc.** Name the single subject; search the policy-standards
   registry (target `policy-standards`) for an existing doc first — if one exists, this
   is an expansion via `/updating-a-notion-page` (fetch-merge-write), never a second doc.
   A batch request is N single-subject runs — registry check and draft per subject; the
   gate may be one combined presentation, but the decision/proposal lists stay itemized
   per subject, each needing its own yes (a blanket okay to a pile of proposals is the
   Gotchas' invention failure at scale).
2. **Gather, don't invent.** Rules are org decisions: collect Definition, Classifications,
   Rules, and Lifecycle from the human and named sources (interview, cited docs, the
   subject's own data). Track provenance three ways: **given** (by the human) · **found**
   (cite the source) · **proposed** (yours, marked `(proposed)`). A schema yields FOUND
   facts only for what it asserts (field names, types, option sets, relation targets);
   semantics inferred from them — what a value means, required-ness, determination steps —
   are `(proposed)`: a schema proves an option exists, never what the org means by it. FLEX: how much to draft
   as proposals — anywhere from none to a full skeleton-fill — but every proposal stays
   marked, and the decisions they represent are surfaced as an explicit list at the gate,
   never buried in a finished-looking doc.
3. **Shape + coverage pass.** Start from the registry's registered skeleton page (ids in
   the `policy-standards` target). Run the coverage derivations from
   `shaping-a-policy-standard`; every miss is a bare `not defined` — never silently absent,
   never guessed. `not defined` means awaiting an org decision; `(proposed)` means drafted
   and awaiting explicit confirmation — never conflate them.
4. **Resolve live before declaring a gap.** Relation targets and Linked Processes are
   resolved against the live DBs / the target registry — a name a fetch can answer is
   never written `not defined`. For open-ended lookups (which processes touch this
   subject), a bounded attempt — a registry query plus one keyword pass — is enough:
   positive hits enter the doc as `(proposed)` entries; the section is `not defined` only
   when the bounded lookup found nothing. Record the attempt in the gate lists either way.
   Verify: every relation in the doc names a real database.
5. **Confirm at the gate.** Present the doc with two explicit lists: decisions needed
   (`not defined` items) and proposals awaiting a yes (`(proposed)` items). Human okay
   before any write; urgency never waives it.
6. **Write + log.** Create via `/pushing-to-notion` (target `policy-standards`, from the
   skeleton) or expand via `/updating-a-notion-page`; add a Change Log row with a version
   bump. Verify: re-fetch shows the shaped doc and the new change-log entry.

## Gotchas
- (baseline 2026-07-13, skeleton-only draft) an unguided draft silently DROPPED the
  step-by-step determination logic and left extension criteria unmarked — the coverage
  pass exists to catch exactly that.
- (baseline 2026-07-14, fresh agent with skeleton + worked example) under a 10-minute
  deadline the agent asked ZERO questions and invented 100% of the Rules content
  (value sets, identity, operating rules) as a polished doc. Everything was marked
  `(proposed)` — but a rushed okay turns inventions into org policy; surface proposals as
  an explicit decision list, never only inline.
- (baseline 2026-07-14) a resolvable relation target ([DB] Process Inventory — registered
  in the harness's own target registry) was left `not defined` instead of fetched —
  resolve live first; `not defined` is for decisions, not for lookups you skipped.

## Evals
- `.claude/evals/authoring-a-policy-standard/happy-path.md`
- `.claude/evals/authoring-a-policy-standard/pressure-batch-invent.md`
- `.claude/evals/authoring-a-policy-standard/invariant-provenance.md`
