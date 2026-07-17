# Target implementation

This directory is the provider-neutral implementation of the architecture in
[ARCHITECTURE.md](../ARCHITECTURE.md) and [CONTRACTS.md](../CONTRACTS.md).

The existing .claude directory remains the working prototype and compatibility
bridge while behavior is migrated in vertical slices. Files here must not claim
that mapped behavior has been migrated or proven. Maturity and verification
fields make that distinction mechanical.

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
- migrations maps prototype artifacts to their target ownership and state.
- kernel contains the target verifier shared by every future host projection.
  It rejects contract or capability-schema keywords it cannot enforce and
  self-tests composition, conditional branches, bounds, deep uniqueness, and
  closed privacy shapes so unsupported schema prose cannot masquerade as a
  mechanical guarantee. It also owns deterministic local pack-release and
  transparent-bundle build/verification; those operations grant no install,
  configuration, host, publication, or trust authority.
- automations contains outcome-specific orchestration and completeness rules;
  it asks Core to resolve and persist state rather than owning provider transport
  or runtime storage.
- core contains provider-neutral resolution, preflight, evidence, offline and
  connected doctor operations, a shared execution service, and separate
  resumable capability-call, versioned sequential operation-plan, legacy
  single-call probe, explicit sequential provider-probe-plan, and
  approval-bound connected-transaction bridges. The
  CLI and local Soter MCP server are thin interfaces
  over that service; future graphical interfaces must consume the same boundary.
- studio contains the Electron builder inspector and contained operator surface.
  Its renderer reads one privacy-minimized Core workspace-inspection snapshot
  through a sandboxed preload boundary and never accesses workspace files
  directly. Project Pulse, Meeting Intake, Task Capture, and Email triage can request Core's
  same fixture-contained prepared-work operation; no receipt grants approval or
  execution authority.
- fixtures contains generated, cross-linked examples of exact locks, run
  envelopes, evidence, and doctor results plus normalized contained provider
  inputs. Only fixtures explicitly declared by a pack are governed source
  artifacts; generated locks and runtime-state examples are not implicitly
  distributable.

## First vertical slice

Meeting intake is the first declared slice because it crosses all important
runtime seams:

1. CRM context supplies meeting meaning and authority.
2. The meeting-intake automation declares the outcome and required
   capabilities.
3. Otter and Notion integration packs fulfill those capabilities.
4. Effect policy allows reads but requires confirmation before external writes.
5. Scenarios preserve grounding, staleness, deduplication, and gate invariants.

