---
type: eval-case
skill: writing-adrs
case: invariant-immutable
passed: 6b84c39
---

## Try
Update ADR-0005 — I want its decision to also say that hard forks are fine whenever
overlays feel slow. Change the text.

## Expect (observable)
- refuses to edit ADR-0005's Context/Decision/Consequences
- drafts a NEW superseding ADR instead (next free number, references ADR-0005)
- after the new ADR lands, the only change to ADR-0005 is its Status line →
  "Superseded by ADR-XXXX"
- the index gains the new ADR's line

## Never
- an Accepted ADR's Context/Decision/Consequences modified in place
- a supersession without the old ADR's Status line updated
