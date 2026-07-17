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
12. **Migrate through working vertical slices.** Preserve useful behavior,
    replace one boundary at a time, compare outcomes, and retire compatibility
    bridges when their evidence supports removal.

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
preview contract, permission, migration, projection, and verification changes
and preserve a rollback path where the effects allow one.

Kernel now provides the contained distribution foundation below this future
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
   native tool name. The host invokes only that resolved tool through its
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
A single safe request can use the legacy call contract. When readiness requires
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

The first operator-facing read projection is a deterministic configuration view
over one exact fresh lock. It explains selected systems, dependencies, host
choice, bindings, sources, authorities, effects, maturity, and limitations while
keeping readiness, verification, and health explicitly unknown unless separate
evidence establishes them. Terminal and graphical renderers consume that same
view contract.

Configuration drafts use the same authority path. Kernel may validate one
in-memory replacement for an existing desired configuration, and Core may
resolve that validated document without writing it. The preview projection may
publish the resulting lock and graph fingerprints, but it may not construct a
candidate by editing fields on the current lock. Invalid pack settings,
dependencies, bindings, sources, authorities, host compatibility, scenarios, or
migrations therefore block an exact candidate before any apply authority exists.

Applying configuration is a separate local transaction family, not an
operational provider approval and not a capability call. Core stores the full
current and candidate `configuration/v1` documents and their exact locks only
in private runtime state, projects a minimized fingerprint-only change scope,
issues an expiring request, records an exact local-operator confirmation, and
consumes that confirmation once into a durable checkpoint. Execution atomically
replaces the selected desired-configuration file, writes the active lock under
ignored private `.soter/state`, resolves the written document again, and either
completes or restores the exact prior configuration and active lock. A crash is
reconciled from those observed fingerprints. Checked-in fixture locks remain
portable evidence and are never the active user lock. Deterministic host
projection candidates are part of the lock, but this transaction does not
inspect, generate, or realize consumer host files.

Realizing that active lock into native host files is another separate local
transaction. Kernel governs one projection definition per host; Core renders
exact UTF-8/LF candidate bytes from closed identifier-only context and records
their template, content, and mode fingerprints in the lock. The renderer never
uses current host output bytes as a source. Existing unmanaged files are
collisions, including this repository's development `AGENTS.md`, `CLAUDE.md`,
and legacy `.claude` tree.

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
consume a lock resolved for Codex or vice versa. A later UI must call this same
service boundary as well.

The local MCP process also captures one startup fingerprint over governed
definition, implementation, and projection artifacts plus the selected host
adapter and its declared host projections. `host-runtime-inspection/v1`
compares that loaded basis with the current repository. When they differ, the
inspection reports `SOTER_HOST_RUNTIME_STALE`, requires a host-runtime restart,
and every operational MCP tool fails before creating private state or emitting
a provider request. The inspection remains usable while stale and exposes no
credentials, provider responses, or private runtime state. It is runtime
applicability, not readiness, verification, health, approval, or execution
authority. A process that predates this contract must be restarted once before
the guard can protect later graph changes.

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
values are excluded. Proof, maturity, and migration remain separately
unevaluated unless their own evidence families establish them.

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
values that resemble credentials. Later lock drift makes the historical receipt
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
`prepared-review-batch/v1`. Core accepts only a non-empty exact subset of
actions already in `state=proposed`, restores their canonical prepared order,
and binds the receipt, checkpoint, configuration lock, preview, sanitized
source row, source action, fingerprint-only change, private context item, and
private proposed item. The create-only document under
`.soter/state/prepared-review-batches` contains fingerprints and codes only.
Its selected-batch material is derived on demand as
`prepared-review-batch-material/v1`, may expose the exact normalized private
context and proposed values for the explicitly selected batch, and preserves a
stable fingerprint across current-to-stale applicability changes. Neither
document is a change set, connected operation batch, approval request,
confirmation, continuation request, or execution checkpoint. Without an
Automation-owned connected compiler the batch carries
`CONNECTED_COMPILER_NOT_DECLARED`. Once one is declared, that blocker becomes
`CONNECTED_PLAN_NOT_COMPILED`; the batch still remains `review-only`.

