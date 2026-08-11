---
skill: capturing-a-task
case: happy-path
passed: fecf7cca
note: 2026-08-11 rerun — write held at the confirm gate (away-human device), so Expect was judged against the PREPARED record. Fixture drift: no "process-platform" row exists in [DB] Projects (it is a [DB] Tooling row), so the case passes on its Never bullets plus a correct refusal (running-evals step 4 FLEX) — the runner proposed Soter Labs: SoterOS on shared-repo evidence and asked rather than fabricating. Deviation: `Next Action` was left as two concrete ISO candidates (2026-08-14 / 2026-08-21) instead of one pinned date + confirm, as the guide's gotcha directs. Verdict from observables — zero write-tool calls, no push/PR, run worktree clean, no eval-case read, every cited id traced to a live tool result.
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
