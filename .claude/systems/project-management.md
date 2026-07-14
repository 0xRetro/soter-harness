---
name: project-management
layer: context
system: project-management
kind: component
mold: system-card
---

# System: project-management

## Promise
Track delivery above the feature level: **projects** (client/internal engagements) and
the **tasks** that execute them, mirrored to the real Notion [DB] Projects and [DB] Tasks
databases. Consumers: the team
tracking what's being delivered, for whom, by when; ingestion (which can produce tasks
from a source); the publishing bindings that write them. Mirrors the LIVE [DB] Tasks /
[DB] Projects schemas (documentation can lag — fetch live, ADR-0016); task and project
semantics are governed by the subjects' policy standards in the org's registry
(ADR-0021). Decreed with the first add-on wave (ADR-0017).

## Mechanisms
- **capturing-a-task** — reads: a described actionable item · produces: a [DB] Tasks row
  (Name + Status = To Do, assignee/context/next-action as given, related to its
  project/org) · runs-when: a user invokes `/capturing-a-task` · invariants: relations
  (Project/Org/Assignee) are resolved to real page/user ids or left empty, never
  fabricated; relative dates pinned to concrete dates; status starts at To Do.
- Further mechanisms (creating a project, advancing a task) forged as needed — ONLY on
  an observed RED baseline. Project capture evaluated 2026-07-14: baseline GREEN — a
  fresh contained agent shaped a correct [DB] Projects row from the
  `writing-records-to-notion` spine, the `projects` target, and the sibling task guide
  alone (Type per the policy's D1, PM/Organization resolved to real ids, de-dup caught
  a genuine possible duplicate, write held at the confirm gate with the user away), so
  no capturing-a-project guide was authored (forge step 4). Re-propose only on an
  observed project-capture failure. Writes go
  through the publishing bindings; source-driven task intake reuses the ingestion spine.

## Components
- `.claude/skills/capturing-a-task/SKILL.md` — the task-capture guide. Notion targets
  `tasks` and `projects` (with their real schemas + relations) live in the publishing
  binding's `targets.md`.

## Concepts
project · task

## Invariants
- tasks and projects are shaped to the live [DB] Tasks / [DB] Projects schemas, never an assumed one — enforcer: (gate) + publishing's live schema fetch
- relations are resolved to real target page ids or left empty — enforcer: (gate) + the guide's resolve step
- records reach Notion through the publishing bindings (the canonical rule; see the publishing card) — enforcer: (gate) + publishing
- task and project semantics and lifecycle follow the subjects' policy standards (ADR-0021) — enforcer: (gate) + the write discipline's fetch-policy step
