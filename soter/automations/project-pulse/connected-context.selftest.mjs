import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from '../../core/inspection.mjs';
import { createContainedConnectedWorkflowEvidence } from '../../core/evidence.mjs';
import { materializeContainedPrivateConfiguration } from '../../core/contained-private-configurations.mjs';
import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  repoRelativePath,
  resolveRepoPath,
  writeJson
} from '../../core/lib/canonical-json.mjs';
import {
  beginProposalConnectedApprovalRequest,
  confirmProposalConnectedApprovalRequest
} from '../../core/operator-authority.mjs';
import { inspectConnectedApprovalReviewMaterial } from '../../core/connected-approval-review.mjs';
import { createProposalConnectedBatch } from '../../core/proposal-connected-batches.mjs';
import {
  inspectPreparedAutomationWork,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';
import { runStatePath } from '../../core/runtime-state.mjs';
import {
  completeDurableConnectedTransactionExecution,
  completeDurableOperationPlanExecution,
  prepareDurableConnectedTransactionExecution
} from '../../core/service.mjs';
import {
  finalizeProjectPulseConnectedAcquisition,
  prepareProjectPulseConnectedAcquisition
} from './context.mjs';
import { evaluateProjectPulseConnectedVerification } from './connected.mjs';
import {
  commitProjectPulseDecision,
  inspectProjectPulseDecisionContext
} from './decision.mjs';
import {
  commitProjectPulseProposal,
  inspectProjectPulseProposalDecision,
  inspectProjectPulseProposalMaterial
} from './proposal.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-20T12:00:00.000Z';
const PROJECT_ID = 'https://www.notion.so/11111111111111111111111111111111';
const PRIVATE_PROJECT_PULSE_OPTION_PREFIX = 'PRIVATE_PROVIDER_PROJECT_PULSE_OPTION_';

function providerOption(field, portable) {
  return PRIVATE_PROJECT_PULSE_OPTION_PREFIX
    + field.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    + '_'
    + portable.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function optionMapping(mapping, recordType, field, values) {
  return {
    mapping,
    recordType,
    field,
    mode: 'exact-bijection',
    entries: values.map((portable) => ({
      portable,
      provider: providerOption(field, portable)
    }))
  };
}

function containedOptionMappings() {
  return [
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'projectType',
      ['Project']
    ),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'status',
      ['active']
    ),
    optionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'status',
      ['done', 'open']
    ),
    optionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'context',
      ['Project']
    ),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project-feed-entry',
      'category',
      ['Status']
    ),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project-feed-entry',
      'visibility',
      ['Internal']
    )
  ];
}

function providerProjectFields(fields) {
  return {
    ...fields,
    ...(fields.projectType === undefined ? {} : {
      projectType: providerOption('projectType', fields.projectType)
    }),
    ...(fields.status === undefined ? {} : {
      status: providerOption('status', fields.status)
    })
  };
}

function providerTaskFields(fields) {
  return {
    ...fields,
    ...(fields.status === undefined ? {} : {
      status: providerOption('status', fields.status)
    }),
    ...(fields.context === undefined ? {} : {
      context: providerOption('context', fields.context)
    })
  };
}

