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
None of its own — both are delegated mechanisms (ADR-0045) running inside
enforcement's checker: the alias lint reads the registry's Aliases table as data;
the registry-coverage lint verifies every Registry term appears on its owning
card's Concepts line (the reverse of the cards' CARD_CONCEPT direction).

## Components
- `.claude/LEXICON.md` — the registry: classification rule, primitives, terms, aliases (singleton)

## Concepts
term · alias · concept · layer · system · mechanism · component · engine ·
delegated mechanism

## Invariants
- one entry per concept; no synonyms in harness content — enforcer: checker `ALIAS`
- an unparseable aliases table is an error, never a silent skip — enforcer: checker `ALIAS_TABLE_EMPTY`
- every load-bearing term used by a piece exists in the registry — `unenforced: review at the gate`
- every registry term appears on its owning system card's Concepts line — enforcer: checker `CONCEPT_UNCARDED`
