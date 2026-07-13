---
name: lexicon
layer: kernel
system: lexicon
kind: component
mold: system-card
---

# System: lexicon

## Promise
Every term is defined once and referenced everywhere; classification is mechanical.
Consumers: every author (human or agent), the enforcement checker.

## Mechanisms
None — this system is data only. Its rules run inside the enforcement checker
(alias lint reads the registry's Aliases table as data).

## Components
- `.claude/LEXICON.md` — the registry: classification rule, primitives, terms, aliases (singleton)

## Concepts
term · alias · concept · layer · system · mechanism · component

## Invariants
- one entry per concept; no synonyms in harness content — enforcer: checker `ALIAS`
- an unparseable aliases table is an error, never a silent skip — enforcer: checker `ALIAS_TABLE_EMPTY`
- every load-bearing term used by a piece exists in the registry — `unenforced: review at the gate`
