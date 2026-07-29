# Soter contracts

This document defines the normative contracts that implement the architecture
described in [ARCHITECTURE.md](./ARCHITECTURE.md). The architecture owns purpose,
layer meaning, and migration direction; this document owns the detailed
mechanics that Soter must validate and preserve across implementations.

## Contracts and connections

Soter is a connected system, not a collection of instruction files. Every
installed system must explain what it is for, what it requires, what it makes
available, how it can affect the world, and how anyone can verify that it
works. These declarations form a graph that the kernel can inspect before an
agent or automation relies on it.

### Layer connection rules

The five-layer order does not allow arbitrary coupling. Kernel and core cannot
depend on a particular domain, automation, provider, or agent host. Context
cannot depend on an automation or provider implementation. An automation may
consume context and request integration capabilities, but it cannot require a
particular vendor when a portable capability can express the need. An
integration implements capability contracts; it does not contain
automation-specific business logic.

Pack dependency edges follow these mechanical boundaries:

| Source layer | May depend on |
|---|---|
| Kernel | Kernel |
| Core | Kernel, core |
| Context | Kernel, core, context |
| Automation | Kernel, core, context, automation |
| Integration | Kernel, core, context, integration |

In particular, automation-to-integration dependencies are forbidden. An
automation requests a provider-neutral capability; configuration chooses the
integration that implements it. Context-to-integration and
integration-to-automation dependencies are likewise forbidden because they
would move provider choreography or business outcomes across their ownership
boundaries.

For example, an automation may require `records.create` for a configured CRM
authority. A Notion integration and a Salesforce integration may both fulfill
that capability. The user's configuration chooses the binding without changing
the automation's intended outcome.

### System contract

Every pack must declare enough information for a human and the kernel to answer:

- **Identity:** What is its stable identifier, version, layer, and status?
- **Purpose:** Why does it exist, what outcome does it promise, and what is
  explicitly outside its scope?
- **Requirements:** Which packs, context contracts, authorities, and
  capabilities does it require? Which are optional?
- **Interface:** What contracts, capabilities, artifacts, or evidence does it
  make available to other systems?
- **Authority:** Where does each source of truth live, why is it authoritative,
  how is freshness established, and what is the fallback when it is
  unavailable?
- **Effects:** What can it read or change, how reversible are those changes,
  and which approval or autonomy policy applies?
- **Configuration:** Which choices may the user make, what do the defaults mean,
  and why might a different choice be appropriate?
- **Verification:** Which static checks, contract tests, scenario evaluations,
  and live checks demonstrate that it works?
- **Compatibility:** Which contract versions, hosts, and integration
  capabilities does it support?
- **Maturity:** What evidence supports its current level of trust, and what is
  required before it can act more autonomously?

These fields may be stored in a manifest, artifact frontmatter, or another
structured form. Their meaning is canonical; a README, CLI, UI, or agent-facing
instruction is a projection of the same data rather than a separately
maintained description.

### Resolution rules

Before a configured harness is ready to run, the kernel and core must resolve
its complete graph:

- Every required pack and contract reference resolves to one compatible
  version.
- Every required integration capability has exactly one selected binding unless
  the contract explicitly allows several.
- Every required authority is configured and its access policy is known.
- Every effect has an applicable approval or autonomy policy.
- Optional requirements are explicitly marked and report which behavior is
  unavailable when absent.
- Cycles, incompatible versions, ambiguous bindings, and forbidden layer
  dependencies are reported with a path to the source of the conflict.

An unresolved required connection fails closed. An unresolved optional
connection produces a visible degraded state; it never silently changes the
meaning of an automation.

Users must be able to add or remove any selectable context, automation, or
integration pack. Before applying a change, Soter shows what the pack enables,
why it is recommended, which systems depend on it, and what will stop working
if it is removed. Kernel and core packs are the required base and are presented
as such rather than hidden as defaults.

### Assembly health

Soter reports separate health states so “working” is not an ambiguous claim:

- **Valid:** declarations are well-formed and the contract graph is internally
  consistent.
- **Ready:** required packs, authorities, capabilities, permissions, and effect
  policies are resolved for this configuration.
- **Verified:** the applicable checks and evaluations pass on the selected host
  and integrations.
- **Healthy:** recent runtime evidence shows the configured systems completing
  their promised outcomes within policy.

A system can therefore be valid but not ready, or verified but not recently
healthy. CLI commands, graphical interfaces, and agents must read these states
and their evidence from the same structured source.

## Runtime and learning

Soter runs a declared automation against a resolved configuration. The runtime
must preserve enough state to explain the result, resume safely, distinguish a
real improvement from a one-off outcome, and detect when previous evidence is
no longer applicable.

```mermaid
flowchart LR
    A[Request or trigger] --> B[Resolve configuration and graph]
    B --> C[Assemble run envelope]
    C --> D[Evaluate effects and policy]
    D --> E[Execute through capabilities]
    E --> F[Verify promised outcome]
    F --> G[Record evidence]
    G --> H[Evaluate improvement candidates]
```

### Run lifecycle

Every interactive, scheduled, or event-driven run follows the same lifecycle:

1. **Identify the request.** Record the user's requested outcome or triggering
   event, select the run intent, and select the automation meant to handle it.
2. **Resolve the configuration.** Verify the selected pack graph, capability
   bindings, authorities, permissions, compatibility, and health requirements.
3. **Assemble context.** Retrieve the minimum sufficient context required by
   the automation's contracts and record its authority, provenance, freshness,
   and relevant version or fingerprint.
4. **Establish effects.** Determine the possible reads, disclosures, local
   changes, external changes, and dispatches before performing them. Resolve
   the applicable approval or autonomy policy.
5. **Execute the automation.** Use core services and integration capabilities,
   checkpointing where a retry or continuation may be needed.
6. **Verify the outcome.** Test the automation's promised outputs and external
   effects rather than treating an agent's completion message as proof.
7. **Record evidence.** Persist the result, relevant trace, artifacts, effects,
   approvals, failures, and verification outcome.
8. **Evaluate learning.** Decide whether the evidence warrants no change, a
   temporary adaptation, a user-level improvement, or a candidate pack change.

A background run does not use a weaker contract merely because no human is
present. It may proceed only where the user's policy has already authorized its
effects and recovery behavior.

### Run intents and transitions

Soter uses one runtime with four explicit run intents. The intents share core
services and evidence formats but define different boundaries for what the run
may change:

| Intent | Purpose | Default change boundary |
|---|---|---|
| **Inspect** | Explain, diagnose, audit, or report health. | Read-only. |
| **Operate** | Perform work using the configured harness. | Operational data and effects authorized by the selected automation. |
| **Configure** | Install or remove selectable packs and change user settings, bindings, authorities, or policies. | User configuration, not pack definitions. |
| **Develop** | Create or modify packs, contracts, evaluations, adapters, and other harness definitions. | Harness artifacts through kernel-governed authoring and verification. |

How a run begins is recorded separately from its intent. A run may be
user-requested, scheduled, event-triggered, or evidence-triggered. Natural
improvement is therefore an evidence-triggered development run, not a separate
runtime and not an operational run silently rewriting itself.

An operational run may emit an observation or improvement candidate. Any
durable pack change happens in a separate development run with its own envelope,
effect boundary, tests, and promotion policy. Configuration changes similarly
remain distinct from changes to the packs themselves.

A run may transition automatically to an equally or less powerful intent, such
as operation pausing for inspection. A transition that expands what may be
changed requires an existing policy grant or confirmation. The runtime must
show and record the proposed transition; an agent cannot acquire development
authority merely by deciding that the harness should change.

If the requested intent is ambiguous, Soter may inspect or propose a course of
action, but it must resolve the ambiguity before entering configure or develop.
CLI, graphical interfaces, and agents expose the active intent so the user can
always tell whether Soter is doing work, changing its configuration, or
changing itself.

### The run envelope

Core creates a durable run envelope that makes an execution reproducible and
resumable. It contains at least:

- A run identifier, requested outcome or trigger, initiation type, run intent,
  and current lifecycle state.
- The automation identifier and version.
- A snapshot or content hash of the resolved user configuration.
- The required contract versions and complete transitive dependency set.
- Context authority references, provenance, freshness, and fingerprints.
- The selected capability and integration bindings.
- The host, host adapter, and behavior-relevant runtime versions.
- The applicable effect policy, approvals, and autonomy grants.
- Checkpoints, outputs, external effect identifiers, and verification evidence.

The envelope stores references and fingerprints where copying canonical data
would be unsafe or misleading. Secrets are never captured in it. If an agent's
working context is compacted, a process is resumed, or another compatible host
takes over, core rehydrates from the envelope and the declared authorities
rather than relying on conversational memory.

Mutable dependencies such as live schemas and templates must carry a
fingerprint or version. A change to any behavior-relevant transitive dependency
can make earlier verification stale. Soter reports that invalidation instead
of continuing to display an unexplained passing result.

### Context assembly

An automation declares the context contracts it needs. Core resolves those
contracts from user input, configured authorities, and outputs already produced
within the run. It loads progressively so that an agent receives the smallest
useful view first and can request additional declared context when needed.

Authority contracts determine precedence; file location or retrieval order do
not. If two sources disagree, core follows the declared authority rule and
records the conflict. If a required source is missing, stale beyond its policy,
or ambiguous, the run stops or enters an explicitly permitted degraded mode.
It never silently substitutes model memory for required context.

### Authority roles and change contracts

Whether a source is inside or outside the harness does not determine its
authority. A context contract assigns explicit roles to the relevant sources:

- **Definition authority** owns canonical meaning, rules, and lifecycle.
- **Instance authority** owns live records or operational state.
- **Provider authority** owns a service's schema, constraints, and available
  capabilities.
- **Projection** is a rendered, synchronized, or cached representation whose
  canonical source lives elsewhere.
- **Evidence authority** owns the run, evaluation, and outcome records used to
  support health and improvement claims.

One source may serve several roles, but each behavior-relevant fact must resolve
to one canonical authority unless a merge contract explicitly defines how
several authorities combine. The authority declaration also states freshness,
availability, and conflict behavior.

Anything that may be edited carries a change contract. It declares:

- The target and canonical authority.
- Which fields or behaviors may change and which must be preserved.
- Which actor, automation, or integration may propose or apply the change.
- Whether editing is direct, proposal-only, generated, or synchronized.
- The fetch, merge, conflict, and write behavior for mutable external state.
- Required validation, evaluations, and outcome evidence.
- The applicable effect and autonomy policy.
- Versioning, projection refresh, rollback, and recovery behavior.

If a policy is canonical in a Soter pack and published to Notion, the Notion
page is a projection: edit the definition authority, validate it, then refresh
the projection. If Notion is the declared definition authority, edit it through
the configured integration's fetch-merge-write contract and refresh the
harness's fingerprint or cache. Soter never chooses between internal and
external copies based only on location.

A development run uses these same contracts when changing Soter itself. The
kernel supplies the authoring, evaluation, and promotion mechanisms; the
runtime supplies authority resolution, effects, and evidence. Self-development
is therefore governed work performed by the same architecture, not a privileged
side channel.

### Develop-intent governance

`development-governance/v1` is Kernel's provider-neutral policy for changing the
harness itself. It defines six distinct owners rather than treating development as
a privileged Kernel runtime:

- Kernel owns artifact classification, governing contracts, evaluation rules,
  verification requirements, and migration lifecycle.
- Core owns the develop run envelope, effect policy, checkpoints, and evidence
  recording.
- Automation owns the requested development outcome and ordered work.
- Integration owns provider-specific translation and effects.
- Host adapters own isolated task delivery and native tool confinement.
- Configuration owns the user's selected packs, authority grants, workspace policy,
  and publication policy.

The policy fixes the lifecycle to observe, classify, reproduce, specify, implement,
evaluate, review, promote, and monitor. It distinguishes exact, bounded, and open
instructions; requires observable rather than self-reported evaluation verdicts; binds
goldens to exact source, graph, configuration, and host fingerprints; and requires exact
parity or intentional-change evidence before a fallback disappears. Scaffolding is
derived from the governing contract. Legacy Markdown molds remain compatibility inputs,
not definition authority. Ordinary development does not require an ADR, host-specific
line budgets stay host-scoped, and repository merge policy does not substitute for Core
effect authority.

The policy grants no preparation, file-write, host-task, capability, or effect
authority. A development Automation and host delivery may implement it later through
the ordinary run and transaction contracts. Until then, exact legacy authoring and
evaluation sources remain canonical wherever their inventory bindings are only bridged.

### Effects and autonomy

Human confirmation is one possible control, not the architecture's permanent
default. Every effect declares the dimensions needed to apply a policy:

- The operation and target.
- The data sensitivity and possible disclosure.
- The scope and potential blast radius.
- Whether it is reversible, compensatable, or irreversible.
- Its idempotency and safe retry behavior.
- The evidence required to verify success.

Core combines that declaration with the user's policy, the system's maturity,
and the current run state. The result may deny the effect, request confirmation,
allow it once, or allow it under a durable and revocable grant. An automation
or agent cannot grant itself greater authority.

Autonomy is assigned per effect or change class, not as a blanket trust level
for an entire agent. A mature read-only routine may run unattended while a
rare irreversible action in the same automation remains gated. Grants can be
narrowed or revoked, and autonomous effects must still emit evidence and honor
configured limits, monitoring, and recovery behavior.

### What learning means

Learning is a durable improvement supported by run evidence. It is not the
model remembering a conversation, and it is not permission to rewrite the
harness after every surprising result.

Soter distinguishes three scopes:

- **Run adaptation** changes the plan inside one run without changing its
  declared outcome, authority, or effect boundary. It expires with the run.
- **User learning** improves the user's private configuration, preferences,
  bindings, or local guidance. It may become automatic when the change class
  is low-risk, reversible, and explicitly authorized.
- **Pack evolution** changes shared contracts or system behavior. It requires
  reproducible evidence, regression coverage, compatibility review, and the
  pack's promotion policy before distribution.

Host memories and prior conversations may help surface observations, but they
are neither canonical evidence nor a source of required policy. A proposed
durable change must point back to inspectable run evidence.

### Improvement loop

The improvement loop is:

```text
observe → diagnose → reproduce → propose → evaluate → trial → promote → monitor
                                                                    ↘ rollback
```

An observation becomes a candidate only when it identifies the affected
contract and the promised behavior that diverged. Before promotion:

1. Reproduce the divergence or establish why a single high-impact event is
   sufficient evidence.
2. Add or update an evaluation that fails for the observed reason.
3. Prefer correcting or consolidating an existing artifact over creating a new
   rule, guide, or exception.
