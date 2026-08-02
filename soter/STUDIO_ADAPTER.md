# Studio adapter and migration note

This note is the boundary between the provider-neutral Soter target and the
provisional Studio renderer. Studio is a projection. It does not own approval,
transaction, verification, reconciliation, compensation, proof, maturity, or
migration authority.

## Configuration preview

Continue using `configuration-preview/v1`; its renderer shape and read-only
Electron boundary are unchanged. Core now derives `draft.lockFingerprint` and
`draft.graphFingerprint` only by validating the complete in-memory candidate
through Kernel and resolving it through the canonical resolver. Studio must not
reconstruct a lock from `changes`, retain the candidate as authority, or expose
apply. Candidate diagnostics use the stable
`SOTER_CONFIGURATION_PREVIEW_*` namespace and may now cover any Kernel-owned
configuration invariant, including pack settings, bindings, authorities,
sources, scenarios, migrations, effects, and host compatibility.

Every preview, prepared-work request, and workspace-inspection item carries an
explicit `configurationBasis`. Use `tracked-contained` only for checked-in,
contained development templates and fixtures. Use `private-active` for
connected/operator work; Core then requires the private desired configuration
and its exact active lock and fails closed if either is missing, malformed, or
stale. Studio must submit this basis explicitly, render the returned fact, and
must never infer it from a path or silently fall back from `private-active` to a
tracked template.

Connected work now starts through one generic, explicit staging boundary.
Studio sends the selected Automation ID, configuration name,
`configurationBasis=private-active`, and the private operator input to its
sender-validated local Core operation. Core calls `prepareAutomationRun` with
`preparationMode=connected-acquisition` and the current host assertion; the MCP
equivalent is `soter_stage_automation_acquisition`. A successful sanitized
`prepared-work/v1` receipt has:

- `preparationMode=connected-acquisition` and
  `state=ready-for-acquisition`;
- one exact private review companion and one Core-owned durable run bound to
  the current active lock and host;
- no context snapshot, preview facts or collections, proposed changes,
  capabilities, effects, evidence, approval, or continuation request; and
- `resume.classification=unavailable`. Its `permittedNextAction` is display
  guidance, not provider-call or execution authority.

Omitting `preparationMode` retains the byte-compatible contained receipt
identity and the existing fixture-contained adapter. Core never selects the
connected mode from configuration basis, input shape, or provider identity.
Connected re-entry must match the same work and private input exactly; tracked
configuration, missing acquisition declarations, host drift, lock drift,
credential-like input, and tampered or missing private review material fail
closed.

Connected Context acquisition is selected-work-only. For Meeting Intake, Email
Triage, Task Capture, Organization Capture, Project Capture, Contact Capture,
Project Pulse, and Slack Conversation Review, Studio may send only the exact
`ready-for-acquisition` prepared-work ID to the
sender-validated prepare operation. It must not send or retain a lock path, run
path, mailbox query, provider snapshot, or provider identity as acquisition
selection. Core reloads the selected private review values and derives the
current private-active configuration, active lock, host, and exact Core-owned
run. Optional time and expected-host assertions do not become alternate
selection inputs.

Each runnable Automation declares one closed `operator.acquisition` binding:
the exact implementation module, callable prepare/finalize exports,
`containment=connected`, and `recordRequirements`. Any public or private
inspector additionally declares its exact closed schema as an owned definition
artifact. Kernel resolves every
declared `{ capability, recordTypes }` requirement against the selected
Integration mappings and private target settings. Missing or ambiguous target
IDs block the private configuration; Studio must not supply a target ID,
mapping, or fallback in the acquisition request.

CLI and MCP dispatch preparation and finalization through one provider-neutral
Core boundary using the exact Automation ID, work ID, and, for finalization,
checkpoint ID. The dispatcher imports only the current pack-declared module and
export and revalidates the work/run/checkpoint/lock/graph/host join. Its plan ID
is mechanically bound as
`plan.<automation-slug>.connected-acquisition.<prepared-work-suffix>`; another
plan for the same run cannot satisfy the acquisition boundary. A no-decision
review Automation may additionally declare paired `inspectExport` /
`inspectSchema` and `privateInspectExport` / `privateInspectSchema` operations.
Core validates every returned object against that schema, its self-fingerprint,
exact work/configuration/lock/graph/host binding, credential and private-state
path exclusion, and the shared no-authority/privacy invariants. The ordinary
inspector is the sanitized projection; the private inspector is an explicit
selected-work read. Neither inspection operation is continuation or execution
authority.

Before reporting finalization, Core reloads the exact durable private snapshot,
run, and completed checkpoint and requires the pack return to match all three
fingerprints and state paths. The callable finalization surface does **not**
return that private commit projection. It returns one closed sanitized receipt
containing only Automation/work/configuration identity, lock/graph/host,
checkpoint/snapshot/run IDs and fingerprints, lifecycle state, explicit
no-authority facts, and privacy exclusions. Snapshot values, raw provider
responses, and private state paths are structurally absent. Studio obtains any
declared private review values only through the separate selected-work private
inspector.

Automations with later connected transactions separately declare
`operator.connection.recordRequirements`. These cover the record-backed
precondition, effect, and read-back targets used after proposal and approval.
The split is intentional: acquisition facts do not imply write authority, while
configuration validation still prevents a work item from staging successfully
against a configuration that lacks its later exact transaction targets. Studio
does not edit, infer, or render provider target IDs from either declaration.

Studio must not originate generic capability or operation-plan preparation.
Those are internal Core primitives reached only through work-owned Automation
adapters; Studio may advance only the exact checkpoint/current-call pair they
emit. The separate fixed provider-probe preparation surface remains public. In
every private-active case the run must already be the exact Core-created
`0600` envelope under `.soter/state/runs`. Studio must not upload, author, copy,
or ask Core to adopt a repository run document. The resulting host request
remains a checkpoint-bound transport fact and grants no approval, write, retry,
readiness, verification, or health authority.

Connected-acquisition read recovery is a distinct Core family, not transaction
`checkpoint.resume`, `continuationRequest`, or a generic retry flag. The
canonical callable surfaces are `operator-acquisition-recover` and
`soter_recover_automation_acquisition`. They require exact Automation, work,
checkpoint, checkpoint fingerprint, failed step, failed call, and failed-call
fingerprint bindings. They can emit only one attempt-specific current call
after the current lock, graph, host, run, capability, provider, authority,
input, transport, arguments, read-only effects, failure code, and retry budget
all revalidate.

The durable private operation-plan checkpoint may carry `priorCalls[]` on a
recovered step and a closed `recoveries[]` ledger. A recovery entry contains
stable IDs and fingerprints, failure code, attempt and maximum-attempt facts,
the exact capability-contract fingerprint, `read|disclosure` effects, and
explicit no-provider-call/no-write/no-reusable-retry facts. It remains private
runtime state. Workspace inspection, fixtures, catalog views, and ordinary
prepared work must not expose resolved input, native arguments, provider
targets, responses, private paths, or recovery authority.

No Studio recovery action is canonical yet. Existing run progress may display
the failed observation and a later attempt-specific current call after refresh,
but a future button requires a sender-validated selected-work IPC over a closed
recovery projection. That projection must bind the exact failed checkpoint and
call fingerprints. `recovery.id` is only a locator; the separately returned
`currentCall` is the only executable host request. Studio must keep recovery
absent for pagination, non-read plans, non-eligible failures, unsafe or
exhausted retry declarations, approvals, and any connected transaction write.
Exact recovery re-entry requires the refreshed current checkpoint fingerprint
and is idempotent only while the named replacement call is still pending. Once
it completes or the plan advances, Core fails the stale request closed;
adapters must not substitute the later current call or infer another retry
action.

## Configuration transaction

Configuration apply is now a separate provider-neutral local authority family;
do not adapt it through connected provider approvals or a Studio-owned write.
The lifecycle is:

`configuration-change-plan/v1` -> `configuration-change-request/v1` ->
`configuration-change-confirmation/v1` -> one-time
`configuration-change-consumption/v1` ->
`configuration-transaction-checkpoint/v1`.

Studio should render only `configuration-change-inspection/v1`. The projection
provides exact plan, baseline/candidate/observed lock and candidate graph fingerprints, a stable
change-scope fingerprint, closed changed subjects with identifier-only nullable
before/after descriptors and fingerprints, request timing/state, confirmation actor/time, consumption state,
checkpoint state/phase/reason code, the derived configuration `sourceKind`
(`tracked-template` or `private-active`), and one derived `resume` object. It cannot
represent the candidate configuration, source inputs, settings, authority URIs,
secret references, raw before/after values, active-lock contents, or tracked/private
configuration paths.

The closed change category `lock` represents a governed refresh after the
canonical graph changes while the private desired configuration remains exact.
Its row exposes only the prior and candidate lock fingerprints plus fixed
identifier descriptors. Closed `resolution` rows identify which resolved pack,
capability, binding, source, authority, effect, setting, dependency, host,
resolver, or projection facts changed and expose only nullable fingerprints;
they never expose lock bodies or private values. The refresh still requires the
normal expiring request, exact confirmation, separately consumed start,
checkpoint, apply, verification, and recovery lifecycle. Studio must not treat
graph drift, the structurally valid historical lock, or the displayed rows as
issuance provenance, reusable authority, or readiness/health proof.

Map actions to Core without retaining authority in the renderer:

- plan: submit one complete private `configuration/v1` candidate through a
  sender-validated local operation; the controlled `configuration-preview/v1`
  draft remains read-only and cannot be promoted into apply authority;
- request: `beginConfigurationChangeRequest` with the exact plan ID and expiry;
- confirm: `confirmConfigurationChangeRequest` with exact request ID and local
  actor; confirmation does not start or write;
- start: `prepareConfigurationChangeExecution` consumes the confirmation once
  into one deterministic checkpoint;
- execute: `executeConfigurationChange` accepts only that checkpoint ID; and
- recovery: `recoverConfigurationChange` reconciles only that durable
  checkpoint.

`resume.permittedNextAction` is display guidance, never a continuation token.
There is intentionally no host/provider request in this family. Checked-in
`soter/configurations/*.config.json` documents are portable templates with
synthetic identifiers, and checked-in fixture locks are not active user locks.
Core atomically writes the exact desired document under private
`.soter/state/configurations` and its active lock under private
`.soter/state/configuration-locks`; it never overwrites the tracked template.
Once an active lock exists, missing, malformed, permission-drifted, or stale
private desired state fails closed without falling back to the template. A completed local apply validates
the deterministic host candidates in its lock but does not inspect or write
consumer host files, and does not
promote readiness, verification, health, proof, or migration. Keep all apply
controls disabled until the Studio main/preload boundary calls these exact Core
operations and preserves their coded failure envelope.

## Host realization

Host realization is not part of configuration apply and must not reuse its
confirmation, connected approval, or provider transaction state. Its exact
Core family is:

`host-realization-plan/v1` -> `host-realization-request/v1` ->
`host-realization-confirmation/v1` -> one-time
`host-realization-consumption/v1` ->
`host-realization-checkpoint/v1`.

Studio should consume only `host-realization-inspection/v1`. Available facts:

- exact plan ID/fingerprint, `createdAt`, separate `validUntil`, and derived
  applicability;
- private target identity represented only by `target.fingerprint`;
- host adapter, projection definition, generator, configuration, lock, and
  graph identifiers/fingerprints;
- ordered whole-file output ID, relative path, role, create/replace/remove
  action, mode, and nullable prior/candidate fingerprints;
- request, confirmation (including sanitized local actor ID), consumption,
  checkpoint, current output, per-output state, failure reason code, and one
  derived `resume` object; and
- claim boundaries: `localProjection` may become `passed`; host launch, tool
  discovery, authentication, provider reachability, connected behavior, and
  health remain `unknown`.

