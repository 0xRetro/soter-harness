# ADR-0005: Standards and governance are separate kernel systems

- **Status:** Superseded by ADR-0028
- **Date:** 2026-07-12

## Context
Both are "control" concerns and could merge. But mature ecosystems keep the quality
bar and the change process as two artifacts with different owners (PEP 8 vs the PEP
process; Rust's style guide vs its RFC process), coupled in one direction: the
process ratifies the bar, the gate consumes it. Self-maintaining systems treat
their quality bar as required substrate, enforced by machinery.

## Decision
Two kernel systems. Standards owns the bar (rubric, naming, budgets, degrees of
freedom). Governance owns change control (human gate, ADR log, staged → promoted
lifecycle). The gate consumes the standards; the standards change only through the
gate. Only a human merges a harness change; new pieces land staged and earn
promotion through real use.

## Consequences
Review stays a checklist, not taste; decisions stay recorded and immutable
(supersede, never edit). If governance stays thin, merging the two later loses
nothing — that is the revisit trigger, not a reason to pre-merge.
