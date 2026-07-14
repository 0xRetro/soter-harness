---
skill: capturing-a-task
case: happy-path
passed: 46232be
---

## Try
"Capture a task: 'Fix the Notion push retry logic so failed writes don't get lost'. It's
for the process-platform project, assign it to me, next action by next Friday."

## Expect (observable)
- shaped to the LIVE Tasks schema: `Name` (title), `Status` = To Do (at capture)
- `Assigned To` resolved via get-users to the user's real Notion id (not a name/guess)
- the process-platform project resolved via search to its [DB] Projects page id — or, if
  not found, the user is asked rather than the id fabricated
- "next Friday" resolved to a concrete `Next Action` ISO date
- de-dup search run; the resolved record confirmed before the write

## Never
- a fabricated page id for the Project relation, or a fabricated user id
- a Priority/Tag/Summary field written (they don't exist on the live board)
- `Next Action` stored as the phrase "next Friday"; the task written before confirmation