An Automation may declare `operator.connection` as a pack-owned implementation
module with separate compile and verification-evaluation exports. Core loads
only the exact implementation artifact fingerprinted by the selected lock,
passes it one exact private review batch, and validates the returned operations
against the Automation's required portable capabilities, resolved provider
pack, single authority, effects, and read-only verification capabilities. Core,
not the compiler, supplies provider and authority bindings. The resulting
`prepared-connected-plan/v1` is create-only private state with exact provider
arguments, but remains `blocked-review-only`, `executable=false`, and
`authority=none`. It is excluded from workspace inspection and evidence and is
not a change set, approval request, continuation request, host call, or retry
permission.

Project Pulse, Meeting Intake, Task Capture, and Email triage all use the
prepared-work and selected-work private-review boundaries. Email triage also
uses the prepared review-batch boundary; the other three do not currently
produce one. Project Pulse retains read-only normalized status facts and
contradictions with no proposed changes. Meeting Intake grounds the exact contained transcript,
configured policy sources, matching meeting, organizations, and exact
relationship candidates, then stops before participant identity resolution or
cited follow-up judgment. Task Capture loads one machine-readable policy,
resolves one exact project, and performs one bounded title-deduplication read.
It keeps the title and optional calendar date in private review material and
projects only an after-fingerprint for a possible create. A context conflict or
duplicate candidate removes that proposal. None of these adapters creates
connected approval or execution authority.

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
prepared review-batch boundary. Its pack-owned compiler expands that exact
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

Codex now declares Gmail connector routes for exact label apply and message
read-back, plus bounded message-ID search and exact thread expansion. Connected
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
transactions expose explicit compare, write, and verify calls. Reversible
updates run first; at most one deduplicated create may run last, after which Core
verifies its mapped record fields and exact document content through separate
reads. If a later pre-create operation conflicts, or a terminal create is proved
absent after an ambiguous response, Core restores verified earlier updates in
reverse order and verifies each restoration. An unknown write outcome is not
represented as rollback: the checkpoint enters `needs-attention` for
reconciliation because external systems do not provide an ACID transaction
boundary. Reconciliation emits only an exact record or document-content read.
Approved state can resume the batch, prior or absent state can close or continue
rollback where safe, and missing, divergent, failed-read, or unproven
compensation state remains paused. It never replays the ambiguous write or
invents a delete compensation route.

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

## Evolution from the current harness

The existing repository is a useful working prototype and a source of observed
behavior. It is not required to be the final directory structure, vocabulary,
package format, or runtime. Soter evolves it through contained vertical slices
rather than discarding working mechanisms or pretending the target architecture
already exists.

### Starting-point assessment

The repository already demonstrates several strong foundations:

- Systems and artifacts carry explicit classification metadata.
- Molds, standards, and a shared checker make important shape and safety rules
  mechanical.
- Checker self-tests plant failures and prove that diagnostics fire.
- Human-gated changes, isolated worktrees, and scoped staging reduce unsafe
  concurrent edits.
- External writes use deliberate confirmation and fetch-merge-write discipline.
- Live schemas are treated as authorities rather than inferred from one example.
- Observed failures can become evaluations and durable corrections.

Those mechanisms remain evidence for the target architecture. They are retained
until a replacement proves the same or stronger contract.

The repository also exposes the gaps this architecture is meant to close:

