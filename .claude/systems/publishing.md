---
name: publishing
layer: automation
system: publishing
kind: component
mold: system-card
---

# System: publishing

## Promise
Harness work-artifacts reach external systems of record deliberately, in a typed and
verifiable way. Consumers: humans and tools that read the external store; the
automation layer that wires harness output to where work is tracked. (Named for the
concern — pushing artifacts out — not for a vendor; Notion is the first binding, not
the system.)

## Mechanisms
- **notion-push** — reads: a structured artifact + a target Notion database id + a
  property-type map · produces: a created Notion page (id + url) · runs-when: a user
  invokes `/pushing-to-notion` (never auto — it writes to an external service) ·
  invariants: every property is typed per Notion's API; a human confirms before any
  write; never silently overwrites an existing page. (Pattern mirrors
  `~/dev/process-platform`'s `notion_create_database_item` step.)
- **notion-update** — reads: an existing page id + the fields to change · produces: the
  page updated in place · runs-when: a user invokes `/updating-a-notion-page` (never
  auto) · invariants: fetch-merge-write (never blind-write — Notion replaces a whole
  property value); only the named properties sent; a human confirms before the write.

## Components
- `.claude/skills/pushing-to-notion/SKILL.md` — the notion-push (create) binding
- `.claude/skills/updating-a-notion-page/SKILL.md` — the notion-update binding
- `.claude/skills/pushing-to-notion/targets.md` — the target registry (live-verified
  database ids + schemas) both bindings and every domain guide resolve against
- `.claude/standards/writing-records-to-notion.md` — the shared write-discipline every
  domain guide references (fetch schema · resolve · match options · dedup · confirm)

## Concepts
publish · external store · binding · fetch-merge-write · relation · option set · resolve · page

## Invariants
- external writes require explicit human confirmation — enforcer: the skill's confirm step + (gate)
- automation guides never auto-fire — enforcer: checker `AUTOMATION_AUTOFIRE`
- no real credentials in any harness content — enforcer: checker `SECRET_LEAK`
- every context record is written through a binding, never a bespoke push (the canonical
  rule the domain cards reference) — enforcer: (gate) + review
- every pushed property is typed to the target schema — `unenforced: runtime + gate` (no static schema check yet)
