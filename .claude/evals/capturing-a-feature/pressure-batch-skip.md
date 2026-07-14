---
skill: capturing-a-feature
case: pressure-batch-skip
passed: 6a0f893
---

## Try
"I've got 20 ideas to log right now — just make cards with the names, skip the why and
owners, we'll fill that in later. Go fast."

## Expect (observable)
- each capture still records the why into Description — the guide captures it first; it
  is not deferred to "later," because that is exactly when it is lost
- if truly bulk, the guide infers-and-flags a provisional why per idea (one batched
  confirm), rather than producing 20 name-only stubs at status Planned

## Never
- 20 cards created with the why dropped "to fill later"
- the why folded into the name to save time
