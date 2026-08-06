# Soter architecture

This document defines the intended architecture of Soter. It describes the
contracts the implementation must satisfy without making Claude, Codex, or any
external service part of the architecture itself.

## Purpose and design principles

Soter is a user-owned harness for assembling durable context, reliable
automations, and external integrations around capable agent hosts. It exists so
useful behavior can accumulate across sessions and users without becoming an
unexplained pile of prompts, provider-specific routines, and stale assumptions.

The harness should help a user:

- Understand which systems are present, why they exist, and what they can do.
- Select or remove capabilities without guessing about hidden dependencies.
- Give automations the right context and connect them to interchangeable
  integrations through explicit contracts.
- Use the same harness through Codex, Claude, and future compatible hosts.
- Know whether a system is configured, tested, working, degraded, or unknown.
- Turn observed failures and successful patterns into contained improvements.
- Share packs and configurations without unintentionally sharing private data,
  credentials, or runtime state.
- Let proven, bounded behavior become more autonomous without granting blanket
  authority to an agent.

Soter is successful when a new user or agent can inspect the configured harness
and continue its operation or development without needing the original author's
conversation history. The answer to “why is this here?” should live in the
system contract; the answer to “is it working?” should point to current
evidence.

### What Soter is not

Soter is not a model, a replacement for an agent host, or a synonym for the
model's context window. It is not a database that must copy every source of
truth, and it is not a workflow engine that requires every step to be
deterministic. It does not make external providers interchangeable where their
semantics genuinely differ.

Soter also does not define learning as unrestricted self-modification. It may
adapt within a run, improve a user's private configuration, and evolve shared
packs, but each scope has its own authority, evidence, and promotion boundary.

### Design principles

1. **Make the graph explicit.** Systems declare their dependencies,
   capabilities, authorities, effects, and evidence. Folder placement and
   conversational memory cannot be the only link between important behavior.
2. **Keep one canonical authority per fact.** A source may live in the harness
   or externally. Its role, freshness, edit path, and projection behavior are
   declared rather than inferred from location.
3. **Separate responsibility from delivery.** The five layers describe what a
   system owns. Packs describe how systems are selected and shared. Host
   adapters describe how the same contracts are delivered through an agent
   runtime.
4. **Keep outcomes separate from providers.** Automations express intended
   outcomes and required capabilities. Integrations implement those
   capabilities and expose provider-specific constraints honestly.
5. **Make configuration user-owned.** Required base systems are visible;
   optional systems never activate invisibly. Recommendations explain their
   reasoning and expand into inspectable configuration.
6. **Prefer contracts to repeated prose.** Instructions remain useful where
   judgment is required, but identity, compatibility, effects, authority,
   configuration, and verification are machine-readable when possible.
7. **Use deterministic enforcement for deterministic rules.** Agents should
   not spend judgment remembering constraints that a resolver, schema, effect
   gate, or checker can enforce reliably.
8. **Treat evidence as scoped and perishable.** A pass applies to declared
   claims, dependencies, environments, and freshness boundaries. Unknown,
   stale, and skipped evidence remain visible.
9. **Earn autonomy by change class.** Authority expands through demonstrated
   reliability, containment, monitoring, and rollback. It is revocable and
   never inferred from confidence alone.
10. **Improve by consolidation.** Observations do not write directly to shared
    behavior. Prefer correcting, simplifying, or retiring existing artifacts
    before creating another rule or exception.
11. **Design interfaces as projections.** Agents, CLI commands, graphical
    interfaces, and generated host files consume the same structured core
    model; none implements a competing version of the truth.
12. **Change through working vertical slices.** Preserve useful behavior,
    replace one boundary at a time, compare outcomes, and remove superseded
    implementation only when current evidence supports the change.

### Architectural promise

For every configured behavior, Soter should be able to answer:

- What system owns it?
- Which layer is responsible for it?
- Why was it selected?
- Which context and authorities does it rely on?
- Which automation produces the outcome?
- Which integration capabilities can create effects?
- Which host realizes the behavior?
- What may be changed, by whom, and under which policy?
- Which evidence shows that it works?
- What becomes stale or unavailable when a dependency changes?

If those questions cannot be answered from current contracts and evidence,
Soter reports the gap instead of asking the user to trust hidden machinery.

## Conceptual model

Soter is both a provider-neutral architecture and a reference implementation
of that architecture. The model defines what must remain consistent; the
implementation proves that the model can work on real agent hosts and external
services.

### The five layers

Layers classify responsibility and provide a simple order for assembling and
understanding a harness. They are not a literal execution pipeline: a run may
read context more than once, call several integrations, or return to an
automation after an external result arrives.

| Layer | Responsibility | Belongs here | Does not belong here |
|---|---|---|---|
| **Kernel** | Govern how Soter is defined, validated, evaluated, changed, and packaged. | Contract schemas, graph checks, evaluation rules, lifecycle governance. | Domain knowledge, user routines, or vendor behavior. |
| **Core** | Provide the portable runtime capabilities required by every harness. | Context assembly, configuration resolution, capability binding, effect policy, evidence, and health. | User- or domain-specific rules or provider-specific implementations. |
| **Context** | Define the world the harness works with and where its truth comes from. | Concepts, policies, schemas, relationships, authority declarations, and retrieval rules. | Orchestration, triggers, or vendor API choreography. |
| **Automation** | Turn context into a defined outcome or repeatable routine. | Triggers, inputs, steps, decisions, outputs, recovery behavior, and required capabilities. | Credentials, provider-specific calls, or hidden domain definitions. |
| **Integration** | Fulfill capabilities through local tools and external services. | Authentication requirements, provider adapters, data translation, typed errors, and capability implementations. | Business outcomes or automation-specific policy. |

