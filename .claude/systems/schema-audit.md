---
name: schema-audit
layer: automation
system: schema-audit
kind: component
mold: system-card
---

# System: schema-audit

## Promise
Each database's **schema doc** (the Notion page documenting its fields — the workspace's
"[DB] X Standards" pages) stays true to the live DB. Drift between doc and reality is
detected and reconciled through a human gate. The inverse of publishing: it keeps Notion's
own documentation honest, rather than writing records. Consumers: the team that trusts the
schema docs; every harness guide that reads a schema (a true doc means fewer live re-fetches
of stale surprises — though live is still the source of truth, ADR-0016).

## Mechanisms
- **auditing-a-schema-doc** — reads: a DB's live schema + its schema doc's
  documented fields · produces: a drift report (fields missing/extra, type mismatches,
  option-set changes) and, on a human okay, the doc updated to match live · runs-when: a
  user invokes `/auditing-a-schema-doc` · invariants: the diff is against the LIVE schema,
  never a cached one (ADR-0016); the doc is never edited without a human okay (it is the
  team's documentation); reconciliation writes go through the update binding.
- Auditing views/templates/relations is forged as needed; each follows the same
  fetch-live → diff → report → gated-reconcile shape.

## Components
- `.claude/skills/auditing-a-schema-doc/SKILL.md` — the audit/reconcile guide. Uses the
  publishing update binding (`updating-a-notion-page`) to write reconciliations.

## Concepts
schema doc · schema drift

## Invariants
- the diff is always against the live schema, never a cached/assumed one — enforcer: (gate) + the guide's fetch-live step
- a schema doc is never edited without a human okay — enforcer: (gate) + the update binding's confirm
- reconciliation writes go through the publishing update binding, never a bespoke push — enforcer: (gate) + the publishing system
