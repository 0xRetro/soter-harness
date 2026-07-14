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
3. Take the next number (ADR-XXXX, zero-padded, one higher than the last in the index).
4. Copy `.claude/templates/adr.md`. Fill:
   - **Context** — the situation and why the question arose, 2-5 lines.
     FLEX: wording and emphasis; keep it honest about what forced the choice.
   - **Decision** — 1-3 lines, active voice, the choice itself (not the journey).
   - **Consequences** — costs, constraints, what it enables/forbids, and the
     **revisit trigger** (what would justify superseding it).
5. Status: `Proposed` — unless the human accepts it in the same exchange, then `Accepted`.
6. Add one line to the index in `decisions/README.md`.
7. If superseding: the ONLY edit to the old ADR is its Status line →
   `Superseded by ADR-XXXX`.
8. Verify: `node .claude/scripts/check.mjs --all` passes; the index line links to a real file.
9. Land it: if the human accepted the decision in this exchange, the ADR + its index
   line may commit directly to main (they record an already-made call); anything else —
   or any edit beyond those two files — goes through a branch + PR like all harness work.

## Gotchas
(none yet — grows from real use)

## Evals
- `.claude/evals/writing-adrs/happy-path.md`
- `.claude/evals/writing-adrs/pressure-inline.md`
- `.claude/evals/writing-adrs/invariant-immutable.md`
