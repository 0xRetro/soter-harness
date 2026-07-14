---
name: red-teaming-a-process
description: >-
  Red-teams a documented process: a fresh read-only agent sweeps five lenses —
  operator execution, adversarial, consistency, completeness, failure paths — and
  findings come back verified, ranked, and reported, never silently fixed. Use when
  the user says red-team, stress-test, or review a process before it goes Active.
  Not for schema-doc audits, harness-piece reviews, or editing the process itself.
disable-model-invocation: true
layer: context
system: process
kind: component
mold: how-to-guide
---

# Red-teaming a process

## Goal
Ranked, verified findings (critical / should-fix / nice-to-have) on one documented
process — every formally-compliant path to a bad outcome named, every blocking gap
surfaced — reported for decisions, not silently fixed.

## Use when / don't use when
- Use when: the user asks to red-team, stress-test, or review a process; a process is
  about to move In Review → Active (this review is that gate's mechanism).
- Not for: auditing a schema doc against its live DB (`auditing-a-schema-doc`);
  reviewing forge output (`reviewing-forge-output`); capturing or editing a process
  (`capturing-a-process` / a normal edit); red-teaming harness pieces (the forge's
  pressure-test owns that).

## Steps
1. **Scope the target.** Collect the source set: the process doc, every policy standard
   its subjects touch, the live schemas of every DB it writes, one real run if any
   exists, and the shaping standard. FLEX: which policies are in scope — bounded by
   what the process doc and its records actually reference.
2. **Dispatch a fresh read-only agent** with the source set and the five lenses,
   verbatim: (1) OPERATOR EXECUTION — could a competent operator complete a run from
   the doc alone, without guessing? (2) ADVERSARIAL — how could a malicious
   counterparty or insider reach the process's success state while formally complying?
   (3) CONSISTENCY — contradictions across doc, policies, live schemas, and runs.
   (4) COMPLETENESS — referenced-but-undefined pieces, `not defined` gaps that BLOCK
   execution, ungoverned live fields, unimplemented doc claims. (5) FAILURE PATHS —
   Failed/Aborted runs, replacements, expiry: is every state derivation safe? Require
   ranked findings with exact locations and proposed fixes. The agent gets NO external
   write tools (use the read-only agent type) — a leaked write must surface as a
   denied call, never live damage.
3. **Verify before reporting.** Spot-check every critical finding (and any finding that
   drives a schema or policy change) against the live source it cites. Drop or
   downgrade what does not reproduce.
4. **Report, don't fix.** Deliver the ranked findings with proposed fixes and what held
   up. Fixes are decisions for the human: only mechanical alignments where an approved
   policy already defines the value (e.g. a live select missing policy-defined options)
   may proceed, each named in the report. Never rewrite the process doc from findings
   without explicit direction.
5. **Route what was decided.** Findings the user accepts land in their proper homes —
   a policy rule, a process work-item, a `not defined` entry, a schema change — per the
   normal capture and policy disciplines.
6. Verify: the findings list is ranked, every reported critical was reproduced in step
   3, and the target process and its records are byte-identical to before the review
   (read-only held).

## Gotchas
- (live 2026-07-14, penny test run 1) An unguided "review this process" pass reads only
  the doc and reports style/clarity notes — the adversarial and derivation-safety holes
  (three formally-compliant paths to a fraudulent Verified address) only surfaced with
  the lenses and the full source set. The lenses are the value; never dispatch bare.
- (live 2026-07-14) Findings can overstate: the same run flagged real criticals AND
  details needing correction (a cross-reference the doc had already fixed). Step 3's
  reproduce-before-report exists because of this.
- (live 2026-07-14) The reviewing agent will happily propose fixes bundled as findings —
  keep the report/decide/route separation or the review becomes an unreviewed rewrite.

## Evals
- .claude/evals/red-teaming-a-process/happy-path.md
- .claude/evals/red-teaming-a-process/pressure-autofix.md
- .claude/evals/red-teaming-a-process/invariant-read-only.md
