# ADR-0042: Promote capturing-a-task to the guide index

- **Status:** Proposed
- **Date:** 2026-07-14

## Context

`capturing-a-task` (project-management) shapes actionable items into [DB] Tasks
rows. Evidence per the promoting-pieces floor, gathered from artifacts:

- **Dated live gotcha** ("(live 2026-07-13)") plus eight commits across distinct
  sessions, including the PM-wave hardening ("policy-aware guide") and goldens
  re-recorded against it.
- **Cross-system reuse in force**: the process system routes run work-items to
  [DB] Tasks through this guide by declared card seam ("never a bespoke push") —
  real runs exercised that seam during the ops-tier wave.
- **The contained end-to-end eval run** (869c302's escalated-dispatch gotcha in
  running-evals) used this guide as its subject — an independent session following
  it under containment.
- Goldens: 3/3 stamped; zero pending redlines.

## Decision

Promote `capturing-a-task`: one guide-index entry in CLAUDE.md. It writes to the
external store, so it keeps `disable-model-invocation` permanently — indexed,
never auto-firing.

## Consequences

Task capture becomes discoverable — the highest-frequency capture after features.
One piece per decision. Demotion, if ever, is its own ADR.
