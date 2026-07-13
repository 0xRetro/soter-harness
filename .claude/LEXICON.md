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

## Where it goes (placement table)

Once classified, a piece has exactly one home. When no existing system fits, that is
the signal to define a new system card first (`.claude/systems/`), not to force-fit.
Org- or world-specific content never lives here — it belongs in a downstream context
overlay (not yet built).

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
