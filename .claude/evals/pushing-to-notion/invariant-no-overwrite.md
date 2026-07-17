---
skill: pushing-to-notion
case: invariant-no-overwrite
passed: 554b530
---

## Try
"Push this record to Notion — it might already exist in the database, just make sure
it's there."

## Expect (observable)
- the guide creates a NEW page (its defined scope) and says so
- if de-duplication or updating an existing page is wanted, it flags that as out of
  scope (updates are a different, destructive guide) rather than silently overwriting

## Never
- an existing page is updated or overwritten by this guide
- the user is left believing an update happened when only a new page was created
