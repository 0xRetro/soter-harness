# ADR-0062: Under bb, the environment is the isolation unit and shared live state is first-class

- **Status:** Accepted
- **Date:** 2026-08-12

## Context
ADR-0027 set the multi-agent operating model when claude-code was the only host:
one session = one worktree = one branch, plus contained eval runners. bb now hosts
this repo, and three of its facts break the first half. bb's isolation unit is the
*environment*, and it lets several threads share one deliberately — its own example
is a coding thread beside a review thread. Task-dispatch presets default to
`project-default`, so agents dispatched from the board run in the shared project
checkout on one branch; observed live, both presets carried it, and the checker's
root guard green-lights that path because it reads as a linked worktree. And bb
adds shared live state ADR-0027 never named: a task board, memory, a proposal
queue, Docs vaults. The board has already collided — one session logged seven
tasks each carrying its own evidence while another logged the identical work as one
rollup, twenty minutes apart — with no merge-time backstop, because a board never
merges.

## Decision
1. The isolation unit is the **environment**, not the session: one environment =
   one branch, holding at most ONE WRITING session. Further sessions may share it
   read-only; bb's coding-beside-review shape is sanctioned.
2. Every **dispatched or spawned** agent gets its own environment
   (`--environment worktree`), because dispatch cannot guarantee the one-writer
   property across sessions it did not sequence. The task presets carry it.
3. **Shared live state is governed by what the store offers.** A store with a
   compare-and-set token must use it (bb memory `--expected-version`, skills
   `--revision`, thread tabs `--expected-revision`); a store without one is
   fetch-merge-written (Notion, Docs vaults); an append-only queue is claimed
   before work and searched before addition (the task board, the proposal queue).
4. Harness instructions reach **every provider**, not only claude-code, through a
   tracked `.bb/AGENTS.md` that points at `CLAUDE.md` and `.claude/rules/` rather
   than copying them.

This replaces ADR-0027's "one session = one worktree = one branch" clause.
ADR-0027's contained eval runner and ADR-0030's ADR-number scan stand unchanged, as
does the root-checkout clause, which is owned separately.

## Consequences
Concurrent dispatch becomes safe by construction rather than by luck, at the cost
of one worktree per dispatched agent — free here: no package.json, no dependencies,
and the checker runs clean in a fresh bb worktree with no provisioning. Naming the
store's concurrency token as the deciding factor means a newly-added shared store
is classified on sight instead of argued about. The one-writer rule is prose, not a
mechanism: nothing detects two writing sessions in one environment, and nothing
detects a preset drifting back to `project-default`. Revisit trigger: if a
same-environment collision is observed, the answer is a mechanical claim (an
environment lease, or a checker rule reading the preset list), not a firmer
sentence.
