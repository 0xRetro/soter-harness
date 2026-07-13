# ADR-0017: Systems are born from real pieces or decreed by ADR

- **Status:** Accepted
- **Date:** 2026-07-13

## Context
The foundation plan carried a rule the repo never codified: a system exists only when
it is BORN (≥3 real pieces plus a named consumer) or explicitly DECREED by a decision
record — empty or speculative systems are how gen-1 grew machinery nobody used. Since
then, real add-on systems were created with fewer than three pieces, and schema-audit
in particular landed after ADR-0016 had explicitly deferred it ("noted, not built"),
with no record of the decision to build it. The rule lived only in an untracked
planning file; a full-repo audit flagged both gaps.

## Decision
Codify the rule: a new system card requires either ≥3 real pieces with a named
consumer, or a decreeing ADR recording why it exists ahead of that mass. The six
existing add-on systems (publishing, ingestion, schema-audit, product-development,
project-management, crm) are hereby decreed: each was created with its first real
mechanism, names its consumers on its card, and grows by forging further mechanisms
into the declared spine.

## Consequences
The governance card gains this as an invariant, enforced at the gate (the checker
cannot count real pieces against a judgment of "real use"). Creating a system card
alongside its first forged mechanism stays legitimate — but the ADR recording that
choice lands in the same change, not never. Revisit trigger: a decreed system that
stays at one unused piece for a long stretch gets a retire-or-re-earn review rather
than remaining a permanent fixture.
