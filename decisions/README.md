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
| [ADR-0013](ADR-0013-automation-layer-safety-enforcement.md) | Automation-layer safety (no autofire, no secret leaks) is mechanically enforced | Accepted |
| [ADR-0014](ADR-0014-mirror-live-notion-schema.md) | Product-development mirrors the live Notion schema; reality is the source of truth | Accepted |
| [ADR-0015](ADR-0015-shared-write-discipline-standard.md) | The Notion write-discipline lives in one shared standard; domain guides reference it | Accepted |
| [ADR-0016](ADR-0016-live-schema-over-standards-pages.md) | The live Notion data source is the source of truth, not the Standards pages | Accepted |
| [ADR-0017](ADR-0017-systems-born-or-decreed.md) | Systems are born from real pieces or decreed by ADR | Accepted |
| [ADR-0018](ADR-0018-promote-writing-adrs.md) | Promote writing-adrs to the guide index | Accepted |
| [ADR-0019](ADR-0019-process-system.md) | The process system — Process → Step → Work-item, defined not engineered | Accepted |
| [ADR-0020](ADR-0020-golden-freshness-git-coupling.md) | The checker reads git history for golden freshness (GOLDEN_STALE) | Accepted |
| [ADR-0021](ADR-0021-policy-standards-operating-model.md) | Subjects are governed by policy standards; the operating model | Accepted |
| [ADR-0022](ADR-0022-policy-system-core.md) | The policy system — core layer, decreed | Accepted |
| [ADR-0023](ADR-0023-process-copy-with-pointer.md) | Process bodies carry the operator-facing how — copy-with-pointer | Accepted |
| [ADR-0024](ADR-0024-promote-reviewing-a-repo.md) | Promote reviewing-a-repo to the guide index | Accepted |
| [ADR-0025](ADR-0025-promote-capturing-a-feature.md) | Promote capturing-a-feature to the guide index | Accepted |
| [ADR-0026](ADR-0026-sky-context-system.md) | The sky context system — ecosystem vocabulary owned once | Accepted |
| [ADR-0027](ADR-0027-multi-agent-operating-model.md) | Multi-agent operating model — worktrees per session, contained eval runners | Accepted |
| [ADR-0028](ADR-0028-resources-context-system.md) | The resources context system — decreed mechanism-less; baseline complied unguided | Accepted |
| [ADR-0029](ADR-0029-schema-sync-enforcement.md) | Schema sync is enforced by same-pass mirror audits and a checker freshness nag | Accepted |
| [ADR-0030](ADR-0030-adr-allocation-scans-live-branches.md) | ADR numbers are allocated against main plus every live branch (0028/0029 claimed on live branches) | Accepted |
| [ADR-0031](ADR-0031-org-harness-boundary.md) | The org–harness boundary is bidirectional | Accepted |
| [ADR-0032](ADR-0032-subprocess-canonical-home-full-copies.md) | Subprocess reuse — canonical home + full inline copies | Accepted |
| [ADR-0033](ADR-0033-promote-running-evals.md) | Promote running-evals to the guide index | Accepted |
| [ADR-0034](ADR-0034-plugin-ships-at-parity.md) | The plugin ships the harness at parity — hook wiring mirrored (HOOK_PARITY), manifest unversioned while internal | Accepted |
| [ADR-0035](ADR-0035-turn-gate.md) | The turn gate — Stop hook holds a turn open once while checker errors stand | Accepted |
| [ADR-0036](ADR-0036-guard-over-permission-denies.md) | Session enforcement floor — guard regex over permission denies; force pushes blocked | Accepted |
| [ADR-0037](ADR-0037-retire-the-event-log.md) | Retire the event log — hooks cannot attribute skill use; native telemetry can | Accepted |
| [ADR-0038](ADR-0038-process-policy-linkage-structural.md) | Process↔policy linkage is a row relation, not body pointers | Accepted |