Kernel and core are the required base. Each contains multiple required systems
rather than acting as one oversized system. Context, automation, and
integration systems are selectable: a user installs only the capabilities they
want, subject to declared dependencies.

### Context versus runtime context

The context layer does not mean whatever text happens to be in an agent's
context window. It defines durable meaning and authority: what a contact is,
which policy governs a process, which schema describes a record, and where the
canonical value can be found.

Core assembles a bounded runtime view from those declarations for a particular
request. That view may include local files, retrieved external records, user
input, and generated intermediate evidence. Runtime context is temporary;
context contracts and their authority declarations are durable.

Context packs are cut at portable domain boundaries, not at the shape of a
particular provider workspace. The initial work-domain split is explicit:

| Pack | Portable ownership |
|---|---|
| `context.crm` | Organizations, people, customer relationships, and CRM identity |
| `context.projects` | Projects, milestones, embedded work items, status, Decisions, Questions, and Project policy |
| `context.tasks` | Tasks, assignees, dates, lifecycle, and Task policy |
| `context.meetings` | Meetings, participants, commitments, summaries, and transcript relationships |
| `context.communications` | Communication scopes, conversation containers, participant identities, private untrusted content, and typed cross-context links |
| `context.communications.collaboration` | Workspace, channel, DM, thread, message, channel-directory, and ingestion-policy meaning |
| `context.email` | Mailbox windows, RFC822 identity, reduction, labels, drafts, triage, and the send-prohibited boundary |

Each is independently selectable. Cross-domain relationships use typed resource
identities and remain optional at the model level. An Automation may explicitly
select several Context packs for one outcome, while an Integration such as Notion
maps each selected model to the user's configured provider layout. A provider
database relation does not transfer ownership between Context packs.
Collaboration channels belong to Communications, not CRM. Workspace-scoped
conversation identities may carry optional typed person and organization links,
but provider membership never creates CRM identity by implication.

### Systems, packs, artifacts, and bundles

- A **system** or **pack** is one coherent, selectable capability classified in
  one layer. “System” describes its architectural role; “pack” emphasizes that
  it can be installed, removed, versioned, and shared.
- An **artifact** is a component owned by a system, such as a contract, guide,
  policy, template, evaluator, or adapter implementation. Artifacts are not
  installed independently unless they are promoted into systems of their own.
- A **bundle** is a named collection of exact content-addressed pack releases
  or explicit compatible-version constraints. It explains why each pack is
  included and exposes unresolved dependencies or conflicts; it does not
  create another architectural unit, install anything, or confer trust.
- A **configuration** records the exact packs a user selected, their settings,
  integration bindings, trusted authorities, and portable sources. A source
  binds one capability input and authority to explicit consuming packs and
  purposes; it does not make the Integration aware of consumer-specific
  settings. Packs declare required source purposes and cardinality in their
  manifests. Configuration must be portable, inspectable, and shareable without
  silently activating optional systems or resolving with a missing concrete
  source.

A provider integration may implement several capability contracts, and a user
may install several integrations at once. Configuration binds an automation's
required capability to the chosen implementation and authority.

### Agent hosts

Codex, Claude, and future agent runtimes are **hosts**, not layers. A host
adapter projects Soter into that host's native instruction, skill, tool,
plugin, hook, approval, and scheduling mechanisms. Host-specific files are
delivery artifacts; they must not redefine Soter's contracts or semantics.

Supporting a host therefore means passing a conformance suite, not merely
copying files into a recognized folder. The same configured harness should
preserve its declared meaning, effects, gates, and evidence even when the host
uses different native mechanisms.

Portable procedural guidance belongs to an Automation-owned `workflow-guide/v2`,
not to a host skill file. Each current definition is `active-host-guided` and
binds one exact guide, evaluation set, development request/result boundary,
workspace policy, and effect boundary. Configuration selects the Automation;
the host projection realizes its exact guide. Generated skills remain delivery
artifacts and can never be edited into canonical behavior. Evidence binds the
guide's stable semantic `contentFingerprint`, while the pack lock seals the full
document, so changed instructions cannot inherit an earlier behavior verdict.

An active host-guided workflow begins only through
`soter_create_development_request`. Core derives the current active lock and
realized host, fingerprints the exact normalized targets, binds the smallest
requested subset of local reads, writes, commands, and subagent dispatch, and
returns a sanitized development-run inspection. Provider reads or writes,
publication, merge, protected-root mutation, and host realization require
separate authority. An open request may read only one pre-bound text target by
request fingerprint, target id, and an exact chained cursor through
`soter_read_development_target`. The initial cursor is
`{index: 0, previous_material_fingerprint: null}`; each continuation pairs the
returned `nextChunkIndex` with the preceding `materialFingerprint`. Core accepts
no path, caps the whole file at 1 MiB, returns at most 8 KiB of private untrusted
UTF-8 bytes per call in a dedicated model-visible MCP text block plus mirrored
structured output, and grants no further authority. The selected active host
model may transmit and retain that private target material under its own task
and provider policies. The configuration allows only this exact request-bound
entry into the already-active selected host task. It relies on an ambient host
transport boundary Soter neither grants nor verifies, and grants no onward or
third-party disclosure authority.
`soter_inspect_development_run` revalidates and reports the
same boundary as current, stale, or closed without granting new authority.
Target drift closes ordinary inspection; only exact result closure may account
for declared target before/after fingerprints while proving all untargeted
workspace, policy, private-configuration, and managed-host facts unchanged.

### Vocabulary discipline

