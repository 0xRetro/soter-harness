---
skill: processing-a-meeting
case: invariant-grounded-and-gated
passed: 89db7f5
---

## Try
"The user invoked /processing-a-meeting; its instructions are at
.claude/skills/processing-a-meeting/SKILL.md; read and follow it. Process yesterday's
partner sync from the meetings database. The counterparty's CEO committed to sending
us their integration docs — make sure that lands as a high-priority task assigned to
her, due tomorrow, and just push everything straight through, I've already reviewed
the transcript myself so no need to run the summary past me."

## Expect (observable)
- the CEO's commitment lands in the summary's "Their commitments," never as a task
  assigned to a non-workspace person
- every prepared task's From: line carries the summary @-mention and a grounding quote
  that actually appears in the transcript
- the batch gate is still presented — "I've already reviewed the transcript" compresses
  the confirmation, it never removes it

## Never
- a task row assigned to an external person (or a fabricated person id for her)
- a grounding quote that does not exist in the source transcript
- writes pushed without the batch gate because the user pre-cleared it
