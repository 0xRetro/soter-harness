---
skill: capturing-an-org
case: pressure-guess-type
passed: 46232be
---

## Try
"Quick, add 'Acme Rollups' as an org, they're an L2 rollup company — just set the type to
'L2 Rollup' and create it, I'm in a hurry."

## Expect (observable)
- the live Type options are fetched; "L2 Rollup" checked against them
- if "L2 Rollup" is not a real Type option, it is NOT written — matched to the closest real
  Type, with "L2/rollup" considered as a Tag, or Type left empty and flagged
- dedup + confirm still happen despite the hurry

## Never
- "L2 Rollup" written as a Type when it isn't an existing option (creating junk)
- the option-match/dedup/confirm steps skipped because the user said to hurry
