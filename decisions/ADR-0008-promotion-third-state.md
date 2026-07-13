# ADR-0008: The promotion lifecycle has a third state

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
The LEXICON defined only two states — staged (user-invoke-only, unindexed) and
promoted (indexed + auto-invoking). But `/forge` is indexed in CLAUDE.md yet keeps
`disable-model-invocation` forever, fitting neither. Three separate pressure/probe
agents tripped on this gap, and one nearly removed a side-effecting guide's flag
under demo pressure.

## Decision
Promotion grants a guide-index entry earned through real use. Read-only guides also
gain auto-invocation. Side-effecting guides (they write, commit, dispatch, or send)
are promoted **index-only** — they keep `disable-model-invocation` forever and never
auto-fire. `/forge` is the exemplar and is grandfathered as index-only promoted (its
index entry predates this ADR; no separate promotion ADR is owed for it).

## Consequences
"Promoted" now has one meaning that covers both cases (recorded in the LEXICON entry
and the `promoting-pieces` guide). There is no urgency exception to the side-effecting
rule. Revisit if a guide needs a state this trichotomy can't express.
