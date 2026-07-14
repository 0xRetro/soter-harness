# ADR-0022: The policy system — core layer, decreed

- **Status:** Accepted
- **Date:** 2026-07-13

## Context
ADR-0021 makes policy standards the governance layer for operational subjects, and that
concept needs an owning system before its pieces exist (ADR-0017: born or decreed). The
kernel `standards` system is a different concern — it sets the quality bar for HARNESS
pieces; nothing owns the governance of operational subjects. The shape of a policy
standard (rules-first sections, overlap rules, lifecycle) is generic and reusable by any
org, while the actual policy docs (Addresses, Orgs) are org-specific and live in Notion.

## Decision
Decree the **policy** system at `layer: core`. It owns the policy-standard concept and,
once the Notion structure settles, the generic shaping standard (and any authoring guide,
forged staged through the loop). The org-specific policy docs themselves stay in Notion
(ADR-0021); any [DB] Policy Standards push target belongs to publishing.

## Consequences
The system card and LEXICON registration land with this decree; the card starts with zero
mechanisms by design. `policy standard` and the kernel `standard` (a harness artifact)
coexist as distinct registered terms — the cards draw the boundary. Revisit trigger: a
decreed system left at zero real mechanisms for a long stretch gets a retire-or-re-earn
review (ADR-0017).
