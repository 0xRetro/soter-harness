# ADR-0009: Non-markdown logic is classified on its owning system's card

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
The LEXICON defined a component as "a file with classification frontmatter," but the
checker (`.claude/scripts/check.mjs`) is a component that carries no frontmatter and
can't — it's executable logic, never read as content. A stranger onboarding and the
red team both flagged the contradiction. The kind test ("runs on a trigger →
mechanism; read or executed → component") also reads ambiguously for a script the
checker mechanism is realized by.

## Decision
A component is a markdown file with classification frontmatter, OR non-markdown logic
(a script) that carries no frontmatter and is classified on its owning system's card
instead. The script is the component; the behavior it realizes (e.g. the checker) is
the mechanism, declared as a card row. Scripts are verified via the selftest, not
frontmatter shape.

## Consequences
`check.mjs` is legitimately the enforcement system's component without needing
frontmatter it can't hold. The placement table in the LEXICON records this. Revisit
if a script ever needs its own machine-readable classification.
