# ADR-0028: Standards and governance stay separate; hard forks are fine when add-ons feel slow

- **Status:** Proposed
- **Date:** 2026-07-14

## Context
ADR-0005 (Accepted) split standards and governance into two kernel systems. The human
directed that its decision additionally allow hard forks whenever overlays feel slow
("overlay" is pre-ADR-0012 vocabulary; the LEXICON term is add-on). Accepted ADRs are
immutable — supersede, never edit — so the addition lands as this superseding record,
carrying ADR-0005's decision forward. The fork/add-on ground also borders ADR-0012.

## Decision
Carries ADR-0005 forward unchanged — Standards owns the bar (rubric, naming, budgets,
degrees of freedom); Governance owns change control (human gate, ADR log, staged →
promoted lifecycle); the gate consumes the standards and the standards change only
through the gate — and adds: a hard fork is fine whenever add-ons ("overlays") feel slow.

## Consequences
Everything ADR-0005 carried still holds: review stays a checklist, not taste; decisions
stay recorded and immutable (supersede, never edit). The new allowance is an escape
hatch from the gate — a hard fork leaves the checker, the ADR log, and the promotion
lifecycle behind, and "feels slow" is a judgment call with no measurable bar. Revisit
triggers: the first real fork (record what "slow" meant and whether it merged back),
and — unchanged from ADR-0005 — if governance stays thin, merging the two systems
later loses nothing.
