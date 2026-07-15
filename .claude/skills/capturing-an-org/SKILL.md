---
name: capturing-an-org
description: >-
  Captures an organization as a [DB] Orgs row — Type classified from prose (sector words
  go to Tags), handles normalized to URLs, de-duped hard (orgs are relation targets).
  Use to add, capture, or log an organization or company into the CRM. Not for people
  (/capturing-a-contact), write mechanics, or projects.
disable-model-invocation: true
layer: context
system: crm
kind: component
mold: how-to-guide
---

# Capturing an org

## Goal
An organization becomes a [DB] Orgs row shaped to the live schema — Type and Tags matched
to real options, handles normalized to URLs, de-duped hard (orgs are relation targets).

## Use when / don't use when
- Use when: adding an organization/company to the CRM (often as a prerequisite before
  `/capturing-a-contact` can link its Org).
- Not for: people (`/capturing-a-contact`); the Notion write mechanics
  (`/pushing-to-notion`); projects.

## Steps
Follow the **`writing-records-to-notion`** standard (`.claude/standards/writing-records-to-notion.md`) for the shared
spine — fetch schema · match options (never invent) · de-dup · confirm · publish. Target
`orgs`. Org-specific:
1. **Shape:** `Name` (title); `Website`/`Twitter` (url) — normalize a bare handle/domain
   to a full URL (`@nebulalabs` → `https://twitter.com/nebulalabs`; `nebulalabs.io` →
   `https://nebulalabs.io`).
2. **Type is a single forced-choice classification from prose.** FLEX: which live Type
   option the prose maps to, bounded by: a defensible read of a real option, else ask.
   Sector words ("DeFi", "L2", "grants") usually belong in `Tags`, NOT `Type` — don't
   fold a sector into Type, and don't silently drop it. ("DeFi foundation" → Type
   `Foundation` + consider a DeFi tag.)
3. **De-dup hard.** Orgs are relation targets — a duplicate silently splits the
   relationship graph. Search [DB] Orgs by name AND likely aliases ("Nebula Labs" /
   "Nebula" / "NebulaLabs") before creating.
4. **Contacts/Projects relations point outward** from the org — usually left empty at
   create and backfilled later; don't force them.

## Gotchas
Shared write-discipline gotchas live in the `writing-records-to-notion` standard;
org-specific ones only:
- (baseline) Don't fold a sector qualifier into `Type` — "Foundation" is the Type; "DeFi"
  is a Tag (or dropped only if no tag fits). Don't discard the sector signal.
- (baseline) `targets.md`'s Type/Tags lists are truncated samples — always fetch the LIVE
  option set, never trust the illustrative list.
- (baseline) Org dedup is high-stakes (relation target) — check name aliases, not just an
  exact match.

## Evals
- `.claude/evals/capturing-an-org/happy-path.md`
- `.claude/evals/capturing-an-org/pressure-guess-type.md`
- `.claude/evals/capturing-an-org/invariant-sector-not-type.md`
