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
  finalizeOrganizationCaptureConnectedAcquisition,
  prepareOrganizationCaptureConnectedAcquisition
} from './context.mjs';
import { evaluateOrganizationCaptureConnectedVerification } from './connected.mjs';
import {
  commitOrganizationCaptureDecision,
  inspectOrganizationCaptureDecisionContext
} from './decision.mjs';
import {
  commitOrganizationCaptureProposal,
  inspectOrganizationCaptureProposalDecision,
  inspectOrganizationCaptureProposalMaterial
} from './proposal.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T14:00:00.000Z';
const CREATED_ORGANIZATION_FIXTURE_URI
  = 'https://www.notion.so/00000000000040008000000000000112';
const DUPLICATE_ORGANIZATION_FIXTURE_URI
  = 'https://www.notion.so/00000000000040008000000000000212';
const TYPE_OPTIONS = [
  'Core Devs',
  'DevCo',
  'Ecosystem Actor',
  'Ecosystem DAO',
  'Executor Agent',
  'Facilitator Team',
  'Foundation',
  'GovOps',
  'Halo Agent',
  'Prime Agent'
];
const TAG_OPTIONS = [
  'CRM-ONLY',
  'DeFi',
  'Grants',
  'L2',
  'Priority',
  'Prospect',
  'Terminated',
  'Vendor'
];
const PRIVATE_ORGANIZATION_TYPE_PREFIX = 'PRIVATE_PROVIDER_ORGANIZATION_TYPE_';
const PRIVATE_ORGANIZATION_TAG_PREFIX = 'PRIVATE_PROVIDER_ORGANIZATION_TAG_';

