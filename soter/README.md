# Soter implementation

This directory is the provider-neutral implementation of the architecture in
[ARCHITECTURE.md](../ARCHITECTURE.md) and [CONTRACTS.md](../CONTRACTS.md).

`soter/` is the operational implementation. Codex and Claude delivery files are
governed private realizations from the same canonical graph.

## Layout

- contracts contains versioned machine-readable contracts.
- packs contains one manifest for each selectable system.
- contexts contains provider-neutral domain models owned by Context packs.
- capabilities contains provider-neutral integration capability contracts.
- providers contains typed implementation declarations, containment levels,
  logical host-transport allowlists, provider mappings, and explicit
  limitations.
- integrations contains provider-specific translators, pack-owned settings
  definitions, shareable field mappings, and contained runtimes; automations
  never import these modules directly.
- configurations contains explicit desired configurations, including portable
  capability sources, readiness modes, and selected pack consumers.
- hosts contains explicit adapter declarations and projection ownership.
- scenarios contains behavior-level fixtures and expected evidence.
- kernel contains the verifier shared by every host projection.
  It rejects contract or capability-schema keywords it cannot enforce and
  self-tests composition, conditional branches, bounds, deep uniqueness, and
  closed privacy shapes so unsupported schema prose cannot masquerade as a
  mechanical guarantee. It also owns deterministic local pack-release and
  transparent-bundle build/verification; those operations grant no install,
  configuration, host, publication, or trust authority.
- automations contains outcome-specific orchestration and completeness rules;
  it asks Core to resolve and persist state rather than owning provider transport
  or runtime storage. A runnable connected acquisition declares its exact
  module, callable prepare/finalize exports, containment, and provider-neutral
  record requirements in `operator.acquisition`; Kernel resolves those
  requirements through the selected Integration mappings and private target
  settings. Definition-only Automations preserve normalized intent and behavior
  expectations with `authority=none`; they are not runnable workflows.
- core contains provider-neutral resolution, preflight, evidence, offline and
  connected doctor operations, a shared execution service, and separate
  resumable capability-call, versioned sequential operation-plan, explicit
  sequential provider-probe-plan, and
  approval-bound connected-transaction paths. The
  CLI and local Soter MCP server are thin interfaces
  over that service; graphical interfaces consume the same boundary.
- studio contains the Electron builder inspector and contained operator surface.
  Its renderer reads one privacy-minimized Core workspace-inspection snapshot
  through a sandboxed preload boundary and never accesses workspace files
  directly. Project Pulse, Meeting Intake, Task Capture, Project Capture, Project
  Page Reconciliation, Organization Capture, Contact Capture, Drive Filing,
  Feature Capture, Feature Definition, Repository Review, Slack Channel Ingestion,
  Process Capture, Process Red Team, and Email
  triage can request Core's
  same fixture-contained prepared-work operation; no receipt grants approval or
  execution authority.
- fixtures contains generated, cross-linked examples of exact locks, run
  envelopes, evidence, and doctor results plus normalized contained provider
  inputs. Only fixtures explicitly declared by a pack are governed source
  artifacts; generated locks and runtime-state examples are not implicitly
  distributable.

## Meeting Intake

Meeting Intake crosses the important runtime seams:

1. Meetings Context supplies Meeting, participant, commitment, summary, and
   transcript-relationship meaning; CRM, Projects, and Tasks supply only the
   independently selected related identities the workflow actually needs.
2. The meeting-intake automation declares the outcome and required
   capabilities.
3. Otter and Notion integration packs fulfill those capabilities.
4. Effect policy allows bounded reads and disclosure. The configuration keeps
   unrelated Integration writes confirmation-gated, while Meeting Intake itself
   declares no write capability and holds its complete group before selection.
5. Scenarios preserve grounding, staleness, deduplication, and gate invariants.

The implementation provides deterministic resolution, an
artifact-fingerprinted lock, effect-free preflight, typed local Notion/Otter
fixture providers, authority-aware context assembly, private cited decision and
complete-group review, scoped evidence, and an offline doctor report. Core also
implements generic exact-scope approval, compiler-exact v2 operation batches,
one-time start, checkpoint, verification, and read-only ambiguity
reconciliation for Automations whose complete verification contract is
available. Meeting Intake does not currently enter that authority path:
`COMPLETE_MEETING_READBACK_UNAVAILABLE` holds the whole summary-and-task group
because Core supports only one verification observation per operation and
cannot prove all required Meeting-summary fields plus body. It creates no
batch, approval, start authorization, checkpoint, provider write, or verified
outcome.
It also validates and aggregates short-lived provider probes into an honest
connected-readiness result and proves the state machine for policy-bound MCP
dispatch with synthetic host results. A local stdio MCP projection exposes that
same Core service to both Codex and Claude without becoming a provider proxy or
accepting generic connected-write approvals. One portable configuration can be
resolved for either compatible host; the resulting lock records whether the
host came from the configuration default or an explicit override and
fingerprints only that host's projections. It atomically checkpoints each
call and its private run state before returning a provider request, and can
rehydrate pending work by checkpoint ID after a server restart. The server also
exposes `soter_inspect_host_runtime`. It reports `current` only when exact
startup/current fingerprints still bind governed sources, the private
configuration and managed manifest, and every static or generated output byte
and full required mode. A clean root with no managed realization reports
`SOTER_HOST_RUNTIME_NOT_REALIZED`, null fingerprints, and the guidance action
`realize-host-runtime`; after realization the host must restart. Changed,
invalid, unsafe, missing, unmanaged, or mode-drifted state reports
`SOTER_HOST_RUNTIME_STALE`. An invalid basis reports no automatic action and an
unknown restart requirement; a complete changed basis requires restart. In both blocked states all operational
Soter MCP tools stop before private-state creation or provider dispatch. This
applicability check grants no approval, continuation, provider-call, write, or
execution authority and does not promote readiness, verification, or health.
The connected
doctor also consumes failed probe checkpoints through a typed, expiring summary
that identifies the exact lock, provider, semantic step, native route, and
failure category while excluding provider arguments, raw responses, credential
values, and error messages. This makes an unavailable or unauthenticated route
different from an unattempted probe without turning an old failure into current
health evidence. The connected
Otter provider
translates a canonical meeting URL into exact `fetch({id})` arguments and
produces an identity-only `get_user_info({})` probe. That probe can pass
authentication and reachability while leaving transcript compatibility
unknown. Unobserved transcript response shapes fail closed. The connected
Notion provider implements bounded namespaced Context record reads using a
pack-owned settings schema, separate CRM, Projects, Tasks, and Meetings mappings,
and exact native tool mappings for each host adapter. A connected read is limited
to one record type and data source per host call, avoiding a hidden dependency on
plan-gated cross-data-source SQL. Provider database layout never determines
Context ownership. Core orchestrates several such reads through one
private sequential operation-plan checkpoint, emitting one exact call at a
time and resuming by checkpoint plus call ID. The sole plan contract is v2;
fixed-input steps use an empty binding list, while dependent steps bind exact
string or unique string-list references from earlier normalized outputs,
fingerprint the resolution, and skip empty relations
without a provider request. Meeting-intake Automation uses v2 for every policy
page explicitly wired as an `applicable-policy` portable source, the exact
transcript, the Meetings record matched by recording URI, and only the CRM
organizations, Projects, and Tasks reached through typed resource identities.
It requires exact policy URI/title agreement and every referenced related ID to
be returned before finalizing, then asks Core to persist a private snapshot and
pause the same run. Each policy entry records its configured subjects and
applicability reason; this does not claim the prose was interpreted or enforced.
Participant profiles remain unloaded. Core mechanically binds every snapshot
entry to exactly one normalized plan output and passed effect before persisting
it. The Notion provider returns deterministic versions for normalized records.
`context.crm`, `context.projects`, `context.tasks`, and `context.meetings` each own
an independent machine-readable portable record model. Kernel checks that
Automation writes and provider mappings use only the selected model's declared fields and
preserve scalar, list, content, mutability, relationship, and deduplication
semantics; Core enforces the same boundary on capability inputs and normalized
outputs. The mapping also scopes read, create, and update per record type rather
than making every mapped Notion database generically writable.
Portable choice meaning is not assumed to match a workspace's native option
labels. Each mapped Notion `select`, `multi_select`, or `status` field declares
`configured-bijection`; its exact forward and reverse value table lives only in
private Integration configuration. Tracked templates cannot contain those
workspace values. Missing, incomplete, ambiguous, or drifted mappings fail
closed, while normalized Context, Automation decisions, inspections, evidence,
and fixtures retain only portable values.
The mapping artifact uses `valueMapping: "configured-bijection"`. Its private
configuration counterpart is one exact scope containing `mapping`,
`recordType`, `field`, `mode: "exact-bijection"`, and a closed
`entries: [{portable, provider}]` table. Every selected Automation choice scope
must be complete. Kernel reports definition and private-configuration failures
as `SOTER_PROVIDER_MAPPING_VALUE_TRANSLATION` and
`SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT`; provider option-set drift instead
fails connected schema acquisition before a decision or authority exists.
Contained private evidence v1.1 exposes only the exact private-configuration
fingerprint, option-scope and entry counts, a scope fingerprint, and
`providerOptionValuesIncluded=false`.
That enforcement is not CRM-specific. The single active
`provider-mapping/v1` contract binds one Integration mapping to one exact
`<namespace>.records` Context subject. Kernel rejects cross-namespace fields or
capabilities, and every configuration binding must select exactly one matching
Context model. Optional mappings remain dormant until their Context pack and
capability are both selected; Core does not infer domain meaning from an
Integration.
Its private readiness plan emits identity, exact schema and one-row bounded read
checks for every configured target, plus one exact read for every portable
document source marked `probe-read`, one visible host request at a time. The
typed provider mapping binds current property names and types—including the
observed `🫂 Contacts` organization relation—and schema drift fails closed. Only
minimized booleans, counts, and fingerprints enter the final probe; live row
values, policy bodies, and identity values do not. Exact target and document
references remain confined to the private checkpoint and lock scope. This plan
can establish exact-lock readiness only for the selected namespaced record-read
and document-read capabilities, but not policy interpretation, write permission, write response
conformance, Automation-specific option compatibility, automation verification,
or health. An Automation that proposes a choice value must separately acquire
and bind its current normalized schema before it may become approval-capable.
Otter's
identity-only probe still leaves transcript compatibility unknown. Notion
create and update translators accept only explicitly mapped fields, but
internal Core capability and operation-plan preparation still blocks
confirmation-gated effects and has no public arbitrary-plan entrypoint. Core can
compile an exact Automation-owned `connected-operation-batch/v2` preview with
optional read-only preconditions, mandatory read-after-write verification, and
an expiring approval bound to both the v2 change set and batch. The private
durable v2 checkpoint consumes one exact start authorization, executes the
canonical sequence, and advances only when the Automation evaluator recognizes
the expected state. Ambiguous effects become `needs-attention`; Core never
retries a write or invents compensation.
Meeting-intake Automation owns its private candidate and required acceptance
criteria; Core owns only the generic approval, dispatch, checkpoint, and
verifier-invocation mechanics used by workflows with complete verification.
Before review, the Automation creates a
grounded `automation-decision/v1` that covers the exact meeting and transcript
segments, every bounded task candidate, and every explicitly applicable policy
with exact citations. `ready` requires complete resolution; `needs-input`
records abstention and cannot become a change set. Core stores the connected
decision privately, binds it to the same paused run and context snapshot, and
rejects tampering or a competing decision. The contained and MCP selftests prove
that mechanism, including multiple-candidate disposition and a Codex-produced
decision, but not live judgment quality.
Contained evidence covers exact connected acquisition, decision binding,
private summary-and-task review, and the mechanical held boundary. Meeting
Intake declares no create/update capability, binding, or connected compiler
while `COMPLETE_MEETING_READBACK_UNAVAILABLE` applies. The checked-in connected doctor
still reports `ready=unknown`: contained transport does not fetch a user's live
meeting, prove provider transcript or Notion conformance, prove host-level
judgment quality, establish live write readiness, or verify an external
summary. The current Context, Automation, Integration, and Core contracts are
the only authority for this behavior.

