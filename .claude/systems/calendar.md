---
name: calendar
layer: context
system: calendar
kind: component
mold: system-card
---

# System: calendar

## Promise
The team's standing **commitments** — recurring meeting series, date-specific
events, and recurring obligation windows — are defined once in the live [DB]
Calendar: what each is for, who attends, and what it links to (org, project,
process). Google Calendar stays authoritative for time and recurrence; the
registry is authoritative for meaning and links, joined by the Google Event ID —
a registry, never a mirror. Decreed by ADR-0057. Consumers: the team (what stands
and why); the crm system's meeting pre-creation (the intended generation source);
the process system (Windows executing defined processes); the publishing bindings.
Mirrors the LIVE [DB] Calendar schema — fetch live, never an assumed one (ADR-0016).

## Mechanisms
- None of its own — decreed with its pieces live (ADR-0057): the Calendar policy
  standard (Notion), the `calendar` target registration, the [Calendar Entry
  Template] row, and two worked-example commitments. The intended mechanisms —
  registry↔Google reconciliation (an audit in the schema-audit mold, never a
  two-way sync engine) and registry-driven pre-creation of [DB] Meetings rows —
  are forged evidence-first, each on an observed need. Writes go through the
  publishing bindings.

## Components
- None of its own. The Notion target `calendar` (live schema mirror) lives in the
  publishing binding's `targets.md`; the rules live in the Calendar policy standard
  (Notion, one doc per subject per ADR-0021).

## Concepts
commitment

## Invariants
- Google Calendar is authoritative for time and recurrence; the registry for meaning and links — on conflict, time follows Google — enforcer: (gate) + the Calendar policy standard
- a commitment with a Google counterpart carries its Google Event ID, the join key sync and audits use — enforcer: (gate) + the intake gate
- records reach Notion through the publishing bindings (the canonical rule; see the publishing card) — enforcer: (gate) + publishing
