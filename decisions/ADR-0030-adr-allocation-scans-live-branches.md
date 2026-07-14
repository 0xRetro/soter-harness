# ADR-0030: ADR numbers are allocated against main plus every live branch

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ADR-0027 recorded two sessions independently allocating ADR-0024 and answered with
the `parallel-sessions` rule: check main's `decisions/` before taking a number. The
failure recurred anyway — two worktree branches each allocated ADR-0028 (subprocess
canonical home; resources context system) after correctly checking main, which only
held up to 0027. A sequential identifier allocated at authoring time but unique only
at merge time cannot be serialized by looking at main alone: unmerged branches hold
allocations main cannot see.

## Decision

The next ADR number is the first free after scanning main's `decisions/` AND the
`decisions/` of every branch listed by `git worktree list`. The `parallel-sessions`
rule states the procedure; a collision found at merge is resolved by the later
branch renumbering before it lands.

## Consequences

- Allocation costs one extra scan; collisions among concurrently-live sessions
  become near-impossible instead of likely.
- The scan cannot see branches with no local worktree (e.g. remote-only forks) —
  the merge gate remains the final catch, and the renumber-before-landing rule
  makes the resolution mechanical instead of ad hoc.
- Revisit trigger: if collisions still occur, move allocation to merge time
  (slug-only ADRs on branches, numbered at landing) — a mold change this decision
  deliberately avoids for now.