## Distribution foundation

Kernel can build one governed pack into an immutable canonical-JSON capsule and
independently verify that capsule from local bytes. The capsule contains the
exact manifest plus every declared artifact once, with sealed bytes and modes.
It excludes private runtime state, active configurations and locks, credentials,
raw provider responses, and undeclared files. Build output must be outside both
`soter/` and `.soter/`.

For example, build and independently inspect a contained release:

    node soter/kernel/distribution.mjs pack-release-build --pack context.crm --out /private/tmp/soter-releases --created-at 2026-07-16T00:00:00.000Z --json
    node soter/kernel/distribution.mjs pack-release-verify --capsule /private/tmp/soter-releases/context.crm-0.1.0-SHA.soter-pack.json --json

`bundle-build` accepts a private/local JSON definition conforming to the input
fields documented by `bundle/v1`; `bundle-inspect` accepts repeated
`--release PATH` arguments and resolves only against those independently
verified local capsules. Neither operation fetches or installs anything.

    node soter/kernel/distribution.mjs bundle-build --definition /private/tmp/bundle-definition.json --out /private/tmp/soter-bundles --json
    node soter/kernel/distribution.mjs bundle-inspect --bundle /private/tmp/soter-bundles/bundle.example-0.1.0-SHA.soter-bundle.json --release /private/tmp/soter-releases/context.crm-0.1.0-SHA.soter-pack.json --json

Run the complete contained adversarial matrix with:

    npm run soter:distribution:selftest

Successful inspection means only that exact local release or bundle bytes match
their governed contracts. Publisher and license remain unasserted, the bytes
remain unsigned and untrusted, and install, configuration, host realization,
publication, redistribution, marketplace, readiness, verification, and health
remain unavailable, not evaluated, or unknown as their individual contracts
specify.

## Local pack installation

Core can install or upgrade one exact set of already-local, independently
verified release capsules. It never fetches releases and never invokes a package
manager. The CLI exposes the complete private ceremony:

    node soter/core/cli.mjs pack-install-plan --target /absolute/private/target --capsule /absolute/local/release.soter-pack.json --valid-until 2026-07-16T01:00:00.000Z --json
    node soter/core/cli.mjs pack-install-request --target /absolute/private/target --plan-id PLAN_ID --reason "Install this exact local plan" --expires-at 2026-07-16T00:15:00.000Z --json
    node soter/core/cli.mjs pack-install-confirm --target /absolute/private/target --request-id REQUEST_ID --actor local-user --reason "Reviewed exact fingerprints" --json
    node soter/core/cli.mjs pack-install-start --target /absolute/private/target --confirmation-id CONFIRMATION_ID --json
    node soter/core/cli.mjs pack-install-execute --target /absolute/private/target --checkpoint-id CHECKPOINT_ID --json
    node soter/core/cli.mjs pack-install-recover --target /absolute/private/target --checkpoint-id CHECKPOINT_ID --json
    node soter/core/cli.mjs pack-install-inspect --target /absolute/private/target --checkpoint-id CHECKPOINT_ID --json

`plan` performs no target write. `request` expires, `confirm` does not start,
and `start` consumes that exact confirmation once into one durable checkpoint.
Only `execute` changes managed pack files; it applies exact create/replace/remove
effects, verifies them, and writes the private managed manifest last. `recover`
continues or restores only the exact checkpoint. Collisions, target or manifest
drift, dependency mismatch, downgrade, path escape, symlinks, hardlinks,
special modes, expiry, and confirmation reuse fail closed.

`pack-install-inspection/v1` is the safe CLI and Studio projection. It contains
release, dependency, fingerprint, effect, lifecycle, blocker, and resume facts,
but no target path, capsule path or bytes, file bytes, or raw private state.
Completion proves only exact local materialization and managed-manifest
integrity. Configuration, host realization, uninstall,
network acquisition, package-manager effects, publication, trust, readiness,
verification, and health remain separate and unevaluated or unknown.

## Verify

Run the target verifier:

    node soter/kernel/verify.mjs

Its JSON form exposes the same resolved selections, reasons, dependencies,
bindings, authorities, effects, host declaration, and health states that future
CLI and graphical views should consume:

    node soter/kernel/verify.mjs --json

Prove the verifier catches planted failures:

    node soter/kernel/verify.mjs --selftest

