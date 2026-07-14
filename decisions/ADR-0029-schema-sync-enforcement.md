# ADR-0029: Schema sync is enforced by same-pass mirror audits and a checker freshness nag

- **Status:** Accepted
- **Date:** 2026-07-14

## Context
Live-first (ADR-0016) protects every WRITE — bindings fetch the live schema before
shaping — but nothing protected the documentation: policy-standard Fields sections and
the harness's own `targets.md` mirror rot silently, and the audit that catches drift ran
only when someone remembered. Worse, `targets.md` — the third copy of every schema —
was audited by nothing at all: schema-audit diffed only the Notion doc. A first draft
put the cadence in the org's Process Inventory; the human rejected that — the inventory
holds the ORG's operational processes, and harness self-maintenance is harness
machinery, not org work.

## Decision
`auditing-a-schema-doc` diffs a registered target's `targets.md` entry against the SAME
live fetch as the schema doc — one audit, both surfaces; mirror fixes land through the
harness gate (repo edit), doc fixes through the update binding. The cadence is the
checker's `TARGET_STALE` rule: every registered target carries an inline
`live-verified YYYY-MM-DD` stamp, and the checker — offline, per ADR-0010 — warns when
a stamp is missing or older than its threshold, on every run (edit hook, `--all`, CI).
The nag clears only by re-auditing and re-stamping. No Notion coupling is added to the
checker, and nothing about the harness's upkeep enters the Process Inventory.

## Consequences
Doc-rot is bounded by the stamp threshold instead of unbounded, and the reminder cannot
be forgotten — it fires wherever the checker runs. A DB documented in one surface but
not the other is now itself a finding, and an unstamped target is a violation, not a
blank. Cost: audits become a recurring chore the warnings nag into existence; stamp
threshold tuning lives in one checker constant. The audit stays human-gated end to end.
Revisit triggers: Notion exposing a schema-version/webhook signal (event-driven audits
would beat stamp-age nagging), or warnings being habitually ignored (then escalate the
rule to an error, or automate the detection half as a scheduled read-only agent under
ADR-0013's automation-layer safety rules).
