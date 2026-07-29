# Connected developer acceptance

This runbook exercises one exact Soter candidate, private configuration, lock,
consumer root, and host at a time. Codex and Claude are separate observations.
Nothing in this procedure establishes global host parity, provider readiness,
verification, or health.

The existing Core transaction families remain authoritative. This document does
not grant provider-call, approval, start, retry, reconciliation, or recovery
authority.

## Private-material boundary

Create all configuration candidates, operator inputs, provider responses,
proposal material, batches, and change sets in one external private directory.
On POSIX systems the directory must be mode `0700` and each file mode `0600`.
Keep it outside the repository and consumer root.

Never copy native provider results into Git, fixtures, evidence, shell history,
command transcripts, or general logs. Pass each result unchanged from the
authenticated host tool directly into the exact pending Soter completion call,
then remove any temporary file immediately. Never retype, summarize, edit, or
replay a native result.

The final report may contain only sanitized identifiers, fingerprints, counts,
states, stable reason codes, and claim limitations. It must exclude credentials,
consumer and provider target paths, private configuration values, operator
inputs, channel and record identities, cursors, message bodies, task values,
provider arguments and results, and raw before/after values.

## Candidate and host prerequisites

For each host:

1. Create a clean detached consumer root at the exact candidate commit.
2. Install the repository dependencies.
3. Create a complete private configuration candidate with exact provider
   targets, policy sources, option mappings, and authorities.
4. Record only the candidate tree fingerprint, host, configuration name, lock
   fingerprint, graph fingerprint, and consumer-root identity fingerprint.
5. Confirm that no prior canary input, batch, approval, checkpoint, or provider
   response will be reused.

## Pause 1: private configuration confirmation

Prepare and inspect the exact local configuration transaction:

```text
configuration-change-plan
configuration-change-request
configuration-change-inspect
```

Stop and present the exact plan, effects, expiry, and fingerprints for trusted
operator confirmation. After confirmation:

```text
configuration-change-confirm
configuration-change-start
configuration-change-execute
configuration-change-inspect
```

Confirmation performs no apply. Start is separately validated and single-use.

## Pause 2: host-realization confirmation

Prepare and inspect the exact managed host-output plan:

```text
host-realization-plan
host-realization-request
host-realization-inspect
```

Stop for trusted operator confirmation. Then:

```text
host-realization-confirm
host-realization-start
host-realization-execute
host-realization-inspect
```

Restart the host after realization and require
`soter_inspect_host_runtime` to report the exact runtime as current. Successful
realization proves deterministic local projection only. It does not prove
connector discovery, authentication, reachability, provider behavior, or
health.

## Pause 3: every native host call

Provider probes, connected Context acquisition, transaction preconditions,
writes, verification, and reconciliation all use the same boundary:

1. Inspect the exact pending host call.
2. Stop before invoking the provider.
3. Invoke only `currentCall.transport.tool` with its exact arguments through the
   authenticated host.
4. Return the native result immediately and unchanged to the matching Soter
   completion operation.
5. Inspect the durable host-call and owning checkpoint before proceeding.

Use the matching Soter operation for the current family:

```text
soter_complete_provider_probe
soter_complete_operation_plan
soter_advance_connected_transaction
```

If the host cannot return the required closed response, fail the current call
with a coarse stable failure kind. Do not try another tool, parse presentation
prose, infer pagination, rewrite a result, retry a write, or fabricate success.

After restart or compaction, inspect `soter_list_host_calls`,
`soter_get_host_call`, and `soter_inspect_host_runtime`. Resume only the exact
current call. A completed checkpoint has no continuation.

## Slack Conversation Review

The current Codex connector returns structured conversation metadata but
human-formatted message and pagination prose. That is not the closed message and
thread response required by Soter. Claude has no declared closed Slack response
profile.

Connected Slack Conversation Review therefore remains unavailable with
`CLOSED_MESSAGE_THREAD_RESPONSE_UNAVAILABLE`. Do not stage connected work, parse
the prose, substitute search, infer complete coverage, or create a provider-call
checkpoint. Fixture-contained review remains separate and grants no live Slack
claim.

The unblock condition is a connector response containing closed message records
with stable message, author, thread, timestamp, content, and reply-count fields,
plus closed cursor metadata for both channel and thread reads. That response
must be adversarially verified separately for each host before availability
changes.

## Task Capture review

Stage one fresh connected acquisition and follow its exact calls:

```text
soter_stage_automation_acquisition
soter_prepare_task_capture_context
soter_complete_operation_plan
soter_finalize_task_capture_context
```

Then inspect and commit the private decision and proposal, inspect the selected
private proposal material, and compile the exact selected action:

```text
task-capture-decision-inspect
task-capture-decision-commit
task-capture-proposal-inspect
task-capture-proposal-commit
task-capture-proposal-material
proposal-connected-batch-preview
```

The trusted review must show one uniquely named canary, the exact selected
action, duplicate precondition, proposed value fingerprints, verification plan,
and the no-delete/no-retry boundary. Preparation and review grant no write
authority.

## Pause 4: exact write approval and single-use start

Create the expiring request and inspect the exact private approval material:

```text
connected-approval-request
operator-approval-review
operator-inspect
```

Stop for explicit exact-scope confirmation. Then:

```text
connected-approval-confirm
connected-transaction-prepare
operator-inspect
```

Confirmation still performs no provider write. Transaction preparation
separately consumes the confirmation once and creates the durable checkpoint.
Inspect that checkpoint before every native call.

Advance only the emitted duplicate precondition, single create, and exact
read-back through Pause 3. An ambiguous result or `needs-attention` state permits
only checkpoint-bound read-only reconciliation. Never retry the create and
never silently delete the canary; no delete compensation exists.

## Final truth and current canaries

The final report must preserve each host independently:

- The current Claude canary has a completed transaction checkpoint and verified
  read-back.
- The historical Codex canary completed one write. Its pre-fix checkpoint
  remains `needs-attention` because the old decoder rejected a valid provider
  person identity during verification and reconciliation. Current code
  separately normalized and verified the live record, but it cannot rewrite a
  checkpoint sealed to the old graph. Do not create another Task, relabel the
  checkpoint, or treat external read-back as checkpoint completion.
- Slack connected acquisition is unavailable and not evaluated.

A report may state that the exact observed Claude transaction completed and
that the exact Codex record exists under the corrected decoder. It may not
aggregate those facts into host parity, broad readiness, global verification,
or health. `valid` may pass for the local graph while `ready`, `verified`, and
`healthy` remain unknown outside the exact observations.
