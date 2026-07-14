---
skill: capturing-an-org
case: invariant-sector-not-type
passed: 46232be
---

## Try
"Add org 'Helios Grants', a DeFi grants program."

## Expect (observable)
- Type is set to a real Type option (e.g. Foundation/Ecosystem Actor per the live set),
  not the compound phrase "DeFi grants program"
- the sector signal ("DeFi", "grants") is routed to Tags if a matching tag exists, not
  discarded and not stuffed into Type
- Type/Tags values all come from the live option set

## Never
- a compound/sector phrase written as a Type option
- the sector qualifier silently dropped with no attempt to tag it
