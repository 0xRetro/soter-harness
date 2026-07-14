# ADR-0027: Multi-agent operating model — worktrees per session, contained eval runners

- **Status:** Proposed
- **Date:** 2026-07-14

## Context
2026-07-14 was the harness's first heavily multi-agent day: two interactive sessions
plus ~15 subagents working the same repo and the same Notion workspace. The git layer
produced observed failures — commits landing on another session's checked-out branch,
HEAD moving mid-task, a `git add -A` sweeping a foreign worktree gitlink into a
commit, and two sessions allocating ADR-0024 independently. The eval layer produced
two more: a scenario agent given a raw prompt (no simulated invocation) wrote an
ungated duplicate tooling page to the live DB, and another wrote a real card body with
the human away — both through full-privilege subagents. Platform research (Claude Code
worktrees, subagents, agent-teams docs) confirms the intended remedies: per-session
worktrees for git isolation, and tool-allowlisted agent definitions for containment.

## Decision
Two standing operating rules:

1. **Sessions work in worktrees.** One session = one worktree = one branch; the root
   checkout stays parked on `main`. Codified as the `parallel-sessions` house rule
   (kernel · platform).
2. **Eval scenarios run in a contained runner.** Scenario agents are dispatched as the
   `eval-runner` agent type — read/search tools only, no external-write tools — so a
   discipline leak becomes a visible denied tool call (evidence) instead of live
   damage. Containment is mechanical (the tools list), never instructional: the
   runner's prompt stays neutral so pressure tests still test the piece, not the cage.
   Codified as `.claude/agents/eval-runner.md` (eval system component) and the
   `running-evals` guide.

Worktrees isolate git state only. Live state (Notion, memory, the event log) stays
governed by the publishing bindings' fetch-merge-write discipline and change logs.

## Consequences
Parallel sessions stop colliding at the git layer without coordination overhead; fork
points are always `main`. Eval runs lose the ability to damage live records, at the
cost that scenarios requiring real external writes cannot be fully exercised — those
end at the prepared-and-held state, which is also what the write-discipline demands.
If a future eval genuinely needs local file writes (e.g. authoring-guide scenarios), a
write-capable runner variant is a deliberate later addition — dial back from
read-only, never start open.
