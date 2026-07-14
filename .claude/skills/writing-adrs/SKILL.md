---
name: writing-adrs
description: >-
  Records a decision as a well-formed ADR in decisions/ — context, choice, and
  consequences, in the house shape. Use when the user says record this decision or
  write an ADR, or a durable strategy/architecture/convention choice emerges mid-task.
  Not for the piece-authoring loop (/forge) or the log's own conventions
  (decisions/README.md).
disable-model-invocation: true
layer: kernel
system: governance
kind: component
mold: how-to-guide
---

# Writing ADRs

## Goal
A decision that would otherwise evaporate from chat is captured as a short, immutable,
indexed record — so it never gets re-litigated and its rationale stays out of always-on
context.

## Use when / don't use when
- Use when: a durable choice was made — something with alternatives, consequences, and a
  reason future-us will want ("why is it this way?").
- Not for: task notes, todos, or status (those aren't decisions); editing an Accepted
  ADR (supersede it instead); authoring other harness pieces (that's /forge).

## Steps
1. Confirm it's a decision: there were real alternatives and the choice constrains future
   work. If it's just information, stop — it isn't an ADR.
2. Read `decisions/README.md`'s index. If an Accepted ADR already covers this ground:
   changing it means a **superseding** ADR — never an edit.
3. Allocate the next FREE number (ADR-XXXX, zero-padded) — scan main's `decisions/`
   AND every live worktree branch's (`git worktree list`, then each branch's
   `decisions/`), per the parallel-sessions rule (ADR-0030). "One higher than this
   index" alone collides: unmerged branches hold numbers this checkout can't see.
   The checker's `ADR_DUP` is the merge-time backstop, not the allocation method.
4. Copy `.claude/templates/adr.md`. Fill:
   - **Context** — the situation and why the question arose, 2-5 lines.
     FLEX: wording and emphasis; keep it honest about what forced the choice.
   - **Decision** — 1-3 lines, active voice, the choice itself (not the journey).
   - **Consequences** — costs, constraints, what it enables/forbids, and the
     **revisit trigger** (what would justify superseding it).
5. Status: `Proposed`. It flips to `Accepted` at the gate that lands it. In-session
   acceptance counts ONLY when the human confirmed the decision CONTENT itself — a
   go-ahead to do the work is NOT acceptance of the decision it produces; when in doubt,
   `Proposed` (the merge flips it — ADR-0027's own precedent).
6. Add one line to the index in `decisions/README.md`.
   If the decision introduces or redefines a term, update `.claude/LEXICON.md`'s
   registry (and the owning card's Concepts line) in the same change — an ADR's
   vocabulary that never reaches the registry goes stale silently.
7. If superseding: the ONLY edit to the old ADR is its Status line →
   `Superseded by ADR-XXXX`.
8. Verify: `node .claude/scripts/check.mjs --all` passes; the index line links to a real file.
9. Land it: on the session's branch like all harness work — never from the root
   checkout (it stays parked on main; parallel-sessions rule). With in-session
   acceptance the PR may merge without further review (that approval WAS the gate);
   otherwise it waits for the human. The merge — or the human's explicit flip — sets
   `Accepted`.

## Gotchas
- (observed 2026-07-14, audit) ADR-0027 introduced `session` and redefined `worktree`,
  but the LEXICON registry never absorbed either — caught only by a later full audit.
  Counter: step 6's same-change registry update.
- (observed 2026-07-14, 2×) Two pairs of parallel branches allocated the same ADR
  number (0028, 0030) after each correctly checked main. Counter: step 3 scans live
  worktree branches too; the first-merged keeps the number, the later renumbers.

## Evals
- `.claude/evals/writing-adrs/happy-path.md`
- `.claude/evals/writing-adrs/pressure-inline.md`
- `.claude/evals/writing-adrs/invariant-immutable.md`