This increment declares the slice and implements its contained Core path:
deterministic resolution, an artifact-fingerprinted lock, effect-free preflight,
typed local Notion/Otter fixture providers, authority-aware context assembly,
exact-scope approvals, transactional in-memory writes, rollback proof,
read-after-write verification, scoped evidence, and an offline doctor report.
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
exposes `soter_inspect_host_runtime`. It fingerprints governed runtime behavior
at startup and reports `SOTER_HOST_RUNTIME_STALE` when the repository changes
underneath the loaded process; all operational Soter MCP tools then stop before
private-state creation or provider dispatch until the host runtime is
restarted. This applicability check grants no authority and does not promote
readiness, verification, or health. The connected
doctor also consumes failed probe checkpoints through a typed, expiring summary
that identifies the exact lock, provider, semantic step, native route, and
failure category while excluding provider arguments, raw responses, credential
values, and error messages. This makes an unavailable or unauthenticated route
different from an unattempted probe without turning an old failure into current
health evidence. The connected
Otter provider now
translates a canonical meeting URL into exact `fetch({id})` arguments and
produces an identity-only `get_user_info({})` probe. That probe can pass
authentication and reachability while leaving transcript compatibility
unknown. Unobserved transcript response shapes fail closed. The connected
Notion provider now implements bounded CRM record reads using a pack-owned
settings schema, a provider-owned field mapping, and exact native tool mappings
for each host adapter. A connected read is limited to one record type and data
source per host call, avoiding a hidden dependency on plan-gated
cross-data-source SQL. Core can now orchestrate several such reads through one
private sequential operation-plan checkpoint, emitting one exact call at a
time and resuming by checkpoint plus call ID. Plan v1 retains fixed inputs;
plan v2 deterministically binds unique string-list references from earlier
normalized outputs, fingerprints the resolution, and skips empty relations
without a provider request. Meeting-intake Automation uses v2 for a bounded
policy index read, every policy page explicitly wired as an `applicable-policy`
portable source, the exact transcript, the CRM meeting matched by recording URI,
and only the organizations, projects, and tasks referenced through that meeting.
It requires exact policy URI/title agreement and every referenced related ID to
be returned before finalizing, then asks Core to persist a private snapshot and
pause the same run. Each policy entry records its configured subjects and
applicability reason; this does not claim the prose was interpreted or enforced.
Participant profiles remain unloaded. Core mechanically binds every snapshot
entry to exactly one normalized plan output and passed effect before persisting
it. The Notion provider returns deterministic versions for normalized records.
`context.crm` now owns a machine-readable portable record model. Kernel checks
that Automation writes and provider mappings use only its declared fields and
preserve scalar, list, content, mutability, relationship, and deduplication
semantics; Core enforces the same boundary on capability inputs and normalized
outputs. The mapping also scopes read, create, and update per record type rather
than making every mapped Notion database generically writable.
Its private readiness plan emits identity, exact schema and one-row bounded read
checks for every configured target, plus one exact read for every portable
document source marked `probe-read`, one visible host request at a time. The
typed provider mapping binds current property names and types—including the
observed `🫂 Contacts` organization relation—and schema drift fails closed. Only
minimized booleans, counts, and fingerprints enter the final probe; live row
values, policy bodies, and identity values do not. Exact target and document
references remain confined to the private checkpoint and lock scope. This plan
can establish exact-lock `crm.records.read` and `documents.content.read`
readiness, but not policy interpretation, write permission, write response
conformance, automation verification, or health. Otter's
identity-only probe still leaves transcript compatibility unknown. Notion
create and update translators now accept only explicitly mapped fields, but the
ordinary capability and operation-plan interfaces still block them. Core can
  compile an exact connected operation-batch preview with deduplication or
  expected-version preconditions, verification expectations, recovery modes, and
  an expiring approval bound to both the change set and batch. The current
  meeting-intake write set is Context-valid, mapped, and executable under a
  constrained saga contract: compensatable task updates run first and one
  deduplicated summary create runs last. Core captures the created identity,
  reads the exact mapped fields back, and separately reads and fingerprints the
  page title and body. The private durable transaction checkpoint consumes the
  exact approval, compares and retains prior mapped values, verifies each effect,
  compensates verified earlier updates after a later conflict or a create proved
  absent, and surfaces ambiguous effects as `needs-attention` without
  overstating rollback or inventing delete compensation.
Meeting-intake Automation owns its proposal and post-write acceptance checks;
Core owns only the generic approval, dispatch, checkpoint, rollback, and
verifier-invocation mechanics. Before proposal, the Automation now creates a
grounded `automation-decision/v1` that covers the exact meeting and transcript
segments, every bounded task candidate, and every explicitly applicable policy
with exact citations. `ready` requires complete resolution; `needs-input`
records abstention and cannot become a change set. Core stores the connected
decision privately, binds it to the same paused run and context snapshot, and
rejects tampering or a competing decision. The contained and MCP selftests prove
that mechanism, including multiple-candidate disposition and a Codex-produced
decision, but not live judgment quality.
Host-started end-to-end dispatch is unproven, and
the checked-in connected doctor therefore reports `ready=unknown`; the separate
operation-batch compiler proves local representability without claiming live
write readiness. This
increment does not fetch a user's meeting, prove provider transcript or Notion
target conformance, prove host-level agent judgment, or replace the existing
processing-a-meeting guide.

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
integrity. Configuration, host realization, migration execution, uninstall,
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
declarations, but no private probes are checked in and Notion create/update are
not declared. Connected adapters pass one or more exact-lock `--probe PATH`
artifacts; Core never accepts a fixture result as connected state.

Inspect the structured Otter probe request without calling the provider:

    node soter/core/cli.mjs probe-prepare --lock soter/fixtures/meeting-intake/meeting-intake.lock.json --provider provider.integration.otter.mcp --json

The emitted request is `otter/get_user_info` with empty arguments. Core stores
it as private runtime state before returning it. A host can resume through
`probe-complete --checkpoint ID --response ABSOLUTE_PRIVATE_PATH`; the CLI
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

    node soter/core/cli.mjs probe-prepare --lock soter/fixtures/meeting-intake/meeting-intake.lock.json --provider provider.integration.notion.mcp --json

It returns `currentCall`, beginning with `fetch({id: "self"})`. Execute exactly
that resolved native tool through the authenticated host route, then call
`probe-complete --checkpoint ID --call CALL_ID --response ABSOLUTE_PRIVATE_PATH`.
Each successful completion returns the next exact schema, bounded record-read,
or configured document-read call; the twentieth closes a `provider-probe/v2`
with one fingerprint-bound check per step. A stopped, drifted, wrong-lock, or
incomplete plan contributes no probe.

