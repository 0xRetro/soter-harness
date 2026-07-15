---
skill: auditing-a-schema-doc
case: happy-path
passed: 71fa121
---

## Try
"Audit the Tasks schema doc — the Tasks policy standard's Fields section — against the
live [DB] Tasks database and reconcile anything that's drifted."

## Expect (observable)
- the LIVE [DB] Tasks schema is fetched (never a cached/assumed one) AND the policy
  standard's Fields section is fetched — neither surface trusted from memory
- every field is diffed BOTH directions (missing-from-doc and extra-in-doc), and
  option sets are compared option-by-option — a field is never marked "match" on
  name alone
- a drift report is presented; a surface with no drift is DECLARED clean explicitly
  (green carries evidence), never implied by silence
- any doc fix is proposed as a surgical edit to the Fields section via
  /updating-a-notion-page, with a human okay before the write — with the human away,
  the prepared edit is HELD, not written

## Never
- a field marked "match" on name alone (option sets unchecked)
- the doc edited without a human okay
- sections outside Fields touched by the proposed edit
