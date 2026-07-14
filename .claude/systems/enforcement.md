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
  PostToolUse hook (warn only, fail-open), PreToolUse Bash guard (`--guard-bash`:
  root-on-main git, agent publishes, add -A, force pushes; fail-open on unparseable
  input), Stop turn gate (`--gate`: holds a turn open ONCE while checker errors
  stand; warnings never block; fail-open off-harness and on any internal error,
  ADR-0035), CI (block), `--selftest` (plant-and-assert) · invariants: ONE shared
  script, rules as data, never per-rule scripts; must catch every planted violation;
  the PostToolUse hook never blocks.

## Components
- `.claude/scripts/check.mjs` — the one shared engine (logic, executed never read)

## Concepts
check rule · green carries evidence

## Invariants
- CI is the merge gate; the lint hook is advisory; the turn gate blocks at most once
  per turn (`stop_hook_active`) — enforcer: `.github/workflows/ci.yml` + checker `--gate`
- zero checkable artifacts = error — enforcer: checker `SCAN_EMPTY`
- the selftest plants every violation code and a default-root canary — enforcer: CI selftest step