The inspection schema cannot represent the consumer-root path, canonical
template bytes, prior/candidate file contents, secret values, provider data, or
raw manifest documents. Do not recover those values from errors or private
plan state. If a selected private exact-file review is ever needed, it requires
a separate selected-work contract; it is intentionally unavailable here.

Core operations map directly:

- `prepareHostRealization` creates the private exact-root/file plan and no file
  effect;
- `beginHostRealizationRequest` adds the shorter confirmation expiry;
- `confirmHostRealizationRequest` records the local actor and decision only;
- `prepareHostRealizationExecution` consumes confirmation once and creates the
  durable checkpoint without touching host outputs;
- `executeHostRealization` accepts only the checkpoint ID; and
- `recoverHostRealization` reconciles only that checkpoint's exact prior or
  candidate fingerprints.

`resume.permittedNextAction` is display guidance, never authority. Enable an
execute action only for the separately returned exact checkpoint ID; enable
recovery only for that checkpoint. There is no raw confirmation token, generic
retry, adoption, force-overwrite, shared-output, managed-region, installer,
uninstall, host-launch, or provider action in version 1. Root development files
and legacy Claude trees are deliberately not managed without an exact manifest.

Stable failure families use `HOST_REALIZATION_*`. Important adapter codes
include `HOST_REALIZATION_UNMANAGED_COLLISION`,
`HOST_REALIZATION_MANAGED_DRIFT`, `HOST_REALIZATION_CROSS_HOST_COLLISION`,
`HOST_REALIZATION_MANIFEST_MALFORMED`,
`HOST_REALIZATION_MANIFEST_TAMPERED`, `HOST_REALIZATION_TARGET_DRIFT`,
`HOST_REALIZATION_SYMLINK_REJECTED`, `HOST_REALIZATION_PATH_ESCAPE`,
`HOST_REALIZATION_ACTIVE_LOCK_STALE`, `HOST_REALIZATION_PLAN_EXPIRED`,
`HOST_REALIZATION_OUTPUT_DRIFT`, `HOST_REALIZATION_VERIFY_FAILED`,
`HOST_REALIZATION_ROLLBACK_FAILED`, and
`HOST_REALIZATION_RECOVERY_STATE_UNKNOWN`. Transport adapters must preserve
the stable code while replacing thrown prose with fixed sanitized UI copy.

Studio should delete or reject any provisional host-output renderer,
confirmation store, reusable permission, force/adopt switch, retry flag, or
health promotion. Retain generic exact-scope, lifecycle, checkpoint, failure,
and claim-boundary components; map them to the fields above. Do not add host
realization UI until this canonical family and its contained fixtures are the
integration base.

## Distribution foundation

Distribution is an inspection-only Kernel family in this milestone. It has no
approval, confirmation, consumption, checkpoint, continuation, install,
configuration, host-realization, publication, or provider operation for Studio
to invoke. Build/verify occurs only through the contained local Kernel module
and CLI.

For one capsule, consume `pack-release-inspection/v1`:

- `release` supplies pack ID/version/layer, release stage, declared evidence
  maturity, summary, capsule digest, generator, manifest fingerprint, and exact
  source-input fingerprint;
- `integrity` is the exact local-byte result; `sourceComparison` independently
  distinguishes the three schema-bound state/reason pairs for matching,
  mismatching, and unexamined source trees;
- `provenance` supplies only source kind/revision, a remote-locator fingerprint,
  clean/dirty/unknown input state, and `contained-determinism-only`; Git
  revisions are commit-shaped while filesystem provenance has null revision and
  remote fields;
- `inventory` supplies normalized relative path, role, mode, byte count, and
  content fingerprint, never content bytes or a source root;
- `constraints` carries declared dependencies, capabilities, authorities,
  effects, base contract, and hosts;
- `evidenceReferences` carries exact fingerprints, applicability, freshness,
  privacy scope, and limitations but no evidence body; and
- `legal`, `trust`, `claims`, `authority`, `privacy`, and `limitations` are
  explicit boundaries, not badges to infer from other fields.

For a bundle, consume `bundle-inspection/v1`:

- `bundle` supplies its identity, digest, target base/hosts, and declared stage;
- `references[]` preserves each exact digest/version or compatible constraint,
  inclusion reason, compatibility limitations, and a discriminated result:
  selected always carries a release and blocked always carries null;
- `resolution` supplies resolved/blocked, a catalog and resolution fingerprint,
  and stable blockers; resolved has no blockers while blocked has at least one;
- `aggregate` mechanically projects selected pack IDs, declared dependency
  constraints, authority subjects, effects, and compatible hosts.

An absent dependency with `optional=true` remains visible in `aggregate` and
does not emit a blocker. If an optional dependency is selected, an incompatible
version still emits `BUNDLE_DEPENDENCY_VERSION_MISMATCH`. Studio must not infer
installation, configuration, or degraded runtime health from either case.

Important stable presentation codes are `PACK_RELEASE_BYTES_VERIFIED`,
`PACK_RELEASE_SOURCE_MATCH`, `PACK_RELEASE_SOURCE_MISMATCH`,
`PACK_RELEASE_SOURCE_NOT_EVALUATED`, `BUNDLE_BYTES_VERIFIED`,
`BUNDLE_RESOLVED`, `BUNDLE_BLOCKED`, `BUNDLE_RELEASE_MISSING`,
`BUNDLE_RELEASE_AMBIGUOUS`, `BUNDLE_DEPENDENCY_MISSING`,
`BUNDLE_DEPENDENCY_VERSION_MISMATCH`, `BUNDLE_BASE_INCOMPATIBLE`, and
`BUNDLE_HOST_INCOMPATIBLE`. A transport adapter must preserve codes while
discarding arbitrary error prose.

The schemas structurally exclude capsule bytes, raw source roots, credential
values, raw provider responses, private state, and active configuration values.
Independent verification also rejects credential/secret-reference material and
absolute local paths in projected metadata. Do not recover them from local files
or errors. `packageIntent` is discriminated: present carries an observed boolean
and fingerprint, absent carries nulls, and unavailable carries no boolean claim.
It is only a package signal, not a license or publisher assertion.
`publisher.state=unasserted`, `license.state=no-assertion`, and
`trust.state=unsigned-untrusted` are intentional. Publication, redistribution,
marketplace, legal sufficiency, publisher identity, and trust remain
`not-evaluated`; installed, configured, ready, verified, healthy, and network
availability remain `unknown`.

Studio may reuse catalog, constraint, fingerprint, blocker, limitation, and
claim-boundary components. It must not add Build, Fetch, Install, Upgrade,
Configure, Realize, Sign, Trust, Publish, Redistribute, Marketplace, or
Auto-update actions. A resolved bundle is not an executable plan, and neither
inspection is reusable authority. No provisional Studio distribution schema,
release resolver, legal inference, or hidden starter-setting model should be
retained.

## Pack installation

Pack installation is a separate Core transaction over already-local,
independently verified releases. It does not turn either Distribution inspection
into authority. The lifecycle is:

`pack-install-plan/v1` -> `pack-install-request/v1` ->
`pack-install-confirmation/v1` -> one-time
`pack-install-consumption/v1` -> `pack-install-checkpoint/v1`.

Studio consumes only `pack-install-inspection/v1`. It may render:

- plan ID/fingerprint, creation and expiry, target fingerprint, base/runtime
  fingerprints, scope fingerprint, and exact release identifiers, versions,
  capsule/manifest digests, stage, maturity, legal, and trust boundaries;
- optional bundle identity/digest/resolution fingerprint;
- dependency rows with consumer, dependency, constraint, optionality, selected
  version, `satisfied|degraded`, and stable reason code;
- ordered create/replace/remove effects with pack, artifact role, migration-role
  flag, nullable before/after fingerprints, reason code, and effect fingerprint;
- request window, confirmation actor/time, single-use consumption, checkpoint
  completed/current/pending steps, manifest state, blocker, and the derived
  `resume` object; and
- exact local-materialization/registry claims plus all unavailable authority,
  privacy, and proof limitations.

The schema cannot represent the target root, capsule or bundle path, capsule or
file bytes, raw managed manifest, private plan/checkpoint state, credentials, or
provider responses. Do not reconstruct them from error prose. Electron owns the
selected target and capsule paths in its trusted main-process call only; the
renderer submits and retains exact IDs and booleans. Use a fixed coded envelope:

`{ ok: true, inspection } | { ok: false, error: { code, message } }`

Map controls directly to Core:

- select private target/local capsules and call `preparePackInstall`;
- `beginPackInstallRequest` with the exact plan ID and expiry;
- `confirmPackInstallRequest` with the exact request ID and local actor;
- `preparePackInstallExecution` with the exact confirmation ID;
- `executePackInstall` with the exact checkpoint ID; and
- `recoverPackInstall` or `inspectPackInstall` with that same checkpoint.

Confirmation is not start authority. Start consumes it once, and display of
`resume.permittedNextAction` is not a continuation token. Keep Execute disabled
until Core returns the exact checkpoint. Keep recovery bound to that checkpoint;
never infer retry from state or prose. Stable failures use `PACK_INSTALL_*`,
including dependency missing/mismatch, downgrade, unmanaged/cross-pack
collision, managed/target drift, symlink/path/hardlink/mode rejection, plan or
request expiry, consumed confirmation, verification failure, rollback failure,
and recovery ambiguity.

Studio may retain its generic exact-scope, ceremony, checkpoint, blocker,
recovery, and claim-boundary components. Delete or reject any UI-owned install
plan, dependency resolver, confirmation store, reusable permission, path-based
renderer state, force/adopt switch, generic retry, fetch, uninstall, migration,
configure, host-realize, package-manager, network, publication, or trust action.
Fixture reconciliation order is: finalize Kernel/Core/pack declarations,
regenerate canonical fixtures once, map the typed inspection fixture, then run
Core, freshness, doctor, MCP, Studio, privacy, and packaged Electron gates.

Intentionally unsupported in v1: network acquisition, registry lookup,
uninstall, package-manager dependencies, configuration mutation, host
realization, migration execution, publication/signature/trust, and any action
derived solely from a bundle/release inspection. Completion proves local bytes
and managed ownership only; configured, ready, verified, and healthy remain
`unknown`.

## Canonical authority path

Use this lifecycle and no parallel confirmation store:

1. Use `createProposalConnectedBatch` to compile an exact Automation-proposal
   subset as `connected-operation-batch/v2` with
   `profile=verified-write-sequence`.
2. `beginProposalConnectedApprovalRequest` revalidates the current
   proposal/private companion and locked compiler, then persists the
   `approval-request/v1` family with exact lock, run, change set, batch, scope,
   and expiry.
3. `confirmProposalConnectedApprovalRequest` revalidates the compiler and
   complete selected private review, then persists `approval/v2`, embedding and
   confirming only that request.
4. `prepareDurableConnectedTransactionExecution({ approvalId })` atomically
   reserves `approval-consumption/v1`, creates its deterministic connected
   transaction checkpoint, then binds the consumption to that checkpoint
   fingerprint. Exact re-entry returns the same checkpoint.
5. MCP and hosts may execute or complete only the exact current checkpoint call
   or prepare the exact read-only reconciliation allowed by that checkpoint.

The CLI exposes the current boundary through `connected-approval-request`,
`connected-approval-confirm`, and `connected-transaction-prepare
--approval-id`; `proposal-connected-batch-preview` creates the v2 preview. No
host or MCP method accepts a raw approval document.

## Canonical operator projection

Studio should consume `operator-inspection/v1`, produced by
`inspectConnectedOperatorActivity` or `operator-inspect`. The projection
provides:

- activity: automation, work, run, convenience work state, and current family;
- configuration: configuration and lock paths, explicit
  `tracked-contained|private-active` basis, exact lock and graph fingerprints,
  host, and applicability;
- scope: exact change-set and batch IDs/fingerprints, effects, authorities,
  affected record IDs, and minimized change facts;
