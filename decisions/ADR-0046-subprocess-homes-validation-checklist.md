# ADR-0046: Subprocess homes — one-step validation checklist, marker tag, registered template

- **Status:** Proposed
- **Date:** 2026-07-14

## Context

Transaction Verification (the first subprocess home, ADR-0032) carried a two-slot
propose→execute choreography, but its reusable core was the invariant validation
checklist — the same checks recur at every validation point, whoever performs them —
and the choreography's law already lived in the Onchain Operations policy. Meanwhile
nothing marked a home structurally (its row read as a normal process), homes had no
mold (the Processes policy's D3 "keep the template's structure" was unmeetable), and
ADR-0043's slots-only rule blocked a home that legitimately needs a standing role.

## Decision

A subprocess home is scoped to the invariant sequence its callers reuse — Transaction
Verification rescoped and renamed to **Transaction Validation**, one role-agnostic
step; propose/queue/handoff/execute choreography lives in the calling processes under
the owning policy's operating rules. Homes are marked by a **Subprocess** Tags value
(discoverability only — the body's shape is what makes it one) and start from the
registered **[Subprocess Template]** (Initialization declares only caller-supplied
inputs; Used By is the carrier ledger; evidence lands on the calling run). A home
**binds slots or roles**: directory roles enter Related Roles as normal; caller-chosen
roles become capability-bound slots that never do.

## Consequences

- The checklist is adoptable at any validation point without dragging choreography
  along; the tag + template + D3 arm make the next home mechanical.
- Amends ADR-0043's slot rule (slots-or-roles) and reads ADR-0032's carry-in-full
  per validation point — a same-page reference stands in for a literal second copy
  within one carrier.
- The legacy Integration Boost doc remains in Transaction Validation's Used By as
  acknowledged migration debt.
- Revisit if a second home shows the one-step scoping too narrow (a reused sequence
  whose choreography itself is the invariant), or if Used By drift recurs despite the
  template.
