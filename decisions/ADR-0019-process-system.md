# ADR-0019: The process system — Process → Step → Work-item, defined not engineered

- **Status:** Accepted
- **Date:** 2026-07-13

## Context
The org documents repeatable work in a live Notion `[DB] Process Inventory` and is
converging three sources onto one definition of a "process": the `process-platform` app
(Template → Step → Field; "Process" = a run), the Merlin prose docs (Process → Step(gate) →
Task), and the live Notion bodies (Process → Phase → numbered Task, "Process Run" = a run).
Nothing in the harness yet names this vocabulary, so captures drift. A new system needs a
decree before its mass of pieces (ADR-0017). The predecessor `olympus` already modeled this
domain correctly but as a Postgres DAG/FSM engine and drowned in per-rule machinery
(ADR-0003) — the cautionary bound on how far this system may go.

## Decision
Decree the **process** system (`layer: context`). Canonical hierarchy: a **process** is a
reusable definition (one `[DB] Process Inventory` entry + shaped body), made of **steps** (a
step is a gated stage — a state that must be true before entering), each holding
**work-items** (the checkboxes / things to get done in a step). A **process run** is one
execution; a run's work-items are *tracked as* `[DB] Tasks` rows — the documented seam to
project-management. "Work-item" is deliberately its own term, never "task," so the process
vocabulary and the `[DB] Tasks` vocabulary never collide; "Phase" is dropped (aliased to
step). The system is **definitional/documentary only** — a shape standard, capture guides, a
Notion target, and a documented seam — and is **never** a runtime/state engine; prose and
molds over machinery (ADR-0003).

## Consequences
The `process` system card, its LEXICON concepts (process · step · work-item · process run),
and its first mechanism (`capturing-a-process`) land together; it grows by forging further
mechanisms (maintaining a process, spawning a run's tasks) into the declared spine. The
`task` LEXICON row is reworded to drop the loose phrase "work item" so the two concepts stay
distinct, and `phase → step` joins the aliases table. The run→`[DB] Tasks` seam is documented,
not built here, and this system never alters the `[DB] Tasks`/`[DB] Projects` schemas (those
are project-management's). Revisit trigger: if a real need for run-state execution emerges
that genuinely requires machinery, that is a separate decision recorded on its own — the
default stays definitional, and a decreed system left at one unused piece gets a
retire-or-re-earn review (ADR-0017).