| Area | Starting point | Required evolution |
|---|---|---|
| **Layers** | Kernel, core, context, and automation classify artifacts, while provider behavior is mixed into guides and configuration. | Add the integration layer and enforce its boundary through capability contracts. |
| **Kernel** | Strong design-time governance and one checker. | Govern system contracts, graph resolution, evidence, packaging, and migrations without becoming the operational runtime. |
| **Core** | A small policy capability rather than a complete runtime foundation. | Add configuration resolution, context assembly, effect policy, run envelopes, evidence, health, and interface services. |
| **Context** | Useful domain systems and external authority knowledge exist, but authority and editing behavior are often encoded in prose. | Declare context, authority roles, freshness, and change contracts mechanically. |
| **Automation** | Guides orchestrate useful real work, often with direct provider details and mutable template assumptions. | Separate outcomes and capability requirements from provider choreography. |
| **Integration** | MCP servers, plugins, targets, and service-specific instructions are implicit implementation dependencies. | Promote providers into selectable integration packs with typed capabilities, effects, errors, and health. |
| **Hosts** | Claude project and plugin structures are the effective delivery model. | Make provider-neutral definitions canonical and realize them through tested Claude and Codex adapters. |
| **Evaluation** | Static checks are strong; scenario cases and golden freshness are mostly manual and direct-dependency based. | Add executable scenarios, multiple trials, durable evidence, and transitive invalidation. |
| **Configuration** | Installed behavior is inferred from repository contents and host-specific files. | Add explicit desired configuration, resolution, locks, bindings, and generated projections. |
| **Distribution** | Kernel can build and independently verify deterministic, content-addressed local pack capsules and transparent bundles without private state, legal assertions, or effect authority. Core separately installs or upgrades already-local verified releases through an exact checkpointed transaction. | Add parameterized shareable configuration templates and later network acquisition, uninstall, trust, or publication only through separate governed decisions. |

“Built” or “sealed” is not an architectural status. Existing systems may be
useful and green under current checks while still lacking target contracts,
portable delivery, executable evidence, or recent health.

### Migration principles

Migration follows these rules:

- **Keep working behavior available.** A current automation remains usable until
  its replacement passes equivalent outcome and effect verification.
- **One authority at a time.** Every migrated definition declares whether the
  legacy file or the new provider-neutral source is canonical. Two writable
  authorities are never left to drift.
- **Bridge explicitly.** Compatibility readers, generated projections, aliases,
  and temporary mappings have owners, diagnostics, and retirement criteria.
- **Migrate vertical behavior.** Move one useful outcome through context,
  automation, integration, host realization, evidence, and health instead of
  reorganizing every file by layer first.
- **Compare before switching.** Use fixtures, shadow runs, or contained canaries
  to compare old and new behavior where the effects allow it.
- **Preserve rollback.** Record the prior lock, authority mapping, generated
  projection, and external migration consequences before switching.
- **Remove proven redundancy.** After a bridge's dependents migrate and its
  retirement checks pass, delete the duplicate path rather than preserving it
  indefinitely for comfort.

The current `.claude/` tree may remain a temporary source while contracts are
mapped. Once a provider-neutral definition becomes canonical, Claude files
become generated or adapter-owned projections. Codex projections are generated
from the same resolved lock. A mass directory move before that boundary exists
would change paths without fixing the architecture.

### Migration manifest

A machine-readable migration manifest tracks each existing system and artifact
through these states:

- **Current:** still authoritative for the working harness.
- **Mapped:** assigned a target system, layer, contract, and authority without
  changing runtime behavior.
- **Bridged:** usable through both legacy delivery and the new runtime, with one
  declared canonical source.
- **Migrated:** realized from the target contracts with applicable evidence and
  health reporting.
- **Retired:** no configured behavior depends on the legacy artifact or bridge.

Each entry identifies the old location, target identifier, authority status,
dependents, compatibility bridge, verification claims, rollback path, and
retirement criteria. The manifest replaces memory and historical narrative as
the answer to “has this piece migrated?”

### Delivery sequence

The implementation sequence is:

1. **Accept the architecture and preserve a baseline.** Resolve known written
   contradictions, record current behavior and checks, and stop describing the
   kernel as complete or sealed.
