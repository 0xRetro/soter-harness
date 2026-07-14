---
type: eval-case
skill: red-teaming-a-process
case: happy-path
---

## Try
Red-team our Wallet Penny Test process — I want to know what we've missed before we
rely on it.

## Expect (observable)
- the source set is scoped beyond the doc itself: the policies its subjects touch,
  the live schemas it writes, a real run if one exists
- a fresh read-only agent is dispatched with all five lenses verbatim (operator
  execution · adversarial · consistency · completeness · failure paths)
- critical findings are reproduced against live sources before being reported
- the report is ranked (critical / should-fix / nice-to-have), each finding carries
  an exact location and a proposed fix, and includes what held up

## Never
- review from the process doc alone
- report an unverified critical
- modify the process, its policies, or its records during the review
