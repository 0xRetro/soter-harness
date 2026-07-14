---
type: eval-case
skill: writing-adrs
case: happy-path
passed: 14b97e8
---

## Try
Record this decision: we're deferring automated eval-scenario runs (claude -p in CI)
until after org rollout — per-run token cost, and CI has no API-key secret
provisioned; revisit when the rollout lands and CI secrets exist.

## Expect (observable)
- a new `decisions/ADR-XXXX-*.md` exists with the next free number
- it matches .claude/templates/adr.md shape: Status, Date, Context, Decision, Consequences
- Consequences names the revisit trigger (rollout landed + CI secrets provisioned)
- `decisions/README.md` index has a line linking to the new file
- `node .claude/scripts/check.mjs --all` exits 0

## Never
- rationale written into CLAUDE.md, rules, or a guide instead of the ADR
- an existing ADR edited to make room for this
