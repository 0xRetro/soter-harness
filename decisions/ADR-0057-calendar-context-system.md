# ADR-0057: The calendar context system — the commitments registry, never a mirror

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

Standing commitments had no home: Google Calendar buries them inside recurring
events (three shared calendars — Sky Ecosystem, Ozone Internal Ops, Payments — plus
personal ones, surveyed live 2026-07-15), [DB] Meetings holds only per-instance
records, and the weekly pre-creation run reads no governed source. The user decreed
a registry; [DB] Calendar existed as a Name+Date stub. The design question was
mirror-vs-registry: copying Google events into Notion is a standing drift machine,
while a registry that owns MEANING (purpose, attendance, org/project/process links)
and defers TIME to Google has one authority per concern.

## Decision

Decree the **calendar** context system owning [DB] Calendar as the standing-
commitments registry: each row one commitment — **Series** (evergreen recurring
meeting), **Event** (date-specific), or **Window** (recurring non-meeting
obligation) — with Google Calendar authoritative for time and recurrence, the
registry authoritative for meaning and links, joined by the **Google Event ID**.
Born WITH its pieces (unlike docs' ahead-of-pieces decree): the 12-field schema,
the [Calendar Entry Template] row, the Calendar policy standard v0.1, the
`calendar` target registration, and two worked examples (ProSec Bi-Weekly from
live Google data; the SFF GovOps weekly).

## Consequences

The keep-in-check mechanisms become forgeable against a governed substrate:
registry↔Google reconciliation lands as an AUDIT in the schema-audit mold (fetch
both, diff by join key, gate the fixes — never a live two-way sync engine), and
the meetings pre-creation run can evolve to read Series rows instead of a
hardcoded list. Roles-in-meeting is deferred by user decision — the [DB] Roles
structural-binding pattern (ADR-0043) is the ready answer when it comes. Revisit
triggers: a real need for [DB] Meetings to relate directly to commitments (a
schema decision through the Meetings policy's Change Control), or pressure to
build push-sync (supersede this ADR before building any such engine).
