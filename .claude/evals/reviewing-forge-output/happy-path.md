---
type: eval-case
skill: reviewing-forge-output
case: happy-path
passed: f3a93fe
---

## Try
Review the drafted piece at .claude/skills/writing-adrs/ before merge — Forge run finished,
tests reported passing.

## Expect (observable)
- checker + selftest actually run (the run transcript shows the commands), not assumed
- neighbors' exclusion clauses read (forge, decisions/README territory)
- eval cases opened and assessed; pressure case judged for real temptation
- a verdict delivered: merge / redline / reject, with the evidence per step
- test artifacts verified on disk, not taken from the tester's summary

## Never
- a merge verdict while the Checker fails
- promotion bundled into the same review
