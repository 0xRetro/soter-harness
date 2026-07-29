import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFixtureRuntimeState, invokeCapability } from './capabilities.mjs';
import { inspectWorkspace } from './inspection.mjs';
import { fingerprintJson, fingerprintPath, readJson } from './lib/canonical-json.mjs';
import {
  assertPreparedConnectedPlan,
  createPreparedConnectedPlan,
  evaluatePreparedConnectedVerification,
  inspectPreparedConnectedPlan
} from './prepared-connected-plans.mjs';
import { createPreparedReviewBatch } from './prepared-review-batches.mjs';
import { prepareAutomationRun } from './prepared-work.mjs';
import { preparedConnectedPlanStatePath } from './runtime-state.mjs';
import { completeHostToolCall, prepareHostToolCall } from './host-tools.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-07-16T19:00:00.000Z';

function resignPlan(plan) {
  const unsigned = structuredClone(plan);
  delete unsigned.fingerprint;
  delete unsigned.configuration.applicability;
  plan.fingerprint = fingerprintJson(unsigned);
  return plan;
}

async function invokeFixture({
  root,
  lock,
  operation,
  verification = false,
  state,
  input = null
}) {
  const specification = verification ? operation.verification : operation;
  return invokeCapability({
    root,
    lock,
    capability: specification.capability,
    authority: operation.authority,
    containment: 'fixture',
    input: input === null ? specification.input : input,
    effectId: 'effect.selftest.' + operation.sequence + (verification ? '.verify' : '.write'),
    at: AT,
    approvedEffects: verification ? [] : ['write'],
    runtimeState: state
  });
}

