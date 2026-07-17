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
checkpoint state/phase/reason code, and one derived `resume` object. It cannot
represent the candidate configuration, source inputs, settings, authority URIs,
secret references, raw before/after values, or active-lock contents.

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
fixture locks are not active user locks; Core writes the active lock only under
private `.soter/state/configuration-locks`. A completed local apply validates
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

1. Compile one exact `connected-operation-batch/v1`, or use
   `createProposalConnectedBatch` to compile an exact Automation-proposal
   subset as `connected-operation-batch/v2` with
   `profile=verified-write-sequence`.
2. `beginConnectedApprovalRequest` handles v1, while
   `beginProposalConnectedApprovalRequest` revalidates v2 against the current
   proposal/private companion and locked compiler. Both persist the same
   `approval-request/v1` family with exact lock, run, change set, batch, scope,
   and expiry.
3. `confirmConnectedApprovalRequest` handles v1, while
   `confirmProposalConnectedApprovalRequest` revalidates the v2 compiler and
   complete selected private review. Both persist `approval/v2`, embedding and
   confirming only that request.
4. `prepareDurableConnectedTransactionExecution({ approvalId })` atomically
   reserves `approval-consumption/v1`, creates its deterministic connected
   transaction checkpoint, then binds the consumption to that checkpoint
   fingerprint. Exact re-entry returns the same checkpoint.
5. MCP and hosts may execute or complete only the exact current checkpoint call
   or prepare the exact read-only reconciliation allowed by that checkpoint.

The CLI dispatches both contract versions through `connected-approval-request`,
`connected-approval-confirm`, and `connected-transaction-prepare
--approval-id`; `proposal-connected-batch-preview` creates the v2 preview. No
host or MCP method accepts a raw approval document.

## Canonical operator projection

Studio should consume `operator-inspection/v1`, produced by
`inspectConnectedOperatorActivity` or `operator-inspect`. The projection
provides:

- activity: automation, work, run, convenience work state, and current family;
- configuration: configuration and lock paths, exact lock and graph
  fingerprints, host, and applicability;
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
- compensation: declared recovery modes, completed and remaining step IDs, and
  a fingerprint of restored private values rather than those values;
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

- Studio `beginOperatorApproval` to `beginConnectedApprovalRequest` for v1 or
  `beginProposalConnectedApprovalRequest` for v2; select by the canonical batch
  contract, never UI state;
- Studio `confirmOperatorApproval` to `confirmConnectedApprovalRequest` for v1
  or `confirmProposalConnectedApprovalRequest` for v2;
- Studio start to `prepareDurableConnectedTransactionExecution({ approvalId })`;
- Studio transaction inbox reads to `inspectConnectedOperatorActivity`;
- `confirmationId` to `approval.confirmation.id`;
- `confirmationFingerprint` to `approval.confirmation.fingerprint`;
- recovery display to the single canonical `resume` object; and
- exact-scope ledger fields to `configuration`, `scope`, `approval`,
  `verification.criteria`, and `compensation.plan`.

Retain:

- Electron sandbox and private-state hygiene;
- renderer components, accessibility behavior, generic queue and lifecycle
  presentation, exact-scope ledger, capability tape, verification and
  compensation ledgers;
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
| `ready-for-review` | `prepared-work/v1` review receipt; no exact write batch or approval request exists yet. |
| `awaiting-approval` | `approval.state=awaiting`; no confirmation or consumption. |
| `approved-not-started` | `approval.state=confirmed` and `approval.consumption=null`; confirmation is not start authorization. |
| `running` | consumption is `started` and checkpoint is `requested`. |
| `blocked` | checkpoint is `needs-attention`; verification and compensation remain separate. |
| `verification-failed` | `verification.state=failed`; checkpoint may require reconciliation or already be compensating. |
| `rolling-back` | `compensation.state=running`; checkpoint still owns the exact current call. |
| `rolled-back` | checkpoint is `rolled-back` and compensation is `verified`; proof maturity remains unevaluated. |
| `completed` | checkpoint is `completed` and its required verification criteria passed; proof maturity remains unevaluated. |

Unknown or pre-transaction prepared-work states should keep actions disabled
with Studio's `RESUME_DECISION_UNAVAILABLE` fallback and
`inspect-checkpoint`. Do not synthesize a canonical transaction decision for
them.

## Reason-code mapping

| Studio provisional code | Canonical treatment |
|---|---|
| `AUTHORITY_PERMISSION_MISSING` | Reserved unchanged for a future prepared-work blocker projection; a connected batch cannot reach approval with this blocker. |
| `REQUIRED_INPUT_MISSING` | Canonical prepared-work blocker; not emitted by connected transaction inspection. |
| `CHECKPOINT_STALE` | Canonical unchanged; emitted for exact-lock applicability drift. |
| `READ_AFTER_WRITE_MISMATCH` | Canonical unchanged; emitted by failed verification criteria. |
| `COMPENSATION_FAILED` | Canonical unchanged; emitted when prior state is not established. |
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