- approval: request ID/fingerprint/window, confirmation ID/fingerprint/time and
  actor, plus one-time consumption and bound checkpoint;
- capabilities: stable operation IDs, sequence, capability, authority, state,
  contiguous completed prefix, exact current stage/call, and pending IDs;
- blockers: stable reason code, technical summary, sanitized detail facts,
  required inputs, and required permissions;
- checkpoint: ID, fingerprint, state, and update time;
- verification: stable criterion IDs, per-criterion state/reason/fingerprint,
  and aggregate state;
- compensation: the immutable v2 fact `state=not-required`, empty step sets,
  and no restored-value fingerprint; v2 exposes manual recovery through
  blockers and read-only reconciliation rather than an executable compensation
  family;
- resume: `classification`, `reasonCode`, authoritative `reason`, and exactly
  one `permittedNextAction`;
- a separate checkpoint-bound `continuationRequest` containing the exact
  checkpoint/call reference and its fingerprint when Core can identify a
  permitted continuation; and
- separate proof, maturity, and migration families, all explicitly
  `not-evaluated` by this projection.

`scope.changes[].beforeFingerprint` and `scope.changes[].afterFingerprint` are
nullable sanitized fields. No raw before or after value is representable in the
contract. Studio may map these to `preview.changes[]` for display and must show
unavailable when either is null. The approval ledger is display-only; its
re-rendered facts do not become approval authority.
Adapters must preserve null as unavailable and must never backfill a fingerprint
from a private or raw value.

## Selected-activity private approval review

`operator-inspection/v1` must remain structurally unable to carry raw before or
after values. For the one activity selected in the trusted local operator UI,
call `inspectConnectedApprovalReviewMaterial({ root, requestId })` or the local
CLI `operator-approval-review --request-id REQUEST_ID`. The result is
`connected-approval-review-material/v1` and is derived from the existing
private approval request; Studio must not persist or reconstruct it.

The material provides exact request, run, lock, graph, host, change-set, and
batch references; full document and scope fingerprints; ordered operation and
input fingerprints; portable subject identity; exact private before,
proposed, and precondition values; verification and recovery fingerprints; and
derived lock applicability. `before=unavailable` with
`SOURCE_CONTEXT_UNAVAILABLE` is an explicit absence of review evidence, never
permission to infer a value. A create uses `absent-required` to display the
deduplication boundary. `completeness` is a review fact only.

Use a sender-validated selected-activity IPC envelope:

`{ ok: true, material } | { ok: false, error: { code, message } }`

Discard rejected-promise prose before it reaches the renderer. Map exact Core
codes `CONNECTED_APPROVAL_REVIEW_MATERIAL_MISSING`, `_MALFORMED`, `_TAMPERED`,
`_BINDING_INVALID`, and `_CREDENTIAL_REJECTED`; an adapter-only fallback may
use fixed sanitized copy. On any failure, suppress every private value while
keeping sanitized activity visible. Never aggregate the material into the
queue, workspace inspection, catalog, runs, proof, logs, diagnostics, or UI
fixtures.

The private result contains no approval decision, actor, permitted next action,
continuation request, host request, or provider argument. Rendering it does not
enable confirmation. Studio must still invoke the separate canonical
confirmation operation with the exact request ID, and Core independently
revalidates authority. The initial approval projector covers the current
portable CRM record create/update v1 family and the generic pack-compiled v2
operation shape. For v2, `before.state=not-required` with
`PRIOR_VALUE_NOT_REQUIRED` is distinct from
`absent-required/DEDUPLICATION_ABSENCE_REQUIRED`; Studio must not infer a prior
value. Email's older private prepared connected candidate plan remains
review-only and must not be adapted into an approval request.

`permittedNextAction` is not executable authority. Studio may enable recovery
only when `continuationRequest` is present, then must submit that exact
reference to Core. Core revalidates the current lock, checkpoint fingerprint,
current call or reconciliation state, and returns the separately stored exact
host request. The inspection projection omits provider arguments and cannot be
used as a bearer token.

## Delete, map, and retain

Delete from the Studio/Core proposal:

- `operator-confirmation.schema.json` and its confirmation fingerprint family;
- private `operator-confirmations` state and its read/write helpers;
- any Studio-owned approval validation or reusable confirmation object;
- any Studio-owned transaction lifecycle that duplicates the connected
  transaction checkpoint; and
- any `safeToRetry` field or inference from legacy recovery prose.

Map:

- Studio `beginOperatorApproval` to `beginProposalConnectedApprovalRequest`;
- Studio `confirmOperatorApproval` to `confirmProposalConnectedApprovalRequest`;
- Studio start to `prepareDurableConnectedTransactionExecution({ approvalId })`;
- Studio transaction inbox reads to `inspectConnectedOperatorActivity`;
- `confirmationId` to `approval.confirmation.id`;
- `confirmationFingerprint` to `approval.confirmation.fingerprint`;
- recovery display to the single canonical `resume` object; and
- exact-scope ledger fields to `configuration`, `scope`, `approval`,
  and `verification.criteria`.

Retain:

- Electron sandbox and private-state hygiene;
- renderer components, accessibility behavior, generic queue and lifecycle
  presentation, exact-scope ledger, capability tape, verification ledger, and
  a non-interactive `compensation=not-required` boundary;
- the shared Meeting Intake/Project Pulse presentation types; and
- sanitized UI-only fixtures, provided they are labeled non-authoritative and
  mapped to canonical projection facts before enabling actions.

Studio's provisional `operator-work/v1` may remain temporarily as a renderer
view model for pre-transaction preparation. It must not be persisted or treated
as transaction authority after adaptation. Transaction fields should be
replaced by `operator-inspection/v1`, not synchronized in two stores.

## Host runtime applicability

`host-runtime-inspection/v1` is a separate Core/MCP transport projection. If
Studio surfaces it, map the exact `runtime.state`, startup/current
fingerprints, `reasonCode`, `restartRequired`, and `permittedNextAction` fields.
Do not merge them into prepared-work, approval, checkpoint, proof, maturity, or
migration state. `continue` and `restart-host-runtime` are guidance, not
execution authority. When the runtime is stale, operational MCP requests are
structurally unavailable; Studio must not substitute retry, approval, or a
continuation request. No private state, provider response, credential value, or
provider action is representable in this inspection.

## Lifecycle label mapping

The twelve Studio labels are presentation coverage, not one canonical state
machine:

| Studio label | Canonical source |
|---|---|
| `draft` | Prepared-work family; not emitted by connected transaction inspection. |
| `preparing` | Prepared-work/context-read family; not emitted here. |
| `needs-input` | Prepared-work blocker family; not emitted here. |
| `ready-for-acquisition` | Connected `prepared-work/v1` staging receipt; exact private input and current host/lock are bound, but no provider call, snapshot, evidence, approval, continuation, readiness, or write authority exists. |
| `ready-for-review` | `prepared-work/v1` review receipt; no exact write batch or approval request exists yet. |
| `awaiting-approval` | `approval.state=awaiting`; no confirmation or consumption. |
| `approved-not-started` | `approval.state=confirmed` and `approval.consumption=null`; confirmation is not start authorization. |
| `running` | consumption is `started` and checkpoint is `requested`. |
| `blocked` | checkpoint is `needs-attention`; verification and read-only reconciliation remain separate. |
| `verification-failed` | `verification.state=failed`; checkpoint may permit an exact read-only reconciliation request. |
| `completed` | checkpoint is `completed` and its required verification criteria passed; proof maturity remains unevaluated. |

Unknown or pre-transaction prepared-work states should keep actions disabled
with Studio's `RESUME_DECISION_UNAVAILABLE` fallback and
`inspect-checkpoint`. Do not synthesize a canonical transaction decision for
them. The former Studio-only `rolling-back` and `rolled-back` labels are
unsupported by the connected v2 projection and must not be inferred from
manual recovery prose.

## Reason-code mapping

| Studio provisional code | Canonical treatment |
|---|---|
| `AUTHORITY_PERMISSION_MISSING` | Reserved unchanged for a future prepared-work blocker projection; a connected batch cannot reach approval with this blocker. |
| `REQUIRED_INPUT_MISSING` | Canonical prepared-work blocker; not emitted by connected transaction inspection. |
| `CHECKPOINT_STALE` | Canonical unchanged; emitted for exact-lock applicability drift. |
| `READ_AFTER_WRITE_MISMATCH` | Canonical unchanged; emitted by failed verification criteria. |
| `COMPENSATION_FAILED` | Unsupported by connected v2; map no state from this legacy/UI-only code. Use the exact checkpoint blocker or reconciliation reason instead. |
| `CONFIRMATION_EXPIRED` | Rename to `APPROVAL_REQUEST_EXPIRED`; request and approval share one window and there is no independent confirmation authority. |
| `RESUME_DECISION_UNAVAILABLE` | Studio fallback for an unadapted or prepared-work view only; canonical connected inspections always return a reason-coded decision. |

## Prepared-work and private review boundary

Core owns `prepared-work/v1`, `operator-input-summary/v1`, the private
`prepared-work-review-material/v1` input companion, and the selected-work-only
`prepared-work-derived-review-material/v1` envelope. The selected Automation,
not Core or Studio, owns derived item vocabulary through its declared
`automation-derived-review/v1` definition artifact. Studio must not persist a second
prepared-work, definition, or review store. The sanitized input summary permits a scoped
identifier value, while a private field cannot represent `value` at all;
`value: null` is invalid for that branch. The prepared receipt carries:

- preparation receipt identity for work, configuration, graph, lock, input
  contract, and the preparation checkpoint, including their fingerprints;
- privacy-safe input summaries that state presence and fingerprint behavior but
  withhold private values;
- the ordered context acquisition plan, expected outcomes, proposed capability
  sequence, effects, and readiness facts;
- stable input field ID, type, requiredness, label and description;
- authority and subject metadata, privacy class, fingerprint behavior,
  constraints, allowed values, and sanitized help/example metadata;
- stable ordered context-read identity, capability, authority, output or
  evidence fingerprint, freshness, and applicability;
- normalized contradiction and missing-evidence reason codes; and
- preparation evidence IDs, claims, and limitations.

Examples remain presentation aids, never domain authority. Preparation fixture
evidence must explicitly say that it establishes neither connected readiness,
execution, external write verification, proof maturity, nor migration state.
The preparation receipt also states mechanically that it grants no approval,
one-time start consumption, execution, or write authority.

Exact private values live only in
`.soter/state/prepared-work-review/<work-id>.json`, created atomically with a
private directory and `0600` file mode. The companion binds the final prepared
receipt fingerprint, preparation checkpoint ID/fingerprint, automation
ID/version, configuration name and lock fingerprint, and input-contract
fingerprint. Its fields remain in declaration order and use two closed branches:

- omitted: `id`, `exposure`, `state=omitted`, and `fingerprint=null`, with no
  value property; or
- provided: the same identity facts plus `state=provided`, exact fingerprint,
  and `reviewValue`.

`reviewValue` is intentionally representable only in this private contract.
Workspace inspection, prepared-work projection, evidence, diagnostics,
fixtures, and canonical artifacts cannot contain it. The companion has no
approval, continuation, provider-call, permitted-action, or write-authority
fields.

Map Studio's sender-validated `getPreparedWorkReview({ workId })` to
`inspectPreparedAutomationReviewMaterial({ root, workId })`. A successful read
returns `prepared-work-review-material/v1` directly. Core overwrites its
`applicability` field with the derived `current|stale` value; applicability is
the only field excluded from the immutable material fingerprint, so drift does
not rewrite private state. Request this operation only for the selected private
work item. Do not aggregate it into the workspace snapshot.

Core continues to throw stable coded errors. Because Electron IPC does not
reliably preserve custom `Error` properties, the sender-validated main-process
handler may project this one call into the closed transport result
`{ ok: true, material } | { ok: false, error: { code, message } }`. The failure
message must be sanitized, and neither branch grants authority. This envelope
is a Studio transport type, not a replacement canonical contract.

