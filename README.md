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
- components - an artifact that is read or executed; used by mechanisms and systems 
- concepts  - a defined thing, so we don't confuse or misuse things. 

## Systems inventory

One row per system, all four layers. The source of truth for every row is the
system's card in `.claude/systems/` — this table is a hand-synced overview, so a PR
that changes a card updates its row in the same PR. Promises drift slowest;
mechanisms, components, and concepts change with nearly every merge — verify against
the card when it matters.

### Kernel — required substrate: makes the harness run and self-build

| System | Promise | Mechanisms | Key components | Concepts |
|---|---|---|---|---|
| **template** | Every piece starts as a copy of a mold — shape by instantiation, not policing | scaffold (a forge step) | `templates/` — 7 molds<br>`mold.md` (the mold-for-molds) | mold<br>shape<br>hint |
| **lexicon** | Every term defined once, referenced everywhere; classification is mechanical | — (data only; the checker runs its rules) | `LEXICON.md` (the registry) | term<br>alias<br>concept |
| **standards** | One explicit bar for "good" — review is a checklist, not taste | — (read at the gate; mechanical items run in the checker) | `RUBRIC.md`<br>`standards/degrees-of-freedom.md` | budget<br>degree of freedom<br>flex point<br>rubric |
| **eval** | Every piece proves it was needed (baseline) and holds under pressure | baseline<br>pressure-test<br>running-evals | `evals/` cases (≥3 per guide)<br>`running-evals` guide<br>`agents/eval-runner.md` | baseline<br>pressure case<br>golden<br>eval case<br>meta-case |
| **enforcement** | Everything declared is mechanically verified; green carries evidence | checker — one engine, 5 triggers:<br>lint hook (warn)<br>Bash guard<br>ADR guard<br>turn gate<br>CI | `scripts/check.mjs` (the one script) | check rule<br>green carries evidence<br>turn gate |
| **governance** | The harness only changes deliberately; humans gate merges | human gate<br>decision recording<br>promotion | `decisions/` (ADR log)<br>`writing-adrs`<br>`reviewing-forge-output`<br>`promoting-pieces` | gate<br>ADR<br>staged<br>promoted<br>add-on<br>decree |
| **authoring** | Pieces are born through the loop — mold → evals → checks → gate | forge | `skills/forge/`<br>`rules/authoring.md` | piece<br>the loop<br>exclusion clause<br>gotcha |
| **platform** | claude-code coupling quarantined here; every other system stays portable | — (owns wiring; usage standards only on an observed RED baseline) | `settings.json`<br>`hooks/hooks.json`<br>`plugin.json`<br>`rules/parallel-sessions.md` | hook · skill · agent<br>command · script<br>worktree · subagent<br>session · guide |

### Core — generic capability above the kernel

| System | Promise | Mechanisms | Key components | Concepts |
|---|---|---|---|---|
| **policy** | Every governed subject has exactly one rules-first policy standard (the docs live in Notion; the shape lives here) | authoring-a-policy-standard | `standards/shaping-a-policy-standard.md`<br>`authoring-a-policy-standard` guide | policy standard<br>subject |

### Context — the world the harness works in

| System | Promise | Mechanisms | Key components | Concepts |
|---|---|---|---|---|
| **crm** | Orgs, contacts, channels mirrored to [DB] Orgs / Contacts / Channels | capturing-an-org<br>capturing-a-contact<br>(channel guide deferred) | `capturing-an-org` guide<br>`capturing-a-contact` guide | org<br>contact<br>channel |
| **project-management** | Projects + tasks mirrored to [DB] Projects / Tasks, semantics per their policies | capturing-a-task<br>(project capture: deliberate no-guide, GREEN baseline) | `capturing-a-task` guide | project<br>task |
| **product-development** | Use-case → shipped feature; board containment IS the tool link | capturing<br>defining<br>(build/ship stages future) | `capturing-a-feature` guide<br>`defining-a-feature` guide | feature record<br>tooling page<br>feature lifecycle<br>Feature Board<br>containment |
| **process** | Repeatable work defined once in [DB] Process Inventory; definitional, not runtime | capturing-a-process<br>red-teaming | `standards/shaping-a-process.md`<br>`capturing-a-process` guide<br>`red-teaming-a-process` guide | process · step<br>work-item<br>process run<br>role · capability |
| **resources** | External accounts/platforms tracked in [DB] Resources, per its policy | validating-resources<br>(capture/update: deliberate no-guide, ADR-0028) | `validating-resources` guide | resource |
| **sky** | Sky-ecosystem vocabulary defined once, referenced everywhere | — (decreed ahead of pieces, ADR-0026) | — (concepts are its substance) | Sky ecosystem · Atlas<br>spell · MSC · star<br>Prime Agent · NFAT |

### Automation — pushing, pulling, and keeping stores honest

| System | Promise | Mechanisms | Key components | Concepts |
|---|---|---|---|---|
| **publishing** | Artifacts reach external stores deliberately — typed, human-confirmed; Notion is the first binding, not the system | notion-push<br>notion-update | `pushing-to-notion` guide<br>`updating-a-notion-page` guide<br>`targets.md` (schema mirror)<br>`writing-records-to-notion.md` (the spine) | publish · binding<br>external store<br>fetch-merge-write<br>relation · option set<br>resolve · page |
| **ingestion** | External source → curated, standardized, human-gated records; the pull side | reviewing-a-repo<br>(more sources forged as needed) | `reviewing-a-repo` guide | source<br>ingestion<br>standardize<br>intake gate |
| **schema-audit** | Schema docs + the `targets.md` mirror stay true to the live DBs | auditing-a-schema-doc | `auditing-a-schema-doc` guide | schema doc<br>schema drift |

Cross-cutting (not systems): the always-on rules (`rules/authoring.md`,
`rules/parallel-sessions.md`) and the primitives above.

Deferred (not kernel): distribution system — likely core; packaging + installer, decided later.

## Status

The kernel is built and sealed: the eight kernel systems in the table above (`.claude/systems/`), the molds
(`.claude/templates/`), the registry + placement table (`.claude/LEXICON.md`), the bar
(`.claude/RUBRIC.md`), and the one checker (`.claude/scripts/check.mjs` — validates
classification frontmatter, card/mold shape + order, card-path/card-concept/card-listing
existence, aliases, links, budgets, security, hook-wiring parity, golden freshness +
coverage, platform-coupling quarantine; blocks live via the Bash guard and the turn
gate; `--selftest` plant-and-asserts every
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
each domain guide references it and adds only its nuance. An ops tier builds on the same
spine: **context** system `process` defines repeatable work (Process → Step → Work-item)
in the live Process Inventory, governed by **core** system `policy` — one rules-first
policy standard per subject (ADR-0021/0022), whose Fields sections are what schema-audit
now audits.

Add-ons are anything not in the kernel-8 (`lexicon · template · enforcement · eval ·
standards · governance · authoring · platform`). Live lists (never hardcode counts):
systems `ls .claude/systems/` · guides `ls .claude/skills/` · decisions
`decisions/README.md`. Everything is **staged** until real use earns promotion.