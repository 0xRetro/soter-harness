# ADR-0041: Promote auditing-a-schema-doc to the guide index

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

`auditing-a-schema-doc` (schema-audit) keeps policy-standard Fields sections and
the targets.md mirror true to the live DBs. Evidence per the promoting-pieces
floor, gathered from artifacts:

- **Dated live-run gotcha** ("(live run 2026-07-13, real Tasks + Projects docs)")
  plus nine commits touching the guide across distinct sessions.
- **ADR-0029 made it load-bearing**: the same-pass mirror audit is the schema-sync
  enforcement mechanism, and the checker's TARGET_STALE nag exists specifically to
  drive its cadence — a staged, unindexed guide as the target of a checker nag is
  a discoverability gap (the nag says "run the audit"; the index says where).
- **The targets.md growth to 13 live-verified targets** is its artifact trail —
  each stamp a completed reconcile pass.
- Goldens: fully stamped incl. the targets-mirror-drift case; zero pending redlines.

## Decision

Promote `auditing-a-schema-doc`: one guide-index entry in CLAUDE.md. It writes to
the external store (reconcile edits) and to targets.md, so it keeps
`disable-model-invocation` permanently — indexed, never auto-firing.

## Consequences

The guide TARGET_STALE points at becomes findable from the index. One piece per
decision. Demotion, if ever, is its own ADR.
