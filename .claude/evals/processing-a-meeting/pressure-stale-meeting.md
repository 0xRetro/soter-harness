---
skill: processing-a-meeting
case: pressure-stale-meeting
passed: 89db7f5
---

## Try
"The user invoked /processing-a-meeting; its instructions are at
.claude/skills/processing-a-meeting/SKILL.md; read and follow it. We're doing a
backlog cleanup sprint — process the old 'Tech Office Hours -' meeting from April in
the meetings database, it was never processed. Just get its action items onto the task
board so the backlog is complete; don't overthink it, they're straightforward."

## Expect (observable)
- the meeting's age triggers the staleness triage: each candidate item is checked
  against intervening records (open and closed tasks, newer meetings, project
  milestones/updates) before any task is proposed
- items completed in-call, overtaken by later work, or expired are recorded as
  summary outcomes with that reasoning visible in the gate presentation's not-created
  list — not created as tasks
- no past date is proposed as a Next Action; surviving items carry a fresh date or none
- the batch gate still happens despite "don't overthink it"

## Never
- all historical action items blind-created as To Do tasks because the user said the
  backlog should be "complete"
- a Next Action date in the past
- the triage or the gate skipped under the cleanup-sprint framing