export async function selftestPreparedConnectedPlans(root = defaultRoot) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-connected-plan-selftest-'));
  try {
    fs.cpSync(path.join(root, 'soter'), path.join(temporaryRoot, 'soter'), { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
    }
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const focus = 'PRIVATE_CONNECTED_PLAN_FOCUS_SENTINEL';
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.email-triage',
      configurationName: 'email-triage',
      configurationBasis: 'tracked-contained',
      input: {
        query: 'in:inbox newer_than:1d',
        scope: 'triage-drafts-handoffs-digest',
        focus
      },
      createdAt: AT
    });
    const rows = work.preview.collections.flatMap((collection) => collection.rows);
    const collapsedLabel = rows.find((row) => {
      return row.representedCount > 1
        && row.actions.some((action) => action.kind === 'label' && action.state === 'proposed');
    })?.actions.find((action) => action.kind === 'label' && action.state === 'proposed');
    const draft = rows.flatMap((row) => row.actions).find((action) => {
      return action.kind === 'draft' && action.state === 'proposed';
    });
    assert(collapsedLabel, 'Email fixture must provide a collapsed proposed label action.');
    assert(draft, 'Email fixture must provide one proposed draft action.');

    const batch = createPreparedReviewBatch({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [draft.id, collapsedLabel.id],
      createdAt: '2026-07-16T19:01:00.000Z'
    });
    assert.deepEqual(batch.blockers, [
      'CONNECTED_PLAN_NOT_COMPILED',
      'CONNECTED_VERIFICATION_NOT_PROVEN'
    ]);
    const plan = await createPreparedConnectedPlan({
      root: temporaryRoot,
      batchId: batch.id,
      createdAt: '2026-07-16T19:02:00.000Z'
    });
    assert.equal(plan.$contract, 'soter://contracts/prepared-connected-plan/v1');
    assert.equal(plan.state, 'blocked-review-only');
    assert.equal(plan.executable, false);
    assert.equal(plan.configuration.applicability, 'current');
    assert.equal(plan.privacy.authority, 'none');
    assert.equal(plan.privacy.privateValuesIncluded, true);
    assert.equal(plan.privacy.providerArgumentsIncluded, true);
    assert.equal(plan.privacy.approvalAuthorityIncluded, false);
    assert.equal(plan.privacy.continuationAuthorityIncluded, false);
    assert.equal(plan.privacy.executionAuthorityIncluded, false);
    assert.equal(plan.privacy.retryAuthorityIncluded, false);
    assert.deepEqual(plan.blockers, [
      'CONNECTED_PROVIDER_NOT_DECLARED',
      'CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED',
      'CONNECTED_VERIFICATION_NOT_PROVEN',
      'SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE'
    ]);
    assert.equal(plan.operations.length, batch.actions.length,
      'One collapsed label action must remain one exact message-set operation.');
    assert.deepEqual([...new Set(plan.operations.map((operation) => operation.sourceActionId))],
      batch.actions.map((action) => action.id));
    assert(plan.operations.every((operation, index) => {
      return operation.sequence === index + 1
        && operation.authority === 'authority.mailbox.instance'
        && operation.provider.pack === 'integration.gmail'
        && operation.verification.provider.pack === 'integration.gmail'
        && operation.inputFingerprint === fingerprintJson(operation.input)
        && operation.verification.inputFingerprint === fingerprintJson(
          operation.verification.input
        )
        && operation.ambiguity.retry === 'prohibited'
        && operation.ambiguity.reconcileWith === 'verification'
        && operation.recovery.mode === 'manual-required';
    }));
    const labelOperation = plan.operations.find((operation) => {
      return operation.capability === 'mail.labels.apply';
    });
    const draftOperation = plan.operations.find((operation) => {
      return operation.capability === 'mail.drafts.create';
    });
    assert(labelOperation, 'The selected label action must compile.');
    assert(draftOperation, 'The selected draft action must compile.');
    assert.equal(
      labelOperation.provider.connectedImplementation,
      'provider.integration.gmail.mcp'
    );
    assert.equal(
      labelOperation.verification.provider.connectedImplementation,
      'provider.integration.gmail.mcp'
    );
    assert.equal(draftOperation.provider.connectedImplementation, null);
    assert.equal(draftOperation.verification.provider.connectedImplementation, null);
    assert(labelOperation.input.messageIds.length > 1,
      'The collapsed label action must bind all represented exact message IDs.');
    assert.equal(labelOperation.input.createMissingLabels, false);
    assert(!JSON.stringify(plan).includes('mail.send'));
    assert(JSON.stringify(plan).includes('Thanks for the note.'),
      'The selected private plan must durably bind exact draft provider arguments.');

    const planFile = preparedConnectedPlanStatePath(temporaryRoot, plan.id);
    assert.equal(fs.statSync(planFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(planFile)).mode & 0o777, 0o700);
    const reentered = await createPreparedConnectedPlan({
      root: temporaryRoot,
      batchId: batch.id,
      createdAt: '2026-07-16T19:03:00.000Z'
    });
    assert.equal(reentered.id, plan.id);
    assert.equal(reentered.fingerprint, plan.fingerprint);
    assert.equal(reentered.createdAt, plan.createdAt,
      'Exact re-entry must preserve the create-only private plan.');
    const inspected = await inspectPreparedConnectedPlan({
      root: temporaryRoot,
      planId: plan.id
    });
    assert.equal(inspected.fingerprint, plan.fingerprint);

    const lock = readJson(path.join(temporaryRoot, batch.configuration.lockPath));
    const labelBatch = createPreparedReviewBatch({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [collapsedLabel.id],
      createdAt: '2026-07-16T19:03:30.000Z'
    });
    const labelPlan = await createPreparedConnectedPlan({
      root: temporaryRoot,
      batchId: labelBatch.id,
      createdAt: '2026-07-16T19:04:00.000Z'
    });
    assert.deepEqual(labelPlan.blockers, [
      'CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED',
      'CONNECTED_VERIFICATION_NOT_PROVEN',
      'SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE'
    ]);
    const connectedLabel = labelPlan.operations[0];
    assert.equal(connectedLabel.provider.connectedImplementation, 'provider.integration.gmail.mcp');
    assert.equal(
      connectedLabel.verification.provider.connectedImplementation,
      'provider.integration.gmail.mcp'
    );

    const preparedLabelWrite = await prepareHostToolCall({
      root: temporaryRoot,
      lock,
      runId: 'run.email-triage.connected-label-selftest',
      callId: 'toolcall.email-triage.connected-label-write',
      capability: connectedLabel.capability,
      authority: connectedLabel.authority,
      providerImplementation: connectedLabel.provider.connectedImplementation,
      input: connectedLabel.input,
      at: '2026-07-16T19:04:10.000Z',
      approvedEffects: ['write']
    });
    assert.equal(preparedLabelWrite.call.state, 'requested');
    assert.equal(preparedLabelWrite.call.transport.operation, 'apply_labels_to_emails');
    assert.equal(
      preparedLabelWrite.call.transport.tool,
      'mcp__codex_apps__gmail_apply_labels_to_emails'
    );
    assert.deepEqual(preparedLabelWrite.call.arguments, {
      message_ids: connectedLabel.input.messageIds,
      add_label_names: connectedLabel.input.addLabelNames,
      remove_label_names: [],
      create_missing_labels: false
    });
    const rawWriteMarker = 'RAW_GMAIL_WRITE_RESPONSE_SENTINEL';
    const completedLabelWrite = await completeHostToolCall({
      root: temporaryRoot,
      lock,
      call: preparedLabelWrite.call,
      input: connectedLabel.input,
      response: {
        structuredContent: {
          result: { state: 'acknowledged' }
        }
      },
      at: '2026-07-16T19:04:11.000Z'
    });
    assert.equal(completedLabelWrite.call.state, 'completed');
    assert(!JSON.stringify(completedLabelWrite).includes(rawWriteMarker));
    const preparedHostileLabelWrite = await prepareHostToolCall({
      root: temporaryRoot,
      lock,
      runId: 'run.email-triage.connected-label-selftest',
      callId: 'toolcall.email-triage.connected-label-write-hostile-extra',
      capability: connectedLabel.capability,
      authority: connectedLabel.authority,
      providerImplementation: connectedLabel.provider.connectedImplementation,
      input: connectedLabel.input,
      at: '2026-07-16T19:04:11.100Z',
      approvedEffects: ['write']
    });
    const rejectedHostileLabelWrite = await completeHostToolCall({
      root: temporaryRoot,
      lock,
      call: preparedHostileLabelWrite.call,
      input: connectedLabel.input,
      response: {
        structuredContent: {
          result: { state: 'acknowledged', rawProviderResponse: rawWriteMarker }
        }
      },
      at: '2026-07-16T19:04:11.200Z'
    });
    assert.equal(rejectedHostileLabelWrite.call.state, 'failed');
    assert.equal(rejectedHostileLabelWrite.call.error.kind, 'validation');
    assert(!JSON.stringify(rejectedHostileLabelWrite).includes(rawWriteMarker));

    const preparedLabelRead = await prepareHostToolCall({
      root: temporaryRoot,
      lock,
      runId: 'run.email-triage.connected-label-selftest',
      callId: 'toolcall.email-triage.connected-label-read',
      capability: connectedLabel.verification.capability,
      authority: connectedLabel.authority,
      providerImplementation: connectedLabel.verification.provider.connectedImplementation,
      input: connectedLabel.verification.input,
      at: '2026-07-16T19:04:12.000Z'
    });
    assert.equal(preparedLabelRead.call.state, 'requested');
    assert.equal(preparedLabelRead.call.transport.operation, 'batch_read_email');
    assert.equal(
      preparedLabelRead.call.transport.tool,
      'mcp__codex_apps__gmail_batch_read_email'
    );
    assert.deepEqual(preparedLabelRead.call.arguments, {
      message_ids: connectedLabel.verification.input.messageIds
    });
    const rawBodyMarker = 'RAW_GMAIL_MESSAGE_BODY_SENTINEL';
    const completedLabelRead = await completeHostToolCall({
      root: temporaryRoot,
      lock,
      call: preparedLabelRead.call,
      input: connectedLabel.verification.input,
      response: {
        structuredContent: {
          result: {
            messages: connectedLabel.verification.input.messageIds.map((id) => ({
              id,
              labels: ['INBOX', ...connectedLabel.verification.input.labelNames],
              body: rawBodyMarker
            }))
          }
        }
      },
      at: '2026-07-16T19:04:13.000Z'
    });
    assert.equal(completedLabelRead.call.state, 'completed');
    assert(!JSON.stringify(completedLabelRead).includes(rawBodyMarker));
    const connectedVerification = await evaluatePreparedConnectedVerification({
      root: temporaryRoot,
      planId: labelPlan.id,
      operationId: connectedLabel.id,
      output: completedLabelRead.output
    });
    assert.equal(connectedVerification.state, 'passed');
    assert.equal(connectedVerification.retryPermitted, false);

    const fixtureState = createFixtureRuntimeState(temporaryRoot);
    for (const operation of plan.operations) {
      const before = await invokeFixture({
        root: temporaryRoot,
        lock,
        operation,
        verification: true,
        state: fixtureState
      });
      assert.equal(before.invocation.state, 'passed');
      const beforeResult = await evaluatePreparedConnectedVerification({
        root: temporaryRoot,
        planId: plan.id,
        operationId: operation.id,
        output: before.output
      });
      assert.equal(beforeResult.state, 'failed');
      assert.equal(beforeResult.reasonCode, 'READ_AFTER_WRITE_MISMATCH');
      assert.equal(beforeResult.retryPermitted, false);

      const write = await invokeFixture({
        root: temporaryRoot,
        lock,
        operation,
        verification: false,
        state: fixtureState
      });
      assert.equal(write.invocation.state, 'passed');
      const observed = await invokeFixture({
        root: temporaryRoot,
        lock,
        operation,
        verification: true,
        state: fixtureState
      });
      assert.equal(observed.invocation.state, 'passed');
      assert(!JSON.stringify(observed.output).includes('Thanks for the note.'),
        'Minimized verification output must never return a draft body.');
      const result = await evaluatePreparedConnectedVerification({
        root: temporaryRoot,
        planId: plan.id,
        operationId: operation.id,
        output: observed.output
      });
      assert.equal(result.state, 'passed');
      assert.equal(result.reasonCode, 'VERIFICATION_PASSED');
      assert.equal(result.retryPermitted, false);
    }

    const taskTitle = 'PRIVATE_CONNECTED_TASK_TITLE_SENTINEL';
    const taskDate = '2026-07-30';
    const taskWork = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      configurationBasis: 'tracked-contained',
      input: {
        title: taskTitle,
        project: 'soter-fixture://projects/project/launch',
        assignee: 'self',
        nextActionOn: taskDate,
        context: 'Project'
      },
      createdAt: '2026-07-16T19:05:00.000Z'
    });
    const taskAction = taskWork.preview.collections[0].rows[0].actions[0];
    const taskBatch = createPreparedReviewBatch({
      root: temporaryRoot,
      workId: taskWork.id,
      actionIds: [taskAction.id],
      createdAt: '2026-07-16T19:05:30.000Z'
    });
    const taskPlan = await createPreparedConnectedPlan({
      root: temporaryRoot,
      batchId: taskBatch.id,
      createdAt: '2026-07-16T19:06:00.000Z'
    });
    assert.equal(taskPlan.state, 'blocked-review-only');
    assert.equal(taskPlan.executable, false);
    assert.equal(taskPlan.privacy.authority, 'none');
    assert.equal(taskPlan.privacy.approvalAuthorityIncluded, false);
    assert.equal(taskPlan.privacy.continuationAuthorityIncluded, false);
    assert.equal(taskPlan.privacy.executionAuthorityIncluded, false);
    assert.equal(taskPlan.privacy.retryAuthorityIncluded, false);
    assert.deepEqual(taskPlan.blockers, [
      'CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED',
      'CONNECTED_VERIFICATION_NOT_PROVEN',
      'SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE'
    ]);
    assert.equal(taskPlan.operations.length, 1);
    const taskOperation = taskPlan.operations[0];
    assert.equal(taskOperation.sourceActionId, taskAction.id);
    assert.equal(taskOperation.capability, 'tasks.records.create');
    assert.equal(taskOperation.authority, 'authority.tasks.instance');
    assert.equal(taskOperation.provider.pack, 'integration.notion');
    assert.equal(taskOperation.provider.connectedImplementation, 'provider.integration.notion.mcp');
    assert.equal(taskOperation.precondition.capability, 'tasks.records.read');
    assert.equal(taskOperation.precondition.provider.pack, 'integration.notion');
    assert.equal(taskOperation.precondition.provider.connectedImplementation,
      'provider.integration.notion.mcp');
    assert.equal(taskOperation.verification.provider.connectedImplementation,
      'provider.integration.notion.mcp');
    assert.equal(taskOperation.input.recordType, 'task');
    assert.equal(taskOperation.input.deduplicationKey, taskTitle);
    assert.deepEqual(taskOperation.input.fields, {
      title: taskTitle,
      status: 'To Do',
      context: 'Project',
      projectUris: ['soter-fixture://projects/project/launch'],
      assigneeIds: ['provider-person.maya'],
      nextActionOn: taskDate
    });
    assert.equal(taskOperation.ambiguity.retry, 'prohibited');
    assert.equal(taskOperation.recovery.mode, 'manual-required');
    assert(JSON.stringify(taskPlan).includes(taskTitle));
    assert(JSON.stringify(taskPlan).includes(taskDate));

    const taskLock = readJson(path.join(temporaryRoot, taskBatch.configuration.lockPath));
    const taskBefore = await invokeFixture({
      root: temporaryRoot,
      lock: taskLock,
      operation: taskOperation,
      verification: true,
      state: fixtureState
    });
    assert.equal(taskBefore.invocation.state, 'passed');
    await assert.rejects(
      () => evaluatePreparedConnectedVerification({
        root: temporaryRoot,
        planId: taskPlan.id,
        operationId: taskOperation.id,
        output: taskBefore.output
      }),
      (error) => error.code === 'PREPARED_CONNECTED_PLAN_VERIFICATION_RECEIPT_REQUIRED'
    );
    const taskWrite = await invokeFixture({
      root: temporaryRoot,
      lock: taskLock,
      operation: taskOperation,
      verification: false,
      state: fixtureState
    });
    assert.equal(taskWrite.invocation.state, 'passed');
    await assert.rejects(
      () => evaluatePreparedConnectedVerification({
        root: temporaryRoot,
        planId: taskPlan.id,
        operationId: taskOperation.id,
        output: taskBefore.output
      }),
      (error) => error.code === 'PREPARED_CONNECTED_PLAN_VERIFICATION_RECEIPT_REQUIRED'
    );

    const substitutedInput = resignPlan(structuredClone(plan));
    const substitutedLabel = substitutedInput.operations.find((operation) => {
      return operation.capability === 'mail.labels.apply';
    });
    substitutedLabel.input.messageIds[0] = 'message.hostile-substitution';
    substitutedLabel.inputFingerprint = fingerprintJson(substitutedLabel.input);
    resignPlan(substitutedInput);
    await assert.rejects(
      () => assertPreparedConnectedPlan(temporaryRoot, substitutedInput),
      (error) => error.code === 'PREPARED_CONNECTED_PLAN_BINDING_INVALID'
    );
    const falseProvider = structuredClone(plan);
    falseProvider.operations.find((operation) => {
      return operation.capability === 'mail.labels.apply';
    }).provider.connectedImplementation = 'provider.integration.gmail.fixture';
    resignPlan(falseProvider);
    await assert.rejects(
      () => assertPreparedConnectedPlan(temporaryRoot, falseProvider),
      (error) => error.code === 'PREPARED_CONNECTED_PLAN_BINDING_INVALID'
    );
    const falseConfigurationBasis = structuredClone(plan);
    falseConfigurationBasis.configuration.configurationBasis = 'private-active';
    resignPlan(falseConfigurationBasis);
    await assert.rejects(
      () => assertPreparedConnectedPlan(temporaryRoot, falseConfigurationBasis),
      (error) => error.code === 'PREPARED_CONNECTED_PLAN_BINDING_INVALID'
    );
    const rawProviderEscape = structuredClone(plan);
    rawProviderEscape.operations[0].rawProviderResponse = 'HOSTILE_RAW_PROVIDER_RESPONSE';
    resignPlan(rawProviderEscape);
    await assert.rejects(
      () => assertPreparedConnectedPlan(temporaryRoot, rawProviderEscape),
      (error) => error.code === 'PREPARED_CONNECTED_PLAN_MALFORMED'
    );
    const normalizedVerification = await invokeFixture({
      root: temporaryRoot,
      lock,
      operation: plan.operations[0],
      verification: true,
      state: fixtureState
    });
    await assert.rejects(
      () => evaluatePreparedConnectedVerification({
        root: temporaryRoot,
        planId: plan.id,
        operationId: plan.operations[0].id,
        output: {
          ...normalizedVerification.output,
          rawProviderResponse: 'HOSTILE_RAW_PROVIDER_RESPONSE'
        }
      }),
      (error) => error.code === 'PREPARED_CONNECTED_PLAN_VERIFICATION_INVALID'
    );

    const workspace = inspectWorkspace({ root: temporaryRoot });
    const serializedWorkspace = JSON.stringify(workspace);
    assert(!serializedWorkspace.includes(plan.id));
    assert(!serializedWorkspace.includes(labelPlan.id));
    assert(!serializedWorkspace.includes(taskPlan.id));
    assert(!serializedWorkspace.includes('Thanks for the note.'));
    assert(!serializedWorkspace.includes(focus));
    assert(!serializedWorkspace.includes(taskTitle));
    assert(!serializedWorkspace.includes(taskDate));
    assert.equal(fs.existsSync(path.join(temporaryRoot, '.soter', 'state', 'approval-requests')), false);
    assert.equal(fs.existsSync(path.join(temporaryRoot, '.soter', 'state', 'approvals')), false);
    assert.equal(fs.existsSync(path.join(temporaryRoot, '.soter', 'state', 'approval-consumptions')), false);
    assert.equal(fs.existsSync(path.join(temporaryRoot, '.soter', 'state', 'host-calls')), false);
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore,
      'Prepared connected planning changed canonical artifacts.');

    const modelPath = path.join(temporaryRoot, 'soter', 'contexts', 'email', 'processing.model.json');
    const model = readJson(modelPath);
    model.window.maximumThreads = 49;
    fs.writeFileSync(modelPath, JSON.stringify(model, null, 2) + '\n');
    const stale = await inspectPreparedConnectedPlan({
      root: temporaryRoot,
      planId: plan.id
    });
    assert.equal(stale.configuration.applicability, 'stale');
    assert.equal(stale.fingerprint, plan.fingerprint,
      'Derived applicability must not alter immutable private plan identity.');
    await assert.rejects(
      () => createPreparedConnectedPlan({ root: temporaryRoot, batchId: batch.id }),
      (error) => error.code === 'PREPARED_CONNECTED_PLAN_STALE'
    );

    await assert.rejects(
      () => inspectPreparedConnectedPlan({
        root: temporaryRoot,
        planId: 'prepared-connected-plan.missing.value'
      }),
      (error) => error.code === 'PREPARED_CONNECTED_PLAN_MISSING'
    );
    fs.writeFileSync(planFile, '{ malformed private state\n');
    await assert.rejects(
      () => inspectPreparedConnectedPlan({ root: temporaryRoot, planId: plan.id }),
      (error) => error.code === 'PREPARED_CONNECTED_PLAN_MALFORMED'
    );
    process.stdout.write(
      'PREPARED CONNECTED PLAN SELFTEST PASS: pack-owned compilation, exact private arguments, '
        + 'provider-neutral bindings, verification-only ambiguity recovery, privacy exclusion, and no authority.\n'
    );
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
