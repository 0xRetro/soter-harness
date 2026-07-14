---
name: shaping-a-process
layer: context
system: process
kind: component
mold: standard
---

# Shaping a process

## The model
A process definition is one [DB] Process Inventory entry: its metadata lives in the **row**,
its runbook in the **body**. Keep the body lean — the essentials needed to run it — and add
heavier sections only when a real process forces them (ADR-0019; minimum viable, grows).

**Row** — set the known row properties, each matched to a live option; the property
registry lives with the `process-inventory` target, not here.

**Body — the lean core (always):**
- **Purpose** — what the process produces or verifies, and why (1–3 lines).
- **Trigger** — a 1–3 line prose intro (how the need arrives in practice, including any
  method-selection context), then one tagged line per trigger: `<kind>` — <condition>.
  Kinds: `Request` (someone asks) · `Event` (observed state demands a run) · `Schedule` ·
  `Emergency` — the kind is backticked, no colon after it, and honest about who/what
  initiates. Each tagged line is an OBJECTIVE condition checkable true/false; assumptions,
  advice, and process notes never live here (a real precondition goes to Prerequisites).
- **Steps** — role-bounded: `### Step N — (Role) <objective>`. One role owns a step, so
  each step transition is a role handoff — that handoff IS the gate; no separate gate
  lines. Each step opens with a 1–3 line narrative intro: how the work actually arrives
  and what the step accomplishes — plain, concrete, never flowery, never restating the
  Trigger. Work-items are `- [ ]` checkboxes: a bolded action headline; the how (and the
  why, where it isn't obvious) goes in prose on its own indented line under the headline —
  never run-on after the bold; no citation tags. Then nested elements as required: field
  sub-checkboxes under a record-write parent (field-per-checkbox — never several fields
  bundled into one box), bulleted value lists (never inlined), determination arrows, and
  `⤷ condition → En` branch pointers. Work-items carry NO example values — an `e.g.`
  literal reads as THE input at run time; worked examples live in the subject's policy
  standard or on real records. Plain operator language only — write "add it if it is not
  on file", never harness jargon like resolve-or-create.
  A **write work-item** mention-links its target database and carries the operator-facing
  how INLINE — imperatives, the current value list, determinations — so a run needs only
  the process doc (ADR-0023). An expanding set (naming convention, function list) is
  copied as the CURRENT rule plus one pointer line naming the subject's policy standard
  as where the set is managed; the law (rules, rationale, extension criteria) is never
  copied (ADR-0021). Prerequisites resolve-or-create through the subject's own owner.

- **Initialization** — its own section between Roles and Steps (NOT a step: it captures
  run metadata, not domain work), owned by whichever role receives the trigger: create
  the run entry in [DB] Process Runs (Name · Process · Started · State as field
  sub-checkboxes), assign the roles (`Roles` — one line per role from the Roles table,
  each an @-mention of the person's [DB] Contacts record; external counterparties are
  roles too), and capture the inputs (`Inputs` — one line per input; the Initialization
  capture list IS the process's input declaration; @-mention the input's record where
  one exists, raw value otherwise — upgraded to the mention once registered). The FINAL
  step closes the run (Completed · State · Outcome · the Post Run Summary Report field).
  Working detail accrues in the run's page body per the [Run Template] (Run · Inputs ·
  Outputs & Proof) — proof lands there as the run progresses; the Post Run Summary
  Report field carries one line per field the process's Post Run Summary Report section
  declares. Identifiers are never truncated — full value, linked to the canonical
  source (explorer, record) where one exists. When the process verifies a subject
  record, that record links the run.

**Recommended (light):**
- **Cadence** — one line, mirrors the `Frequency` property.
- **Roles** — Role · Who · Responsibility; the step headings bind to these roles, so the
  table exists whenever steps do.
- **Exception Handling** — labeled exceptions (**E1, E2, …**), each failure → workaround,
  defined once here; a work-item that can trigger one carries an inline `⤷ condition → En`
  pointer instead of restating the handling.
- **Post Run Summary Report** — the doc section DECLARES the run field's line items (as
  Initialization declares inputs): the structured facts this process's close-out must
  record, one line per field, filled at close. Working detail lives in the run body,
  not here. A run's work-items are tracked as [DB] Tasks (the run→tasks seam).

**Add later, as the process firms up (not needed for a first version):** Prerequisites ·
Resources · Inputs & Outputs · Sub-process rules · Connections · Improvement opportunities ·
Notes · Change Log.

Vocabulary: **steps** (never `phases`), **work-items** (never `tasks` — a [DB] Tasks task is
a run's tracked copy of a work-item). Fetch the live default template body before shaping —
don't invent the section set (ADR-0016).

## Use when / don't
- Applies when: shaping or reviewing the *body* of a [DB] Process Inventory entry.
- Doesn't apply when: the Notion *write mechanics* (`writing-records-to-notion` +
  `/pushing-to-notion`); the entry's row *properties* and option sets (the `process-inventory`
  target in `targets.md`); auditing a schema *doc* against its live DB
  (`auditing-a-schema-doc`); capturing a task or a feature (their own guides).