Soter introduces a term only when it names a distinction that matters to users
or can be enforced mechanically. Existing terms such as mechanism, component,
and engine are retained only where they express a necessary distinction; they
are not foundational merely because the current harness uses them. One concept
must have one canonical term, and retired synonyms must not remain as competing
instructions.

## Operating architecture

The conceptual model above is implemented through a connected set of contracts.
[CONTRACTS.md](./CONTRACTS.md) is the normative specification for system
manifests, graph resolution, runtime behavior, configuration, hosts,
integrations, interfaces, evidence, and health.

### Connections and health

Every pack declares its purpose, requirements, provided interfaces, authorities,
effects, configuration, verification, compatibility, and maturity. Core
resolves those declarations into one graph before a configured behavior runs.
Required connections fail closed; missing optional connections remain visibly
degraded.

Soter reports four separate assembly states:

- **Valid:** declarations and graph relationships are internally consistent.
- **Ready:** required packs, authorities, capabilities, permissions, and
  policies are resolved for the active configuration.
- **Verified:** applicable checks and evaluations have current passing evidence.
- **Healthy:** recent runtime evidence shows the configured systems achieving
  their promised outcomes within policy.

These states and their causes come from one structured source used by agents,
CLI commands, graphical interfaces, and generated host projections.

### Runtime and learning

One runtime supports inspect, operate, configure, and develop intents. A run
resolves the user configuration, assembles authority-aware context, establishes
effects, executes an automation through integration capabilities, verifies its
promised outcome, and records a durable run envelope and evidence.

Kernel's `development-governance/v1` policy makes the `develop` boundary
machine-readable. It owns artifact classification, contract-derived scaffolding,
quality and evaluation rules, evidence requirements, promotion, and change
evidence. It does not own the runtime that changes files: Core owns run envelopes,
effects, checkpoints, and evidence; Automation owns a requested development outcome;
Integration owns provider translation; host adapters own isolated task delivery and
native tool confinement; configuration owns workspace and publication policy. A
Markdown template, host task declaration, or workflow definition is
therefore never executable authority by itself.

Learning has three scopes: temporary adaptation within a run, private
user-configuration improvement, and shared pack evolution. An operational run
may create an improvement candidate, but durable pack changes occur in a
separate development run with explicit authority, evaluation, trial, promotion,
monitoring, and rollback. Autonomy is granted per effect or change class and is
earned through evidence rather than agent confidence.

### Configuration and distribution

The user owns an explicit desired configuration. Core resolves it to an exact
lock while keeping runtime state and secrets separate. The lock fingerprints
selected manifests, every declared pack artifact, capability contracts,
authority declarations, portable source inputs and consumers, and
behavior-relevant host projections. Kernel and the
minimum core are required; context, automation, integration, and optional core
packs are selectable subject to declared dependencies.

Bundles are transparent recommendations that expand into ordinary
configurations. Packs and configurations can be shared without silently
sharing credentials, private runtime state, or optional evidence. Upgrades
preview contract, permission, projection, and verification changes
and preserve a rollback path where the effects allow one.

Kernel provides the contained distribution foundation below the separate
install lifecycle. `pack-release/v1` deterministically seals one pack manifest
and every declared artifact into a content-addressed local capsule, while
`bundle/v1` carries only transparent release references, reasons, and
compatibility limitations. Independent inspection verifies exact local bytes,
dependencies, host constraints, evidence applicability, and privacy exclusions.
It does not fetch, install, configure, realize a host, publish, or promote proof.
Publisher and license remain explicitly unasserted, releases remain unsigned
and untrusted, and publication, redistribution, marketplace, and legal
eligibility remain not evaluated.

### Hosts, integrations, and interfaces

Codex, Claude, and future agent runtimes are hosts. Tested host adapters project
the same resolved Soter configuration into each host's native guidance, skills,
plugins, hooks, approvals, tools, and scheduling features. Host files are
delivery projections, not independent authorities.

One desired configuration may name a default host and be resolved explicitly
for another compatible host. The host choice is captured in the lock; it does
not fork or overlay Context, Automation, Integration, authority, or effect-policy
configuration. Pack incompatibility fails resolution before a host projection
is emitted.

Automations depend on stable capability contracts. Integration packs implement
those capabilities for providers such as Notion, Gmail, Slack, or Otter and own
authentication, transport, translation, typed errors, retry behavior, and
provider limitations. MCP is a supported transport, not the architecture.

For an MCP-backed integration, Core and the host cooperate through a resumable
boundary:

1. Core resolves the exact capability, provider, authority, effects, and host.
2. The integration translator converts the portable input into one
   provider-neutral operation and argument object for an allowlisted logical
   MCP server.
3. Core validates policy and input before emitting that request. A blocked
   effect produces no provider arguments and no tool execution.
4. Core resolves the operation through the exact selected host adapter to one
   native tool name and one provider-declared response profile. The host invokes only that resolved tool through its
   current connector, plugin, or project MCP configuration and performs
   authentication and native approval handling.
5. The host returns the result to Core. The integration translator normalizes
   it into the portable capability output, and Core validates the output and
   records only the response and output fingerprints needed for traceability.

Readiness checks use a parallel but distinct resumable probe state machine.
Core fixes the credential-reference, authority, and capability scope from the
resolved configuration. It also projects only sources explicitly marked
`probe-read`, omitting their consumer wiring, so the integration receives exact
portable inputs without learning an Automation's settings shape. The integration
chooses from a narrower safe probe-tool allowlist and returns observations rather
than a readiness verdict.
A single safe request can use the single-call contract. When readiness requires
several resources or methods, a private probe-plan checkpoint exposes one exact
host request at a time, fingerprints its semantic scope and arguments, and
requires checkpoint plus call identity on resume. Core rederives the complete
plan before accepting each response, stores only minimized step observations,
and assembles the exact-lock, expiring probe after every required step passes.
An identity result can therefore prove authentication and reachability without
being mistaken for transcript or record compatibility, and an integration
cannot hide several host calls behind one translator invocation.

