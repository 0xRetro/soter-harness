---
name: lexicon
layer: kernel
system: lexicon
kind: component
mold: singleton   # unique shape; the registry defines entry formats itself (ADR-0007)
---

# Soter Harness — Lexicon

The registry: every term defined once, referenced everywhere. Data, not machinery —
the enforcement checker reads this file (aliases table below) and runs the rules.

## The classification rule

Every piece is placed by four questions — mechanical, not a vibe:

1. **kind** — does it run on a trigger? → *mechanism*. Is it read or executed? → *component*.
2. **system** — which promise does it keep, for which consumer? Group by concern,
   never by delivery-form. Each system is defined once in `.claude/systems/`.
3. **layer** — *kernel* (required to run/self-build) · *core* (adds capability) ·
   *context* (org/world-specific) · *automation* (built with the harness).
4. **mold** — which template it instantiates (`.claude/templates/<mold>.md`), or
   `singleton` for unique-shape components (ADR-0007).

Declared as frontmatter (`layer · system · kind · mold`) on every durable content
piece; the checker validates all four. Eval cases and ADRs carry their own
established headers instead (ADR-0007).

## The primitives

| Primitive | Is | On disk |
|---|---|---|
| **layer** | a tier of generality | a frontmatter value only |
| **system** | a concern: one promise to a named consumer; owns mechanisms + components | one card in `.claude/systems/` |
| **mechanism** | a way of doing something that runs on a trigger | a card row in its system's card, realized by files |
| **component** | an artifact that is read or executed | a markdown file with classification frontmatter — OR non-markdown logic (a script), which carries no frontmatter and is classified on its owning system's card instead |
| **concept** | a defined term | a row in the Registry or this Primitives table |

## Registry (terms)

One row per concept: term · owning system · definition. No synonyms — the aliases
table below is the banned list.

