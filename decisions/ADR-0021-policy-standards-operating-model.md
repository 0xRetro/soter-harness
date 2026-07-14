# ADR-0021: Subjects are governed by policy standards; the operating model

- **Status:** Accepted
- **Date:** 2026-07-13

## Context
Working the first real process (Wallet Penny Test) exposed the modularity problem: a
process's work-items write records (addresses, orgs, runs), and without a boundary every
process re-explains every table's fields, or everything becomes a subprocess. The first
field-spec draft also proved that leading with data (a fields table) buries the real
content — the rules, classifications, and lifecycle of the thing being governed. And two
homes were possible for these specs: Notion (where operators work) or the harness.

## Decision
Work decomposes into exactly three artifact kinds: a **policy standard** (the write-spec +
rules for one subject), a **subprocess** (a reused executable sequence with its own
inventory entry, extracted on its second use), and an **inline work-item**. A data write is
never a process. One policy standard per subject; policies and processes **reference** a
subject's policy standard, never restate it — prerequisites resolve-or-create through the
subject's own owner; hand-offs are feeds-into connections. Policy standards are
**rules-first**: definition · scope · classifications with explicit overlap rules
(mutually-exclusive vs overlapping) · rules · lifecycle — representation (fields) last and
subordinate. They live **in Notion** with their subject's data ([DB] Policy Standards); the
live database stays the source of truth (ADR-0016), and the harness mirrors a subject
(target + capture guide) only when its writes are automated.

## Consequences
The Process Inventory stays small (few true subprocesses); field-level DRY lives in the
policy layer where one table change updates one doc. The legacy "[DB] X Standards" pages
are the ungoverned ancestor of a policy standard's representation section — schema-audit's
aim becomes keeping that section true to the live DB. A future addresses/treasury context
system is anticipated but not created until it has real pieces or a decree (ADR-0017).
Cost: every new subject needs its policy standard authored before processes can cleanly
reference it. Revisit trigger: if referencing (not restating) proves too indirect for
operators in practice, or policy conflicts emerge that the one-owner rule can't resolve.
