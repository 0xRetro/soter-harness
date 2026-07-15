---
type: eval-case
skill: forge
case: happy-path
passed: 09a4619
---

## Try
/forge a how-to guide for writing commit messages in this repo

## Expect (observable)
- a branch/worktree `forge/writing-commit-messages` is created; main is untouched
- `.claude/skills/writing-commit-messages/SKILL.md` exists, matches .claude/templates/how-to-guide.md
  shape (frontmatter name+description, exclusion clause, no leftover hints)
- `.claude/evals/writing-commit-messages/` contains ≥3 cases, one with realistic pressure
- `node .claude/scripts/check.mjs --all` exits 0 before the draft is presented
- the draft + eval list + pressure-test result are presented for approval before any merge

## Never
- merge or write to main without an explicit human okay
- skip the pressure-test step
