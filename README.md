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

| Layer | System | Promise (short) | Mechanisms | Key components | Concepts |
|---|---|---|---|---|---|
| kernel | **template** | Every piece starts as a copy of a mold | scaffold (a forge step) | 7 molds in `templates/` incl. the mold-for-molds | mold · shape · hint |
| kernel | **lexicon** | Every term defined once; classification mechanical | — (data only; checker runs its rules) | `LEXICON.md` registry | term · alias · concept |
| kernel | **standards** | One explicit bar for "good" | — (read at gate; mechanical items in checker) | `RUBRIC.md` · `degrees-of-freedom.md` | budget · degree of freedom · flex point · rubric |
| kernel | **eval** | Pieces prove need (baseline) and hold under pressure | baseline · pressure-test · running-evals | `evals/` cases · `running-evals` guide · `eval-runner` agent | baseline · pressure case · golden · eval case · meta-case |
| kernel | **enforcement** | Everything declared is verified; green carries evidence | checker (one engine, 5 triggers: lint hook · Bash guard · ADR guard · turn gate · CI) | `scripts/check.mjs` | check rule · green carries evidence · turn gate |
| kernel | **governance** | Changes are deliberate; humans gate merges | human gate · decision recording · promotion | `decisions/` · `writing-adrs` · `reviewing-forge-output` · `promoting-pieces` | gate · ADR · staged · promoted · add-on · decree |
| kernel | **authoring** | Pieces born through the loop, never freehand | forge | `forge` guide · `rules/authoring.md` | piece · the loop · exclusion clause · gotcha |
| kernel | **platform** | claude-code coupling quarantined; rest stays portable | — (owns wiring; usage standards only on RED baseline) | `settings.json` · `hooks.json` · `plugin.json` · `rules/parallel-sessions.md` | hook · skill · agent · command · script · worktree · subagent · session · guide |
| core | **policy** | One rules-first policy standard per governed subject (docs live in Notion) | authoring-a-policy-standard | `shaping-a-policy-standard.md` · the authoring guide | policy standard · subject |
| context | **crm** | Orgs, contacts, channels → [DB] Orgs/Contacts/Channels | capturing-an-org · capturing-a-contact (channel guide deferred) | the two capture guides | org · contact · channel |
| context | **project-management** | Projects + tasks → [DB] Projects/Tasks, per their policies | capturing-a-task (project capture: deliberate no-guide, GREEN baseline) | `capturing-a-task` guide | project · task |
| context | **product-development** | Use-case → shipped feature; board containment IS the tool link | capturing · defining (build/ship stages future) | `capturing-a-feature` · `defining-a-feature` | feature record · tooling page · feature lifecycle · Feature Board · containment |
| context | **process** | Repeatable work defined once → [DB] Process Inventory; definitional, not runtime | capturing-a-process · red-teaming | `shaping-a-process.md` · the two guides | process · step · work-item · process run · role · capability |
| context | **resources** | External accounts/platforms → [DB] Resources, per its policy | validating-resources (capture/update: deliberate no-guide, ADR-0028) | `validating-resources` guide | resource |
| context | **sky** | Sky-ecosystem vocabulary defined once | — (decreed ahead of pieces, ADR-0026) | — (concepts are its substance) | Sky ecosystem · Atlas · spell · MSC · star · Prime Agent · NFAT |
| automation | **publishing** | Artifacts reach external stores typed + human-confirmed; Notion = first binding | notion-push · notion-update | binding guides · `targets.md` mirror · `writing-records-to-notion.md` spine | publish · external store · binding · fetch-merge-write · relation · option set · resolve · page |
| automation | **ingestion** | External source → curated, standardized records; the pull side | reviewing-a-repo (more sources forged as needed) | `reviewing-a-repo` guide | source · ingestion · standardize · intake gate |
| automation | **schema-audit** | Schema docs + `targets.md` mirror stay true to live DBs | auditing-a-schema-doc | `auditing-a-schema-doc` guide | schema doc · schema drift |

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