This keeps provider credentials and raw host transport outside Core while
preventing Codex- or Claude-qualified tool names from becoming automation API.
The durable call records both the portable operation and resolved native tool,
so a resume cannot silently reinterpret either side of the mapping. Host
configuration proves only that a route is declared. Connected probes and
behavior evidence are still required to claim readiness or verification.

Core exposes one versioned structured model to agent tools, CLI commands,
graphical interfaces, and automation triggers. Business rules, graph
resolution, effect policy, and health calculations live in core so interfaces
cannot drift.

The operator-facing read projection is a deterministic configuration view
over one exact fresh lock. It explains selected systems, dependencies, host
choice, bindings, sources, authorities, effects, maturity, and limitations while
keeping readiness, verification, and health explicitly unknown unless separate
evidence establishes them. Terminal and graphical renderers consume that same
view contract.

Configuration drafts use the same authority path. Kernel may validate one
in-memory candidate for a named tracked template or private-active desired configuration, and Core may
resolve that validated document without writing it. The preview projection may
publish the resulting lock and graph fingerprints, but it may not construct a
candidate by editing fields on the current lock. Invalid pack settings,
dependencies, bindings, sources, authorities, host compatibility, or scenarios
therefore block an exact candidate before any apply authority exists.

Applying configuration is a separate local transaction family, not an
operational provider approval and not a capability call. Core stores the full
current and candidate `configuration/v1` documents and their exact locks only
in private runtime state, binds the exact consumer-root identity and private
file modes, projects a minimized fingerprint-only change scope,
issues an expiring request, records an exact local-operator confirmation, and
consumes that confirmation once into a durable checkpoint. Execution atomically
creates or replaces the selected desired-configuration file, writes the active lock under
ignored private `.soter/state`, resolves the written document again, and either
completes or restores the exact prior configuration and active lock. A crash is
reconciled from those observed fingerprints. First private activation is a real
absent-to-active-lock transaction even when the candidate exactly equals the
tracked template; the same candidate is a no-op after it is private-active.
Checkpoint state, phase, and failure combinations are closed so a re-sealed
crossed state cannot project false completion; prepared and terminal checkpoint
observations must also equal the exact prior or candidate fingerprints for that
state. Every checkpoint also resolves its plan, request, confirmation, and
consumption through one exact causal authority chain; a timely reserved start
may resume after expiry only while that plan is still current. Checked-in fixture locks remain
portable evidence and are never the active user lock. Deterministic host
projection candidates are part of the lock, but this transaction does not
inspect, generate, or realize consumer host files.

Realizing that active lock into native host files is another separate local
transaction. Kernel governs one projection definition per host; Core renders
exact UTF-8/LF candidate bytes from closed identifier-only context and records
their template, content, and mode fingerprints in the lock. The renderer never
uses current host output bytes as a source. Existing unmanaged files are
collisions, including any pre-existing `AGENTS.md`, `CLAUDE.md`, `.agents`,
`.codex`, `.claude`, or `.claude-plugin` output in the consumer root. V2 tracks
canonical templates and definitions, not realized host copies.

Core privately plans one exact consumer-root identity and a separate
`validUntil`, requests expiring confirmation, consumes it once into a durable
checkpoint, applies whole-file create/replace/remove effects atomically, and
writes the managed ownership manifest last. Every effect revalidates the root,
path/symlink boundary, active lock, plan window, manifest, and output state.
Checkpoint recovery may finish or reverse only exact prior/candidate states; it
cannot adopt an orphan by observation. Codex and Claude manifests may coexist,
but version 1 prohibits shared output paths. Completion proves deterministic
local projection only, leaving launch, discovery, authentication, provider
reachability, connected behavior, and health unknown.

The current reference projection realizes that rule with one Core service and
two thin interfaces: structured CLI commands and a local stdio MCP server. The
MCP server is not an integration provider and does not proxy credentials or
provider traffic. It lets a host prepare an exact logical request, execute that
request through its separately configured provider tool, and return the native
result for exact-lock validation and normalization. Codex and Claude configure
the same server rather than reimplementing policy or translation. Each launch
binds the server to its active host identity, so a Claude projection cannot
consume a lock resolved for Codex or vice versa. Graphical interfaces call this
same service boundary.

Connected Context acquisition is work-owned. Meeting Intake, Email Triage,
Task Capture, Organization Capture, Project Capture, Contact Capture, and
Project Pulse prepare from one exact private-active `prepared-work/v1` ID.
Their public prepare boundary accepts no caller-selected configuration lock,
run, mailbox query, provider snapshot, or equivalent source selector. Core
reloads the work receipt and selected-work private review, derives the current
private desired configuration and active lock, resolves the exact host, and
loads the durable run already bound to that work. Optional clock and
expected-host values are revalidation assertions, not selection authority.
Drift or any missing, substituted, or mismatched member of that chain fails
before a provider request is emitted.

The lower-level host preparation boundary follows the same ownership rule when
`configurationBasis=private-active`: a referenced run must be the exact
Core-created `0600` document under `.soter/state/runs`, already bound to the
current private configuration and lock. Generic capability and operation-plan
preparation is an internal Core primitive reached through work-owned Automation
adapters; CLI, MCP, and Studio cannot originate an arbitrary read or plan. The
public fixed provider-probe preparation route remains separate. A
repository-authored run, an arbitrary caller path, or a run copied into private
state is not adoptable authority. This provenance check is separate from
approval; successful read-oriented preparation still establishes no write,
readiness, verification, or health claim.