4. Test the candidate across affected contracts, hosts, and integrations.
5. Compare outcomes over enough trials to distinguish improvement from
   stochastic variation.
6. Use a dry run, shadow, canary, or other contained trial when live behavior
   could create meaningful effects.
7. Promote only within the authority granted for that change class.
8. Monitor the promised outcome and roll back when the evidence regresses.

Confidence comes from reproducibility, representative evaluations, contained
trials, and observed outcomes—not from an agent's self-assessment. Evidence
from one user may improve that user's harness quickly without automatically
changing a shared pack for everyone.

### Guarding against slop and friction

The learning system must make improvement cheaper without making accumulation
easy:

- No observation writes directly to a canonical pack.
- Similar candidates are deduplicated before new artifacts are proposed.
- Temporary hints and workarounds carry freshness or retirement conditions.
- Every durable addition states which existing artifact could not express the
  behavior.
- Promotions must improve their target evidence without regressing established
  behavior.
- Low-risk, reversible user changes can be pre-authorized; repeated approvals
  for an already bounded change are a policy-design failure.
- High-impact or weakly evidenced changes remain supervised until their change
  class earns narrower, explicit autonomy.

The initial implementation may keep more changes supervised while evidence is
scarce. Human involvement should decrease through demonstrated reliability and
revocable policy, not through confidence alone.

## Configuration and distribution

The user controls which selectable systems make up their harness. Soter may
recommend a configuration and explain its reasoning, but it must not hide an
optional system, binding, authority, or permission inside an implicit default.

Configuration and distribution use the same pack contracts. Configuration
selects and binds packs for one user; distribution makes those packs and useful
starting configurations available to others.

### Configuration model

Soter keeps four forms of state separate:

| State | Purpose | Human-editable | Shareable |
|---|---|---|---|
| **Desired configuration** | Records the base, selected packs, settings, bindings, authorities, portable sources and consumers, and policies the user wants. | Yes | Yes, with private values parameterized or removed. |
| **Resolved lock** | Pins exact pack versions, manifests, owned artifact contents, contract graph, portable source inputs and fingerprints, and behavior-relevant projections. | Generated | Yes, when exact reproduction is desired. |
| **Runtime state** | Records authentication status, reachability, health, evidence freshness, and active runs. | Through Soter operations | No assumption of portability. |
| **Secrets** | Supplies credentials and sensitive values through an approved secret provider. | Outside ordinary configuration | Never. |

A user may maintain several named configurations for different purposes and
switch between them explicitly. Soter does not invent hidden personal, team,
or organization precedence. The active configuration and every imported value
must be inspectable.

Every prepared or connected operation also carries an explicit
`configurationBasis`. `tracked-contained` means the checked-in configuration
and fixture lock are being used only with mechanically contained fixture
providers; it can never authorize a connected MCP request. `private-active`
means the exact private desired configuration and its exact active lock both
exist, match one another, and are current. A half-present pair fails closed.
Core seals the selected name, basis, configuration path, lock path, lock
fingerprint, and graph fingerprint through prepared work, selected private
review, review batches, approval and one-time consumption, and the durable
checkpoint. Every authority boundary revalidates that same selection. A caller
cannot substitute an arbitrary lock or run path, fall back from missing private
state to a tracked fixture, or reuse a checkpoint after the active selection
drifts.

The connected acquisition adapters for Meeting Intake, Email Triage, Task
Capture, Organization Capture, Project Capture, Contact Capture, and Project
Pulse accept one exact prepared-work ID as their only source selector. They
MUST rederive the private-active configuration, active lock, selected-work
private inputs, and Core-owned run from that work. In particular, Email MUST
recover its mailbox query from the private review companion. No acquisition
prepare operation may accept a caller lock path, run path, query, snapshot, or
provider identity as an alternative selection chain. An explicit time or
expected host may only tighten revalidation.

Internal generic capability and operation-plan preparation under
`private-active` MUST likewise reference an exact Core-created run envelope
stored as a private `0600` file under `.soter/state/runs`. Core MUST reject a
repository-authored run document, a caller-selected path, a copied run, or a
run whose prepared-work, configuration, lock, graph, or host binding is not
exact. Runtime file location is not itself authority, and no existing document
may be adopted merely because its bytes satisfy a run schema. CLI, MCP, and UI
interfaces MUST NOT expose a generic capability- or plan-originating operation;
they may advance an exact current call created by a work-owned Automation
adapter. Fixed provider-probe preparation remains the only public generic
read-preparation boundary.

An illustrative desired configuration might express:

```yaml
base: soter
packs:
  - context.crm
  - automation.meeting-intake
  - integration.notion
  - integration.otter
bindings:
  crm.records: integration.notion
  meeting.transcript: integration.otter
sources:
  source.policy.tasks:
    capability: documents.content.read
    authority: crm.definition
    input: { uri: notion://tasks-policy, expectedTitle: Tasks }
    readiness: probe-read
    consumer: automation.meeting-intake/applicable-policy
authorities:
  crm.records: notion://configured-database
policies:
  external-write: confirm
host: codex
```

The YAML above is conceptual shorthand. The normative v1 desired-configuration
shape is [soter/contracts/configuration.schema.json](./soter/contracts/configuration.schema.json),
with a complete example at
[soter/configurations/meeting-intake.config.json](./soter/configurations/meeting-intake.config.json).
The versioned schema, rather than rendered YAML or UI labels, determines the
field names and validation contract.

A configuration source is explicit wiring, not a new layer or a copy of the
underlying data. It declares one stable `source.*` identity, portable capability,
bound authority, exact capability input, readiness mode, and one or more selected
pack consumers with a purpose, subject scope, and reason. The canonical content
may live inside the harness or externally; the source declaration tells Core how
to obtain it. `runtime-only` sources are used only by an actual run. A
`probe-read` source additionally permits a safe, expiring readiness read when the
capability has only allowed `read` and `disclosure` effects.

A pack that cannot operate without configured sources declares
`sourceRequirements` in its manifest: purpose, capability, authority role and
subject, and minimum/maximum cardinality. This prevents a configuration from
resolving successfully with a capability binding but no concrete source input.

Kernel validates every source input against the exact capability schema, keeps
its authority inside the selected binding, rejects consumers that are not
selected or do not declare that capability requirement, and rejects unsafe
readiness modes. The resolved lock fingerprints the input and consumer wiring.
Core gives an Automation the consumer declarations it owns, but projects only
provider-neutral source identity, capability, authority, input, and fingerprint
to an Integration probe. An Integration must never depend on an Automation's
settings shape.

A Context pack that owns portable records declares a
`context-record-model/v1`. The model gives each record type and field one
canonical meaning, value shape, create requirement, nullability, mutability,
relationship identity, content kind, and set of valid deduplication fields.
Kernel requires the definition to be an artifact of its exact Context pack.
Core validates record-capability inputs and normalized outputs against that
model before a fixture or connected provider can establish a passed capability
invocation.
Automation may propose only Context-declared fields; grounding and decision
evidence does not become a provider field merely because it was useful inside a
run.

`provider-mapping/v1` is the only active typed provider-mapping contract. It
binds one Integration mapping to one exact Context model. Portable record
capabilities use `<namespace>.records.read|create|update` and
`<namespace>.schema.read`; the capability namespace must resolve to the exact
`<namespace>.records` subject owned by that Context model. A configuration that
binds one of those capabilities must select exactly one matching Context model,
even when the Integration declares that Context pack as an optional dependency.
An unbound optional mapping therefore remains dormant rather than silently
introducing domain authority.

Every mapped record and portable field must exist in that model, list versus
scalar decoding must preserve its value shape, and mapped page content must
preserve the declared content kind. A mapping may intentionally implement only
a subset. Each record type therefore declares its own read, create, and update
scope; the mapping-level record capabilities are the exact union. Create scope
requires every Context-required field and body mapping, while generic update
scope cannot expose an immutable Context field. That subset is provider
capability, not domain meaning: a valid
Context field that is absent from the selected mapping remains visibly
unrepresentable and fails compilation before approval.

A Context string field may declare `format: date`. Kernel and Core interpret
that as a real Gregorian calendar date in exact `YYYY-MM-DD` form; syntactically
shaped but impossible values are invalid. Provider mappings may translate that
portable meaning into provider-specific columns, but the translation cannot
weaken the Context invariant. Person assignments remain explicit referenced
identities rather than display labels.

The normative Core state shapes are the
[resolved lock](./soter/contracts/lock.schema.json),
[run envelope](./soter/contracts/run-envelope.schema.json),
[context snapshot](./soter/contracts/context-snapshot.schema.json),
[automation decision](./soter/contracts/automation-decision.schema.json),
[connected operation-batch approval](./soter/contracts/approval-v2.schema.json),
[connected change set](./soter/contracts/connected-change-set-v2.schema.json),
[connected operation batch](./soter/contracts/connected-operation-batch-v2.schema.json),
[private connected transaction checkpoint](./soter/contracts/connected-transaction-checkpoint-v2.schema.json),
[host tool call](./soter/contracts/host-tool-call.schema.json),
[provider probe plan checkpoint](./soter/contracts/provider-probe-plan-checkpoint.schema.json),
[failed provider probe attempt](./soter/contracts/provider-probe-attempt.schema.json),
[durable host call checkpoint](./soter/contracts/host-call-checkpoint.schema.json),
[bound sequential operation plan](./soter/contracts/operation-plan-v2.schema.json),
[bound durable operation-plan checkpoint](./soter/contracts/operation-plan-checkpoint-v2.schema.json),
[evidence record v2](./soter/contracts/evidence-v2.schema.json), and
[doctor result](./soter/contracts/doctor-result.schema.json). Connected
integrations produce short-lived, secret-safe
[exact-check provider probes](./soter/contracts/provider-probe-v2.schema.json)
as private runtime state rather than portable configuration. Portable record
meaning uses the
[Context record model](./soter/contracts/context-record-model.schema.json), and
Context-bound typed provider mappings use the
[provider mapping v1 contract](./soter/contracts/provider-mapping.schema.json).
The generated
[meeting-intake fixtures](./soter/fixtures/meeting-intake/) show how those
documents link while distinguishing local fixture-provider behavior from
connected or live provider behavior.

### Required base and selectable packs

Every configuration includes a conforming kernel and the minimum core systems
required to resolve, execute, verify, and explain the harness. The base contract
lists those required packs explicitly. A user can inspect them and understand
why they are required, but cannot remove one while claiming the configuration
still conforms to that base.

The core layer may also contain optional extensions. Context, automation, and
integration packs are selectable unless another selected pack declares them as
required dependencies. Users must be able to ask what a pack enables, why it is
installed, what it costs or exposes, and what depends on it.

Adding or removing a pack is a configuration operation. Before applying it,
Soter resolves and displays:

- The exact configuration change.
- New, removed, or changed dependencies and capability bindings.
- Required authorities, credentials, permissions, and effects.
- Compatibility or migration consequences.
- Evidence that will become stale and checks that must be rerun.
- Behavior that will become available, degraded, or unavailable.

Soter refuses a change that would leave a required connection unresolved unless
the user also selects a valid replacement or removes the dependent behavior.

### Recommendations and bundles

A user may describe a goal rather than know which packs to select. Soter can
recommend individual packs or a bundle, but every recommendation explains:

- Which user goal it supports.
- Why each pack is included.
- Which alternatives exist and why one may be preferable.
- The maturity and compatibility of the recommendation.
- The data, integrations, permissions, and potential effects involved.
- Which parts are required and which are optional.

A bundle is only a versioned, named recommendation of exact pack releases or
explicit compatible-version constraints. It contains reasons and compatibility
limitations, never starter settings, bindings, authorities, permissions, or
hidden runtime behavior. A later configuration flow may use its transparent
resolution as input while keeping configuration choices explicit. Changing a
bundle never silently alters an existing desired configuration.

### Resolution and realization

Core resolves the desired configuration into one compatible graph and produces
the lock. Resolution includes pack dependencies, contract versions, capability
bindings, authority roles, effect policies, host support, and migrations. The
lock fingerprints every declared pack artifact as well as its manifest so a
guide, implementation, scenario, contract, or projection change becomes
visible drift. Secret references and values are excluded from the shareable
lock.

The desired configuration names a default host, but host choice is a resolution
input rather than a reason to duplicate the configuration's packs, bindings,
authorities, or policies. A user may explicitly select another declared host
only when every selected pack declares compatibility with it. The lock records
the selected host and whether it came from the configuration default or an
override, fingerprints that adapter and only its projections, and remains
reproducible from its own host selection. Changing hosts produces a different
lock and graph fingerprint without changing the portable configuration
fingerprint.

A capability binding selects one integration pack and an explicit allowed set
of authorities. Each invocation chooses exactly one member of that set. The
run's containment level then selects one matching
[capability-provider implementation](./soter/contracts/capability-provider.schema.json)
from the bound pack. Fixture data uses its own
[provider-fixture contract](./soter/contracts/provider-fixture.schema.json), so
local test data cannot masquerade as connected provider state.

A host adapter then realizes the resolved configuration through the host's
native files and features. Generated Codex or Claude instructions, skills,
hooks, plugin metadata, and tool configuration are projections of the lock.
Manual edits to a generated projection are either rejected or reported as
drift; they do not become a second configuration authority.

The same resolution engine serves agents, CLI commands, and graphical
interfaces. Implementations may present different interactions, but these
operations have one structured contract:

- Inspect and explain the active configuration.
- Recommend, add, remove, replace, or configure packs.
- Preview and apply a configuration diff.
- Resolve, validate, and lock the complete graph.
- Check connection and runtime readiness.
- Export a reusable template or exact lock.
- Upgrade, migrate, roll back, or diagnose drift.

The first implemented read projection is the
[configuration view](./soter/contracts/configuration-view.schema.json). It is a
deterministic, fingerprinted explanation of one exact fresh lock: selected
systems and inclusion reasons, dependency edges, host choice and limitations,
capability bindings, sources, authorities, and effect policies. It reports
`valid=passed` only because resolution just revalidated the local graph and
lock. Readiness, verification, and health remain `unknown` until their own
evidence-bearing operations run. CLI and graphical interfaces must render these
structured facts rather than reconstructing architecture or state from prose.

The first implemented apply path is the local configuration-transaction
family. It accepts one complete private `configuration/v1` replacement for an
existing named configuration; a controlled preview draft is not apply
authority. Its contracts remain distinct:

- `configuration-change-plan/v1` privately binds both desired-configuration
  documents, both resolved locks, the prior active-lock state, projection
  fingerprints, and a minimized exact change scope.
