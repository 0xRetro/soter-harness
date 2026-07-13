# ADR-0007: Classification frontmatter scope; `mold: singleton` allowed

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
"Every piece declares its classification" collides with two realities: eval cases
and ADRs already carry established headers their consumers read (skill/case; the
ADR status block), and one-of-a-kind components (the lexicon registry, the rubric)
would each need a mold with exactly one instance — structure nothing else reads.

## Decision
Classification frontmatter (`layer · system · kind · mold`) is required on durable
content pieces: molds, system cards, guides, rules, standards, the registry, the
rubric. Eval cases and ADRs keep their own headers. Unique-shape components declare
`mold: singleton`; the checker skips shape-matching for them but still validates
the other fields.

## Consequences
No fields without consumers; no one-instance molds. The two-path rule governs
growth: a third singleton wearing the same implicit shape earns a real mold.
Revisit if singletons multiply past a handful — that means shapes are hiding.
