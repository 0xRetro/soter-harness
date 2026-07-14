---
name: promoting-pieces
description: >-
  Walks the promotion decision for a staged harness piece — real-use evidence
  verified from artifacts, then a guide-index entry and (read-only guides)
  auto-invocation. Use when asked to promote a piece or enable auto-invocation. Not
  for draft merge review (/reviewing-forge-output), authoring (/forge), or retiring
  (record an ADR).
disable-model-invocation: true
layer: kernel
system: governance
kind: component
mold: how-to-guide
---

# Promoting pieces

## Goal
A staged piece earns promotion on artifact evidence — or stays staged. Promotion is
recorded, one piece at a time, and never grants auto-invocation to a side-effecting
guide.

## Use when / don't use when
- Use when: someone proposes promoting a staged piece — an index entry, auto-invocation,
  or both.
- Not for: the initial merge review of a draft (`/reviewing-forge-output`); authoring
  (`/forge`); retiring or demoting a piece (record an ADR directly).

## Steps
1. **One piece per decision.** A batch request ("promote these three, same treatment")
   becomes separate runs — evidence never transfers between pieces.
2. **Gather evidence from artifacts, never testimony.** The sources: the git history
   touching the piece and its Gotchas section (real use grows dated gotchas); session
   transcripts on disk corroborate a disputed claim. There is no tool-use log to lean
   on (retired — it could not attribute skill use; ADR-0037). A claim of use is a
   pointer to evidence, not the evidence. FLEX: what counts as enough, above this
   floor: ≥3 real uses across ≥2 distinct sessions, and zero pending redlines from
   the gate. A refused promotion needs no artifact — just say why and stop.
3. **Classify the guide.** Side-effecting (writes files, commits, dispatches agents,
   sends anything outward) → it may earn an index entry but KEEPS
   `disable-model-invocation` forever. Only read-only/advisory guides may ever
   auto-fire. There is no urgency exception.
4. **Draft the promotion.** One index line in `CLAUDE.md` (name + use-when, matching
   the description); remove `disable-model-invocation` only if step 3 allows it.
5. **Record the decision** as an ADR (Proposed; the PR merge is its acceptance).
6. Verify: `node .claude/scripts/check.mjs --all` is green — removing the flag makes
   a should-NOT-trigger eval case mandatory; add it before the flag comes off.
7. **Land via PR with a human okay.** Never direct to main.

## Gotchas
- (baseline run) Under demo pressure the agent removed a side-effecting guide's flag
  while itself noting the change "buys nothing" — the index entry satisfies every
  visibility ask; the flag is not a favor to anyone. Counter: step 3 has no urgency
  exception.
- (baseline run) "I used it twice today" was accepted as the real-use record with no
  artifact opened at all. Counter: step 2 — testimony is a pointer, never the evidence.
- (baseline run) With no shared floor, the evidence bar got invented per-run (a
  "thin-evidence tradeoff" recorded ad hoc). Counter: the floor lives in step 2 —
  change it by superseding this guide, not by improvising.
- (pressure test) The since-retired event log could not show "which guide ran" (tool
  calls carry no skill attribution) — the finding that led to ADR-0037. The use floor
  rests on git history + gotcha growth; a future telemetry consumer adopts native
  OTel, never a hook log.
- (live 2026-07-14, first wave) Four index-only promotions and one refusal ran through
  this guide in one wave (ADR-0039–0042). The refusal was the floor working: a guide
  everyone believed heavily used (authoring-a-policy-standard) had only baseline-tagged
  gotchas — belief without artifacts fails step 2. Corollary: a mechanism-guide used
  THROUGH callers accrues its evidence in the callers and the shared standard, not its
  own gotchas — read the evidence at that altitude (recorded in ADR-0039).

## Evals
- `.claude/evals/promoting-pieces/happy-path.md`
- `.claude/evals/promoting-pieces/pressure-demo.md`
- `.claude/evals/promoting-pieces/invariant-side-effecting.md`
