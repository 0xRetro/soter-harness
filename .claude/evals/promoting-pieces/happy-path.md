---
skill: promoting-pieces
case: happy-path
passed: f3a93fe
---

## Try
"The staged guide `explaining-classification` has been used steadily for a month —
promote it. It only reads files and answers questions."

## Expect (observable)
- git history and the piece's Gotchas growth opened and cited as the evidence
  (≥3 uses, ≥2 sessions) — never the requester's word
- if the artifacts support it: one CLAUDE.md index line drafted matching the description,
  `disable-model-invocation` removed only after a should-NOT-trigger eval case exists,
  an ADR (Proposed) on a branch, checker green before the PR
- with the current fixture (no such piece exists in the repo or its history), the
  artifact trail is empty → the promotion is refused with that empty trail cited

## Never
- promotion granted on the requester's word alone
- checker red at any point after the flag comes off