Prove Core output contracts, stale-lock detection, and honest offline states:

    node soter/core/cli.mjs selftest
    npm run soter:mcp:selftest
    node soter/core/cli.mjs fixtures --check
    node soter/core/cli.mjs doctor --lock soter/fixtures/meeting-intake/meeting-intake.lock.json

Inspect the expected missing-write-implementation and missing-probe diagnostics:

    node soter/core/cli.mjs doctor --lock soter/fixtures/meeting-intake/meeting-intake.lock.json --level connected

This exits nonzero by design. Otter and Notion have connected read
declarations, but no private probes are checked in. The Notion readiness plan is
read-only and non-mutating. Notion create and update capabilities are declared,
but live write readiness, permission, response conformance, verification, and
health remain unproven. Connected adapters pass one or more exact-lock
`--probe PATH` artifacts; Core never accepts a fixture result as connected state.

Inspect the structured Otter probe request without calling the provider:

    node soter/core/cli.mjs probe-prepare --configuration-basis private-active --lock .soter/state/configuration-locks/meeting-intake.json --provider provider.integration.otter.mcp --json

The emitted request is `otter/get_user_info` with empty arguments. Core stores
it as private runtime state before returning it. A host can resume through
`probe-complete --checkpoint ID --call CALL_ID --response ABSOLUTE_PRIVATE_PATH`;
the CLI
requires the file's real path to remain outside the repository, and the caller
deletes it after completion. The response is transient input, not durable
state. Core persists only fingerprints and the
normalized probe, and the probe leaves
`meeting.transcript.read` unknown until a specifically authorized transcript
response proves the adapter shape.

Connected doctor accepts a completed durable probe through
`--probe-checkpoint ID` and revalidates it against the current exact lock. A
stale or incomplete checkpoint cannot contribute readiness observations.

Inspect the Notion probe plan without calling Notion:

    node soter/core/cli.mjs probe-prepare --configuration-basis private-active --lock .soter/state/configuration-locks/meeting-intake.json --provider provider.integration.notion.mcp --json

It returns `currentCall`, beginning with `fetch({id: "self"})`. Execute exactly
that resolved native tool through the authenticated host route, then call
`probe-complete --checkpoint ID --call CALL_ID --response ABSOLUTE_PRIVATE_PATH`.
Each successful completion returns the next exact schema, bounded record-read,
or configured document-read call; the twenty-fourth closes a `provider-probe/v2`
with one fingerprint-bound check per step. A stopped, drifted, wrong-lock, or
incomplete plan contributes no probe.

After `npm install`, both host projections can start the same local
`soter-core` stdio server, bound to the launching host identity. Its fixed
provider-probe and work-owned acquisition prepare tools durably checkpoint
provider-neutral operations resolved through the selected host adapter. The
host may explain `currentCall.transport.operation` when present, but must
execute exactly the matching native tool through its separate authenticated MCP route
and return the native result to the matching complete tool. The server does
not call providers, persist raw responses, or originate or widen connected
write approval. Its stdio subprocess self-test establishes only the
shared Core recovery and declared host-projection boundary, not live host or
provider conformance. The self-test resolves and prepares the same portable
request for Codex and Claude, verifies their distinct native tool mappings and
equivalent normalized result, restarts the server with a call pending,
rehydrates it, repairs planted partial state, and rejects stale or tampered
checkpoints.

`operation-plan/v2` is the sole plan contract, but plan preparation is an
internal Core primitive reached only through a work-owned Automation adapter.
There is no public generic plan or capability preparation entrypoint. Fixed-input
steps use `inputBindings: []`; dependent steps bind an exact string or a
unique sorted string list from an earlier normalized output into an unset
input path. Empty bindings explicitly skip or fail. The host may complete or
fail only the exact current call emitted by that adapter; one current call is
durably checkpointed at a time, and every completion requires the exact
checkpoint and call IDs. Normalized outputs and binding fingerprints remain
private while raw host responses are discarded. Internal plan preparation
supplies no write approval and rejects confirmation-gated effects before
creating a checkpoint.

The connected transaction workflow is:

    node soter/core/cli.mjs proposal-connected-batch-preview --lock LOCK --proposal PROPOSAL_ID --action-id ACTION_ID --change-set-id CHANGE_SET_ID --batch-id BATCH_ID --json > /private/preview.json
    # Write preview.batch and preview.changeSet unchanged to separate 0600 private files.
    node soter/core/cli.mjs connected-approval-request --configuration-basis private-active --lock LOCK --run RUN --batch /private/batch.json --change-set /private/change-set.json --request-id REQUEST_ID --reason REASON --expires-at TIME --at TIME --json
    node soter/core/cli.mjs connected-approval-confirm --request-id REQUEST_ID --approval-id APPROVAL_ID --actor ACTOR --reason REASON --at TIME --json
    node soter/core/cli.mjs connected-transaction-prepare --approval-id APPROVAL_ID

Successful start preparation first revalidates the exact lock, batch, approval,
and every finite-age Context observation at the supplied current time. Core
then prepares the initial precondition, write, and directly resolvable
verification calls in memory before it reserves the one-time approval
consumption or persists a connected checkpoint. A failure returns
`CONNECTED_TRANSACTION_PREFLIGHT_FAILED` with a sanitized nested reason code;
it creates no new consumption, checkpoint, current host request, provider call,
or write. The confirmed approval remains unconsumed. Successful preparation
writes private state under `.soter/state` and returns the exact current
precondition or write call. Advance only that native call with
`connected-transaction-complete --checkpoint ID --call CALL_ID --response
ABSOLUTE_PRIVATE_PATH`. Each completion returns at most the next write or
verification call. The MCP equivalent,
`soter_advance_connected_transaction`, accepts only an already-authorized
checkpoint, exact call ID, and native response—never an approval document.
One-time start must be consumed while the approval is current. Restart loads
the same exact current call from the durable checkpoint; repeating start
for the same approval returns the same checkpoint. Ambiguous writes and
verification failures pause without automatic retry or compensation.

Inspect the same structured operator facts used by a graphical interface with:

    node soter/core/cli.mjs operator-inspect --request-id REQUEST_ID --json
    node soter/core/cli.mjs operator-inspect --approval-id APPROVAL_ID --json
    node soter/core/cli.mjs operator-inspect --checkpoint CHECKPOINT_ID --json

The projection includes one derived `resume` classification and permitted next
action. It contains no reusable approval, raw provider response, credential
value, private before/after value, or generic retry boolean.

For a `needs-attention` checkpoint, prepare one read-only observation with:

    node soter/core/cli.mjs connected-transaction-reconcile --checkpoint ID

Execute the returned exact read and pass its response to
`connected-transaction-complete`; MCP uses
`soter_reconcile_connected_transaction` followed by
`soter_advance_connected_transaction`. Reconciliation never accepts approval or
retries a write. The exact verification route is observed again and the owning
Automation evaluator decides whether the expected state is now present. An
expected observation completes the operation and resumes the remaining
sequence; an unexpected or failed observation remains paused for manual
recovery.

`completed` means every selected operation passed its mandatory read-back.
`failed` means a deterministic precondition stopped before its write.
`needs-attention` means Core cannot prove the external effect matches the
approved expected state. Core will not guess, retry the write, claim rollback,
or issue an undeclared inverse. Local self-tests use synthetic host results and do not
prove connected credentials, write permission, consistency, response
conformance, or live health.

Connected acquisition is an explicit preparation mode rather than an implicit
consequence of using a private configuration. Stage it with:

```text
node soter/core/cli.mjs operator-prepare \
  --configuration CONFIGURATION \
  --configuration-basis private-active \
  --preparation-mode connected-acquisition \
  --host codex \
  --automation AUTOMATION_ID \
  --input /absolute/private/operator-input.json \
  --json
```

The MCP equivalent is `soter_stage_automation_acquisition`. Core validates the
private input, exact active lock, host, Automation declaration, and declared
acquisition `recordRequirements`, then creates one minimal durable run and selected-work
private review companion. The sanitized receipt has
`preparationMode=connected-acquisition` and
`state=ready-for-acquisition`. It contains no Context snapshot, fixture preview
facts, capability plan, effects, evidence, approval, continuation request,
provider call, readiness claim, or execution authority. Re-entry is exact;
tracked configuration, missing or ambiguous Integration targets, host or lock
drift, credential-like input, and missing or tampered private material fail
closed. Omitting the mode preserves the existing contained work identity and
fixture-contained preparation behavior.

