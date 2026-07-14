# ADR-0029: Schema sync is enforced by same-pass mirror audits and an ops-tier cadence

- **Status:** Accepted
- **Date:** 2026-07-14

## Context
Live-first (ADR-0016) protects every WRITE — bindings fetch the live schema before
shaping — but nothing protected the documentation: policy-standard Fields sections and
the harness's own `targets.md` mirror rot silently, and the audit that catches drift ran
only when someone remembered. Worse, `targets.md` — the third copy of every schema —
was audited by nothing at all: schema-audit diffed only the Notion doc. The checker
cannot close this (it is an offline drift-catcher, ADR-0010; it cannot fetch Notion).

## Decision
`auditing-a-schema-doc` diffs a registered target's `targets.md` entry against the SAME
live fetch as the schema doc — one audit, both surfaces; mirror fixes land through the
harness gate (repo edit), doc fixes through the update binding. The audit's cadence is
owned by the ops tier: a "Schema Audit Sweep" entry in the Process Inventory, its
Frequency property the enforcement — required by the org's own process system, not by
memory. No static schema check is added to the checker.

## Consequences
Doc-rot is bounded by the sweep interval instead of unbounded; a DB documented in one
surface but not the other is now itself a finding. Cost: a recurring operator duty (one
sweep run per cadence tick) and one more section per audit. The audit stays human-gated
end to end. Revisit triggers: Notion exposing a schema-version/webhook signal (would
enable event-driven audits instead of a cadence), or the sweep being repeatedly skipped
(then automate the detection half as a scheduled read-only agent under ADR-0013's
automation-layer safety rules).
