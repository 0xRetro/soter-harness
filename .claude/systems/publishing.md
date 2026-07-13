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

## Components
- `.claude/skills/pushing-to-notion/SKILL.md` — the notion-push binding (a guide)

## Concepts
publish · external store · binding

## Invariants
- external writes require explicit human confirmation — enforcer: the skill's confirm step + (gate)
- automation guides never auto-fire — enforcer: checker `AUTOMATION_AUTOFIRE`
- no real credentials in any harness content — enforcer: checker `SECRET_LEAK`
- every pushed property is typed to the target schema — `unenforced: runtime + gate` (no static schema check yet)
