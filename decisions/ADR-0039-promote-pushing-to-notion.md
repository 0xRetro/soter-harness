# ADR-0039: Promote pushing-to-notion to the guide index

- **Status:** Proposed
- **Date:** 2026-07-14

## Context

`pushing-to-notion` (publishing) is the create binding — the only sanctioned path
for making new Notion pages. Evidence per the promoting-pieces floor (≥3 real uses
across ≥2 sessions, zero pending redlines), gathered from artifacts:

- **Indirect use is its designed mode**: every capture guide (feature, task,
  contact, org, process) routes creation through this binding, so its real-use
  trail is the records those guides created this week across many sessions —
  tooling pages, feature cards, [DB] Tasks rows, Process Inventory entries,
  policy-standard pages. The write pattern (typed properties, confirm-first)
  is visible in the session transcripts behind each.
- **Git history**: five commits touching the guide across distinct sessions,
  including targets.md growth to 13 mirrored targets — each target registration
  an artifact of the binding being pointed at a new live database.
- **Its own gotchas skew "(baseline)"** because use accrues through callers; the
  shared write standard (`writing-records-to-notion`) carries the dated live
  gotchas the callers hit. Noting this here so future promotions of
  mechanism-guides read the evidence at the right altitude.
- Goldens: 3/3 stamped (PR #13/#19 waves); zero pending redlines.

## Decision

Promote `pushing-to-notion`: one guide-index entry in CLAUDE.md. It writes to an
external store, so it keeps `disable-model-invocation` permanently — indexed,
never auto-firing.

## Consequences

Creation becomes discoverable from the index — sessions asked to "push/publish to
Notion" find the binding instead of improvising raw API writes (its baseline
failure). One piece per decision; evidence never transfers. Demotion, if ever, is
its own ADR.
