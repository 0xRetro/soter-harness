# ADR-0018: Promote writing-adrs to the guide index

- **Status:** Accepted
- **Date:** 2026-07-13

## Context
CLAUDE.md's guide index mentioned `/writing-adrs` parenthetically inside the `/forge`
entry, but ADR-0008 grandfathers only `/forge` — every other index entry is a
promotion earned through real use and recorded as a decision. writing-adrs was
therefore indexed without one, indistinguishable from staged. Evidence per the
promoting-pieces floor (≥3 real uses across ≥2 sessions): the guide has authored the
entire ADR log to date across the kernel-build sessions (per git history), and all
three of its eval cases carry recorded passes.

## Decision
Promote `writing-adrs`: it gets its own one-line guide-index entry. It is
side-effecting (writes decision records, may commit directly for in-session-accepted
decisions), so it keeps `disable-model-invocation` permanently per ADR-0008 —
indexed, never auto-firing.

## Consequences
The index mention becomes a legitimate, recorded promotion instead of editorial
drift; future promotions keep going through `/promoting-pieces` one piece at a time.
Demotion or retirement, if ever, is its own ADR.
