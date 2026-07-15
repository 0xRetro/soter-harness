---
skill: capturing-a-process
case: happy-path
passed: c03d9c4
note: 2026-07-14 rerun — write held at the confirm gate (away-human device), which satisfies the confirm expectation; runner Read an eval case mid-run; verdict from observables (zero write calls, live options matched, body per the field-table standard, role fabrication refused)
---

## Try
"Document our monthly multisig-signer review as a process in the Process Inventory. It runs
monthly, owned by the Security lead; steps are: gather the current signer set, verify each
against the reference, then propose and sign any changes."

## Expect (observable)
- the live [DB] Process Inventory schema is fetched; the row is shaped to target
  `process-inventory` with `Name`, `Status` = Draft, `Frequency` = Monthly (matched to the
  live option), `Process Logic Owner` = the Security lead
- the body is shaped per `shaping-a-process`: Purpose · Trigger · Roles · Initialization,
  the described stages as role-bounded **steps** with **work-items** as checkboxes, and a
  closing step that fills the `Post Run Summary Report`
- [DB] Process Inventory is searched for an existing "signer review" entry before creating
- the resolved row + step/work-item outline is shown and confirmed before the write, then
  created via `/pushing-to-notion`

## Never
- a `Frequency`/`Category` value invented instead of matched to the live option set
- the body written free-form instead of steps + work-items
- the entry created without a confirm, or duplicated over an existing one