| Term | System | Definition |
|---|---|---|
| term | lexicon | a word with exactly one meaning here, defined in this registry |
| alias | lexicon | a banned synonym; the checker flags it and names the canonical term |
| concept | lexicon | a defined idea; a registry row, never a file |
| mold | template | the standard shape a piece is instantiated from; lives in `.claude/templates/` |
| shape | template | the required frontmatter + sections a mold prescribes |
| hint | template | an HTML comment in a mold guiding the author; deleted when filled |
| check rule | enforcement | one mechanical validation the checker runs; declared as data |
| green carries evidence | enforcement | a pass must prove work happened — an empty scan is an error, never a pass |
| gate | governance | a checkpoint a change must pass; the human gate is merge approval |
| ADR | governance | an append-only decision record in `decisions/`; immutable once Accepted — supersede, never edit |
| staged | governance | merged but user-invoke-only, not in the guide index — every new piece starts here |
| promoted | governance | earned a guide-index entry through real use. Read-only guides also gain auto-invocation; side-effecting guides (they write, commit, dispatch, send) keep `disable-model-invocation` forever — indexed but never auto-firing (`/forge` is the exemplar) |
| baseline | eval | the recorded failure of an agent WITHOUT the piece — proof the piece is needed |
| pressure case | eval | an eval scenario with realistic stakes tempting the agent to skip the piece |
| golden | eval | a recorded known-good pass (`passed: <sha>`); a golden that stops passing is a regression |
| eval case | eval | one artifact-level test: Try / Expect (observable) / Never |
| budget | standards | a hard size cap (CLAUDE.md, guide bodies, descriptions) the checker enforces |
| degree of freedom | standards | how tightly a step is specified: narrow bridge → exact; open field → heuristics |
| flex point | standards | a marked spot (`FLEX:`) where judgment is allowed, with stated bounds |
| rubric | standards | THE checklist every piece clears before merge (`.claude/RUBRIC.md`) |
| exclusion clause | authoring | what a piece does NOT cover; no two pieces claim the same territory |
| gotcha | authoring | an observed failure mode recorded in the piece that hit it |
| piece | authoring | any classified artifact of the harness (a component or a mechanism's file) |
| the loop | authoring | mold → evals → checks → gate; the only way a piece is born |
| guide | platform | a how-to skill: steps the model loads on demand (`.claude/skills/`) |
| hook | platform | auto-triggered deterministic infra at a lifecycle event |
| skill | platform | on-demand loaded procedure (progressive disclosure) |
| agent | platform | an isolated-context delegate with its own tools/prompt |
| command | platform | a typeable shortcut over existing capability |
| script | platform | logic that is executed, never read into context |
| worktree | platform | an isolated working copy; the sandbox for authoring |
| subagent | platform | an agent spawned for one task (testing, exploration) |
| add-on | governance | a modular bundle of context/automation pieces that stacks on the kernel, reusing its molds, checker, and lexicon (ADR-0012) |
| publish | publishing | to send a harness work-artifact to an external store |
| external store | publishing | a system of record outside the harness that receives published artifacts (Notion is the first) |
| binding | publishing | a mechanism mapping harness artifacts to one external store's API (e.g. notion-push) |
| fetch-merge-write | publishing | update an external record by reading its current value, merging locally, then writing — never a blind write that clobbers what's there |
| relation | publishing | a field pointing to another record; written as the TARGET page's id (resolve it, never fabricate) |
| option set | publishing | the fixed list of allowed values for a select/multi_select field; a value must match an existing option, never invented |
| resolve | publishing | to turn a name/description into the real Notion id or existing option it refers to (via search / get-users / live schema), or leave it empty — never fabricate |
| page | publishing | one entry in a Notion database; a "card" (board view) and "row" (table view) are renderings of the same page, not new concepts |
| Feature Board | product-development | a Notion database of feature cards; one per tooling entry — the board a card lives in is its link to that tooling page |
| feature record | product-development | one card on the Feature Board — the tracked unit of product work: name, the why (in Description), and status |
| tooling page | product-development | one page in the [DB] Tooling database describing a tool/product; each tooling entry has its own Feature Board, so a feature belongs to a tool by living in that board (containment is the link) |
| feature lifecycle | product-development | a feature card's real Feature Board statuses: Planned → Up Next → In Development → Completed (or Canceled) |
| ingestion | ingestion | turning an external source into standardized Notion records, human-gated on what enters |
| source | ingestion | an external thing to ingest — a repo, doc, or dump |
| standardize | ingestion | normalize a source's data to the target database's schema before publishing |
| intake gate | ingestion | the human decision on WHAT from a source actually gets ingested — distinct from a merge gate (governance) and from a per-write confirm |
| containment | product-development | a feature belongs to a tool by living in that tool's Feature Board — the board IS the link, no relation property |
| schema doc | schema-audit | the representation layer of a subject's policy standard — the documented fields that schema-audit audits against the live DB (the legacy "[DB] X Standards" pages are its ungoverned ancestor) |
| schema drift | schema-audit | divergence between a schema doc and the live database's actual fields/types/options |
| project | project-management | one row in the [DB] Projects database — a client or internal engagement (type, status, dates, org, contact), tracking work above the task level |
| task | project-management | one row in the [DB] Tasks database — an actionable unit of delivery (status, assignee, next action), related to a project and/or org |
| process | process | a reusable definition of how repeatable work gets done — one entry in the live [DB] Process Inventory (row + shaped body), distinct from any single run of it |
| step | process | an ordered stage within a process that groups the work-items done in that stage |
| work-item | process | one thing to get done inside a step (a checkbox in the process body); the process concept, deliberately NOT a [DB] Tasks task |
| process run | process | one execution of a process; its work-items are tracked as [DB] Tasks rows — the seam to project-management |
| role | process | a named responsibility bundle a process binds its steps to — one row in [DB] Roles (definition, requirements, training, held-by); a run's Roles field maps each to a contact |
| capability | process | a tag on a [DB] Roles row naming an authorization or skill the role requires (values defined in the Processes policy); a person is matched to a role by holding every capability it requires |
| subprocess | process | a reused executable sequence with one canonical [DB] Process Inventory home; callers carry it in full (never a pointer) and the home's Used By list is the update obligation (ADR-0028) |
| org | crm | one row in the [DB] Orgs database — an organization (type, tags, links), with related contacts and projects |
| contact | crm | one row in the [DB] Contacts database — a person (email, role, status, disposition), related to their org |
| channel | crm | one row in the [DB] Channels database — a communication venue (platform, members, related orgs) where work arrives or is coordinated |
| policy standard | policy | the rules-first governance doc for ONE subject — definition, scope, classifications with overlap rules, rules, lifecycle, then representation; lives in the org's policy-standards registry in the external store, with its subject's data; exactly one per subject (ADR-0021) |
| subject | policy | the one thing a policy standard governs — a record type, a concept, or a mechanism; named, never implied |
| Sky ecosystem | sky | the Sky (formerly MakerDAO) ecosystem the org operates within — the umbrella for its stars, agents, and governance artifacts |
| Atlas | sky | the Sky Atlas — the ecosystem's governance rulebook; articles cited as A.x.y links (sky-atlas.io) |
| spell | sky | a governance/protocol action executed on-chain as a spell |
| MSC | sky | the Monthly Settlement Cycle |
| star | sky | a semi-autonomous sub-organization of the Sky ecosystem (e.g. Laniakea), onboarded via the Star Onboarding process |
| Prime Agent | sky | an agent-organization rank in the ecosystem's agent framework — an org Type in [DB] Orgs and the Tasks `Prime Agent` select (Spark · Skybase · Grove · Keel) |
| NFAT | sky | the NFAT product line — Beacon · Configurator · Relay |

## Aliases (do not use → use instead)

Machine-read by the checker (synonym lint) over harness content. Grow only on
observed drift.

| Do not use | Use instead |
|---|---|
| playbook, recipe | guide |
| test case | eval case |
| judgment point | flex point |
| template file | mold |
| category | system |
| project page | tooling page |
| phase | step |

## Where it goes (placement table)

Once classified, a piece has exactly one home. When no existing system fits, that is
the signal to define a new system card first (`.claude/systems/`), not to force-fit.
The harness holds all four layers (ADR-0012): generic pieces stay generic (kernel ·
core), and org- or vendor-specific pieces live here too as declared add-ons
(`layer: context` or `layer: automation`) — e.g. the product-development and publishing
systems. Only kernel + core export as the generic plugin.

| Piece | Directory | Mold | Evals? |
|---|---|---|---|
| guide | `.claude/skills/<name>/SKILL.md` | how-to-guide | yes (≥3, incl. pressure) |
| house rule | `.claude/rules/<topic>.md` | house-rule | no |
| standard | `.claude/standards/<name>.md` | standard | no |
| system card | `.claude/systems/<name>.md` | system-card | no |
| mold | `.claude/templates/<name>.md` | mold | no |
| eval case | `.claude/evals/<guide>/<case>.md` | eval-case | — |
| ADR | `decisions/ADR-<n>-<slug>.md` | adr | no |
| script (non-md logic) | its system's dir | none (classified on the system card) | via selftest |