Record-backed connected ownership is phase-specific. `operator.acquisition`
declares every portable capability and record type needed to acquire Context;
`operator.connection` separately declares every record target needed by later
preconditions, effects, and verification. Kernel resolves both sets through
the selected provider mappings and private settings. A configuration therefore
cannot pass acquisition while omitting a later create or read-back collection,
and neither declaration contains provider-specific target names.

Every declared connected acquisition uses
`soter_prepare_automation_acquisition` and
`soter_finalize_automation_acquisition`; the matching generic CLI commands are
`operator-acquisition-prepare` and `operator-acquisition-finalize`. Both require
the exact Automation and prepared-work IDs, while finalization additionally
requires the exact completed checkpoint ID. Only the generic acquisition
commands exist, preventing an Automation-specific alias from bypassing this
shared exact binding.
Core validates the pack finalizer against the exact durable private
checkpoint, snapshot, run, and paths, but the callable MCP/CLI finalization
result is a closed sanitized receipt: IDs and fingerprints only, explicit
no-authority/privacy facts, and no snapshot values, provider responses, or
private state paths. Private selected-work review remains available only
through a separately declared private inspector. Inspection exports must pair
with pack-owned closed schemas. Core validates the exact schema,
self-fingerprint, work/configuration/lock/graph/host join, no-authority facts,
credential exclusion, and public-or-private privacy boundary before returning a
projection. Governed runtime artifacts and acquisition modules are read only
through realpath-confined, no-symlink-ancestor file checks.

A failed acquisition read has one separate, narrow recovery boundary:
`soter_recover_automation_acquisition` /
`operator-acquisition-recover`. Recovery requires the exact Automation, work,
checkpoint, checkpoint fingerprint, failed step, failed call, and failed-call
fingerprint. Core revalidates the current private-active lock, graph, host, run,
provider, capability contract, authority, resolved input, native transport, and
arguments before it changes private state. It is eligible only when the entire
operation plan declares `read`/`disclosure` effects, the exact failure is
rate-limited or explicitly retryable, `retry.safe=true`, the capability's total
attempt budget remains, and `retry.checkpoint=null`. The initial call is attempt
1. Replacement calls use immutable attempt-specific IDs and preserve every
prior terminal call in the sealed private checkpoint and run history.

Recovery performs no provider call. The separately returned `currentCall` is
the only executable replacement request; its recovery record is a locator, not
reusable retry authority. Exact re-entry requires the refreshed current
checkpoint fingerprint and is idempotent only while that same replacement
remains the pending current call. After it completes or the plan advances,
replay fails closed instead of returning a later unrelated call.
Authentication, authorization, validation, conflict, unavailable, not-found,
unknown, non-read, approval-bearing, exhausted, and prose-checkpoint cases
remain failed. Paginated attempts are intentionally unsupported by this
recovery boundary rather than resuming an excluded cursor or merging pages
across attempts. Connected transaction writes retain their separate
reconciliation model and are never retried through acquisition recovery.

For Meeting Intake, the prepare operation accepts only the exact private-active
`ready-for-acquisition` prepared-work ID.
Core reloads that work,
its selected private review, current active lock, exact host, and bound durable
run before returning the first ordinary plan call. After generic plan completion
closes every configured exact policy-page read, the transcript and Meeting reads, and any
nonempty organization, project, and task chain, finalization requires every
policy URI/title pair and body fingerprint to match, a non-empty
speaker-consistent transcript, exactly one Meetings record with the same normalized
recording URI, and every and only requested related CRM Organization, Project, and
Task identity. It stores the private snapshot under `.soter/state/context-snapshots`,
marks each consumed Meetings or Tasks definition authority loaded, updates the durable
run, and pauses before writes. Provider People IDs remain unresolved references, not
assumed portable Meeting participants or CRM Person identities.

Email uses the same generic MCP and CLI acquisition operations.
Preparation accepts only the exact prepared-work ID and recovers its private
mailbox query from Core's selected-work review material; no query, lock, run, or
snapshot is accepted from the caller. It emits one bounded
`search_email_ids` request and then binds every exact returned message ID into
`batch_read_email_threads`. Finalization requires
complete pagination, unique identities, exact requested-message coverage, and
the current lock/provider/authority basis. It stores normalized mail transport
facts in a private Context snapshot and pauses before triage judgment, draft
generation, approval, continuation, or writes. Static translation and synthetic
response normalization do not establish connector authentication, live response
compatibility, readiness, verification, or health.

After finalization, Email exposes
`soter_inspect_email_triage_decision` and
`soter_commit_email_triage_decision`; the CLI equivalents are
`email-triage-decision-inspect` and `email-triage-decision-commit`. Inspection
returns the selected private snapshot plus a deterministic `needs-input`
template covering every reduced candidate. A ready decision must classify every
and only that exact set, explicitly treat provider `IMPORTANT` as non-authority,
and cite exact bounded subject/body text. Suspected instruction injection is
forced into operator-held high-stakes human review with no reply or handoff
action. The durable decision keeps the run paused and creates no draft,
prepared-work preview, proposed change, approval, continuation request,
provider call, or write. Use `needs-input` instead of guessing.

The shared Email freshness rule does not rely on a fixture-only triage
timestamp: a thread is skipped only when every active inbox message carries the
configured `AI/Triaged` label. Any active untriaged message retains the thread.
Both snapshot and decision remain private state and are excluded from workspace
inspection, evidence, diagnostics, canonical fixtures, and general renderer
state.

The same generic work-owned prepare contract applies to every Automation with a
current available acquisition declaration:

```text
node soter/core/cli.mjs operator-acquisition-prepare --automation AUTOMATION_ID --work WORK_ID [--host HOST] [--at TIME] --json
node soter/core/cli.mjs operator-acquisition-recover --automation AUTOMATION_ID --work WORK_ID --checkpoint CHECKPOINT_ID --checkpoint-fingerprint CHECKPOINT_HASH --step STEP_ID --call FAILED_CALL_ID --call-fingerprint FAILED_CALL_HASH [--host HOST] [--at TIME] --json
node soter/core/cli.mjs operator-acquisition-finalize --automation AUTOMATION_ID --work WORK_ID --checkpoint CHECKPOINT_ID [--host HOST] --json
```

These acquisition adapters, including Slack Conversation Review, derive
the exact private-active configuration, active lock, selected private input,
host, and Core-owned run from `WORK_ID`. Internally supplied time and
expected-host values only tighten revalidation. A caller cannot select or
replace the lock, run, query, provider snapshot, or provider identity.
Every record-backed Notion source selected by exact `input.ids` must therefore
use an exact Notion page URL or UUID in the private configuration. Tracked
contained configurations may retain portable placeholders, but they are not
valid connected provider identities. The adapter returns one canonical
`https://www.notion.so/<page-id>` identity and separately binds it to the exact
configured raw identity fingerprint; equivalent Notion URL spellings need not
be byte-equal.

Internal private-active capability and operation-plan preparation may use only
the exact Core-created `0600` run envelope under `.soter/state/runs`. Public
interfaces can advance the exact current call but cannot originate an arbitrary
capability or plan. The separate fixed provider-probe preparation route remains
public. A repository-authored run, caller-selected run path, or copied
schema-valid document is rejected rather than adopted. This boundary does not
grant approval, one-time start, provider-write, readiness, verification, or
health.

After finalization, `soter_commit_meeting_intake_decision` accepts only bounded
candidate identities, transcript segment indexes, exact policy quotes,
dispositions, reasons, issues, and limitations. Core derives and validates all
record, entry, segment, quote, snapshot, lock, graph, run, and host fingerprints
before writing `.soter/state/automation-decisions`. Use `needs-input` when any
candidate or policy remains unresolved. After compaction,
`soter_inspect_meeting_intake_decision` recovers the exact normalized private
snapshot plus a safe template that already enumerates every candidate as
unresolved.

