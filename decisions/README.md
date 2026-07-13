# Decisions — the ADR log

Append-only. One short record per durable decision; immutable once Accepted —
supersede, never edit. Written via `/writing-adrs` from `.claude/templates/adr.md`.

| # | Title | Status |
|---|---|---|
| [ADR-0001](ADR-0001-port-sky-kernel.md) | Port the sky-harness kernel; soter is its successor | Accepted |
| [ADR-0002](ADR-0002-systems-first-classification.md) | Systems-first classification: four declared fields | Accepted |
| [ADR-0003](ADR-0003-one-shared-checker.md) | One enforcement system, one shared checker, rules as data | Accepted |
| [ADR-0004](ADR-0004-platform-quarantine.md) | Platform primitives are forms, not systems; one quarantine system | Accepted |
| [ADR-0005](ADR-0005-standards-governance-separate.md) | Standards and governance are separate kernel systems | Accepted |
| [ADR-0006](ADR-0006-evals-kernel-substrate.md) | Evals are kernel substrate; cases are data, the runner is replaceable | Accepted |
| [ADR-0007](ADR-0007-classification-scope-singletons.md) | Classification frontmatter scope; `mold: singleton` allowed | Accepted |
| [ADR-0008](ADR-0008-promotion-third-state.md) | The promotion lifecycle has a third state (index-only) | Accepted |
| [ADR-0009](ADR-0009-classifying-non-markdown-logic.md) | Non-markdown logic is classified on its system's card | Accepted |
| [ADR-0010](ADR-0010-checker-is-a-drift-catcher.md) | The checker is a cooperative drift-catcher, not a security boundary | Accepted |
| [ADR-0011](ADR-0011-check-rules-name-their-enforcer.md) | Every declared check rule names its enforcer | Accepted |
| [ADR-0012](ADR-0012-all-layers-one-repo.md) | Harness holds all four layers; genericness is per-piece; context/automation are add-ons | Accepted |
