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
it produces (product-development, project-management, crm); the
publishing bindings it writes through. Decreed with the first add-on wave (ADR-0017).

## Mechanisms
- **reviewing-a-repo** — reads: a git repo · produces: proposed feature records + a
  tooling page, curated by a human before any write · runs-when: a user invokes
  `/reviewing-a-repo` · invariants: nothing is written without a human deciding what to
  ingest; records are standardized to the target schema before publish; re-review
  doesn't duplicate.
- **ingesting-slack-channels** — reads: Slack channels (identity first; member rosters
  only post-gate) · produces: curated [DB] Channels rows with members resolved to
  [DB] Contacts · runs-when: a user invokes `/ingesting-slack-channels` · invariants:
  the intake gate curates which channels enter BEFORE any people-data is read; member
  and org relations are resolved to real ids or left empty, never fabricated; existing
  rows are updated, never duplicated.
- Further source mechanisms (docs, dumps, other DB intakes) are forged as needed; each
  follows the same spine (source → review → standardize → confirm → publish).

## Components
- `.claude/skills/reviewing-a-repo/SKILL.md` — the first intake mechanism. Notion writes
  go through the publishing bindings (`pushing-to-notion` / `updating-a-notion-page`),
  never a bespoke push.
- `.claude/skills/ingesting-slack-channels/SKILL.md` — the Slack channel intake
  mechanism (staged).

## Concepts
source · ingestion · standardize · intake gate

## Invariants
- nothing enters Notion without an intake gate (a human curating what to ingest) — enforcer: (gate) + the guide's intake-gate step
- ingested records are standardized to the target database's schema before publish — enforcer: (gate) + publishing's live schema fetch
- re-ingesting a source doesn't duplicate — `unenforced: the guide's de-dup step`