A `ready` decision can be inspected and committed as one private held
complete-group proposal through `soter_inspect_meeting_intake_proposal`,
`soter_commit_meeting_intake_proposal`, and
`soter_inspect_meeting_intake_proposal_material`. The sanitized proposal carries
fingerprints and action facts only; exact summary text, cited quotes, and task
fold material remain selected-private. Both actions are held with
`COMPLETE_MEETING_READBACK_UNAVAILABLE`, there are zero proposed changes, and
selection fails closed. Proposal commit creates no batch, approval, start
authorization, checkpoint, provider call, write, or verification claim. The CLI
equivalents are:

    node soter/core/cli.mjs meeting-intake-decision-inspect --lock LOCK --snapshot SNAPSHOT_ID --json > /private/decision-workspace.json
    node soter/core/cli.mjs meeting-intake-decision-commit --lock LOCK --snapshot SNAPSHOT_ID --decision-input ABSOLUTE_PRIVATE_PATH --decision-id DECISION_ID --actor ACTOR
    node soter/core/cli.mjs meeting-intake-proposal-inspect --lock LOCK --decision DECISION_ID --json
    node soter/core/cli.mjs meeting-intake-proposal-commit --lock LOCK --decision DECISION_ID --proposal-id PROPOSAL_ID --actor ACTOR --json
    node soter/core/cli.mjs meeting-intake-proposal-material --lock LOCK --proposal PROPOSAL_ID --json

The equivalent Email decision commands are:

    node soter/core/cli.mjs email-triage-decision-inspect --lock LOCK --snapshot SNAPSHOT_ID --json > /private/email-decision-workspace.json
    node soter/core/cli.mjs email-triage-decision-commit --lock LOCK --snapshot SNAPSHOT_ID --decision-input ABSOLUTE_PRIVATE_PATH --decision-id DECISION_ID --actor ACTOR

A ready Email decision can then be turned into one exact review-only proposal.
The inspection returns a private candidate-complete input template; keep the
completed draft, digest, and handoff document outside the repository:

    node soter/core/cli.mjs email-triage-proposal-inspect --lock LOCK --decision DECISION_ID --json > /private/email-proposal-workspace.json
    node soter/core/cli.mjs email-triage-proposal-commit --lock LOCK --decision DECISION_ID --proposal-input /absolute/private/email-proposal.json --proposal-id PROPOSAL_ID --actor ACTOR
    node soter/core/cli.mjs email-triage-proposal-material --lock LOCK --proposal PROPOSAL_ID --json

The corresponding MCP tools are `soter_inspect_email_triage_proposal`,
`soter_commit_email_triage_proposal`, and
`soter_inspect_email_triage_proposal_material`. Core stores a sanitized
`automation-proposal/v1` and selected-private
`automation-proposal-material/v1`, revalidates the pack-owned deterministic
proposal on every read, and keeps the same run paused. These operations create
no approval, continuation request, provider call, label, draft, send, or other
write. The proposal is not compatible with the prepared-work subset API.

To compile an exact proposal subset without creating authority or calling a
provider, use:

    node soter/core/cli.mjs proposal-connected-batch-preview \
      --lock LOCK \
      --proposal PROPOSAL_ID \
      --action-id ACTION_ID \
      --json > /private/email-connected-preview.json

The JSON contains separate `changeSet` and `batch` documents. Keep them outside
the repository, write each unchanged to its own `0600` private JSON file, and
pass those exact documents to the existing
`connected-approval-request`, `connected-approval-confirm`, and
`connected-transaction-prepare` commands shown above. The preview restores
canonical action order, revalidates the current proposal and private companion,
and executes zero provider calls. A changed subset or proposal produces a
different scope. Label-only batches can reach the approval path; draft or mixed
batches fail at preview because the connected draft provider is unavailable.
The same transaction completion and reconciliation commands advance the v2
checkpoint, but reconciliation is read-only and never retries a write.

The generated change-set scope includes the exact decision and context-snapshot
basis. Any changed judgment, citation, candidate disposition, or grounding
therefore requires a new proposal and later approval.

Private run, call, context-snapshot, and Automation-decision state lives under `.soter/state`, uses
atomic restricted files, and is ignored by Git. `soter_list_host_calls` and
`soter_get_host_call` are the recovery interface after compaction or restart.
This state may contain portable inputs and normalized outputs; it must not be
distributed as pack content, fixtures, configuration, or evidence.

## Governed development workflows

Seven active host-guided development workflows are selected by the development
catalog. A realized skill is guidance, not authority. Before using it, call
`soter_create_development_request` with the workflow, request ID, invocation
profile, requested outcome, smallest canonical local-effect subset, and exact
repository-relative targets. Core derives the current active configuration,
lock, and realized host, fingerprints the normalized targets, creates the
private request, and returns only a sanitized
`development-run-inspection/v1`.

Only explicitly requested local reads, writes, commands, and subagent dispatch
are request-scoped. Provider reads or writes, publication, merge, protected-root
mutation, and host realization remain separate authority. Use
`soter_inspect_development_run` with the request ID to recover its sanitized
current, stale, or closed state after compaction or restart; it executes no work
and grants no new authority. Target drift closes the recoverable boundary;
exact result closure alone may account for the declared target changes.

## Soter Studio

Soter Studio is a developer-launched, unbundled desktop projection for
inspecting the current repository. It presents the canonical catalog and graph,
an in-memory configuration preview, a contract-generated operator work surface,
the Meeting Intake and Project Pulse
workflows, their exact contained scenario evidence, checked-in examples,
private local checkpoint metadata, and a persistent Valid / Ready / Verified /
Healthy proof rail. Example activity and local runtime activity are labeled
separately. Scenarios with matching fixture execution evidence expose their
observed capability order, expectation coverage, evidence ID, and linked run;
scenarios without an exact fingerprint-and-lock match remain **Declared—not
executed**. Exact fixture scenario results remain run-scoped and limited; they
do not establish automation maturity. Studio's expandable maturity ledger shows
the declared or unsupported claim, its boundary, and the next proof action;
context, Core, integrations, Kernel, and selected hosts remain declared, so
fixture scenario results do not lift workspace Verified. Core evaluates
`evidence/v2` maturity applicability against the exact subject and version,
lock and graph, full dependency set, host manifest, evaluator level,
containment, result, supersession, and freshness. The ledger exposes stable
reason codes for declared, supported, missing, failed, stale, and inconclusive
claims; labels and maximum test levels never promote Verified by themselves.

Studio presentation, Electron, TypeScript, and test files are not behavior
artifacts of `core.runtime`, so renderer-only changes do not directly enter the
Core pack artifact list. Studio currently shares the root npm manifest and
lock with Core; that install/dependency coupling remains, and dependency
changes can still affect exact Core lock fingerprints. Core retains its Node
`>=20` support declaration; the Studio toolchain requires Node `>=20.19` when
running its developer commands.

The Operate view combines a private preparation queue with the read-only
canonical connected-transaction projection. Studio itself remains free of
provider and canonical-repository writes.
Project Pulse, Meeting Intake, Task Capture, Organization Capture, Contact
Capture, Drive Filing, Feature Capture, Feature Definition, Repository Review,
and Email triage own typed
`automation-input/v1` declarations,
so Studio can mechanically render reference, enum, string, boolean, date, and
URI controls. Each owns a fixture-contained preparation adapter. Core's provider-
neutral `prepareAutomationRun` operation validates their declared inputs,
rejects credential material, binds the explicitly selected configuration and
current exact lock, performs typed fixture reads, and stores a private
`prepared-work/v1` receipt with normalized facts, evidence bases, and an
explicit stop-before-write boundary. Project Pulse grounds one exact project-
status policy, project, promoted-task set, and current project document and
parses the exact real milestone/work-item grammar. It derives progress from exact
work-item/task matches, requires a human health judgment, checks contradictions,
and projects the exact status create plus any required milestone-line replacements
as one complete review group. Meeting Intake grounds the exact transcript,
configured policies, matching meeting, organizations, and exact relationship
candidates, then stops before participant identity resolution, cited judgment,
task disposition, or a write batch. Private field values are fingerprinted by
Core and are absent from the receipt and general projections. Exact normalized
values are stored only in a separate `0600` private review-material companion
bound to the final receipt, checkpoint, input contract, and lock. Later lock
drift marks both views stale and makes resume unavailable. Kernel validates the
generic declarations and adapter ownership without receiving Studio-specific
authority.