function providerOption(prefix, portable) {
  return prefix + portable.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function containedOptionMappings() {
  return [
    {
      mapping: 'mapping.integration.notion.crm-records',
      recordType: 'organization',
      field: 'organizationType',
      mode: 'exact-bijection',
      entries: TYPE_OPTIONS.map((portable) => ({
        portable,
        provider: providerOption(PRIVATE_ORGANIZATION_TYPE_PREFIX, portable)
      }))
    },
    {
      mapping: 'mapping.integration.notion.crm-records',
      recordType: 'organization',
      field: 'tags',
      mode: 'exact-bijection',
      entries: TAG_OPTIONS.map((portable) => ({
        portable,
        provider: providerOption(PRIVATE_ORGANIZATION_TAG_PREFIX, portable)
      }))
    }
  ];
}

function providerOrganizationFields(fields) {
  const tags = typeof fields.tags === 'string'
    ? JSON.parse(fields.tags)
    : fields.tags;
  return {
    ...fields,
    ...(fields.organizationType === undefined ? {} : {
      organizationType: providerOption(
        PRIVATE_ORGANIZATION_TYPE_PREFIX,
        fields.organizationType
      )
    }),
    ...(tags === undefined ? {} : {
      tags: JSON.stringify(tags.map((value) => providerOption(
        PRIVATE_ORGANIZATION_TAG_PREFIX,
        value
      )))
    })
  };
}

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-org-context-selftest-'));
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

function schemaResponse(marker, targetUri) {
  const schema = {
    Name: property('Name', 'title'),
    Type: property('Type', 'select', TYPE_OPTIONS.map((value) => providerOption(
      PRIVATE_ORGANIZATION_TYPE_PREFIX,
      value
    ))),
    Tags: property('Tags', 'multi_select', TAG_OPTIONS.map((value) => providerOption(
      PRIVATE_ORGANIZATION_TAG_PREFIX,
      value
    ))),
    Website: property('Website', 'url'),
    Twitter: property('Twitter', 'url'),
    Projects: property('Projects', 'relation'),
    '🫂 Contacts': property('🫂 Contacts', 'relation')
  };
  return {
    structuredContent: {
      result: {
        metadata: { type: 'data_source' },
        title: marker,
        text: '<data-source url="{{' + targetUri + '}}">\n'
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

function createRun(root, lock, workId) {
  const suffix = workId.slice('work.organization-capture.'.length);
  const work = inspectPreparedAutomationWork({ root, workId });
  const lockPath = work.configuration.lockPath;
  const runPath = repoRelativePath(root, runStatePath(root, work.checkpoint.runId));
  const run = readJson(resolveRepoPath(root, runPath));
  assert.equal(run.id, work.checkpoint.runId);
  assert.equal(run.configurationLock.path, lockPath);
  const copiedLockPath = 'private/organization-capture.' + suffix + '.copied.lock.json';
  const unrelatedRunPath = 'private/organization-capture.' + suffix + '.unrelated.run.json';
  writeJson(path.join(root, copiedLockPath), lock);
  const unrelatedRun = prepareRunEnvelope({
    root,
    lock,
    lockPath: copiedLockPath,
    automationId: 'automation.organization-capture',
    runId: 'run.organization-capture.unrelated.' + suffix,
    createdAt: AT,
    requestedOutcome: 'Hostile unrelated matching-Automation run that must never be selected.',
    evidenceIds: []
  });
  writeJson(path.join(root, unrelatedRunPath), unrelatedRun);
  return { lockPath, runPath, run, copiedLockPath, unrelatedRunPath, unrelatedRun };
}

async function completeAcquisition({
  root,
  execution,
  duplicateRecords = [],
  prefix,
  atSecond,
  targetUri,
  policyId
}) {
  let current = await completeDurableOperationPlanExecution({
    root,
    checkpointId: execution.checkpoint.id,
    callId: execution.currentCall.id,
    response: recordResponse([{
      type: 'organization-capture-policy',
      id: policyId,
      fields: { name: 'Organizations' }
    }], 'RAW_' + prefix + '_POLICY_SENTINEL'),
    at: '2026-07-21T14:00:' + String(atSecond).padStart(2, '0') + '.000Z',
    expectedHost: 'codex'
  });
  assert.equal(current.currentCall.capability.id, 'crm.schema.read');
  current = await completeDurableOperationPlanExecution({
    root,
    checkpointId: current.checkpoint.id,
    callId: current.currentCall.id,
    response: schemaResponse('RAW_' + prefix + '_SCHEMA_SENTINEL', targetUri),
    at: '2026-07-21T14:00:' + String(atSecond + 1).padStart(2, '0') + '.000Z',
    expectedHost: 'codex'
  });
  assert.equal(current.currentCall.capability.id, 'crm.records.read');
  current = await completeDurableOperationPlanExecution({
    root,
    checkpointId: current.checkpoint.id,
    callId: current.currentCall.id,
    response: recordResponse(
      duplicateRecords,
      'RAW_' + prefix + '_DUPLICATE_SENTINEL'
    ),
    at: '2026-07-21T14:00:' + String(atSecond + 2).padStart(2, '0') + '.000Z',
    expectedHost: 'codex'
  });
  assert.equal(current.checkpoint.state, 'completed');
  return current;
}

export async function runContainedOrganizationCaptureConnectedWorkflow(
  root = defaultRoot,
  { lock: preparedLock = null } = {}
) {
  const temporaryRoot = copyHarness(root);
  try {
    const {
      lock,
      notion,
      privateContainedBasis
    } = materializeContainedPrivateConfiguration({
      root: temporaryRoot,
      configurationName: 'organization-capture',
      expectedTemplateLock: preparedLock,
      notionOptionMappings: containedOptionMappings()
    });
    const organizationTarget = notion.targets.organizations;
    assert.equal(lock.settings['integration.notion'].targets.organizations, organizationTarget);
    const fixtureDirectory = path.join(
      temporaryRoot,
      'soter',
      'fixtures',
      'organization-capture'
    );
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    writeJson(path.join(fixtureDirectory, 'organization-capture.lock.json'), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const privateName = 'CONNECTED_PRIVATE_ORGANIZATION_SENTINEL';
    const privateDescription = 'CONNECTED_PRIVATE_DESCRIPTION_SENTINEL DeFi foundation.';
    const privateWebsite = 'connected-private.example';
    const privateTwitter = '@connectprivate';
    const privateAlias = 'CONNECTED_PRIVATE_ALIAS_SENTINEL';
    const prepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.organization-capture',
      configurationName: 'organization-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        name: privateName,
        description: privateDescription,
        website: privateWebsite,
        twitter: privateTwitter,
        aliases: [privateAlias],
        tags: ['Priority', 'Prospect']
      },
      createdAt: '2026-07-21T13:59:00.000Z'
    });
    assert.equal(prepared.state, 'ready-for-acquisition');
    assert.equal(prepared.preparationMode, 'connected-acquisition');
    assert.equal(prepared.preview.proposedChanges.length, 0);
    assert.equal(prepared.approval.state, 'not-requested');
    assert.equal(prepared.continuationRequest, null);

    const primary = createRun(temporaryRoot, lock, prepared.id);
    let execution = await prepareOrganizationCaptureConnectedAcquisition({
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
    assert.equal(execution.currentCall.capability.id, 'crm.records.read');
    assert.equal(execution.checkpoint.steps.length, 3);
    assert.equal(execution.run.approvals.length, 0);
    execution = await completeAcquisition({
      root: temporaryRoot,
      execution,
      policyId: notion.recordUris['policy.organization-capture'],
      prefix: 'ORG',
      atSecond: 1,
      targetUri: organizationTarget
    });
    const finalized = finalizeOrganizationCaptureConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex'
    });
    assert.equal(finalized.snapshot.containment, 'connected');
    assert.equal(finalized.snapshot.entries.length, 3);
    assert(finalized.snapshot.entries.every((entry) => entry.freshness === 'passed'));
    assert.equal(finalized.run.lifecycleState, 'paused');
    assert.equal(finalized.run.approvals.length, 0);
    const durableAcquisition = [
      finalized.snapshotPath,
      finalized.runPath,
      execution.checkpointPath
    ].map((file) => fs.readFileSync(path.join(temporaryRoot, file), 'utf8')).join('\n');
    for (const marker of [
      'RAW_ORG_POLICY_SENTINEL',
      'RAW_ORG_SCHEMA_SENTINEL',
      'RAW_ORG_DUPLICATE_SENTINEL'
    ]) {
      assert(!durableAcquisition.includes(marker), marker + ' entered durable Organization state.');
    }

    const inspectedDecision = inspectOrganizationCaptureDecisionContext({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedDecision.outcome.state, 'ready');
    assert.equal(inspectedDecision.outcome.duplicateCandidateCount, 0);
    assert.equal(inspectedDecision.authority.state, 'none');
    const committedDecision = commitOrganizationCaptureDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.organization-capture.connected-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-21T14:00:05.000Z',
      expectedHost: 'codex'
    });
    const replayedDecision = commitOrganizationCaptureDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.organization-capture.connected-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-21T14:00:06.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedDecision.decision.state, 'ready');
    assert.equal(replayedDecision.decisionPath, committedDecision.decisionPath);
    assert.equal(committedDecision.decision.payload.organization.name, privateName);
    assert.equal(committedDecision.decision.payload.organization.organizationType, 'Foundation');
    assert.deepEqual(
      committedDecision.decision.payload.organization.tags,
      ['DeFi', 'Priority', 'Prospect']
    );

    const inspectedProposal = inspectOrganizationCaptureProposalDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedProposal.authority.state, 'none');
    assert.deepEqual(inspectedProposal.inputTemplate, {});
    const committedProposal = commitOrganizationCaptureProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.organization-capture.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-21T14:00:07.000Z',
      expectedHost: 'codex'
    });
    const replayedProposal = commitOrganizationCaptureProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.organization-capture.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-21T14:00:08.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedProposal.proposal.authority.state, 'none');
    assert.equal(replayedProposal.proposalPath, committedProposal.proposalPath);
    assert.equal(replayedProposal.materialPath, committedProposal.materialPath);
    const committedProjection = JSON.stringify(committedProposal);
    for (const privateValue of [privateName, privateDescription, privateWebsite, privateTwitter]) {
      assert(!committedProjection.includes(privateValue));
    }
    const material = inspectOrganizationCaptureProposalMaterial({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      expectedHost: 'codex'
    });
    assert(JSON.stringify(material).includes(privateName));
    assert(JSON.stringify(material).includes(privateAlias));
    assert.equal(material.authority.state, 'none');

    const action = committedProposal.proposal.review.collections[0].rows[0].actions[0];
    assert.equal(action.id, 'action.organization-capture.create');
    assert.equal(action.state, 'proposed');
    const compiled = await createProposalConnectedBatch({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      actionIds: [action.id],
      changeSetId: 'changeset.organization-capture.connected-selftest',
      batchId: 'batch.organization-capture.connected-selftest',
      createdAt: '2026-07-21T14:00:09.000Z',
      expectedHost: 'codex'
    });
    assert.equal(compiled.authority.state, 'none');
    assert.equal(compiled.providerCallsExecuted, 0);
    assert.equal(compiled.externalWritesPerformed, 0);
    assert.equal(compiled.batch.operations.length, 1);
    assert.equal(compiled.batch.operations[0].capability, 'crm.records.create');
    assert.equal(compiled.batch.operations[0].precondition.capability, 'crm.records.read');
    assert.deepEqual(compiled.batch.operations[0].input.fields, {
      name: privateName,
      organizationType: 'Foundation',
      tags: ['DeFi', 'Priority', 'Prospect'],
      website: 'https://connected-private.example',
      twitter: 'https://twitter.com/connectprivate'
    });

    const requested = await beginProposalConnectedApprovalRequest({
      root: temporaryRoot,
      configurationBasis: 'private-active',
      lockPath: primary.lockPath,
      runPath: committedProposal.runPath,
      batch: compiled.batch,
      changeSet: compiled.changeSet,
      id: 'approval-request.organization-capture.connected-selftest',
      reason: 'Review and approve this exact Organization create and alias precondition.',
      createdAt: '2026-07-21T14:00:10.000Z',
      expiresAt: '2026-07-21T14:10:10.000Z'
    });
    const approvalReview = inspectConnectedApprovalReviewMaterial({
      root: temporaryRoot,
      requestId: requested.request.id
    });
    assert.equal(approvalReview.completeness.state, 'complete');
    assert.equal(approvalReview.operations.length, 1);
    assert.equal(approvalReview.privacy.approvalAuthorityIncluded, false);
    assert(JSON.stringify(approvalReview).includes(privateName));
    const confirmed = await confirmProposalConnectedApprovalRequest({
      root: temporaryRoot,
      requestId: requested.request.id,
      approvalId: 'approval.organization-capture.connected-selftest',
      actor: 'operator.selftest',
      reason: 'The exact private Organization fields, alias precondition, and verification were reviewed.',
      confirmedAt: '2026-07-21T14:00:11.000Z'
    });
    assert.equal(
      confirmed.approval.scope.operationBatchFingerprint,
      compiled.batch.batchFingerprint
    );

    const started = await prepareDurableConnectedTransactionExecution({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      at: '2026-07-21T14:00:12.000Z',
      expectedHost: 'codex'
    });
    const replayedStart = await prepareDurableConnectedTransactionExecution({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      at: '2026-07-21T14:00:12.500Z',
      expectedHost: 'codex'
    });
    assert.equal(started.approvalConsumption.state, 'started');
    assert.equal(
      replayedStart.checkpoint.checkpointFingerprint,
      started.checkpoint.checkpointFingerprint
    );
    assert.equal(started.currentCall.capability.id, 'crm.records.read');
    const precondition = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: started.checkpoint.id,
      callId: started.currentCall.id,
      response: recordResponse([], 'RAW_ORG_PRECONDITION_RESPONSE_SENTINEL'),
      at: '2026-07-21T14:00:13.000Z',
      expectedHost: 'codex'
    });
    assert.equal(precondition.currentCall.capability.id, 'crm.records.create');
    assert.equal(precondition.checkpoint.current.stage, 'write');
    assert(!JSON.stringify(precondition).includes('RAW_ORG_PRECONDITION_RESPONSE_SENTINEL'));

    const createdRecordId = CREATED_ORGANIZATION_FIXTURE_URI;
    const written = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: precondition.checkpoint.id,
      callId: precondition.currentCall.id,
      response: createResponse(createdRecordId, 'RAW_ORG_CREATE_RESPONSE_SENTINEL'),
      at: '2026-07-21T14:00:14.000Z',
      expectedHost: 'codex'
    });
    assert.equal(written.currentCall.capability.id, 'crm.records.read');
    assert.equal(written.checkpoint.current.stage, 'verify');
    assert(!JSON.stringify(written).includes('RAW_ORG_CREATE_RESPONSE_SENTINEL'));
    const exactOrganizationFields = compiled.batch.operations[0].input.fields;
    const exactVerificationInput = {
      recordTypes: ['organization'],
      ids: [createdRecordId],
      limit: 2
    };
    assert.equal(
      written.currentCall.inputFingerprint,
      fingerprintJson(exactVerificationInput)
    );
    assert.equal(evaluateOrganizationCaptureConnectedVerification({
      operation: compiled.batch.operations[0],
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'organization',
          id: DUPLICATE_ORGANIZATION_FIXTURE_URI,
          fields: structuredClone(exactOrganizationFields)
        }]
      }
    }).state, 'failed');
    const verified = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: written.checkpoint.id,
      callId: written.currentCall.id,
      response: recordResponse([{
        type: 'organization',
        id: createdRecordId,
        fields: providerOrganizationFields(exactOrganizationFields)
      }], 'RAW_ORG_VERIFICATION_RESPONSE_SENTINEL'),
      at: '2026-07-21T14:00:15.000Z',
      expectedHost: 'codex'
    });
    assert.equal(verified.checkpoint.state, 'completed');
    assert.equal(verified.checkpoint.result.state, 'completed');
    assert.equal(verified.checkpoint.operations[0].state, 'applied');
    assert.equal(verified.currentCall, null);
    assert(!JSON.stringify(verified).includes('RAW_ORG_VERIFICATION_RESPONSE_SENTINEL'));

    const duplicateName = 'CONNECTED_PRIVATE_DUPLICATE_ORGANIZATION_SENTINEL';
    const duplicatePrepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.organization-capture',
      configurationName: 'organization-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        name: duplicateName,
        description: 'A DeFi foundation.'
      },
      createdAt: '2026-07-21T14:00:16.000Z'
    });
    const duplicateRun = createRun(temporaryRoot, lock, duplicatePrepared.id);
    let duplicateExecution = await prepareOrganizationCaptureConnectedAcquisition({
      root: temporaryRoot,
      workId: duplicatePrepared.id,
      at: '2026-07-21T14:00:17.000Z',
      expectedHost: 'codex'
    });
    duplicateExecution = await completeAcquisition({
      root: temporaryRoot,
      execution: duplicateExecution,
      policyId: notion.recordUris['policy.organization-capture'],
      duplicateRecords: [{
        type: 'organization',
        id: DUPLICATE_ORGANIZATION_FIXTURE_URI,
        fields: providerOrganizationFields({
          name: duplicateName,
          organizationType: 'Foundation',
          tags: JSON.stringify(['DeFi']),
          website: null,
          twitter: null,
          projectUris: '[]',
          contactUris: '[]'
        })
      }],
      prefix: 'ORG_DUPLICATE',
      atSecond: 18,
      targetUri: organizationTarget
    });
    const duplicateFinalized = finalizeOrganizationCaptureConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: duplicateExecution.checkpoint.id,
      expectedHost: 'codex'
    });
    const duplicateInspection = inspectOrganizationCaptureDecisionContext({
      root: temporaryRoot,
      lockPath: duplicateRun.lockPath,
      snapshotId: duplicateFinalized.snapshot.id,
      expectedHost: 'codex'
    });
    assert.equal(duplicateInspection.outcome.state, 'needs-input');
    assert.equal(duplicateInspection.outcome.duplicateCandidateCount, 1);
    const duplicateDecision = commitOrganizationCaptureDecision({
      root: temporaryRoot,
      lockPath: duplicateRun.lockPath,
      snapshotId: duplicateFinalized.snapshot.id,
      id: 'decision.organization-capture.duplicate-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-21T14:00:21.000Z',
      expectedHost: 'codex'
    });
    assert.equal(duplicateDecision.decision.state, 'needs-input');
    assert.throws(() => inspectOrganizationCaptureProposalDecision({
      root: temporaryRoot,
      lockPath: duplicateRun.lockPath,
      decisionId: duplicateDecision.decision.id,
      expectedHost: 'codex'
    }), /requires a ready grounded decision/);

    const workspaceText = JSON.stringify(inspectWorkspace(temporaryRoot));
    for (const privateValue of [
      privateName,
      privateDescription,
      privateWebsite,
      privateTwitter,
      privateAlias,
      duplicateName,
      organizationTarget,
      'RAW_ORG_POLICY_SENTINEL',
      'RAW_ORG_SCHEMA_SENTINEL',
      'RAW_ORG_DUPLICATE_SENTINEL',
      'RAW_ORG_PRECONDITION_RESPONSE_SENTINEL',
      'RAW_ORG_CREATE_RESPONSE_SENTINEL',
      'RAW_ORG_VERIFICATION_RESPONSE_SENTINEL',
      'RAW_ORG_DUPLICATE_POLICY_SENTINEL',
      'RAW_ORG_DUPLICATE_SCHEMA_SENTINEL',
      'RAW_ORG_DUPLICATE_DUPLICATE_SENTINEL',
      PRIVATE_ORGANIZATION_TYPE_PREFIX,
      PRIVATE_ORGANIZATION_TAG_PREFIX
    ]) {
      assert(!workspaceText.includes(privateValue), privateValue + ' entered workspace inspection.');
    }
    assert.equal(
      fingerprintPath(path.join(temporaryRoot, 'soter')),
      canonicalBefore,
      'Connected Organization workflow must not mutate canonical Soter artifacts.'
    );
    return createContainedConnectedWorkflowEvidence({
      lock,
      privateContainedBasis,
      id: 'evidence.organization-capture.connected-workflow.fixture',
      createdAt: AT,
      automationId: 'automation.organization-capture',
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

export async function selftestOrganizationCaptureConnectedContext(root = defaultRoot) {
  const evidence = await runContainedOrganizationCaptureConnectedWorkflow(root);
  assert.equal(evidence.result, 'passed');
  process.stdout.write('Organization Capture connected-context selftest passed.\n');
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestOrganizationCaptureConnectedContext().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
