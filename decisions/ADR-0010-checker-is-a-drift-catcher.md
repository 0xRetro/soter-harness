# ADR-0010: The checker is a cooperative drift-catcher, not a security boundary

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
A red-team probe showed the checker can be defeated by an adversarial editor:
modifying `check.mjs` itself to suppress findings, planting content in unwalked
directories, shipping non-markdown payloads, or editing an Accepted ADR — all stay
green. This looks alarming until measured against the actual threat model: every
harness change lands only through a human gate (ADR-0005), and git history is the
record of record.

## Decision
The checker's job is to catch **honest drift by cooperative authors** — mistakes,
staleness, forgotten steps — not to defend against a malicious editor. Integrity
against tampering is the human gate's job (a reviewer reading the diff) and git's, not
the checker's. We will not add checker self-hashing, all-directory walking, or content
signing; that is the machinery-maintenance treadmill this harness exists to avoid.

## Consequences
Card invariants that say "immutable" or "only a human merges" name the gate/git as
their enforcer, honestly, not a checker code. The checker's promise is scoped
accordingly in its own header. Revisit only if the harness is ever distributed to
untrusted editors without a human gate — then the threat model changes and this ADR
is superseded.
