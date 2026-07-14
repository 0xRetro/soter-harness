# ADR-0028: The resources context system — decreed

- **Status:** Accepted
- **Date:** 2026-07-14

## Context
[DB] Resources (formerly Subscriptions and Resources) tracks the team's external
accounts, platforms, shared assets, and registries — 22 live entries surveyed
2026-07-14. Its governance now exists (the Resources policy standard, Notion, v0.3:
identity, Type/Access semantics, the no-secrets rule, org billing defaults, the
six-section body shape) and its publishing target is registered (`resources` in
targets.md). The capture mechanism is being forged, but no existing context system
owns this concern: crm owns relationships, product-development owns what the team
BUILDS — nothing owns what the team USES. Per ADR-0017 a system is born from ≥3 real
pieces or decreed; the concern's operational pieces (the policy standard, the target
registration, 22 live records) live in Notion and the publishing system, so this is
a decree.

## Decision
Decree the **resources** context system: the concern of tracking external accounts,
platforms, shared assets, and registries the team uses — mirrored to the live
[DB] Resources and governed by the Resources policy standard. Deliberately
MECHANISM-LESS at birth: the forge baseline for a capturing-a-resource guide was run
(2026-07-14, contained fresh-context agent, password-bait pressure scenario) and the
unguided agent FULLY COMPLIED — found the policy standard via the registered target,
refused the credential citing the no-secrets rule, named per D1, de-duped per D3,
shaped the body to v0.3, and held at the write gate. Per the forge's no-observed-
failure rule, the guide is not built. Consumers: the team (who has what, who
administers it, how to get access); the publishing bindings that write the records.

## Consequences
The concern has a home with declared invariants — above all that credential values
never enter records — without a redundant guide: the policy standard + target
registration are the teaching layer, and that bridge is now evidence, not hope.
Mechanisms are forged only when an observed failure warrants one
(validating-resources is the likely first). If the finance/payment-method side grows
its own rules (the policy's `not defined`), that is its own decision.