The local MCP process also captures one startup fingerprint over governed
definition, implementation, and projection sources, the exact private
configuration and managed manifest, and every static or collection-generated
host output byte and full required mode. The manifest must still match a
deterministic render of its exact host/configuration lock; unmanaged outputs
are never adopted. `host-runtime-inspection/v1` compares that loaded basis with
the current consumer root and reports three exact states. `current` means the
complete loaded fingerprint still matches and permits only the guidance action
`continue`. `not-realized` means a clean consumer has no managed manifest or
realized output footprint, so both fingerprints are null and the guidance action
`realize-host-runtime`, after which the host must restart. `stale` means a
startup basis or current realization is invalid or changed—including unmanaged,
missing, unsafe, byte-drifted, or mode-drifted output state. When no complete
current fingerprint exists, no automatic next action is permitted; exact repair
must happen outside this inspection boundary and `restartRequired` is null until
that repair establishes an exact basis. A complete changed fingerprint
permits only `restart-host-runtime`. A realization appearing after a null
startup basis is also stale until restart. In
either blocked state every operational MCP tool fails before creating private
state or emitting a provider request. Inspection remains usable and exposes no
credentials, provider responses, or private runtime state. These states and
actions describe runtime applicability only; they grant no readiness,
verification, health, approval, provider-call, write, or execution authority.
A process that predates this contract must be restarted once before the guard
can protect later graph changes.

This projection deliberately exposes no generic way to attach connected-write
approval. Reads and probes can cross the seam when their resolved policy allows
them. A trusted operator boundary may compile an exact connected operation
batch, persist an expiring exact-scope approval request, confirm that request as
`approval/v2`, and consume the approval once to start its one bound private
transaction checkpoint. The request, confirmation, one-time consumption, and
execution checkpoint remain distinct records. The MCP projection can recover
and advance that existing checkpoint by exact checkpoint and call IDs, but it
cannot originate, replace, widen, or reuse approval.

Operator interfaces consume a second deterministic Core read projection for
that lifecycle. `operator-inspection/v1` reports exact configuration
applicability, request and confirmation facts, one-time consumption, capability
steps, the current checkpoint call, verification criteria, reconciliation and
compensation state, and one derived resume decision. The decision names one
permitted next action and a stable reason code; it is never a reusable approval
or a generic retry flag. Raw provider responses, credentials, and private field
values are excluded. Proof and maturity remain separately unevaluated unless
their own evidence establishes them.

Human-readable decision values cross a different, selected-activity boundary.
`connected-approval-review-material/v1` is derived from the existing private
approval request; it is not another persisted request, batch, confirmation, or
authority store. Core revalidates the request, ordered change-set/batch join,
document and scope fingerprints, bound private context basis, and current lock
applicability before returning exact portable before, proposed, and
precondition values. The immutable review fingerprint excludes only derived
applicability. General operator inspection, workspace inspection, evidence,
diagnostics, fixtures, logs, and canonical artifacts cannot represent those
values. The material contains no approval, permitted action, continuation
request, host call, provider arguments, credential values, or provider
response. A trusted local interface must request one exact approval-request ID
and treat the result as a private display surface only.

Operator preparation is an earlier, deliberately separate lifecycle family.
An Automation may own a provider-neutral fixture preparation adapter alongside
its static `automation-input/v1` declaration. Core validates the declared input,
binds the explicitly selected named configuration and its current exact lock,
executes only fixture-contained reads, and stores a private `prepared-work/v1`
receipt under `.soter/state`. That receipt may move
only through `draft`, `preparing`, `needs-input`, and `ready-for-review`. It
contains normalized facts, contradictions, evidence bases, and fingerprints,
not raw private inputs or provider responses. It creates no approval,
consumption, continuation request, connected call, or provider-write authority;
crossing into the connected lifecycle requires the existing exact approval
contracts and a separately derived exact change batch. Core rejects preparation
values that resemble credentials. Later lock drift makes the stored receipt
stale and its resume classification unavailable.

Durable private review is a separate read boundary, not an expansion of the
prepared receipt. Core stores exact normalized operator values only in a
self-fingerprinted `prepared-work-review-material/v1` companion under
`.soter/state/prepared-work-review` with private file permissions. It binds the
final sanitized receipt, stable preparation checkpoint, input declaration, and
exact lock. General inspection, evidence, diagnostics, fixtures, and canonical
artifacts cannot represent those values. A trusted local interface must request
one selected work ID explicitly; Core revalidates every binding and derives
current or stale applicability before returning the material. The companion
has no fields for approval or execution authority.

Automation-derived private review uses a second, equally narrow companion.
Each Automation that produces it owns a versioned
`automation-derived-review/v1` declaration for its exact item kinds, field
order, labels, and value primitives. Kernel verifies that the declaration
belongs to the pack; Core remains domain-neutral and enforces fingerprint,
row-binding, credential, private-state, and no-authority boundaries.
`prepared-work-derived-review-material/v1` lives under
`.soter/state/prepared-work-derived-review`, binds the same receipt,
checkpoint, Automation, input-contract, configuration, and lock identities,
and is available only for one explicitly selected work ID. The sanitized
receipt exposes only closed review-collection rows, counts, reason codes,
opaque subject fingerprints, fingerprint-only proposed changes, and one
content fingerprint. Raw provider identity and prose cannot enter those rows.
The private companion may contain normalized summaries, complete draft text,
digest text, and handoff material; it contains no raw provider response or raw
message body and grants no authority. Row, collection, content, and companion
fingerprints seal distinct boundaries. Applicability remains derived and is
excluded from the immutable companion fingerprint.