Private review material remains display-only. Any future Task Capture write
still requires a separately derived exact change batch, expiring approval
request, exact confirmation, one-time consumption, and connected checkpoint.

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
| `project` | `reference` | yes | identifier | Exact CRM project record identity. It is required because the selected policy requires a project. |
| `assignee` | `reference` | no | identifier | Exact provider-person identity; preparation does not prove connected user availability. |
| `nextActionOn` | `date` | no | private | Real pinned `YYYY-MM-DD` calendar date; impossible dates are `INPUT_INVALID`. |
| `context` | `enum` | no | identifier | `Internal`, `Service`, `Project`, or `Client`; omitted becomes `Project` for the required project relation. |

The prepared preview kind is `task-capture-preview`. A successful contained
review exposes policy, project, default status, context, duplicate-count,
date-presence, and assignee-binding facts plus at most one proposed change:
`crm.records.create`, `beforeFingerprint: null`, and a non-null
`afterFingerprint`. Raw before/after values, title, and date are not
representable. `project-context-conflict` or
`duplicate-candidates-observed` is a normalized contradiction and produces no
proposed change. These IDs are review facts, not lifecycle reason codes.

No new approval, start, execution, resume, proof, or migration state is added.
The declared write effect should render as held/not proposed during preparation,
never as an executed write or read-only authority claim. The external Notion
policy body, provider-person availability, task body shaping, connected write
permission, response conformance, and post-write verification are intentionally
unavailable. Studio may rebase its UI-only effect-ledger checkpoint onto this
graph and generate real adapter fixtures, but must not synthesize an operation
batch, approval, continuation request, or executable create.

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
`soter_prepare_email_triage_context` / `soter_finalize_email_triage_context`
and the CLI equivalents `email-context-connected-prepare` /
`email-context-connected-finalize`. The durable v2 operation plan has exactly
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

Both results are review facts with `authority=none`. For Email the batch remains
`state=review-only` and carries `CONNECTED_PLAN_NOT_COMPILED` plus
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

Studio may display a quiet private “compiled candidate” ledger if useful, but
must keep every approval, confirmation, continuation, execute, retry, and
reconcile control disabled. Every plan retains
`CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED`,
`CONNECTED_VERIFICATION_NOT_PROVEN`, and
`SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE`. Draft or mixed plans
also retain `CONNECTED_PROVIDER_NOT_DECLARED`; a label-only plan does not.
The non-null Gmail provider is route metadata, not readiness or execution
authority. Do not reinterpret the prepared review batch or plan as
`change-set/v1`, `connected-operation-batch/v1`, or `approval-request/v1`.

### Email exact-subset approval and checkpoint mapping

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

Only label actions currently have both declared connected write and exact read-
back providers. Draft-only or mixed selections fail before request creation
with `PROPOSAL_CONNECTED_BATCH_PROVIDER_UNAVAILABLE`; keep the proposal review
visible and show no approval ceremony. There is no fallback to the fixture
provider. Email send, digest persistence, label removal, compensation, and
automatic write retry remain unsupported.

For a successful label-only preview, invoke the v2 authority path through
`beginProposalConnectedApprovalRequest`, selected-request
`inspectConnectedApprovalReviewMaterial`, and
`confirmProposalConnectedApprovalRequest`. Studio may display the private
review only through the sender-validated selected-activity envelope. Each v2
operation provides:

- exact operation/source-action/input fingerprints and portable subject;
- `before.state=not-required`, reason
  `PRIOR_VALUE_NOT_REQUIRED`, and `fingerprint=null` for label application;
- the exact selected private proposed value and fingerprint;
- exact precondition, verification, ambiguity, and recovery facts; and
- the same request/change-set/batch/run/lock bindings already used by v1.

The review grants no authority. Confirmation remains a separate trusted local
Core operation. The shared `approval/v2` and `approval-consumption/v1` families
remain authoritative; Studio must not introduce an Email confirmation or start
token.

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
as manual-required/not-required according to the canonical inspection facts.
Keep approval, consumption, checkpoint, verification, reconciliation, proof,
maturity, and migration as separate families.

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

Retain the generic queue, exact-scope ledger, selected private approval review,
capability tape, checkpoint resume object, verification ledger, and recovery
brief. Add v2 contract types and map them mechanically. Delete or reject any
Studio-owned Email compiler, batch, request, confirmation, retry, continuation,
transaction, or provider-readiness state. Do not expose native provider
arguments, raw response bodies, private query/draft/body text, or raw
before/after values in sanitized inspection or UI fixtures.

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
