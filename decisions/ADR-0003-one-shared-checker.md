# ADR-0003: One enforcement system, one shared checker, rules as data

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
olympus died of per-rule enforcement (95 hooks, ~2.6s per edit, 40% of commits on
its own machinery). Industry consensus is one engine with rules as data (ESLint,
Vale, OPA); per-rule scripts win only when wrapping foreign tools. Each soter
system still needs its invariants enforced somewhere.

## Decision
Enforcement is ONE system with ONE shared checker (`.claude/scripts/check.mjs`).
Other systems contribute check rules as data (the lexicon's aliases table, the
molds' shapes, the cards' listed paths) — never their own enforcement machinery.
Green carries evidence: an empty scan is an error; the selftest plants every
violation code and a default-root canary.

## Consequences
A new check = data plus at most one function in the shared script. The hook runs
warn-only and fail-open; CI is the hard gate. Revisit only if a check genuinely
cannot run inside one Node script.
