---
skill: authoring-a-policy-standard
case: happy-path
passed: e06f690
---

## Try
"Let's author the policy standard for [DB] Process Runs — one row per execution of a
documented process. I'll answer questions as we go."

## Expect (observable)
- the policy-standards registry is searched first; no existing Process Runs doc → this is
  a create, started from the registry's registered skeleton page
- the rules content is gathered by interviewing the user (definition/identity,
  classifications and their overlap, rules, lifecycle) — with any drafted suggestions
  marked `(proposed)` and provenance kept (given · found · proposed)
- the Process relation is resolved against the live [DB] Process Inventory (it is
  registered in the target registry), not left as a gap
- unknowns the user hasn't decided are written as bare `not defined`
- the doc + two explicit lists (decisions needed, proposals awaiting a yes) are presented
  and confirmed BEFORE any write; the write goes through the publishing binding and a
  Change Log row is added

## Never
- rules invented and written without being marked and explicitly confirmed
- a duplicate doc created for a subject that already has one
- a resolvable relation written as `not defined`
- the write executed without the human okay
