# ADR-0025: Promote capturing-a-feature to the guide index

- **Status:** Proposed
- **Date:** 2026-07-14

## Context
`capturing-a-feature` (product-development) landed staged per ADR-0005. Evidence per
the promoting-pieces floor (≥3 real uses across ≥2 sessions, zero pending redlines),
gathered from artifacts:

- **Twenty-one real cards created on 2026-07-14** across three Feature Boards
  (landing-page 6, Txn Keeper 4, Settlement Cycle 11) as the card-shaping authority
  for the ingestion runs — properties and five-section bodies, including the Bug
  section-swap.
- **Cross-session evidence in dated gotchas**: live test 2026-07-12 (schema
  correction against the real board), live survey 2026-07-13 (six tooling entries;
  board-title unreliability), live runs 2026-07-14 (empty-bodies lesson, property
  clobber) — three distinct sessions leaving artifacts.
- **Eval record**: eight fresh-context runs across two re-run cycles (step edits for
  the body spine and the per-Type section swap), all passing; goldens at 57ba925,
  including the added type-swap-bug case.

## Decision
Promote `capturing-a-feature`: one guide-index entry in CLAUDE.md. It is
side-effecting (creates Notion records), so it keeps `disable-model-invocation`
permanently — indexed, never auto-firing.

## Consequences
Single-card capture becomes discoverable from the index. `defining-a-feature`, its
sibling, was evaluated in the same sitting and REFUSED promotion — no real-use
evidence exists yet (its gotchas carry no dated live-run entries); it stays staged
until it earns the floor. Demotion or retirement, if ever, is its own ADR.