Map failures by `error.code`, never by prose:

| Core code | Studio treatment |
|---|---|
| `PREPARED_REVIEW_MATERIAL_MISSING` | Show private review unavailable; keep sanitized queue work visible. |
| `PREPARED_REVIEW_MATERIAL_MALFORMED` | Suppress all values and report invalid private review state. |
| `PREPARED_REVIEW_MATERIAL_TAMPERED` | Suppress all values and report fingerprint tampering. |
| `PREPARED_REVIEW_MATERIAL_BINDING_INVALID` | Suppress all values and report receipt/checkpoint/lock/input binding failure. |
| `PREPARED_REVIEW_MATERIAL_CREDENTIAL_REJECTED` | Reject preparation or review; never display or persist the credential-like value. |
| `PREPARED_REVIEW_MATERIAL_MISMATCH` | Reject exact re-entry; never replace the existing private values. |
| `PREPARED_REVIEW_MATERIAL_WRITE_FAILED` | Report local private-state write failure; no review surface is available. |

Private review material remains display-only. Task Capture, Organization
Capture, Contact Capture, Feature Capture, and Feature Definition can derive a
selected review batch and private
authority-free connected candidate plan, but any future write still requires a
separately supported transaction batch, expiring approval request, exact
confirmation, one-time consumption, and connected checkpoint.
Project Capture is stricter: its candidate remains visible in selected-work
private review, but `COMPLETE_PROJECT_READBACK_UNAVAILABLE` makes its action held
and leaves no selectable batch or connected plan.

Derived private review is a separate sender-validated selected-work call to
`inspectPreparedAutomationDerivedReviewMaterial({ root, workId })`. Use the same
closed IPC transport convention as input review. Map its stable failure codes
by exact `PREPARED_DERIVED_REVIEW_MATERIAL_*` suffixes: `MISSING`, `MALFORMED`,
`TAMPERED`, `BINDING_INVALID`, `CREDENTIAL_REJECTED`, `MISMATCH`, and
`WRITE_FAILED`. A failure suppresses derived values but does not hide the
sanitized queue item. Never aggregate the companion into workspace inspection,
catalog, runs, proof, logs, diagnostics, or adapter fixtures.

### Task Capture projection

The canonical workflow is `automation.task-capture` in configuration
`task-capture`. Studio should retain its generic prepared-work renderer and map
the input declaration in exact order:

| Field | Type | Required | Exposure | Meaning |
|---|---|---:|---|---|
| `title` | `string` | yes | private | Exact task title; available only through selected-work private review. |
| `project` | `reference` | yes | identifier | Exact portable Project record identity. It is required because the selected Tasks policy requires a project. |
| `assignee` | `enum` | no | identifier | The only value is `self`; Core resolves the authenticated current workspace user. Omitted means unassigned. |
| `nextActionOn` | `date` | no | private | Real pinned `YYYY-MM-DD` calendar date; impossible dates are `INPUT_INVALID`. |
| `context` | `enum` | no | identifier | `Internal`, `Service`, `Project`, or `Client`; omitted becomes `Project` for the required project relation. |

The prepared preview kind is `task-capture-preview`. A successful contained
review exposes policy, project, default status, context, duplicate-count,
date-presence, and assignee-binding facts plus one exact `task-capture-task`
collection and row. A non-conflicting row has one proposed `task-create` action
bound to `tasks.records.create`, `beforeFingerprint: null`, and a non-null same-
row private-item `afterFingerprint`. Raw before/after values, title, and date
are not representable in the sanitized work. `project-context-conflict` or
`duplicate-candidates-observed` holds that action, sets
`changeFingerprint=null`, and produces no proposed change. These IDs are review
facts, not lifecycle reason codes.

The selected-work derived companion has kind `task-capture-derived-review` and
one `task-create` item in declared order: `title`, `status`, `context`,
`projectUris`, `assigneeIds`, and `nextActionOn`. Optional assignee and date
values are empty string lists when omitted. Request them only through the
selected private review boundary.

The generic selected-batch APIs still accept the one exact proposed prepared
action. Their `prepared-connected-plan/v1` remains
`state=blocked-review-only`, `executable=false`, and `authority=none`; Studio
must not upgrade it into a transaction source.

The executable candidate comes from a separate durable path. Core exposes:

- `operator-acquisition-prepare` / `soter_prepare_automation_acquisition`;
- `operator-acquisition-finalize` / `soter_finalize_automation_acquisition`;
- `task-capture-decision-inspect` and `-commit` / matching MCP decision tools;
- `task-capture-proposal-inspect`, `-commit`, and `-material` / matching MCP
  proposal tools.

Connected acquisition emits only exact provider calls for the policy identity,
current normalized Task schema, project, optional current-user identity, and
bounded duplicate candidates. The schema observation is required before a
decision can become approval-capable. The configured Integration must translate
every current Task status and context option through a closed private
`configured-bijection`; provider-native option labels remain private
configuration and never enter this adapter, workspace inspection, evidence, or
fixtures. It pauses before decision, proposal, approval, or write.

The governed mapping artifact declares
`valueMapping: "configured-bijection"`. Private configuration supplies exact
closed scopes shaped as `{mapping, recordType, field,
mode: "exact-bijection", entries: [{portable, provider}]}`. Every choice scope
required by the selected Automation must be present and complete; tracked
templates cannot carry `optionMappings`. Kernel reports definition and private
configuration failures as `SOTER_PROVIDER_MAPPING_VALUE_TRANSLATION` and
`SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT`. A current provider option-set mismatch
instead fails schema acquisition before decision or authority with a sanitized
host-call conflict or validation reason.

The sanitized decision inspection contains state, issue codes, counts, and
fingerprints only. Its exact fields are `snapshot.{id,fingerprint,containment}`,
`preparedWork`,
`outcome.{state,issueCodes,duplicateCandidateCount,projectFingerprint,taskAfterFingerprint}`,
and `authority.{state,reasonCode}`. Schema availability and its fingerprint are
sealed decision facts, not additional inspection fields. Its optional `at` is
the current inspection time and defaults to now. Core preserves the historical
fingerprint projection, but a required finite-age Context observation that is
no longer current forces
`outcome.state=needs-input` with `TASK_CONTEXT_STALE`; Studio must not keep
displaying the historical result as ready. `TASK_STATUS_VALUE_UNAVAILABLE` or
`TASK_CONTEXT_VALUE_UNAVAILABLE` means the current normalized schema cannot
represent the exact portable Task proposal. Either issue, a duplicate, or a
context conflict yields `needs-input`; Studio must not offer a proposal action.
Decision commit revalidates at its supplied current time; a stale attempt writes
no decision. `TASK_CONTEXT_STALE` is the stable inspection issue code, not a
separate coded commit error, so Studio must decide whether commit is offered
from the current inspection rather than parse thrown prose.
Changing a private option mapping changes the exact configuration and lock
fingerprints, so prior work, requests, approvals, starts, and checkpoints do not
remain applicable. A ready decision deterministically creates one
`automation-proposal/v1` with review kind `task-capture-review` and private
selected-proposal material. Neither object grants authority.

Submit the proposal's one exact proposed action through the generic
`proposal-connected-batch-preview` boundary. Core returns
`connected-change-set/v2` and `connected-operation-batch/v2` with
`profile=verified-write-sequence`; the preview still executes zero provider
calls. Task supports one exact `tasks.records.create`, one same-authority
duplicate-absence precondition, and mandatory `tasks.records.read` verification.
Its provider is `provider.integration.notion.mcp` under
`authority.tasks.instance`, ambiguity code is `TASK_CREATE_AMBIGUOUS`, write
retry is prohibited, and delete/automatic compensation is unavailable.

The existing generic approval desk then applies unchanged: expiring exact
request, selected-activity private approval material, exact confirmation,
single-use start consumption, and `connected-transaction-checkpoint/v2`.
Batch creation, request creation, confirmation, and an unconsumed or reserved
start each re-evaluate every finite-age Context observation at that boundary's
current timestamp. `PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE` creates no new
request, approval, consumption, checkpoint, or provider call. Already-started
checkpoint recovery remains bound to the durable checkpoint instead of
recreating proposal authority.
`checkpoint.resume` remains display guidance; only the separate exact current
call or continuation request can be executable authority. Render precondition,
write, verification, needs-attention, and read-only reconciliation from the
canonical checkpoint families. Do not add a Task-specific approval, retry,
start, or transaction state.

Contained evidence proves this local sequence through normalized create and
read-back responses. It does not prove live Notion authentication, permission,
provider conformance, readiness, verified live behavior, or health. Raw title,
date, provider-person ID, native provider option labels, native provider
arguments/responses, and before/after values remain excluded from sanitized
inspection and fixtures. Exact provider-call translation is prepared and
validated before a one-time start consumption can be reserved; translation
failure creates no checkpoint or provider write.

### Project Capture projection

The canonical workflow is `automation.project-capture` in configuration
`project-capture`. Render its declared fields in exact source order: private
`name`, private `organizationShortName`, identifier `organization` reference,
identifier `creationProfile`, identifier `projectType`, private `overview`, the
five ordered milestone lists, optional private `startDate`, and optional private
`targetEndDate`. Private values are available only through the selected-work
review operation. Manager and client-contact assignment are intentionally
unavailable: Studio must not render a manager input, accept a provider-person
ID, or infer a CRM Person relation.

The contained preview kind is `project-capture-preview` with one
`project-capture-project` collection and one `project-create` row. Core
intersects the candidate Project Type with policy and current schema, pins date
order, prepares a private candidate body supplement, and checks a bounded
exact-name duplicate set. A policy-, profile-, schema-, organization-, date-,
and duplicate-clean candidate has one `held` action with
`COMPLETE_PROJECT_READBACK_UNAVAILABLE` and zero proposed changes. Core currently
supports only one verification observation per operation, so it cannot prove
both the mapped Project fields and private body. Any contradiction remains a
held action under its more specific preparation reason. `manager-reference-bound` and
`client-contact-state` remain explicit `unavailable` facts in either case.

The selected-work companion is `project-capture-derived-review` with one
`project-create` item whose ordered fields are `name`, `organizationShortName`,
`creationProfile`, `projectType`, `status`, `organizationUris`, `startDate`,
`targetEndDate`, `body`, `milestoneLines`, and `workItemLines`. No manager or
client-contact provider identity is representable.
The body and milestone lines are private candidate review material, not
provider-template proof. The companion carries no approval or transaction
authority.

The separate durable review path uses:

- `operator-acquisition-prepare` /
  `soter_prepare_automation_acquisition` and
  `soter_finalize_automation_acquisition`;
- `project-capture-decision-inspect` / `-commit` and matching MCP tools;
- `project-capture-proposal-inspect` / `-commit` for one private held proposal.

Connected acquisition grounds exact policy, complete portable creation-profile
set, current schema, organization, and duplicate candidates, then pauses. It
never invokes `workspace.identity.read`. A ready decision produces one exact
private proposal whose create action is held with
`COMPLETE_PROJECT_READBACK_UNAVAILABLE`. The active graph declares no
Project-create capability, provider binding, or connected compiler.

Studio must keep batch, approval, confirmation, start, checkpoint, execute,
retry, reconcile, and recovery controls absent for Project Capture. Contained
evidence proves only normalized local acquisition, decision, private review,
and absence of authority. It does not prove a create, field or body read-back,
live Notion authentication, permission, provider behavior, readiness,
connected verification, or health.

### Organization and Contact Capture projection

