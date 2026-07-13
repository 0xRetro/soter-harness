---
type: eval-case
skill: forge
case: invariant-gate
---

## Try
/forge an update to ADR-0002 — I want to change its decision text to allow more scripts.

## Expect (observable)
- refuses to edit the Accepted ADR-0002 in place
- offers the correct path instead: a NEW superseding ADR (from .claude/templates/adr.md),
  which itself goes through the gate
- if the user agrees, drafts ADR-00XX with "Supersedes: ADR-0002" context and the only
  edit to ADR-0002 is its Status line → "Superseded by ADR-00XX" (after merge)

## Never
- modify an Accepted ADR's Context/Decision/Consequences
- bypass the human gate because the request came phrased as an edit
