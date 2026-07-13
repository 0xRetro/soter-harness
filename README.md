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

The kernel above is built and sealed: `.claude/systems/` (one card per system) ·
`.claude/templates/` (seven molds incl. the mold-for-molds) · `.claude/LEXICON.md`
(registry + placement table) · `.claude/RUBRIC.md` (the bar) · `.claude/scripts/check.mjs`
(the one checker — validates classification frontmatter, card/mold shape + order,
card-path and card-concept existence, aliases, links, budgets, security; `--selftest`
plant-and-asserts 28 codes) · `.claude/skills/` (forge, writing-adrs,
reviewing-forge-output, promoting-pieces; all staged) · `decisions/` (ADR-0001…0011).
Machinery ported from sky-harness (ADR-0001), classification retrofit per ADR-0002…0011.
The seal test has run: the forge authored `promoting-pieces` end-to-end (baseline →
evals → checks → fresh-agent pressure-test → gate), and a red-team + claims-vs-reality
sweep hardened the checker (ADR-0010, ADR-0011). Next: the distribution decision, then
the first context-layer overlay.