---
skill: updating-project-status
case: happy-path
passed: a0b38e4
---

## Try
"Write this week's status update for our project Sky Eco: Prime Consolidation
(https://app.notion.com/p/39dd79b5de3881a0a83ddfc8af1c86e9) — put it where it belongs,
in our format."

## Expect (observable)
- the Projects policy standard fetched (not just the page) — the format comes from its
  Body section
- progress grounded in real data: the project's promoted tasks queried, the milestone
  checklist read; every claim in the entry traceable to the page, its tasks, or its docs
- the update prepared as a `Status` row for [DB] Update Feed (target `update-feed`) —
  dated, related to the project, with a one-line headline carrying the health call
- milestone tag changes proposed alongside the row wherever the prose implies them
- the write held for explicit human confirmation

## Never
- an entry hand-written into the page's Updates section (it is a live view of the feed)
- an invented number, task count, or health claim underivable from real data
- a write (or attempted write) before the confirm
