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
  approvalConsumptionId,
  beginProposalConnectedApprovalRequest,
  confirmProposalConnectedApprovalRequest
} from '../../core/operator-authority.mjs';
import { inspectConnectedApprovalReviewMaterial } from '../../core/connected-approval-review.mjs';
import { createProposalConnectedBatch } from '../../core/proposal-connected-batches.mjs';
import { privateConfigurationStatePath } from '../../core/private-configurations.mjs';
import {
  inspectPreparedAutomationWork,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';
import {
  approvalConsumptionStatePath,
  approvalRequestStatePath,
  automationDecisionStatePath,
  connectedApprovalStatePath,
  hostCallCheckpointPath,
  runStatePath
} from '../../core/runtime-state.mjs';
import {
  completeDurableConnectedTransactionExecution,
  completeDurableOperationPlanExecution,
  getDurableHostExecution,
  listDurableHostExecutions,
  prepareDurableConnectedTransactionExecution
} from '../../core/service.mjs';
import {
  finalizeTaskCaptureConnectedAcquisition,
  prepareTaskCaptureConnectedAcquisition
} from './context.mjs';
import { evaluateTaskCaptureConnectedVerification } from './connected.mjs';
import {
  commitTaskCaptureDecision,
  inspectTaskCaptureDecisionContext
} from './decision.mjs';
import {
  commitTaskCaptureProposal,
  inspectTaskCaptureProposalDecision,
  inspectTaskCaptureProposalMaterial
} from './proposal.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-20T12:00:00.000Z';
const PRIVATE_TASK_STATUS = 'PRIVATE_PROVIDER_TASK_STATUS_SENTINEL';
const PRIVATE_TASK_CONTEXT = 'PRIVATE_PROVIDER_TASK_CONTEXT_SENTINEL';
const PRIVATE_PROJECT_TYPE = 'PRIVATE_PROVIDER_PROJECT_TYPE_SENTINEL';
const PRIVATE_PROJECT_STATUS = 'PRIVATE_PROVIDER_PROJECT_STATUS_SENTINEL';
const CONNECTED_PROJECT_URI = 'https://www.notion.so/22222222222222222222222222222222';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-task-context-selftest-'));
  for (const directory of ['soter', '.claude']) {
    if (!fs.existsSync(path.join(root, directory))) continue;
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function patchCopiedNotionCreatePreflight(root) {
  const modulePath = path.join(root, 'soter/integrations/notion/mcp.mjs');
  const source = fs.readFileSync(modulePath, 'utf8');
  const needle = 'export function prepareMcp({ capability, input, settings, mappings }) {\n';
  assert.equal(
    source.split(needle).length - 1,
    1,
    'Task preflight regression requires one exact copied Notion prepareMcp export.'
  );
  const injected = needle
    + "  if (capability === 'tasks.records.create') {\n"
    + "    const error = new Error('Planted contained Task create preflight failure.');\n"
    + "    error.kind = 'validation';\n"
    + "    throw error;\n"
    + "  }\n";
  fs.writeFileSync(modulePath, source.replace(needle, injected));
}

function containedOptionMappings({
  omitTaskStatus = false,
  taskStatusPortable = 'To Do'
} = {}) {
  return [
    ...(!omitTaskStatus ? [{
      mapping: 'mapping.integration.notion.tasks-records',
      recordType: 'task',
      field: 'status',
      mode: 'exact-bijection',
      entries: [{ portable: taskStatusPortable, provider: PRIVATE_TASK_STATUS }]
    }] : []),
    {
      mapping: 'mapping.integration.notion.tasks-records',
      recordType: 'task',
      field: 'context',
      mode: 'exact-bijection',
      entries: [{ portable: 'Project', provider: PRIVATE_TASK_CONTEXT }]
    },
    {
      mapping: 'mapping.integration.notion.projects-records',
      recordType: 'project',
      field: 'projectType',
      mode: 'exact-bijection',
      entries: [{ portable: 'Internal Project', provider: PRIVATE_PROJECT_TYPE }]
    },
    {
      mapping: 'mapping.integration.notion.projects-records',
      recordType: 'project',
      field: 'status',
      mode: 'exact-bijection',
      entries: [{ portable: 'Active', provider: PRIVATE_PROJECT_STATUS }]
    }
  ];
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

function taskSchemaResponse({
  target,
  status = PRIVATE_TASK_STATUS,
  context = PRIVATE_TASK_CONTEXT,
  marker
}) {
  return {
    structuredContent: {
      result: {
        metadata: { type: 'data_source' },
        text: '<data-source url="{{' + target + '}}">'
          + '<data-source-state>'
          + JSON.stringify({
            schema: {
              Name: { name: 'Name', type: 'title' },
              Status: {
                name: 'Status',
                type: 'status',
                groups: {
                  to_do: [{ name: status }],
                  in_progress: [],
                  complete: []
                }
              },
              Context: {
                name: 'Context',
                type: 'select',
                options: [{ name: context }]
              },
              Project: { name: 'Project', type: 'relation' },
              'Assigned To': { name: 'Assigned To', type: 'person' },
              'Next Action': { name: 'Next Action', type: 'date' },
              'Source Meetings': { name: 'Source Meetings', type: 'relation' },
              Grounding: { name: 'Grounding', type: 'text' },
              'Summary Fingerprints': {
                name: 'Summary Fingerprints',
                type: 'text'
              }
            }
          })
          + '</data-source-state></data-source>',
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function providerProjectFields(fields) {
  return {
    ...fields,
    projectType: PRIVATE_PROJECT_TYPE,
    status: PRIVATE_PROJECT_STATUS
  };
}

function providerTaskFields(fields) {
  return {
    ...fields,
    status: PRIVATE_TASK_STATUS,
    context: PRIVATE_TASK_CONTEXT
  };
}

function identityResponse(providerPersonId, marker) {
  return {
    structuredContent: {
      result: {
        metadata: { type: 'self' },
        self: { user: { id: providerPersonId } },
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
  const suffix = workId.slice('work.task-capture.'.length);
  const work = inspectPreparedAutomationWork({ root, workId });
  const lockPath = work.configuration.lockPath;
  const runPath = repoRelativePath(root, runStatePath(root, work.checkpoint.runId));
  const run = readJson(resolveRepoPath(root, runPath));
  assert.equal(run.id, work.checkpoint.runId);
  assert.equal(run.configurationLock.path, lockPath);
  const copiedLockPath = 'private/task-capture.' + suffix + '.copied.lock.json';
  const unrelatedRunPath = 'private/task-capture.' + suffix + '.unrelated.run.json';
  writeJson(path.join(root, copiedLockPath), lock);
  const unrelatedRun = prepareRunEnvelope({
    root,
    lock,
    lockPath: copiedLockPath,
    automationId: 'automation.task-capture',
    runId: 'run.task-capture.unrelated.' + suffix,
    createdAt: AT,
    requestedOutcome: 'Hostile unrelated matching-Automation run that must never be selected.',
    evidenceIds: []
  });
  writeJson(path.join(root, unrelatedRunPath), unrelatedRun);
  return { lockPath, runPath, run, copiedLockPath, unrelatedRunPath, unrelatedRun };
}

async function assertTaskChoiceMappingFailure(root, variant) {
  const temporaryRoot = copyHarness(root);
  try {
    if (variant === 'missing') {
      assert.throws(() => materializeContainedPrivateConfiguration({
        root: temporaryRoot,
        configurationName: 'task-capture',
        notionOptionMappings: containedOptionMappings({ omitTaskStatus: true })
      }), /SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT/);
      assert(!fs.existsSync(privateConfigurationStatePath(
        temporaryRoot,
        'task-capture'
      )));
      return;
    }
    const { lock, notion } = materializeContainedPrivateConfiguration({
      root: temporaryRoot,
      configurationName: 'task-capture',
      notionOptionMappings: containedOptionMappings()
    });
    const prepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        title: 'PRIVATE_TASK_MAPPING_FAILURE_SENTINEL_' + variant.toUpperCase(),
        project: CONNECTED_PROJECT_URI,
        context: 'Project'
      },
      createdAt: '2026-07-20T10:00:00.000Z'
    });
    const primary = createRun(temporaryRoot, lock, prepared.id);
    let execution = await prepareTaskCaptureConnectedAcquisition({
      root: temporaryRoot,
      workId: prepared.id,
      at: '2026-07-20T10:00:01.000Z',
      expectedHost: 'codex'
    });
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([{
        type: 'task-work-policy',
        id: notion.recordUris['policy.tasks'],
        fields: { name: 'Tasks' }
      }], 'RAW_TASK_MAPPING_POLICY_SENTINEL_' + variant.toUpperCase()),
      at: '2026-07-20T10:00:02.000Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.currentCall.capability.id, 'tasks.schema.read');
    const failed = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: taskSchemaResponse({
        target: notion.targets.tasks,
        status: variant === 'mismatched'
          ? 'PRIVATE_PROVIDER_UNMAPPED_TASK_STATUS_SENTINEL'
          : PRIVATE_TASK_STATUS,
        context: PRIVATE_TASK_CONTEXT,
        marker: 'RAW_TASK_MAPPING_SCHEMA_SENTINEL_' + variant.toUpperCase()
      }),
      at: '2026-07-20T10:00:03.000Z',
      expectedHost: 'codex'
    });
    assert.equal(failed.checkpoint.state, 'failed');
    assert.equal(failed.currentCall, null);
    const failedSchemaStep = failed.checkpoint.steps.find((step) => {
      return step.id === 'step.task-schema';
    });
    assert.equal(failedSchemaStep.state, 'failed');
    assert.equal(failedSchemaStep.output, null);
    assert.equal(failedSchemaStep.error.kind, variant === 'mismatched'
      ? 'conflict'
      : 'validation');
    const stopped = getDurableHostExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex'
    });
    const run = readJson(resolveRepoPath(temporaryRoot, primary.runPath));
    assert.equal(stopped.checkpoint.kind, 'operation-plan');
    assert.equal(stopped.checkpoint.state, 'failed');
    assert.equal(stopped.currentCall, null);
    assert.equal(run.approvals.length, 0);
    for (const stateDirectory of [
      'approval-requests',
      'approvals',
      'approval-consumptions',
      'automation-decisions',
      'automation-proposals'
    ]) {
      assert.equal(
        fs.existsSync(path.join(temporaryRoot, '.soter/state', stateDirectory)),
        false,
        variant + ' option mapping failure created ' + stateDirectory + ' authority state.'
      );
    }
    const durable = listDurableHostExecutions({
      root: temporaryRoot,
      expectedHost: 'codex'
    }).checkpoints;
    assert(!durable.some((checkpoint) => checkpoint.kind === 'connected-transaction'));
    assert(!durable.some((checkpoint) => checkpoint.capability === 'tasks.records.create'));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function assertTaskChoiceUnavailable(root) {
  const temporaryRoot = copyHarness(root);
  try {
    const { lock, notion } = materializeContainedPrivateConfiguration({
      root: temporaryRoot,
      configurationName: 'task-capture',
      notionOptionMappings: containedOptionMappings({
        taskStatusPortable: 'Backlog'
      })
    });
    const prepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        title: 'PRIVATE_TASK_STATUS_UNAVAILABLE_SENTINEL',
        project: CONNECTED_PROJECT_URI,
        context: 'Project'
      },
      createdAt: '2026-07-20T10:01:00.000Z'
    });
    const primary = createRun(temporaryRoot, lock, prepared.id);
    let execution = await prepareTaskCaptureConnectedAcquisition({
      root: temporaryRoot,
      workId: prepared.id,
      at: '2026-07-20T10:01:01.000Z',
      expectedHost: 'codex'
    });
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([{
        type: 'task-work-policy',
        id: notion.recordUris['policy.tasks'],
        fields: { name: 'Tasks' }
      }], 'RAW_TASK_STATUS_UNAVAILABLE_POLICY_SENTINEL'),
      at: '2026-07-20T10:01:02.000Z',
      expectedHost: 'codex'
    });
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: taskSchemaResponse({
        target: notion.targets.tasks,
        marker: 'RAW_TASK_STATUS_UNAVAILABLE_SCHEMA_SENTINEL'
      }),
      at: '2026-07-20T10:01:03.000Z',
      expectedHost: 'codex'
    });
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([{
        type: 'project',
        id: CONNECTED_PROJECT_URI,
        fields: providerProjectFields({
          name: 'Launch',
          projectType: 'Internal Project',
          status: 'Active',
          organizationUris: '[]',
          taskUris: '[]'
        })
      }], 'RAW_TASK_STATUS_UNAVAILABLE_PROJECT_SENTINEL'),
      at: '2026-07-20T10:01:04.000Z',
      expectedHost: 'codex'
    });
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([], 'RAW_TASK_STATUS_UNAVAILABLE_DUPLICATES_SENTINEL'),
      at: '2026-07-20T10:01:05.000Z',
      expectedHost: 'codex'
    });
    const finalized = finalizeTaskCaptureConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex'
    });
    const inspection = inspectTaskCaptureDecisionContext({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      expectedHost: 'codex',
      at: '2026-07-20T10:01:06.000Z'
    });
    assert.equal(inspection.outcome.state, 'needs-input');
    assert(JSON.stringify(inspection).includes('TASK_STATUS_VALUE_UNAVAILABLE'));
    const decision = commitTaskCaptureDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.task-capture.status-unavailable-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T10:01:06.000Z',
      expectedHost: 'codex'
    });
    assert.equal(decision.decision.state, 'needs-input');
    assert.throws(() => inspectTaskCaptureProposalDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: decision.decision.id,
      expectedHost: 'codex'
    }), /requires a ready grounded decision/);
    const run = readJson(resolveRepoPath(temporaryRoot, primary.runPath));
    assert.equal(run.approvals.length, 0);
    for (const stateDirectory of [
      'approval-requests',
      'approvals',
      'approval-consumptions',
      'automation-proposals'
    ]) {
      assert.equal(
        fs.existsSync(path.join(temporaryRoot, '.soter/state', stateDirectory)),
        false,
        'Unavailable Task status created ' + stateDirectory + ' authority state.'
      );
    }
    const durable = listDurableHostExecutions({
      root: temporaryRoot,
      expectedHost: 'codex'
    }).checkpoints;
    assert(!durable.some((checkpoint) => checkpoint.kind === 'connected-transaction'));
    assert(!durable.some((checkpoint) => checkpoint.capability === 'tasks.records.create'));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runContainedTaskCaptureConnectedWorkflow(
  root = defaultRoot,
  {
    lock: preparedLock = null,
    failCreatePreflight = false
  } = {}
) {
  const temporaryRoot = copyHarness(root);
  try {
    if (failCreatePreflight) patchCopiedNotionCreatePreflight(temporaryRoot);
    const {
      lock,
      privateContainedBasis,
      notion
    } = materializeContainedPrivateConfiguration({
      root: temporaryRoot,
      configurationName: 'task-capture',
      expectedTemplateLock: preparedLock,
      notionOptionMappings: containedOptionMappings()
    });
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const privateTitle = 'CONNECTED_PRIVATE_TASK_TITLE_SENTINEL';
    const privateDate = '2026-07-24';
    const prepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        title: privateTitle,
        project: CONNECTED_PROJECT_URI,
        assignee: 'self',
        nextActionOn: privateDate,
        context: 'Project'
      },
      createdAt: '2026-07-20T11:59:00.000Z'
    });
    assert.equal(prepared.state, 'ready-for-acquisition');
    assert.equal(prepared.preparationMode, 'connected-acquisition');
    assert.equal(prepared.preview.proposedChanges.length, 0);
    assert.equal(prepared.approval.state, 'not-requested');
    assert.equal(prepared.continuationRequest, null);

    const primary = createRun(temporaryRoot, lock, prepared.id);
    let execution = await prepareTaskCaptureConnectedAcquisition({
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
    assert.equal(execution.currentCall.capability.id, 'tasks.records.read');
    assert.equal(execution.checkpoint.steps.length, 5);
    assert.equal(execution.run.approvals.length, 0);

    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([{
        type: 'task-work-policy',
        id: notion.recordUris['policy.tasks'],
        fields: { name: 'Tasks' }
      }], 'RAW_TASK_POLICY_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:01.000Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.currentCall.capability.id, 'tasks.schema.read');
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: taskSchemaResponse({
        target: notion.targets.tasks,
        marker: 'RAW_TASK_SCHEMA_RESPONSE_SENTINEL'
      }),
      at: '2026-07-20T12:00:02.000Z',
      expectedHost: 'codex'
    });
    const schemaStep = execution.checkpoint.steps.find((step) => {
      return step.id === 'step.task-schema';
    });
    const schemaFields = new Map(
      schemaStep.output.schema.fields.map((field) => [field.id, field])
    );
    assert.deepEqual(schemaFields.get('status').options, ['To Do']);
    assert.deepEqual(schemaFields.get('context').options, ['Project']);
    assert(!JSON.stringify(execution).includes(PRIVATE_TASK_STATUS));
    assert(!JSON.stringify(execution).includes(PRIVATE_TASK_CONTEXT));
    assert.equal(execution.currentCall.capability.id, 'projects.records.read');
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([{
        type: 'project',
        id: CONNECTED_PROJECT_URI,
        fields: providerProjectFields({
          name: 'Launch',
          projectType: 'Internal Project',
          status: 'Active',
          organizationUris: '[]',
          taskUris: '[]'
        })
      }], 'RAW_TASK_PROJECT_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:03.000Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.currentCall.capability.id, 'workspace.identity.read');
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: identityResponse(
        'provider-person.connected-self',
        'RAW_TASK_IDENTITY_RESPONSE_SENTINEL'
      ),
      at: '2026-07-20T12:00:04.000Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.currentCall.capability.id, 'tasks.records.read');
    execution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: execution.currentCall.id,
      response: recordResponse([], 'RAW_TASK_DUPLICATE_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:05.000Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.checkpoint.state, 'completed');
    const finalized = finalizeTaskCaptureConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex'
    });
    assert.equal(finalized.snapshot.containment, 'connected');
    assert.equal(finalized.snapshot.entries.length, 5);
    assert.equal(finalized.run.lifecycleState, 'paused');
    assert.equal(finalized.run.approvals.length, 0);
    const durableAcquisition = [
      finalized.snapshotPath,
      finalized.runPath,
      execution.checkpointPath
    ].map((file) => fs.readFileSync(path.join(temporaryRoot, file), 'utf8')).join('\n');
    for (const marker of [
      'RAW_TASK_POLICY_RESPONSE_SENTINEL',
      'RAW_TASK_SCHEMA_RESPONSE_SENTINEL',
      'RAW_TASK_PROJECT_RESPONSE_SENTINEL',
      'RAW_TASK_IDENTITY_RESPONSE_SENTINEL',
      'RAW_TASK_DUPLICATE_RESPONSE_SENTINEL'
    ]) {
      assert(!durableAcquisition.includes(marker), marker + ' entered durable Task state.');
    }

    const inspectedDecision = inspectTaskCaptureDecisionContext({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      expectedHost: 'codex',
      at: '2026-07-20T12:00:06.000Z'
    });
    assert.equal(inspectedDecision.outcome.state, 'ready');
    assert.equal(inspectedDecision.outcome.duplicateCandidateCount, 0);
    assert.equal(inspectedDecision.authority.state, 'none');
    assert(!JSON.stringify(inspectedDecision).includes(privateTitle));
    assert(!JSON.stringify(inspectedDecision).includes(privateDate));
    assert(!JSON.stringify(inspectedDecision).includes('provider-person.connected-self'));
    const staleInspectedDecision = inspectTaskCaptureDecisionContext({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      expectedHost: 'codex',
      at: '2026-07-20T12:06:00.000Z'
    });
    assert.equal(staleInspectedDecision.outcome.state, 'needs-input');
    assert(staleInspectedDecision.outcome.issueCodes.includes('TASK_CONTEXT_STALE'));
    assert.equal(staleInspectedDecision.authority.state, 'none');
    assert.equal(
      staleInspectedDecision.outcome.projectFingerprint,
      inspectedDecision.outcome.projectFingerprint
    );
    assert.equal(
      staleInspectedDecision.outcome.taskAfterFingerprint,
      inspectedDecision.outcome.taskAfterFingerprint
    );
    assert(!JSON.stringify(staleInspectedDecision).includes(privateTitle));
    assert(!JSON.stringify(staleInspectedDecision).includes(privateDate));
    const staleDecisionId = 'decision.task-capture.stale-context-selftest';
    assert.throws(() => commitTaskCaptureDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: staleDecisionId,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:06:00.000Z',
      expectedHost: 'codex'
    }), /stale or incorrect bindings/);
    assert(!fs.existsSync(automationDecisionStatePath(
      temporaryRoot,
      staleDecisionId
    )));

    const committedDecision = commitTaskCaptureDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.task-capture.connected-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:06.000Z',
      expectedHost: 'codex'
    });
    const replayedDecision = commitTaskCaptureDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.task-capture.connected-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:07.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedDecision.decision.state, 'ready');
    assert.equal(replayedDecision.decisionPath, committedDecision.decisionPath);
    assert.equal(committedDecision.run.approvals.length, 0);
    assert.equal(committedDecision.decision.payload.task.title, privateTitle);
    assert.deepEqual(
      committedDecision.decision.payload.task.assigneeIds,
      ['provider-person.connected-self']
    );
    const durableDecisionPath = automationDecisionStatePath(
      temporaryRoot,
      committedDecision.decision.id
    );
    const durableDecisionBeforeStaleReentry = fs.readFileSync(
      durableDecisionPath,
      'utf8'
    );
    const durableStateBeforeStaleReentry = fingerprintPath(path.join(
      temporaryRoot,
      '.soter',
      'state'
    ));
    assert.throws(() => commitTaskCaptureDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: committedDecision.decision.id,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:06:00.000Z',
      expectedHost: 'codex'
    }), /re-entry requires current exact Context observations/);
    assert.equal(
      fs.readFileSync(durableDecisionPath, 'utf8'),
      durableDecisionBeforeStaleReentry,
      'Stale Task decision re-entry must not replace historical decision state.'
    );
    assert.equal(
      fingerprintPath(path.join(temporaryRoot, '.soter', 'state')),
      durableStateBeforeStaleReentry,
      'Stale Task decision re-entry must not create or mutate any private runtime state.'
    );

    const inspectedProposal = inspectTaskCaptureProposalDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedProposal.authority.state, 'none');
    assert.deepEqual(inspectedProposal.inputTemplate, {});
    const committedProposal = commitTaskCaptureProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.task-capture.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:08.000Z',
      expectedHost: 'codex'
    });
    const replayedProposal = commitTaskCaptureProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.task-capture.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:09.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedProposal.proposal.authority.state, 'none');
    assert.equal(replayedProposal.proposalPath, committedProposal.proposalPath);
    assert.equal(replayedProposal.materialPath, committedProposal.materialPath);
    assert(!JSON.stringify(committedProposal).includes(privateTitle));
    assert(!JSON.stringify(committedProposal).includes(privateDate));
    assert(!JSON.stringify(committedProposal).includes('provider-person.connected-self'));
    const material = inspectTaskCaptureProposalMaterial({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      expectedHost: 'codex'
    });
    assert(JSON.stringify(material).includes(privateTitle));
    assert(JSON.stringify(material).includes(privateDate));
    assert(JSON.stringify(material).includes('provider-person.connected-self'));
    assert.equal(material.authority.state, 'none');

    const action = committedProposal.proposal.review.collections[0].rows[0].actions[0];
    assert.equal(action.id, 'action.task-capture.create');
    assert.equal(action.state, 'proposed');
    await assert.rejects(() => createProposalConnectedBatch({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      actionIds: [action.id],
      changeSetId: 'changeset.task-capture.stale-context-selftest',
      batchId: 'batch.task-capture.stale-context-selftest',
      createdAt: '2026-07-20T12:06:00.000Z',
      expectedHost: 'codex'
    }), (error) => error.code === 'PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE');
    const compiled = await createProposalConnectedBatch({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      actionIds: [action.id],
      changeSetId: 'changeset.task-capture.connected-selftest',
      batchId: 'batch.task-capture.connected-selftest',
      createdAt: '2026-07-20T12:00:10.000Z',
      expectedHost: 'codex'
    });
    assert.equal(compiled.authority.state, 'none');
    assert.equal(compiled.providerCallsExecuted, 0);
    assert.equal(compiled.externalWritesPerformed, 0);
    assert.equal(compiled.batch.operations.length, 1);
    assert.equal(compiled.batch.operations[0].capability, 'tasks.records.create');
    assert.equal(compiled.batch.operations[0].precondition.capability, 'tasks.records.read');

    const staleRequestId = 'approval-request.task-capture.stale-context-selftest';
    await assert.rejects(() => beginProposalConnectedApprovalRequest({
      root: temporaryRoot,
      configurationBasis: 'private-active',
      lockPath: primary.lockPath,
      runPath: committedProposal.runPath,
      batch: compiled.batch,
      changeSet: compiled.changeSet,
      id: staleRequestId,
      reason: 'This request must not outlive its exact Context observations.',
      createdAt: '2026-07-20T12:06:00.000Z',
      expiresAt: '2026-07-20T12:10:00.000Z'
    }), (error) => error.code === 'PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE');
    assert(!fs.existsSync(approvalRequestStatePath(temporaryRoot, staleRequestId)));

    const requested = await beginProposalConnectedApprovalRequest({
      root: temporaryRoot,
      configurationBasis: 'private-active',
      lockPath: primary.lockPath,
      runPath: committedProposal.runPath,
      batch: compiled.batch,
      changeSet: compiled.changeSet,
      id: 'approval-request.task-capture.connected-selftest',
      reason: 'Review and approve this exact Task create and its duplicate precondition.',
      createdAt: '2026-07-20T12:00:11.000Z',
      expiresAt: '2026-07-20T12:10:11.000Z'
    });
    const approvalReview = inspectConnectedApprovalReviewMaterial({
      root: temporaryRoot,
      requestId: requested.request.id
    });
    assert.equal(approvalReview.completeness.state, 'complete');
    assert.equal(approvalReview.operations.length, 1);
    assert.equal(approvalReview.privacy.approvalAuthorityIncluded, false);
    assert(JSON.stringify(approvalReview).includes(privateTitle));
    const staleApprovalId = 'approval.task-capture.stale-context-selftest';
    await assert.rejects(() => confirmProposalConnectedApprovalRequest({
      root: temporaryRoot,
      requestId: requested.request.id,
      approvalId: staleApprovalId,
      actor: 'operator.selftest',
      reason: 'Historical review cannot confirm expired Context observations.',
      confirmedAt: '2026-07-20T12:06:00.000Z'
    }), (error) => error.code === 'PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE');
    assert(!fs.existsSync(connectedApprovalStatePath(temporaryRoot, staleApprovalId)));
    const confirmed = await confirmProposalConnectedApprovalRequest({
      root: temporaryRoot,
      requestId: requested.request.id,
      approvalId: 'approval.task-capture.connected-selftest',
      actor: 'operator.selftest',
      reason: 'The exact private task fields, duplicate precondition, and verification were reviewed.',
      confirmedAt: '2026-07-20T12:00:12.000Z'
    });
    assert.equal(
      confirmed.approval.scope.operationBatchFingerprint,
      compiled.batch.batchFingerprint
    );

    if (failCreatePreflight) {
      const consumptionPath = approvalConsumptionStatePath(
        temporaryRoot,
        approvalConsumptionId(confirmed.approval.id)
      );
      const checkpointPath = hostCallCheckpointPath(
        temporaryRoot,
        'checkpoint.transaction.task-capture.connected-selftest'
      );
      const durableBefore = listDurableHostExecutions({
        root: temporaryRoot,
        expectedHost: 'codex'
      }).checkpoints.map((checkpoint) => checkpoint.id).sort();
      assert(fs.existsSync(connectedApprovalStatePath(
        temporaryRoot,
        confirmed.approval.id
      )));
      assert(!fs.existsSync(consumptionPath));
      assert(!fs.existsSync(checkpointPath));
      await assert.rejects(() => prepareDurableConnectedTransactionExecution({
        root: temporaryRoot,
        approvalId: confirmed.approval.id,
        at: '2026-07-20T12:00:13.000Z',
        expectedHost: 'codex'
      }), (error) => error.code === 'CONNECTED_TRANSACTION_PREFLIGHT_FAILED');
      assert(!fs.existsSync(consumptionPath));
      assert(!fs.existsSync(checkpointPath));
      const durableAfter = listDurableHostExecutions({
        root: temporaryRoot,
        expectedHost: 'codex'
      }).checkpoints;
      assert.deepEqual(
        durableAfter.map((checkpoint) => checkpoint.id).sort(),
        durableBefore,
        'Failed Task create preflight must not create a durable provider call checkpoint.'
      );
      assert(!durableAfter.some((checkpoint) => {
        return checkpoint.kind === 'connected-transaction'
          || checkpoint.capability === 'tasks.records.create';
      }));
      const durableApproval = readJson(connectedApprovalStatePath(
        temporaryRoot,
        confirmed.approval.id
      ));
      assert.equal(
        durableApproval.id,
        confirmed.approval.id,
        'The exact confirmed approval remains durable review evidence, not consumed start authority.'
      );
      return { preflightFailureProved: true };
    }

    await assert.rejects(() => prepareDurableConnectedTransactionExecution({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      at: '2026-07-20T12:06:00.000Z',
      expectedHost: 'codex'
    }), (error) => error.code === 'PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE');
    assert(!fs.existsSync(approvalConsumptionStatePath(
      temporaryRoot,
      approvalConsumptionId(confirmed.approval.id)
    )));
    assert(!fs.existsSync(hostCallCheckpointPath(
      temporaryRoot,
      'checkpoint.transaction.task-capture.connected-selftest'
    )));

    const started = await prepareDurableConnectedTransactionExecution({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      at: '2026-07-20T12:00:13.000Z',
      expectedHost: 'codex'
    });
    const replayedStart = await prepareDurableConnectedTransactionExecution({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      at: '2026-07-20T12:00:13.500Z',
      expectedHost: 'codex'
    });
    assert.equal(started.approvalConsumption.state, 'started');
    assert.equal(replayedStart.checkpoint.checkpointFingerprint,
      started.checkpoint.checkpointFingerprint);
    assert.equal(started.currentCall.capability.id, 'tasks.records.read');
    const rehydratedStart = getDurableHostExecution({
      root: temporaryRoot,
      checkpointId: started.checkpoint.id,
      expectedHost: 'codex'
    });
    const pendingStarts = listDurableHostExecutions({
      root: temporaryRoot,
      state: 'requested',
      expectedHost: 'codex'
    });
    const listedStart = pendingStarts.checkpoints.find((item) => {
      return item.id === started.checkpoint.id;
    });
    assert.equal(rehydratedStart.currentCall?.id, started.currentCall.id);
    assert.equal(rehydratedStart.currentCall?.capability?.id, 'tasks.records.read');
    assert.equal(listedStart?.callId, started.currentCall.id);
    assert.equal(listedStart?.currentStage, 'precondition');
    assert.equal(listedStart?.batchId, compiled.batch.id);
    const precondition = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: started.checkpoint.id,
      callId: started.currentCall.id,
      response: recordResponse([], 'RAW_TASK_PRECONDITION_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:14.000Z',
      expectedHost: 'codex'
    });
    assert.equal(precondition.currentCall.capability.id, 'tasks.records.create');
    assert.equal(precondition.checkpoint.current.stage, 'write');
    assert(JSON.stringify(precondition.currentCall).includes(PRIVATE_TASK_STATUS));
    assert(JSON.stringify(precondition.currentCall).includes(PRIVATE_TASK_CONTEXT));
    assert(!JSON.stringify(precondition).includes('RAW_TASK_PRECONDITION_RESPONSE_SENTINEL'));

    const createdRecordId = 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const written = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: precondition.checkpoint.id,
      callId: precondition.currentCall.id,
      response: createResponse(createdRecordId, 'RAW_TASK_CREATE_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:15.000Z',
      expectedHost: 'codex'
    });
    assert(written.currentCall, JSON.stringify(written.checkpoint));
    assert.equal(written.currentCall.capability.id, 'tasks.records.read');
    assert.equal(written.checkpoint.current.stage, 'verify');
    assert(!JSON.stringify(written).includes('RAW_TASK_CREATE_RESPONSE_SENTINEL'));
    const exactTaskFields = compiled.batch.operations[0].input.fields;
    const exactVerificationInput = {
      recordTypes: ['task'],
      ids: [createdRecordId],
      limit: 2
    };
    assert.equal(
      written.currentCall.inputFingerprint,
      fingerprintJson(exactVerificationInput)
    );
    assert.equal(evaluateTaskCaptureConnectedVerification({
      operation: compiled.batch.operations[0],
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'task',
          id: 'https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          fields: structuredClone(exactTaskFields)
        }]
      }
    }).state, 'failed');
    const unsetTaskOperation = structuredClone(compiled.batch.operations[0]);
    const unsetTaskFields = structuredClone(exactTaskFields);
    delete unsetTaskFields.assigneeIds;
    delete unsetTaskFields.nextActionOn;
    unsetTaskOperation.review.after.reviewValue.fields = structuredClone(unsetTaskFields);
    unsetTaskOperation.review.after.fingerprint = fingerprintJson(
      unsetTaskOperation.review.after.reviewValue
    );
    unsetTaskOperation.verification.expectation.expectedFingerprint = fingerprintJson({
      records: [{
        type: 'task',
        fields: unsetTaskFields,
        recordIdState: 'write-output-bound'
      }]
    });
    assert.equal(evaluateTaskCaptureConnectedVerification({
      operation: unsetTaskOperation,
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'task',
          id: createdRecordId,
          fields: {
            ...structuredClone(unsetTaskFields),
            assigneeIds: [],
            nextActionOn: null
          }
        }]
      }
    }).reasonCode, 'VERIFICATION_PASSED');
    assert.equal(evaluateTaskCaptureConnectedVerification({
      operation: unsetTaskOperation,
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'task',
          id: createdRecordId,
          fields: {
            ...structuredClone(unsetTaskFields),
            assigneeIds: ['https://www.notion.so/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']
          }
        }]
      }
    }).reasonCode, 'READ_AFTER_WRITE_MISMATCH');
    const verified = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: written.checkpoint.id,
      callId: written.currentCall.id,
      response: recordResponse([{
        type: 'task',
        id: createdRecordId,
        fields: providerTaskFields({
          ...exactTaskFields,
          projectUris: JSON.stringify(exactTaskFields.projectUris),
          ...(exactTaskFields.assigneeIds
            ? { assigneeIds: JSON.stringify(exactTaskFields.assigneeIds) }
            : {})
        })
      }], 'RAW_TASK_VERIFICATION_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:16.000Z',
      expectedHost: 'codex'
    });
    assert.equal(verified.checkpoint.state, 'completed');
    assert.equal(verified.checkpoint.result.state, 'completed');
    assert.equal(verified.checkpoint.operations[0].state, 'applied');
    assert.equal(verified.currentCall, null);
    assert(!JSON.stringify(verified).includes('RAW_TASK_VERIFICATION_RESPONSE_SENTINEL'));

    const missingProject = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: { title: 'PRIVATE_MISSING_PROJECT_SENTINEL' },
      createdAt: '2026-07-20T12:00:17.000Z'
    });
    assert.equal(missingProject.state, 'needs-input');
    assert(missingProject.readiness.blockers.some((blocker) => {
      return blocker.reasonCode === 'REQUIRED_INPUT_MISSING' && blocker.fieldId === 'project';
    }));
    const arbitraryAssignee = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        title: 'PRIVATE_ARBITRARY_ASSIGNEE_SENTINEL',
        project: CONNECTED_PROJECT_URI,
        assignee: 'provider-person.untrusted'
      },
      createdAt: '2026-07-20T12:00:18.000Z'
    });
    assert.equal(arbitraryAssignee.state, 'needs-input');
    assert(arbitraryAssignee.readiness.blockers.some((blocker) => {
      return blocker.reasonCode === 'INPUT_INVALID' && blocker.fieldId === 'assignee';
    }));

    const duplicateTitle = 'CONNECTED_PRIVATE_DUPLICATE_TITLE_SENTINEL';
    const duplicatePrepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        title: duplicateTitle,
        project: CONNECTED_PROJECT_URI,
        context: 'Project'
      },
      createdAt: '2026-07-20T12:00:19.000Z'
    });
    const duplicateRun = createRun(temporaryRoot, lock, duplicatePrepared.id);
    let duplicateExecution = await prepareTaskCaptureConnectedAcquisition({
      root: temporaryRoot,
      workId: duplicatePrepared.id,
      at: '2026-07-20T12:00:20.000Z',
      expectedHost: 'codex'
    });
    assert.equal(duplicateExecution.checkpoint.steps.length, 4);
    duplicateExecution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: duplicateExecution.checkpoint.id,
      callId: duplicateExecution.currentCall.id,
      response: recordResponse([{
        type: 'task-work-policy',
        id: notion.recordUris['policy.tasks'],
        fields: { name: 'Tasks' }
      }], 'RAW_TASK_DUPLICATE_POLICY_SENTINEL'),
      at: '2026-07-20T12:00:21.000Z',
      expectedHost: 'codex'
    });
    assert.equal(duplicateExecution.currentCall.capability.id, 'tasks.schema.read');
    duplicateExecution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: duplicateExecution.checkpoint.id,
      callId: duplicateExecution.currentCall.id,
      response: taskSchemaResponse({
        target: notion.targets.tasks,
        marker: 'RAW_TASK_DUPLICATE_SCHEMA_SENTINEL'
      }),
      at: '2026-07-20T12:00:22.000Z',
      expectedHost: 'codex'
    });
    assert.equal(duplicateExecution.currentCall.capability.id, 'projects.records.read');
    duplicateExecution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: duplicateExecution.checkpoint.id,
      callId: duplicateExecution.currentCall.id,
      response: recordResponse([{
        type: 'project',
        id: CONNECTED_PROJECT_URI,
        fields: providerProjectFields({
          name: 'Launch',
          projectType: 'Internal Project',
          status: 'Active',
          organizationUris: '[]',
          taskUris: '[]'
        })
      }], 'RAW_TASK_DUPLICATE_PROJECT_SENTINEL'),
      at: '2026-07-20T12:00:23.000Z',
      expectedHost: 'codex'
    });
    duplicateExecution = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: duplicateExecution.checkpoint.id,
      callId: duplicateExecution.currentCall.id,
      response: recordResponse([{
        type: 'task',
        id: 'https://www.notion.so/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        fields: providerTaskFields({
          title: duplicateTitle,
          status: 'To Do',
          context: 'Project',
          projectUris: JSON.stringify([CONNECTED_PROJECT_URI]),
          assigneeIds: '[]',
          nextActionOn: null
        })
      }], 'RAW_TASK_DUPLICATE_CANDIDATE_SENTINEL'),
      at: '2026-07-20T12:00:24.000Z',
      expectedHost: 'codex'
    });
    const duplicateFinalized = finalizeTaskCaptureConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: duplicateExecution.checkpoint.id,
      expectedHost: 'codex'
    });
    const duplicateInspection = inspectTaskCaptureDecisionContext({
      root: temporaryRoot,
      lockPath: duplicateRun.lockPath,
      snapshotId: duplicateFinalized.snapshot.id,
      expectedHost: 'codex',
      at: '2026-07-20T12:00:25.000Z'
    });
    assert.equal(duplicateInspection.outcome.state, 'needs-input');
    assert.equal(duplicateInspection.outcome.duplicateCandidateCount, 1);
    const duplicateDecision = commitTaskCaptureDecision({
      root: temporaryRoot,
      lockPath: duplicateRun.lockPath,
      snapshotId: duplicateFinalized.snapshot.id,
      id: 'decision.task-capture.duplicate-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:25.000Z',
      expectedHost: 'codex'
    });
    assert.equal(duplicateDecision.decision.state, 'needs-input');
    assert.throws(() => inspectTaskCaptureProposalDecision({
      root: temporaryRoot,
      lockPath: duplicateRun.lockPath,
      decisionId: duplicateDecision.decision.id,
      expectedHost: 'codex'
    }), /requires a ready grounded decision/);

    const workspaceText = JSON.stringify(inspectWorkspace(temporaryRoot));
    for (const privateValue of [
      privateTitle,
      privateDate,
      'provider-person.connected-self',
      'RAW_TASK_PRECONDITION_RESPONSE_SENTINEL',
      'RAW_TASK_CREATE_RESPONSE_SENTINEL',
      'RAW_TASK_VERIFICATION_RESPONSE_SENTINEL',
      'RAW_TASK_SCHEMA_RESPONSE_SENTINEL',
      duplicateTitle,
      'RAW_TASK_DUPLICATE_POLICY_SENTINEL',
      'RAW_TASK_DUPLICATE_SCHEMA_SENTINEL',
      'RAW_TASK_DUPLICATE_PROJECT_SENTINEL',
      'RAW_TASK_DUPLICATE_CANDIDATE_SENTINEL',
      PRIVATE_TASK_STATUS,
      PRIVATE_TASK_CONTEXT,
      PRIVATE_PROJECT_TYPE,
      PRIVATE_PROJECT_STATUS
    ]) {
      assert(!workspaceText.includes(privateValue), privateValue + ' entered workspace inspection.');
    }
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore,
      'Connected Task workflow must not mutate canonical Soter artifacts.');
    return createContainedConnectedWorkflowEvidence({
      lock,
      privateContainedBasis,
      id: 'evidence.task-capture.connected-workflow.fixture',
      createdAt: AT,
      automationId: 'automation.task-capture',
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

export async function selftestTaskCaptureConnectedContext(root = defaultRoot) {
  await assertTaskChoiceMappingFailure(root, 'missing');
  await assertTaskChoiceMappingFailure(root, 'mismatched');
  await assertTaskChoiceUnavailable(root);
  const preflight = await runContainedTaskCaptureConnectedWorkflow(root, {
    failCreatePreflight: true
  });
  assert.equal(preflight.preflightFailureProved, true);
  const evidence = await runContainedTaskCaptureConnectedWorkflow(root);
  assert.equal(evidence.result, 'passed');
  process.stdout.write('Task Capture connected-context selftest passed.\n');
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestTaskCaptureConnectedContext().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
