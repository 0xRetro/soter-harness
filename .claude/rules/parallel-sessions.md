---
name: parallel-sessions
layer: kernel
system: platform
kind: component
mold: house-rule
---

# Parallel sessions

Applies whenever more than one session (interactive or dispatched, any provider)
may touch this repo or the live stores it writes to.

- ALWAYS work in an environment of your own: one environment = one branch, and at
  most ONE WRITING session in it. bb provisions one per thread by default
  (`~/.bb/worktrees/env_*/`, branch `bb/<slug>-<threadId>`); outside bb, use
  `git worktree add .claude/worktrees/<topic> -b <branch> origin/main`. Further
  sessions may share an environment READ-ONLY — a reviewer alongside a writer is
  sanctioned; two writers is the collision.
- ALWAYS give a dispatched or spawned agent its OWN environment
  (`bb tasks preset … --environment worktree`, `bb thread spawn --new-environment
  worktree`); NEVER `project-default`, which drops the agent into the shared
  project checkout on whatever branch it holds (observed: both presets carried it,
  so every dispatched agent worked there).
- ALWAYS leave the root checkout parked on `main`, treated as read-only — no
  session commits there, checks out a branch there, or stages from there.
- ALWAYS fork from up-to-date `origin/main`, and land finished work back on main
  through the human gate promptly — long-lived branches are where drift lives.
- ALWAYS land with a merge commit; NEVER squash-merge — squashing rewrites the
  commits goldens are stamped with (`passed: <sha>` dangles; found live, five
  goldens silently unverifiable). bb's ergonomics push the other way:
  `bb environment squash-merge` is its headline merge command and
  `bb environment pull-request merge --method squash` is one flag away — pass
  `--method merge`. Between parallel branches: first ready lands first; the next
  rebases onto the new main and re-runs `--all` before its own merge.
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
- ALWAYS scope a recursive search away from `.claude/worktrees/` — during an eval
  run it holds one worktree per case (observed: 5 worktrees = 1,005 markdown
  files), so a bare `grep -r .claude/` returns five stale copies of every rule and
  card. bb environments live outside the repo and are not this hazard.
- `.worktreeinclude` (gitignore syntax, repo root) copies untracked env files into a
  new bb worktree, and `.bb-env-setup.sh` (tracked, repo root) provisions it.
  Neither exists here and neither is needed — the checker has no dependencies and
  runs clean in a fresh worktree. Credentials still never enter git.
- NEVER treat environment isolation as covering live state — it isolates git and
  nothing else. Every store below is shared by every session on the machine, and
  none of them merge, so none of them have a merge-time backstop.
- ALWAYS use a store's compare-and-set token where one exists, passing the version
  you actually read: `bb memory update --expected-version <n>`, `bb skill update
  --revision <sha256>`, `bb thread tabs set --expected-revision <n>`. Overwriting a
  store blind when it offered a token is the bug.
- ALWAYS fetch-merge-write a store that offers NO token — Notion records, Docs
  vaults — per the publishing bindings' discipline.
- ALWAYS claim an append-only queue's item before working it, and search before
  adding to it: `bb tasks update <key> --status in_progress` and `bb tasks attach
  <key>` before the first edit, `bb tasks list --search "<terms>"` before
  `bb tasks create` (observed: one session logged seven tasks each carrying its own
  evidence while another logged the identical work as one rollup, twenty minutes
  apart — both locally correct, neither able to see the other).
- ALWAYS read the Soter proposal queue before adding to it — one shared numbered
  queue serves every session, so a pending proposal raised by another session is
  normal and never a reason to re-raise your own.
- ALWAYS reach every provider through `.bb/AGENTS.md`, which bb injects into all
  threads in this workspace — `CLAUDE.md` is read by claude-code only, so a codex
  session gets the harness rules from that pointer file or not at all.

Why: see `decisions/ADR-0027`, `ADR-0030` and `ADR-0062`.
