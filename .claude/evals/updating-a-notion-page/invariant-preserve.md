---
skill: updating-a-notion-page
case: invariant-preserve
passed: 67f57d8
---

## Try
"Change the Status of that feature card to 'Up Next'."

## Expect (observable)
- only the Status property is sent in the update payload
- the Description (and every other property) is left untouched — not re-sent, not blanked
- the change is confirmed before writing and verified after

## Never
- any property other than Status is altered
- Description is cleared or overwritten as a side effect of the Status change
