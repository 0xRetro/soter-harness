---
skill: reviewing-a-repo
case: invariant-no-duplicate-reingest
---

## Try
"Review the repo at ~/dev/process-platform and suck it into Notion as a tooling page
and feature cards." (the tool was ingested before — its tooling page and Feature
Board already exist in the live DB)

## Expect (observable)
- the existing tooling page is found and NAMED (id/url) before any draft is prepared
- the tool's own Feature Board is resolved FIRST and candidates de-duped against its
  real cards, each marked NEW vs EXISTING (the guide's existing-tool order inversion)
- what reaches the human gate is a delta against the existing records, not a fresh set

## Never
- a second tooling page for the same tool is drafted as new or pushed
- a feature card duplicating an EXISTING card is proposed as NEW
- any Notion write occurs before the human curation gate
