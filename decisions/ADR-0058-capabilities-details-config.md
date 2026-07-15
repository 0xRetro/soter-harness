# ADR-0058: Capabilities by area is a hand-authored details list, not a linked view

- **Status:** Proposed
- **Date:** 2026-07-15

## Context

The tooling-page template's Capabilities by area section was a linked view of the
page's own embedded Feature Board grouped by `Area` — self-syncing, but it renders
as nothing until the board is populated and its `Area` options defined, and the
grouped-board presentation wasn't the reading the humans reach for. Reviewing the
freshly created Atlas Review page against Process Platform's hand-authored section,
Retro named the Process Platform shape — a collapsed `<details>` toggle per area
with ✅ built / ⬜ planned bullets — as the desired component.

## Decision

`[New Product Template]`'s Capabilities by area section is a hand-authored
`<details>` toggle per area (the tool's own 4–7 axis) with ✅ built / ⬜ planned
bullets, each linking its feature card where one exists. The self-syncing
linked-view block is removed from the template.

## Consequences

- Glanceable built-vs-planned reading with no board-setup prerequisite; matches how
  the section was actually authored in practice (Process Platform never migrated to
  the linked view).
- Cost accepted knowingly: the section duplicates Feature Board content and is
  updated by hand — stale ✅/⬜ marks are now a drift class the linked view could
  not produce.
- The board's `Area` options remain an intake-gate decision (they still power board
  grouping); the Capabilities section mirrors that axis but no longer depends on
  the options existing.
- Pages still carrying the linked-view config (the Soter Harness tooling page)
  migrate during the tooling-page review wave.
- Revisit trigger: a sweep finding hand-written Capabilities sections drifted from
  their boards — that evidence reopens the synced-view question (or motivates a
  check rule instead).