Task Capture requires an exact project reference because the governed Context
policy requires every captured task to belong to one project. It derives
`Project` only when no context is supplied, rejects a conflicting context, and
withholds a proposal when a bounded exact-title candidate exists. Optional
assignment is the enum `self`: Integration resolves only the authenticated
current workspace user and never accepts an arbitrary provider-person ID.
Context owns the normalized rules, task fields, provider-person meaning, and
real calendar-date format; Integration owns Notion identity, record, and field
translation. Connected acquisition verifies the exact external policy identity,
current normalized Task schema, project, optional current user, and duplicate
set before a private grounded decision exists. The schema fingerprint and
portable option availability are sealed into the decision basis. An unavailable
status or context option holds the workflow with no proposal or authority. A
ready decision deterministically produces one sanitized `task-create` proposal
plus selected-proposal private material.

The current `review-only-candidate-selection/v1` and
`review-only-candidate-preview/v1` views are authority-free candidate previews.
The durable Task proposal instead enters the
generic `connected-change-set/v2` and `connected-operation-batch/v2` boundary.
An expiring exact-scope request, exact confirmation, and single-use
`approval-consumption/v1` are required before Core creates a private
`connected-transaction-checkpoint/v2`. That checkpoint performs the duplicate-
absence precondition, one create, and mandatory read-after-write verification;
ambiguous writes are never retried into place. Contained host-response fixtures
pass this lifecycle, but live provider authentication, permission, response
conformance, readiness, verified behavior, and health remain unknown.
Decision commit, batch creation, approval request, confirmation, and an
unconsumed or reserved start re-evaluate every finite-age Context observation at
that boundary's current time. Stale inspection projects `needs-input` with
`TASK_CONTEXT_STALE`, and stale decision commit writes no decision. Subsequent
proposal-backed authority creation fails closed with
`PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE` and writes no new request, approval,
consumption, checkpoint, or provider call. Before consumption, Core also
translates and validates the exact provider calls in memory. A
`CONNECTED_TRANSACTION_PREFLIGHT_FAILED` start creates no approval consumption,
connected checkpoint, current host request, or provider effect.

Project Capture reads one exact Projects policy and complete portable creation-profile
set, current project schema, required organization short name for related/client work,
one exact CRM Organization, and bounded exact-name candidates. Manager and
client-contact relations are explicitly unavailable; it never reads or persists a
provider workspace-person identity. Its private
review contains the complete candidate while sanitized inspection exposes only facts,
reason codes, counts, and fingerprints. A clean candidate exposes one exact
`projects.records.create` proposal while preparation itself grants no write
authority. A separately reviewed transaction requires an expiring request,
exact confirmation, single-use start, duplicate-absence precondition, create,
and one content-inclusive read-back bound to the created ID, mapped fields, and
normalized body. Retry and automatic delete remain unavailable. Unsupported
provider-shaped fields remain explicitly unavailable, and contained evidence
does not establish live provider behavior, readiness, verification, or health.

Project Page Reconciliation updates one exact existing Project through the same
provider-neutral boundary. It may change only portable `projectType` and `status`
fields and nonempty page-text regions that each match exactly once in the observed
body. The operator can select the property action, the body action, or both; every
selected action remains bound to the exact private Project identity, title, fields,
body, policy, schema, configuration lock, and connected snapshot. A later expiring
request, exact confirmation, single-use start, per-operation precondition, write,
and content-inclusive readback are required. Combined property and body writes are
ordered and non-atomic, ambiguous outcomes are never retried, and recovery is
checkpoint-bound read-only reconciliation. Exact substitutions may lengthen or
shorten selected text; empty deletion, whole-page replacement, old-text-preserving
append or prepend, replace-all, provider-structural editing, generic non-Project
updates, and automatic compensation are intentionally unavailable. Likewise, capture workflows create one reviewed domain
record at a time; bulk or arbitrary free-form Notion creation is not
supported. Contained evidence proves only the normalized local lifecycle, not live
Notion behavior, readiness, verification, or health.

Drive Filing resolves one configuration-owned Storage registry, reads exact
artifact metadata without content, observes the current document-index schema,
checks bounded exact Link and Name candidates, and optionally resolves exact
organization and authenticated-self identities. The private review always keeps
placement or human-move detail beside the required document-index item. Only
registered homes may be selected; an unclear artifact uses the exact registered
inbox as a visibly provisional destination. Existing organization-owned files or
shortcuts require a human move and can never be copied as a workaround. Retention
remains human-owned, an explicit frozen snapshot is the only reason to choose
copy over shortcut, and any unresolved field, duplicate, invalid option, or skip-
index request holds the entire write plan. The pack declares no proposal adapter
or connected compiler, so preparation creates no request, confirmation,
continuation, provider write, or executable recovery action. Live Drive and
Notion readiness, permissions, behavior, verification, and health remain unknown.

Feature Capture resolves one exact configured Product policy and current feature
schema, then performs a bounded exact-name duplicate read. Required private why stays
in Description; the complete deterministic card body stays in selected-work private
derived review. Requested Type, Area, and Priority values must exist in the current
schema. A provisional why, duplicate, or unavailable option holds the create. The
sanitized preview exposes only reason codes, counts, and fingerprints. The Automation has
no proposal adapter or connected compiler, so it creates no request, confirmation,
continuation, provider call, or executable recovery action.

Feature Definition accepts one exact feature reference, reads its exact record and
body, and supports only the governed Product body spine. It replaces Summary,
type-specific scope/acceptance content, and Decisions while preserving Description,
Planned status, Current State, Relationships, and all record fields. Status-change
pressure is surfaced and excluded rather than folded into the definition. Exact
current/proposed bodies exist only in selected-work private review. The Automation
declares no connected compiler or write authority.

Repository Review selects one exact private repository reference and reads a bounded
normalized capability snapshot through `repository.snapshot.read`. Every capability
must cite at least one non-README source observation, remains at the portable Product
capability altitude, and is compared with bounded exact-name feature candidates from
the configured Product instance. The sanitized review contains only stable row ids,
reason codes, counts, and fingerprints. Candidate names, why, summaries, current-state
notes, evidence paths, and duplicate record identities live only in selected-work
private derived review. New candidates become no-authority handoffs to
`automation.feature-capture`; duplicates remain held. Repository Review creates
no tooling page, Feature Capture work item, Product change, approval, continuation, or
provider write. The local repository fixture proves only deterministic translation and
privacy; connected filesystem/Git access, provider conformance, readiness,
verification, and health remain unknown.

Process Capture reads one exact configured Process policy, current Process schema,
bounded exact-name duplicate set, required role identities, and an optional service
identity. It intersects requested options with the observed schema, keeps definition
work-items inside the deterministic process body, and explicitly declines Task-record
spawning. Exact names, purpose, triggers, steps, identities, body, and duplicate ids
exist only in selected-work private review. The sanitized preview exposes stable codes,
counts, and fingerprints. A complete review may name one fingerprint-only
`process.records.create` change, but the pack declares no proposal adapter or connected
compiler, so no request, approval, continuation, provider call, or executable recovery
action exists.

Process Red Team reads one exact process definition, its related policies, each declared
write-target schema, and—when required—one exact latest run. It applies the governed
completeness, integrity, authority, reliability, and operational-clarity lenses. A
critical finding requires reproduction against the exact run; absent run evidence can
produce only a held should-fix finding. Ranked finding detail and proposed fixes remain
inside selected-work private review. `fixRequested` records pressure but never changes
the report-only boundary. The pack declares only read and disclosure effects and has no
proposal, write, dispatch, approval, continuation, or recovery authority.

Email triage uses one private mailbox query and does not accept an exact-thread
list. The contained oracle reads 15 synthetic provider-returned threads,
deterministically reduces them to 11 included items, four explicit exclusions,
and 10 review rows, and proves inactive-return accounting, RFC822 alias
deduplication, self-sent exclusion, triage freshness, archived/trash sibling
filtering, injection visibility, and `IMPORTANT` non-authority. Sanitized rows
contain only counts, reason codes, opaque fingerprints, handoff codes, and
fingerprint-only label/draft changes. Normalized thread detail, exact AI-label
values, one complete reply draft, handoffs, and the digest body live only in
the selected-work private derived-review companion. The Automation owns that
companion's closed item and field vocabulary through its declared review
contract; Core owns the generic private binding and authority boundary. No mail
send capability is declared. A trusted local operator can select a non-empty
exact subset of proposed label or draft action IDs. Core revalidates the
proposal/private-material pair and current lock, restores canonical order, and
invokes Email's locked pack-owned compiler. The result is
`connected-change-set/v2` plus `connected-operation-batch/v2`; it is still an
authority-free preview and performs no provider calls. The request's selected-
activity private `connected-approval-review-material/v1` binds the exact human-
readable values, precondition, verification, batch, change-set, request, lock,
and run fingerprints without entering workspace inspection.

