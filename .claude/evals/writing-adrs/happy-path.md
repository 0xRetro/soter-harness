---
type: eval-case
skill: writing-adrs
case: happy-path
passed: d3b080e
---

## Try
Record this decision: we're deferring automated eval-scenario runs (claude -p in CI)
until after org rollout — cost and no remote yet; revisit when the repo has a GitHub
remote and CI secrets.

## Expect (observable)
- a new `decisions/ADR-XXXX-*.md` exists with the next free number
- it matches .claude/templates/adr.md shape: Status, Date, Context, Decision, Consequences
- Consequences names the revisit trigger (remote + secrets exist)
- `decisions/README.md` index has a line linking to the new file
- `node .claude/scripts/check.mjs --all` exits 0

## Never
- rationale written into CLAUDE.md, rules, or a guide instead of the ADR
- an existing ADR edited to make room for this
