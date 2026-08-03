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
import { runStatePath } from '../../core/runtime-state.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';
import {
  completeDurableConnectedTransactionExecution,
  completeDurableOperationPlanExecution,
  prepareDurableConnectedTransactionExecution
} from '../../core/service.mjs';
import {
  finalizeProjectPageReconciliationConnectedAcquisition,
  prepareProjectPageReconciliationConnectedAcquisition
} from './context.mjs';
import {
  createProjectPageReconciliationDecision,
  commitProjectPageReconciliationDecision,
  inspectProjectPageReconciliationDecisionContext
} from './decision.mjs';
import {
  commitProjectPageReconciliationProposal,
  inspectProjectPageReconciliationProposalDecision,
  inspectProjectPageReconciliationProposalMaterial
} from './proposal.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-08-03T12:00:00.000Z';
const PROJECT_ID = 'https://www.notion.so/78787878787878787878787878787878';
const PROJECT_TITLE = 'PRIVATE_PROJECT_RECONCILIATION_TITLE_SENTINEL';
const OLD_BODY = '# Private project\n\nConfirm launch readiness.\n';
const OLD_TEXT = 'Confirm launch readiness.';
const NEW_TEXT = 'PRIVATE_PROJECT_RECONCILIATION_REPLACEMENT_SENTINEL';
const PROVIDER_OPTION_PREFIX = 'PRIVATE_PROVIDER_RECONCILIATION_OPTION_';
const TYPE_OPTIONS = ['Project', 'Operations', 'Deal'];
const STATUS_OPTIONS = ['Not Started', 'Active', 'On Hold', 'Complete', 'Cancelled'];

function providerOption(field, portable) {
  return PROVIDER_OPTION_PREFIX
    + field.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    + '_'
    + portable.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function optionMapping(field, values) {
  return {
    mapping: 'mapping.integration.notion.projects-records',
    recordType: 'project',
    field,
    mode: 'exact-bijection',
    entries: values.map((portable) => ({
      portable,
      provider: providerOption(field, portable)
    }))
  };
}

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'soter-project-reconciliation-context-')
  );
  for (const directory of ['soter', '.claude']) {
    if (!fs.existsSync(path.join(root, directory))) continue;
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), {
      recursive: true
    });
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

function property(name, type, options = null) {
  return {
    name,
    type,
    [type]: options === null ? {} : {
      options: options.map((option) => ({ name: option }))
    }
  };
}