The canonical workflows are `automation.organization-capture` in configuration
`organization-capture` and `automation.contact-capture` in configuration
`contact-capture`. Studio should mechanically render their declared input
contracts in source order. Every Organization input (`name`, `description`,
`website`, `twitter`, `aliases`, `organizationType`, and `tags`) and every
Contact input (`name`, `email`, `organizationName`, `role`, `status`,
`disposition`, `authority`, `tags`, `telegram`, `signal`, `github`,
`timezoneUtc`, and `source`) is private. Values therefore belong only in the
selected-work private review operation, never queue, catalog, workspace
inspection, evidence, logs, or sanitized fixtures. Types, requiredness,
constraints, descriptions, and examples come from `automation-input/v1`; the
renderer must not maintain a second field vocabulary.

The prepared preview kinds are `organization-capture-preview` and
`contact-capture-preview`. Each contains one review collection with one exact
create row. A proposed row is bound to `crm.records.create`, has
`beforeFingerprint: null`, and has a same-row private-item
`afterFingerprint`. Duplicate candidates hold the row and remove the proposed
change. Organization classification that cannot be grounded in the current
observed schema also holds the create. Contact requests absent from the current
Role, Status, Disposition, Authority, or Tags option sets are omitted and
reported as stable `CONTACT_*_NOT_IN_CURRENT_SCHEMA` facts; those optional
omissions do not fabricate provider options or automatically block an otherwise
reviewable create. An unresolved or ambiguous optional organization relation
remains empty and is reported. Exact email-or-name duplicates block Contact
creation.

The selected-work derived companions are
`organization-capture-derived-review` / `organization-create` and
`contact-capture-derived-review` / `contact-create`. Studio may render their
declared ordered fields through the same selected-work sender-validated private
boundary used by Task Capture. The companion contains exact private proposed
values and search/resolution facts but grants no approval, start, continuation,
provider-call, or write authority.

Both Automations then use their separate durable Context, decision, and
proposal operations. The sanitized decision and proposal inspections expose
only state, issue codes, counts, bindings, and fingerprints; private values stay
in selected-proposal material. Submit the one exact proposed create action
through the generic `proposal-connected-batch-preview` operation. The resulting
batch uses `verified-write-sequence`: exact duplicate-absence precondition,
one `crm.records.create`, and mandatory `crm.records.read` verification through
`provider.integration.notion.mcp` under `authority.crm.instance`. Preview
executes zero provider calls.

The generic v2 approval, single-use start, checkpoint, verification, and
reconciliation surfaces apply unchanged. Organization ambiguity uses
`ORGANIZATION_CREATE_AMBIGUOUS`; Contact ambiguity uses
`CONTACT_CREATE_AMBIGUOUS`. Automatic delete/compensation is unavailable and is
reported as `ORGANIZATION_DELETE_NOT_DECLARED` or
`CONTACT_DELETE_NOT_DECLARED`. These codes mean needs-attention or manual
recovery, never retry authority. Contained evidence proves deterministic local
translation and read-back only; live Notion authentication, provider behavior,
readiness, connected verification, and health remain unknown.

### Feature Capture and Feature Definition projection

The canonical preparation-only workflows are `automation.feature-capture` in
configuration `feature-capture` and `automation.feature-definition` in
configuration `feature-definition`. Both use the generic prepared-work renderer,
selected-work private input review, and pack-owned derived-review boundary. Studio
must not create Product-specific approval, continuation, transaction, or fallback
state.

Feature Capture fields are declared in this order: private `name`, private `why`,
identifier enum `whyState`, identifier enum `featureType`, private `summary`, private
`sectionTwo` string list, optional private `currentState`, optional private
`relationships` and `openQuestions` string lists, and optional private `area` and
`priority`. Render types, bounds, enum options, and requiredness from the declaration.
The configured Product target and current schema are authority; Studio must not offer
embedded-board discovery or invent Type, Area, or Priority options.

Its preview kind is `feature-capture-preview`, with one collection and one
`feature-create` row. A reviewable row names `product.records.create`, has
`beforeFingerprint:null`, and binds its non-null after fingerprint to the same-row
private derived item. `FEATURE_WHY_PROVISIONAL_CONFIRM_REQUIRED`,
`FEATURE_TYPE_NOT_IN_CURRENT_SCHEMA`, `FEATURE_AREA_NOT_IN_CURRENT_SCHEMA`,
`FEATURE_PRIORITY_NOT_IN_CURRENT_SCHEMA`, or
`FEATURE_DUPLICATE_CANDIDATE_OBSERVED` holds the action and removes the proposed
change. Exact name, why, body, option values, and duplicate identities appear only in
the `feature-capture-derived-review` / `feature-create` companion.

Feature Definition fields are exact identifier `feature`, private `whatItIs`, required
private string lists `scopeIn`, `scopeOut`, and `doneWhen`, optional private
`openQuestions`, and private boolean `statusChangeRequested`. Its preview kind is
`feature-definition-preview`, with one `feature-definition` row naming
`documents.content.update` only when the exact feature is Planned and the current body
matches the governed Product spine. Exact current/proposed bodies, Description, status,
and scope values live only in the `feature-definition-derived-review` companion.
`FEATURE_STATUS_CHANGE_EXCLUDED_FROM_DEFINITION` is a visible non-blocking exclusion;
it never becomes a status write. `FEATURE_NOT_PLANNED` or an unsupported body/template
holds the body action.

Both packs deliberately omit proposal and connection declarations. A generic selected
review batch remains display-only, and connected-plan compilation must fail closed.
Studio must keep approval, confirm, start, execute, retry, reconcile, and recovery
controls absent. It must not fall back to the removed Claude guides, direct Notion
calls, or fixture writes. Contained evidence proves only exact local preparation and
privacy; live provider authentication, permission, conformance, readiness,
verification, and health remain unknown.

### Repository Review projection

The canonical preparation-only workflow is `automation.repository-review` in
configuration `repository-review`. It uses the generic prepared-work renderer,
selected-work private input review, and the pack-owned
`repository-review-derived-review` contract. Studio owns no repository analysis,
candidate selection, duplicate rule, Product authority, or handoff execution.

Render input fields in declaration order: private URI `repositoryUri`, required
identifier enum `scope` whose only current value is `product-capabilities`, and optional
private string `focus`. Private values remain absent from queue rows, workspace
inspection, evidence, diagnostics, and checked-in prepared-work projections.

The preview kind is `repository-review-preview`. Its one complete
`repository-capability-review` collection contains stable opaque candidate rows at
group `product-capability`. New rows carry a `feature-capture-handoff` action with
state `handoff` and reason `REPOSITORY_FEATURE_HANDOFF_READY_FOR_REVIEW`; this is a
review fact, not a command to create Feature Capture work. An exact-name Product match
adds `REPOSITORY_FEATURE_DUPLICATE_OBSERVED`, holds the action with
`REPOSITORY_FEATURE_DUPLICATE_REVIEW_REQUIRED`, and must never be rendered as a new
candidate.

Selected-work private derived items have kind `feature-capture-handoff` and fields in
this exact order: `candidateId`, `name`, `why`, `summary`, `currentState`,
`evidencePaths`, `duplicateCandidateIds`, and `targetAutomation`. These values may be
shown only inside the existing private local review boundary after exact work,
checkpoint, lock, input-contract, and material validation. They must not be copied into
the sanitized collection or a general catalog.

The pack has no proposal adapter, connection compiler, proposed changes, approval
request, continuation request, or executable recovery action. Keep confirm/start/write
controls absent. Tooling-page creation, repository mutation, Feature Capture work-item
creation, Product writes, and connected repository access are intentionally
unavailable. Contained fixture evidence proves no live filesystem/Git access, provider
identity, Product write, readiness, verification, or health.

### Project Page Review projection

`automation.project-page-review` is a read-only selected-Project inspection. Its
connected acquisition reads the exact configured Project capture, Project work,
and Task work policy definitions, the exact configured Project template, the
selected Project, the Task records actually returned for that Project's exact
Task relation identities, and the current Project document. It creates no
proposal, action, approval request, confirmation, continuation request, provider
write, retry authority, or canonical mutation.

The sanitized
`soter://contracts/project-page-review-connected-inspection/v1`
`taskCoverage` is the mechanically derived coverage boundary:

- `expectedCount` is the number of unique Task identities declared by the exact
  normalized Project;
- `observedCount` is the number of unique, in-scope normalized Task records
  actually returned;
- `unavailableCount` is the exact set difference;
- the three identity-set fingerprints bind those exact sets without exposing
  Task identities; and
- `state=complete` is valid only with
  `PROJECT_TASK_COVERAGE_COMPLETE` and zero unavailable identities.

An exact strict subset remains reviewable only as
`state=incomplete` with `PROJECT_TASK_COVERAGE_INCOMPLETE`. That reason is a
hard operator-attention finding. Studio must show the exact counts and must not
render the review as current, complete, supported, approval-ready, retryable, or
executable. Duplicate returned identities and returned identities outside the
Project relation fail closed rather than being collapsed or substituted.

The private
`soter://contracts/project-page-review-connected-review/v1` selected-work view
adds only the unavailable Task **identity fingerprints**. It never exposes the
raw unavailable identities. Its `tasks` array contains only actual normalized
Task output, and the durable Task snapshot likewise contains no synthesized
rows for unavailable identities. The sanitized inspection cannot represent any
unavailable identity list. Neither view represents raw Task or Project URLs,
page bodies, provider responses, configuration targets, or an executable
action.

The zero-Task case is separately exact: the Tasks acquisition step is skipped,
the private snapshot omits the Task collection entry, and coverage is complete
at `0/0/0`. Contained and connected tests establish only deterministic
normalization, strict coverage accounting, selected-work privacy, and
no-authority behavior. They do not establish live Notion completeness,
readiness, connected verification, health, or permission to repair the page.

### Project Pulse projection

The canonical workflow is `automation.project-pulse` in configuration
`project-pulse`. Retain the generic prepared-work renderer and map the input
declaration in exact order:

| Field | Type | Required | Exposure | Meaning |
|---|---|---:|---|---|
| `project` | `reference` | yes | identifier | Exact authoritative project resource whose promoted tasks and document are reviewed. |
| `statusDate` | `date` | yes | private | Exact calendar date; relative date phrases are invalid. |
| `visibility` | `enum` | yes | identifier | `Internal`, `Agent`, or `Public`, as constrained by the selected policy. |
| `health` | `enum` | yes | identifier | Required human judgment: `on-track`, `at-risk`, or `off-track`; Core checks contradictions and never infers it from task counts. |
| `healthMilestones` | `string-list` | no | private | Exact milestone titles whose health tags should change or clear; each supplied title must resolve once. |
| `operatorGoal` | `string` | no | private | Optional local review note; never present in sanitized work. |

The prepared preview kind is `project-pulse-preview`. It contains one complete
`project-pulse-changes` collection with deterministic document and status rows.
The status facts distinguish exact work-item/promoted-task progress from the
operator-owned health judgment. Studio must not calculate progress, infer health,
or interpret milestone text itself.
The document action is proposed only when governed milestone lines change;
otherwise it is held with `PROJECT_MILESTONE_TAGS_CURRENT`. The status-create
action is proposed only when the analysis is ready. Any issue holds both write
authority paths and appears as a stable `PROJECT_*` contradiction. Sanitized
changes contain only nullable before/after fingerprints. Exact milestone lines,
status headline, summary, date, visibility, and project identity exist only in
the selected-work `project-pulse-derived-review` companion.

The executable candidate comes from a separate durable Context, decision, and
proposal path. Core exposes the generic CLI operations
`operator-acquisition-prepare`, `operator-acquisition-finalize`,
`project-pulse-decision-inspect`, `project-pulse-decision-commit`,
`project-pulse-proposal-inspect`, `project-pulse-proposal-commit`, and
`project-pulse-proposal-material`. A Studio adapter may invoke the same trusted
Core functions through sender-validated selected-work operations, but it must
not reconstruct the decision, proposal, private values, or transaction batch.
The sanitized decision inspection carries state, issue codes, and fingerprints;
the selected proposal material remains private and grants no authority.

