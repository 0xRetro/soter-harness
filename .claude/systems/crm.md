---
name: crm
layer: context
system: crm
kind: component
mold: system-card
---

# System: crm

## Promise
Track relationships: organizations (**orgs**), the people at them (**contacts**), the
communication venues connecting us (**channels**), and the calls held with them
(**meetings**), mirrored to the real Notion [DB] Orgs, [DB] Contacts, [DB] Channels,
and [DB] Meetings. A contact belongs to an org (the Org relation); a channel
links its member contacts and related orgs. Consumers: the team
managing relationships; ingestion (people/orgs from a source); the publishing bindings;
the process system (runs name channels as inputs and comms venues).
Mirrors the LIVE schemas — the Standards pages document these
but can lag; fetch live (ADR-0016). Decreed with the first add-on wave (ADR-0017).

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
- **meetings** — the [DB] Meetings directory + its policy are live (a meeting links its
  participating orgs; rows are PRE-CREATED ahead of the call by the weekly generation
  run, so an existing series+date row is an update, never a duplicate); writes go through
  the publishing bindings against the `meetings` target. A dedicated
  `capturing-a-meeting` guide is forged when meeting writes become routine (a baseline
  run 2026-07-14 showed the shared write discipline already carries the capture case).
  Turning a meeting's transcript into records is the ingestion system's
  `processing-a-meeting` (ADR-0051).
- **channels** — the [DB] Channels directory + its policy are live (a channel record links
  member contacts and related orgs); processes reference channels today via the publishing
  bindings. A dedicated `capturing-a-channel` guide is forged when channel writes become
  routine.
- Updating orgs/contacts is forged as needed. Writes go through the publishing bindings.

## Components
- `.claude/skills/capturing-a-contact/SKILL.md` — the contact-capture guide
- `.claude/skills/capturing-an-org/SKILL.md` — the org-capture guide. Notion targets
  `orgs`, `contacts`, `channels`, and `meetings` (with their real schemas + relations)
  live in the publishing binding's `targets.md`.

## Concepts
org · contact · channel · meeting

## Invariants
- orgs, contacts, and channels are shaped to their live [DB] schemas, never an assumed one — enforcer: (gate) + publishing's live schema fetch
- select/multi_select values are matched to the live option set, never invented — enforcer: (gate) + the guide's schema-fetch step
- the Org relation is resolved to a real page id or left empty — enforcer: (gate) + the guide's resolve step
- records reach Notion through the publishing bindings (the canonical rule; see the publishing card) — enforcer: (gate) + publishing