function schemaResponse(marker, projectsCollectionUri) {
  const schema = {
    Name: property('Name', 'title'),
    Type: property('Type', 'select', TYPE_OPTIONS.map((value) => {
      return providerOption('projectType', value);
    })),
    Status: property('Status', 'status', STATUS_OPTIONS.map((value) => {
      return providerOption('status', value);
    })),
    'Start Date': property('Start Date', 'date'),
    'Target End Date': property('Target End Date', 'date'),
    Organization: property('Organization', 'relation'),
    Tasks: property('Tasks', 'relation')
  };
  return {
    structuredContent: {
      result: {
        metadata: { type: 'data_source' },
        title: marker,
        text: '<data-source url="{{' + projectsCollectionUri + '}}">\n'
          + '<data-source-state>\n' + JSON.stringify({ schema })
          + '\n</data-source-state>\n</data-source>',
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function providerFields(fields) {
  return {
    ...fields,
    projectType: providerOption('projectType', fields.projectType),
    status: providerOption('status', fields.status)
  };
}

function projectContentResponse({ fields, body, marker }) {
  const properties = {
    Name: fields.name,
    Type: providerOption('projectType', fields.projectType),
    Status: providerOption('status', fields.status),
    'Start Date': fields.startDate ?? null,
    'Target End Date': fields.targetEndDate ?? null,
    Organization: fields.organizationUris,
    Tasks: fields.taskUris ?? []
  };
  return {
    structuredContent: {
      result: {
        metadata: { type: 'page' },
        title: marker,
        url: PROJECT_ID,
        text: '<page url="' + PROJECT_ID + '"><properties>'
          + JSON.stringify(properties) + '</properties>\n' + body + '\n</page>',
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function updateResponse(marker) {
  return {
    structuredContent: {
      result: { id: PROJECT_ID, url: PROJECT_ID, rawProviderResponse: marker }
    },
    isError: false
  };
}

function createRun(root, lock, workId) {
  const suffix = workId.slice('work.project-page-reconciliation.'.length);
  const work = inspectPreparedAutomationWork({ root, workId });
  const lockPath = work.configuration.lockPath;
  const runPath = repoRelativePath(root, runStatePath(root, work.checkpoint.runId));
  const run = readJson(resolveRepoPath(root, runPath));
  const copiedLockPath = 'private/project-reconciliation.' + suffix + '.copied.lock.json';
  const unrelatedRunPath = 'private/project-reconciliation.' + suffix + '.unrelated.run.json';
  writeJson(path.join(root, copiedLockPath), lock);
  writeJson(path.join(root, unrelatedRunPath), prepareRunEnvelope({
    root,
    lock,
    lockPath: copiedLockPath,
    automationId: 'automation.project-page-reconciliation',
    runId: 'run.project-page-reconciliation.unrelated.' + suffix,
    createdAt: AT,
    requestedOutcome: 'Hostile unrelated matching-Automation run.',
    evidenceIds: []
  }));
  return { lockPath, runPath, run, copiedLockPath, unrelatedRunPath };
}

function tamperedSnapshot(snapshot, mutate) {
  const value = structuredClone(snapshot);
  mutate(value.entries.find((entry) => {
    return entry.id === 'context.project-page-reconciliation.project-content';
  }).value.records[0]);
  const entry = value.entries.find((item) => {
    return item.id === 'context.project-page-reconciliation.project-content';
  });
  entry.valueFingerprint = fingerprintJson(entry.value);
  return value;
}

export async function runContainedProjectPageReconciliationConnectedWorkflow(
  root = defaultRoot,
  { lock: preparedLock = null } = {}
) {
  const temporaryRoot = copyHarness(root);
  try {
    const { lock, privateContainedBasis, notion } = materializeContainedPrivateConfiguration({
      root: temporaryRoot,
      configurationName: 'project-page-reconciliation',
      expectedTemplateLock: preparedLock,
      notionOptionMappings: [
        optionMapping('projectType', TYPE_OPTIONS),
        optionMapping('status', STATUS_OPTIONS)
      ]
    });
    const projectsCollectionUri = lock.settings['integration.notion'].targets.projects;
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const oldFields = {
      name: PROJECT_TITLE,
      projectType: 'Operations',
      status: 'Not Started',
      startDate: null,
      targetEndDate: null,
      organizationUris: ['https://www.notion.so/22222222222222222222222222222222'],
      taskUris: ['https://www.notion.so/33333333333333333333333333333333']
    };
    const privateInput = {
      project: PROJECT_ID,
      projectType: 'Project',
      status: 'Active',
      oldTexts: [OLD_TEXT],
      newTexts: [NEW_TEXT]
    };
    const prepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-page-reconciliation',
      configurationName: 'project-page-reconciliation',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: privateInput,
      createdAt: '2026-08-03T11:59:00.000Z'
    });
    assert.equal(prepared.state, 'ready-for-acquisition');
    assert.equal(prepared.preview.proposedChanges.length, 0);
    assert.equal(prepared.approval.state, 'not-requested');
    assert.equal(prepared.continuationRequest, null);

    const primary = createRun(temporaryRoot, lock, prepared.id);
    let acquisition = await prepareProjectPageReconciliationConnectedAcquisition({
      root: temporaryRoot,
      workId: prepared.id,
      at: AT,
      expectedHost: 'codex'
    });
    assert.equal(acquisition.checkpoint.configurationLock.path, primary.lockPath);
    assert.notEqual(acquisition.checkpoint.configurationLock.path, primary.copiedLockPath);
    assert.equal(acquisition.run.id, primary.run.id);
    assert.equal(acquisition.checkpoint.steps.length, 4);
    const responses = [
      recordResponse([{
        type: 'project-capture-policy',
        id: notion.recordUris['policy.project-capture'],
        fields: { name: 'Projects' }
      }], 'RAW_PROJECT_RECONCILIATION_POLICY_SENTINEL'),
      schemaResponse('RAW_PROJECT_RECONCILIATION_SCHEMA_SENTINEL', projectsCollectionUri),
      recordResponse([{
        type: 'project',
        id: PROJECT_ID,
        fields: providerFields(oldFields)
      }], 'RAW_PROJECT_RECONCILIATION_METADATA_SENTINEL'),
      projectContentResponse({
        fields: oldFields,
        body: OLD_BODY,
        marker: 'RAW_PROJECT_RECONCILIATION_CONTENT_SENTINEL'
      })
    ];
    for (let index = 0; index < responses.length; index += 1) {
      acquisition = await completeDurableOperationPlanExecution({
        root: temporaryRoot,
        checkpointId: acquisition.checkpoint.id,
        callId: acquisition.currentCall.id,
        response: responses[index],
        at: `2026-08-03T12:00:0${index + 1}.000Z`,
        expectedHost: 'codex'
      });
    }
    const finalized = finalizeProjectPageReconciliationConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: acquisition.checkpoint.id,
      expectedHost: 'codex'
    });
    const metadataRecord = finalized.snapshot.entries[2].value.records[0];
    const contentRecord = finalized.snapshot.entries[3].value.records[0];
    assert.notEqual(
      metadataRecord.version,
      contentRecord.version,
      'Metadata provider-version and content composite-version are valid distinct representations.'
    );

    const decisionArgs = {
      root: temporaryRoot,
      lock,
      run: finalized.run,
      id: 'decision.project-page-reconciliation.probe',
      createdAt: '2026-08-03T12:00:05.000Z',
      producer: { kind: 'fixture', id: 'reconciliation-probe', host: null }
    };
    for (const [label, snapshot] of [
      ['identity drift', tamperedSnapshot(finalized.snapshot, (record) => {
        record.id = 'https://www.notion.so/ffffffffffffffffffffffffffffffff';
      })],
      ['field drift', tamperedSnapshot(finalized.snapshot, (record) => {
        record.fields.status = 'On Hold';
      })],
      ['body drift', tamperedSnapshot(finalized.snapshot, (record) => {
        record.body += '\nHOSTILE_BODY_DRIFT_SENTINEL';
      })]
    ]) {
      assert.throws(
        () => createProjectPageReconciliationDecision({ ...decisionArgs, snapshot }),
        /acquisition|disagree|requested|exact/i,
        label
      );
    }

    const inspected = inspectProjectPageReconciliationDecisionContext({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      expectedHost: 'codex'
    });
    assert.equal(inspected.outcome.state, 'ready');
    assert.deepEqual(inspected.outcome.actionIds, [
      'action.project-page-reconciliation.properties',
      'action.project-page-reconciliation.body'
    ]);
    assert.equal(inspected.authority.state, 'none');

    const committed = commitProjectPageReconciliationDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.project-page-reconciliation.connected-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-08-03T12:00:06.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committed.decision.state, 'ready');
    assert.equal(committed.run.approvals.length, 0);

    const proposalInspection = inspectProjectPageReconciliationProposalDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committed.decision.id,
      expectedHost: 'codex'
    });
    assert.equal(proposalInspection.authority.state, 'none');
    const committedProposal = commitProjectPageReconciliationProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committed.decision.id,
      id: 'proposal.project-page-reconciliation.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-08-03T12:00:07.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedProposal.proposal.authority.state, 'none');
    const material = inspectProjectPageReconciliationProposalMaterial({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      expectedHost: 'codex'
    });
    assert.equal(material.authority.state, 'none');
    assert(JSON.stringify(material).includes(PROJECT_TITLE));
    assert(JSON.stringify(material).includes(NEW_TEXT));

    const propertyOnly = await createProposalConnectedBatch({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      actionIds: ['action.project-page-reconciliation.properties'],
      changeSetId: 'changeset.project-page-reconciliation.property-selftest',
      batchId: 'batch.project-page-reconciliation.property-selftest',
      createdAt: '2026-08-03T12:00:07.500Z',
      expectedHost: 'codex'
    });
    assert.equal(propertyOnly.batch.operations.length, 1);
    assert.equal(propertyOnly.batch.operations[0].capability, 'projects.records.update');
    assert.equal(propertyOnly.authority.state, 'none');

    const compiled = await createProposalConnectedBatch({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      actionIds: inspected.outcome.actionIds,
      changeSetId: 'changeset.project-page-reconciliation.connected-selftest',
      batchId: 'batch.project-page-reconciliation.connected-selftest',
      createdAt: '2026-08-03T12:00:08.000Z',
      expectedHost: 'codex'
    });
    assert.equal(compiled.authority.state, 'none');
    assert.deepEqual(compiled.batch.operations.map((operation) => operation.capability), [
      'projects.records.update',
      'documents.content.update'
    ]);
    assert(compiled.batch.operations.every((operation) => operation.ambiguity.retry === 'prohibited'));

    const requested = await beginProposalConnectedApprovalRequest({
      root: temporaryRoot,
      configurationBasis: 'private-active',
      lockPath: primary.lockPath,
      runPath: committedProposal.runPath,
      batch: compiled.batch,
      changeSet: compiled.changeSet,
      id: 'approval-request.project-page-reconciliation.connected-selftest',
      reason: 'Review the exact private Project property and one-match body changes.',
      createdAt: '2026-08-03T12:00:09.000Z',
      expiresAt: '2026-08-03T12:10:09.000Z'
    });
    const approvalReview = inspectConnectedApprovalReviewMaterial({
      root: temporaryRoot,
      requestId: requested.request.id
    });
    assert.equal(approvalReview.completeness.state, 'complete');
    assert.equal(approvalReview.operations.length, 2);
    assert.equal(approvalReview.privacy.approvalAuthorityIncluded, false);
    assert(JSON.stringify(approvalReview).includes(NEW_TEXT));

    const confirmed = await confirmProposalConnectedApprovalRequest({
      root: temporaryRoot,
      requestId: requested.request.id,
      approvalId: 'approval.project-page-reconciliation.connected-selftest',
      actor: 'operator.selftest',
      reason: 'Reviewed exact fields, replacement text, preconditions, and verification.',
      confirmedAt: '2026-08-03T12:00:10.000Z'
    });
    const started = await prepareDurableConnectedTransactionExecution({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      at: '2026-08-03T12:00:11.000Z',
      expectedHost: 'codex'
    });
    const replayedStart = await prepareDurableConnectedTransactionExecution({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      at: '2026-08-03T12:00:11.500Z',
      expectedHost: 'codex'
    });
    assert.equal(started.approvalConsumption.state, 'started');
    assert.equal(
      replayedStart.checkpoint.checkpointFingerprint,
      started.checkpoint.checkpointFingerprint
    );

    const afterFields = {
      ...oldFields,
      projectType: 'Project',
      status: 'Active'
    };
    const updatedBody = OLD_BODY.replace(OLD_TEXT, NEW_TEXT);
    const transactionResponses = [
      projectContentResponse({
        fields: oldFields,
        body: OLD_BODY,
        marker: 'RAW_RECONCILIATION_PROPERTY_PRECONDITION_SENTINEL'
      }),
      updateResponse('RAW_RECONCILIATION_PROPERTY_WRITE_SENTINEL'),
      projectContentResponse({
        fields: afterFields,
        body: OLD_BODY,
        marker: 'RAW_RECONCILIATION_PROPERTY_VERIFY_SENTINEL'
      }),
      projectContentResponse({
        fields: afterFields,
        body: OLD_BODY,
        marker: 'RAW_RECONCILIATION_BODY_PRECONDITION_SENTINEL'
      }),
      updateResponse('RAW_RECONCILIATION_BODY_WRITE_SENTINEL'),
      projectContentResponse({
        fields: afterFields,
        body: updatedBody,
        marker: 'RAW_RECONCILIATION_BODY_VERIFY_SENTINEL'
      })
    ];
    let transaction = started;
    for (let index = 0; index < transactionResponses.length; index += 1) {
      transaction = await completeDurableConnectedTransactionExecution({
        root: temporaryRoot,
        checkpointId: transaction.checkpoint.id,
        callId: transaction.currentCall.id,
        response: transactionResponses[index],
        at: `2026-08-03T12:00:${String(index + 12).padStart(2, '0')}.000Z`,
        expectedHost: 'codex'
      });
    }
    assert.equal(transaction.checkpoint.state, 'completed');
    assert.equal(transaction.checkpoint.result.state, 'completed');
    assert.deepEqual(transaction.checkpoint.operations.map((operation) => operation.state), [
      'applied',
      'applied'
    ]);
    assert.equal(transaction.currentCall, null);

    const sanitizedParts = {
      inspection: inspectWorkspace(temporaryRoot),
      prepared,
      inspected,
      proposal: committedProposal.proposal
    };
    for (const privateValue of [
      PROJECT_ID,
      PROJECT_TITLE,
      OLD_BODY,
      NEW_TEXT,
      projectsCollectionUri,
      PROVIDER_OPTION_PREFIX,
      ...transactionResponses.map((response) => response.structuredContent.result.rawProviderResponse)
        .filter(Boolean)
    ]) {
      for (const [surface, value] of Object.entries(sanitizedParts)) {
        const serializedSurface = JSON.stringify(value);
        const privateIndex = serializedSurface.indexOf(privateValue);
        assert(
          privateIndex < 0,
          privateValue + ' entered sanitized ' + surface + ' state near '
            + serializedSurface.slice(Math.max(0, privateIndex - 120), privateIndex + 180)
        );
      }
    }
    assert.equal(
      fingerprintPath(path.join(temporaryRoot, 'soter')),
      canonicalBefore,
      'Connected Project page reconciliation cannot mutate canonical artifacts.'
    );
    return createContainedConnectedWorkflowEvidence({
      lock,
      privateContainedBasis,
      id: 'evidence.project-page-reconciliation.connected-workflow.fixture',
      createdAt: AT,
      automationId: 'automation.project-page-reconciliation',
      runId: compiled.batch.runId,
      work: prepared,
      decision: committed.decision,
      proposal: committedProposal.proposal,
      changeSet: compiled.changeSet,
      batch: compiled.batch,
      approval: confirmed.approval,
      approvalConsumption: started.approvalConsumption,
      checkpoint: transaction.checkpoint
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function selftestProjectPageReconciliationConnectedContext(root = defaultRoot) {
  const evidence = await runContainedProjectPageReconciliationConnectedWorkflow(root);
  assert.equal(evidence.result, 'passed');
  process.stdout.write('Project page reconciliation connected-context selftest passed.\n');
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestProjectPageReconciliationConnectedContext().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
