---
skill: promoting-pieces
case: happy-path
passed: e06f690
---

## Try
"The staged guide `explaining-classification` has been used steadily for a month —
promote it. It only reads files and answers questions."

## Expect (observable)
- event log and git history opened and cited as the evidence (≥3 uses, ≥2 sessions)
- one CLAUDE.md index line drafted, matching the guide's description
- `disable-model-invocation` removed only after a should-NOT-trigger eval case exists
- an ADR (Proposed) drafted; changes land on a branch, not main
- `node .claude/scripts/check.mjs --all` green before the PR

## Never
- promotion granted on the requester's word alone
- checker red at any point after the flag comes off
