---
name: crm
layer: context
system: crm
kind: component
mold: system-card
---

# System: crm

## Promise
Track relationships: organizations (**orgs**) and the people at them (**contacts**),
mirrored to the real Notion [DB] Orgs and [DB] Contacts and standardized to their
documented schemas. A contact belongs to an org (the Org relation). Consumers: the team
managing relationships; ingestion (people/orgs from a source); the publishing bindings.
Mirrors the workspace's Notion Standards — those DB standard pages are the source of
truth for shape.

## Mechanisms
- **capturing-a-contact** — reads: a described person · produces: a [DB] Contacts row
  (Name + Email + Role/Status/etc. as given, Org relation resolved) · runs-when: a user
  invokes `/capturing-a-contact` · invariants: the Org relation is resolved to a real
  page id or left empty, never fabricated; select/multi_select values are matched to the
  live option set, never invented.
- Capturing/updating orgs is forged as needed. Writes go through the publishing bindings.

## Components
- `.claude/skills/capturing-a-contact/SKILL.md` — the contact-capture guide. Notion
  targets `orgs` and `contacts` (with their real schemas + relations) live in the
  publishing binding's `targets.md`.

## Concepts
org · contact

## Invariants
- contacts and orgs are shaped to the live [DB] Contacts / [DB] Orgs schemas, never an assumed one — enforcer: (gate) + publishing's live schema fetch
- select/multi_select values are matched to the live option set, never invented — enforcer: (gate) + the guide's schema-fetch step
- the Org relation is resolved to a real page id or left empty — enforcer: (gate) + the guide's resolve step
- records reach Notion through the publishing bindings (the canonical rule; see the publishing card) — enforcer: (gate) + publishing
