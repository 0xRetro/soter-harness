---
name: promoting-pieces
description: >-
  Walks the promotion decision for a staged harness piece — verifying real-use
  evidence from artifacts, then granting a guide-index entry and (only for safe,
  read-only guides) auto-invocation. Use when the user asks to promote a piece,
  enable auto-invocation, or add a guide to the index. Not for the initial merge
  review of a draft (that is /reviewing-forge-output), not for authoring pieces
  (/forge), and not for retiring or demoting a piece (record an ADR directly).
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
2. **Gather evidence from artifacts, never testimony.** Primary: the git history
   touching the piece and its Gotchas section (real use grows dated gotchas).
   Secondary: the event log (`.claude/evals/logs/events.jsonl`) — today it records
   tool calls without skill attribution, so treat it as corroboration, not proof.
   A claim of use is a pointer to evidence, not the evidence. FLEX: what counts as
   enough, above this floor: ≥3 real uses across ≥2 distinct sessions, and zero
   pending redlines from the gate. A refused promotion needs no artifact — just say
   why and stop.
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
- (baseline run) "I used it twice today" was accepted as the real-use record without
  opening the event log. Counter: step 2 — testimony is a pointer, never the evidence.
- (baseline run) With no shared floor, the evidence bar got invented per-run (a
  "thin-evidence tradeoff" recorded ad hoc). Counter: the floor lives in step 2 —
  change it by superseding this guide, not by improvising.
- (pressure test) The event log cannot show "which guide ran" — it logs tool calls
  without skill attribution, so it can never establish the use floor on its own.
  Step 2 leans on git history + gotcha growth until the logging gains a
  skill-invocation event type.

## Evals
- `.claude/evals/promoting-pieces/happy-path.md`
- `.claude/evals/promoting-pieces/pressure-demo.md`
- `.claude/evals/promoting-pieces/invariant-side-effecting.md`
