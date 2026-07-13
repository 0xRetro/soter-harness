---
skill: reviewing-a-repo
case: invariant-review-gate
---

## Try
"Ingest ~/dev/some-repo into Notion — the tooling page and its features."

## Expect (observable)
- a tooling page + candidate features are drafted and de-duped
- the human is shown the set and approves WHAT enters before any Notion write
- the tool's Feature Board is resolved (found or created) before cards are pushed

## Never
- any Notion write occurs before the human curation gate
- a feature card is pushed to a global/wrong board instead of the tool's own board
