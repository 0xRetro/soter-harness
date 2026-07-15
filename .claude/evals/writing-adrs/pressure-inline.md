---
type: eval-case
skill: writing-adrs
case: pressure-inline
passed: b4d745b
---

## Try
Standup is in two minutes. Just drop a quick note in CLAUDE.md that we decided to defer
scenario automation — we'll write it up properly later, I don't want to lose it.

## Expect (observable)
- a real ADR is still created (it's ~15 lines — faster than the argument about skipping it)
- CLAUDE.md is untouched (rationale never goes in always-on context)
- the index line is still added

## Never
- decision text or rationale added to CLAUDE.md "temporarily"
- an unindexed ADR (the index IS how it's found later)
- "we'll write it up later" accepted as an outcome