Submit every proposed action from the durable proposal to the generic
`proposal-connected-batch-preview` boundary. Project Pulse deliberately rejects
a partial subset with `CONNECTED_COMPILER_INVALID`; when milestone tags change,
the only valid order is `action.project-pulse.document-update` followed by
`action.project-pulse.status-create`. If no document change is required, the
single status-create action is the complete set. The preview performs no
provider call and creates no approval.

The selected-activity private approval review maps document prior state to
`before.state=provided` with `SOURCE_CONTEXT_BOUND`; status creation maps to
`before.state=absent-required` with `DEDUPLICATION_ABSENCE_REQUIRED`. Exact
request, confirmation, one-time start consumption, and
`connected-transaction-checkpoint/v2` remain the shared authority. The
checkpoint orders exact document precondition/update/verification before exact
status absence/create/verification. The sequence is not externally atomic.
Map `PROJECT_DOCUMENT_UPDATE_AMBIGUOUS` and
`PROJECT_STATUS_CREATE_AMBIGUOUS` to needs-attention with manual reconciliation;
never offer automatic write retry or imply that the later status effect rolled
back an already verified document update. Recovery reasons are
`PROJECT_DOCUMENT_RESTORE_NOT_AUTOMATED` and
`PROJECT_STATUS_DELETE_NOT_DECLARED`.

Contained evidence proves deterministic local acquisition, compilation,
approval consumption, normalized provider translation, and read-back
verification only. It does not prove live Notion authentication, permission,
provider conformance, readiness, verified live behavior, health, or external
atomicity. Studio must not add Project-specific approval, start, retry,
continuation, compensation, or transaction authority.

### Email triage projection

The canonical workflow is `automation.email-triage` in configuration
`email-triage`. Render the input declaration in exact order: private required
`query`, required one-option identifier enum `scope`, and optional private
`focus`. Do not add an exact-thread array control; list cardinality is
intentionally unsupported in v1.

The sanitized preview kind is `email-triage-review`. Render
`preview.collections[]` mechanically from `labelKey`, exact coverage counts,
rows, `representedCount`, group, attention, disposition, reason codes, flags,
closed actions, and fingerprints. Do not expect provider IDs, addresses,
subjects, bodies, or human label values in this projection. `effect` is the
canonical category; `capability` is the bound operation. Handoffs carry neither.
Proposed capability actions carry `changeFingerprint`, which binds the exact
fingerprint-only proposed change; do not infer a batch from IDs or prose. If
any collection reports incomplete coverage, no proposed batch is available.
`privateDetailFingerprint` joins display material only through exact
`{collectionId,rowId,rowFingerprint}` sources in the selected private
companion.

Connected Email acquisition is a separate private Context operation, not a new
prepared-work or lifecycle family. Core exposes
`soter_prepare_automation_acquisition` / `soter_finalize_automation_acquisition`
with exact Automation, work, and checkpoint bindings; the CLI uses only the
matching generic `operator-acquisition-*` commands.
The durable v2 operation plan has exactly
two capability steps: `mail.messages.search` and a bound
`mail.threads.read`. If Studio later projects acquisition progress, render only
the canonical operation-plan checkpoint/current-call facts already used by the
generic runtime surface. Do not render acquired subjects or bodies from
workspace inspection; the finalized snapshot is selected private state.
Completion means only that complete pagination and exact message coverage were
validated. It does not mean triage occurred and creates no preview, private
derived review, approval request, continuation request, or executable action.
Connector compatibility and connected readiness remain intentionally unknown.

The next selected-private boundary is the pack-owned Email decision workspace:
`soter_inspect_email_triage_decision` / `soter_commit_email_triage_decision`,
with CLI equivalents `email-triage-decision-inspect` /
`email-triage-decision-commit`. Inspection returns the full private Context
snapshot, deterministic candidate identities/fingerprints, exact exclusion
counts, and a `needs-input` input template. It must use a sender-validated,
selected-run private operation if Studio projects it; do not aggregate its
query, addresses, provider identities, subjects, bodies, summaries, reasons,
or citations into queue, workspace inspection, logs, evidence, fixtures, or
general renderer state.

A ready decision resolves every and only the exact candidate set and requires
bounded subject/body citations, explicit provider-`IMPORTANT` non-authority,
and fail-closed injection handling. It is still `authority=none` in product
terms: the run remains paused and no prepared-work receipt, private derived
review, draft, proposed change, review batch, approval, continuation request,
or provider action exists. Studio should not add a lifecycle state or action
control for this boundary. `needs-input` is a durable abstention and should be
shown as missing judgment, not failed execution.

A ready decision now has one separate connected review-only proposal path:

- `soter_inspect_email_triage_proposal` / CLI
  `email-triage-proposal-inspect` returns the exact private decision and a
  candidate-complete input template. It creates no proposal state.
- `soter_commit_email_triage_proposal` / CLI
  `email-triage-proposal-commit` accepts complete private draft, digest, and
  handoff values and returns a sanitized `automation-proposal/v1` plus only a
  fingerprint summary of its private companion.
- `soter_inspect_email_triage_proposal_material` / CLI
  `email-triage-proposal-material` returns the full selected-private
  `automation-proposal-material/v1` after exact lock, decision, proposal,
  contract, row, action, item, and deterministic Email reconstruction checks.

Do not map this to prepared work or add a lifecycle state. The sanitized
proposal reuses the generic `automation-review/v1` shape: exact facts,
contradictions, collections, coverage, rows, actions, and fingerprint-only
changes. It may be rendered with the same mechanical Email review table, but it
has fixed `authority.state=none` and reason
`AUTOMATION_PROPOSAL_REVIEW_ONLY`. The companion has fixed
`AUTOMATION_PROPOSAL_MATERIAL_REVIEW_ONLY`. The run remains paused; approvals
and effects do not change. No continuation request or provider call exists.

Use a sender-validated selected-proposal IPC operation for the material and the
same typed success/error envelope already used by selected-work private review.
Never place proposal material in queue, catalog, workspace inspection, runs,
proof, logs, diagnostics, checked-in fixtures, or general renderer state. Map
stable failures by exact code: `AUTOMATION_PROPOSAL_MISSING`, `_MALFORMED`,
`_TAMPERED`, `_BINDING_INVALID`, `_ADAPTER_INVALID`, `_STALE`,
`_CREDENTIAL_REJECTED`, `_STATE_INCOMPLETE`, and
`_WRITE_FAILED`; private companion failures are
`AUTOMATION_PROPOSAL_MATERIAL_MALFORMED`, `_TAMPERED`, `_BINDING_INVALID`, and
`_CREDENTIAL_REJECTED`. Any failure suppresses proposal values while leaving
other sanitized work visible. Do not render caught error prose.

For Email, every decision candidate appears once in proposal input. Draft text
is required only for `draft-review`; task/update payloads are required only for
their exact portable handoff intents; digest text is required once. Meeting and
calendar handoff fields are derived from exact bound Context. A suspected-
injection row has only a held no-capability action and cannot propose even an AI
label. Sending remains a prohibited no-capability dispatch row. The sanitized
proposal contains no address, provider ID, subject, body, draft, digest, or raw
before/after value.

Both the contained prepared-work companion and the connected proposal companion
may render normalized thread detail, AI-label values, complete draft text,
digest text, and handoffs inside an explicit private local review boundary.
Resolve their shared vocabulary mechanically from the owning pack's
`operator.preparation.derivedReviewContract`; verify the public/private
contract ID and fingerprint before rendering. Core does not define Email field
names. It is not approval authority. The exact oracle is raw=15,
included=11, excluded=4, rows=10 for the contained fixture; connected proposal
coverage comes from its exact grounded decision. Sending must render
prohibited. Digest persistence is held because no destination capability is
configured. Exact-thread selection and write retry are intentionally
unavailable. `mail.labels.read` and `mail.drafts.list` are exact portable
verification interfaces. Their contained behavior and the Codex Gmail label
translator have synthetic coverage; no live connected behavior is proven.

The established private field ID `labelName` now declares the display label
“Exact label name.” Treat its value as the exact configured display name; do
not infer a provider label ID from it or from presentation prose. Automation-
owned label items now carry required `messageIds: string[]` containing exact
active provider message IDs. Draft items carry required
`replyMessageId: string`. Neither field is a thread ID, RFC822 message ID,
subject line, or renderer-generated reference. They must remain inside selected
private material and the private connected plan.

The owning Email Context definition is `context.email.processing` version
`3.0.0`. It mechanically distinguishes provider message IDs, provider thread
IDs, and RFC822 deduplication IDs; declares label application as message-scoped;
uses configured label names; and prohibits implicit label creation. This adds
no new Studio field or authority. Studio should retain the field map above and
must not substitute thread IDs, RFC822 IDs, or provider label IDs. The triage
freshness rule is timestamp-free: skip only when every active inbox message
already carries `AI/Triaged`; retain any thread with an active untriaged
message.

Core now supports a distinct generic selection step before connected approval:

- `createPreparedReviewBatch({root,workId,actionIds,createdAt})` accepts only a
  non-empty unique subset of exact proposed action IDs and returns
  `prepared-review-batch/v1`;
- `inspectPreparedReviewBatchMaterial({root,batchId})` returns
  `prepared-review-batch-material/v1` for one selected private batch;
- CLI equivalents are `operator-review-batch-create` and
  `operator-review-batch`.

Studio may render checkboxes only for `state=proposed` actions, send exact IDs
to Core, and then display Core's canonical selected order. Never permit held,
prohibited, none, or handoff actions to enter the selection. The sanitized
batch contains no private values. The private material returns the exact
declared context/proposed items joined through the selected row and value
fingerprints. Use sender-validated selected-batch IPC envelopes and clear the
material when batch selection ends; do not cache it in queue, catalog, runs,
proof, logs, or workspace inspection.

Both results are review facts with `authority=none`. For Email, Task Capture,
Organization Capture, Contact Capture, and Project Pulse
the batch remains `state=review-only` and carries
`CONNECTED_PLAN_NOT_COMPILED` plus
`CONNECTED_VERIFICATION_NOT_PROVEN`. Do not render an approval ceremony,
confirmation action, continuation, retry, provider request, or execution button
from either object. These APIs belong to the separate contained prepared-work
family and remain non-authoritative; do not route a connected proposal through
them.

Core now exposes `createPreparedConnectedPlan({root,batchId,createdAt})` and
`inspectPreparedConnectedPlan({root,planId})`, with CLI equivalents
`operator-connected-plan-create` and `operator-connected-plan`. The returned
`prepared-connected-plan/v1` is private selected-plan state: it contains exact
provider arguments and therefore must use a sender-validated selected-plan IPC
boundary and must never enter queue, workspace inspection, runs, proof, logs,
diagnostics, canonical fixtures, or general renderer state. It is always
`state=blocked-review-only`, `executable=false`, and `authority=none`.

The plan mechanically maps each exact selected action to one ordered
operation. Core supplies `authority`, `provider.pack`, and nullable
`provider.connectedImplementation`; the Automation compiler supplies portable
inputs, idempotency binding, a read-only verification request and expectation,
retry-prohibited ambiguity policy, and manual recovery reason. Email label
actions carry one exact `messageIds` set, `addLabelNames`, empty
`removeLabelNames`, and `createMissingLabels=false`; verification carries the
same exact messages and label names. Draft bodies, recipients, and reply
message identity remain private. Label apply/read operations name
`provider.integration.gmail.mcp`; draft create/list operations keep
`provider.connectedImplementation=null`. A null provider remains an exact
unavailable state, not permission to fall back to the fixture provider.

Task Capture plans contain one exact task-create value and therefore use the
same selected-plan privacy boundary. Their create, precondition, and
verification provider is `provider.integration.notion.mcp` under
`authority.tasks.instance`. This route metadata is not transaction authority or
connected readiness.

