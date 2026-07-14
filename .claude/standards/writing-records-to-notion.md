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
8. **Body from the target's registered template, facts only.** If the target records a
   page template (in `targets.md`), a new record's body starts from that template's
   sections — filled with gathered or derivable facts; a section that can't be filled
   stays visibly empty, never invented.
9. **Write via the publishing binding** — `/pushing-to-notion` (create) or
   `/updating-a-notion-page` (update) — then verify.

Don't silently default an unstated field — a default is a guess; flag it, don't assert it.
Unknowns in a record's body stay bare `not defined` — searchable, and they ARE the
worklist (the policy-doc convention, generalized to records).

### Async writes, templates, and schema changes (learned live 2026-07-14)

- **Submit a template/content operation exactly once, then poll its async task.** Notion
  applies them asynchronously and EVERY submission eventually lands — a "no-op" may
  materialize minutes later. Never re-submit because a fetch looks unchanged (a blind
  retry triple-applied a page template).
- **Verify only against a snapshot newer than your write.** The fetch view serves stale
  cached snapshots for ~a minute; a verify whose "as of" timestamp predates your last
  write proves nothing.
- **Batched content edits can PARTIALLY apply and still return success** (observed
  2026-07-14: one op of three landed, the other two silently skipped). And stored text
  differs from what you wrote — Notion auto-linkifies emails/URLs, so an old_str copied
  from your own draft may never match. Copy old_str from a FRESH fetch, and verify
  every op landed.
- **Never `apply_template` onto a record that already has real property values** — a
  template's default properties overwrite them. Write the body content directly instead.
- **A schema change checks the DB's registered templates AND affected record bodies.**
  When a property or option set changes, check whether any registered template sets a
  value in it (a template holding a removed option goes silently stale), sweep record
  bodies for references to the changed field (a removed property leaves "set the X
  property" strays), and update the `targets.md` mirror in the same change. Known edge:
  an ALTER of a select property wipes that property's description — restore it in the
  Notion UI.

## Use when / don't
- Applies when: any guide creates or updates a Notion record.
- Doesn't apply when: reading from Notion; non-Notion stores.