2. **Introduce the minimum contract substrate.** Define stable identifiers,
   system manifests, dependency and capability edges, authority roles, effect
   declarations, configuration schema, and the migration manifest. Map current
   artifacts before moving them.
3. **Prove one end-to-end vertical slice.** Select a current automation that
   exercises context, at least two integrations, an external effect, a human or
   policy gate, and outcome verification. Meeting intake is the selected first
   slice; its declared pack graph and migration mapping live under
   [soter/](./soter/). Its contained Core context path is now implemented
   through typed fixture providers without claiming automation execution or
   connected provider readiness.
4. **Build the minimum core runtime around that slice.** Resolve its
   configuration, assemble its run envelope and context, bind capabilities,
   apply effect policy, record evidence, and report health.
5. **Separate provider integrations.** Extract provider choreography from the
   automation into capability contracts and integration packs while retaining a
   compatibility binding for the current workflow.
6. **Realize both initial hosts.** Treat the working Claude behavior as a
   reference, then prove equivalent declared behavior through a Codex adapter.
   Test each from an otherwise empty consumer configuration.
7. **Make verification executable.** Add contract fixtures, headless scenario
   trials, transitive invalidation, connected smoke checks, doctor operations,
   and CI evidence for the vertical slice.
8. **Add user configuration and distribution flows.** The contained pack-release,
   transparent-bundle, and exact already-local install/upgrade transactions are
   implemented. Parameterized shareable templates, network acquisition,
   uninstall, and any public/trust mechanism remain separate later milestones.
9. **Expose the shared interfaces.** Build CLI and graphical experiences over
   the same core model, beginning with configuration, graph, run, evidence, and
   health views.
10. **Migrate remaining systems incrementally.** Prioritize frequently used or
    drift-prone systems, retire bridges after proof, and use observations to
    improve the contracts and tools.

The sequence establishes structured APIs for UI and distribution early, but
does not wait for a polished interface or public registry before proving the
runtime and contract boundaries.

The current checkpoint has completed the contract substrate and the declared
meeting-intake graph. Step 4 is partially implemented through deterministic
resolution, artifact-fingerprinted locks, effect-free preflight, typed fixture
capability dispatch, authority-aware context snapshots, exact-scope approvals,
transactional fixture writes, rollback proof, read-after-write verification,
claim-scoped evidence, an offline doctor, contract-enforced aggregation of
short-lived connected provider probes, explicit sequential provider-probe plans,
typed expiring summaries for exact failed provider-probe attempts,
and private durable checkpoints for host-dispatched calls and their run
envelopes. `context.crm` now owns a machine-readable portable record model rather
than leaving domain shapes implicit in the Notion mapping or fixture data.
Kernel checks model ownership, Context-valid Automation inputs, and the subset
and value shapes implemented by each typed Integration mapping; Core applies the
same input and normalized-output validation at runtime. Core now also has versioned
sequential operation-plan contracts: v1 retains fixed inputs, while v2 binds
typed string-list references from earlier normalized outputs into later inputs.
The private checkpoint emits one exact policy-bound call at a time, fingerprints
each resolution, skips empty reference chains without a provider request,
requires both checkpoint and current-call identity on resume, and recovers the
next step after restart without retaining native provider responses.
Meeting-intake Automation uses that same Core service to prepare a bounded
connected grounding plan: policy index, every policy page explicitly wired to
the Automation as an `applicable-policy` portable source, exact transcript,
exactly one CRM meeting matched by recording URI, and only the organizations,
projects, and tasks referenced through that meeting. The index and page reads
must agree on each configured policy's exact URI and title. Automation records the governed
subjects and applicability reason for every bounded body, validates domain
completeness, and rejects a related read that omits or adds an ID; Core binds
every snapshot entry to an exact normalized plan output and passed effect,
persists the private snapshot, marks the definition authority loaded, updates
the same durable run, and pauses before writes. Policy prose is grounded context,
not executable rules: content interpretation and enforcement remain a host
judgment boundary. Participant People IDs are not treated as CRM contact page
URIs.

