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
Mirrors the LIVE [DB] Orgs / [DB] Contacts schemas — the Standards pages document these
but can lag; fetch live (ADR-0016).

## Mechanisms
- **capturing-a-contact** — reads: a described person · produces: a [DB] Contacts row
  (Name + Email + Role/Status/etc. as given, Org relation resolved) · runs-when: a user
  invokes `/capturing-a-contact` · invariants: the Org relation is resolved to a real
  page id or left empty, never fabricated; select/multi_select values are matched to the
  live option set, never invented.
- **capturing-an-org** — reads: a described organization · produces: a [DB] Orgs row
  (Name + Type/Tags matched to live options, handles normalized to URLs) · runs-when: a
  user invokes `/capturing-an-org` · invariants: sector words go to Tags not Type;
  Type/Tags matched to the live option set; dedup is alias-aware (orgs are relation targets).
- Updating orgs/contacts is forged as needed. Writes go through the publishing bindings.

## Components
- `.claude/skills/capturing-a-contact/SKILL.md` — the contact-capture guide
- `.claude/skills/capturing-an-org/SKILL.md` — the org-capture guide. Notion targets
  `orgs` and `contacts` (with their real schemas + relations) live in the publishing
  binding's `targets.md`.

## Concepts
org · contact

## Invariants
- contacts and orgs are shaped to the live [DB] Contacts / [DB] Orgs schemas, never an assumed one — enforcer: (gate) + publishing's live schema fetch
- select/multi_select values are matched to the live option set, never invented — enforcer: (gate) + the guide's schema-fetch step
- the Org relation is resolved to a real page id or left empty — enforcer: (gate) + the guide's resolve step
- records reach Notion through the publishing bindings (the canonical rule; see the publishing card) — enforcer: (gate) + publishing
