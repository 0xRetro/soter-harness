---
name: ingesting-slack-channels
description: >-
  Turns Slack channels into [DB] Channels rows — the human curates which channels
  enter at an intake gate, members resolve to real [DB] Contacts records, existing
  rows update not duplicate. Use to ingest, sweep, or sync Slack channels into the
  CRM. Not for message content or digests, non-Slack channel records (the publishing
  bindings directly), capturing people (/capturing-a-contact), or the write mechanics
  (/pushing-to-notion, /updating-a-notion-page).
disable-model-invocation: true
layer: automation
system: ingestion
kind: component
mold: how-to-guide
---

# Ingesting Slack channels

## Goal
Slack channels become [DB] Channels rows the human chose to track — channel identity
gathered first, people-data read only for channels that passed the intake gate,
member links resolved to real records or left empty, existing rows updated not
duplicated.

## Use when / don't use when
- Use when: ingesting one or many Slack channels into [DB] Channels (a workspace
  sweep, or a named channel with its membership).
- Not for: Slack message content, digests, or transcripts (not an ingestion target);
  a non-Slack channel record (a Telegram group, a mailing list — capture it through
  the publishing bindings until a dedicated guide exists); capturing the unmatched
  people it surfaces (`/capturing-a-contact`, one person each, human-requested);
  the Notion write mechanics (`/pushing-to-notion`, `/updating-a-notion-page`).

## Steps
1. **Sweep channel identity only — no people-data.** List channels public AND
   private (the channel search returns public-only unless private is requested
   explicitly), following every pagination cursor. Record per channel: name, id,
   host workspace (a Slack Connect channel lives on the partner org's host),
   public/private, permalink. Do NOT read members, profiles, or messages yet —
   the member roster is the personal-data-bearing read, and it happens only for
   channels the human approves at step 3.
2. **De-dup against the live board.** Fetch the live `channels` target (schema and
   rows — the publishing binding's `targets.md` names the data source). Mark every
   swept channel NEW or EXISTING. An existing row is an update
   (`/updating-a-notion-page`, fetch-merge-write), never a duplicate.
3. **Intake gate — the human curates the channel list.** Present name · host ·
   public/private · NEW/EXISTING and let the human choose WHICH channels enter the
   CRM and which stay out. Not every venue belongs in a shared directory —
   leadership, signer-ops, and social channels are the human's call, never yours.
   This gate curates *selection*; the bindings' confirm covers *write mechanics* —
   both happen, neither substitutes for the other. Nothing below this line runs
   before the okay. FLEX: when the human explicitly named the exact channel(s) to
   ingest, that naming IS the selection and this gate folds into the write confirm —
   never for a sweep, a name filter, or "all channels".
4. **Resolve members for approved channels only.** List members per approved
   channel; exclude bots. Match each person against [DB] Contacts: email-exact
   first, then name — FLEX: what counts as a defensible name match, bounded by: a
   recorded reason per match; ambiguous stays unlinked. Unmatched people are listed
   for the human as capture candidates — never auto-captured, and a `Members`
   relation is a resolved page id or absent, never fabricated.
5. **Assign Related Orgs.** The org hosting a Slack Connect channel, plus any org
   the channel name explicitly names — FLEX: the naming read, bounded by: defensible
   from name or host, resolved to a real [DB] Orgs id; a missing org is flagged,
   never silently created; never blanket-apply the team's own org to every row.
6. **Write through the bindings.** Creates via `/pushing-to-notion`, updates via
   `/updating-a-notion-page`, target `channels`, select values matched to the live
   option set. The batch confirm may compress to one okay, never disappear. A batch
   has no rollback — if row N fails, rows 1..N-1 stand; report exactly what landed.
7. **Verify and hand off the residue.** The live board's rows match the approved
   set (name the ids). Report the residue lists — unmatched people, missing orgs,
   duplicate contact records the matching surfaced — as follow-up work, not as
   writes of this run.

## Gotchas
- (baseline 2026-07-15) "Make the board complete and current" was read as
  ingest-everything: all 90 swept channels queued for creation — leadership,
  signer-ops, and social venues included — with the write confirm presented as the
  only stop. Counter: step 3's intake gate curates selection BEFORE anything else;
  the write confirm never substitutes for it.
- (baseline 2026-07-15) Member profiles were bulk-resolved before any human saw a
  channel list — 250 people's names and emails across ten external host workspaces,
  flagged by the platform's safety layer as mass personal-data collection. Counter:
  the step 1/4 ordering (identity first, members only post-gate); it also cut the
  sweep's cost by an order of magnitude (the unguided run spent ~400 tool calls).
- (baseline 2026-07-15) The write discipline itself held (live schema fetched,
  de-dup ran, unmatched members left empty, zero write attempts) — the observed
  failure is scope and ordering, not mechanics. Don't grow this guide toward
  re-teaching `writing-records-to-notion`; point at it.
- (probe 2026-07-15) A channel search that doesn't explicitly request private
  channels silently returns public-only — a "complete" sweep of a Connect-heavy
  workspace misses most of it.

## Evals
- `.claude/evals/ingesting-slack-channels/happy-path.md`
- `.claude/evals/ingesting-slack-channels/pressure-full-board-sweep.md`
- `.claude/evals/ingesting-slack-channels/invariant-no-fabricated-members.md`
