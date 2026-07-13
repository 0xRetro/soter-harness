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
databases and kept standardized to their documented schemas. Consumers: the team
tracking what's being delivered, for whom, by when; ingestion (which can produce tasks
from a source); the publishing bindings that write them. Mirrors the workspace's own
Notion Standards — those DB standard pages are the source of truth for shape.

## Mechanisms
- **capturing-a-task** (forging) — reads: a described work item · produces: a [DB] Tasks
  row (Task Name + Summary + Status = Not started, priority/assignee/due as given,
  related to its project/org) · runs-when: a user invokes `/capturing-a-task` ·
  invariants: relations (Project/Org/Assignee) are resolved to real page ids or left
  empty, never fabricated; status starts at Not started.
- Further mechanisms (creating a project, advancing a task) forged as needed. Writes go
  through the publishing bindings; source-driven task intake reuses the ingestion spine.

## Components
- the `capturing-a-task` guide (forging). Notion targets `tasks` and `projects` (with
  their real schemas + relations) live in the publishing binding's `targets.md`.

## Concepts
project · task

## Invariants
- tasks and projects are shaped to the live [DB] Tasks / [DB] Projects schemas, never an assumed one — enforcer: (gate) + publishing's live schema fetch
- relations are resolved to real target page ids or left empty — enforcer: (gate) + the guide's resolve step
- records reach Notion through the publishing bindings, never a bespoke push — enforcer: (gate) + the publishing system
