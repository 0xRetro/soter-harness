---
name: forge
description: >-
  Authors a new harness piece at any layer — guide, house rule, standard, or mold —
  from its mold, with eval cases, a pressure test, and the human gate. Use when the
  user says forge, or asks to create or add a guide, rule, standard, or add-on to the
  harness. Not for editing existing pieces, recording a standalone decision
  (/writing-adrs), inlining org data into a generic piece, or bulk changes.
disable-model-invocation: true
layer: kernel
system: authoring
kind: component
mold: how-to-guide
---

# Forge — authoring a harness piece

## Goal
A new piece merged **staged**: template-shaped, Checker-clean, with ≥3 eval cases
(one a pressure case), pressure-tested by fresh eyes, and human-approved.

## Use when / don't use when
- Use when: the user invokes `/forge` to add a guide, rule, standard, or mold.
- Not for: editing existing pieces (small edits go straight to a PR); standalone
  decisions (`/writing-adrs` — though a forge run may *produce* ADRs along the way);
  inlining org-specific data into a generic kernel/core piece (keep those generic —
  context/automation add-ons ARE forgeable, ADR-0012); bulk operations (needs a plan first).

## Steps
1. **Clarify.** Classify first — run the classification rule in `.claude/LEXICON.md`
   (kind · system · layer · mold) — then name and scope. Ask only what's unclear.
   FLEX: naming and scope, within `.claude/rules/authoring.md` conventions.
2. **Territory check.** Read the CLAUDE.md guide index and every existing piece's
   exclusion clause. Overlap found → stop and propose extending that piece instead.
3. **Sandbox.** Create a worktree on branch `forge/<name>`. Nothing touches main.
4. **Baseline (RED).** Before drafting, dispatch a fresh-context subagent on the
   pressure scenario *without* the piece. Record what it actually does wrong and the
   rationalizations it produces. No observed failure → stop: the piece may not be
   needed. ("If you didn't watch an agent fail without it, you don't know it teaches
   the right thing.")
5. **Draft.** Copy the mold from `.claude/templates/`, fill every section, delete all
   hints. Follow `.claude/RUBRIC.md`. The draft must counter the baseline's observed
   rationalizations — list them in Gotchas with counters. Rationale that needs
   preserving → a new ADR, not prose.
6. **Evals.** For a **guide**, write ≥3 cases in `.claude/evals/<name>/`: happy path,
   **pressure case** (realistic stakes tempting a shortcut), invariant ("must never").
   Rules, standards, and molds carry no eval requirement — their shape IS the check
   (see the placement table in `.claude/LEXICON.md`).
7. **Check.** Run `node .claude/scripts/check.mjs --all`; fix until 0 errors.
8. **Pressure-test.** Dispatch a **fresh-context subagent** with only the draft and
   the pressure scenario — never the drafting conversation. Verify it *uses* the
   piece and *complies* with its steps. Confusion or noncompliance → fix the draft,
   record the gotcha, re-test.
9. **Human gate.** Present: the draft, the baseline (RED) evidence, the eval list, and
   the pressure-test result. Redlines → apply, re-run steps 7-8, re-present. Okay →
   merge, remove worktree.
10. **Land staged.** The new piece keeps `disable-model-invocation: true` and stays
   out of the guide index. Promotion (auto-invocation + index entry) happens only
   after it proves itself in real use — a separate, explicit decision.

## Verification
Merged piece passes `check.mjs --all`; its eval cases exist; the pressure-test
transcript showed compliance; the human okay is the merge itself (git provenance).

## Gotchas
- 2026-07-09 (run 1, writing-adrs): the Checker's placeholder scan can false-positive on
  strings that are notation in one context and mold-residue in another (e.g. "ADR-XXXX"
  in a guide about ADRs). Fix the Checker's scoping; don't contort the draft's wording.
- 2026-07-09 (run 1): pressure/invariant tests leave REAL artifacts in the worktree — a
  compliant agent will faithfully write the test's bait content into live files (a fake
  decision nearly entered the log). Before merge: revert bait artifacts, keep only ones
  that are genuinely true. Better: make test scenarios out of real work you want anyway.
- Timing note: step 3 creates the worktree *before* drafting (sandbox-first) —
  deliberate; nothing should ever draft on main.

## Evals
- `.claude/evals/forge/happy-path.md`
- `.claude/evals/forge/pressure-shortcut.md`
- `.claude/evals/forge/invariant-gate.md`