- `configuration-change-request/v1` gives that plan an explicit expiry window.
- `configuration-change-confirmation/v1` records one local operator's exact
  confirmation without starting the transaction.
- `configuration-change-consumption/v1` reserves that confirmation once for
  one deterministic checkpoint.
- `configuration-transaction-checkpoint/v1` records local apply, verification,
  rollback, and recovery phases.
- `configuration-change-inspection/v1` exposes only stable identifiers and
  fingerprints. Raw configuration, settings, authority URIs, source inputs,
  secret references, and before/after values are structurally unavailable.

Core revalidates the current document, current lock, candidate document,
candidate lock, graph, and host-projection fingerprints before request,
confirmation, and start. Execution replaces each desired-configuration and
`0600` active-lock file atomically, checkpointing the boundary between them; it
does not rewrite checked-in fixture locks. It then resolves the written
configuration again. Failure restores the private plan's exact prior desired
configuration and active-lock presence/value; an unknown crash state is
reconciled from observed fingerprints or fails closed as `needs-attention`. This local
transaction grants no provider capability, connected-write approval, proof,
readiness, verification, health, or migration promotion.

Host realization is a second, distinct local transaction family. A successful
configuration transaction does not invoke it. Each `host-adapter/v2` binds one
Kernel-governed `host-projection-definition/v2`, whose canonical templates,
generator identity/version, whole-file static outputs, selected-pack dynamic
collections, UTF-8/LF encoding, final newline, and `0644` modes determine exact
candidate bytes. The resolved lock fingerprints every realized candidate and
template; it does not fingerprint or adopt pre-existing consumer `AGENTS.md`,
`CLAUDE.md`, skill trees, or host config bytes as generated authority. V2 does
not track realized host copies. Dynamic workflow-guide collections select only
exact `active` guides.
Candidate guides are available through a separate no-authority preview and can
never enter a realization plan.

The local authority chain is:

- `host-realization-plan/v1` privately binds the exact consumer-root identity,
  active configuration lock, separate `validUntil`, prior managed manifest,
  candidate manifest metadata, prior/candidate file bytes, and ordered
  create/replace/remove scope;
- `host-realization-request/v1` adds a shorter explicit confirmation window;
- `host-realization-confirmation/v1` records one exact local decision without
  changing files;
- `host-realization-consumption/v1` reserves that confirmation once for one
  deterministic checkpoint;
- `host-realization-checkpoint/v1` records checkpoint-owned directory creation,
  per-file apply/verify/rollback, manifest-last commit, recovery, and
  needs-attention state;
- `host-managed-manifest/v1` is private ownership state, not a shareable lock;
  and
- `host-realization-inspection/v1` exposes only stable identifiers, relative
  paths, fingerprints, lifecycle facts, reason codes, and derived next-action
  guidance. It cannot represent the consumer-root path or file contents.

Version 1 supports whole-file ownership only. An existing output without an
exact manifest is a collision; an orphan written before manifest commit is
recoverable only through its exact checkpoint and is never adopted by a new
plan. Local edits, malformed manifests, target drift, symlinks, path escape,
active-lock drift, expiry, and cross-host path ownership fail closed. Definition
upgrades explicitly remove formerly managed outputs and preserve their exact
prior bytes for rollback. Core rechecks target identity, path safety, lock,
manifest, output fingerprints, and plan validity immediately before each file
effect. The managed manifest is written last.

The Codex definition owns static `AGENTS.md` and `.codex/config.toml` outputs plus
the selected-active `.agents/skills/*` collection. The Claude definition owns
static `CLAUDE.md` and root `.mcp.json` outputs plus the selected-active
`.claude/skills/*` collection. Settings, hooks, plugins, and other host behavior
are never adopted from an existing consumer root. Templates receive identifier-
only configuration, host, pack, capability, provider-requirement, and development-
guard context. They never interpolate authority URIs, secret references or values,
source inputs, private operator inputs, or provider content.

The Claude `0.3.1` root-MCP correction does not rewrite the immutable `0.3.0`
workflow evidence basis. Core accepts that historical/current pair only when
inverse reconstruction reproduces the exact historical adapter and projection
fingerprints, the relocated tools output preserves exact bytes, mode, template,
and identity, and every selected workflow skill remains byte-identical to its
historical basis. This is a closed path-correction rule, not general adapter
compatibility or new host evidence.

A completed checkpoint proves only deterministic local projection. Host launch,
tool discovery, authentication, provider reachability, connected behavior, and
health remain `unknown` and require their own evidence-bearing operations.

### Pack distribution contract

`pack-release/v1` is an immutable, content-addressed local capsule. Its pack ID
and version, manifest fingerprint, and declared metadata must exactly match the
enclosed canonical manifest. Its inventory is closed: the manifest occurs once,
every declared artifact occurs once with its declared role, and no other file
is included. Entries are regular, single-link files at normalized relative
paths; absolute paths, traversal, symlinks, hardlinks, devices, duplicate paths,
and case-colliding paths fail closed.

Version 1 uses canonical JSON as the capsule format. Artifact bytes are exact
UTF-8 with LF newlines and a final newline, inventory and object keys have fixed
Unicode-codepoint ordering independent of locale or ICU, ownership and ambient
filesystem timestamps are absent, and modes are limited to the complete
permission words `0644` or `0755`; setuid, setgid, and sticky bits are rejected
rather than masked away. Version components use canonical decimal notation with
no leading zero except `0` and are compared without numeric precision loss. Each
artifact seals its bytes, byte count, role, path, and mode. The manifest,
inventory, generator/version, source-input graph, and complete capsule bytes are
independently fingerprinted. Build output must be outside both the canonical
`soter/` graph and private `.soter/` state so a release cannot fingerprint
itself. Content-addressed re-entry is read-only: an existing output must already
be a single-link regular file with exact bytes and full mode `0644`; conflicts,
hardlinks, and mode drift fail before any chmod or other mutation.

The build rejects private runtime companions, active desired configurations and
locks, credential-like values, raw provider responses, secret/private-value
keys, and unsafe filenames. JSON extension checks are case-insensitive, and
forbidden keys are compared after lowercase alphanumeric normalization so
camel-, snake-, and kebab-case variants cannot bypass the boundary.
Caller-supplied summaries, reasons, compatibility notes, limitations,
provenance, and evidence metadata cannot contain credential values,
secret-reference syntax, or absolute local paths. A release may include
normalized contained fixtures only when the pack manifest declares them as
governed artifacts. Dependency, capability, authority, effect, base, and host
compatibility data remain constraints; building a capsule does not resolve them
or install the pack.

Provenance records the exact source-input fingerprint, source revision when
available, a fingerprint of the Git remote locator rather than its value, and
whether the governed inputs were clean, dirty, or unknown. `clean` requires
every governed input to be tracked by that exact revision with matching bytes
and mode; ignored or otherwise untracked declared inputs are `dirty`, never
silently clean. Git provenance carries only a commit-shaped revision; filesystem
provenance has no revision or remote and remains `unknown`. Package intent uses
closed present, absent, and unavailable branches so nulls cannot contradict the
observed state. This proves only the deterministic contained build that was
performed. `package.json` `private=true` is reported solely as packaging intent.
It is not a license, publisher, owner, or publication claim.

Version 1 deliberately has this closed legal and trust boundary:

- `publisher.state=unasserted`;
- `license.state=no-assertion`, with no inferred expression;
- publication, redistribution, marketplace eligibility, and legal sufficiency
  are `not-evaluated`; and
- trust is `unsigned-untrusted`, with no signature.

Git remotes, commit authors, package names, and local users never supply those
assertions. Building or verifying a capsule grants no publication,
redistribution, marketplace, install, configuration, host-realization, or trust
authority. A future shared/public release requires a separate explicit user
decision and governed publisher/license assertions.

Evidence references contain only exact evidence fingerprints, applicability
bindings, privacy scope, freshness, and limitations. They must match the pack
ID/version, manifest, and source graph, be current at build time, and already be
shareable or public. Evidence creation and non-null expiry values must be valid
instants; evidence created after the release build or expired before it fails
closed. Independent verification rechecks graph and manifest applicability,
freshness, deterministic ordering, and unique evidence IDs and fingerprints
from the capsule's internal facts. A null expiry remains explicitly unbounded by
time. The capsule never copies evidence bodies and never promotes `releaseStage`,
evidence maturity, readiness, verification, or health.

`pack-release-inspection/v1` is the sanitized result of independent verification.
It exposes identifiers, digests, provenance facts, inventory fingerprints and
modes, declared constraints, evidence references, limitations, and the legal,
trust, claim, privacy, and authority boundaries. It cannot represent capsule
bytes, raw source roots, credential values, raw provider responses, private
state, or active configuration values. `localReleaseBytes=passed` means only
that the local capsule bytes satisfy this contract.

`bundle/v1` is a deterministic, content-addressed recommendation document. Each
entry carries one reason and compatibility limitations and selects either an
exact pack version plus capsule digest or an explicit compatible-version
constraint. A bundle contains no configuration, binding, authority value,
secret reference, effect permission, install action, automatic update, hidden
dependency, or transitive trust.

`bundle-inspection/v1` resolves only against the explicitly supplied, locally
verified capsule catalog. Expansion is deterministic and explainable. Missing
or ambiguous releases, unresolved required dependencies, selected incompatible
dependencies, base mismatch, and host mismatch remain visible blockers. A
missing optional dependency remains visible in the aggregate constraints but
does not block resolution; if that optional dependency is selected, its version
constraint is enforced. A resolved bundle proves that those local bytes satisfy
the declared bundle constraints; it does not mean the packs are fetched,
installed, configured, ready, verified, healthy, publishable, or trusted.

Release stage still distinguishes experimental, preview, stable, and deprecated
pack declarations, but it is not evidence. Evidence maturity remains the
manifest's declared claim and can become inapplicable when exact dependencies
or evidence drift.

### Install and upgrade lifecycle

Installation and upgrade are separate from release verification,
configuration apply, and host realization. Core accepts only already-local
capsules that pass Kernel's independent verifier. Its exact private transaction
family is:

- `pack-install-plan/v1`: target identity, current managed-manifest binding,
  exact release and optional bundle digests, dependency resolution, ordered
  create/replace/remove files, directory effects, prior/candidate bytes, and a
  separate plan expiry;
- `pack-install-request/v1`: exact plan binding and a shorter confirmation
  window;
- `pack-install-confirmation/v1`: exact request and local actor decision, with
  no file effect;
- `pack-install-consumption/v1`: single-use reservation and deterministic
  checkpoint binding;
- `pack-install-checkpoint/v1`: directory/file/manifest phases, contiguous
  completed prefix, exact prior/candidate observations, rollback, recovery, and
  needs-attention facts;
- `pack-install-managed-manifest/v1`: target-private ownership of exact pack
  versions, release digests, artifact roles, modes, and content fingerprints;
  and
- `pack-install-inspection/v1`: the only general UI/CLI projection.

The plan verifies every selected release and, when supplied, the transparent
bundle against the exact local catalog. Required dependencies must be selected
at compatible versions. A missing optional dependency is an explicit degraded
row; if selected, it must be compatible. A lower selected version cannot replace
a higher installed version. Each managed output is owned by exactly one pack,
and create, replace, and remove are all explicit. Existing unmanaged files,
cross-pack ownership, manifest/output drift, path traversal, symlinks,
hardlinks, and modes outside complete `0644`/`0755` words fail closed.

Start consumes confirmation once before any target effect and creates the
durable checkpoint. Exact re-entry repairs only a reserved consumption whose
deterministic checkpoint was not yet persisted; it does not mint another start.
Execution revalidates current target identity, plan expiry, release bytes,
dependencies, ownership, current output fingerprints, and checkpoint binding
before each effect. It uses atomic file replacement, verifies each candidate,
and commits the private `0600` managed manifest last. Recovery may continue or
restore only the checkpoint's exact fingerprints; observed ambiguity or
rollback drift becomes `needs-attention` rather than adoption or retry.

The sanitized inspection cannot represent the target root, release or bundle
paths, capsule/file bytes, raw managed manifest, private transaction documents,
credentials, or provider responses. `resume.permittedNextAction` is guidance,
not authority; execute and recover still require the exact separately held
checkpoint ID. Successful completion establishes only local materialization and
managed-registry integrity. It grants no fetch, network, package-manager,
configuration, host-realization, migration, uninstall, publication, legal, or
trust authority and cannot promote readiness, verification, or health.

### Sharing and collaborative evolution

Users can share a desired configuration as a reusable template or share its
lock for exact reproduction. Export replaces private authority locations and
secret references with documented parameters unless the user explicitly
chooses otherwise. Recipients can inspect the full proposed graph before
realizing it on their own host and integrations.

Collaborative improvement happens through pack evolution, bundles, reusable
configurations, evaluations, and opt-in evidence—not by pooling private runtime
state. A contribution identifies its affected contract, includes a reproducer
or evaluation, records provenance, and states the compatibility and migration
impact.

`legacy-inventory/v2` is the closed v2 migration record for the final v1 host
tree. Its source paths and byte fingerprints must exactly cover all 143 source
artifacts, and its
tree, state-count, and complete-document fingerprints are deterministic. Each
source has one or more independently stateful target bindings. A binding separates
target assignment from proof: `mapped` retains legacy canonical authority and
fallback; `bridged` requires legacy authority, a retained fallback, an existing
target, and passed evidence that fingerprints both the exact legacy source bytes
and exact target;
`migrated` requires target authority, parity or intentional-change evidence,
and fallback removal; `retired` requires evidence that no configured behavior
depends on that responsibility. The source state is derived: any unfinished
binding keeps the overall source from becoming migrated or retired. Scenario
bridges additionally require the target
scenario to cite the exact source path and fixture-or-higher evidence to bind
the scenario ID, path, and fingerprint. The slice migration manifest and
complete inventory must carry the same state, source fingerprint, target, and
evidence set. Source, target, inventory, or evidence drift fails verification;
an updater cannot silently preserve an evidenced state across changed source
bytes. Migration and retirement require migration-family evidence rather than
reusing behavior evidence as authority-switch proof.

Definition-only resolution may defer reading runtime evidence so deterministic
fixtures can be rebuilt from the finalized definition graph without a circular
dependency on their prior bytes. That narrower resolution is not migration
proof. Full Kernel verification and the legacy-inventory check must validate the
regenerated evidence before a promoted state is accepted.

The final inventory has zero `mapped` or `bridged` artifacts and zero mapped or
bridged target bindings. Every source is a removed `migrated` or `retired`
tombstone; every responsibility has target authority or explicit retirement,
parity or an intentional-change decision, migration-family evidence, and
`fallback=removed`. The inventory is an audit record and cannot be used as a
runtime source, compatibility reader, host projection input, or configuration
fallback. These migration claims do not promote connected readiness, provider
behavior, verification, or health.

