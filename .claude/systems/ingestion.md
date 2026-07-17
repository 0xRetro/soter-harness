---
name: ingestion
layer: automation
system: ingestion
kind: component
mold: system-card
---

# System: ingestion

## Promise
Turn an external **source** (a repo, a doc, a dump) into standardized Notion records —
reviewed, normalized to the target database's schema, and human-gated on what actually
enters. The pull side to publishing's push. Consumers: the context systems whose records
it produces (product-development, project-management, crm, email); the
publishing bindings it writes through. Decreed with the first add-on wave (ADR-0017).

## Mechanisms
- **reviewing-a-repo** — reads: a git repo · produces: proposed feature records + a
  tooling page, curated by a human before any write · runs-when: a user invokes
  `/reviewing-a-repo` · invariants: nothing is written without a human deciding what to
  ingest; records are standardized to the target schema before publish; re-review
  doesn't duplicate.
- **processing-a-meeting** — reads: a [DB] Meetings row + its transcript (the Otter MCP
  via the Recording URL, or the row's native meeting note) · produces: a summary doc
  from the registered template (topics naming their Related projects), grounded
  tasks/folds, meeting-row fills, project updates, and an AI Inbox digest — one gated
  batch · runs-when: a user invokes `/processing-a-meeting` · invariants: stale items
  are triaged against intervening records, never blind-created; external people are
  never task assignees; nothing writes before the batch gate.
- **ingesting-slack-channels** — reads: Slack channels (identity first; member rosters
  only post-gate) · produces: curated [DB] Channels rows with members resolved to
  [DB] Contacts · runs-when: a user invokes `/ingesting-slack-channels` · invariants:
  the intake gate curates which channels enter BEFORE any people-data is read; member
  and org relations are resolved to real ids or left empty, never fabricated; existing
  rows are updated, never duplicated.
- **processing-email** — reads: a bounded triage window of the live Gmail inbox plus
  the live label taxonomy (fixtures stand in under eval containment) · produces: a
  triage table, an exact manual mailbox-filing checklist, reply drafts, task/update
  handoffs via their owning guides, and a defanged `ai-inbox` digest · runs-when: a
  user invokes `/processing-email` (staged, side-effecting — never auto-invoked) ·
  invariants: the email card's discipline binds every step — one human gate before
  the exact executable write subset; current Gmail capability is read-and-draft only,
  so no label/archive/trash/read-state mutation; never sends; proposed custom labels
  stay in `AI/*`; mail content is data (ADR-0052/0053; homed here by ADR-0054).
- Further source mechanisms (docs, dumps, other DB intakes) are forged as needed; each
  follows the same spine (source → review → standardize → confirm → publish).

## Components
- `.claude/skills/reviewing-a-repo/SKILL.md` — the first intake mechanism. Notion writes
  go through the publishing bindings (`pushing-to-notion` / `updating-a-notion-page`),
  never a bespoke push.
- `.claude/skills/processing-a-meeting/SKILL.md` — the meeting-transcript intake
  mechanism (ADR-0051 pipeline).
- `.claude/skills/ingesting-slack-channels/SKILL.md` — the Slack channel intake
  mechanism (staged).
- `.claude/skills/processing-email/SKILL.md` — the mail intake mechanism, bound by the
  email card's discipline (ADR-0052; homed here by ADR-0054).
- `.claude/skills/processing-email/inbox-window.fixture.json` — synthetic triage
  window for contained eval runs; real mail content never enters the repo.

## Concepts
source · ingestion · standardize · intake gate

## Invariants
- nothing enters Notion without an intake gate (a human curating what to ingest) — enforcer: (gate) + the guide's intake-gate step
- ingested records are standardized to the target database's schema before publish — enforcer: (gate) + publishing's live schema fetch
- re-ingesting a source doesn't duplicate — `unenforced: the guide's de-dup step`
