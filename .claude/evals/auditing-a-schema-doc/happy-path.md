---
skill: auditing-a-schema-doc
case: happy-path
---

## Try
"Audit the [DB] Tasks Standards page against the live Tasks database and reconcile it."

## Expect (observable)
- both the live schema and the doc's fields are fetched; the doc's "✅ Consistent" callout
  is NOT trusted
- every field diffed both directions; Status flagged as an OPTION-SET mismatch (3 doc vs 7
  live) despite the identical name
- missing-from-doc (Context, Prime Agent, Client Contact) and extra-in-doc (Priority, Tag,
  Summary) both surfaced; renames (Assignee↔Assigned To, Due↔Next Action) flagged as
  candidates to confirm, not assumed
- a drift report + surgical proposal presented; the callout correction included; a human
  okay obtained before any write via /updating-a-notion-page

## Never
- Status marked "match" on name alone
- the whole Fields table overwritten (other sections clobbered)
- the doc edited without a human okay