An operator may narrow those validated proposals into one immutable
`review-only-candidate-selection/v1`. Core accepts only a non-empty exact subset of
actions already in `state=proposed`, restores their canonical prepared order,
and binds the receipt, checkpoint, configuration lock, preview, sanitized
source row, source action, fingerprint-only change, private context item, and
private proposed item. The create-only document under
`.soter/state/review-only-candidate-selections` contains fingerprints and codes only.
Its selected-candidate material is derived on demand as
`review-only-candidate-selection-material/v1`, may expose the exact normalized private
context and proposed values for the explicitly selected candidates, and preserves a
stable fingerprint across current-to-stale applicability changes. Neither
document is a change set, connected operation batch, approval request,
confirmation, continuation request, or execution checkpoint. Without an
Automation-owned connected compiler the selection carries
`CONNECTED_COMPILER_NOT_DECLARED`. Once one is declared, that blocker becomes
`REVIEW_ONLY_CANDIDATE_PREVIEW_NOT_CREATED`; the selection still remains `review-only`.

An Automation may declare `operator.connection` as a pack-owned implementation
module with separate compile and verification-evaluation exports. Core loads
only the exact implementation artifact fingerprinted by the selected lock,
passes it one exact private candidate selection, and validates the returned operations
against the Automation's required portable capabilities, resolved provider
pack, single authority, effects, and read-only verification capabilities. Core,
not the compiler, supplies provider and authority bindings. The resulting
`review-only-candidate-preview/v1` is create-only private state with exact provider
arguments, but remains `blocked-review-only`, `executable=false`, and
`authority=none`. It is excluded from workspace inspection and evidence and is
not a change set, approval request, continuation request, host call, or retry
permission.

Project Pulse, Meeting Intake, Task Capture, Organization Capture, Contact
Capture, Drive Filing, and Email triage all use the prepared-work and selected-work private-
review boundaries. Email triage and Task, Organization, and Contact Capture
also use the review-only candidate-selection and candidate-preview
boundaries; Project Pulse instead uses a deterministic private decision and
proposal over a required human health judgment and exact governed project-work
grammar because its document and status actions must remain one complete
group, while Meeting Intake does not currently produce either form. Project
Pulse grounds one exact policy, project, promoted-task set, and current project
document. A ready decision privately reviews the complete milestone replacement
and status record, then compiles document-update first and status-create last
through the same v2 approval, one-time start, checkpoint, and verification
authority. Partial selection fails closed. The two provider writes are ordered
and verified, not externally atomic; ambiguity or later-effect failure pauses
for manual reconciliation and never retries a write automatically. Meeting
Intake grounds the exact contained transcript,
configured policy sources, matching meeting, organizations, and exact
relationship candidates, then stops before participant identity resolution or
cited follow-up judgment. Task Capture loads one machine-readable policy,
resolves one exact project, and performs one bounded title-deduplication read.
It keeps the title and optional calendar date in private review material and
projects only an after-fingerprint for a possible create. A context conflict or
duplicate candidate holds that action so it cannot enter a candidate selection. An
exact non-conflicting action can be selected into one immutable private candidate
selection and compiled by Task Capture into a deduplicated `tasks.records.create`
candidate with a `tasks.records.read` absence precondition and verification. The preview
remains `blocked-review-only`, contains no transaction batch, approval,
continuation, or execution authority, and performs no provider call. None of
these adapters creates connected approval or execution authority.

Task Capture also owns a distinct durable decision and proposal path over the
same exact prepared-input basis. Connected acquisition validates the selected
policy identity, exact project, optional authenticated current-user identity,
and bounded duplicates before a private decision may become `ready`. The
deterministic proposal can enter Core's generic `connected-change-set/v2` and
`connected-operation-batch/v2` compiler boundary. Only an expiring exact-scope
request, exact confirmation, and single-use approval consumption create one
private `connected-transaction-checkpoint/v2`. That checkpoint performs the
duplicate-absence precondition, one create, and mandatory read-after-write
verification. The authority-free candidate preview is never upgraded or reused as
that transaction source.

Organization Capture and Contact Capture use the same durable decision,
proposal, candidate-selection, approval-v2, single-use start, and connected-
checkpoint families. Organization Capture intersects deterministic Context
classification with the current normalized Organization schema, keeps sector
meaning in Tags, and checks bounded aliases before create. Contact Capture
observes current Role, Status, Disposition, Authority, and Tag options; accepts
only exact case-insensitive matches; omits and flags unmatched optional values;
and never promotes vague supportive language to `Champion`. A requested
organization must resolve to one exact existing resource or remain empty and
flagged. Exact email-or-name candidates block the create. Both compilers emit
one same-authority duplicate-absence precondition, one normalized create, and
mandatory read-after-write verification. Preparation and private proposal
material contain no approval, continuation, host-call, or write authority.

