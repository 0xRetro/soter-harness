# ADR-0024: The sky context system — ecosystem vocabulary owned once

- **Status:** Accepted
- **Date:** 2026-07-14

## Context
Sky-ecosystem vocabulary recurs across the org's tables and the harness pieces that touch
them — process Tags and Categories (Spells, Atlas, MSC, NFAT, Star Lifecycle), org Types
(Prime Agent, Executor Agent, Halo Agent), contact Roles (Sky SME, Atlas Editor), task
selects (Prime Agent: Spark · Skybase · Grove · Keel), and Atlas citations in policy docs.
Each surface currently re-explains its slice; the same term drifts between them, and
ecosystem words have no legitimate layer home (they are org-context, so they leak into
generic pieces by accident — one such leak was caught by audit). No existing system owns
this concern.

## Decision
Decree the **sky** context system: the harness owner of Sky-ecosystem domain vocabulary
and, as they emerge, sky-specific mechanisms and components. Its concepts are registered
in the LEXICON (owned by `sky`); harness pieces and policy docs reference these terms
rather than re-defining them. No Notion policy doc for the ecosystem itself — the
vocabulary is harness context, not an operational record type.

## Consequences
The card and LEXICON rows land with this decree; the system starts with zero mechanisms
by design and grows as sky-specific automation is forged. Ecosystem definitions in
operator-facing Notion docs (e.g. the Processes policy's tag definitions) remain as
copies-with-a-home — the LEXICON row is the harness-side authority and the two must
agree. Layer discipline gains a named home: sky vocabulary belongs at context, never in
kernel/core pieces. Revisit trigger: a decreed system left at zero real mechanisms for a
long stretch gets a retire-or-re-earn review (ADR-0017); vocabulary-only ownership counts
as real use here only while other pieces actively reference it.
