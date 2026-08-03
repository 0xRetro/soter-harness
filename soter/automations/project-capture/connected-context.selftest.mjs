import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from '../../core/inspection.mjs';
import { createContainedConnectedWorkflowEvidence } from '../../core/evidence.mjs';
import {
  materializeContainedPrivateConfiguration
} from '../../core/contained-private-configurations.mjs';
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
  finalizeProjectCaptureConnectedAcquisition,
  prepareProjectCaptureConnectedAcquisition
} from './context.mjs';
import { evaluateProjectCaptureConnectedVerification } from './connected.mjs';
import {
  commitProjectCaptureDecision,
  inspectProjectCaptureDecisionContext
} from './decision.mjs';
import {
  commitProjectCaptureProposal,
  inspectProjectCaptureProposalDecision,
  inspectProjectCaptureProposalMaterial
} from './proposal.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-20T12:00:00.000Z';
const CONNECTED_ORGANIZATION_URI
  = 'https://www.notion.so/11111111111111111111111111111111';
const TYPE_OPTIONS = ['Project', 'Operations', 'Deal'];
const STATUS_OPTIONS = ['Not Started', 'Active', 'On Hold', 'Complete', 'Cancelled'];
const PRIVATE_PROJECT_CAPTURE_OPTION_PREFIX = 'PRIVATE_PROVIDER_PROJECT_CAPTURE_OPTION_';
const PROFILE_OPTION_VALUES = {
  profileId: ['project', 'deal'],
  allowedProjectTypes: TYPE_OPTIONS,
  bodyFormat: ['portable-project-body/v1'],
  requiredBodySections: ['Overview', 'Milestones'],
  milestoneSyntaxVersion: ['project-milestone-line/v1'],
  workItemSyntaxVersion: ['dated-owner-action-line/v1']
};

function providerOption(field, portable) {
  return PRIVATE_PROJECT_CAPTURE_OPTION_PREFIX
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
    ...Object.entries(PROFILE_OPTION_VALUES).map(([field, values]) => optionMapping(
      'mapping.integration.notion.projects-records',
      'project-creation-profile',
      field,
      values
    )),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'projectType',
      TYPE_OPTIONS
    ),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'status',
      STATUS_OPTIONS
    ),
    optionMapping(
      'mapping.integration.notion.crm-records',
      'organization',
      'organizationType',
      ['DevCo']
    ),
    optionMapping(
      'mapping.integration.notion.crm-records',
      'organization',
      'tags',
      ['DeFi', 'Priority', 'Prospect']
    )
  ];
}