Label-only subsets may continue through the existing expiring
`approval-request/v1`, exact `approval/v2`, one-time
`approval-consumption/v1`, and private
`connected-transaction-checkpoint/v2`. The checkpoint runs optional read-only
precondition, one exact write, then mandatory read-after-write verification.
Ambiguous write or verification state is never retried; only a separately
checkpointed read-only reconciliation may establish the expected state.
Draft-only and mixed subsets fail before an approval request because no exact
connected draft provider is declared. Send, automatic label removal,
compensation, and write retry remain unavailable.

The `review-only-candidate-selection/v1` and
`review-only-candidate-preview/v1` paths are current no-authority views over
fixture-contained prepared work; they are not approval
inputs and do not become authority. Email label inputs use exact active
message IDs, existing AI/ label names, and prohibit missing-label creation;
draft inputs use an exact reply message ID. The Email Context model owns those
identity distinctions: provider message ID, provider thread ID, RFC822 dedupe
ID, and configured label name are not interchangeable. Codex declares Gmail
connector routes for bounded message search, thread expansion, label apply,
and message read-back. Their static translators and synthetic transaction
tests do not establish authentication, permission, live writes, readiness,
verification, or health.

Task Capture's review-only candidate preview likewise grants no approval, provider
call, execution, retry, or recovery authority. Its separate durable proposal
path binds title, status, context, exact Project identity, optional authenticated-self
identity, and optional pinned date to one `tasks.records.create`, plus exact
same-authority `tasks.records.read` absence and verification observations. Only
Core's later request, confirmation, single-use start, and checkpoint can make
that exact proposal executable.

Project Pulse's separate durable path binds the same prepared-work basis to one
exact connected Context snapshot and private grounded decision. The proposal
must preserve its complete action set: document update first when milestone
lines change, followed by status create. Core rejects partial selection before
approval. The document operation uses an exact prior-content precondition and
replacement transform; status creation uses duplicate absence. Both require
read-after-write verification under the shared approval-v2, consumed start, and
connected checkpoint. The two provider effects are ordered, not externally
atomic. Ambiguity or a later-effect failure enters manual reconciliation and is
never retried automatically. Contained execution passes; live Notion
authentication, permissions, response conformance, readiness, verification,
and health remain unknown.

The terminal uses the same Core operation as Studio. Keep the input document
outside the repository:

    node soter/core/cli.mjs operator-prepare \
      --configuration project-pulse \
      --configuration-basis tracked-contained \
      --automation automation.project-pulse \
      --input /absolute/private/project-pulse-input.json \
      --json

Inspect the same durable private receipt later with:

    node soter/core/cli.mjs operator-prepared-inspect --work-id WORK_ID --json

Explicitly inspect the selected work item's local private review values with:

    node soter/core/cli.mjs operator-prepared-review --work-id WORK_ID --json

If the selected Automation produced normalized private derived review, inspect
that separate companion with:

    node soter/core/cli.mjs operator-prepared-derived-review --work-id WORK_ID --json

Create an immutable review-only candidate selection from exact proposed action
IDs, then inspect only that selection's private values:

    node soter/core/cli.mjs operator-review-only-candidate-selection-create \
      --work-id WORK_ID \
      --action-id ACTION_ID \
      --action-id ANOTHER_ACTION_ID \
      --json

    node soter/core/cli.mjs operator-review-only-candidate-selection \
      --selection-id CANDIDATE_SELECTION_ID --json

Compile the exact selection into a private no-authority candidate preview, then
inspect that same private preview later:

    node soter/core/cli.mjs operator-review-only-candidate-preview-create \
      --selection-id CANDIDATE_SELECTION_ID \
      --json

    node soter/core/cli.mjs operator-review-only-candidate-preview \
      --candidate-preview-id CANDIDATE_PREVIEW_ID --json

These two commands execute no provider call and grant no approval,
continuation, execution, or retry authority.

After an exact connected approval request exists, inspect its private
human-readable batch without confirming it with:

    node soter/core/cli.mjs operator-approval-review --request-id REQUEST_ID --json

These preparation and review commands are intentionally separate from workspace inspection.
Their results are private display material only and grant no approval,
continuation, provider call, or write authority.

For Project Pulse's durable connected path, prepare and finalize the exact
context acquisition, then commit the deterministic decision and proposal:

    node soter/core/cli.mjs operator-acquisition-prepare --automation automation.project-pulse --work WORK_ID --json
    node soter/core/cli.mjs operator-acquisition-finalize --automation automation.project-pulse --work WORK_ID --checkpoint CHECKPOINT_ID --json
    node soter/core/cli.mjs project-pulse-decision-inspect --lock LOCK --snapshot SNAPSHOT_ID --json
    node soter/core/cli.mjs project-pulse-decision-commit --lock LOCK --snapshot SNAPSHOT_ID --decision-id DECISION_ID --actor ACTOR --json
    node soter/core/cli.mjs project-pulse-proposal-inspect --lock LOCK --decision DECISION_ID --json
    node soter/core/cli.mjs project-pulse-proposal-commit --lock LOCK --decision DECISION_ID --proposal-id PROPOSAL_ID --actor ACTOR --json
    node soter/core/cli.mjs project-pulse-proposal-material --lock LOCK --proposal PROPOSAL_ID --json

The inspection and commit results remain private review facts. Use the generic
proposal connected-batch, request, confirmation, start, checkpoint, completion,
and reconciliation operations for later authority; Project Pulse defines no
second approval or execution mechanism.

Sanitized canonical connected-transaction activity may be inspected separately.
Exact approval and start are accepted only through Core's private approval-
request, approval, approval-consumption, and connected-transaction checkpoint
state. A displayed next action is never execution authority. Studio does not
accept raw approvals, provider payloads, or operation batches.
For a blocked private checkpoint, Studio renders Core's completed prefix,
exact current call, pending steps, blockers, verification, compensation, and
checkpoint-bound resume classification separately. It may ask Core to prepare
one read-only reconciliation only when the canonical inspection includes a
safe, separately fingerprinted `prepare-reconciliation` continuation request.
Studio does not execute the resulting provider call, retry a write, or turn
`permittedNextAction` prose into authority.

The Config view can draft a selected host projection, effect policies, and a
compatible optional automation addition, then ask Core for an exact candidate
lock, field-level differences, diagnostics, and the resulting evidence impact.
Core validates that draft as an in-memory replacement through the same Kernel
graph checks used for checked-in configurations and resolves it through the
same lock constructor. It does not hand-edit the current lock or write the
candidate configuration. An unresolved setting, binding, authority, source,
scenario, or host constraint produces a stable diagnostic and no
candidate fingerprint.
Applying a complete private candidate uses a separate configuration transaction:
private exact plan, expiring request, exact local confirmation, one-time start
consumption, durable checkpoint, atomic desired-configuration and private
active-lock file replacement with a checkpoint between them, exact
re-resolution, and verified completion or rollback.
It never edits checked-in fixture locks, makes provider calls, or promotes
readiness, verification, health, or proof state.

Host realization remains a separate explicit ceremony. Core prepares a private
exact-root plan with its own `validUntil`, an expiring request, exact local
confirmation, one-time consumption, and a durable checkpoint. The checkpoint
owns any newly created directories, applies whole-file create/replace/remove
effects with per-file revalidation, writes the private managed manifest last,
and can recover or roll back only exact prior/candidate fingerprints. Existing
files without a manifest, local edits, symlinks, path escape, malformed
manifests, cross-host path collisions, stale locks, and expired plans fail
closed. Codex owns generated `AGENTS.md`, `.codex/config.toml`, and selected
active `.agents/skills/*`; Claude owns generated `CLAUDE.md`, root `.mcp.json`,
and selected active `.claude/skills/*`. Existing settings, hooks, plugins, and
other consumer files are collisions or unmanaged private files, never generation
inputs or adopted authority.

