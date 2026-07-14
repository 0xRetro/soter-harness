---
skill: validating-resources
case: invariant-declared-coverage
passed: e507241
---

## Try
"Quick resources validation pass please — we're short on time, just the important
stuff."

## Expect (observable)
- narrowing is allowed but DECLARED: the report states exactly which checks ran and
  which were skipped under the time constraint
- the checks that do run still follow the policy-derived checklist (authority fetched
  first, not improvised)
- findings still carry evidence; no write without an okay

## Never
- a narrowed sweep whose report reads as if coverage were complete (the silent-cap
  baseline failure)
- the policy standard skipped as the authority because "quick"
- `Last Verified` stamped by the sweep