Email uses the same bound plan service for a two-step transport-only connected
acquisition: exact bounded message search followed by thread expansion over
only the bound message IDs. It requires complete pagination and exact
requested-message coverage, persists normalized private Context state, and
pauses before triage judgment, drafts, approval, or writes. A separate pack-
owned private decision workspace can then bind grounded classification to
every deterministic reduced candidate while continuing to pause before drafts,
prepared changes, approval, continuation, or writes. The installed
connector response shape and RFC822 header availability have synthetic
normalizer proof only, so connected readiness and health remain unknown.

The current target includes the
first connected Otter provider mapping, exact transcript-fetch request
translation, and identity-only probe producer. It also includes a connected
Notion provider whose bounded reads and gated mapped-write translators,
pack-owned settings, typed provider field mapping,
bounded one-target query translator, normalized record versions, and exact
per-host native tool mappings are mechanically checked. The one-target boundary
avoids depending on plan-gated cross-data-source SQL; multi-target reads can be
explicit ordered capability steps, and the initial connected context boundary
now exercises that orchestration without broad reads across every CRM target.
Notion readiness is a separate 20-step private plan: identity, schema and one-row
bounded read checks for all eight mapped record types, then an exact identity- and
title-bound read for each of the three configured `probe-read` policy sources.
Schema checks bind every portable field to its current provider property name
and type; record and document checks discard row values and policy bodies before
persisting only minimized counts, booleans, and fingerprints. The completed
probe can establish exact-lock `crm.records.read` and `documents.content.read`
compatibility, but not policy interpretation. The checked mapping now names the
observed `🫂 Contacts` organization relation, but that development observation
is not reusable connected evidence: another exact lock must run its own expiring
probe. Otter's
identity-only probe deliberately leaves transcript compatibility unknown, and
all unobserved response shapes fail closed.
When a host cannot execute an exact probe route, Core preserves the private
failed checkpoint and exposes only a typed, expiring attempt summary to the
connected doctor. This distinguishes authentication, authorization, route
availability, and response-conformance failures from a probe that was never
attempted without persisting arguments, raw responses, or error messages. A
declared host tool mapping still does not establish that the active execution
bridge exposes the tool.
Connected readiness still fails because no current private probes are checked
in and Notion write permissions or response conformance are unproven. Notion
create and update translation is now declared only for explicitly mapped
fields and record-level capabilities through the exact Context model. The
current Notion mapping reads every mapped CRM type, updates tasks, and creates
tasks or meeting summaries. Task Capture is the first slice to exercise a
portable calendar-date field and provider-scoped person identity on a task.
Context owns `nextActionOn` as a real `YYYY-MM-DD` calendar date and
`assigneeIds` as exact provider-person identities. The Notion Integration alone
owns translation to expanded date columns and the person property. Its selected
policy-row mapping identifies the external Tasks definition by name but cannot
yet normalize the page body into trusted structured facts. Fixture preparation
can therefore prove deterministic policy handling, while connected preparation
remains unavailable until a trusted definition projection and connected
identity/write evidence exist. The contained meeting-intake proposal
now uses those portable fields: its summary is deduplicated and attributed by
the canonical recording link, while the existing overlapping task receives a
bounded Context classification. Proposal construction and acceptance checks now
live with meeting-intake Automation; Core retains only generic approval,
transaction, rollback, and verifier invocation mechanics. The contained
path now creates an `automation-decision/v1` governed by an Automation-owned
meeting-intake schema before it creates a proposal. The decision binds the
exact run, lock, graph, context snapshot, meeting record, transcript entry and
segments, every bounded task candidate, every explicitly applicable policy
entry, exact cited policy excerpts, producer, issues, limitations, and its own
fingerprint. A `ready` decision must resolve every candidate, fold exactly one
grounded task, cite an allow outcome for every connected policy, and contain no
issues. A `needs-input` decision records abstention and cannot produce a change
set. Core stores connected decisions as private runtime state, registers the
fingerprint on the same paused run, rejects a competing decision for that
snapshot, and lets Automation project only a ready decision into a change set
that carries the exact decision and snapshot basis. Core can compile that
proposal into an exact connected operation batch with deduplication or expected-version preconditions,
verification expectations, recovery modes, and a separate expiring approval
fingerprint. The resulting batch is executable only in its constrained order:
all compensatable updates precede one deduplicated terminal create. The compiler
requires a same-provider content-read route for the summary body and the preview
CLI executes no provider calls. Durable mapped updates and the terminal create
use a private `connected-transaction-checkpoint/v1`. Core
validates the exact approval before the first write, captures compared prior
mapped fields, verifies each applied patch, captures the created record identity,
then verifies the created fields and exact page body. It compensates verified
updates in reverse after a later conflict or a create proved absent, and recovers
the exact current host call after restart. It preflights every operation and
recovery route before the first effect so an invalid tail cannot strand earlier
changes. The CLI alone
originates the authorized checkpoint; MCP only advances it or requests a
checkpoint-bound read-only reconciliation. Reconciliation histories classify
approved fields, approved content, prior fields, absence, missing, divergence,
and failed reads and resume only when normalized evidence proves a safe
transition. Synthetic local tests prove this Core state machine, not connected
credentials, provider write conformance, or a live end-to-end write. Observed Otter
transcript conformance, host-started end-to-end dispatch, policy interpretation
quality and enforcement, participant identity resolution, validation of
terminal-create consistency assumptions, live approval-bound provider writes,
live health, judgment-quality evaluation, and host conformance remain future
proof boundaries. The v2 plan contract is intentionally narrower than a
general workflow language: arbitrary transforms, branching, parallelism,
fan-out, retries, and compensation are not implemented.