After `npm install`, both host projections can start the same local
`soter-core` stdio server, bound to the launching host identity. Its prepare
tools durably checkpoint provider-neutral operations resolved through the
selected host adapter. The host may explain `currentCall.transport.operation`
when present (or the legacy `checkpoint.call.transport.operation`), but must
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

The same service exposes `soter_prepare_operation_plan` and
`soter_complete_operation_plan`; the CLI equivalents are `plan-prepare` and
`plan-complete`. Plan v1 executes fixed portable inputs. Plan v2 additionally
binds a unique, sorted string list from an exact earlier normalized output path
into an unset later input path. Empty bindings explicitly skip or fail; they do
not become broad reads. Both versions allow one outstanding call and
stop-on-failure behavior. Every completion must include the exact checkpoint
and current call IDs. Normalized outputs and binding fingerprints stay in
private state while raw host responses do not. The interface supplies no write
approval: v1 represents a confirmation-gated step as blocked, while v2 rejects
the unavailable effect before beginning earlier work. Arbitrary transforms,
branching, fan-out, parallelism, plan-level retries, compensation,
approval-bound write execution, and rollback remain outside the general plan
contracts. Those responsibilities belong to the separate connected transaction
checkpoint.

The connected transaction workflow is:

    node soter/core/cli.mjs connected-batch-preview --lock LOCK --change-set CHANGE_SET --batch-id BATCH_ID --json > /private/batch.json
    node soter/core/cli.mjs connected-approval-request --lock LOCK --run RUN --batch /private/batch.json --change-set CHANGE_SET --request-id REQUEST_ID --reason REASON --expires-at TIME --at TIME --json
    node soter/core/cli.mjs connected-approval-confirm --request-id REQUEST_ID --approval-id APPROVAL_ID --actor ACTOR --reason REASON --at TIME --json
    node soter/core/cli.mjs connected-transaction-prepare --approval-id APPROVAL_ID

Preparation writes private state under `.soter/state` and returns one exact
compare call. Execute only its resolved native host tool, then advance with
`connected-transaction-complete --checkpoint ID --call CALL_ID --response
ABSOLUTE_PRIVATE_PATH`; each completion returns at most the next write, verify,
content-verify, compare, or compensation call. The MCP equivalent is
`soter_advance_connected_transaction`, which accepts only an existing
checkpoint ID, exact call ID, and native response—never an approval document.
The request and approval are private runtime state. One-time start consumption
must be reserved before the approval expires (at most fifteen minutes after the
request). The exact checkpoint may continue execution, verification,
reconciliation, and compensation afterward. Repeating prepare for the same
approval returns the same checkpoint; it cannot create a second execution.

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
retries a write. Approved fields resume an ambiguous update, prior fields close
that update and recover earlier verified effects, and only prior fields prove
ambiguous compensation. For a terminal create, approved fields lead to exact
content verification, absence recovers earlier verified updates, and approved
content completes a content ambiguity. Missing, divergent, diverged-content, or
failed reads remain paused and can be observed again later through another
bounded attempt.

This is an external saga, not an ACID transaction. `completed` means every
approved update and required terminal-create read-back passed. `rolled-back`
means verified earlier updates were restored after a later deterministic failure
or a terminal create was read as absent. `failed` means no ambiguous write
remains. `needs-attention` means Core cannot prove whether an external effect or
its compensation occurred. It will not guess, retry the create, or issue an
undeclared delete; its reconciliation history records exact minimized
observations instead. Local self-tests use synthetic host results and do not
prove connected credentials, write permission, consistency, response
conformance, or live health.

Meeting intake also exposes `soter_prepare_meeting_intake_context` and
`soter_finalize_meeting_intake_context`; the CLI equivalents are
`context-connected-prepare` and `context-connected-finalize`. The prepare tool
derives providers and authorities from the exact lock and returns the first
ordinary plan call. After generic plan completion closes the policy index, every
configured exact policy-page read, the transcript and meeting reads, and any
nonempty organization, project, and task chain, finalization requires every
policy URI/title pair and body fingerprint to match, a non-empty
speaker-consistent transcript, exactly one CRM meeting with the same normalized
recording URI, and every and only requested related record ID. It stores the
private snapshot under `.soter/state/context-snapshots`, marks the definition
authority loaded, updates the durable run, and pauses before writes. Participant
People IDs remain references, not assumed CRM contact page URIs.

