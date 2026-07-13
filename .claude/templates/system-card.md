---
name: system-card
layer: kernel
system: template
kind: component
mold: mold
---

# Mold: system card

<!-- Copy to define a new system. One card per system — the single place a system's
     promise, parts, and invariants are declared. Fill every section, delete hints. -->

## Makes
A system card in `.claude/systems/<name>.md` — the one definition of one system.

## Frontmatter
Per the mold-for-molds. Note: a system card is owned by the system it describes
(`system: lexicon` on the lexicon card) — each system owns its own definition.

## Shape
- `## Promise` — one sentence: what this system guarantees, and to which consumer.
- `## Mechanisms` — the things that run, each as a card row: name · reads · produces · runs-when · invariants.
- `## Components` — the artifacts this system owns, with their paths.
- `## Concepts` — the terms this system contributes to the lexicon registry.
- `## Invariants` — what must always hold; each names its enforcer (a check rule, the gate, or `unenforced: <reason>`).

## Check rules
- frontmatter valid; system == card name — checker `FM_CLASS` + `CARD_OWNER`
- body has the five sections, in order — checker `SECTIONS_MISSING` + `SECTION_ORDER`
- every listed component path exists — checker `CARD_PATH`
- every listed concept has a LEXICON entry — checker `CARD_CONCEPT`