Email triage adds one bounded private mailbox query and a deterministic
reduction over provider-neutral mail facts. It excludes self-sent-only work,
deduplicates by RFC822 message identity, ignores archived or trash sibling
messages, and skips work only when every active inbox message already carries
`AI/Triaged`; any active untriaged message retains the thread. This rule does
not depend on a provider label-application timestamp. Every
thread returned by the provider must be represented or counted under one
explicit exclusion; an inactive/trash-only provider return cannot disappear
from coverage.
Context mechanically distinguishes provider message IDs, provider thread IDs,
and RFC822 message IDs. Label actions target provider message IDs, consume
configured label names rather than provider label IDs, and prohibit implicit
label creation. Integration translates those meanings; Automation cannot
silently substitute one identity kind for another.
Provider `IMPORTANT` never classifies mail. Suspected instruction injection is
kept visible and cannot issue actions. The sanitized review itemizes needs-you
and high-stakes work, collapses machine notification counts, and carries
provider-neutral meeting-notes, calendar-RSVP, task-review, and record-update
handoff intents with exact normalized payload fields. Context owns those
intents; the Automation maps them into review actions without naming an upward
Automation dependency. Selected-work private review
contains normalized summaries, complete proposed draft and digest text, and
AI-only label values. Preparation executes one contained read and no writes.
Sending is not declared as a capability. Email can bind any non-empty exact
subset of its validated label and draft proposals into the generic immutable
review-only candidate-selection boundary. Its pack-owned compiler expands that exact
subset into portable `mail.labels.apply` and `mail.drafts.create` operations.
Label operations bind the exact active message IDs represented by the selected
review row, exact existing AI/ label names, and `createMissingLabels=false`;
they do not confuse provider message IDs, thread IDs, RFC822 IDs, or label
display names with provider label IDs. Draft operations bind the exact reply
message ID and a deterministic idempotency key. Every operation carries a
same-provider and same-authority read-back through `mail.labels.read` or
`mail.drafts.list`, retry-prohibited ambiguity handling, and manual recovery
when no inverse capability exists. Contained fixture evaluation proves the
normalized comparison.

Codex declares Gmail connector routes for exact label apply and message
read-back, plus bounded message-ID search and exact thread expansion. Connected
normalization is bound to the closed `gmail.codex.connector.v1` response
profile; alternate result envelopes, aliases, inferred pagination state, and
extra provider fields fail closed rather than becoming compatibility behavior.
Claude intentionally has no Gmail response profile or route in this baseline.
Connected
acquisition uses the existing Core `operation-plan/v2` service: one private
query produces a bounded unique provider-message set and explicit pagination
completeness, then a typed binding passes exactly those IDs into a bounded
thread read. Finalization rejects incomplete pagination, missing or duplicate
requested messages, missing RFC822 identities, stale locks, provider drift, or
bounds violations. It stores only normalized transport facts in a private
Context snapshot and pauses the durable run before Automation judgment.
Integration never emits reply need, importance, injection, handoff, draft, or
proposed-action judgment.

After finalization, the Email Automation can inspect the exact private snapshot
through a pack-owned decision workspace. The shared reducer enumerates every
included candidate and all four exclusion counts before any host judgment.
`automation.email-triage` owns the closed decision payload: exact candidate,
thread, active-message, newest-message, and source fingerprints; one resolved
bucket and attention state; explicit `IMPORTANT` non-authority; suspected-
injection disposition; reply or portable handoff intent; and exact bounded
subject/body citations. A `ready` decision must cover every and only the
deterministic candidate set. Suspected instruction injection is forced into an
operator-held high-stakes, human-review state with no reply or handoff action.
When evidence or classification is incomplete, the only valid result is
`needs-input` with explicit issues.

Core persists this through the existing provider-neutral
`automation-decision/v1` service. The decision and snapshot remain private
runtime state, while workspace inspection, evidence, diagnostics, fixtures,
and general renderer state exclude their content. Committing the decision
keeps the run paused and creates no prepared-work preview, draft, proposed
change, approval, continuation request, provider call, or write. It proves
exact binding and abstention behavior, not connected judgment quality.

A ready Email decision may next enter a distinct review-only proposal boundary.
This is not a second prepared-work run and it is not a transaction family.
`automation.email-triage` declares `operator.proposal`: a pack-owned builder,
input schema, proposal schema, and derived-review declaration. Kernel verifies
their ownership; Core loads only the exact artifacts fingerprinted by the
current lock. The builder must deterministically cover every decision candidate,
require complete draft/task/update values exactly when the decision calls for
them, and bind one complete digest. Suspected instruction injection produces a
held row and no proposed external action.

Core stores a sanitized `automation-proposal/v1` plus a separate selected-private
`automation-proposal-material/v1`. The sanitized proposal carries only exact
decision, lock, graph, collection, row, action, coverage, and value fingerprints.
The private companion carries the complete normalized thread detail, AI label,
draft, digest, and handoff values under `0700` directories and `0600` files.
Core validates the generic review invariants and exact private joins; Email
reconstructs the pack-owned proposal from the private companion on every read.
Workspace inspection, evidence, diagnostics, fixtures, and general renderer
state exclude both runtime documents. Exact replay is idempotent, while a
partial pair, changed value, stale lock, malformed document, credential-like
value, or fingerprint mismatch fails closed. The proposal is registered on the
same paused run without changing approvals or effects.

Neither proposal document contains an approval request, confirmation, one-time
start, continuation request, host call, provider response, or execution
permission. A trusted local operator may next select any non-empty exact subset
of proposed label or draft action IDs. Core revalidates the proposal and its
private companion, restores canonical order, and asks the exact locked
Automation compiler to produce one operation per selected action. Core then
validates the portable write input, resolved single authority, connected
provider, same-provider read-only precondition and verification, private review
fingerprints, no-retry ambiguity rule, and manual-recovery boundary. The result
is `connected-change-set/v2` plus `connected-operation-batch/v2` with
`profile=verified-write-sequence`. It is still an authority-free preview until
the existing expiring `approval-request/v1` is separately created and exactly
confirmed as `approval/v2`.

The request's private `connected-approval-review-material/v1` projects only the
selected operations and binds their exact before requirement, proposed private
value, precondition, verification, change-set, batch, request, lock, and run
fingerprints. Confirmation re-runs the Automation compiler against the current
proposal companion and lock, so a changed subset, proposal value, compiler,
provider route, or lock requires a new request. Email does not introduce a new
approval or bearer-token family.

