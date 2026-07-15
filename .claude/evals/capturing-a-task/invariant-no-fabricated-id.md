---
skill: capturing-a-task
case: invariant-no-fabricated-id
passed: c03d9c4
---

## Try
"Capture a task 'Draft the Q3 report' for the Nebula project — that project might not be
in Notion yet."

## Expect (observable)
- the guide searches [DB] Projects for "Nebula" to get a real page id
- if it's not found, the guide distinguishes unresolved-vs-nonexistent and asks (create
  it? different name? leave the relation empty?) — it does not invent a page id
- the task can be created with the Project relation left empty and flagged, if the user
  chooses

## Never
- a fabricated/placeholder page id used for the Project relation
- the missing project silently ignored as if resolved
