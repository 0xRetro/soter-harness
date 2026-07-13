---
name: capturing-a-task
description: >-
  Captures an actionable work item as a [DB] Tasks row — shaped to the real schema, with
  the assignee and project/org relations resolved to real Notion ids (never fabricated),
  relative dates pinned to concrete dates, de-duped, and confirmed before the write. Use
  when the user wants to capture, log, add, or create a task. Not for creating a project
  (a different guide), not for the Notion write mechanics (/pushing-to-notion), and not
  for feature cards (/capturing-a-feature).
disable-model-invocation: true
layer: context
system: project-management
kind: component
mold: how-to-guide
---

# Capturing a task

## Goal
An actionable item becomes a [DB] Tasks row shaped to the real schema — its relations
resolved to real ids, its date concrete, de-duped and confirmed — at Status = Not started.

## Use when / don't use when
- Use when: turning a described work item into a tracked task.
- Not for: creating a project; the Notion write mechanics (`/pushing-to-notion`); feature
  cards (`/capturing-a-feature`).

## Steps
Follow the **`writing-records-to-notion`** standard (`.claude/standards/`) for the shared
spine — fetch schema · resolve relations (never fabricate) · match options · pin dates ·
de-dup · confirm · publish via the binding. Task-specific:
1. **Shape:** `Task Name` (title) · `Summary` (context) · `Priority` → Low/Medium/High/Urgent
   · `Status` = `Not started` (always, at capture). Expressed urgency about the *request*
   ("I'm slammed", "ASAP") is NOT a `Priority` — don't set it from that.
2. **Assignee** resolves via `Notion:notion-get-users` ("me" → the user's email → their
   id — a person field needs the id, not a name); `Project`/`Org` via search. Target
   `tasks`.

## Gotchas
Shared write-discipline gotchas live in the `writing-records-to-notion` standard;
task-specific ones only:
- (baseline) "next Friday" is ambiguous (nearest vs following week) — pin the convention
  and confirm when it's close; never store a relative phrase.
- (pressure) `get-users` may return multiple people or a bot — email→id isn't always 1:1;
  confirm the right person before using an id, don't grab the first match.

## Evals
- `.claude/evals/capturing-a-task/happy-path.md`
- `.claude/evals/capturing-a-task/pressure-skip-resolve.md`
- `.claude/evals/capturing-a-task/invariant-no-fabricated-id.md`
