---
name: auditing-a-schema-doc
description: >-
  Audits a database's schema doc (a Notion "[DB] X Standards" page) against the live
  schema and reconciles drift through a human gate — diffing fields by option and type,
  distinguishing renames from deletions, quarantining not-yet-built fields, and correcting
  a false "consistent" callout with surgical edits. Use when the user wants to audit,
  reconcile, or fix a DB's schema doc, or check one for drift. Not for writing records
  (the capturing guides) or the write mechanics (/updating-a-notion-page).
disable-model-invocation: true
layer: automation
system: schema-audit
kind: component
mold: how-to-guide
---

# Auditing a schema doc

## Goal
A schema doc reconciled to the live DB — every field diffed, renames confirmed not assumed,
not-yet-built fields quarantined not deleted, the callout made true — via surgical,
human-gated edits that leave the doc's other sections untouched.

## Use when / don't use when
- Use when: checking or reconciling a DB's schema doc against its live schema.
- Not for: writing records (the `capturing-*` guides); the write mechanics
  (`/updating-a-notion-page`); editing the doc's prose sections (Purpose/Views/Templates).

## Steps
Any write follows the **`writing-records-to-notion`** standard
(`.claude/standards/writing-records-to-notion.md`) — confirm, then write via the update
binding. Audit-specific:
1. **Fetch BOTH live** — the live DB schema AND the schema doc's documented fields. Never
   diff against a cached/assumed schema (ADR-0016). A self-attesting "✅ Consistent"
   callout is exactly what the audit exists to falsify — never trust it as evidence.
2. **Diff every field, both directions, by PROPERTY ID not label.** For
   select/status/multi_select, compare the OPTION SETS option-by-option (a field named
   identically — e.g. `Status` — can still have different options; comparison is
   case-sensitive). Classify each field: match · missing-from-doc · extra-in-doc ·
   type/option/writability mismatch · rename-candidate.
3. **Renames need confirmation.** A label-only match (`Assignee`↔`Assigned To`) or a
   same-type/different-meaning pair (`Due`↔`Next Action`) is a CANDIDATE, not a fact —
   compare property IDs where available; ask the human, don't silently equate them.
4. **Never silent-delete an "extra" doc field.** A doc field absent from live may be
   roadmap intent (Priority/Tag/Summary) — quarantine it to a clearly-labeled "Documented
   but not built" area; only the human decides a real deletion.
5. **Record writability + type.** A read-only/rollup field documented as a writable
   relation misleads every downstream writer — mark writability, not just type. Decide once
   (with the user) whether auto fields (Created/Last edited) are documented at all.
6. **Report + propose surgical edits.** Present the full diff. Propose edits to the Fields
   section ONLY (leave Purpose/Views/Templates untouched) plus correcting the callout to
   the truth ("⚠️ Drifted — N fields out of sync; re-audited `<date>`"). Sweep the
   non-field sections for references to dead fields (a view grouped by a deleted field) and
   flag them — don't edit them here.
7. **Reconcile on the human okay** — via `/updating-a-notion-page` (fetch-merge-write,
   surgical). Never overwrite the whole page. Under "don't make me review" pressure, keep
   the gate but make it cheap: present a tight summary + only the decisions that actually
   need a human (rename confirmations, delete-vs-quarantine) — not a wall of diff.

## Gotchas
- (baseline) `Status` "matches" by name but not options — compare option sets
  option-by-option, case-sensitive; name-only matching hides the worst drift.
- (baseline) Rename vs delete+add is unknowable from labels alone — use property IDs; a
  label match is a candidate to confirm, and same-type/different-meaning (Due↔Next Action)
  is the trap.
- (baseline) Never silent-delete an "extra" field — it may be roadmap; quarantine it.
- (baseline) A false "✅ Consistent" callout must be corrected — non-optional; left alone
  it actively lies to the team.
- (baseline) Surgical edits only — rewriting the Fields table clobbers the doc's other
  sections.
- (live run 2026-07-13, real Tasks + Projects docs) `updating-a-notion-page`'s
  `update_content` does true surgical search-replace — proven end-to-end on a FULL
  reconciliation of two real docs: field-row removes/adds, whole option-table swaps, and
  prose fixes all matched the fetched `<td>...</td>` table format, and every unrelated
  section stayed byte-for-byte. Batch many edits in one call (atomic — one mismatch fails
  the whole call, so no half-writes). Caveat: it edits TEXT, not a callout's color/type —
  a green "✅" callout can be made to SAY "⚠️ Drifted" yet stays green; note the color
  caveat or use block-level ops to recolor.

## Evals
- `.claude/evals/auditing-a-schema-doc/happy-path.md`
- `.claude/evals/auditing-a-schema-doc/pressure-overwrite.md`
- `.claude/evals/auditing-a-schema-doc/invariant-no-silent-delete.md`