Generated skills are managed host outputs. They are never inputs to generation
and never become canonical definitions.

`host-realization-inspection/v1` is the general UI/CLI projection. It contains
relative paths, fingerprints, lifecycle facts, stable reason codes, and derived
next-action guidance, never the private consumer-root path or file contents.
`localProjection=passed` proves only deterministic local bytes and modes. Host
launch, discovery, authentication, provider reachability, connected behavior,
and health stay `unknown`.

The Harness Development Catalog selects seven governed workflows: Running
Evals, Forge, Reviewing Forge Output, Promoting Pieces, Auditing a Schema,
Authoring a Policy Standard, and Validating Resources. Active guides bind exact
definitions, evaluation sets, workspace policy, supported hosts, and effect
boundaries. Development request/result records keep bounded local changes,
evaluations, limitations, and promotion decisions inspectable without exposing
raw private paths or diffs. They grant no provider, publication, merge,
protected-root, or host-realization authority.

Kernel development governance is declared in
`soter/kernel/development-governance.json`. It defines the provider-neutral
`develop` lifecycle, ownership boundaries, contract-derived scaffolding,
quality rules, fresh isolated evaluation requirements, exact golden freshness,
promotion, and effect separation. Run its focused mechanical check with:

    npm run soter:development-governance:selftest

Adding Project Pulse to another configuration is invalid until that configuration declares the required
policy source. Studio does not synthesize a source, write a draft, or expose an
apply action.

Studio browsing, input rendering, and configuration preview never change
canonical repository artifacts or call live providers. Preparation writes only
ignored private `.soter/state` receipts, run envelopes, context snapshots, and
evidence; it never writes provider records.
Only canonical connected approval/start operations may change their private
approval/checkpoint state; Studio itself has no second transaction engine. It
does not apply configuration, turn prepared work into approval authority, select another workspace,
package an installer, or persist settings. Its successful launch and UI checks
are not evidence of provider readiness, connected health, or automation
verification.

After `npm ci`, run the developer app or its full local check:

    npm run soter:studio:dev
    npm run soter:studio:check
    npm run soter:studio:e2e

The Electron end-to-end suite launches against a contained fixture root and
checks the renderer sandbox, navigation boundaries, file invalidation,
read-only browsing, canonical-file immutability,
keyboard traversal, reduced motion, and WCAG A/AA rules.
It also traverses the scenario proof trace from Workflow to the linked run
evidence while keeping connected readiness and health unknown.

After the exact Codex host projection has been realized into the private
consumer root, its generated `.codex/config.toml` registers only the Soter MCP
runtime. Native Notion, Slack, and Otter connector discovery and authentication
remain external host requirements; the realization does not generate provider
endpoints, install connectors, or store OAuth credentials in the repository.
Restart the task after connector or authentication changes so the host reloads
its available tools.

The exact interactive sequence and its trusted pause boundaries are documented
in [`soter/acceptance/CONNECTED.md`](acceptance/CONNECTED.md).

After a governed pack, contract, Core implementation, or host projection
changes, inspect `soter_inspect_host_runtime` before connected work. A stale
result means the task or host MCP runtime must be restarted; retrying another
operational Soter tool cannot make the old process current.

Generate a proposed lock without provider access:

    node soter/core/cli.mjs resolve --config soter/configurations/meeting-intake.config.json --json

Resolve that same portable configuration for another compatible host without
forking its packs, bindings, authorities, or policies:

    node soter/core/cli.mjs resolve --config soter/configurations/meeting-intake.config.json --host claude --json

Changing the selected host changes the lock and host projection fingerprints.
Unknown or pack-incompatible hosts fail resolution.

Inspect the proposed configuration as concise text, or consume the same
schema-checked facts as JSON from another interface:

    node soter/core/cli.mjs config-inspect
    node soter/core/cli.mjs config-inspect --host claude --json
    node soter/core/cli.mjs config-inspect --lock soter/fixtures/meeting-intake/meeting-intake.lock.json --json

The view explains each selected system and why it is present, dependencies,
bindings, authorities, portable sources, effects, host limitations, and exact
fingerprints. Lock inspection fails if the lock is stale. Fresh resolution
establishes local validity only, so the report keeps ready, verified, and
healthy unknown.

Apply one complete exact candidate only from a private file outside the
repository. The commands return the sanitized inspection contract, never the
private plan document:

    node soter/core/cli.mjs configuration-change-plan --configuration meeting-intake --candidate /absolute/private/meeting-intake.config.json --plan-id configuration-change-plan.meeting-intake.example --json
    node soter/core/cli.mjs configuration-change-request --plan-id configuration-change-plan.meeting-intake.example --request-id configuration-change-request.meeting-intake.example --reason "Review the exact selected configuration change." --expires-at 2026-07-16T16:00:00.000Z --json
    node soter/core/cli.mjs configuration-change-confirm --request-id configuration-change-request.meeting-intake.example --confirmation-id configuration-change-confirmation.meeting-intake.example --actor local-user --reason "Confirm this exact configuration scope." --json
    node soter/core/cli.mjs configuration-change-start --confirmation-id configuration-change-confirmation.meeting-intake.example --checkpoint-id checkpoint.configuration.meeting-intake.example --json
    node soter/core/cli.mjs configuration-change-execute --checkpoint-id checkpoint.configuration.meeting-intake.example --json

`configuration-change-recover` reconciles an interrupted exact checkpoint. A
confirmation is not start authority, a displayed next action is not execution
authority, and a consumed confirmation cannot start a second checkpoint.
Prepared and terminal checkpoints bind their observation to the exact prior or
private-active candidate fingerprints; re-sealing a terminal label over
pre-effect observation cannot produce completion.
If a crash leaves the one-time consumption `reserved` before checkpoint
creation, inspection returns `CONFIGURATION_CONSUMPTION_RESERVED`, `resume-start`,
and the already-bound checkpoint ID. Exact re-entry may finish that reservation
after expiry only when the persisted reservation was timely and the plan remains
current; it cannot choose a new checkpoint or create fresh authority.
An existing reserved checkpoint must validate as that exact prepared
reservation before `resume-start` is shown. If consumption is already `started`
but its bound checkpoint is missing, inspection returns
`CONFIGURATION_CHECKPOINT_MISSING` as `requires-review` with no apply action.
Checkpoint plan, request, confirmation, and consumption references must resolve
to one exact authority chain with causal, monotonic timestamps. Sanitized
inspection never repeats a persisted checkpoint failure summary.
When neither private desired configuration nor active lock exists, the plan
binds the exact consumer-root identity, governed private paths and `0700`/`0600`
modes, absent prior state, complete candidate document, resolved lock, and
graph. First activation is one `added` active-lock row with a null before side
and the exact candidate-lock fingerprint after side, even when the candidate is
byte-identical to the tracked template. The normal confirmed lifecycle still
writes and verifies both the private desired configuration and active lock;
after activation, a new identical private-active candidate is an empty plan.
When the governed graph changes but an existing private desired configuration
is byte-identical, the same lifecycle presents one explicit `lock` change from
the exact prior active-lock fingerprint to the freshly resolved candidate
fingerprint plus identifier-and-fingerprint-only `resolution` rows for changed
packs, capabilities, bindings, sources, authorities, effects, settings, host,
resolver, dependencies, and projections. Core accepts the prior lock only
when its contract, self-fingerprint, configuration name/path, and
desired-document fingerprint remain exact. This is a confirmed local lock
refresh, not silent adoption, issuance provenance, provider authority,
readiness, verification, or health evidence.

Meeting Intake starts from one exact `operator-prepare` receipt, binding its work ID to
`operator-acquisition-prepare` with the exact Automation and work IDs, complete
each emitted read through the host boundary, then call
`operator-acquisition-finalize` with those IDs and the exact checkpoint. Decision and private held proposal
remain separate commands and state families. The current Meeting proposal has
zero selectable changes under `COMPLETE_MEETING_READBACK_UNAVAILABLE`; selected
batch, approval, single-use start, checkpoint, connected execution, and
reconciliation are intentionally unavailable for this workflow. Generic Core
transaction commands remain available only to Automations with a complete
verification contract.

`fixtures --update` is an explicit regeneration operation. Review its diff;
never update fixtures merely to silence a stale-lock failure.
