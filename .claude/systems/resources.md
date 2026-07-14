---
name: resources
layer: context
system: resources
kind: component
mold: system-card
---

# System: resources

## Promise
The team's external **resources** — accounts, platforms, shared assets, registries —
are tracked in the live [DB] Resources: what the team uses, who administers it, and
how to get access, governed by the Resources policy standard (Notion). Decreed by
ADR-0028. Consumers: the team (access and administration answers); the publishing
bindings that write the records. Mirrors the LIVE [DB] Resources schema — fetch live,
never an assumed one (ADR-0016).

## Mechanisms
None yet — deliberately (ADR-0028): the forge baseline for a capture guide observed
an unguided agent fully comply (found the policy standard via the registered target,
refused a credential, D1/D2/D3 honored, write held), so no guide was built. Capture
runs through the publishing bindings guided by the Resources policy standard.
Mechanisms are forged when an observed failure warrants one — validating-resources
(URL liveness, body-shape and billing-defaults conformance, config↔Tooling
cross-refs) is the likely first.

## Components
- None in the harness yet. The Notion target `resources` (live schema + body shape)
  lives in the publishing binding's `targets.md`; the rules live in the Resources
  policy standard (Notion, one doc per subject per ADR-0021).

## Concepts
resource

## Invariants
- no credential value, token, password, or one-time code ever enters a record; standing
  invite links only by explicit admin decision — enforcer: (gate) + the Resources
  policy standard + the bindings' confirm
- records are shaped to the live [DB] Resources schema and the policy standard's body
  shape, never an assumed one — enforcer: (gate) + publishing's live schema fetch
- records reach Notion through the publishing bindings (the canonical rule; see the
  publishing card) — enforcer: (gate) + publishing
