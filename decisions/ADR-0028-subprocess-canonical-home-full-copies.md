# ADR-0028: Subprocess reuse — canonical home + full inline copies

**Status:** Accepted
**Date:** 2026-07-14

## Context

The Wallet Penny Test's Step 3 pointed at an undocumented "Transaction Verification
sub-process" (a red-team CRITICAL: the process's core safety gate did not exist). The
sequence already lived, six times over, inside the Integration Boost Weekly Payment
Process — build → independent decode → hash verification → simulation → extension/device
match → sign+queue → handoff → executor full re-verification → broadcast+proof. Anything
that validates by transaction will reuse it. Two reuse shapes were on the table:
pointer-only references (callers jump to the home) or full copies in every caller.
Pointer-jumping breaks the one-doc run rule (ADR-0023: a run needs only the process doc).

## Decision

A reused sequence (subprocess) gets ONE canonical home — its own [DB] Process Inventory
entry — whose **Used By** section lists every process carrying it. Callers carry the flow
**in full**, adapted to their parameters (roles, the approved instruction), with one
provenance line naming the home. Never a pointer-only reference. When the home's sequence
changes, every Used By carrier updates in the same change — the fan-out list IS the
update obligation. The sequence's law (rules, tooling set, variant selection) lives in
the owning policy standard — first instance: Onchain Operations, governing Transaction
Verification.

## Consequences

- Operators execute one document end to end; drift is managed, not avoided — the Used By
  list makes stale copies findable and the update duty explicit.
- Extraction stays triggered by second use (ADR-0021); extraction now means "create the
  home + convert existing occurrences into declared copies."
- A carrier whose copy diverges from the home without a same-change reason is drift — a
  future audit mechanism's check, review-enforced until then.