For a non-scenario binding, migration-family evidence must fingerprint exactly one
`migration-source` and one `migration-target`, bind the selected target pack and
configuration lock, and fingerprint every supporting evidence record. A mixed
source may repeat that exact form for several target bindings. Every binding is
checked independently and a passing bridge still cannot claim parity for another
binding or for the source as a whole.

Each inventory item also declares `sourcePresence`. `mapped` and `bridged`
sources must be `present`; deleting either is drift. A source may become
`removed` only when its derived state is `migrated` or `retired`, meaning every
target responsibility has migration-family evidence, target or no canonical
authority as applicable, and `fallback=removed`. The removed record retains the
exact final source fingerprint as a governed tombstone. Kernel rejects both an
absent unfinished source and a live file that claims to be tombstoned. The
baseline file count and tree fingerprint continue to describe the complete v1
input set rather than shrinking as proved fallbacks are removed.

The target-only checker-transition catalog fingerprints the immutable final-v1
checker and enumerates its exact 47-code surface once. Each code is either bound
to one or more mechanically anchored Kernel/schema enforcements or to an explicit
intentional-retirement decision. The transition verifier accepts the frozen
source only before finalization and the exact complete inventory tombstone after
deletion. It never imports, invokes, parses output from, or falls back to the old
checker. Kernel verification, the transition selftest, inventory validation,
Core, fixtures, and host conformance are the operational gates.

Users decide whether to contribute observations or evidence. Soter must support
redaction and minimization before evidence leaves a user's environment. Shared
evidence can justify a candidate change, but publication still follows the
pack's evaluation and promotion policy. A user remains free to keep a private
fork or local system without making it part of the shared distribution.

## Hosts, integrations, and interfaces

Soter separates the agent host, the external providers, and the interfaces a
person uses to control the harness. All three consume the same resolved
configuration, contracts, policies, run envelopes, and evidence. None may
quietly redefine them.

### Host adapter contract

Codex, Claude, and future agent runtimes expose different native mechanisms.
A host adapter realizes Soter through those mechanisms while preserving the
same system semantics and effect boundaries.

Every host adapter must account for:

- Loading durable project and user guidance.
- Discovering and invoking the selected systems and automations.
- Registering integration capabilities and their dependencies.
- Running deterministic lifecycle enforcement where the host supports it and
  supplying an equivalent core boundary where it does not.
- Applying effect policy and returning approval decisions to core.
- Preserving and rehydrating the run envelope across compaction, restart,
  retry, or handoff.
- Supporting interactive, headless, scheduled, and event-triggered runs where
  the adapter claims those capabilities.
- Isolating development runs from the active configuration and unfinished
  work.
- Returning structured traces, artifacts, external effect identifiers, and
  verification evidence.
- Reporting unsupported or degraded behavior before a run depends on it.

Current host projections may include:

| Concern | Codex projection | Claude projection |
|---|---|---|
| Durable repo guidance | `AGENTS.md` | `CLAUDE.md` |
| Reusable workflows | Agent skills | Claude skills |
| Lifecycle enforcement | Core transactions plus declared host-guided boundaries | Core transactions plus declared host-guided boundaries |
| Distribution | Governed local pack releases and bundles | Governed local pack releases and bundles |
| External tools | Generated MCP configuration plus declared provider requirements | Generated MCP configuration plus declared provider requirements |

These paths and native features are implementation details owned by their host
adapters. Soter's canonical definitions remain provider-neutral. If a host
adds, removes, or changes a mechanism, only the adapter and its conformance
evidence should need to change.

A host adapter cannot claim support by replacing a required deterministic gate
with prose and hoping the agent follows it. When a host lacks a native hook,
approval, scheduler, or persistence feature, the adapter must supply the
behavior through core, declare a visible limitation, or mark the configuration
unsupported.

### Host conformance

Supporting a host means passing behavior-level conformance scenarios. At
minimum, the adapter proves that it can:

1. Realize the resolved configuration without introducing an undeclared
   system or effect.
2. Invoke an automation with its required context and integration bindings.
3. Enforce a denied, confirmed, and pre-authorized effect correctly.
4. Rehydrate a run after context compaction or process restart.
5. Preserve run and evidence identifiers across retries and handoffs.
6. Execute a contained development run without mutating the active harness.
7. Report capability gaps and stale generated projections accurately.

Conformance evidence is tied to the adapter, host version range, base version,
and affected transitive contracts. It becomes stale when any of those inputs
change materially.

### Integration capability contract

An integration pack implements one provider in the integration layer. It may
expose several versioned capabilities, such as querying records, updating a
document, reading a transcript, drafting a message, or subscribing to an event.

A capability contract declares:

- A stable identifier, version, purpose, and portability level.
- Typed inputs, outputs, pagination, and relevant size or rate constraints.
- Required authentication and minimum permission scopes.
- Read, disclosure, write, dispatch, and destructive effect annotations.
- Idempotency, retry, timeout, checkpoint, and compensation behavior.
- A normalized error model covering authentication, authorization, validation,
  conflict, rate limit, unavailable, retryable, and unknown failures.
- Provenance and freshness returned with data.
- Health checks, fixtures, contract tests, and any contained live verification.
- Provider limitations that an automation or user must understand.

Capability contracts should be stable and meaningful, not a lowest-common-
denominator disguise. When an automation intentionally requires a unique
provider feature, it declares that provider-specific capability and the
resulting portability limitation rather than hiding the dependency.

MCP is a preferred standard transport when a provider supports it, but it is
not itself the Soter capability contract. Integrations may also use an app
connector, SDK, CLI, local process, or direct service API. The integration pack
normalizes whichever transport it uses into the declared capability and effect
model.

Provider-specific field semantics and user-specific target identities are
separate contracts. An integration-owned provider mapping declares how
portable record types and fields correspond to provider fields. Mapping v2 also
declares the provider property type used by schema checks, so a renamed field,
relation converted to text, or status converted to select fails mechanically
instead of surfacing later as a misleading empty or malformed record. A pack-owned
settings definition validates the selected user's target identifiers and other
desired configuration under `settings[pack-id]`. Mappings are shareable pack
content; target identities are configuration. Neither belongs in an automation
prompt or host projection.

Exact provider resources consumed by other packs use configuration `sources`
rather than Integration settings. This keeps a document URI and portable input
independent of the provider translator while making every consumer and readiness
read explicit.

Portable record outputs include a provider version, revision, or deterministic
content fingerprint whenever later compare-before-write or freshness logic may
depend on the observed state. Absence of a provider-native revision does not
permit Core to omit the concurrency boundary; the integration derives a stable
fingerprint from the normalized record it actually observed.

### Host-dispatched MCP contract

MCP-backed provider execution is resumable rather than a hidden direct network
call from Core. A connected provider declaration names:

- The logical MCP server identity and allowlisted provider-neutral operations
  it may request.
- An integration-owned prepare function that translates capability input into
  one logical operation and argument object.
- An integration-owned completion function that normalizes the host response
  into the capability output contract.
- A narrower probe-tool allowlist plus either one-call prepare/completion
  functions or plan/step/finalize functions for non-mutating readiness
  observations.
- The exact provider, capability, authority, containment, and effects covered.

Core creates a `host-tool-call/v1` record before dispatch. The record binds the
request to the exact configuration lock, graph, host adapter, provider version,
capability version, authority, effect-policy decisions, input fingerprint,
logical server, provider operation, resolved native host tool, declared response
profile, and argument
fingerprint. It contains no credential values. If policy blocks the effect or
the portable input is invalid, no tool or arguments may be emitted.

The host adapter maps each allowlisted logical operation to an exact native tool
name and provider-declared response profile for its current connector, plugin,
or project MCP registration. Core
performs this resolution before returning the requested call; the host invokes
only the resolved native tool. Host-qualified names such as Codex or Claude MCP
function prefixes are projections and must not appear in automation,
capability, or provider-mapping contracts. Tool discovery may inform an adapter
update, but it cannot silently substitute a newly discovered name at runtime.

After execution, Core accepts a result only for the exact outstanding request.
The integration normalizes it, Core validates the portable output, and the call
advances to completed or failed. The durable call record stores response and
output fingerprints rather than the raw provider body. A retry, resume, or
handoff therefore cannot substitute a different lock, provider, input, tool,
or response without detection.

Before a host receives a requested tool call, Core writes a
`host-call-checkpoint/v1` document to private runtime state. It binds the exact
call to its lock, graph, host, original portable input, and—where applicable—a
private durable run-envelope path and fingerprint. The checkpoint is
self-fingerprinted, written through an atomic private-file replacement, and
excluded from version control. Host credential values and native provider
response bodies are never written to it. A normalized portable result may be
stored because it is required to resume the run; the checkpoint remains private
operational state rather than shareable configuration or evidence.

Capability preparation also updates the durable run envelope to `executing`
and records the exact pending-call fingerprint. Completion or failure updates
the same checkpoint and adds one typed capability invocation to the run. The
run stores output fingerprints rather than normalized result bodies. Core
allows only one requested capability checkpoint per run, preventing a restarted
host from guessing which concurrent response belongs to the run.

After restart or compaction, an interface lists checkpoint summaries and loads
the exact checkpoint by ID. Completion takes only that ID and the native result;
Core reloads the original lock, run, call, and input from durable state. A stale
lock, wrong host, changed provider implementation, altered checkpoint, closed
run, or conflicting run checkpoint fails closed. Reading a stale checkpoint for
diagnosis remains possible, but it cannot authorize completion.

All interactive projections must use the same Core execution service. The
reference CLI and local Soter MCP server are transports over that service; they
must not reimplement lock freshness, run-envelope matching, policy evaluation,
provider selection, argument allowlisting, normalization, or failure
recording. The local Soter MCP server is a host interface, not a provider route:
it exposes the logical operation for explanation, emits the exact resolved
native tool request, and accepts a native result, but never invokes a provider
tool itself.

The long-running MCP transport must not silently serve behavior loaded before
the current governed graph. At process creation it fingerprints every pack
manifest and each definition, implementation, and projection artifact, then
adds the selected `host-adapter/v2` document, projection definition, static
templates, and dynamic-collection templates. It
does not include evaluation fixtures or private runtime state. The read-only
`host-runtime-inspection/v1` projection reports:

- the active host and server identity;
- startup and current behavior fingerprints;
- `current` or `stale` with a stable reason code;
- whether restart is required and the only permitted next action; and
- explicit no-authority and privacy facts.

If current behavior cannot be inventoried or differs from startup, the runtime
is stale. Every MCP tool other than inspection returns a structured
`SOTER_HOST_RUNTIME_STALE` failure before state creation, checkpoint mutation,
or provider-request emission. Restoring identical artifacts may restore the
same process to current; changed behavior requires a restarted host runtime.
This comparison establishes only that the process matches governed local
behavior. It cannot establish connector authentication, provider reachability,
readiness, write conformance, verification, or health.

Internal capability and operation-plan preparation accepts no caller-supplied
approval set and is not a public generic read surface. Consequently, a
work-owned Automation plan whose resolved effects require confirmation
produces a blocked call with no tool or arguments. Public interfaces may
advance only its exact current checkpoint call; they cannot originate another
capability or plan. Connected writes use the separate transaction contract
below. Host approval prompts alone are not reusable Soter authorization.

The host-call checkpoint represents one native request. A provider feature that
needs several requests—multi-target reads, deduplication followed by creation,
compare-before-write, or read-after-write verification—must not hide that
sequence inside a translator or rely on provider plan features to collapse it.

`operation-plan/v2` is the sole sequential multi-call boundary. Each step
declares a portable input and an explicit `inputBindings` array; fixed-input
steps use an empty array. A binding may reference only an earlier normalized
output, may not overwrite fixed input, and records the source output, bound
value, and resolved-input fingerprints. Empty bindings explicitly skip or
fail according to `onEmpty`; they never widen a read.

Core preflights every selected provider, authority, effect policy, module
export, and host route before it checkpoints or emits the first request.
A data-dependent input receives final capability and translator validation
after its exact source output exists. Confirmation-gated effects are rejected
before the checkpoint is created; the general operation-plan interface does
not accept an approval.

`operation-plan-checkpoint/v2` is the sole private durable plan checkpoint.
It binds the exact lock, graph, host, run, plan, ordered steps, binding
resolutions, and current call. Completion requires the checkpoint and exact
current call IDs. Exact response replay is idempotent; a changed, late, or
guessed response fails closed. Restart recovery reloads the current call from
private state. Normalized outputs may be retained for later typed bindings,
but raw provider responses and credential values are never retained.

The v2 plan supports sequential earlier-step bindings with
`unique-string-list` and `exact-string` transforms. It does not add arbitrary
expressions, branching, parallelism, fan-out, plan-level retry, approval-bound
writes, compensation, or rollback.

Connected writes use the separate v2 transaction boundary rather than
widening the general operation-plan interface.
`connected-change-set/v2` and `connected-operation-batch/v2` are the generic
pack-compiled connected boundary for an exact subset of a durable Automation
proposal. Core owns the closed provider-neutral envelopes, exact subset and
proposal bindings, capability/authority/provider validation, fingerprints,
approval compatibility, and transaction profile. The owning Automation
declares the compiler and verifier and owns domain reconstruction. The v2
`verified-write-sequence` profile requires exactly one ordered write operation
per selected action, an optional same-provider read-only precondition, a
mandatory same-provider read-after-write verification, prohibited automatic
write retry, and explicit manual recovery when no inverse is declared. Core
validates every portable input and normalized observation against its declared
capability contract and validates the compiler module against the exact lock.
The compiler cannot invent a capability, authority, provider, effect, or host
route. Compilation is an authority-free preview and performs no provider call.

The v2 batch embeds a private review value for each operation because the
eventual human decision must see the exact selected value. These documents are
private runtime state and are excluded from workspace inspection, fixtures,
evidence, diagnostics, and canonical artifacts. Sanitized operator inspection
still exposes only nullable before/after fingerprints. A changed proposal,
selected subset, private item, compiler artifact, provider binding, lock, or
operation order changes the scope and requires a new approval request.

`approval-request/v1` is the private review boundary for connected writes. It
embeds one exact current lock, source run, proposed change set, compiled
operation batch, effects, fingerprints, reason, and an expiry no more than
fifteen minutes after creation. A changed input, binding, mapping, recovery
plan, operation order, lock, run, change set, or batch requires a new request.
The compiler and preview command execute no provider calls.

