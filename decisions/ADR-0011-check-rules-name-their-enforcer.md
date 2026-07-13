# ADR-0011: Every declared check rule names its enforcer

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
A claims-vs-reality sweep found the mold and system-card "Check rules" sections
declared ~8 validations the checker never implemented (component-path existence,
concept-in-registry, section order, ADR placeholder residue, and more). A rule that
reads as enforced but isn't is the exact drift that hollowed out the predecessor
harness's trust — writing a rule was mistaken for enforcing one.

## Decision
Every line in a mold's "Check rules" section names its enforcer: a checker code
(`FM_CLASS`, `CARD_PATH`, …) or `(gate)` for a human-review item. A validation with
no enforcer does not belong in "Check rules" — it goes in the RUBRIC as a reviewer
item. The load-bearing cross-checks the sweep exposed are now implemented (`CARD_PATH`,
`CARD_CONCEPT`, `SECTION_ORDER`, name-presence, ADR placeholder + security lint) and
planted in the selftest.

## Consequences
"Check rules" sections are now honest inventories, not aspirations, matching the
invariant convention already used on system cards (`enforcer: …` / `unenforced:
<reason>`). The gap that remains is by-design human-gate territory (ADR-0010).
Revisit by adding a meta-check that flags an unannotated check-rule line if this
convention starts drifting.
