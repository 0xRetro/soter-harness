---
name: adr
layer: kernel
system: template
kind: component
mold: mold
---

# Mold: ADR

<!-- Copy the Shape skeleton to decisions/ADR-<n>-<slug>.md (next free number from
     decisions/README.md). ADRs carry their own header, not classification
     frontmatter (ADR-0007). Immutable once Accepted — supersede, never edit. -->

## Makes
A decision record at `decisions/ADR-<n>-<slug>.md` plus one index line in `decisions/README.md`.

## Frontmatter
None — ADRs use the in-body header below (status + date), per the log's own convention.

## Shape
```markdown
# ADR-<n>: <title>

- **Status:** Proposed <!-- → Accepted → (only ever edited to) Superseded by ADR-<m> -->
- **Date:** <date>

## Context
<!-- The situation, 2-5 lines: why this question arose. -->

## Decision
<!-- 1-3 lines, active voice: the choice, not the journey. -->

## Consequences
<!-- Costs, constraints, what this enables/forbids — and the revisit trigger. -->
```

## Check rules
- filename ADR-<n>-<slug>.md; Status/Date/Context/Decision/Consequences present — checker `NAME_LINT` + `SECTIONS_MISSING`
- no unfilled mold residue; no injection/zero-width — checker `PLACEHOLDER` + `SEC_LINT`
