---
name: resources
layer: context
system: resources
kind: component
mold: system-card
---

# System: resources

## Promise
The team's external **resources** — accounts, platforms, shared assets, registries —
are tracked in the live [DB] Resources: what the team uses, who administers it, and
how to get access, governed by the Resources policy standard (Notion). Decreed by
ADR-0028. Consumers: the team (access and administration answers); the publishing
bindings that write the records. Mirrors the LIVE [DB] Resources schema — fetch live,
never an assumed one (ADR-0016).

## Mechanisms
- **validating-resources** — reads: the Resources policy standard + the live [DB]
  Resources records + the cross-referenced records ([DB] Tooling, Finance records,
  the workspace roster) · produces: a bucketed drift report with declared coverage
  and gated fixes · runs-when: a user invokes `/validating-resources` · invariants:
  coverage omissions are declared, never silent; fixes land only through the gate;
  facts gathered or asked, never guessed; Last Verified never stamped by a
  records-only sweep. Earned by baseline: an unguided sweep silently omitted URL
  liveness and cross-checks (2026-07-14).
- Capture and single-record updates deliberately have NO guide (ADR-0028): unguided
  baselines fully complied twice (capture with password-bait; the Vercel update) —
  the policy standard + target registration are the teaching layer for writes.

## Components
- `.claude/skills/validating-resources/SKILL.md` — the validation sweep guide
  (staged). The Notion target `resources` (live schema + body shape) lives in the
  publishing binding's `targets.md`; the rules live in the Resources policy standard
  (Notion, one doc per subject per ADR-0021).

## Concepts
resource

## Invariants
- no credential value, token, password, or one-time code ever enters a record; standing
  invite links only by explicit admin decision — enforcer: (gate) + the Resources
  policy standard + the bindings' confirm
- records are shaped to the live [DB] Resources schema and the policy standard's body
  shape, never an assumed one — enforcer: (gate) + publishing's live schema fetch
- records reach Notion through the publishing bindings (the canonical rule; see the
  publishing card) — enforcer: (gate) + publishing
