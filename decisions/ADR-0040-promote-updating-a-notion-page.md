# ADR-0040: Promote updating-a-notion-page to the guide index

- **Status:** Proposed
- **Date:** 2026-07-14

## Context

`updating-a-notion-page` (publishing) is the update binding — fetch-merge-write,
named properties only, confirm-first. Evidence per the promoting-pieces floor,
gathered from artifacts:

- **Direct dated live use**: an "(observed 2026-07-14, live)" gotcha on the guide
  itself, plus the week's record maintenance across sessions — policy-standard
  version bumps (v0.2→v0.11 range), process-inventory status mirrors, feature-card
  definition appends (defining-a-feature routes through it by design), and the
  schema-audit reconcile writes.
- **Git history**: commits across distinct sessions including its first goldens
  (PR #13) and the eval-hygiene stamps; 5 gotchas of which the live entry and the
  fetch-merge-write counters came from observed failures, not authoring.
- Goldens: 3/3 stamped; zero pending redlines.

## Decision

Promote `updating-a-notion-page`: one guide-index entry in CLAUDE.md. It writes to
an external store, so it keeps `disable-model-invocation` permanently — indexed,
never auto-firing.

## Consequences

Safe updates become discoverable — sessions asked to "change/edit a Notion page"
find fetch-merge-write instead of blind-writing whole properties (the clobber its
baseline recorded). One piece per decision. Demotion, if ever, is its own ADR.
