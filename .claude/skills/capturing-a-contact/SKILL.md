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
Follow the **`writing-records-to-notion`** standard (`.claude/standards/writing-records-to-notion.md`) for the shared
spine — fetch schema · resolve relations · match options (never invent) · de-dup ·
confirm · publish. Contact-specific:
1. **Shape:** `Name` · `Email` · `Telegram`/`Signal`/`Github`/`Timezone (UTC)`/`Source`
   (text). Record where the contact came from in `Source` if known. Target `contacts`.
2. **Fuzzy option-reads need care.** `Role`/`Disposition`/`Authority` map from prose —
   "supportive" is not necessarily "Champion" (vs "Coach"); "VP of Engineering" may match
   no real `Role`. FLEX: which live option a fuzzy phrase maps to, bounded by: it must be
   a defensible read of an existing option — otherwise leave empty and ask; never
   over-read into a strong option.
3. **Org relation:** search [DB] Orgs → the page id; if absent, create the org first
   (`/capturing-an-org`) or leave empty and flag.

## Gotchas
Shared write-discipline gotchas live in the `writing-records-to-notion` standard;
contact-specific ones only:
- (baseline) Fuzzy descriptions over-map to strong options ("supportive" ≠ automatically
  "Champion") — pick the defensible read or ask; leave empty rather than force a match.

## Evals
- `.claude/evals/capturing-a-contact/happy-path.md`
- `.claude/evals/capturing-a-contact/pressure-guess-role.md`
- `.claude/evals/capturing-a-contact/invariant-no-invented-option.md`
