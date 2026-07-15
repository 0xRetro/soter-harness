# ADR-0048: The docs context system — decreed

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

[DB] Docs is live and load-bearing — Projects, Tasks, Orgs, and Opportunities all
carry Docs relations — but no system owns the concern: crm owns relationships,
resources owns what the team USES, product-development owns what it BUILDS; nothing
owns what the team KNOWS or SHARES. The Docs integration feature card (Planned, on
the Soter Harness tooling page) already scopes the build-out — a rules-first policy
standard (type × audience model), a registered `docs` target, a capture guide — but
those pieces need an owning system to declare their invariants. Unlike resources
(ADR-0028, decreed after its governance existed), none of the pieces exist yet, so
this is a decree ahead of pieces (ADR-0017's decree path).

## Decision

Decree the **docs** context system: the concern of the team's shared documents and
links, mirrored to the live [DB] Docs and governed by the (to-be-authored) Docs
policy standard. Boundary against resources: resources answers "what do we use and
who has access"; docs answers "what do we know or share and who is it for."
Consumers: the team; the context systems whose records relate to docs; the
publishing bindings that write the records.

## Consequences

The feature card's acceptance boxes become the system's build-out, each with a
declared home: the policy standard through the policy system's authoring loop, the
target registration in publishing's `targets.md`, and a capture guide only if a
forge baseline fails (resources' no-observed-failure precedent, ADR-0028).
Harness-authored docs pushed to Notion become possible later without new machinery —
a doc type's shape in the policy standard plus the existing notion-push binding.
Revisit trigger: the type × audience model collapsing into resources' model (one
policy covering both subjects), which would merge the systems by a superseding ADR.