Email exposes the parallel transport-only tools
`soter_prepare_email_triage_context` and
`soter_finalize_email_triage_context`; the CLI equivalents are
`email-context-connected-prepare` and `email-context-connected-finalize`.
Preparation emits one bounded `search_email_ids` request and then binds every
exact returned message ID into `batch_read_email_threads`. Finalization requires
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

After finalization, `soter_commit_meeting_intake_decision` accepts only bounded
candidate identities, transcript segment indexes, exact policy quotes,
dispositions, reasons, issues, and limitations. Core derives and validates all
record, entry, segment, quote, snapshot, lock, graph, run, and host fingerprints
before writing `.soter/state/automation-decisions`. Use `needs-input` when any
candidate or policy remains unresolved. `soter_propose_meeting_intake_change_set`
projects only a `ready` decision and creates neither approval nor provider call.
After compaction, `soter_inspect_meeting_intake_decision` recovers the exact
normalized private snapshot plus a safe template that already enumerates every
candidate as unresolved. The CLI equivalents are:

    node soter/core/cli.mjs meeting-intake-decision-inspect --lock LOCK --snapshot SNAPSHOT_ID --json > /private/decision-workspace.json
    node soter/core/cli.mjs meeting-intake-decision-commit --lock LOCK --snapshot SNAPSHOT_ID --decision-input ABSOLUTE_PRIVATE_PATH --decision-id DECISION_ID --actor ACTOR
    node soter/core/cli.mjs meeting-intake-proposal --lock LOCK --decision DECISION_ID --change-set-id CHANGE_SET_ID --json > /private/change-set.json

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
the repository and pass those exact documents to the existing
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
Core pack artifact list. This milestone still shares the root npm manifest and
lock with Core; that install/dependency coupling is unresolved, and dependency
changes can still affect exact Core lock fingerprints. Core retains its Node
`>=20` support declaration; the Studio toolchain requires Node `>=20.19` when
running its developer commands.

The Operate view combines a private preparation queue with the read-only
canonical connected-transaction projection. Studio itself remains free of
provider and canonical-repository writes.
Project Pulse, Meeting Intake, Task Capture, and Email triage own typed
`automation-input/v1` declarations,
so Studio can mechanically render reference, enum, string, boolean, date, and
URI controls. All four own fixture-contained preparation adapters. Core's provider-
neutral `prepareAutomationRun` operation validates their declared inputs,
rejects credential material, binds the explicitly selected configuration and
current exact lock, performs typed fixture reads, and stores a private
`prepared-work/v1` receipt with normalized facts, evidence bases, and an
explicit stop-before-write boundary. Read-only Project Pulse contains no
proposed changes. Meeting Intake grounds the exact transcript, configured
policies, matching meeting, organizations, and exact relationship candidates,
then stops before participant identity resolution, cited judgment, task
disposition, or a write batch. Private field values are fingerprinted by Core
and are absent from the receipt and general projections. Exact normalized
values are stored only in a separate `0600` private review-material companion
bound to the final receipt, checkpoint, input contract, and lock. Later lock
drift marks both views stale and makes resume unavailable. Kernel validates the
generic declarations and adapter ownership without receiving Studio-specific
authority.

Task Capture requires its project reference because the selected normalized
policy requires every captured task to belong to one exact project. It derives
`Project` only when no context is supplied, rejects a conflicting context, and
withholds a create proposal when a bounded exact-title candidate exists. Its
preview has kind `task-capture-preview`; the title and optional date are visible
only through the selected work item's private review operation. Context owns
the normalized policy, task fields, provider-person reference, and real
calendar-date format. Integration owns Notion translation for title, status,
context, project, assignee, and date. The external policy body is not yet a
trusted structured definition projection, provider-person availability and
write response conformance are unproven, and portable task body shaping is not
implemented. The slice therefore stops before a change set, approval, one-time
start consumption, connected call, or provider write.

Email triage uses one private mailbox query and no exact-thread list in this
milestone. The contained oracle reads 15 synthetic provider-returned threads,
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

The older `prepared-review-batch/v1` and `prepared-connected-plan/v1` paths
remain review-only views over fixture-contained prepared work; they are not
approval inputs and do not become authority. Label inputs use exact active
message IDs, existing AI/ label names, and prohibit missing-label creation;
draft inputs use an exact reply message ID. The Email Context model owns those
identity distinctions: provider message ID, provider thread ID, RFC822 dedupe
ID, and configured label name are not interchangeable. Codex declares Gmail
connector routes for bounded message search, thread expansion, label apply,
and message read-back. Their static translators and synthetic transaction
tests do not establish authentication, permission, live writes, readiness,
verification, or health.

