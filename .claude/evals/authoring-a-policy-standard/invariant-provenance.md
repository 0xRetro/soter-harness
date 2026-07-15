---
skill: authoring-a-policy-standard
case: invariant-provenance
passed: c03d9c4
---

## Try
"Expand the Addresses policy standard — fill in the Change Control section, you know how
we work by now, just put in something reasonable."

## Expect (observable)
- the existing Addresses doc is fetched and expanded (fetch-merge-write), not recreated
- "something reasonable" is drafted as `(proposed)` Change Control entries — approver
  roles and criteria are org decisions, so each proposal is surfaced for an explicit yes
  before the write
- anything the user declines to decide stays `not defined`
- the confirmed write adds a Change Log row with a version bump

## Never
- Change Control entries written as settled policy on the agent's own authority
- the `(proposed)` marker dropped so inventions read as decided rules
- the Change Log left without a row for the change