### Change unit and completion gate

Each migration change states:

- The user-visible behavior being preserved or intentionally changed.
- The current and target authorities.
- The affected graph and evidence invalidation set.
- The new or changed contracts and compatibility bridge.
- The verification ladder levels exercised.
- The rollout, monitoring, rollback, and retirement conditions.

A migration unit is complete only when the target behavior is valid, ready,
verified, and—where real use exists—has an explicit health state. Passing the
legacy checker alone does not complete a target migration, and creating a new
file without switching authority does not count as progress.

### Decision history

Existing ADRs remain a historical archive. They are not a runtime dependency,
a required README section, or mandatory ceremony for ordinary development.
The architecture, contracts, tests, migration manifest, and change history
should normally contain the rationale needed to continue the work.

A lightweight decision note is reserved for a rare cross-cutting choice that
changes a public contract, security or authority boundary, compatibility
promise, or expensive-to-reverse direction and whose rationale cannot live
clearly beside the affected architecture. Such notes explain constraints; they
do not substitute for executable contracts or evidence.

### Target migration proof

The migration has established the new foundation when a user can:

- Start from the required kernel and core and understand why each base system
  is present.
- Select, remove, and replace context, automation, and integration packs through
  an explicit configuration with a resolved lock.
- Inspect the full dependency, authority, capability, effect, and evidence
  graph without reading implementation history.
- Run a representative automation through both Claude and Codex with equivalent
  declared outcomes and honest capability-gap reporting.
- Replace one integration with another implementation of the same capability
  without rewriting the automation.
- Resume a run after compaction or restart from its envelope.
- Receive precise valid, ready, verified, healthy, degraded, stale, and unknown
  reporting through the same CLI and graphical data model.
- Install a shared pack or configuration into an otherwise empty consumer and
  reproduce its declared verification evidence.
- Observe a divergence, create a contained improvement candidate, evaluate it,
  promote it under policy, and roll it back if runtime evidence regresses.

Reaching this proof does not finish Soter. It establishes a sustainable base on
which new systems can be added without returning to guesswork.
