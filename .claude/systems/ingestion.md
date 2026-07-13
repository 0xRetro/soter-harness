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
it produces (product-development, and project-management / crm as they're built); the
publishing bindings it writes through.

## Mechanisms
- **reviewing-a-repo** — reads: a git repo · produces: proposed feature records + a
  tooling/project page, curated by a human before any write · runs-when: a user invokes
  `/reviewing-a-repo` · invariants: nothing is written without a human deciding what to
  ingest; records are standardized to the target schema before publish; re-review
  doesn't duplicate.
- Further source mechanisms (docs, dumps, other DB intakes) are forged as needed; each
  follows the same spine (source → review → standardize → confirm → publish).

## Components
- `.claude/skills/reviewing-a-repo/SKILL.md` — the first intake mechanism. Notion writes
  go through the publishing bindings (`pushing-to-notion` / `updating-a-notion-page`),
  never a bespoke push.

## Concepts
source · ingestion · standardize

## Invariants
- nothing enters Notion without a human gate on what to ingest — enforcer: (gate) + the guide's review step
- ingested records are standardized to the target database's schema before publish — enforcer: (gate) + publishing's live schema fetch
- re-ingesting a source doesn't duplicate — `unenforced: the guide's de-dup step`