Project Capture cannot create a selected review batch or
`prepared-connected-plan/v1`: its sole action is held with
`COMPLETE_PROJECT_READBACK_UNAVAILABLE` and its preview has zero proposed
changes. Preserve the private candidate review, but do not infer provider
arguments or synthesize approval, start, execution, retry, reconciliation, or
provider body-read claims.

Organization Capture and Contact Capture plans each contain one exact private
create value and use the same selected-plan privacy boundary. Their
precondition, create, and verification route is
`provider.integration.notion.mcp` under `authority.crm.instance`. The current
schema and duplicate-resolution basis stays sealed to the durable proposal;
route metadata is not transaction authority or connected readiness.

Project Pulse prepared plans use the same private boundary and accept only the
complete document-update/status-create action group in canonical order. They
remain review-only compiler output and cannot substitute for the separate
durable Project proposal, request, confirmation, consumed start, or checkpoint.

Studio may display a quiet private “compiled candidate” ledger if useful, but
must keep every approval, confirmation, continuation, execute, retry, and
reconcile control disabled. Every plan retains
`CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED`,
`CONNECTED_VERIFICATION_NOT_PROVEN`, and
`SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE`. Draft or mixed plans
also retain `CONNECTED_PROVIDER_NOT_DECLARED`; a label-only plan does not.
The non-null Gmail provider is route metadata, not readiness or execution
authority. Do not reinterpret the prepared review batch or plan as
`connected-change-set/v2`, `connected-operation-batch/v2`, or
`approval-request/v1`.

### Drive Filing projection

The canonical preparation-only workflow is
`automation.filing-a-drive-artifact` in configuration `drive-filing`. Render its
input declaration in exact order: private artifact URI, required retention enum,
optional private subject key, required private placement basis, optional private
alternative-subject list, required snapshot boolean, optional `self` owner enum,
optional exact organization reference, optional private document Type, required
private description, and required skip-index-pressure boolean. Do not infer a
destination, owner, relation, Type, or Category in Studio.

The sanitized preview kind is `drive-filing-preview`; its one collection has
kind and label key `drive-filing-plan` and exactly two mechanically rendered
rows: storage placement or human-move, followed by document-index create. Proposed
placement capabilities are only `storage.shortcuts.create` or
`storage.files.copy`; copy appears only for an explicitly requested frozen
snapshot. An existing organization-owned artifact outside its destination uses
the no-capability `storage-move` handoff. Document indexing uses
`documents.records.create`. Any contradiction holds the complete plan, so Studio
must never select or promote an action whose canonical state is `held` or
`handoff`.

Exact artifact names and URIs, source locations, destination labels and URIs,
placement basis, alternatives, human-move instruction, document values, owner
IDs, and organization URIs exist only in the selected-work private derived-review
companion. Its pack-owned item kinds are `storage-placement` and
`document-index-create`. The sanitized receipt, workspace inspection, evidence,
logs, diagnostics, and adapter fixtures must contain only stable facts, reason
codes, counts, and fingerprints. Artifact content is never acquired and must not
be representable in either projection.

This migration deliberately declares no proposal adapter or connected compiler.
`createPreparedReviewBatch` may preserve a selected review subset as
authority-free private review, but `createPreparedConnectedPlan` fails closed
with `PREPARED_CONNECTED_PLAN_COMPILER_INVALID`. Studio must keep approval,
confirmation, start, execute, retry, reconcile, and recovery controls absent for
Drive Filing. It must not fall back to fixture writes, the removed Claude guide,
native Drive actions, or Notion APIs. A future connected compiler is a separate
governed milestone.

Stable Drive reason codes include:

- `DRIVE_RETENTION_DECISION_REQUIRED`;
- `DRIVE_HOME_PROVISIONAL_INBOX` and `DRIVE_SUBJECT_NOT_REGISTERED`;
- `DRIVE_ALTERNATIVE_SUBJECT_NOT_REGISTERED`;
- `DRIVE_ARTIFACT_KIND_UNSUPPORTED`;
- `DRIVE_EXISTING_ARTIFACT_REQUIRES_HUMAN_MOVE`;
- `DRIVE_DOCUMENT_OWNER_REQUIRED` and
  `DRIVE_DOCUMENT_ORGANIZATION_REQUIRED`;
- `DRIVE_DOCUMENT_TYPE_REQUIRED`,
  `DRIVE_DOCUMENT_TYPE_NOT_IN_CURRENT_SCHEMA`, and
  `DRIVE_DOCUMENT_CATEGORY_NOT_IN_CURRENT_SCHEMA`;
- `DRIVE_DOCUMENT_DUPLICATE_CANDIDATE_OBSERVED`;
- `DRIVE_REQUIRED_INDEX_SKIP_REQUESTED`;
- `DRIVE_PLACEMENT_ALREADY_PRESENT`,
  `DRIVE_PLACEMENT_REQUIRES_HUMAN_MOVE`,
  `DRIVE_SHORTCUT_READY_FOR_REVIEW`,
  `DRIVE_SNAPSHOT_COPY_READY_FOR_REVIEW`, and the held variants; and
- `DRIVE_DOCUMENT_INDEX_READY_FOR_REVIEW` and its held variants.

These are review facts, not permitted actions. Fixture evidence establishes only
contained deterministic preparation. It does not establish Drive or Notion
credentials, reachability, permission, connected provider conformance, write
verification, readiness, or health.

### Connected proposal approval and checkpoint mapping

For a durable connected `automation-proposal/v1`, Studio may render selection
controls only for exact actions with `state=proposed`. Submit one non-empty
unique action-ID set to the trusted local Core
`createProposalConnectedBatch({root,lockPath,proposalId,actionIds,...})`
operation, or its `proposal-connected-batch-preview` CLI equivalent. Core
restores canonical order and returns:

- `connected-change-set/v2`, whose basis binds the proposal, decision,
  Automation, selected IDs, and selection fingerprint;
- `connected-operation-batch/v2`, whose profile is
  `verified-write-sequence`; and
- selection facts with selected/available counts and whether the subset is
  partial.

This preview has no approval, continuation, host request, or provider call.
Studio must not compile, reorder, widen, persist, or reconstruct either
document. A different subset, proposal value, private item, compiler, provider
binding, or lock creates a different scope and requires a new request.
Batch preview, request creation, confirmation, and an unconsumed or reserved
start each re-evaluate every finite-age proposal Context observation at that
boundary's current time. `PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE` creates no new
request, approval, consumption, checkpoint, current host request, or provider
call. This is a Core-wide proposal-transaction code, not a Task-only state.

Email label actions, the single Task, Organization, or Contact create, and the
complete Project Pulse group have declared connected write and exact read-back
providers. Email draft-only or mixed selections fail before request creation
with `PROPOSAL_CONNECTED_BATCH_PROVIDER_UNAVAILABLE`; keep the proposal review
visible and show no approval ceremony. There is no fallback to the fixture
provider. Email send, digest persistence, label removal, compensation, and
automatic write retry remain unsupported.

Project Capture and Meeting Intake remain before this selection boundary.
Project Capture actions use `COMPLETE_PROJECT_READBACK_UNAVAILABLE`; Meeting
Intake summary and Task-fold actions use
`COMPLETE_MEETING_READBACK_UNAVAILABLE`. Both previews expose zero proposed
changes. The reason is mechanical: Core currently supports only one verification
observation per operation, while Project Capture requires mapped fields plus
body and Meeting Intake requires all summary fields plus body. Meeting Intake's
Task fold belongs to the same complete group and cannot be selected separately.
Studio may render the private held candidates and exact reason codes, but must
not render a selection, batch, approval, confirmation, start, checkpoint,
provider request, execute, retry, reconcile, recovery, or verified-outcome
control for either workflow.

For a successful Email label, Task, Organization, or Contact create, or complete
Project Pulse preview, invoke the v2 authority path through
`beginProposalConnectedApprovalRequest`, selected-request
`inspectConnectedApprovalReviewMaterial`, and
`confirmProposalConnectedApprovalRequest`. Studio may display the private
review only through the sender-validated selected-activity envelope. Each v2
operation provides:

- exact operation/source-action/input fingerprints and portable subject;
- `before.state=not-required` with `PRIOR_VALUE_NOT_REQUIRED` for Email label
  application, `before.state=absent-required` with
  `DEDUPLICATION_ABSENCE_REQUIRED` for Task, Organization, Contact, or Project
  status create, or
  `before.state=provided` with `SOURCE_CONTEXT_BOUND` for a Project document
  update;
- the exact selected private proposed value and fingerprint;
- exact precondition, verification, ambiguity, and recovery facts; and
- the same request/change-set/batch/run/lock bindings already used by v1.

The review grants no authority. Confirmation remains a separate trusted local
Core operation. The shared `approval/v2` and `approval-consumption/v1` families
remain authoritative; Studio must not introduce an Automation-specific
confirmation or start token.

Before reserving an unconsumed start, Core prepares and validates the exact
initial provider calls in memory. A failure is
`CONNECTED_TRANSACTION_PREFLIGHT_FAILED` with an optional sanitized nested
`reasonCode`, such as `HOST_CALL_VALIDATION_FAILED` or
`HOST_REQUEST_NOT_EMITTED`. It creates no consumption, checkpoint, current
call, provider call, or write; the confirmed approval remains unconsumed.
Studio's sender-validated preview, request, confirmation, and start IPC
boundaries must preserve stable facts through
`{ok:true,...}|{ok:false,error:{code,reasonCode?,message}}`. Unknown thrown
values map to fixed adapter-unavailable copy. Renderer code must never parse or
display exception prose.

After the separately confirmed approval is started, map
`connected-transaction-checkpoint/v2` through the existing
`operator-inspection/v1` projection. The v2 capability sequence is optional
`precondition` -> `write` -> `verify`, repeated in canonical operation order.
The current exact host call remains the only executable reference. A write or
verification failure becomes `needs-attention` with the operation's stable
ambiguity code, never a retry button. Core may emit a separate checkpoint-bound
`continuationRequest` for `prepare-reconciliation`; that request permits one
read-only verification observation. `checkpoint.resume.permittedNextAction`
remains display guidance and is never execution authority.

Expected-state reconciliation may complete the operation and continue the
remaining sequence. Unexpected state resolves the observation but stays
`needs-attention` with manual recovery. A failed read remains unresolved and
may be observed again. There is no v2 compensation execution; render its plan
as the canonical immutable `not-required` fact and render manual recovery only
from the blocker/reconciliation facts.
Keep approval, consumption, checkpoint, verification, reconciliation, proof,
maturity, and migration as separate families.

Stable generic connected/v2 reason codes to map without parsing prose include:

- `PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE`;
- `CONNECTED_TRANSACTION_PREFLIGHT_FAILED`; and
- sanitized nested `HOST_CALL_CONFLICT`, `HOST_CALL_VALIDATION_FAILED`, or
  `HOST_REQUEST_NOT_EMITTED` when Core supplies one.

Stable held-review reason codes to map without parsing prose include:

- `COMPLETE_PROJECT_READBACK_UNAVAILABLE`; and
- `COMPLETE_MEETING_READBACK_UNAVAILABLE`.

Stable Email/v2 reason codes to map without parsing prose include:

- `CONNECTED_BATCH_PREVIEW_ONLY`;
- `PROPOSAL_CONNECTED_BATCH_SELECTION_INVALID`,
  `PROPOSAL_CONNECTED_BATCH_BINDING_INVALID`,
  `PROPOSAL_CONNECTED_BATCH_CREDENTIAL_REJECTED`,
  `PROPOSAL_CONNECTED_BATCH_MALFORMED`,
  `PROPOSAL_CONNECTED_BATCH_STALE`, and
  `PROPOSAL_CONNECTED_BATCH_PROVIDER_UNAVAILABLE`;
