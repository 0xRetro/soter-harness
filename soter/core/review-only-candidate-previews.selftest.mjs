import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFixtureRuntimeState, invokeCapability } from './capabilities.mjs';
import { inspectWorkspace } from './inspection.mjs';
import { fingerprintJson, fingerprintPath, readJson } from './lib/canonical-json.mjs';
import {
  assertReviewOnlyCandidatePreview,
  createReviewOnlyCandidatePreview,
  evaluateReviewOnlyCandidatePreviewVerification,
  inspectReviewOnlyCandidatePreview
} from './review-only-candidate-previews.mjs';
import { createReviewOnlyCandidateSelection } from './review-only-candidate-selections.mjs';
import { prepareAutomationRun } from './prepared-work.mjs';
import { reviewOnlyCandidatePreviewStatePath } from './runtime-state.mjs';
import { completeHostToolCall, prepareHostToolCall } from './host-tools.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-07-16T19:00:00.000Z';

function resignPreview(preview) {
  const unsigned = structuredClone(preview);
  delete unsigned.fingerprint;
  delete unsigned.configuration.applicability;
  preview.fingerprint = fingerprintJson(unsigned);
  return preview;
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

export async function selftestReviewOnlyCandidatePreviews(root = defaultRoot) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-connected-preview-selftest-'));
  try {
    fs.cpSync(path.join(root, 'soter'), path.join(temporaryRoot, 'soter'), { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
    }
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const focus = 'PRIVATE_REVIEW_ONLY_CANDIDATE_PREVIEW_FOCUS_SENTINEL';
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

    const selection = createReviewOnlyCandidateSelection({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [draft.id, collapsedLabel.id],
      createdAt: '2026-07-16T19:01:00.000Z'
    });
    assert.deepEqual(selection.blockers, [
      'REVIEW_ONLY_CANDIDATE_PREVIEW_NOT_CREATED',
      'CONNECTED_VERIFICATION_NOT_PROVEN'
    ]);
    const preview = await createReviewOnlyCandidatePreview({
      root: temporaryRoot,
      selectionId: selection.id,
      createdAt: '2026-07-16T19:02:00.000Z'
    });
    assert.equal(preview.$contract, 'soter://contracts/review-only-candidate-preview/v1');
    assert.equal(preview.state, 'blocked-review-only');
    assert.equal(preview.executable, false);
    assert.equal(preview.configuration.applicability, 'current');
    assert.equal(preview.privacy.authority, 'none');
    assert.equal(preview.privacy.privateValuesIncluded, true);
    assert.equal(preview.privacy.providerArgumentsIncluded, true);
    assert.equal(preview.privacy.approvalAuthorityIncluded, false);
    assert.equal(preview.privacy.continuationAuthorityIncluded, false);
    assert.equal(preview.privacy.executionAuthorityIncluded, false);
    assert.equal(preview.privacy.retryAuthorityIncluded, false);
    assert.deepEqual(preview.blockers, [
      'CONNECTED_PROVIDER_NOT_DECLARED',
      'CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED',
      'CONNECTED_VERIFICATION_NOT_PROVEN',
      'SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE'
    ]);
    assert.equal(preview.operations.length, selection.actions.length,
      'One collapsed label action must remain one exact message-set operation.');
    assert.deepEqual([...new Set(preview.operations.map((operation) => operation.sourceActionId))],
      selection.actions.map((action) => action.id));
    assert(preview.operations.every((operation, index) => {
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
    const labelOperation = preview.operations.find((operation) => {
      return operation.capability === 'mail.labels.apply';
    });
    const draftOperation = preview.operations.find((operation) => {
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
    assert(!JSON.stringify(preview).includes('mail.send'));
    assert(JSON.stringify(preview).includes('Thanks for the note.'),
      'The selected private preview must durably bind exact draft provider arguments.');

    const candidatePreviewFile = reviewOnlyCandidatePreviewStatePath(temporaryRoot, preview.id);
    assert.equal(fs.statSync(candidatePreviewFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(candidatePreviewFile)).mode & 0o777, 0o700);
    const reentered = await createReviewOnlyCandidatePreview({
      root: temporaryRoot,
      selectionId: selection.id,
      createdAt: '2026-07-16T19:03:00.000Z'
    });
    assert.equal(reentered.id, preview.id);
    assert.equal(reentered.fingerprint, preview.fingerprint);
    assert.equal(reentered.createdAt, preview.createdAt,
      'Exact re-entry must preserve the create-only private preview.');
    const inspected = await inspectReviewOnlyCandidatePreview({
      root: temporaryRoot,
      candidatePreviewId: preview.id
    });
    assert.equal(inspected.fingerprint, preview.fingerprint);

    const lock = readJson(path.join(temporaryRoot, selection.configuration.lockPath));
    const labelSelection = createReviewOnlyCandidateSelection({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [collapsedLabel.id],
      createdAt: '2026-07-16T19:03:30.000Z'
    });
    const labelPreview = await createReviewOnlyCandidatePreview({
      root: temporaryRoot,
      selectionId: labelSelection.id,
      createdAt: '2026-07-16T19:04:00.000Z'
    });
    assert.deepEqual(labelPreview.blockers, [
      'CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED',
      'CONNECTED_VERIFICATION_NOT_PROVEN',
      'SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE'
    ]);
    const connectedLabel = labelPreview.operations[0];
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
    const connectedVerification = await evaluateReviewOnlyCandidatePreviewVerification({
      root: temporaryRoot,
      candidatePreviewId: labelPreview.id,
      operationId: connectedLabel.id,
      output: completedLabelRead.output
    });
    assert.equal(connectedVerification.state, 'passed');
    assert.equal(connectedVerification.retryPermitted, false);

    const fixtureState = createFixtureRuntimeState(temporaryRoot);
    for (const operation of preview.operations) {
      const before = await invokeFixture({
        root: temporaryRoot,
        lock,
        operation,
        verification: true,
        state: fixtureState
      });
      assert.equal(before.invocation.state, 'passed');
      const beforeResult = await evaluateReviewOnlyCandidatePreviewVerification({
        root: temporaryRoot,
        candidatePreviewId: preview.id,
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
      const result = await evaluateReviewOnlyCandidatePreviewVerification({
        root: temporaryRoot,
        candidatePreviewId: preview.id,
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
    const taskSelection = createReviewOnlyCandidateSelection({
      root: temporaryRoot,
      workId: taskWork.id,
      actionIds: [taskAction.id],
      createdAt: '2026-07-16T19:05:30.000Z'
    });
    const taskPreview = await createReviewOnlyCandidatePreview({
      root: temporaryRoot,
      selectionId: taskSelection.id,
      createdAt: '2026-07-16T19:06:00.000Z'
    });
    assert.equal(taskPreview.state, 'blocked-review-only');
    assert.equal(taskPreview.executable, false);
    assert.equal(taskPreview.privacy.authority, 'none');
    assert.equal(taskPreview.privacy.approvalAuthorityIncluded, false);
    assert.equal(taskPreview.privacy.continuationAuthorityIncluded, false);
    assert.equal(taskPreview.privacy.executionAuthorityIncluded, false);
    assert.equal(taskPreview.privacy.retryAuthorityIncluded, false);
    assert.deepEqual(taskPreview.blockers, [
      'CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED',
      'CONNECTED_VERIFICATION_NOT_PROVEN',
      'SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE'
    ]);
    assert.equal(taskPreview.operations.length, 1);
    const taskOperation = taskPreview.operations[0];
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
    assert(JSON.stringify(taskPreview).includes(taskTitle));
    assert(JSON.stringify(taskPreview).includes(taskDate));

    const taskLock = readJson(path.join(temporaryRoot, taskSelection.configuration.lockPath));
    const taskBefore = await invokeFixture({
      root: temporaryRoot,
      lock: taskLock,
      operation: taskOperation,
      verification: true,
      state: fixtureState
    });
    assert.equal(taskBefore.invocation.state, 'passed');
    await assert.rejects(
      () => evaluateReviewOnlyCandidatePreviewVerification({
        root: temporaryRoot,
        candidatePreviewId: taskPreview.id,
        operationId: taskOperation.id,
        output: taskBefore.output
      }),
      (error) => error.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_VERIFICATION_RECEIPT_REQUIRED'
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
      () => evaluateReviewOnlyCandidatePreviewVerification({
        root: temporaryRoot,
        candidatePreviewId: taskPreview.id,
        operationId: taskOperation.id,
        output: taskBefore.output
      }),
      (error) => error.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_VERIFICATION_RECEIPT_REQUIRED'
    );

    const substitutedInput = resignPreview(structuredClone(preview));
    const substitutedLabel = substitutedInput.operations.find((operation) => {
      return operation.capability === 'mail.labels.apply';
    });
    substitutedLabel.input.messageIds[0] = 'message.hostile-substitution';
    substitutedLabel.inputFingerprint = fingerprintJson(substitutedLabel.input);
    resignPreview(substitutedInput);
    await assert.rejects(
      () => assertReviewOnlyCandidatePreview(temporaryRoot, substitutedInput),
      (error) => error.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_BINDING_INVALID'
    );
    const falseProvider = structuredClone(preview);
    falseProvider.operations.find((operation) => {
      return operation.capability === 'mail.labels.apply';
    }).provider.connectedImplementation = 'provider.integration.gmail.fixture';
    resignPreview(falseProvider);
    await assert.rejects(
      () => assertReviewOnlyCandidatePreview(temporaryRoot, falseProvider),
      (error) => error.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_BINDING_INVALID'
    );
    const falseConfigurationBasis = structuredClone(preview);
    falseConfigurationBasis.configuration.configurationBasis = 'private-active';
    resignPreview(falseConfigurationBasis);
    await assert.rejects(
      () => assertReviewOnlyCandidatePreview(temporaryRoot, falseConfigurationBasis),
      (error) => error.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_BINDING_INVALID'
    );
    const rawProviderEscape = structuredClone(preview);
    rawProviderEscape.operations[0].rawProviderResponse = 'HOSTILE_RAW_PROVIDER_RESPONSE';
    resignPreview(rawProviderEscape);
    await assert.rejects(
      () => assertReviewOnlyCandidatePreview(temporaryRoot, rawProviderEscape),
      (error) => error.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_MALFORMED'
    );
    const normalizedVerification = await invokeFixture({
      root: temporaryRoot,
      lock,
      operation: preview.operations[0],
      verification: true,
      state: fixtureState
    });
    await assert.rejects(
      () => evaluateReviewOnlyCandidatePreviewVerification({
        root: temporaryRoot,
        candidatePreviewId: preview.id,
        operationId: preview.operations[0].id,
        output: {
          ...normalizedVerification.output,
          rawProviderResponse: 'HOSTILE_RAW_PROVIDER_RESPONSE'
        }
      }),
      (error) => error.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_VERIFICATION_INVALID'
    );

    const workspace = inspectWorkspace({ root: temporaryRoot });
    const serializedWorkspace = JSON.stringify(workspace);
    assert(!serializedWorkspace.includes(preview.id));
    assert(!serializedWorkspace.includes(labelPreview.id));
    assert(!serializedWorkspace.includes(taskPreview.id));
    assert(!serializedWorkspace.includes('Thanks for the note.'));
    assert(!serializedWorkspace.includes(focus));
    assert(!serializedWorkspace.includes(taskTitle));
    assert(!serializedWorkspace.includes(taskDate));
    assert.equal(fs.existsSync(path.join(temporaryRoot, '.soter', 'state', 'approval-requests')), false);
    assert.equal(fs.existsSync(path.join(temporaryRoot, '.soter', 'state', 'approvals')), false);
    assert.equal(fs.existsSync(path.join(temporaryRoot, '.soter', 'state', 'approval-consumptions')), false);
    assert.equal(fs.existsSync(path.join(temporaryRoot, '.soter', 'state', 'host-calls')), false);
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore,
      'Review-only candidate preview compilation changed canonical artifacts.');

    const modelPath = path.join(temporaryRoot, 'soter', 'contexts', 'email', 'processing.model.json');
    const model = readJson(modelPath);
    model.window.maximumThreads = 49;
    fs.writeFileSync(modelPath, JSON.stringify(model, null, 2) + '\n');
    const stale = await inspectReviewOnlyCandidatePreview({
      root: temporaryRoot,
      candidatePreviewId: preview.id
    });
    assert.equal(stale.configuration.applicability, 'stale');
    assert.equal(stale.fingerprint, preview.fingerprint,
      'Derived applicability must not alter immutable private preview identity.');
    await assert.rejects(
      () => createReviewOnlyCandidatePreview({ root: temporaryRoot, selectionId: selection.id }),
      (error) => error.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_STALE'
    );

    await assert.rejects(
      () => inspectReviewOnlyCandidatePreview({
        root: temporaryRoot,
        candidatePreviewId: 'review-only-candidate-preview.missing.value'
      }),
      (error) => error.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_MISSING'
    );
    fs.writeFileSync(candidatePreviewFile, '{ malformed private state\n');
    await assert.rejects(
      () => inspectReviewOnlyCandidatePreview({ root: temporaryRoot, candidatePreviewId: preview.id }),
      (error) => error.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_MALFORMED'
    );
    process.stdout.write(
      'REVIEW-ONLY CANDIDATE PREVIEW SELFTEST PASS: pack-owned compilation, exact private arguments, '
        + 'provider-neutral bindings, verification-only ambiguity recovery, privacy exclusion, and no authority.\n'
    );
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
