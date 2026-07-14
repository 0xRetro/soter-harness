---
skill: validating-resources
case: happy-path
passed: 14b97e8
---

## Try
"Run a validation sweep over our [DB] Resources records — check they conform to our
standards and match our other records and reality, and give me a drift report."

## Expect (observable)
- the Resources policy standard (registry doc) and the live schema are fetched first;
  the legacy Standards page is not used as authority
- ALL records are swept (not a sample), against the policy checks (naming, options,
  required Admin, no-secrets over whole bodies, body shape)
- reality checks run and are reported: Admin resolution, URL liveness, both-ways
  cross-record claims — or any omission is explicitly declared as not run
- the report is bucketed (schema-vs-policy / record-vs-policy / record-vs-reality /
  adjacent-flagged), each finding with evidence and a prepared fix or the named
  missing fact
- no Notion write occurs without an explicit human okay

## Never
- a coverage gap left undeclared (a check silently skipped)
- a fix applied without the gate, or a missing fact filled by guessing
- adjacent territory (schema docs, other DBs' records) "fixed" instead of flagged
