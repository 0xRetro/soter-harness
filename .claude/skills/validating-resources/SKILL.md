---
name: validating-resources
description: >-
  Sweeps every [DB] Resources record against the Resources policy standard and reality
  (admins, URL liveness, cross-record claims) into a drift report; fixes applied only on
  a human okay. Use to validate, audit, or sweep the resources records. Not for schema-
  doc drift (/auditing-a-schema-doc), single-record edits, or capture.
disable-model-invocation: true
layer: context
system: resources
kind: component
mold: how-to-guide
---

# Validating resources

## Goal
Every [DB] Resources record checked against the policy standard AND against reality,
with a bucketed drift report whose coverage is explicit — anything not checked is
declared, fixes are prepared but land only through the gate, and no fact is guessed.

## Use when / don't use when
- Use when: validating, auditing, or sweeping the resources records for drift.
- Not for: auditing a policy standard's Fields section against the live schema
  (`/auditing-a-schema-doc`); making a known single-record change
  (`/updating-a-notion-page`); capturing a new resource (the policy standard + target
  registration teach that unguided — ADR-0028).

## Steps
1. **Authority first.** Fetch the Resources policy standard from the policy-standards
   registry (never the legacy "[DB] Accounts & Resources Standards" page — superseded)
   and the live [DB] Resources schema. Three-way check: live schema vs the policy's
   Fields vs the harness target mirror. A mismatch is a report line, never a silent
   adaptation.
2. **Full sweep, coverage declared.** Query ALL records. Per record, against the
   policy: D1 naming · Type/Access values in the live option sets · required fields
   present (Admin) · no-secrets (scan the WHOLE body — credential-looking content,
   and invite links that are expired or missing their admin-decision annotation) ·
   body shape per the registered template (as-applicable sections may be absent;
   hand-written extra content is kept, but pre-template freeform blocks that
   duplicate templated sections are drift). Anything skipped or sampled is listed as
   skipped — a silent cap reads as "covered everything" (baseline failure).
3. **Reality checks — the part memory omits.** Admin ids resolve to real workspace
   users (documented-external is fine when the body says so) · URL liveness (fetch
   each URL; dead or redirected is a finding) · cross-record claims hold BOTH ways
   (billing links point at real Finance records; Configuration's deployed/used-by
   claims vs [DB] Tooling prod URLs, and Tooling's platform URLs vs the resource's
   Configuration). FLEX: liveness for auth-walled URLs may be limited to
   reachability — say so in the report.
4. **Report drift, bucketed.** Schema-vs-policy · record-vs-policy ·
   record-vs-reality · adjacent (another system's territory — flag it, never fix
   it). Every finding carries its evidence and either a prepared exact fix or the
   named fact only a human can supply.
5. **Fixes land only through the gate.** Prepare exact edits per the shared write
   discipline (`.claude/standards/writing-records-to-notion.md` — fresh-fetch,
   merge, verify: the standard is the source, not this paraphrase); apply only on
   an explicit human okay, per finding or an explicitly-scoped batch. Facts are
   never guessed (gathered-or-empty).
   `Last Verified` is stamped only on records a human confirms verified — a
   records-vs-records sweep alone never stamps it.
6. **Verify + close.** Applied fixes re-fetched against a snapshot newer than the
   write, every op confirmed; the report closes with the `not defined` worklist delta
   (cleared vs added).

## Gotchas
- (baseline 2026-07-14) An unguided sweep was otherwise strong but silently OMITTED
  URL-liveness and the config↔Tooling cross-checks — no note that they weren't run.
  Steps 2–3's declared-coverage rule is the counter.
- (baseline 2026-07-14) Under "fix anything that's safe to fix" the unguided agent
  correctly held every write and refused to fabricate missing facts — hold that line;
  step 5 makes it explicit.
- (live 2026-07-14, Slack) A pre-template freeform block sat ABOVE the templated
  sections carrying an EXPIRED invite link and duplicated billing info — earlier
  tooling had appended sections without fetching first. Sweep whole bodies; an
  expired or un-annotated invite is a no-secrets finding even where a standing one
  is allowed (the admin-decision annotation is the difference).
- (live 2026-07-14, Octane) An Admin id that resolves to no workspace member can be
  intentional (external contact) — the body note is what makes it conformant;
  unresolvable AND unexplained is the finding.

## Evals
- `.claude/evals/validating-resources/happy-path.md`
- `.claude/evals/validating-resources/pressure-fix-everything.md`
- `.claude/evals/validating-resources/invariant-declared-coverage.md`
