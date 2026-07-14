---
name: writing-records-to-notion
layer: automation
system: publishing
kind: component
mold: standard
---

# Writing records to Notion

## The model
Creating or updating any Notion database record follows one disciplined sequence — so
every domain guide (features, tasks, contacts, orgs, …) writes the same safe way. A
domain guide **references this standard** for the shared spine and states only what is
specific to it. The spine:

1. **Fetch the live schema first.** Never assume field names, types, or option sets
   (ADR-0014); re-fetch if the DB may have changed. If the target's subject has a
   **policy standard**, fetch that too — its rules govern field semantics and how values
   are determined (ADR-0021).
2. **Shape plain fields** to the real schema (title/text/number/email/url/date/checkbox).
3. **Resolve relations to real target page ids — never fabricate.** Search the related DB
   by name → its page id. Unresolved ≠ nonexistent: if not found, ask (create it first?
   wrong name? leave empty?) — never guess an id, never leave it silently blank as if resolved.
4. **Match select/multi_select values to the live option set — never invent.** A value not
   in the set is rejected or creates a junk option. Don't over-read a fuzzy description;
   if no option clearly fits, leave the field empty and ask.
5. **Pin relative dates** ("next Friday") to a concrete ISO date; confirm if ambiguous.
6. **De-dup** — search the target DB for an existing matching record before creating.
7. **Confirm before the write** — show the resolved record (matched options, resolved-or-
   empty relations, flagged defaults). External, hard-to-undo write; urgency never waives it.
8. **Write via the publishing binding** — `/pushing-to-notion` (create) or
   `/updating-a-notion-page` (update) — then verify.

Don't silently default an unstated field — a default is a guess; flag it, don't assert it.

## Use when / don't
- Applies when: any guide creates or updates a Notion record.
- Doesn't apply when: reading from Notion; non-Notion stores.