function providerProfileFields(fields) {
  const result = { ...fields };
  for (const field of Object.keys(PROFILE_OPTION_VALUES)) {
    const value = result[field];
    if (value === undefined || value === null) continue;
    if (['allowedProjectTypes', 'requiredBodySections'].includes(field)) {
      const values = typeof value === 'string' ? JSON.parse(value) : value;
      result[field] = JSON.stringify(
        values.map((item) => providerOption(field, item))
      );
    } else {
      result[field] = providerOption(field, value);
    }
  }
  return result;
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
    Type: property(
      'Type',
      'select',
      TYPE_OPTIONS.map((value) => providerOption('projectType', value))
    ),
    Status: property(
      'Status',
      'status',
      STATUS_OPTIONS.map((value) => providerOption('status', value))
    ),
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
          + '<data-source-state>\n'
          + JSON.stringify({ schema })
          + '\n</data-source-state>\n</data-source>',
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

function projectContentResponse({ recordId, fields, body, marker }) {
  const properties = {
    Name: fields.name,
    Type: providerOption('projectType', fields.projectType),
    Status: providerOption('status', fields.status),
    'Start Date': fields.startDate ?? null,
    'Target End Date': fields.targetEndDate ?? null,
    Organization: fields.organizationUris,
    Tasks: fields.taskUris ?? [],
    rawProviderResponse: marker
  };
  return {
    structuredContent: {
      result: {
        metadata: { type: 'page' },
        title: marker,
        url: recordId,
        text: '<page url="' + recordId + '"><properties>'
          + JSON.stringify(properties)
          + '</properties>\n'
          + body
          + '\n</page>'
      }
    },
    isError: false
  };
}

function profileRecords(recordUris) {
  return [
    {
      type: 'project-creation-profile',
      id: recordUris['profile.project-capture.project'],
      fields: {
        name: 'Project',
        profileId: 'project',
        allowedProjectTypes: JSON.stringify(['Project', 'Operations']),
        bodyFormat: 'portable-project-body/v1',
        requiredBodySections: JSON.stringify(['Overview', 'Milestones']),
        milestoneSyntaxVersion: 'project-milestone-line/v1',
        workItemSyntaxVersion: 'dated-owner-action-line/v1'
      }
    },
    {
      type: 'project-creation-profile',
      id: recordUris['profile.project-capture.deal'],
      fields: {
        name: 'Deal',
        profileId: 'deal',
        allowedProjectTypes: JSON.stringify(['Deal']),
        bodyFormat: 'portable-project-body/v1',
        requiredBodySections: JSON.stringify(['Overview', 'Milestones']),
        milestoneSyntaxVersion: 'project-milestone-line/v1',
        workItemSyntaxVersion: 'dated-owner-action-line/v1'
      }
    }
  ].map((record) => ({
    ...record,
    fields: providerProfileFields(record.fields)
  }));
}

function createRun(root, lock, workId) {
  const suffix = workId.slice('work.project-capture.'.length);
  const work = inspectPreparedAutomationWork({ root, workId });
  const lockPath = work.configuration.lockPath;
  const runPath = repoRelativePath(root, runStatePath(root, work.checkpoint.runId));
  const run = readJson(resolveRepoPath(root, runPath));
  assert.equal(run.id, work.checkpoint.runId);
  assert.equal(run.configurationLock.path, lockPath);
  const copiedLockPath = 'private/project-capture.' + suffix + '.copied.lock.json';
  const unrelatedRunPath = 'private/project-capture.' + suffix + '.unrelated.run.json';
  writeJson(path.join(root, copiedLockPath), lock);
  const unrelatedRun = prepareRunEnvelope({
    root,
    lock,
    lockPath: copiedLockPath,
    automationId: 'automation.project-capture',
    runId: 'run.project-capture.unrelated.' + suffix,
    createdAt: AT,
    requestedOutcome: 'Hostile unrelated matching-Automation run that must never be selected.',
    evidenceIds: []
  });
  writeJson(path.join(root, unrelatedRunPath), unrelatedRun);
  return { lockPath, runPath, run, copiedLockPath, unrelatedRunPath, unrelatedRun };
}

export async function runContainedProjectCaptureConnectedWorkflow(
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
      configurationName: 'project-capture',
      expectedTemplateLock: preparedLock,
      notionOptionMappings: containedOptionMappings()
    });
    const projectsCollectionUri = lock.settings['integration.notion'].targets.projects;
    assert.match(
      projectsCollectionUri,
      /^collection:\/\/[a-f0-9-]{32,36}$/,
      'Contained Project schema and plan require one exact private collection URI.'
    );
    const fixtureDirectory = path.join(temporaryRoot, 'soter', 'fixtures', 'project-capture');
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    writeJson(path.join(fixtureDirectory, 'project-capture.lock.json'), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const privateInput = {
      name: 'CONNECTED_PRIVATE_SHORT_NAME_SENTINEL: CONNECTED_PRIVATE_PROJECT_NAME_SENTINEL',
      organizationShortName: 'CONNECTED_PRIVATE_SHORT_NAME_SENTINEL',
      organization: CONNECTED_ORGANIZATION_URI,
      creationProfile: 'project',
      projectType: 'Project',
      overview: 'CONNECTED_PRIVATE_PROJECT_OVERVIEW_SENTINEL grounded without invented completion.',
      milestoneTitles: [
        'CONNECTED_PRIVATE_PROJECT_SCOPE_SENTINEL',
        'CONNECTED_PRIVATE_PROJECT_REVIEW_SENTINEL'
      ],
      milestoneDescriptions: [
        'CONNECTED_PRIVATE_PROJECT_SCOPE_DESCRIPTION_SENTINEL is explicit',
        'CONNECTED_PRIVATE_PROJECT_REVIEW_DESCRIPTION_SENTINEL is evidenced'
      ],
      milestoneOwners: [
        'CONNECTED_PRIVATE_PROJECT_SCOPE_OWNER_SENTINEL',
        'CONNECTED_PRIVATE_PROJECT_REVIEW_OWNER_SENTINEL'
      ],
      milestoneActions: [
        'CONNECTED_PRIVATE_PROJECT_SCOPE_ACTION_SENTINEL confirms scope',
        'CONNECTED_PRIVATE_PROJECT_REVIEW_ACTION_SENTINEL reviews evidence'
      ],
      milestoneDates: ['2026-07-28', '2026-08-14'],
      startDate: '2026-07-24',
      targetEndDate: '2026-08-15'
    };
    const prepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-capture',
      configurationName: 'project-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: privateInput,
      createdAt: '2026-07-20T11:59:00.000Z'
    });
    assert.equal(prepared.state, 'ready-for-acquisition', JSON.stringify(prepared.readiness));
    assert.equal(prepared.preparationMode, 'connected-acquisition');
    assert.equal(prepared.preview.proposedChanges.length, 0);
    assert.equal(prepared.preview.collections.length, 0);
    assert.equal(prepared.approval.state, 'not-requested');
    assert.equal(prepared.continuationRequest, null);

    const primary = createRun(temporaryRoot, lock, prepared.id);
    let execution = await prepareProjectCaptureConnectedAcquisition({
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
    assert.equal(execution.checkpoint.steps.length, 5);
    assert.equal(execution.run.approvals.length, 0);
    const responses = [
      recordResponse([{
        type: 'project-capture-policy',
        id: notion.recordUris['policy.project-capture'],
        fields: { name: 'Projects' }
      }], 'RAW_PROJECT_POLICY_RESPONSE_SENTINEL'),
      recordResponse(
        profileRecords(notion.recordUris),
        'RAW_PROJECT_PROFILE_RESPONSE_SENTINEL'
      ),
      schemaResponse('RAW_PROJECT_SCHEMA_RESPONSE_SENTINEL', projectsCollectionUri),
      recordResponse([{
        type: 'organization',
        id: privateInput.organization,
        fields: {
          name: 'Acme Design',
          organizationType: providerOption('organizationType', 'DevCo'),
          tags: '[]',
          website: null,
          twitter: null,
          projectUris: '[]',
          contactUris: '[]'
        }
      }], 'RAW_PROJECT_ORGANIZATION_RESPONSE_SENTINEL'),
      recordResponse([], 'RAW_PROJECT_DUPLICATE_RESPONSE_SENTINEL')
    ];
    for (let index = 0; index < responses.length; index += 1) {
      execution = await completeDurableOperationPlanExecution({
        root: temporaryRoot,
        checkpointId: execution.checkpoint.id,
        callId: execution.currentCall.id,
        response: responses[index],
        at: `2026-07-20T12:00:0${index + 1}.000Z`,
        expectedHost: 'codex'
      });
    }
    assert.equal(execution.checkpoint.state, 'completed');
    const finalized = finalizeProjectCaptureConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex'
    });
    assert.equal(finalized.snapshot.containment, 'connected');
    assert.equal(finalized.snapshot.entries.length, 5);
    assert.equal(finalized.run.lifecycleState, 'paused');
    assert.equal(finalized.run.approvals.length, 0);

    const inspected = inspectProjectCaptureDecisionContext({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      expectedHost: 'codex'
    });
    assert.equal(inspected.outcome.state, 'ready');
    assert.deepEqual(inspected.outcome.issueCodes, []);
    assert.equal(inspected.authority.state, 'none');

    const committed = commitProjectCaptureDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.project-capture.connected-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:07.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committed.decision.state, 'ready');
    assert.equal(committed.run.approvals.length, 0);

    const inspectedProposal = inspectProjectCaptureProposalDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committed.decision.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedProposal.authority.state, 'none');
    const committedProposal = commitProjectCaptureProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committed.decision.id,
      id: 'proposal.project-capture.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-20T12:00:08.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedProposal.proposal.authority.state, 'none');
    const material = inspectProjectCaptureProposalMaterial({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      expectedHost: 'codex'
    });
    assert.equal(material.authority.state, 'none');
    assert(JSON.stringify(material).includes(privateInput.name));
    assert(JSON.stringify(material).includes(privateInput.targetEndDate));

    const action = committedProposal.proposal.review.collections[0].rows[0].actions[0];
    assert.equal(action.id, 'action.project-capture.create');
    assert.equal(action.state, 'proposed');
    assert.equal(action.reasonCode, 'PROJECT_CREATE_READY_FOR_REVIEW');
    assert.equal(action.capability, 'projects.records.create');
    assert.equal(action.effect, 'write');
    assert.match(action.changeFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(committedProposal.proposal.review.proposedChanges.length, 1);

    const compiled = await createProposalConnectedBatch({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      actionIds: [action.id],
      changeSetId: 'changeset.project-capture.connected-selftest',
      batchId: 'batch.project-capture.connected-selftest',
      createdAt: '2026-07-20T12:00:09.000Z',
      expectedHost: 'codex'
    });
    assert.equal(compiled.authority.state, 'none');
    assert.equal(compiled.providerCallsExecuted, 0);
    assert.equal(compiled.externalWritesPerformed, 0);
    assert.equal(compiled.batch.operations.length, 1);
    assert.equal(compiled.batch.operations[0].capability, 'projects.records.create');
    assert.equal(compiled.batch.operations[0].precondition.capability, 'projects.records.read');
    assert.equal(compiled.batch.operations[0].verification.capability, 'projects.records.read');
    assert.equal(compiled.batch.operations[0].verification.input.limit, 1);
    assert.equal(
      compiled.batch.operations[0].verification.input.content.expectedTitle,
      privateInput.name
    );
    assert.equal(compiled.batch.operations[0].ambiguity.retry, 'prohibited');
    assert.equal(compiled.batch.operations[0].recovery.mode, 'manual-required');

    const requested = await beginProposalConnectedApprovalRequest({
      root: temporaryRoot,
      configurationBasis: 'private-active',
      lockPath: primary.lockPath,
      runPath: committedProposal.runPath,
      batch: compiled.batch,
      changeSet: compiled.changeSet,
      id: 'approval-request.project-capture.connected-selftest',
      reason: 'Review and approve this exact Project create, body, and absence precondition.',
      createdAt: '2026-07-20T12:00:10.000Z',
      expiresAt: '2026-07-20T12:10:10.000Z'
    });
    const approvalReview = inspectConnectedApprovalReviewMaterial({
      root: temporaryRoot,
      requestId: requested.request.id
    });
    assert.equal(approvalReview.completeness.state, 'complete');
    assert.equal(approvalReview.operations.length, 1);
    assert.equal(approvalReview.privacy.approvalAuthorityIncluded, false);
    assert(JSON.stringify(approvalReview).includes(privateInput.name));
    assert(JSON.stringify(approvalReview).includes(privateInput.overview));

    const confirmed = await confirmProposalConnectedApprovalRequest({
      root: temporaryRoot,
      requestId: requested.request.id,
      approvalId: 'approval.project-capture.connected-selftest',
      actor: 'operator.selftest',
      reason: 'The exact private Project fields, complete body, absence check, and verification were reviewed.',
      confirmedAt: '2026-07-20T12:00:11.000Z'
    });
    assert.equal(
      confirmed.approval.scope.operationBatchFingerprint,
      compiled.batch.batchFingerprint
    );

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
      started.checkpoint.checkpointFingerprint,
      'The consumed start authorization must resolve only to its existing exact checkpoint.'
    );
    assert.equal(started.currentCall.capability.id, 'projects.records.read');

    const precondition = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: started.checkpoint.id,
      callId: started.currentCall.id,
      response: recordResponse([], 'RAW_PROJECT_PRECONDITION_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:13.000Z',
      expectedHost: 'codex'
    });
    assert.equal(precondition.currentCall.capability.id, 'projects.records.create');
    assert.equal(precondition.checkpoint.current.stage, 'write');
    assert(!JSON.stringify(precondition).includes('RAW_PROJECT_PRECONDITION_RESPONSE_SENTINEL'));

    const createdRecordId = 'https://www.notion.so/33333333333333333333333333333333';
    const written = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: precondition.checkpoint.id,
      callId: precondition.currentCall.id,
      response: createResponse(createdRecordId, 'RAW_PROJECT_CREATE_RESPONSE_SENTINEL'),
      at: '2026-07-20T12:00:14.000Z',
      expectedHost: 'codex'
    });
    assert.equal(written.currentCall.capability.id, 'projects.records.read');
    assert.equal(written.checkpoint.current.stage, 'verify');
    assert(!JSON.stringify(written).includes('RAW_PROJECT_CREATE_RESPONSE_SENTINEL'));

    const operation = compiled.batch.operations[0];
    const exactProjectFields = operation.review.after.reviewValue.fields;
    const exactVerificationInput = {
      recordTypes: ['project'],
      ids: [createdRecordId],
      content: { expectedTitle: privateInput.name },
      limit: 1
    };
    assert.equal(written.currentCall.inputFingerprint, fingerprintJson(exactVerificationInput));
    assert.equal(evaluateProjectCaptureConnectedVerification({
      operation,
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'project',
          id: createdRecordId,
          fields: structuredClone(exactProjectFields),
          body: operation.input.body + '\nHOSTILE_UNAPPROVED_BODY_MUTATION'
        }]
      }
    }).state, 'failed');
    assert.equal(evaluateProjectCaptureConnectedVerification({
      operation,
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'project',
          id: createdRecordId,
          fields: {
            ...structuredClone(exactProjectFields),
            taskUris: ['https://www.notion.so/44444444444444444444444444444444']
          },
          body: operation.input.body
        }]
      }
    }).state, 'failed', 'Unapproved mapped relations must fail exact Project read-back.');
    assert.equal(operation.ambiguity.retry, 'prohibited');

    const verified = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: written.checkpoint.id,
      callId: written.currentCall.id,
      response: projectContentResponse({
        recordId: createdRecordId,
        fields: exactProjectFields,
        body: operation.input.body,
        marker: 'RAW_PROJECT_VERIFICATION_RESPONSE_SENTINEL'
      }),
      at: '2026-07-20T12:00:15.000Z',
      expectedHost: 'codex'
    });
    assert.equal(verified.checkpoint.state, 'completed', JSON.stringify({
      state: verified.checkpoint.state,
      result: verified.checkpoint.result,
      operations: verified.checkpoint.operations,
      blockers: verified.checkpoint.blockers,
      verification: verified.checkpoint.verification,
      reconciliation: verified.checkpoint.reconciliation
    }, null, 2));
    assert.equal(verified.checkpoint.result.state, 'completed');
    assert.equal(verified.checkpoint.operations[0].state, 'applied');
    assert.equal(verified.currentCall, null);
    assert(!JSON.stringify(verified).includes('RAW_PROJECT_VERIFICATION_RESPONSE_SENTINEL'));

    const serialized = JSON.stringify({
      inspection: inspectWorkspace(temporaryRoot),
      prepared,
      inspected,
      committedProposal
    });
    for (const privateValue of [
      privateInput.name,
      privateInput.organizationShortName,
      privateInput.overview,
      ...privateInput.milestoneTitles,
      ...privateInput.milestoneDescriptions,
      ...privateInput.milestoneOwners,
      ...privateInput.milestoneActions,
      ...privateInput.milestoneDates,
      privateInput.startDate,
      privateInput.targetEndDate,
      projectsCollectionUri,
      'RAW_PROJECT_POLICY_RESPONSE_SENTINEL',
      'RAW_PROJECT_PROFILE_RESPONSE_SENTINEL',
      'RAW_PROJECT_SCHEMA_RESPONSE_SENTINEL',
      'RAW_PROJECT_ORGANIZATION_RESPONSE_SENTINEL',
      'RAW_PROJECT_DUPLICATE_RESPONSE_SENTINEL',
      'RAW_PROJECT_PRECONDITION_RESPONSE_SENTINEL',
      'RAW_PROJECT_CREATE_RESPONSE_SENTINEL',
      'RAW_PROJECT_VERIFICATION_RESPONSE_SENTINEL',
      PRIVATE_PROJECT_CAPTURE_OPTION_PREFIX
    ]) {
      assert(!serialized.includes(privateValue), privateValue + ' entered sanitized Project state.');
    }
    assert.equal(
      fingerprintPath(path.join(temporaryRoot, 'soter')),
      canonicalBefore,
      'Connected Project workflow must not mutate canonical Soter artifacts.'
    );
    return createContainedConnectedWorkflowEvidence({
      lock,
      privateContainedBasis,
      id: 'evidence.project-capture.connected-workflow.fixture',
      createdAt: AT,
      automationId: 'automation.project-capture',
      runId: compiled.batch.runId,
      work: prepared,
      decision: committed.decision,
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

export async function selftestProjectCaptureConnectedContext(root = defaultRoot) {
  const evidence = await runContainedProjectCaptureConnectedWorkflow(root);
  assert.equal(evidence.result, 'passed');
  process.stdout.write('Project Capture connected-context selftest passed.\n');
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestProjectCaptureConnectedContext().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
