# Soter Harness: a claude-code collaboration platform

*Stop teaching your agents the same thing over and over, and start distributing collective knowledge and unlock leverage.*  

The Soter Harness is a claude-code project that aims to create a standard and consistent way for users to generate durable AI context and knowledge in a collaborative way. The Soter Harness aims to create a generic harness, that self-manages and self-improves. The intention of the harness is to require concepts to be defined and implemented in a consistent way. This simple meta-mechanism then compounds into strategy for building a platform of context, knowledge, and automations, and ultimately unlocking accessible controls and distribution channels for powerful tools for users (and agents alike). 

The Harness is structured in 4 layers of separation. 
- **The Kernel Layer** - required substrate that makes the harness run and self-build. 
- **The Core Layer** - systems and generic enhancements for the harness system itself, or global helper system for more advanced layers. 
- **The Context Layer** - real-world context and knowledge about the world the harness is interacting with. Defines 'things' and concepts beyond the harness layers. 
- **The Automation Layer** - the layer where pushing and pulling, and applying all systems to deliver work occurs.  

The primitives that are used to create anything within the harness are: 
- Layer - a tier of generality; where a thing lives based on how required/generic it is 
- systems - a collection of mechanisms that accomplish an objective or purpose 
- mechanisms - a way or routine of doing something 
- components - a collection of things used in mechanisms and systems 
- concepts  - a defined thing, so we don't confuse or misuse things. 

The Kernel Layer involves 
- soter-harness lexicon system
  - lexicon registry component (md file — data, no machinery of its own)
    - concept entries: one concept → one term + accepted synonyms + banned synonyms
  - lexicon check rule components (data rows the enforcement checker runs)
  - concepts: term · alias · concept
- soter-harness template system
  - scaffold mechanism (a new piece = a copy of its mold)
  - template mold components (one mold per piece shape, incl. the mold-for-molds)
  - shape check rule components (data rows the enforcement checker runs)
  - concepts: mold · shape
- soter-harness enforcement system
  - checker mechanism (ONE shared engine — reads every system's check rules as data)
  - check registry component
  - concepts: check rule · green carries evidence (an empty scan is a failure, never a pass)
- soter-harness eval system
  - baseline mechanism (prove the failure without the piece, first)
  - pressure-test mechanism (fresh agent, realistic stakes — polite tests lie)
  - eval case components (data, ≥3 per piece; the runner is replaceable machinery)
  - concepts: baseline · pressure case
- soter-harness standards system (kernel: the gate consumes it)
  - rubric component (THE checklist) · naming standard · budget standard
  - degrees-of-freedom standard component (where judgement is allowed, with bounds)
  - concepts: budget · degree of freedom · flex point
- soter-harness governance system (separate from standards; ratifies them, the gate consumes them)
  - human gate mechanism (merge approval on every harness change)
  - ADR log component (append-only decision records)
  - concepts: gate · ADR · staged → promoted
- soter-harness authoring system (the self-build loop — kernel by definition)
  - forge mechanism (authors a new piece end-to-end: mold → evals → checks → gate; never freehand)
  - authoring guide component (how pieces are born, baseline-failure first)
  - concepts: piece · the loop
- soter-harness platform system (claude-code only — ALL platform coupling quarantined here; kept separate for exactly that reason)
  - one usage-standard component per primitive: hooks · skills · agents · commands · worktrees · orchestration
  - wiring component (settings/hooks.json — how mechanisms get attached to the platform)
  - concepts: hook (auto-triggered deterministic infra) · skill (on-demand loaded procedure) · agent (isolated-context delegate) · command (typeable shortcut) · script (executed, never read) · worktree (isolated working copy)
  - note: a concrete hook/skill/agent file is a mechanism or component OF the system that uses it — the platform system only defines what these forms ARE and how we use them

Deferred (not kernel): distribution system — likely core; packaging + installer, decided later.

## Status

The kernel is built and sealed: the eight systems above (`.claude/systems/`), the molds
(`.claude/templates/`), the registry + placement table (`.claude/LEXICON.md`), the bar
(`.claude/RUBRIC.md`), and the one checker (`.claude/scripts/check.mjs` — validates
classification frontmatter, card/mold shape + order, card-path/card-concept/card-listing
existence, aliases, links, budgets, security; `--selftest` plant-and-asserts every
violation code). Machinery ported from sky-harness (ADR-0001), classification retrofit
and hardening per the ADR log. The seal test ran end-to-end (the forge authored a piece
through baseline → evals → checks → fresh-agent pressure-test → gate); red-team +
claims-vs-reality sweeps harden the checker.

**Add-ons built on top (ADR-0012, all four layers in one repo):** a Notion intake engine —
**automation** systems `publishing` (create/update bindings, live-proven), `ingestion`
(review a source → curate → publish), and `schema-audit` (keep Notion's own schema docs
true to the live DBs), plus **context** domains `product-development`,
`project-management`, and `crm` that each shape their records and write through the
bindings. The shared write-discipline lives once in `.claude/standards/writing-records-to-notion.md`;
each domain guide references it and adds only its nuance.

Add-ons are anything not in the kernel-8 (`lexicon · template · enforcement · eval ·
standards · governance · authoring · platform`). Live lists (never hardcode counts):
systems `ls .claude/systems/` · guides `ls .claude/skills/` · decisions
`decisions/README.md`. Everything is **staged** until real use earns promotion.