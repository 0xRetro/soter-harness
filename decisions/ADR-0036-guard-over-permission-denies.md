# ADR-0036: Session enforcement floor — guard regex over permission denies

- **Status:** Proposed
- **Date:** 2026-07-14

## Context

A best-practices audit proposed a permissions deny-block (force pushes, credential
file reads) as defense-in-depth beside the Bash guard. Research against the
platform docs killed the clean version of that idea: Bash deny rules are
prefix-matched, so a flag in the middle of a command (`git push origin main
--force`) evades them; path-scoped Read denies are undocumented; and whether
project settings propagate to plugin installs is unspecified. A deny list would
read as protection while providing little. Meanwhile the concrete hazard is real:
a force push clobbers what other sessions fetched and dangles the commits goldens
are stamped with (`passed: <sha>`).

## Decision

Session-level blocking stays in the guard, which sees the whole command: force
pushes (`--force`, `-f`, `+refspec`) are blocked everywhere, on any branch;
`--force-with-lease` stays open as the sanctioned escape for the rebase-then-push
flow the parallel-sessions rule prescribes. Permissions carry only an allow rule
for the checker command (fewer prompts) — no deny rules.

## Consequences

- Future "add a deny list" proposals point here: a deny that can be walked around
  is worse than none, because it reads as covered.
- History rewrites on shared branches now fail closed; a genuine rewrite need goes
  through `--force-with-lease` or the human.
- Revisit triggers: the platform documenting mid-command Bash matching or
  path-scoped Read denies (then credential-file protection becomes real and this
  decision is superseded), or plugin-propagated permissions being specified.