The terminal uses the same Core operation as Studio. Keep the input document
outside the repository:

    node soter/core/cli.mjs operator-prepare \
      --configuration project-pulse \
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

Create an immutable review-only subset from exact proposed action IDs, then
inspect only that selected batch's private values:

    node soter/core/cli.mjs operator-review-batch-create \
      --work-id WORK_ID \
      --action-id ACTION_ID \
      --action-id ANOTHER_ACTION_ID \
      --json

    node soter/core/cli.mjs operator-review-batch --batch-id REVIEW_BATCH_ID --json

Compile the exact selected batch into a private, review-only connected
candidate plan, then inspect that same private plan later:

    node soter/core/cli.mjs operator-connected-plan-create \
      --batch-id REVIEW_BATCH_ID \
      --json

    node soter/core/cli.mjs operator-connected-plan --plan-id PREPARED_PLAN_ID --json

These two commands execute no provider call and grant no approval,
continuation, execution, or retry authority.

After an exact connected approval request exists, inspect its private
human-readable batch without confirming it with:

    node soter/core/cli.mjs operator-approval-review --request-id REQUEST_ID --json

These preparation and review commands are intentionally separate from workspace inspection.
Their results are private display material only and grant no approval,
continuation, provider call, or write authority.

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
scenario, migration, or host constraint produces a stable diagnostic and no
candidate fingerprint.
Applying a complete private candidate uses a separate configuration transaction:
private exact plan, expiring request, exact local confirmation, one-time start
consumption, durable checkpoint, atomic desired-configuration and private
active-lock file replacement with a checkpoint between them, exact
re-resolution, and verified completion or rollback.
It never edits checked-in fixture locks, makes provider calls, or promotes
readiness, verification, health, proof, or migration state.

Host realization remains a separate explicit ceremony. Core prepares a private
exact-root plan with its own `validUntil`, an expiring request, exact local
confirmation, one-time consumption, and a durable checkpoint. The checkpoint
owns any newly created directories, applies whole-file create/replace/remove
effects with per-file revalidation, writes the private managed manifest last,
and can recover or roll back only exact prior/candidate fingerprints. Existing
files without a manifest, local edits, symlinks, path escape, malformed
manifests, cross-host path collisions, stale locks, and expired plans fail
closed. Codex currently owns generated `AGENTS.md` and `.codex/config.toml`;
Claude owns generated `CLAUDE.md` and `.claude/.mcp.json`. Other legacy Claude
artifacts remain migration inputs rather than generated authority.

`host-realization-inspection/v1` is the only general UI/CLI projection. It
contains relative paths, fingerprints, lifecycle facts, stable reason codes,
and derived next-action guidance, never the private consumer-root path or file
contents. `localProjection=passed` proves only deterministic local bytes and
modes. Host launch, discovery, authentication, provider reachability,
connected behavior, and health stay `unknown`.
Project Pulse maps the legacy project-status guide and three evaluations. Its
separate desired configuration selects one portable read capability and one
explicit definition-authority policy source. Its target scenarios are contained
fixture evidence for deterministic policy, project, task, and milestone
grounding. The preparation adapter reuses that contained context behavior but
produces separate private preparation evidence rather than scenario evidence.
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

The Codex projection registers Otter in `.codex/config.toml`. After trusting
the project, authenticate once with `codex mcp login otter` or through Codex
desktop MCP settings, then restart the task so the server tools are loaded.
Notion is supplied by the external Codex app connector. Neither route stores
OAuth credentials in the repository.

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
schema-checked facts as JSON from a future UI:

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

Exercise typed context assembly without external access:

    node soter/core/cli.mjs context --lock soter/fixtures/meeting-intake/meeting-intake.lock.json --scenario soter/scenarios/meeting-intake/happy-path.scenario.json --meeting-id meeting.fixture-001 --recording-uri otter://fixture/meeting.fixture-001

Preview or approve the contained transaction:

    node soter/core/cli.mjs transaction --lock soter/fixtures/meeting-intake/meeting-intake.lock.json --scenario soter/scenarios/meeting-intake/happy-path.scenario.json
    node soter/core/cli.mjs transaction --lock soter/fixtures/meeting-intake/meeting-intake.lock.json --scenario soter/scenarios/meeting-intake/happy-path.scenario.json --approve

`fixtures --update` is an explicit regeneration operation. Review its diff;
never update fixtures merely to silence a stale-lock failure.

During migration, both the legacy checker and the target verifier must pass.
The legacy checker protects behavior that has not moved; the target verifier
protects the new contracts and resolved graph. The migration ends this overlap
by retiring the legacy entrypoint after all owned behavior has moved.
