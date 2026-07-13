---
name: product-development
layer: context
system: product-development
kind: component
mold: system-card
---

# System: product-development

## Promise
Carry a captured use-case to a shipped feature, tracked lightly. Each feature is a
**feature record** (a card) linked to a **project page** (its spec); work moves through
the **feature lifecycle** — capture → define → build → review → ship. Consumers: the
team tracking what is being built and why; the publishing binding that mirrors records
and pages into Notion. Deliberately lightweight — self-directed, no forced gates.

## Mechanisms
None yet. Each lifecycle stage becomes a guide forged as the process firms up
(capturing, defining, reviewing, shipping). Pushing records and pages out lives in the
publishing system, not here.

## Components
None yet — a feature-record schema and stage guides are forged as needed. Notion
targets for the cards and project pages live in the publishing binding's `targets.md`.

## Concepts
feature record · project page · feature lifecycle

## Invariants
- every feature record links to its project page — `unenforced: runtime/gate (lightweight)`
- the lifecycle stage is tracked on the record — `unenforced: runtime`
- records and pages reach Notion through the publishing binding, never a bespoke push — enforcer: (gate) + the publishing system
