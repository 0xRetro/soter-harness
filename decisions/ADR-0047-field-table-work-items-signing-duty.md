# ADR-0047: Field-table work-items; validation is a signing duty

- **Status:** Proposed
- **Date:** 2026-07-14

## Context

Record-writes, evidence captures, judgments, and comms all formatted identically in
process bodies; the validation evidence field set lived only in a policy Fields
section no operator ever saw; checkbox semantics were undeclared; and capability
keying forced a "who verifies?" question the propose/execute split answered wrongly.
Checklist research (READ-DO vs DO-CONFIRM) and the form-first shape of the legacy
Integration Boost doc and ProcessOS pointed the same way. The format was co-designed
with the human on a live Examples page against real penny-test content.

## Decision

A work-item is a short bold sentence plus a capability-keyed prose line. Record-writes,
evidence captures, and Initialization carry their fields as a fit-page-width table —
**☐ · Field · Type · Required · Instruction · Why** — field names plain; instructions
plain full sentences; Why carries the operator-facing reason and all exactness dicta;
value conventions in italics; predetermined literals backticked; a value list closes
with a bare @-policy locator ("add/change enum options" — the one scoped exception to
ADR-0038's no-pointer rule). The doc is a READ-DO script: ☐ is a glyph; ticking happens
on the run or its form. Capabilities re-keyed to match: **Signer** validates every
signature personally, **Proposer** builds and queues, **Executor** broadcasts,
**Attestor** judges evidence and closes the run — externals hold capabilities too, so
every responsibility is keyed.

## Consequences

- Checklist, policy field set, and data entry share one field vocabulary; both
  registered templates carry the mold table (copy it, never rebuild it).
- Costs: tables are heavier to edit via API than prose; the @-locator must stay a bare
  mention or the pointer-regrowth that ADR-0038 killed returns.
- The capability set (Ops · Comms · Signer · Proposer · Executor · Attestor) is
  frozen — a new value is a policy event, not a process nitpick.
- Revisit if ProcessOS becomes the run surface (the table may then live there, with
  the doc slimming back toward SOP altitude), or if table maintenance costs exceed
  their data-entry clarity in practice.
