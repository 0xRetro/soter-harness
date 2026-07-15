---
name: docs
layer: context
system: docs
kind: component
mold: system-card
---

# System: docs

## Promise
The team's shared **documents and links** have one governed home — the live [DB]
Docs: what a doc is (type), who it is for (audience), and what it relates to (the
Projects, Tasks, Orgs, and Opportunities rows that reference it), governed by the
Docs policy standard (Notion). Boundary: resources answers what the team USES
(access, administration); docs answers what the team KNOWS or SHARES (content,
audience). Decreed by ADR-0048, ahead of its pieces. Consumers: the team (find the
doc, know its audience); the context systems whose records relate to docs; the
publishing bindings that write the records. Mirrors the LIVE [DB] Docs schema —
fetch live, never an assumed one (ADR-0016). A second tier: **private-workspace
docs** — docs in restricted collections — follow their collection's own template
pages, are served by the harness in place, and never enter [DB] Docs (ADR-0049).

## Mechanisms
- None of its own — decreed ahead of pieces (ADR-0048). The Docs policy standard
  (Notion) and the `docs` target registration are live; a capture guide is forged
  ONLY if its baseline fails (resources' precedent, ADR-0028: the policy standard +
  registered target may be the whole teaching layer). Doc capture evaluated
  2026-07-15: baseline GREEN — a fresh contained agent captured an external
  reference (a live dashboard URL) correctly from the policy + target + write spine
  alone (live schema fetched, de-dup on Link+Name, Type per D2 with Link set, Org
  resolved to a real page id, required-but-human fields flagged never guessed, D3
  audience implication surfaced, write held at the confirm gate with the user
  away), so no capturing-a-doc guide was authored (forge step 4). Re-propose only
  on an observed doc-capture failure. Authoring docs from a policy-defined type
  shape is forged when a real need shows up; writes go through the publishing
  bindings.

## Components
- None of its own. The Notion target `docs` (live schema mirror) lives in the
  publishing binding's `targets.md`; the rules live in the Docs policy standard
  (Notion, one doc per subject per ADR-0021).

## Concepts
doc · private-workspace doc

## Invariants
- docs records are shaped to the live [DB] Docs schema, never an assumed one — enforcer: (gate) + publishing's live schema fetch
- relations to other records are resolved to real page ids or left empty, never fabricated — enforcer: (gate) + the bindings' resolve step
- records reach Notion through the publishing bindings (the canonical rule; see the publishing card) — enforcer: (gate) + publishing
- private-collection content, agendas, and page ids never enter harness pieces, evals, gotchas, org databases, or memory — the harness learns the pattern, never the instance (ADR-0049) — enforcer: (gate) + review