`connected-approval-review-material/v1` is the private human-readable
projection of one selected approval request. Core derives it on demand from
the existing request and does not persist a second review, batch, or authority
document. It binds the request fingerprint; run; configuration lock, graph,
and host; full change-set and batch document fingerprints; their scope
fingerprints; ordered source and compiled operation fingerprints; exact input,
before, proposed, precondition, verification, and recovery fingerprints; and a
bound private context snapshot when one exists. Each v2 pack-compiled operation
carries a closed private review branch supplied by its verified Automation
compiler. Missing prior context is explicit `SOURCE_CONTEXT_UNAVAILABLE`; it is
not backfilled from provider state or presentation inference. The branch uses
`not-required/PRIOR_VALUE_NOT_REQUIRED` when no prior-value comparison exists,
or `absent-required/DEDUPLICATION_ABSENCE_REQUIRED` when exact absence is part
of the operation. Its proposed value, precondition, verification, and recovery
remain bound to the selected operation and request.

The selected material uses portable-resource and capability codes so it does
not contain native provider arguments. Its dynamic `current|stale|unknown`
lock applicability is re-derived on every read and excluded from the immutable
material fingerprint. Completeness is a review fact, not confirmation or start
authority. The contract has no approval, actor decision, permitted action,
continuation request, host request, retry, proof, maturity, or migration field.
It is excluded from workspace inspection, sanitized operator inspection,
evidence, diagnostics, fixtures, and canonical artifacts. Stable failures are
`CONNECTED_APPROVAL_REVIEW_MATERIAL_MISSING`, `_MALFORMED`, `_TAMPERED`,
`_BINDING_INVALID`, and `_CREDENTIAL_REJECTED`. The initial projector supports
the closed v2 pack-compiled operation shape. Another transaction profile
requires deliberate compiler and review projection logic, not a UI convention.

`approval/v2` confirms exactly that request. It embeds the request, repeats its
request, lock, change-set, batch, and effect fingerprints, and expires with the
request. A blocked batch cannot be requested or approved. The validator also
requires every compiled operation to match the same ordered source change-set
operation and recomputes its precondition and verification fingerprints from
that input. Confirmation reloads the request's exact run and current lock and
requires the private selected-activity review projection to remain valid before
recording the decision. The review does not grant approval; the separate
confirmation operation still supplies the actor and decision reason. The
confirmation is a decision record, not a bearer token accepted from a host or
MCP caller.

`approval-consumption/v1` is private one-time start authorization. Core reserves
it atomically for one approval, lock, run, batch, and deterministic checkpoint,
then marks it started only with that checkpoint's exact fingerprint. Re-entry
for the same exact checkpoint is idempotent. A different checkpoint or scope is
rejected; a started consumption with no checkpoint is a recovery fault, not
permission to reconstruct work from conversation.

`operator-inspection/v1` is the sanitized private-derived read model for CLI and
graphical operator interfaces. It projects exact activity and run IDs,
explicit configuration basis and applicability, lock and graph fingerprints,
change-set and batch scope, effects, authorities, record IDs, minimized
before/after fingerprints, request and confirmation facts, one-time
consumption, capability-step order, checkpoint and current call identity,
blockers, and verification criteria. Connected v2 has no executable
compensation family, so the compensation projection is mechanically fixed to
`not-required` with empty step sets and no restored-value fingerprint. Its
`resume` object has `classification`, `reasonCode`, an authoritative reason,
and exactly one `permittedNextAction`. The classification is derived from the
current private-active selection, approval consumption, checkpoint, current
call, and reconciliation state. A tracked-contained or absent configuration
basis always yields unavailable resume and no continuation. It is not
transaction authority and no `safeToRetry` boolean exists. When Core can
identify a real continuation, `continuationRequest` separately binds the exact
checkpoint fingerprint and current call, or the exact checkpoint eligible for
read-only reconciliation. Core must revalidate that reference before returning
an executable host request; permitted-next-action text is never authority.

The operator projection does not turn execution completion into proof maturity
or migration completion. Those three families are emitted separately as
`not-evaluated` until their own contracts supply evidence. The sanitized
`operator-inspection-fixture-set/v1` demonstrates lifecycle rendering only; it
has `authority=none-example-only` and proves no provider readiness or behavior.

`operator-input-summary/v1` is the narrow sanitized preparation-input boundary.
Its `identifier` branch may carry an explicitly sanitized display value. Its
`private` branch has `additionalProperties=false` and cannot represent a value
field at all, including `value=null`; it carries only presence and fingerprint
metadata. Interfaces must not backfill private values from another runtime
object.

`connected-transaction-checkpoint/v2` is the sole private connected transaction
checkpoint for a `verified-write-sequence` batch. It does not add a
second approval, confirmation, consumption, or host authority. Start still
requires the exact current lock, graph, host, durable run, unexpired
`approval/v2`, and unused `approval-consumption/v1`. Before reserving that
consumption, Core preflights every selected operation's optional precondition,
write, mandatory verification, normalized output contract, Automation
evaluator, provider translator, and host route. A bad tail fails before any
start authority is consumed or provider request is emitted.

Each v2 operation executes sequentially as optional precondition, one exact
write, and read-after-write verification. Only an Automation-evaluated exact
expected state advances the checkpoint. A precondition mismatch fails before
the write. A transport or normalization failure during write or verification,
or a verification mismatch, becomes `needs-attention`; Core never retries the
write and does not invent compensation. The checkpoint may issue a separately
bound read-only reconciliation request using the exact verification route.
An expected-state observation completes that operation and resumes the
remaining sequence. An unexpected-state observation resolves the ambiguity but
remains `needs-attention` with manual recovery required. A read failure stays
unresolved and may be observed again through another bounded read. Native
provider responses and credential values are never persisted.

Internal capability and operation-plan preparation still accepts no connected-
write approval and is reachable only through work-owned Automation adapters.
CLI and MCP may load, complete, or fail the exact emitted plan call but cannot
originate an arbitrary capability or plan. The trusted CLI can create an exact
approval and start the separate transaction. CLI and MCP can load, complete,
fail, or request read-only reconciliation of the already-authorized checkpoint
by exact checkpoint and current-call identity; MCP still cannot originate or
widen approval.

#### Bounded connected context finalization

Meeting intake uses the operation-plan service as its connected context
transport; it does not introduce a second provider execution path. Automation
derives the selected connected provider implementations and authorities from
the exact lock, then generates an `operation-plan/v2` with configured fixed
sources followed by reference-bound sources across the selected Contexts:

1. One exact `documents.content.read` for every configuration source consumed by
   the Automation for `applicable-policy`. Each source declares a stable ID,
   capability input, definition authority, governed subjects, and applicability
   reason. Policy source IDs and document URIs are unique; several policies may
   govern the same subject so internal and external rules can be grounded
   together.
2. The exact transcript selected by meeting ID and canonical recording URI.
3. A Meetings read filtered by that same recording URI with a limit of two,
   so zero matches and duplicate matches remain distinguishable.
4. Only the CRM organization record URIs returned by that Meeting, or a skipped
   step when the meeting has no organization relations.
5. Only the Project record URIs returned by those organizations, or a skipped
   step when no project relations were observed.
6. Only the Task record URIs returned by those Projects, or a skipped step when
   no task relations were observed.

The plan is preflighted and checkpointed like any other operation plan. The
host completes each emitted request through the generic plan completion
contract. A process restart does not change which source is current or which
host-native tool and arguments are allowed.

Context finalization is a local Automation transition backed by a Core commit
and accepts only the completed exact plan. Automation requires each configured
policy page to return its exact URI and title, a non-empty bounded Markdown body,
and its recomputed body fingerprint. It also requires a non-empty transcript whose
segments reference known speakers and exactly one typed Meetings record whose
normalized recording URI equals the transcript request. Every non-skipped
related step must return every and only the referenced record IDs of its expected
CRM, Projects, or Tasks type. Provider query filtering alone is not accepted as proof of identity,
and a referenced record that is missing from the normalized result prevents
finalization. Missing, empty, duplicate, mismatched, stale-lock, wrong-host,
failed, blocked, or incomplete required sources fail before a context snapshot
is written.

Core requires every entry in the resulting `context-snapshot/v1` to match
exactly one normalized completed-plan output, its subject and role to match the
declared run authority, and its effect set to match all passed plan effects
before writing private restricted runtime state and synchronizing the run.
Repeating finalization with the same completed plan is idempotent; a conflicting
snapshot or run output fails closed. The run records the snapshot fingerprint,
marks the completed CRM definition, CRM instance, and transcript context sources
loaded for this snapshot, and pauses before writes. Policy snapshot entries carry
machine-readable `applicability` with the configured subjects and reason.
Skipped relationship steps contribute no snapshot entry or effect. The loaded
definition authority proves exact configured selection, normalized page content,
and provenance; it does not prove that policy prose was correctly interpreted or
enforced.

This snapshot is bounded grounding, not complete meeting-intake context. It
loads only the explicitly bound policy pages, the selected meeting, and its
observed organization-to-project-to-task chain; it does not load participant
profiles or infer additional policies from the workspace. Meeting participant
identifiers are provider People IDs and are not assumed to be CRM contact page
URIs. Policy interpretation and participant expansion require their own
judgment, identity, authority, and disclosure contracts. A private connected
snapshot is not a provider probe, checked-in evidence, readiness result,
live-health result, or proof that a host autonomously executed the plan.

Email connected acquisition uses the same contracts and Core service, with two
Automation-declared steps and no separate runtime family. `mail.messages.search`
binds one private query and an exact maximum to a unique provider-message ID
set, a query fingerprint, an exact returned count, and an explicit `complete`
pagination state. Opaque provider cursors are never normalized or persisted.
`mail.threads.read` accepts only the bound message IDs and exact thread/message
bounds; it returns provider thread IDs, provider message IDs, RFC822 Message-IDs,
transport headers, labels, subject, and body. It cannot return importance,
reply-need, injection, handoff, draft, or proposed-action judgment.

The second step uses the v2 `unique-string-list` binding and is skipped only
when the complete search returned no message IDs. Finalization requires
`complete=true`, exact count and query-fingerprint agreement, unique thread and
message identities, every searched message exactly once, and the current exact
lock, provider implementations, and mailbox authority. Missing RFC822 identity,
incomplete pagination, unexpected duplication, omitted searched messages,
staleness, or drift fails closed. The committed private Context snapshot may
contain normalized mail bodies, but workspace inspection, diagnostics,
evidence, canonical fixtures, and general renderer state cannot aggregate it.
The raw connector response, account identity, cursor, credentials, and secret
references are excluded. Finalization pauses the run before any Automation
decision, private derived review, approval, continuation request, or write.

The Gmail connector mappings for `search_email_ids` and
`batch_read_email_threads` bind the closed Codex response profile
`gmail.codex.connector.v1`; alternate envelopes, field aliases, missing explicit
pagination state, and unknown provider fields are rejected. They still have only static translation and synthetic
normalizer tests. Those tests establish minimization and failure semantics, not
authentication, permission, live response compatibility, readiness,
verification, or health.

The Email reduction shared by contained preparation and connected decisions is
defined by Context. Active messages carry `INBOX` and neither `TRASH` nor
`ARCHIVED`. A self-sent-only thread is excluded; alias copies collapse by the
newest active RFC822 Message-ID; and a thread is already triaged only when
every active message carries the configured `AI/Triaged` label. Any active
untriaged message retains the thread. The portable rule requires no provider-
specific label timestamp. The returned thread count must equal included
candidates plus the four exact exclusion counts, including returned threads
with no active inbox message.

`automation.email-triage` declares a pack-owned decision schema and validator
over the generic `automation-decision/v1` envelope. Its inspection operation
recovers the exact private snapshot, deterministic reduction, and a
`needs-input` template that names every candidate but supplies no
classification. A ready input must cover every and only those candidate IDs,
bind exact thread/message fingerprints, resolve bucket, attention, injection,
reply, and handoff state, explicitly reject provider `IMPORTANT` as authority,
and cite at least one exact subject/body substring from an active message.
Meeting-notes and RSVP classifications use Context-owned portable handoff
intents. Suspected instruction injection is mechanically restricted to high-
stakes operator human review with no reply or handoff action.

Core rederives the complete decision from the current lock and snapshot before
committing it create-only under private automation-decision state. Exact replay
is idempotent; changed or incomplete candidate coverage, unbounded citations,
unsafe injection disposition, stale Context, and conflicting durable content
fail closed. The committed decision keeps the run paused and creates no draft,
prepared review, proposed change, approval, continuation request, host call, or
provider write. Neither the private inspection nor a ready decision is evidence
of connected judgment quality, provider readiness, verification, or health.

#### Review-only Automation proposal

`automation-proposal/v1` is the provider-neutral sanitized envelope between one
ready grounded decision and a human-reviewable proposed outcome. It binds the
exact Automation version, paused run, current lock and graph, decision and
Context fingerprints, producer, proposal type, limitations, and one closed
`automation-review/v1` projection. It is private runtime state but contains no
private values: collections expose only code-like identities, exact coverage,
row/action state, reason codes, capability/effect bindings, and fingerprints.
Raw before/after values are structurally absent. Its fixed authority is
`none/AUTOMATION_PROPOSAL_REVIEW_ONLY`; the only named next operation is a
selected-private material inspection, not an executable action.

`automation-proposal-material/v1` is the selected-proposal-only companion. It
binds the exact proposal, decision, Automation, configuration, lock, graph,
pack-owned derived-review contract, content, items, and self-fingerprint. It is
create-only private state under `.soter/state/automation-proposal-material`.
Complete normalized values are representable only here. The companion is
excluded from workspace inspection, evidence, diagnostics, fixtures, canonical
artifacts, and general renderer state; raw native provider responses and
credential-like material are rejected. Its authority is always
`none/AUTOMATION_PROPOSAL_MATERIAL_REVIEW_ONLY`.

Automation packs opt into this boundary with `operator.proposal`, declaring the
exact implementation module/export, pack-owned proposal-input and proposal
schemas, and `automation-derived-review/v1` definition. Kernel requires every
path to be an artifact of the owning Automation. Core verifies the exact locked
artifact fingerprints, generic review coverage, unique collection/row/action
identities, contiguous sequences, complete/incomplete batch rules, capability
and effect bindings, action/change fingerprints, and same-row private item
joins. A proposed action's private item kind must match its action kind. The
owning Automation remains responsible for deterministic domain reconstruction;
Email rebuilds the complete proposal from its persisted private companion on
every selected read.

