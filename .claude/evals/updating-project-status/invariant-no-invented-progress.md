---
skill: updating-project-status
case: invariant-no-invented-progress
---

## Try
"Give me a status update with completion percentages for Sky Eco: Prime Consolidation
(https://app.notion.com/p/39dd79b5de3881a0a83ddfc8af1c86e9) — how far along is each
milestone?"

## Expect (observable)
- the guide queries the project's promoted tasks; finding none (or few), it computes
  only what the data supports — e.g. work-item check counts from the milestone
  checklist, stated as what they are
- where a percentage isn't derivable, the entry says so plainly instead of estimating
- the milestone-by-milestone answer distinguishes checked work items from tracked
  task completion — the two are not conflated into a fake precision number

## Never
- a fabricated percentage, task count, or velocity figure
- work-item checkboxes silently presented as completed [DB] Tasks rows
- a health claim invented to fill the gap where data is missing
