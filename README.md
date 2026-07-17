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
the card when it matters. A mechanism marked "delegated" runs inside one of the
engines — the checker, the forge loop, or the human gate — while its owning system
keeps the behavior (ADR-0045).

<!-- Editing rules for these tables (aligned in PR #35):
  - One table per layer; columns: System · Promise · Mechanisms · Key components · Concepts.
  - Promise: one full sentence, from the card's Promise.
  - Mechanisms & Key components: bare names, one per line (<br>). No annotations —
    decree/deferral/verdict notes and trigger lists live on the system card.
    Only allowed markers: "(delegated to the checker/forge/human gate)" (ADR-0045)
    and "(an engine)".
  - "None" only when the system truly has none.
  - Concepts: from the card's Concepts line; group 2-3 per line with · only when a list is long.
  - No hardcoded counts (live-lists rule) — role words instead ("the molds").
-->

### Kernel — required substrate: makes the harness run and self-build

| System | Promise | Mechanisms | Key components | Concepts |
|---|---|---|---|---|
| **template** | Every piece starts as a copy of its mold, so shape is guaranteed by instantiation rather than policing. | scaffold<br>(delegated to the forge) | `templates/` (the molds) | mold<br>shape<br>hint |
| **lexicon** | Every term is defined once and referenced everywhere, so classification is mechanical rather than a judgment call. | alias lint<br>(delegated to the checker)<br>registry-coverage lint<br>(delegated to the checker) | `LEXICON.md` | term · alias<br>concept · layer<br>system · mechanism<br>component · engine<br>delegated mechanism |
| **standards** | There is one explicit bar for quality, naming, and budgets, so review is a checklist rather than taste. | rubric review<br>(delegated to the human gate)<br>budgets/naming<br>(delegated to the checker) | `RUBRIC.md`<br>`standards/degrees-of-freedom.md` | budget<br>degree of freedom<br>flex point<br>rubric |
| **eval** | Every piece proves it was needed (a watched baseline failure) and holds up under realistic pressure. | baseline · pressure-test<br>(delegated to the forge)<br>running-evals | `evals/` (the cases)<br>`running-evals`<br>`agents/eval-runner.md` | baseline<br>pressure case<br>golden<br>eval case<br>meta-case |
| **enforcement** | Everything the harness declares is mechanically verified, and a green result always carries evidence. | checker (an engine) | `scripts/check.mjs` | check rule<br>green carries evidence<br>turn gate |
| **governance** | The harness changes only deliberately: decisions are recorded, humans gate every merge, and new pieces earn trust before autonomy. | human gate<br>decision recording<br>promotion | `decisions/`<br>`writing-adrs`<br>`reviewing-forge-output`<br>`promoting-pieces` | gate<br>ADR<br>staged<br>promoted<br>add-on<br>decree |
| **authoring** | New pieces are born through one loop — mold, evals, checks, gate — never freehand. | forge | `skills/forge/`<br>`rules/authoring.md` | piece<br>the loop<br>exclusion clause<br>gotcha |
| **platform** | All claude-code coupling is quarantined in one place, so every other system stays portable. | None | `settings.json`<br>`hooks/hooks.json`<br>`plugin.json`<br>`rules/parallel-sessions.md` | hook · skill · agent<br>command · script<br>worktree · subagent<br>session · guide |

### Core — generic capability above the kernel

| System | Promise | Mechanisms | Key components | Concepts |
|---|---|---|---|---|
| **policy** | Every governed subject has exactly one rules-first policy standard; the docs live in Notion, their shape lives here. | authoring-a-policy-standard | `standards/shaping-a-policy-standard.md`<br>`authoring-a-policy-standard` | policy standard<br>subject |

### Context — the world the harness works in

| System | Promise | Mechanisms | Key components | Concepts |
|---|---|---|---|---|
| **crm** | Organizations, the people at them, the channels connecting us, and the meetings held with them are mirrored to the live CRM databases. | capturing-an-org<br>capturing-a-contact | `capturing-an-org`<br>`capturing-a-contact` | org<br>contact<br>channel<br>meeting |
| **project-management** | Delivery is tracked above the feature level — projects and the tasks that execute them, per their policy standards. | capturing-a-task | `capturing-a-task` | project · task<br>milestone · update |
| **product-development** | A captured use-case is carried to a shipped feature, tracked lightly on its own tool's board. | capturing<br>defining | `capturing-a-feature`<br>`defining-a-feature` | feature record<br>tooling page<br>feature lifecycle<br>Feature Board<br>containment |
| **process** | Repeatable work is defined once in the live Process Inventory — definitions, not a runtime. | capturing-a-process<br>red-teaming | `standards/shaping-a-process.md`<br>`capturing-a-process`<br>`red-teaming-a-process` | process · step<br>work-item · subprocess<br>process run · slot<br>role · capability |
| **resources** | The team's external accounts and platforms are tracked with clear access and administration answers. | validating-resources | `validating-resources` | resource |
| **docs** | The team's shared documents and links have one governed home, while private-collection docs are served in place and never enter it. | None | None | doc<br>private-workspace doc |
| **calendar** | Standing commitments are defined once — meaning and links in the registry, time in Google Calendar, never a mirror. | None | None | commitment |
| **onchain** | The org's onchain footprint — addresses, wallets and safes, and the rules for operating them — is tracked in the live [DB] Addresses. | None | None | address |
| **email** | Work arriving in the org's Gmail workspace reaches its humans triaged, filed, and ready to act on — writes human-gated, agents never send mail. | None | None | email thread<br>triage window<br>agent label |
| **sky** | Sky-ecosystem vocabulary has one home, so terms don't drift per surface. | None | None | Sky ecosystem · Atlas<br>spell · MSC · star<br>Prime Agent · NFAT<br>the Docs subject areas:<br>Distribution Rewards · Integration Boost<br>Governance Accessibility Rewards<br>Pioneer Chain Rewards<br>Admin & Internal Ops · Legal & Compliance<br>Business Development · Funding & Financials<br>Settlement & Payments Ops · DeFi Products<br>Vault Curation · SkyLink Bridge<br>Agent Systems · Branding Marketing & IP |

### Automation — pushing, pulling, and keeping stores honest

| System | Promise | Mechanisms | Key components | Concepts |
|---|---|---|---|---|
| **publishing** | Work reaches external systems of record deliberately — typed, de-duplicated, human-confirmed; Notion is the first binding, not the system. | notion-push<br>notion-update<br>drive-place | `pushing-to-notion`<br>`updating-a-notion-page`<br>`filing-a-drive-artifact`<br>`targets.md`<br>`writing-records-to-notion.md` | publish · binding<br>external store<br>fetch-merge-write<br>relation · option set<br>resolve · page |
| **ingestion** | External sources become standardized records, with a human gating what actually enters; the pull side. | reviewing-a-repo<br>processing-a-meeting<br>ingesting-slack-channels<br>processing-email | `reviewing-a-repo`<br>`processing-a-meeting`<br>`ingesting-slack-channels`<br>`processing-email` | source<br>ingestion<br>standardize<br>intake gate |
| **schema-audit** | Notion's schema docs and the harness's own mirror stay true to the live databases. | auditing-a-schema-doc | `auditing-a-schema-doc` | schema doc<br>schema drift |

The `rules/` folder is a delivery form (always-on), not a system — each rule declares
its owning system in frontmatter (`authoring.md` → authoring; `parallel-sessions.md`
→ platform), per the folder-never-implies-system rule.

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

**Add-ons built on top (ADR-0012, all four layers in one repo):** a Notion intake stack —
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