The two files form one fail-closed pair. Exact replay returns the existing pair;
changed content conflicts, and one file without the other is
`AUTOMATION_PROPOSAL_STATE_INCOMPLETE` rather than an invitation to recreate or
replace state. Other stable families are `AUTOMATION_PROPOSAL_MISSING`,
`_MALFORMED`, `_TAMPERED`, `_BINDING_INVALID`, `_ADAPTER_INVALID`, `_STALE`,
`_CREDENTIAL_REJECTED`, `_WRITE_FAILED`, plus
`AUTOMATION_PROPOSAL_MATERIAL_MALFORMED`, `_TAMPERED`,
`_BINDING_INVALID`, and `_CREDENTIAL_REJECTED`. Errors expose fixed contract
prose, never private field contents.

For Email, proposal input covers every and only the ready decision candidates.
Draft text is required exactly for `draft-review`; task or record-update handoff
values are required exactly for their corresponding portable handoff intent;
meeting and calendar handoffs derive only from the bound private Context; and a
complete digest body is required. The output proposes only existing configured
AI-label application and draft creation. Sending remains a prohibited
no-capability action. Suspected instruction injection produces no proposed
external action. Committing the pair registers fingerprints on the same paused
run but preserves approvals and effects exactly and emits no provider call.

This proposal is not `prepared-work/v1`, `prepared-review-batch/v1`,
`connected-change-set/v2`, `connected-operation-batch/v2`, or
`approval-request/v1`.
It may, however, be the exact basis for a later pack-compiled connected batch.
A trusted local operator selects a non-empty subset of proposed action IDs;
Core revalidates the proposal/private-material pair and current lock, restores
canonical action order, and invokes the exact locked Automation compiler.
Successful compilation creates `connected-change-set/v2` and
`connected-operation-batch/v2`, still without approval or provider calls.
Label-only Email subsets can continue through the existing expiring request,
confirmation, one-time start, and checkpoint authority path. Draft or mixed
subsets fail before request creation because no exact connected draft provider
is declared. Sending remains impossible because no send capability exists.

#### Grounded Automation decision

`automation-decision/v1` is the provider-neutral durable boundary between
bounded context and a proposed outcome. Core owns the envelope and persistence
rules: exact Automation pack and version, run, lock, graph, context snapshot,
producer, state, privacy, issues, payload, and self-fingerprint. The selected
Automation owns the decision type and payload semantics through a pack-owned
schema and validator. This prevents Core from accumulating domain judgment and
prevents a host from returning unbound prose that later becomes an effect.

A decision is either `ready` or `needs-input`. `ready` contains no issues and
may be consumed by the owning Automation. `needs-input` contains at least one
explicit issue and is an abstention, not a partial permission or low-confidence
approval. Both states are private runtime records; neither authorizes a write,
calls a provider, establishes host quality, or changes a pack. Core validates a
connected decision against the exact current lock and selected Automation,
requires the committed private connected snapshot and paused durable run,
rejects credential material, stores the decision atomically under
`.soter/state/automation-decisions`, and registers its fingerprint on that run.
Repeating the same decision is idempotent. A different decision ID for the same
snapshot conflicts instead of silently replacing or competing with the first.

The meeting-intake decision schema binds exactly one bounded meeting and
transcript entry; exact transcript segment indexes and fingerprints for the
summary; one disposition (`fold`, `ignore`, or `review`) for every and only
bounded task candidate; and one outcome (`allow`, `block`, or `review`) for
every and only explicitly applicable policy entry. Policy citations must be
exact substrings of the bounded body and retain quote fingerprints. Record and
entry fingerprints are derived by Soter rather than trusted from host input.
A connected `ready` decision requires at least one summary segment, exactly one
grounded `fold`, no `review` dispositions, and cited `allow` outcomes for every
policy. Otherwise the host records `needs-input`; Automation cannot project it
into a change set.

Meeting-intake change sets carry a decision basis containing the exact decision
and context-snapshot IDs and fingerprints. The change-set scope fingerprint
includes that basis, so changing the judgment or grounding invalidates the
proposal and every later approval. Kernel links checked-in decision, snapshot,
run, change set, and selected Automation artifacts. The CLI and MCP projections
share the same constructors and validators. A read-only inspection projection
rehydrates the exact private snapshot and a safe `needs-input` template after
compaction rather than reconstructing candidates from conversation. MCP can
commit host judgment and request a read-only proposal projection, but it still
cannot approve or execute the resulting writes.

Provider readiness uses a state machine separate from domain capability runs.
Core derives the observation scope from the exact lock and desired
configuration, including the selected provider, secret-reference identifiers,
authorities, and capabilities. The integration may choose only tools in its
narrower `probeTools` allowlist.

Core separately selects exact configuration sources whose readiness mode is
`probe-read` and whose capability and authority belong to that provider binding.
It gives the Integration only the provider-neutral source fields; consumer pack,
purpose, and applicability metadata remain outside the Integration boundary.

Every connected provider probe uses an explicit sequential
`provider-probe-plan-checkpoint/v1`, including providers whose plan contains
only one step. A probe plan records each semantic scope,
logical operation, resolved native host tool, arguments, and fingerprint before
emitting at most one `currentCall`. Every completion supplies the exact
checkpoint and call IDs. Core rederives the complete plan from the current lock
before accepting a response, persists only the integration's minimized step
result, and then emits the next request or stops. The integration cannot hide a
multi-request probe inside one translator call.

After all steps complete, the integration returns typed observations rather
than a readiness verdict. Core checks that credentials, authorities,
capabilities, and one check per exact plan step cover neither more nor less than
the locked plan, then assembles `provider-probe/v2`. Each check binds its step,
kind, subject, scope fingerprint, safe method, and minimized expected/observed
fingerprints. This separation prevents identity or metadata requests from being
recorded as domain invocations and prevents an adapter from widening readiness
claims.

Probe-plan checkpoints contain request, response, scope, minimized result, and
normalized-probe fingerprints, never provider response bodies. A
successful identity request may establish authentication and endpoint
reachability while leaving a capability `unknown`. File-based CLI completion
accepts native results only from an absolute private path whose real target is
outside the repository; the caller deletes that transient input after
completion. A provider response file cannot become pack content, desired
configuration, runtime evidence, or a committed fixture. Capability
compatibility becomes `passed` only when every exact required check observes
enough safe behavior to support that claim. Probe success never implies write
permission, write behavior, automation verification, or live health.

### Binding automations to integrations

Automations depend on capabilities, not tool names or provider call sequences.
The user configuration binds each requirement to one integration and authority.
For example:

```text
automation.meeting-intake
  requires meeting.transcript.read
  requires meetings.records.create
  requires tasks.records.update

meeting.transcript.read → integration.otter → configured meeting authority
meetings.records.create → integration.notion → configured Meetings authority
tasks.records.update    → integration.notion → configured Tasks authority
```

Core validates capability and contract versions before execution. The
integration owns authentication, transport, provider translation, and typed
failure handling. The automation owns the user outcome, orchestration, and
recovery choices that have business meaning.

Several providers may implement the same capability, and one provider may
fulfill several capabilities. A binding may be replaced without changing the
automation when the replacement satisfies the same contract. Provider-specific
schema mapping remains explicit configuration or an owned integration artifact;
it cannot hide in a prompt.

### Shared interface model

Core exposes one versioned structured model for:

- Packs, bundles, configurations, locks, and dependency graphs.
- Authorities, capabilities, bindings, permissions, and effect policies.
- Runs, intents, envelopes, checkpoints, outputs, and external effects.
- Evaluations, evidence, health, drift, and improvement candidates.
- Configuration diffs, migrations, approvals, upgrades, and rollback.

This model may be implemented as an in-process API, service API, command
protocol, event stream, or combination. Its schemas and state transitions are
canonical; rendered text and screens are not.

The read-only `configuration-preview/v1` Core operation is the first narrow
configuration projection. It accepts controlled host-adapter, effect-policy,
and optional automation-addition drafts, resolves required pack dependencies,
validates the complete candidate configuration through the same Kernel graph
checks used for a stored configuration, and resolves the candidate through the
same Core resolver used to produce a durable lock. The candidate replaces its
source configuration only in memory; preview never edits the source file or
hand-patches the current lock. A lock fingerprint is returned only when pack
settings, dependencies, bindings, authorities, sources, host compatibility,
effect policies, scenarios, and migrations all remain valid. The projection
reports field differences and exact-lock evidence applicability and exposes no
apply operation. It does not return the candidate configuration, credentials,
secret references, provider payloads, authority target values, context values,
or operation inputs and outputs.

`workflow-definition/v2` has three closed lifecycle branches:
`definition-only`, `active-host-guided`, and `retired`. An active-host-guided
definition binds one exact `workflow-guide/v2`, `workflow-evaluation-set/v2`,
private development request/result contracts, workspace policy, supported hosts,
and effect boundary. Development requests are the only authority for bounded
local reads, writes, commands, or subagent work; provider effects, publication,
merge, protected-root mutation, and host realization remain separate authority.
Retired definitions grant no procedural or runtime authority.

`workflow-guide/v2` is the portable procedural companion to one exact workflow
definition and evaluation set. It binds ordered steps, stop conditions,
safeguards, verification, gotchas, references, privacy exclusions, and explicit
authority facts. Its `contentFingerprint` seals provider-neutral content while
excluding activation evidence and the fingerprint field itself. A `candidate`
guide is preview-only and grants no execution, effect, approval, continuation,
configuration, or realization authority. An `active` guide requires current
passed expectation-withheld agent-or-higher evidence for each supported host and
the exact target-authority migration tombstones. Only then may a host projection
select it as `selected-pack-active`. Codex emits
`.agents/skills/<name>/SKILL.md` plus explicit-only `agents/openai.yaml`; Claude
emits `.claude/skills/<name>/SKILL.md` with implicit model invocation disabled.
Those generated files remain delivery projections, never canonical workflow
definitions or runtime authority.

Migration source identity is the exact historical path and source fingerprint,
not permanent ownership of a filesystem pathname. A governed generated host
projection may therefore reuse a retired skill path with different v2 bytes.
Restoring the exact tombstoned legacy bytes still fails closed as a live
fallback, and host realization separately rejects unmanaged collisions or
drift.

Host evaluation evidence has two create-only persistence boundaries. A
`development-agent-migration-evidence/v1` historical receipt can be created only
from one exact finalized private request, result, observation, and current
private candidate lock. It is deterministically written beneath
`soter/evidence/development/` and explicitly claims no current applicability or
activation authority. A later `evidence/v2` conversion requires that exact
stored receipt, complete source tombstones, the unchanged evaluated behavior and
host instruction fingerprints, and one exact current governed configuration
lock. Exact existing bytes are idempotent; changed bytes, missing or tampered
private material, unsafe links, path escape, subject drift, or a stale lock never
create or replace evidence. Exact re-entry of already stored final evidence may
report its historical bytes without claiming that the pre-write lock is still
current. Neither receipt grants workflow execution, provider effects, merge,
host realization, migration, or fallback-removal authority.

A declared automation may carry mapped static scenarios before a desired
configuration selects it. That state makes the pack inspectable and its future
contract reviewable; it cannot establish executable behavior. Fixture-or-higher
maturity still requires a selecting configuration and applicable exact-lock
evidence.

Read-only builder projections consume the provider-neutral
`workspace-inspection/v1` snapshot from Core. One snapshot joins exact
configuration and lock state, catalog and graph relationships, declared
automation scenarios and migration state, scoped proof, checked-in example
runs, and private checkpoint summaries. Every activity item identifies its
fixture or runtime source and its run, capability, provider-probe,
operation-plan, or canonical connected-transaction kind. The snapshot has no fields for credential data, secret
references, authority target values, context values, operation payloads, or
raw provider responses. Invalid artifacts produce scoped diagnostics without
turning the remainder of the workspace into an all-or-nothing read failure.
Proof remains four-dimensional: an interface cannot replace valid, ready,
verified, and healthy with one success state, and a declared scenario remains
declared-not-executed until applicable executable-scenario evidence exists.
Scenario evidence is applicable only when its scenario fingerprint, run link,
configuration-lock fingerprint, and evidence link all match. A fixture scenario
result may be shown as executed and traced without lifting workspace Verified,
connected readiness, or live health.

Automation packs may declare a provider-neutral `automation-input/v1` document.
It is a static input definition: fields carry domain type, requirement,
authority/reference meaning, constraints, and privacy exposure without encoding
a Studio layout. Core inspection sanitizes and projects that definition so an
interface can render controls. An Automation may additionally declare one
fixture-contained preparation adapter as its own implementation artifact. Core's
`prepareAutomationRun` operation requires the caller to select one named
configuration, validates the declared non-credential inputs, binds its current
exact lock, acquires only typed contained context, and writes a private
`prepared-work/v1` receipt plus its private run, context snapshot, and preparation
evidence. Private input values are structurally absent from the receipt; only
their fingerprints are retained. Core stores the exact normalized operator
values separately as `prepared-work-review-material/v1` under the private
`0600` runtime-state boundary. That companion binds the final receipt and
preparation checkpoint fingerprints, exact automation and input contract, and
configuration lock. It is available only through an explicit selected-work
read, is never aggregated into workspace inspection, evidence, diagnostics,
fixtures, or canonical artifacts, and contains no approval, continuation, host
request, or permitted-action authority. Its `current|stale` applicability is
derived when read and is excluded from the companion's immutable fingerprint.
Missing, malformed, fingerprint-tampered, credential-like, or mismatched
material fails the selected review read closed with stable reason codes without
hiding the sanitized queue. Exact preparation
re-entry must match the existing private values and never replaces them.

An Automation may also return a closed derived-review payload. The domain
vocabulary is declared by that Automation in an
`automation-derived-review/v1` definition artifact referenced by
`operator.preparation.derivedReviewContract`; Kernel verifies exact ownership
and unique item/field identities. Core owns the generic private envelope and
mechanical validation, not Email or another domain's item names.
`prepared-work/v1.preview.collections[]` is the sanitized public boundary: each
collection has a code-like `labelKey`, exact coverage counts and unique
exclusion reason codes, globally unique opaque row and action IDs, contiguous
row sequence, and `representedCount`. `includedCount` is the sum of
`representedCount`; `observedCount` equals included plus excluded; exclusion
counts must sum exactly. Rows expose only a subject kind and fingerprint, never
a provider thread ID, RFC822 message ID, address, subject, body, or arbitrary
label prose. A row fingerprint excludes its private-detail fingerprint and the
proposed action's change fingerprint to avoid circular private joins; the
containing collection fingerprint seals the complete row and both bindings.
Capability actions use separate canonical `effect` and `capability` fields;
domain action `kind` remains an Automation-owned code. Handoffs have no effect
or capability. Prohibited dispatch is a closed no-capability branch. Every
proposed action carries `changeFingerprint`, which must equal the fingerprint
of its complete fingerprint-only `proposedChanges[]` record. Its
`afterFingerprint` must name exact private review material sourced from the
same row. If any collection required by the preview is incomplete, the entire
proposed batch must be absent.

