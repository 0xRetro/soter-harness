---
name: capturing-a-contact
description: >-
  Captures a person as a [DB] Contacts row — shaped to the live schema, with every
  select/multi-select value matched to a real existing option (never invented), the Org
  relation resolved to a real page id or left empty, de-duped, and confirmed before the
  write. Use when the user wants to add, capture, or log a contact or person into the
  CRM. Not for organizations (a separate guide), not for the Notion write mechanics
  (/pushing-to-notion), and not for tasks or features.
disable-model-invocation: true
layer: context
system: crm
kind: component
mold: how-to-guide
---

# Capturing a contact

## Goal
A person becomes a [DB] Contacts row shaped to the live schema — every select value a
real option, the Org resolved to a real id or empty, de-duped and confirmed before write.

## Use when / don't use when
- Use when: adding a person to the CRM.
- Not for: organizations (a separate guide); the Notion write mechanics
  (`/pushing-to-notion`); tasks (`/capturing-a-task`) or features.

## Steps
1. **Shape the plain fields** (schema in `.claude/skills/pushing-to-notion/targets.md`):
   `Name` (title) · `Email` · `Telegram`/`Signal`/`Github`/`Timezone (UTC)`/`Source`
   (text). Record where the contact came from in `Source` if known.
2. **Fetch the live option sets and MATCH — never invent (the load-bearing step).** For
   `Role`, `Status`, `Disposition`, `Authority`, `Tags`, fetch the live schema's options
   (fetch the target data source — the same schema fetch `/pushing-to-notion` does) and
   map the description to an EXISTING one. "VP of Engineering" → the closest real `Role`,
   or leave it empty and flag if none fits. A value not in the set is rejected or silently
   creates a junk option. Don't over-read fuzzy words — "supportive" is not necessarily
   "Champion" (vs "Coach"). Tie-breaker: if no option clearly fits, leave the field empty
   and ask — never force a closest-match under pressure.
3. **Resolve the Org relation.** Search [DB] Orgs for the org name → its page id. If not
   found: create the org first (a `capturing-an-org` step, forthcoming) or leave the
   relation empty and flag — never fabricate an id.
4. **Don't invent unstated fields.** Leave blank what the user didn't say; don't silently
   default `Status`. If you apply a default, flag it as a default, not a fact.
5. **De-dup.** Search [DB] Contacts by name and email before creating.
6. **Confirm before writing.** Show the resolved record — the matched option values, the
   resolved-or-empty Org, and any flagged defaults — and get an explicit okay. External,
   hard-to-undo write.
7. **Publish + verify.** Create via `/pushing-to-notion` (target `contacts`); report the
   created url and confirm the Org linked.

## Gotchas
- (baseline) Never invent a select/multi_select value — fetch the live options and match,
  or leave empty; a wrong value is rejected or creates a junk option (the core failure).
- (baseline) Don't over-read a fuzzy description into a strong option ("supportive" ≠
  automatically "Champion") — pick the defensible read or ask.
- (baseline) Never fabricate the Org page id — resolve via search, create the org first,
  or leave empty and flag.
- (baseline) Don't silently default `Status` or other unstated fields — a default is a
  guess; flag it. De-dup and confirm before the write.

## Evals
- `.claude/evals/capturing-a-contact/happy-path.md`
- `.claude/evals/capturing-a-contact/pressure-guess-role.md`
- `.claude/evals/capturing-a-contact/invariant-no-invented-option.md`
