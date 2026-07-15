# ADR-0056: Promote promoting-pieces to the guide index

- **Status:** Proposed
- **Date:** 2026-07-15

## Context

The second promotion wave reviewed all thirteen staged-unpromoted guides against the
evidence floor (≥3 real uses across ≥2 distinct sessions, artifacts never testimony).
Twelve refused — baseline/eval-tagged gotchas are forge evidence, not real use, and
every guide with live gotchas had them from one day's single session. One passed:
`promoting-pieces` itself, with the first wave (2026-07-14: five decisions, one
refusal, ADRs 0039–0042 recorded through it, a dated live gotcha) as session one and
this wave's thirteen reviews as session two.

## Decision

`promoting-pieces` gets a guide-index entry in CLAUDE.md. It is side-effecting (writes
CLAUDE.md, ADRs, commits), so `disable-model-invocation` stays forever — the index
entry is the whole promotion.

## Consequences

Future sessions discover the promotion path from CLAUDE.md instead of re-deriving it;
the twelve refusals stay staged and re-enter through the same door when their evidence
crosses the floor in a later session. The self-referential shape is acknowledged: the
promoting guide promoted by its own procedure, on two waves of artifacts — if that
ever reads as circular in practice, the revisit trigger is a promotion decision this
guide's own steps could not adjudicate cleanly.