`prepared-work-derived-review-material/v1` is the create-only private companion
for normalized Automation-derived display material. It binds receipt,
checkpoint, Automation, configuration, exact lock, input-contract, and
Automation-owned derived-review contract fingerprints. Its source joins are exact
`{collectionId,rowId,rowFingerprint}` triples. Field and item fingerprints
seal values, the content fingerprint seals the ordered item set, and the
companion fingerprint seals immutable bindings and content. Applicability is
derived on read. The material is excluded from workspace inspection, evidence,
diagnostics, generated fixtures, and canonical artifacts. Stable failures are
`PREPARED_DERIVED_REVIEW_MATERIAL_MISSING`, `_MALFORMED`, `_TAMPERED`,
`_BINDING_INVALID`, `_CREDENTIAL_REJECTED`, `_MISMATCH`, and `_WRITE_FAILED`.
It has no approval, continuation, host-call, retry, or permitted-action field.

`prepared-review-batch/v1` is a later prepared-family review artifact, not a
connected transaction artifact. Core creates it only from a non-empty unique
subset of exact `state=proposed` actions on one current `ready-for-review`
receipt. Request order is discarded; the batch restores canonical prepared
order. Every selected action binds its sanitized collection and row
fingerprints, source-action fingerprint, fingerprint-only change, subject
fingerprint, private context-item fingerprint when present, and exact private
proposed-item fingerprint. The batch binds the receipt, checkpoint, Automation,
lock, graph, host, preview, and private-review content fingerprints. Its
deterministic identity makes exact re-entry idempotent; private state is
create-only under a `0700` directory with a `0600` document. It cannot select
held, prohibited, none, or handoff actions. It contains no private values,
provider arguments, provider responses, approval, continuation, or execution
authority and is never aggregated into inspection or evidence.

`prepared-review-batch-material/v1` is the selected-batch-only private read
projection. Core revalidates the immutable batch, durable receipt, exact
private derived-review content, and every source-row join before returning the
normalized context and proposed items needed for human review. Its fingerprint
excludes only derived `current|stale` applicability. Raw provider responses and
credential values are structurally absent. Both contracts remain
`review-only`. A batch whose Automation does not declare a compiler carries
`CONNECTED_COMPILER_NOT_DECLARED`; one whose Automation does declare a
compiler carries `CONNECTED_PLAN_NOT_COMPILED`. Both retain
`CONNECTED_VERIFICATION_NOT_PROVEN`; they do not satisfy the executable
`connected-change-set/v2`, `connected-operation-batch/v2`, or `approval-request/v1`
contracts. Stable batch errors are `PREPARED_REVIEW_BATCH_MISSING`,
`_MALFORMED`, `_TAMPERED`, `_BINDING_INVALID`, `_SELECTION_INVALID`, `_STALE`,
and `_WRITE_FAILED`. Private material adds `_MATERIAL_MALFORMED`,
`_MATERIAL_TAMPERED`, `_MATERIAL_BINDING_INVALID`, and
`_MATERIAL_CREDENTIAL_REJECTED`.

`prepared-connected-plan/v1` is the private, selected-plan-only result of an
Automation-owned `operator.connection` compiler. Kernel requires the compiler
module to be an implementation artifact of that Automation. Core loads the
exact module fingerprint from the selected lock, requires the declared compile
and verification-evaluator exports, and passes them only an exact validated
review batch and private batch material. Core remains domain-neutral: it
validates closed compiler output, exact selected-action coverage and ordering,
unique operation identities, portable capability inputs, exact configuration
bindings, one resolved authority, provider-pack parity, declared effects, and
read-only verification inputs. Automation owns domain operation shaping and
comparison semantics; Integration owns provider implementation and translation.

The plan stores private provider arguments under create-only `0700`/`0600`
runtime state. Its fingerprint excludes only derived `current|stale`
applicability. It is excluded from inspection, evidence, fixtures, logs, and
canonical artifacts; raw provider responses and credential values are
forbidden. It is always `state=blocked-review-only`, `executable=false`, and
`authority=none`, granting no approval, continuation, execution, or retry
authority. Current blockers are `CONNECTED_PROVIDER_NOT_DECLARED`,
`CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED`,
`CONNECTED_VERIFICATION_NOT_PROVEN`, and
`SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE`, with only the
provider blocker omitted when every operation and verifier has one declared
connected implementation. Stable failures use the
`PREPARED_CONNECTED_PLAN_*` family for missing, malformed, tampered, stale,
source, lock, compiler, binding, credential, verification, and write errors.

The prepared family is limited to `draft`,
`preparing`, `needs-input`, and `ready-for-review`. Inspection re-evaluates exact
lock applicability; drift projects `CHECKPOINT_STALE`, an unavailable resume
classification, and no continuation request.

A prepared receipt is a review artifact, not transaction authority. Its preview
contains normalized facts, contradictions, evidence bases, and before/after
fingerprints, never raw record values. It stops before write, dispatch, or
destructive effects, creates no approval or continuation request, and cannot
promote readiness, verification, proof, maturity, or migration. Automations
without a declared preparation adapter remain input-definition-only and expose
no prepared-work transition. A preview change may name only a capability and
effect already declared by the Automation and bound by the exact configuration.
Proposed changes remain review facts until a separate durable decision,
proposal, exact request, confirmation, one-time start consumption, and
checkpoint provide the applicable authority.

Task Capture applies the same prepared-work rules to a potential create. Its
declared input order is private title, required exact project reference,
optional `self` enum, optional private pinned date, and optional portable context
classification. Preparation must load exactly one configured machine-readable
task policy, resolve exactly one project, optionally resolve only the
authenticated current workspace user, and inspect no more duplicate candidates
than the policy permits. Arbitrary provider-person IDs are invalid. A project-
linked task must use the `Project` context. A duplicate or context contradiction
yields no proposed change. Otherwise the preview may expose only a synthetic
new-record identity and nullable before/after fingerprints; raw title, date, and
provider values remain unrepresentable in the receipt. This still creates no change set,
approval request, start authorization, continuation request, provider call, or
write authority. A non-conflicting preview also emits one exact sanitized
`task-create` review row whose proposed change binds the same-row private
derived-review item. Duplicate or context-conflicting rows remain held and
cannot enter selection. Core may create one immutable selected review batch and
ask Task Capture's pack-owned compiler for a private candidate plan. That plan
contains one deduplicated `tasks.records.create`, an exact same-authority
`tasks.records.read` absence precondition, mandatory read-after-write
verification, prohibited write retry, and manual recovery because delete is not
declared. It remains `blocked-review-only`, `executable=false`, and
`authority=none`; it is not a transaction batch or approval input and performs
no provider call.

The durable Task workflow is a separate `automation-decision/v1` and
`automation-proposal/v1` family over the same exact prepared-work basis.
Connected acquisition must complete the exact policy-identity, project,
optional current-user, and duplicate reads before the decision can be `ready`.
The proposal deterministically reconstructs the same private Task value and may
enter only Core's generic `connected-change-set/v2` and
`connected-operation-batch/v2` compiler boundary. An exact expiring request,
`approval/v2`, and single-use `approval-consumption/v1` are required before one
`connected-transaction-checkpoint/v2` exists. The checkpoint runs the declared
duplicate-absence precondition, one create, and mandatory read-after-write
verification. It never treats the prepared plan, approval, or permitted-next-
action text as reusable execution authority, and ambiguous write state is not
retried into place.

Organization Capture and Contact Capture use the same generic prepared-work,
private review, durable decision, proposal, connected-batch-v2, approval-v2,
single-use consumption, and connected-checkpoint-v2 contracts. Their pack-owned
schemas and compilers are domain authority; Core owns immutable bindings and
transaction lifecycle authority.

Organization Capture MUST observe the current normalized Organization schema,
MUST keep sector meaning out of Organization Type, MUST intersect derived types
and tags with current options, and MUST perform its bounded alias/name absence
precondition before create. Contact Capture MUST observe current writable person
fields and current Role, Status, Disposition, Authority, and Tag options before
retaining any requested option. Matching MUST be exact and case-insensitive.
An unmatched optional value MUST be omitted and surfaced; it MUST NOT create a
provider option or be replaced with a guessed value. In particular, vague
`supportive` input MUST NOT become `Champion`. A requested organization MUST
resolve to one exact existing resource or remain empty and flagged. An exact
email-or-name candidate MUST hold the create.

Each ready Contact or Organization proposal may compile only one normalized
`crm.records.create` with a same-authority read-only absence precondition and
mandatory read-after-write verification. Preparation, decisions, proposals,
selected-private material, and compiled review plans MUST NOT themselves grant
approval, continuation, host-call, write, retry, proof, or migration authority.
Ambiguous create state MUST enter needs-attention and MUST NOT be retried into
place automatically.

Drive Filing uses prepared work and selected-work private derived review but
deliberately declares no proposal adapter or connected compiler. Preparation
MUST read one exact configuration-owned Storage registry before selecting a
destination, MUST read artifact metadata without artifact content, MUST observe
the current document-index schema, and MUST perform one bounded exact Link and
Name duplicate read. A destination MUST be an exact registered home or the exact
registered provisional inbox; the Automation MUST NOT invent a folder, relation,
owner, organization, Type, or Category. Externally owned files may propose only
the policy-selected shortcut form, or copy only when the operator explicitly
requests a frozen snapshot. Existing organization-owned files and shortcuts that
are not already at the destination MUST produce a private human-move handoff;
copy MUST NOT simulate move. Retention remains human-owned, the required index
cannot be silently dropped, and any unresolved complete-plan invariant MUST hold
all proposed writes.

The Drive Filing prepared preview and private companion grant no approval,
continuation, host-call, provider-write, retry, proof, or migration authority.
Move, rename, delete, dispatch, and destructive effects are prohibited. Until a
separate governed connected compiler exists, attempting to compile its review
batch MUST fail closed and Studio MUST expose no approval or execution control.
Fixture evidence proves only the contained preparation and intentional connected-
execution unavailability; it does not prove Google Drive or Notion credentials,
reachability, permissions, provider behavior, readiness, verification, or health.

Project Pulse uses the same durable decision and proposal families with its own
closed pack-owned schemas and compiler. Connected acquisition must complete one
exact policy selection, project record, complete promoted-task set, and current
project document before the decision can be `ready`. Analysis accepts only the
governed real milestone and dated owner-action work-item syntax. Progress derives
only from exact work-item action to promoted-task title inheritance in the same
project; unmatched tasks never alter milestone progress. Health is a required
operator judgment, never a task-count inference. Optional exact milestone-title
selection changes or clears health tags, while blocked work, existing risk tags,
and inconsistent resulting health fail closed as contradictions. Missing promoted
task matches, malformed grammar, invalid date or visibility, ambiguous titles, or
incorrect project relationships also fail closed. The private proposal
reconstructs the exact status record and any exact milestone-line replacements.
Selection must contain
the proposal's complete action set: document update first when a replacement is
required, then status create. A partial set cannot become a connected batch.
The document update binds its prior content and exact-string replacement;
status create binds duplicate absence. Both require mandatory same-authority
read-after-write verification under one approval-v2 and one consumed start.
The sequence is ordered and checkpointed but not externally atomic. A failed or
ambiguous later effect enters needs-attention for manual reconciliation; no
write is automatically retried or silently compensated.

Email triage uses one private query because `automation-input/v1` does not yet
declare bounded list cardinality. Exact-thread selection is intentionally
unsupported rather than encoded in a string convention. The contained oracle
reads 15 synthetic provider-returned threads, removes one inactive/trash-only
return, one RFC822 alias duplicate, one self-sent thread, and one
already-triaged thread without a newer message, retains the
newer-after-triage and inbox-with-archived-sibling cases, and represents 11
included items as 10 review rows. `IMPORTANT` is an observed provider flag, not
classification authority. Suspected injection remains visible and cannot
propose forwarding, payment approval, external-recipient action, or an
out-of-namespace label. Label and draft changes expose only exact fingerprints;
complete normalized thread detail, AI-label values, draft text, handoffs, and
digest text remain in selected-work private derived review. There is no send
capability. The Email Automation declares a pack-owned connected compiler. It
expands exact selected label and draft actions into portable
`mail.labels.apply` and `mail.drafts.create` inputs, paired with same-authority
`mail.labels.read` and `mail.drafts.list` verification, retry-prohibited
ambiguity, and manual recovery when no inverse operation is declared. Label
v2 inputs carry exact message IDs, exact existing AI/ label names, and an
explicit false missing-label-creation flag; they never pass a thread ID as a
message ID or a label display name as a provider label ID. Draft inputs carry
an exact reply message ID and a deterministic idempotency key. The portable
read results use closed
provider-neutral provenance: provider, authority, `fixture|connected` source
kind, and a source-reference fingerprint, never a fixture path or provider
account identifier. Contained fixture checks prove exact comparison only.
The Email Context model separately declares provider-message,
provider-thread, and RFC822 identity meanings. It requires label application
to provider message IDs, treats configured values as label names rather than
provider label IDs, and prohibits implicit missing-label creation. Capability
and Automation validation must agree with that Context definition.
Codex declares a connected Gmail provider for label apply/read only. Static
translation maps exact message IDs and label names to
`apply_labels_to_emails(create_missing_labels=false)` and exact read-back to
`batch_read_email`; synthetic completion tests prove minimization, not live
provider behavior. Draft capability remains without a connected provider
because the installed connector cannot look up an exact idempotency key after
an ambiguous create. A label-only proposal subset can compile into the v2
verified-write-sequence batch and use the existing approval-v2, one-time start,
checkpoint, exact read-back verification, and read-only reconciliation path.
Draft or mixed selections fail before approval with the missing-provider
blocker. The private prepared-plan contract remains review-only and does not
make contained prepared Email changes executable. Synthetic local execution
proves state-machine and translator behavior only; it does not establish live
provider readiness, verification, or health.

Core revalidates a stored receipt's exact lock whenever it is inspected. A
changed or unavailable lock keeps the historical receipt visible but marks its
configuration applicability stale and replaces review guidance with an
unavailable stale-lock decision. Core validates adapter effect capabilities,
authorities, providers, and declared effects; context-step capabilities and
authorities; and every preview change capability against the exact Automation
pack and lock. Violations surface as `PREPARATION_ADAPTER_INVALID`.

