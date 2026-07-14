---
name: reviewing-forge-output
description: >-
  Walks the human gate for a forge-drafted piece — everything to verify beyond the
  checker before saying merge. Use when a forge run reaches its gate, the user asks to
  review a drafted guide, rule, or standard, or before promoting a staged piece. Not
  for authoring (/forge) or mechanical shape checks (the checker owns those).
disable-model-invocation: true
layer: kernel
system: governance
kind: component
mold: how-to-guide
---

# Reviewing Forge output

## Goal
A merge decision made on evidence: the piece is stranger-readable, territory-clean,
honestly tested, and free of bait artifacts — or it goes back to the Forge with
specific redlines.

## Use when / don't use when
- Use when: a forge run reaches its human-gate step, or a staged piece is up for review.
- Not for: authoring or fixing the piece itself (that's /forge); the mechanical floor
  (Checker); the separate promotion decision after real use.

## Steps
1. **Mechanical floor.** `node .claude/scripts/check.mjs --all` green and selftest passing.
   Not green → back to the Forge; review hasn't started.
2. **Stranger read.** Read only the frontmatter description: does it say what, when,
   and not-for? Would you pick this piece from its one index line alone?
3. **Exclusion sweep — both directions.** (a) Clauses: no two pieces may both claim —
   or both disclaim — the same territory. (b) Content: scan the draft's *steps* for
   trespass — a step doing a neighbor's job (e.g. "record decisions in the summary")
   is a conflict even when the clauses look clean.
4. **Eval quality.** ≥3 cases; the pressure case genuinely tempting (stakes + a
   permitted shortcut), Expects observable, Nevers meaningful.
5. **Evidence, not testimony.** Verify the pressure-test verdict from the artifacts
   the test left (files, the run's transcript) — never from the testing agent's
   self-report alone.
6. **Bait sweep.** Hunt for test artifacts that aren't genuinely true (fake decisions,
   fixture files) and revert them. Tests write real files (Forge gotcha, run 1).
7. **Rework tally.** Note every fix needed beyond review comments — recorded in the
   piece's Gotchas so the pattern is visible next time.
8. **Verdict.** Merge (lands staged) / redline (back to the Forge with specifics) /
   reject. FLEX: quality judgment on steps 2 and 4 — but steps 1, 3, and 6 are
   non-negotiable floors.

## Gotchas
- 2026-07-09 (first pressure test): a reviewer following "check exclusion clauses"
  verified clause *presence* but missed content-level trespass (a step quietly doing a
  neighbor's job). Step 3 now demands both directions: clauses AND steps.

## Evals
- `.claude/evals/reviewing-forge-output/happy-path.md`
- `.claude/evals/reviewing-forge-output/pressure-rubberstamp.md`
- `.claude/evals/reviewing-forge-output/invariant-floor.md`
