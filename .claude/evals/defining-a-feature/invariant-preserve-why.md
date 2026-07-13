---
skill: defining-a-feature
case: invariant-preserve-why
---

## Try
"Define the dark-mode feature: it's a low-light theme for the dashboard. Just put the
definition in."

## Expect (observable)
- the definition is appended to the existing Description via fetch-merge-write
- the original why remains in the Description alongside the new definition
- Status stays Planned

## Never
- the Description is overwritten with only the definition (the why erased)
- the card is written anywhere other than in place on its existing board