function providerFeedFields(fields) {
  return {
    ...fields,
    category: providerOption('category', fields.category),
    visibility: providerOption('visibility', fields.visibility)
  };
}

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-project-context-selftest-'));
  for (const directory of ['soter', '.claude']) {
    if (!fs.existsSync(path.join(root, directory))) continue;
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function recordResponse(records, marker) {
  return {
    structuredContent: {
      result: {
        results: records.map((record) => ({
          __soterType: record.type,
          __soterId: record.id,
          __soterFields: JSON.stringify(record.fields)
        })),
        has_more: false,
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function documentResponse({ uri, title, body }, marker) {
  return {
    structuredContent: {
      result: {
        metadata: { type: 'page' },
        title,
        url: uri,
        text: '<page url="' + uri + '"><properties>{"title":'
          + JSON.stringify(title) + '}</properties>\n' + body + '\n</page>',
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function updateResponse(uri, marker) {
  return {
    structuredContent: {
      result: {
        id: uri,
        url: uri,
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function createResponse(recordId, marker) {
  return {
    structuredContent: {
      result: {
        pages: [{ id: recordId, url: recordId }],
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function createRun(root, lock, workId) {
  const suffix = workId.slice('work.project-pulse.'.length);
  const work = inspectPreparedAutomationWork({ root, workId });
  const lockPath = work.configuration.lockPath;
  const runPath = repoRelativePath(root, runStatePath(root, work.checkpoint.runId));
  const run = readJson(resolveRepoPath(root, runPath));
  assert.equal(run.id, work.checkpoint.runId);
  assert.equal(run.configurationLock.path, lockPath);
  const copiedLockPath = 'private/project-pulse.' + suffix + '.copied.lock.json';
  const unrelatedRunPath = 'private/project-pulse.' + suffix + '.unrelated.run.json';
  writeJson(path.join(root, copiedLockPath), lock);
  const unrelatedRun = prepareRunEnvelope({
    root,
    lock,
    lockPath: copiedLockPath,
    automationId: 'automation.project-pulse',
    runId: 'run.project-pulse.unrelated.' + suffix,
    createdAt: AT,
    requestedOutcome: 'Hostile unrelated matching-Automation run that must never be selected.',
    evidenceIds: []
  });
  writeJson(path.join(root, unrelatedRunPath), unrelatedRun);
  return { lockPath, runPath, run, copiedLockPath, unrelatedRunPath, unrelatedRun };
}

function applyDocumentUpdates(body, updates) {
  let value = body;
  for (const update of updates) {
    const first = value.indexOf(update.oldText);
    const second = first < 0 ? -1 : value.indexOf(update.oldText, first + update.oldText.length);
    assert(first >= 0 && second < 0, 'selftest document update must match exactly once');
    value = value.slice(0, first) + update.newText + value.slice(first + update.oldText.length);
  }
  return value;
}

export async function runContainedProjectPulseConnectedWorkflow(
  root = defaultRoot,
  { lock: preparedLock = null } = {}
) {
  const temporaryRoot = copyHarness(root);
  try {
    const {
      lock,
      privateContainedBasis,
      notion
    } = materializeContainedPrivateConfiguration({
      root: temporaryRoot,
      configurationName: 'project-pulse',
      expectedTemplateLock: preparedLock,
      notionOptionMappings: containedOptionMappings()
    });
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const fixture = readJson(path.join(
      temporaryRoot,
      'soter/fixtures/providers/notion/workspace-records.json'
    )).data;
    const project = fixture.records.find((record) => record.id === PROJECT_ID);
    const tasks = fixture.records.filter((record) => project.fields.taskUris.includes(record.id));
    const document = fixture.documents.find((item) => item.uri === PROJECT_ID);
    assert(project && tasks.length === 2 && document);

    const privateDate = '2026-07-20';
    const privateGoal = 'CONNECTED_PRIVATE_PROJECT_GOAL_SENTINEL';
    const prepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-pulse',
      configurationName: 'project-pulse',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        project: PROJECT_ID,
        statusDate: privateDate,
        visibility: 'Internal',
        health: 'on-track',
        operatorGoal: privateGoal
      },
      createdAt: '2026-07-20T11:59:00.000Z'
    });
    assert.equal(prepared.state, 'ready-for-acquisition');
    assert.equal(prepared.preparationMode, 'connected-acquisition');
    assert.equal(prepared.approval.state, 'not-requested');
    assert.equal(prepared.continuationRequest, null);
    assert.equal(prepared.preview.proposedChanges.length, 0);

    const primary = createRun(temporaryRoot, lock, prepared.id);
    let execution = await prepareProjectPulseConnectedAcquisition({
      root: temporaryRoot,
      workId: prepared.id,
      at: AT,
      expectedHost: 'codex'
    });
    assert.equal(execution.checkpoint.configurationLock.path, primary.lockPath);
    assert.notEqual(execution.checkpoint.configurationLock.path, primary.copiedLockPath);
    assert.equal(execution.checkpoint.configuration.configurationBasis, 'private-active');
    assert.equal(execution.run.id, primary.run.id);
    assert.notEqual(execution.run.id, primary.unrelatedRun.id);
    assert.equal(execution.currentCall.capability.id, 'projects.records.read');
    assert.equal(execution.checkpoint.steps.length, 4);
    assert.equal(execution.run.approvals.length, 0);

    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([{
        type: 'project-work-policy',
        id: notion.recordUris['policy.projects'],
        fields: { name: 'Projects' }
      }], 'RAW_PROJECT_POLICY_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:01.000Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.currentCall.capability.id, 'projects.records.read');
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([{
        type: 'project',
        id: project.id,
        fields: providerProjectFields({
          ...project.fields,
          organizationUris: JSON.stringify(project.fields.organizationUris),
          taskUris: JSON.stringify(project.fields.taskUris)
        })
      }], 'RAW_PROJECT_RECORD_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:02.000Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.currentCall.capability.id, 'tasks.records.read');
    assert.deepEqual(
      execution.checkpoint.steps.find((step) => step.id === execution.checkpoint.currentStepId)
        .resolvedInput.ids,
      [...project.fields.taskUris].sort()
    );
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse(tasks.map((task) => ({
        type: 'task',
        id: task.id,
        fields: providerTaskFields({
          ...task.fields,
          projectUris: JSON.stringify(task.fields.projectUris),
          assigneeIds: JSON.stringify(task.fields.assigneeIds || [])
        })
      })), 'RAW_PROJECT_TASK_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:03.000Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.currentCall.capability.id, 'documents.content.read');
    assert.equal(
      execution.checkpoint.steps.find((step) => step.id === execution.checkpoint.currentStepId)
        .resolvedInput.uri,
      PROJECT_ID
    );
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: documentResponse(document, 'RAW_PROJECT_DOCUMENT_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:04.000Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.checkpoint.state, 'completed');

    const finalized = finalizeProjectPulseConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex'
    });
    assert.equal(finalized.snapshot.containment, 'connected');
    assert.equal(finalized.snapshot.entries.length, 4);
    assert.equal(finalized.run.lifecycleState, 'paused');
    assert.equal(finalized.run.approvals.length, 0);
    const durableAcquisition = [
      finalized.snapshotPath,
      finalized.runPath,
      execution.checkpointPath
    ].map((file) => fs.readFileSync(path.join(temporaryRoot, file), 'utf8')).join('\n');
    for (const marker of [
      'RAW_PROJECT_POLICY_RESPONSE_SENTINEL',
      'RAW_PROJECT_RECORD_RESPONSE_SENTINEL',
      'RAW_PROJECT_TASK_RESPONSE_SENTINEL',
      'RAW_PROJECT_DOCUMENT_RESPONSE_SENTINEL'
    ]) {
      assert(!durableAcquisition.includes(marker), marker + ' entered durable Project Pulse state.');
    }

    const inspectedDecision = inspectProjectPulseDecisionContext({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedDecision.outcome.state, 'ready');
    assert.equal(inspectedDecision.outcome.taskCount, 2);
    assert.equal(inspectedDecision.outcome.milestoneCount, 1);
    assert.equal(inspectedDecision.outcome.milestoneChangeCount, 1);
    assert.equal(inspectedDecision.authority.state, 'none');
    assert(!JSON.stringify(inspectedDecision).includes(project.fields.name));
    assert(!JSON.stringify(inspectedDecision).includes(privateGoal));

    const committedDecision = commitProjectPulseDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.project-pulse.connected-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:05.000Z',
      expectedHost: 'codex'
    });
    const replayedDecision = commitProjectPulseDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.project-pulse.connected-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:06.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedDecision.decision.state, 'ready');
    assert.equal(replayedDecision.decisionPath, committedDecision.decisionPath);
    assert.equal(committedDecision.run.approvals.length, 0);
    assert.equal(committedDecision.decision.payload.analysis.status.fields.date, privateDate);
    assert.equal(committedDecision.decision.payload.analysis.health.state, 'on-track');
    assert.equal(committedDecision.decision.payload.analysis.health.contradicted, false);

    const inspectedProposal = inspectProjectPulseProposalDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedProposal.authority.state, 'none');
    assert.deepEqual(inspectedProposal.inputTemplate, {});
    const committedProposal = commitProjectPulseProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.project-pulse.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:07.000Z',
      expectedHost: 'codex'
    });
    const replayedProposal = commitProjectPulseProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.project-pulse.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:08.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedProposal.proposal.authority.state, 'none');
    assert.equal(replayedProposal.proposalPath, committedProposal.proposalPath);
    assert.equal(replayedProposal.materialPath, committedProposal.materialPath);
    assert(!JSON.stringify(committedProposal).includes(document.body));
    assert(!JSON.stringify(committedProposal).includes(privateGoal));
    const proposalMaterial = inspectProjectPulseProposalMaterial({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      expectedHost: 'codex'
    });
    assert(JSON.stringify(proposalMaterial).includes(project.fields.name));
    assert.equal(proposalMaterial.authority.state, 'none');

    const actions = committedProposal.proposal.review.collections[0].rows
      .flatMap((row) => row.actions)
      .filter((action) => action.state === 'proposed');
    assert.deepEqual(
      actions.map((action) => action.id),
      ['action.project-pulse.document-update', 'action.project-pulse.status-create']
    );
    await assert.rejects(
      () => createProposalConnectedBatch({
        root: temporaryRoot,
        lockPath: primary.lockPath,
        proposalId: committedProposal.proposal.id,
        actionIds: ['action.project-pulse.status-create'],
        changeSetId: 'changeset.project-pulse.partial-selftest',
        batchId: 'batch.project-pulse.partial-selftest',
        createdAt: '2026-07-20T12:00:08.500Z',
        expectedHost: 'codex'
      }),
      (error) => {
        assert.equal(error.code, 'CONNECTED_COMPILER_INVALID');
        assert.match(error.cause?.message || '', /partial selection is not allowed/);
        return true;
      }
    );
    const compiled = await createProposalConnectedBatch({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      actionIds: [...actions.map((action) => action.id)].reverse(),
      changeSetId: 'changeset.project-pulse.connected-selftest',
      batchId: 'batch.project-pulse.connected-selftest',
      createdAt: '2026-07-20T12:00:09.000Z',
      expectedHost: 'codex'
    });
    assert.equal(compiled.authority.state, 'none');
    assert.equal(compiled.providerCallsExecuted, 0);
    assert.equal(compiled.externalWritesPerformed, 0);
    assert.deepEqual(
      compiled.batch.operations.map((operation) => operation.capability),
      ['documents.content.update', 'projects.records.create']
    );

    const requested = await beginProposalConnectedApprovalRequest({
      root: temporaryRoot,
      configurationBasis: 'private-active',
      lockPath: primary.lockPath,
      runPath: committedProposal.runPath,
      batch: compiled.batch,
      changeSet: compiled.changeSet,
      id: 'approval-request.project-pulse.connected-selftest',
      reason: 'Review and approve this exact milestone document and project status batch.',
      createdAt: '2026-07-20T12:00:10.000Z',
      expiresAt: '2026-07-20T12:10:10.000Z'
    });
    const approvalReview = inspectConnectedApprovalReviewMaterial({
      root: temporaryRoot,
      requestId: requested.request.id
    });
    assert.equal(approvalReview.completeness.state, 'complete');
    assert.equal(approvalReview.operations.length, 2);
    assert.equal(approvalReview.privacy.approvalAuthorityIncluded, false);
    const approvalReviewJson = JSON.stringify(approvalReview);
    const documentOperation = compiled.batch.operations[0];
    assert(approvalReviewJson.includes(project.fields.name));
    assert(approvalReviewJson.includes('Launch readiness'));
    assert(approvalReviewJson.includes(
      documentOperation.review.before.reviewValue.milestoneLines[0]
    ));
    assert(approvalReviewJson.includes(
      documentOperation.review.after.reviewValue.milestoneLines[0]
    ));
    const confirmed = await confirmProposalConnectedApprovalRequest({
      root: temporaryRoot,
      requestId: requested.request.id,
      approvalId: 'approval.project-pulse.connected-selftest',
      actor: 'operator.selftest',
      reason: 'The exact private milestone replacements, status values, preconditions, and verification were reviewed.',
      confirmedAt: '2026-07-20T12:00:11.000Z'
    });
    assert.equal(confirmed.approval.scope.operationBatchFingerprint, compiled.batch.batchFingerprint);

    const started = await prepareDurableConnectedTransactionExecution({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      at: '2026-07-20T12:00:12.000Z',
      expectedHost: 'codex'
    });
    const replayedStart = await prepareDurableConnectedTransactionExecution({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      at: '2026-07-20T12:00:12.500Z',
      expectedHost: 'codex'
    });
    assert.equal(started.approvalConsumption.state, 'started');
    assert.equal(
      replayedStart.checkpoint.checkpointFingerprint,
      started.checkpoint.checkpointFingerprint
    );
    assert.equal(started.currentCall.capability.id, 'documents.content.read');

    let transaction = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: started.checkpoint.id,
      callId: started.currentCall.id,
      response: documentResponse(document, 'RAW_PROJECT_PRECONDITION_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:13.000Z',
      expectedHost: 'codex'
    });
    assert.equal(transaction.currentCall.capability.id, 'documents.content.update');
    assert.equal(transaction.checkpoint.current.stage, 'write');
    transaction = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: transaction.checkpoint.id,
      callId: transaction.currentCall.id,
      response: updateResponse(PROJECT_ID, 'RAW_PROJECT_UPDATE_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:14.000Z',
      expectedHost: 'codex'
    });
    assert.equal(transaction.currentCall.capability.id, 'documents.content.read');
    assert.equal(transaction.checkpoint.current.stage, 'verify');
    const updatedBody = applyDocumentUpdates(
      document.body,
      compiled.batch.operations[0].input.updates
    );
    transaction = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: transaction.checkpoint.id,
      callId: transaction.currentCall.id,
      response: documentResponse(
        { uri: PROJECT_ID, title: project.fields.name, body: updatedBody },
        'RAW_PROJECT_DOCUMENT_VERIFY_RESPONSE_SENTINEL'
      ),
      at: '2026-07-20T12:00:15.000Z',
      expectedHost: 'codex'
    });
    assert.equal(transaction.currentCall.capability.id, 'projects.records.read');
    assert.equal(transaction.checkpoint.current.stage, 'precondition');
    transaction = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: transaction.checkpoint.id,
      callId: transaction.currentCall.id,
      response: recordResponse([], 'RAW_PROJECT_STATUS_PRECONDITION_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:16.000Z',
      expectedHost: 'codex'
    });
    assert.equal(transaction.currentCall.capability.id, 'projects.records.create');
    const createdRecordId = 'https://www.notion.so/44444444444444444444444444444444';
    transaction = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: transaction.checkpoint.id,
      callId: transaction.currentCall.id,
      response: createResponse(createdRecordId, 'RAW_PROJECT_STATUS_CREATE_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:17.000Z',
      expectedHost: 'codex'
    });
    assert.equal(transaction.currentCall.capability.id, 'projects.records.read');
    assert.equal(transaction.checkpoint.current.stage, 'verify');
    const exactStatusFields = compiled.batch.operations[1].input.fields;
    const exactVerificationInput = {
      recordTypes: ['project-feed-entry'],
      ids: [createdRecordId],
      limit: 2
    };
    assert.equal(
      transaction.currentCall.inputFingerprint,
      fingerprintJson(exactVerificationInput)
    );
    assert.equal(evaluateProjectPulseConnectedVerification({
      operation: compiled.batch.operations[1],
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'project-feed-entry',
          id: 'https://www.notion.so/55555555555555555555555555555555',
          fields: structuredClone(exactStatusFields)
        }]
      }
    }).state, 'failed');
    assert.equal(evaluateProjectPulseConnectedVerification({
      operation: compiled.batch.operations[1],
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'project-feed-entry',
          id: createdRecordId,
          fields: {
            ...structuredClone(exactStatusFields),
            sourceUri: 'https://example.test/unreviewed-project-status-source'
          }
        }]
      }
    }).reasonCode, 'READ_AFTER_WRITE_MISMATCH');
    const verified = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: transaction.checkpoint.id,
      callId: transaction.currentCall.id,
      response: recordResponse([{
        type: 'project-feed-entry',
        id: createdRecordId,
        fields: providerFeedFields({
          ...exactStatusFields,
          projectIds: JSON.stringify(exactStatusFields.projectIds)
        })
      }], 'RAW_PROJECT_STATUS_VERIFY_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:18.000Z',
      expectedHost: 'codex'
    });
    assert.equal(verified.checkpoint.state, 'completed');
    assert.equal(verified.checkpoint.result.state, 'completed');
    assert.deepEqual(verified.checkpoint.operations.map((operation) => operation.state), [
      'applied',
      'applied'
    ]);
    assert.equal(verified.currentCall, null);

    const workspaceText = JSON.stringify(inspectWorkspace(temporaryRoot));
    for (const privateValue of [
      privateGoal,
      document.body,
      updatedBody,
      'RAW_PROJECT_PRECONDITION_RESPONSE_SENTINEL',
      'RAW_PROJECT_UPDATE_RESPONSE_SENTINEL',
      'RAW_PROJECT_DOCUMENT_VERIFY_RESPONSE_SENTINEL',
      'RAW_PROJECT_STATUS_PRECONDITION_RESPONSE_SENTINEL',
      'RAW_PROJECT_STATUS_CREATE_RESPONSE_SENTINEL',
      'RAW_PROJECT_STATUS_VERIFY_RESPONSE_SENTINEL',
      PRIVATE_PROJECT_PULSE_OPTION_PREFIX
    ]) {
      assert(!workspaceText.includes(privateValue), privateValue + ' entered workspace inspection.');
    }
    assert.equal(
      fingerprintPath(path.join(temporaryRoot, 'soter')),
      canonicalBefore,
      'Connected Project Pulse workflow must not mutate canonical Soter artifacts.'
    );
    return createContainedConnectedWorkflowEvidence({
      lock,
      privateContainedBasis,
      id: 'evidence.project-pulse.connected-workflow.fixture',
      createdAt: AT,
      automationId: 'automation.project-pulse',
      runId: compiled.batch.runId,
      work: prepared,
      decision: committedDecision.decision,
      proposal: committedProposal.proposal,
      changeSet: compiled.changeSet,
      batch: compiled.batch,
      approval: confirmed.approval,
      approvalConsumption: started.approvalConsumption,
      checkpoint: verified.checkpoint
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function selftestProjectPulseConnectedContext(root = defaultRoot) {
  const evidence = await runContainedProjectPulseConnectedWorkflow(root);
  assert.equal(evidence.result, 'passed');
  process.stdout.write('Project Pulse connected-context selftest passed.\n');
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestProjectPulseConnectedContext().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
