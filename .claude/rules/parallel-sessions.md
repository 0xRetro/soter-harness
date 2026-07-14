---
name: parallel-sessions
layer: kernel
system: platform
kind: component
mold: house-rule
---

# Parallel sessions

Applies whenever more than one session (interactive or agent) may touch this repo.

- ALWAYS work in a git worktree — one session = one worktree = one branch
  (`claude --worktree <topic>`, the `EnterWorktree` tool, or
  `git worktree add .claude/worktrees/<topic> -b <branch> main`). Git itself refuses
  two worktrees on the same branch.
- ALWAYS leave the root checkout parked on `main`, treated as read-only — no session
  commits there, checks out a branch there, or stages from there.
- ALWAYS fork from up-to-date `origin/main`, and land finished work back on main
  through the human gate promptly — long-lived branches are where drift lives.
- ALWAYS land with a merge commit; NEVER squash-merge — squashing rewrites the commits
  goldens are stamped with (`passed: <sha>` dangles; found live, five goldens silently
  unverifiable). Between parallel branches: first ready lands first; the next rebases
  onto the new main and re-runs `--all` before its own merge.
- ALWAYS push the session branch to origin at its first commit and keep pushing as
  work lands — unpushed work is invisible to every other session's allocation scan
  and lives on one disk (observed: 17 commits staged for a combine existed nowhere
  but a laptop).
- ALWAYS check main's `decisions/` AND every live worktree branch's (`git worktree
  list`, then each branch's `decisions/`) before allocating the next ADR number (or
  any shared sequential identifier) — checking main alone still collides: unmerged
  branches hold allocations main can't see (observed twice: ADR-0024, ADR-0028).
  On a collision, the later-merging branch renumbers its still-Proposed ADR; the
  first-merged keeps the number (the checker's ADR_DUP catches what eyeballs miss).
- ALWAYS scope `git add` to named paths; NEVER `git add -A` (it once swept another
  session's worktree gitlink into a commit).
- NEVER treat worktree isolation as covering live state — Notion records and the
  memory directory are shared across all sessions; the publishing bindings'
  fetch-merge-write discipline governs those, worktrees only isolate git.
- `.worktreeinclude` (gitignore syntax, repo root) copies env files into new worktrees
  when local runs need them — credentials still never enter git.

Why: see `decisions/ADR-0027` and `decisions/ADR-0030`.