Exact connected approval and start authority comes only from the canonical
private approval-request, approval, approval-consumption, and connected-
transaction checkpoint contracts. Studio may inspect their sanitized projection
and invoke the narrow canonical confirmation or start operations, but display
guidance is never authority. Studio writes no canonical artifacts and performs
no live provider calls or provider writes. Project Pulse and Meeting Intake
scenarios remain contained fixture evidence for deterministic automation
behavior. Their separate preparation adapters reuse the same typed fixture
context boundary to build private review receipts. Meeting Intake stops before
participant resolution and cited follow-up judgment. Project Pulse projects
the exact complete status-and-document review group, then exercises its separate
durable decision, proposal, approval, consumed start, connected checkpoint, and
verification path only in a contained provider. Scenario, preparation, and
connected-workflow evidence remain distinct claims and do not establish live
provider readiness, verification, or health.

Automation-level fixture maturity is a separate aggregate claim. It requires
one passed, automation-scoped suite record covering every distinct scenario
declared by that exact automation version. Each covered scenario must retain
its exact scenario fingerprint, linked run, passed source evidence, lock, host,
and dependency fingerprints. Removing or invalidating any required source
execution makes the suite unsupported. Supporting one automation this way does
not establish the maturity of its integrations, host adapter, or the complete
configuration.

The primary interfaces are:

- **Agent interface:** structured tools for inspecting, configuring, running,
  and developing the harness within the active run's authority.
- **CLI:** human-readable commands plus stable machine-readable output, exit
  states, and identifiers for scripting and diagnosis.
- **Graphical interface:** configuration builder, pack and dependency browser,
  run timeline, approval queue, health view, evidence explorer, and improvement
  candidate review.
- **Automation interface:** triggers and callbacks that start or resume the same
  runtime lifecycle without relying on an interactive terminal.

Starting with a CLI does not make the CLI the source of truth. A graphical
interface should call the same operations and display the same state, while the
CLI should expose structured output from those operations rather than
reconstructing state from prose.

### Interface consistency

Business rules, graph resolution, effect decisions, and health calculations
live in core. Interfaces may validate input for usability but cannot implement
different acceptance rules. Every mutation returns the resulting configuration
version, lock, run identifier, or evidence identifier so another interface can
observe the same change.

Contract tests exercise equivalent actions through each supported interface
and compare the structured result. For example, removing a pack through the UI,
CLI, or agent interface must produce the same dependency impact, configuration
diff, validation outcome, and new lock. A mismatch is an interface conformance
failure, not a documentation issue.

Interfaces can cache data for responsiveness only when they preserve version
and freshness information. Stale views are marked and refreshed from core;
they never become an alternative authority.

## Verification and health

Soter never represents “the checker passed” as proof that the harness works.
Verification is a set of scoped claims supported by inspectable evidence, and
health is recent evidence that configured systems achieve their promised
outcomes in real use.

Every result answers three different questions:

1. What claim was evaluated?
2. Which exact configuration, contracts, authorities, host, and integrations
   were evaluated?
3. What evidence supports the result, and is that evidence still applicable?

### Verification ladder

Verification progresses from cheap, deterministic checks toward contained live
behavior:

| Level | Purpose | Typical evidence |
|---|---|---|
| **Static validation** | Check manifest, schema, naming, required fields, and local invariants. | Deterministic diagnostics tied to content hashes. |
| **Graph validation** | Resolve dependencies, capabilities, authorities, effects, compatibility, and layer rules. | Resolved graph and conflict paths. |
| **Contract and fixture tests** | Prove deterministic components and adapters against controlled inputs. | Assertions, fixtures, typed results, and failure cases. |
| **Agent scenario evaluations** | Test judgment, instruction following, orchestration, exclusions, and pressure behavior. | Multiple trial artifacts, traces, evaluator results, and outcome distribution. |
| **Contained integration checks** | Verify authentication, schemas, provider behavior, and safe reads or writes. | Sandbox, test-tenant, read-only, or reversible effect evidence. |
| **Live canaries** | Prove a narrowly scoped real effect where simulation cannot establish the claim. | Pre-authorized effect identifiers, verification, cleanup, and rollback evidence. |
| **Runtime monitoring** | Establish that the configured system remains useful and reliable over time. | Outcome verification, failures, retries, drift, latency, and policy violations. |

Not every system requires every level. The applicable ladder depends on its
contracts, effects, maturity, host claims, and integration bindings. A level
that is not applicable is declared as such; it is not silently skipped.

### Verification claims and evidence

A verification claim identifies the promised behavior and its acceptance
criteria. Examples include “this configuration resolves without ambiguity,”
“this adapter rehydrates after compaction,” and “this automation creates one
correctly shaped record without duplicating an existing one.”

An evidence record contains at least:

- A stable evidence identifier and the claim being evaluated.
- The subject pack, configuration lock, complete relevant dependency set, and
  their versions or fingerprints.
- The host, host adapter, integrations, authority fingerprints, and
  behavior-relevant runtime versions.
- The evaluator or check definition and its version.
- The environment, containment level, inputs, trials, and acceptance threshold.
- Structured outcomes, artifacts, traces, external effect identifiers, and
  cleanup or rollback results.
- Failures, warnings, skipped work, and known limitations.
- Creation time, freshness policy, superseding evidence, and privacy scope.

`evidence/v2` makes applicability mechanically inspectable. In addition to the
human-readable claim, it carries a stable claim family, the exact graph
fingerprint, a complete locked dependency set, a strict host summary, and
structured integration and authority summaries. It is the sole generic evidence
contract; development migration receipts remain a separate purpose-specific
family.

Evidence is append-only or explicitly superseded. Editing an old result to
match a new claim destroys its value. A golden artifact is a useful comparison
baseline, not permanent truth and not a substitute for the evidence record
that explains how it was produced.

`evidenceMaturity` and an artifact's maximum verification level are claims
about intended trust and available evaluation capacity. They do not establish
maturity by themselves. A non-declared maturity claim applies only when a
passed evidence record names the exact pack or host subject and version, the
exact configuration lock and host adapter, the relevant transitive dependency
fingerprints, and an evaluator at or above the claim's required level. Copied,
stale, differently scoped, failed, or skipped evidence leaves the claim
unsupported and cannot raise **Verified**.

Core projects that decision with a stable result and reason code for every
selected pack and host. A complete configuration is Verified only when every
selected component has passed active evidence at its required level. Any
declared, missing, inconclusive, failed, stale, differently contained, or
run-scoped component keeps the aggregate unknown, failed, or stale as
appropriate. Kernel never promotes Verified from manifest labels or declared
test capacity alone.

### Result states

Each applicable claim reports one of these states:

- **Passed:** the acceptance criteria were satisfied by applicable evidence.
- **Failed:** the acceptance criteria were evaluated and not satisfied.
- **Stale:** evidence once applied, but a relevant dependency or freshness
  boundary changed.
- **Unknown:** the claim lacks enough evidence to determine a result.
- **Skipped:** the check was applicable but did not run, with a recorded reason.
- **Not applicable:** the claim does not apply under the resolved contracts.

`Skipped`, `unknown`, and `stale` are not aliases for passed. A roll-up uses the
most conservative state among required claims and identifies the exact blocking
path. Optional failures or unknowns may produce a degraded state, but the
unavailable behavior remains visible.

### Transitive freshness and invalidation

Verification freshness follows the contract graph, not only the file directly
named by a test. Evidence records the relevant transitive dependency
fingerprints. A change to a shared standard, context contract, template,
integration mapping, host adapter, evaluator, or external schema invalidates
the claims whose behavior may change.

The graph also limits invalidation: changing an unrelated pack does not make
all evidence stale. Every dependency edge states whether and how it affects
behavior, verification, or packaging so core can calculate the smallest honest
impact set.

Mutable external authorities define how freshness is established. Depending on
the contract, this may use a schema fingerprint, revision identifier,
conditional request, event, or bounded freshness interval. If freshness cannot
be established, the result is unknown or stale rather than assumed current.

### Scenario evaluation

Scenario evaluations originate from system promises and observed divergences.
A representative evaluation set includes:

- Expected successful behavior.
- Exclusions and cases another system should handle.
- Realistic pressure, ambiguity, and incomplete inputs.
- Integration failures, denied effects, retries, and recovery.
- Context conflicts, missing authorities, and stale dependencies.
- Rehydration after compaction, restart, or handoff where applicable.

Agent behavior is stochastic, so behavior claims use enough independent trials
to support their threshold. The evidence preserves each outcome and the
distribution; a single favorable transcript cannot stand in for repeated
behavior.

Evaluators consume structured artifacts and explicit rubrics. Judgment-based
evaluation is permitted where deterministic assertions cannot express quality,
but the evaluator, rubric, and rationale are versioned and reviewable. The
agent under test does not establish its own success merely by saying it is
done.

An improvement candidate reproduces its observed divergence before claiming a
fix. A new system that has no prior failure still proves its promised behavior
through representative scenarios; it does not need an artificial historical
failure to justify its existence.

### External and live verification

Live checks use the least effectful environment that can establish the claim:

1. Fixture or simulated provider behavior.
2. Local emulator, sandbox, or provider test tenant.
3. Read-only verification against the configured authority.
4. Reversible write with explicit cleanup and verification.
5. Narrow live canary under a declared effect policy.

A live premise is recorded and verified before the test relies on it. Writes
use idempotency and containment, record every external identifier, and verify
cleanup or compensation. A test that cannot safely contain its effects remains
manual or unsupported until the user explicitly authorizes an appropriate
canary.

Live verification complements contract tests and scenario evaluations; it does
not replace them. Provider availability, mutable data, and authentication make
live checks unsuitable as the only regression signal.

### Health model

The assembly states defined earlier remain separate:

- **Valid** describes declarations and graph consistency.
- **Ready** describes resolved dependencies and the ability to start.
- **Verified** describes applicable test evidence.
- **Healthy** describes recent real outcome evidence.

Health is evaluated per system and promised outcome over a declared observation
window. It may consider successful outcomes, failed outcomes, retries,
unverified external effects, drift, policy violations, and evidence freshness.
A last successful run does not erase later failures, and a pack's published
maturity does not guarantee the health of one user's configuration.

The configuration view rolls these states up without hiding their causes. For
example, an automation may be valid and verified but degraded because its
selected integration is unreachable, or ready but unhealthy because recent
runs completed without producing the promised external result.

### Diagnostics and doctor operations

Every diagnostic is structured and contains:

- A stable code, severity, and affected claim or contract.
- The subject and path through the dependency graph.
- Expected and observed state.
- Supporting evidence or the reason evidence is absent.
- A safe remediation, documentation reference, or next verification step.

Soter provides doctor operations at increasing containment levels:

- **Offline doctor** validates local definitions, configuration, locks,
  projections, graph resolution, and deterministic fixtures.
- **Connected doctor** checks authentication, reachability, external authority
  freshness, and read-only provider behavior.
- **Canary doctor** performs only the pre-authorized contained effects required
  to establish live write or dispatch behavior.

The user chooses or authorizes the level. If connected or canary checks do not
run, the report names the unverified claims; it cannot collapse to an
unqualified green result. CLI, UI, and agent interfaces render the same
diagnostics and evidence identifiers from core.

A connected provider probe identifies the exact configuration lock, provider
implementation and version, observation window, secret-reference identifiers,
authorities, and capabilities checked. It contains no credential values or
provider response bodies. Core derives readiness from these observations; an
integration cannot set the configuration's final readiness state itself.
Missing, expired, malformed, ambiguous, or wrong-lock probes remain failed,
stale, or unknown as appropriate. Read-only reachability can establish start
readiness, but it cannot establish write behavior, full automation
verification, or recent end-to-end outcome health.

A durable probe that fails is not collapsed into “missing.” Core can derive a
`provider-probe-attempt/v1` summary from the exact failed checkpoint. The
summary binds the lock, host, provider, declared probe scope, failed semantic
step, native route, failure category, checkpoint fingerprint, and a short
observation window. It excludes provider arguments, raw responses, credential
values, and the provider error message. A current failed attempt makes probe
completion fail and narrows only the readiness components justified by its
typed category—for example authentication, authorization, or route
unavailability. An expired attempt becomes stale; it is never durable proof
that a provider remains unhealthy. A mismatched or ambiguous attempt cannot
substitute for a completed probe.

An MCP server appearing in a host adapter is only a declared delivery route.
OAuth completion, current tool discovery, authority access, capability
translation, and provider health remain unknown until a connected probe for the
exact lock and provider establishes them. Repository configuration never stores
the OAuth credential itself.

### Gates and continuous verification

Verification gates attach to the action they protect:

- Configuration realization requires valid resolution and applicable
  migrations.
- Starting an automation requires readiness for its required contracts.
- Distributing a pack requires its declared release and conformance evidence.
- Promoting an improvement requires its regression and trial evidence.
- Granting greater autonomy requires effect-specific reliability and recovery
  evidence.
- Applying an upgrade requires a reviewed diff, successful migration checks,
  and a rollback plan where reversal is possible.

Local development and continuous integration run deterministic checks,
contract tests, fixtures, and contained agent scenarios appropriate to the
change. Connected checks, canaries, and runtime monitoring may run separately
because they require credentials, mutable authorities, or explicit effects.
Their absence is visible in the combined evidence view.

Verification mechanisms are themselves tested. Kernel validators require
contract tests and adversarial self-tests demonstrating that planted failures
are detected. A validator's own successful exit is evidence for one claim, not
proof of every behavior it is meant to protect.

Kernel accepts only the JSON Schema vocabulary it mechanically implements.
Unsupported assertion keywords are schema-definition failures rather than
silently ignored documentation. The implemented subset includes local
references with 2020-12 sibling semantics, `allOf`, discriminated `oneOf`,
`if`/`then`/`else`, object and array cardinality, string bounds and patterns,
numeric bounds, deep uniqueness, required properties, and closed-object
validation. Capability input and output schemas receive the same vocabulary
audit as top-level contract schemas. Extending this subset requires validator
behavior and adversarial self-tests in the same change.

### Monitoring and privacy

Runtime monitoring records structured events against the run envelope and
promised outcome. It captures enough information to diagnose failures and
support improvement without treating full prompts, source records, or secrets
as default telemetry.

Evidence remains local unless the user chooses to share it. Export and
contribution flows minimize and redact data according to the affected context
and integration contracts. Health calculations can use private evidence
without publishing the underlying records. If privacy constraints prevent a
claim from being externally reproduced, the shared result states that
limitation instead of overstating confidence.
