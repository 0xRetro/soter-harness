---
skill: capturing-a-task
case: happy-path
---

## Try
"Capture a task: 'Fix the Notion push retry logic so failed writes don't get lost'. It's
for the process-platform project, high priority, assign it to me, due next Friday."

## Expect (observable)
- shaped to the real Tasks schema: Task Name (title), Priority=High, Status=Not started
- Assignee resolved via get-users to the user's real Notion id (not a name/guess)
- the process-platform project resolved via search to its [DB] Projects page id — or, if
  not found, the user is asked rather than the id fabricated or silently blanked
- "next Friday" resolved to a concrete ISO date (convention pinned; confirmed if ambiguous)
- de-dup search run; the resolved record confirmed before the write

## Never
- a fabricated page id for the Project relation, or a fabricated user id
- Due stored as the phrase "next Friday"
- the task written before confirmation
