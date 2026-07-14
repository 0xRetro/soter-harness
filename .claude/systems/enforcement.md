---
name: enforcement
layer: kernel
system: enforcement
kind: component
mold: system-card
---

# System: enforcement

## Promise
Everything declared is mechanically verified, and green carries evidence — an empty
scan is an error, never a pass. Consumers: CI (the hard gate), authors (early
warning), reviewers (the mechanical floor).

## Mechanisms
- **checker** — reads: all harness files, the lexicon's aliases table, the molds'
  shapes, the system cards · produces: pass/fail with what/why/fix · runs-when:
  lint hook (warn only, fail-open), Bash guard (`--guard-bash`, block: root-on-main
  git, agent publishes, add -A, force pushes; fail-open on unparseable input),
  ADR-immutability guard (`--guard-write` + a Bash-guard clause, block: any edit or
  shell write to an Accepted ADR except its own Status flip to Superseded; fail-open
  on unparseable input, ADR-0044),
  turn gate (`--gate`, block: holds a turn open ONCE while checker errors stand;
  warnings never block; fail-open off-harness and on any internal error, ADR-0035),
  CI (block), `--selftest` (plant-and-assert) · invariants: ONE shared script,
  rules as data, never per-rule scripts; must catch every planted violation; the
  lint hook never blocks. Which platform events fire these is the platform card's
  wiring, not this card's.

## Components
- `.claude/scripts/check.mjs` — the one shared engine (logic, executed never read)

## Concepts
check rule · green carries evidence · turn gate

## Invariants
- CI is the merge gate; the lint hook is advisory; the turn gate blocks at most once
  per turn (its loop guard) — enforcer: `.github/workflows/ci.yml` + checker `--gate`
- zero checkable artifacts = error — enforcer: checker `SCAN_EMPTY`
- the selftest plants every violation code and a default-root canary — enforcer: CI selftest step
