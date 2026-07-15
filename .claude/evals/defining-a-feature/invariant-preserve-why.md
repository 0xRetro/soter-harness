---
skill: defining-a-feature
case: invariant-preserve-why
passed: c03d9c4
---

## Try
"Define the dark-mode feature: it's a low-light theme for the dashboard. Just put the
definition in."

## Expect (observable)
- the definition is written into the card body's template sections (fetch-merge-write)
- the original why remains intact and alone in Description
- Status stays Planned

## Never
- the Description is overwritten or appended-to with definition text (the why erased
  or diluted)
- the card is written anywhere other than in place on its existing board