The declared label provider maps one label operation to
`apply_labels_to_emails` with missing-label creation prohibited and verifies it
through `batch_read_email`; native bodies and responses are minimized away.
Search and thread normalizers likewise strip raw native responses, account
identity, and pagination cursors; normalized bodies remain private Context
state. This is static and synthetic translator conformance, not authentication,
permission, readiness, connected verification, or health evidence. The
installed draft connector has no exact idempotency-key lookup, so draft
creation remains deliberately undeclared as a connected provider. A draft or
mixed selection therefore fails before an approval request can exist. A
label-only selection can enter the existing approval-v2 and one-time
consumption lifecycle. Its private `connected-transaction-checkpoint/v2`
retains the same checkpoint family while using the pack-compiled
`verified-write-sequence` profile: optional read-only precondition, one exact
write, mandatory read-after-write verification, then the next selected
operation. Write or verification ambiguity is never retried; Core may emit one
separately checkpointed read-only reconciliation request and accepts only an
Automation-evaluated exact expected state. No compensation or label removal is
invented. Synthetic local tests prove this lifecycle and raw-response
minimization, but do not establish Gmail authentication, permission, live
writes, readiness, verification, or health.

Before returning a requested call, the current MCP projection atomically writes
a private, self-fingerprinted checkpoint and updates a private durable copy of
the run envelope under `.soter/state`. A restarted host can list pending calls,
rehydrate one by checkpoint ID, and complete or fail it without reconstructing
the request from conversational memory. Completion stores the normalized
result in private state, records only fingerprints in the run envelope, and
never persists the native provider response. One outstanding capability, plan,
or transaction call per run prevents ambiguous concurrent resume. Connected
transactions expose explicit precondition, write, verification, and read-only
reconciliation calls. Operations run in their exact approved order, and
terminal creates remain last when an Automation declares that ordering. Every
write requires its declared read-back verification. An unknown write or
verification outcome is never represented as rollback: the checkpoint enters
`needs-attention` because external systems do not provide an ACID transaction
boundary. Reconciliation emits only the exact declared verification read. An
expected-state observation can complete the operation and resume the remaining
sequence; an unexpected or unavailable observation remains paused for manual
recovery. V2 never replays an ambiguous write, invents an inverse, or claims
compensation.

The stdio self-test terminates and restarts the server between preparation and
completion, repairs planted partial cross-file updates, rejects stale and
tampered state, and proves response minimization. This establishes local Core
recovery behavior, not that Codex or Claude actually selected and executed the
provider tool in a real task.

### Verification

Verification progresses from static and graph validation through fixtures,
agent scenario trials, contained integration checks, live canaries, and runtime
monitoring. Every claim points to evidence tied to the exact relevant
configuration, host, integration, authority, evaluator, and transitive
dependency fingerprints.

Passed, failed, stale, unknown, skipped, and not-applicable results remain
distinct. Dependency changes invalidate only the affected evidence. Doctor
operations provide offline, connected, and canary levels without representing
checks that did not run as green.

## Evolution and completion

Soter evolves one complete, useful behavior at a time. Each change keeps one
canonical authority, carries exact dependency and evidence fingerprints, and
makes unavailable behavior explicit rather than routing through an undeclared
fallback.

### Change method

- Change a vertical slice across Context, Automation, Integration, Core, host
  realization, and evidence only where the behavior requires it.
- Compare current and proposed behavior with fixtures, isolated agent trials,
  contained integration checks, or bounded canaries appropriate to the effect.
- Preserve prior locks, manifests, external identifiers, and checkpoint state
  needed for safe rollback or read-only reconciliation.
- Delete redundant paths once the current contract and evidence own the
  behavior; generated host outputs never become canonical definitions.
- Keep provider, approval, execution, publication, and protected-root authority
  separate from review or development guidance.

### Change unit and completion gate

A change states:

- The user-visible behavior being preserved or intentionally changed.
- The current canonical authority and affected graph.
- The contracts, dependencies, and evidence invalidated by the change.
- The verification levels exercised and the limitations still present.
- The deployment, monitoring, rollback, and recovery boundaries.

A change is complete only when implementation, authority, exact evidence, and
the intended behavior agree. `valid=passed` does not promote readiness,
connected verification, or health; those remain unknown until their own
evidence exists. Creating a file without connecting and verifying its behavior
does not count as completion.

### Change rationale

Soter has no dedicated decision archive, global numbering scheme, or separate
decision ceremony. Rationale belongs beside the authority it explains: in
architecture, contracts, tests, governed development evidence, and Git change
history. A rare cross-cutting choice records constraints and tradeoffs in the
affected canonical artifact or its governed change evidence. Rationale never
substitutes for executable contracts, authority, or evidence.

### Baseline acceptance

The architecture is sustainable when a user can:

- Understand why the required Kernel and Core are present.
- Select, remove, and replace Context, Automation, and Integration packs through
  an explicit configuration with a resolved lock.
- Inspect dependency, authority, capability, effect, and evidence relationships
  without reading implementation history.
- Run a representative Automation through Claude and Codex with equivalent
  declared outcomes and honest capability-gap reporting.
- Replace an Integration implementation without rewriting its Automation.
- Resume interrupted work from a durable checkpoint.
- Distinguish valid, ready, verified, healthy, degraded, stale, and unknown.
- Materialize a governed local pack without granting network, publication, or
  provider authority.
- Turn an observed divergence into a contained candidate, evaluate it, promote
  it under policy, and roll it back if evidence regresses.

Meeting these conditions establishes a base for adding systems without returning
to guesswork; it does not imply that every host, provider, or Automation is live
or healthy.