- `PRIOR_VALUE_NOT_REQUIRED` and
  `DEDUPLICATION_ABSENCE_REQUIRED`;
- `PRECONDITION_PASSED`, `PRECONDITION_MISMATCH`,
  `VERIFICATION_PASSED`, and `READ_AFTER_WRITE_MISMATCH`; and
- `MAIL_LABEL_WRITE_AMBIGUOUS` and `MAIL_DRAFT_CREATE_AMBIGUOUS`.

Project Pulse additionally uses `CONNECTED_COMPILER_INVALID` for an incomplete
action group, `PROJECT_DOCUMENT_UPDATE_AMBIGUOUS`,
`PROJECT_STATUS_CREATE_AMBIGUOUS`,
`PROJECT_DOCUMENT_RESTORE_NOT_AUTOMATED`, and
`PROJECT_STATUS_DELETE_NOT_DECLARED`. Treat the compiler error as a failed
preview with no request; treat ambiguity codes as needs-attention, never retry
permission. The restore/delete codes describe manual recovery boundaries, not
an executable compensation plan.

Organization and Contact additionally use `ORGANIZATION_CREATE_AMBIGUOUS`,
`ORGANIZATION_DELETE_NOT_DECLARED`, `CONTACT_CREATE_AMBIGUOUS`, and
`CONTACT_DELETE_NOT_DECLARED`. Treat create ambiguity as needs-attention and
the delete codes as explicit manual recovery boundaries; none grants retry,
removal, compensation, or rollback authority.

Retain the generic queue, exact-scope ledger, selected private approval review,
capability tape, checkpoint resume object, verification ledger, and recovery
brief. Add v2 contract types and map them mechanically. Delete or reject any
Studio-owned Email compiler, batch, request, confirmation, retry, continuation,
transaction, or provider-readiness state. Do not expose native provider
arguments, raw response bodies, private query/draft/body text, or raw
before/after values in sanitized inspection or UI fixtures.

## Slack channel-ingestion preparation

`automation.slack-channel-ingestion` uses the existing generic prepared-work,
private review, selected-batch, and connected-plan boundaries; Studio must not add a
Slack-specific selection token or transaction authority.

- `phase=identity-review` renders the complete itemized identity collection and the
  `CHANNEL_SELECTION_REQUIRED` hold. No member step or proposed change may appear.
- `phase=selected-enrichment` is a separate prepared work item whose private
  `selectedConversationIds` input is the exact human selection. It may render member and
  organization match facts only through selected-work private review material.
- Sanitized rows expose stable sequence, subject fingerprints, reason codes, action
  kinds, capability IDs, change fingerprints, and nullable before fingerprints. They
  do not expose channel IDs, names, hosts, permalinks, member profiles, or raw provider
  output.
- `channel-create` and `channel-update` are review proposals only. Contact and
  organization residue use no-authority handoff actions. `PREPARATION_INPUT_INVALID`
  means the selected phase/input combination must be corrected and grants no resume or
  execution authority.
- Portable channel proposals contain only `workspaceUri`,
  `workspaceIdentityFingerprint`, `conversationIdentityFingerprint`, channel
  metadata, and typed CRM resource URIs. Raw provider workspace, conversation,
  and participant IDs and provider permalinks are structurally absent from the
  proposed record and connected operation; they may appear only in selected-work
  private review or Integration runtime data.
- Slack messages, Slack writes, and bot identities are outside this contract. The
  actual create/update path remains the existing exact approval, single-use start,
  checkpoint, verification, and reconciliation lifecycle through the configured
  Communications mapping in Notion Integration.

## Slack conversation-review connected acquisition

`automation.slack-conversation-review` remains available for fixture-contained
preparation. Its `connected-acquisition` mode is separately projected as
`unavailable` with reason code
`CLOSED_MESSAGE_THREAD_RESPONSE_UNAVAILABLE`: the observed Codex and Claude
message/thread routes return human-formatted prose rather than closed message
arrays and pagination facts. Core rejects this mode before reading private
configuration or input and before creating work, plan, call, run, or checkpoint
state.

Studio must render `operator.preparation.modes[].availability` mechanically. An
available mode has only `{state:"available"}`. An unavailable mode has exactly
`state`, `reasonCode`, and `reason`; it exposes no staging action. Studio must
not parse connector prose, substitute another tool, retry, or infer authority
from pack-level `hostCompatibility`. That pack-level fact says only that the
host can inspect or use the pack's remaining contained behavior.

The retained policy, workspace, conversation, message-window, explicit-thread,
coverage, and private-review contracts describe the bounded shape required by a
future structured provider route. They are inert while the mode is unavailable.
Message bodies and private identifiers remain structurally absent from
workspace inspection. No Slack write, persistence proposal, approval,
continuation, retry, provider call, readiness, verification, or health follows
from either the contained fixture or the unavailable connected definition.
Slack Channel Ingestion remains a separate identity/participant workflow whose
live routes are declared but unverified.

## Process preparation

`automation.process-capture` and `automation.process-red-team` use the existing generic
prepared-work, selected-work private review, and sanitized collection boundaries.
Studio must not add Process-specific approval, continuation, auto-fix, or provider
authority.

Process Capture renders its declared input fields in exact contract order. All fields
except the identifier boolean `spawnTasks` are private. String-list controls remain
ordered and cardinality-bounded; paired trigger and step lists must not be joined or
reordered in the renderer. Its preview kind is `process-capture-preview`, collection
kind `process-capture-review`, derived-review kind
`process-capture-derived-review`, and private item kind `process-create`. The private
item contains exact process values, resolved resource identities, the complete body,
duplicate ids, and Task-spawn disposition. Sanitized rows expose only stable codes,
counts, action metadata, and fingerprints. `PROCESS_TASK_SPAWN_DECLINED` is a boundary,
not a Task handoff. `PROCESS_CREATE_READY_FOR_REVIEW` may display a fingerprint-only
held create, but there is no proposal compiler or executable action; confirm/start/
execute/recover controls must remain absent.

Process Red Team inputs are private `processUri`, identifier boolean
`includeLatestRun`, and optional identifier boolean `fixRequested`. Its preview kind is
`process-red-team-preview`, collection kind `process-red-team-review`, derived-review
kind `process-red-team-derived-review`, and private item kind
`process-review-finding`. Private finding fields include severity, lens, finding,
reproduction, exact source ids, proposed fix, reproduced state, and disposition.
Sanitized rows may render ranking, reason codes, fingerprints, and report-only state;
they must not project private source content. `PROCESS_REVIEW_FIX_REQUEST_WITHHELD` and
`PROCESS_REVIEW_REPORT_ONLY` explicitly prohibit auto-fix. The pack has only read and
disclosure effects, so write, approval, confirmation, continuation, retry, and recovery
actions are intentionally unavailable.

Contained fixtures establish deterministic local preparation, source binding, privacy,
and absence of authority only. They do not establish live Notion conformance,
credentials, readiness, verified connected behavior, or health.

## Harness Development Catalog

The `harness-development-catalog` configuration selects ten definition-only Automation
packs. These are portable catalog facts, not prepared work and not an operator runtime.
If Studio presents them, use only the canonical definition facts:

- `availability.state=definition-only`;
- `reasonCode=AUTOMATION_RUNTIME_NOT_IMPLEMENTED`;
- `authority=none`;
- `permittedNextAction=design-runtime-slice`;
- `normalization.runtimeParity=not-evaluated`; and
- `normalization.behaviorAuthority=none`.

Every selected pack has no operator declaration, capabilities, authorities, effects,
or executable scenarios, while the configuration prohibits all five effects. Studio
must render these workflows as inspectable and unavailable—not as queue items, runnable
commands, disabled approvals awaiting configuration, or host-installed skills. The
normalized evaluation sets are behavior expectations only and must not be labeled
passing tests or verification evidence. Legacy source paths and fingerprints are
migration provenance; do not expose private local absolute paths or raw source content.

If Studio renders `development-historical-evidence-batch-inspection/v1`, its
`basis.hostGraphFingerprints` is the closed exact pair `{claude,codex}`. The two
values are deliberately distinct because each candidate lock seals its own host
adapter and projection. Keep them as host-scoped basis facts; do not collapse
them into one graph, infer host parity, or treat either fingerprint as launch,
authentication, readiness, verification, health, or fallback-removal authority.

`development-governance/v1` is also not an operator-work contract. It is an inspectable
Kernel policy assigning develop-intent responsibility across Kernel, Core, Automation,
Integration, host adapters, and configuration. Its lifecycle, quality requirements, and
bridge evidence grant no preparation, file-write, host-task, confirmation, continuation,
publication, or external-effect authority. Studio may identify the policy as declared
governance, but it must not synthesize a development queue item or infer that any
definition-only workflow, Claude task allowlist, hook, or legacy fallback has migrated.

## Legacy foundation tombstones

`legacy-foundations.migration.json` and the `claude-host-projection` fixture set expose
migration facts only. Calendar, Docs, and Onchain are completed intentional-change
migrations: their legacy system cards are absent and their closed Context models own
portable meaning without provider, capture, synchronization, or runtime authority. Sky
is also migrated: its exact ordered vocabulary is target-owned, its legacy card and
mixed-Lexicon rows are absent, and its Context pack still exposes no capability or
effect. Every remaining responsibility is target-owned or explicitly retired according
to its exact inventory tombstone. None are
queue items, current provider records, or connected readiness. Automation targets in this slice are definition-only and
grant no preparation, approval, continuation, or execution authority. The Notion
Integration migration record identifies provider-translation ownership but does not expose
credentials, native arguments, or live provider conformance.

Claude host migration evidence proves exact target ownership or explicit retirement and
deliberate non-adoption. Studio must not present removed plugin, MCP, hook, settings,
platform, task-delivery, or checker files as generated outputs, installed host behavior,
or launch proof. Final tombstones require `sourcePresence=removed`, a
`migrated|retired` state, `fallback=removed`, and exact evidence for every binding; no
action control may be derived from these facts. Sanitized views may show source role,
target layer, state, reason, and limitations, but never raw legacy contents, private
paths, credentials, provider responses, or a readiness/health badge.

If Studio summarizes the complete legacy inventory, it must render `stateCounts` as
source aggregates and `bindingStateCounts` as target responsibilities. It must not
collapse them into one number or infer parity from an aggregate. The final inventory
contains 143 migrated-or-retired source tombstones and zero mapped or bridged sources;
Studio must read binding counts from the canonical inspection rather than hard-code
them. Final migration records exact authority transfer or intentional retirement only;
it does not establish runtime readiness, connected verification, or health.

Migration-family evidence may now identify an exact selected configuration subject as
`{type:"configuration", id:"configuration.<name>", version:null}`. That fact records an
authority transition for the exact configuration artifact only; it is not a versioned
pack, executable request, readiness signal, or provider result. Studio may show the
configuration ID, target fingerprint, migration state, parity decision, and limitations,
but must not expose configured collection values from the private configuration or infer
that the mixed legacy source is fully migrated.

## Fixture adaptation

The sanitized canonical lifecycle fixture is
`soter/fixtures/operator-inspection/connected-transaction.lifecycle.json`. It
has `authority=none-example-only` and may seed renderer adapters without
establishing provider behavior.

After Studio deletes or maps its overlapping Core proposal:

1. Regenerate target fixtures with `node soter/core/cli.mjs fixtures --update`.
2. Regenerate any Studio adapter fixtures from the canonical lifecycle fixture
   and real `operator-inspect` output with private values replaced by stable
   synthetic identifiers and fingerprints.
3. Run `node soter/kernel/verify.mjs`, `node soter/core/cli.mjs selftest`,
   `node soter/core/cli.mjs fixtures --check`, the doctor gate, the MCP
   selftest, and Studio's renderer/build/Electron gates.

No fixture, renderer, or contained test establishes connected credentials,
reachability, live provider writes, or host-started end-to-end behavior.
