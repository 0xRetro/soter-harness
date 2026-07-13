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
  PostToolUse hook (warn only, fail-open), CI (block), `--selftest`
  (plant-and-assert) · invariants: ONE shared script, rules as data, never
  per-rule scripts; must catch every planted violation; hook mode never blocks.

## Components
- `.claude/scripts/check.mjs` — the one shared engine (logic, executed never read)

## Concepts
check rule · green carries evidence

## Invariants
- CI is the hard gate; the hook is advisory — enforcer: `.github/workflows/ci.yml`
- zero checkable artifacts = error — enforcer: checker `SCAN_EMPTY`
- the selftest plants every violation code and a default-root canary — enforcer: CI selftest step
