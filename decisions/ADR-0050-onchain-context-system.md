# ADR-0050: The onchain context system — decreed

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

[DB] Addresses is live and load-bearing — a registered target, two policy standards
(Addresses, Onchain Operations), and structural links to Process Runs — but no system
owns the concern: crm owns relationships, process owns definitions and runs; nothing
owns the org's onchain footprint. Naming was weighed in-session: "crypto" rejected as
vaguer and a synonym risk; "onchain" matches the Onchain Operations policy's own
vocabulary. Decreed ahead of pieces per ADR-0017's decree path (the resources and
docs precedents).

## Decision

Decree the **onchain** context system: the org's onchain footprint — addresses,
wallets and safes, and the rules for operating them — mirrored to the live
[DB] Addresses and governed by the Addresses and Onchain Operations policy standards
(Notion). Boundary: the process system owns verification processes and runs (an
address's Verification Process relation points there); onchain owns the account
records and the operational rules.

## Consequences

Addresses and the Onchain Operations policy gain a declared harness home for their
invariants (no credential values in records; relations resolved, never fabricated;
Verified checked only with a linked Closed·Success run). A capture guide follows the
docs precedent — forged only on an observed RED baseline. Accepted in-session
(2026-07-15); the landing PR is transport, not the gate. Revisit trigger: a second
chain-adjacent database, or the process/onchain boundary generating real confusion.
