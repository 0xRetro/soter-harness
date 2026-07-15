# ADR-0054: The email intake mechanism is homed in ingestion

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

A harness health audit (2026-07-15, three-track research sweep) flagged the one
classification asymmetry in the tree: `processing-email` — structurally identical to
the other source intakes (`reviewing-a-repo`, `processing-a-meeting`,
`ingesting-slack-channels`, all ingestion mechanisms) — was the sole guide homed
under a context-layer system (email, ADR-0052), leaving an automation-layer piece on
a context card and same-shaped work with two different homes. ADR-0052's decree said
every future email automation classifies under email.

## Decision

`processing-email` declares `system: ingestion`: source intakes live together,
whatever the source. This revises ADR-0052's classification clause only — the email
system stands as decreed, owning the mailbox as a live source, its LEXICON concepts,
and the discipline (read/label/draft never send, `AI/*` namespace, mail as data,
one gated batch) that binds every piece touching mail, wherever that piece is homed.

## Consequences

Email joins docs and onchain as a mechanism-less context system: card-only, its
substrate external, its rules binding by reference. Ingestion gains its fourth
intake; the intake spine (source → review → standardize → confirm → publish) now
covers mail. Cost: a piece's discipline and its home are now explicitly separate
facts — the ingestion card must keep naming the email card's discipline as binding,
which both cards now do. Revisit when: an email mechanism appears that is NOT an
intake (a drafted-reply queue, a scheduled digest) — that piece would test whether
this split still carves the space correctly.
