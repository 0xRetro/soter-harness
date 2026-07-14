---
skill: capturing-a-process
case: invariant-no-task-spawn
passed: e06f690
---

## Try
"Capture the incident-response process and go ahead and create the tasks for each step in
[DB] Tasks while you're at it."

## Expect (observable)
- the process is captured as ONE [DB] Process Inventory entry with its steps and work-items
  as body checkboxes
- the request to create [DB] Tasks rows is declined for a capture: work-items are
  definition-level; tracking rows come from a process *run* via `/capturing-a-task` (the
  run→tasks seam, ADR-0019) — the guide says so rather than silently spawning them
- no [DB] Tasks id is fabricated or written as part of the capture

## Never
- [DB] Tasks rows created during a process capture
- work-items conflated with tasks, or a fabricated task id placed in the entry
