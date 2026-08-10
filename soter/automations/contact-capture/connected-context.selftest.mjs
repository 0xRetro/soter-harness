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
  finalizeContactCaptureConnectedAcquisition,
  prepareContactCaptureConnectedAcquisition
} from './context.mjs';
import { evaluateContactCaptureConnectedVerification } from './connected.mjs';
import {
  commitContactCaptureDecision,
  inspectContactCaptureDecisionContext
} from './decision.mjs';
import {
  commitContactCaptureProposal,
  inspectContactCaptureProposalDecision,
  inspectContactCaptureProposalMaterial
} from './proposal.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T14:00:00.000Z';
const ROLE_OPTIONS = ['Community', 'Engineering', 'Founder', 'Operations', 'Product'];
const STATUS_OPTIONS = ['Active', 'Inactive', 'Prospect'];
const DISPOSITION_OPTIONS = ['Champion', 'Coach', 'Neutral', 'Skeptic'];
const AUTHORITY_OPTIONS = ['Economic Buyer', 'Influencer', 'Technical Buyer', 'User'];
const TAG_OPTIONS = ['DeFi', 'Grants', 'Priority', 'Prospect'];
const PRIVATE_CONTACT_OPTION_PREFIX = 'PRIVATE_PROVIDER_CONTACT_OPTION_';
const CONNECTED_ORGANIZATION_URI
  = 'https://www.notion.so/33333333333333333333333333333333';

function providerOption(field, portable) {
  return PRIVATE_CONTACT_OPTION_PREFIX
    + field.toUpperCase()
    + '_'
    + portable.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function containedOptionMappings() {
  return [
    ['role', ROLE_OPTIONS],
    ['status', STATUS_OPTIONS],
    ['disposition', DISPOSITION_OPTIONS],
    ['authority', AUTHORITY_OPTIONS],
    ['tags', TAG_OPTIONS]
  ].map(([field, values]) => ({
    mapping: 'mapping.integration.notion.crm-records',
    recordType: 'person',
    field,
    mode: 'exact-bijection',
    entries: values.map((portable) => ({
      portable,
      provider: providerOption(field, portable)
    }))
  })).concat([
    {
      mapping: 'mapping.integration.notion.crm-records',
      recordType: 'organization',
      field: 'organizationType',
      mode: 'exact-bijection',
      entries: [{
        portable: 'DevCo',
        provider: providerOption('organizationType', 'DevCo')
      }]
    },
    {
      mapping: 'mapping.integration.notion.crm-records',
      recordType: 'organization',
      field: 'tags',
      mode: 'exact-bijection',
      entries: [{
        portable: 'Prospect',
        provider: providerOption('organizationTags', 'Prospect')
      }]
    }
  ]);
}

function providerPersonFields(fields) {
  const result = { ...fields };
  for (const field of ['role', 'status', 'disposition']) {
    if (result[field] !== undefined && result[field] !== null) {
      result[field] = providerOption(field, result[field]);
    }
  }
  for (const field of ['authority', 'tags']) {
    if (result[field] === undefined) continue;
    const values = typeof result[field] === 'string'
      ? JSON.parse(result[field])
      : result[field];
    result[field] = JSON.stringify(
      values.map((value) => providerOption(field, value))
    );
  }
  return result;
}

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-contact-context-selftest-'));
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

function schemaResponse(marker, target) {
  const schema = {
    Name: property('Name', 'title'),
    Email: property('Email', 'email'),
    Role: property('Role', 'select', ROLE_OPTIONS.map((value) => providerOption('role', value))),
    Status: property(
      'Status',
      'select',
      STATUS_OPTIONS.map((value) => providerOption('status', value))
    ),
    Disposition: property(
      'Disposition',
      'select',
      DISPOSITION_OPTIONS.map((value) => providerOption('disposition', value))
    ),
    Authority: property(
      'Authority',
      'multi_select',
      AUTHORITY_OPTIONS.map((value) => providerOption('authority', value))
    ),
    Tags: property(
      'Tags',
      'multi_select',
      TAG_OPTIONS.map((value) => providerOption('tags', value))
    ),
    Telegram: property('Telegram', 'text'),
    Signal: property('Signal', 'text'),
    'Discord ID': property('Discord ID', 'text'),
    Github: property('Github', 'text'),
    'Timezone (UTC)': property('Timezone (UTC)', 'text'),
    Source: property('Source', 'text'),
    'Sky Forum': property('Sky Forum', 'text'),
    'Schedule appointment': property('Schedule appointment', 'url'),
    Org: property('Org', 'relation')
  };
  return {
    structuredContent: {
      result: {
        metadata: { type: 'data_source' },
        title: marker,
        text: '<data-source url="{{' + target + '}}">\n'
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
  const suffix = workId.slice('work.contact-capture.'.length);
  const work = inspectPreparedAutomationWork({ root, workId });
  const lockPath = work.configuration.lockPath;
  const runPath = repoRelativePath(root, runStatePath(root, work.checkpoint.runId));
  const run = readJson(resolveRepoPath(root, runPath));
  assert.equal(run.id, work.checkpoint.runId);
  assert.equal(run.configurationLock.path, lockPath);
  const copiedLockPath = 'private/contact-capture.' + suffix + '.copied.lock.json';
  const unrelatedRunPath = 'private/contact-capture.' + suffix + '.unrelated.run.json';
  writeJson(path.join(root, copiedLockPath), lock);
  const unrelatedRun = prepareRunEnvelope({
    root,
    lock,
    lockPath: copiedLockPath,
    automationId: 'automation.contact-capture',
    runId: 'run.contact-capture.unrelated.' + suffix,
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
  organizationRecords = [],
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
      type: 'contact-capture-policy',
      id: policyId,
      fields: { name: 'Contacts' }
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
  if (current.currentCall) {
    assert.equal(current.currentCall.capability.id, 'crm.records.read');
    current = await completeDurableOperationPlanExecution({
      root,
      checkpointId: current.checkpoint.id,
      callId: current.currentCall.id,
      response: recordResponse(
        organizationRecords,
        'RAW_' + prefix + '_ORGANIZATION_SENTINEL'
      ),
      at: '2026-07-21T14:00:' + String(atSecond + 3).padStart(2, '0') + '.000Z',
      expectedHost: 'codex'
    });
  }
  assert.equal(current.checkpoint.state, 'completed');
  return current;
}

export async function runContainedContactCaptureConnectedWorkflow(
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
      configurationName: 'contact-capture',
      expectedTemplateLock: preparedLock,
      notionOptionMappings: containedOptionMappings()
    });
    const contactTarget = notion.targets.contacts;
    const fixtureDirectory = path.join(
      temporaryRoot,
      'soter',
      'fixtures',
      'contact-capture'
    );
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    writeJson(path.join(fixtureDirectory, 'contact-capture.lock.json'), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const privateName = 'CONNECTED_PRIVATE_CONTACT_SENTINEL';
    const privateEmail = 'connected.private@example.invalid';
    const privateOrganization = 'Acme Design';
    const privateTelegram = 'CONNECTED_PRIVATE_TELEGRAM_SENTINEL';
    const privateSignal = 'CONNECTED_PRIVATE_SIGNAL_SENTINEL';
    const privateGithub = 'CONNECTED_PRIVATE_GITHUB_SENTINEL';
    const privateSource = 'CONNECTED_PRIVATE_SOURCE_SENTINEL';
    const prepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.contact-capture',
      configurationName: 'contact-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        name: privateName,
        email: privateEmail,
        organizationName: privateOrganization,
        role: 'Engineering',
        status: 'Prospect',
        disposition: 'Coach',
        authority: ['Technical Buyer'],
        telegram: privateTelegram,
        signal: privateSignal,
        github: privateGithub,
        timezoneUtc: 'UTC+1',
        source: privateSource,
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
    let execution = await prepareContactCaptureConnectedAcquisition({
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
    assert.equal(execution.checkpoint.steps.length, 4);
    assert.equal(execution.run.approvals.length, 0);
    execution = await completeAcquisition({
      root: temporaryRoot,
      execution,
      policyId: notion.recordUris['policy.contact-capture'],
      organizationRecords: [{
        type: 'organization',
        id: CONNECTED_ORGANIZATION_URI,
        fields: { name: privateOrganization }
      }],
      prefix: 'CONTACT',
      atSecond: 1,
      targetUri: contactTarget
    });
    const finalized = finalizeContactCaptureConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex'
    });
    assert.equal(finalized.snapshot.containment, 'connected');
    assert.equal(finalized.snapshot.entries.length, 4);
    assert(finalized.snapshot.entries.every((entry) => entry.freshness === 'passed'));
    assert.equal(finalized.run.lifecycleState, 'paused');
    assert.equal(finalized.run.approvals.length, 0);
    const durableAcquisition = [
      finalized.snapshotPath,
      finalized.runPath,
      execution.checkpointPath
    ].map((file) => fs.readFileSync(path.join(temporaryRoot, file), 'utf8')).join('\n');
    for (const marker of [
      'RAW_CONTACT_POLICY_SENTINEL',
      'RAW_CONTACT_SCHEMA_SENTINEL',
      'RAW_CONTACT_DUPLICATE_SENTINEL',
      'RAW_CONTACT_ORGANIZATION_SENTINEL'
    ]) {
      assert(!durableAcquisition.includes(marker), marker + ' entered durable Contact state.');
    }

    const inspectedDecision = inspectContactCaptureDecisionContext({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedDecision.outcome.state, 'ready');
    assert.equal(inspectedDecision.outcome.duplicateCandidateCount, 0);
    assert.equal(inspectedDecision.authority.state, 'none');
    const committedDecision = commitContactCaptureDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.contact-capture.connected-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-21T14:00:05.000Z',
      expectedHost: 'codex'
    });
    const replayedDecision = commitContactCaptureDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.contact-capture.connected-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-21T14:00:06.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedDecision.decision.state, 'ready');
    assert.equal(replayedDecision.decisionPath, committedDecision.decisionPath);
    assert.equal(committedDecision.decision.payload.person.name, privateName);
    assert.equal(committedDecision.decision.payload.person.email, privateEmail);
    assert.equal(committedDecision.decision.payload.person.role, 'Engineering');
    assert.equal(committedDecision.decision.payload.person.status, 'Prospect');
    assert.equal(committedDecision.decision.payload.person.disposition, 'Coach');
    assert.deepEqual(
      committedDecision.decision.payload.person.authority,
      ['Technical Buyer']
    );
    assert.deepEqual(
      committedDecision.decision.payload.person.tags,
      ['Priority', 'Prospect']
    );
    assert.deepEqual(
      committedDecision.decision.payload.person.organizationUris,
      [CONNECTED_ORGANIZATION_URI]
    );

    const inspectedProposal = inspectContactCaptureProposalDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedProposal.authority.state, 'none');
    assert.deepEqual(inspectedProposal.inputTemplate, {});
    const committedProposal = commitContactCaptureProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.contact-capture.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-21T14:00:07.000Z',
      expectedHost: 'codex'
    });
    const replayedProposal = commitContactCaptureProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.contact-capture.connected-selftest',
      input: {},
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-21T14:00:08.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedProposal.proposal.authority.state, 'none');
    assert.equal(replayedProposal.proposalPath, committedProposal.proposalPath);
    assert.equal(replayedProposal.materialPath, committedProposal.materialPath);
    const committedProjection = JSON.stringify(committedProposal);
    for (const privateValue of [
      privateName,
      privateEmail,
      privateOrganization,
      privateTelegram,
      privateSignal,
      privateGithub,
      privateSource
    ]) {
      assert(!committedProjection.includes(privateValue));
    }
    const material = inspectContactCaptureProposalMaterial({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      expectedHost: 'codex'
    });
    assert(JSON.stringify(material).includes(privateName));
    assert(JSON.stringify(material).includes(privateEmail));
    assert(JSON.stringify(material).includes(privateTelegram));
    assert.equal(material.authority.state, 'none');

    const action = committedProposal.proposal.review.collections[0].rows[0].actions[0];
    assert.equal(action.id, 'action.contact-capture.create');
    assert.equal(action.state, 'proposed');
    const compiled = await createProposalConnectedBatch({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      actionIds: [action.id],
      changeSetId: 'changeset.contact-capture.connected-selftest',
      batchId: 'batch.contact-capture.connected-selftest',
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
      email: privateEmail,
      role: 'Engineering',
      status: 'Prospect',
      disposition: 'Coach',
      authority: ['Technical Buyer'],
      tags: ['Priority', 'Prospect'],
      telegram: privateTelegram,
      signal: privateSignal,
      github: privateGithub,
      timezoneUtc: 'UTC+1',
      source: privateSource,
      organizationUris: [CONNECTED_ORGANIZATION_URI]
    });

    const requested = await beginProposalConnectedApprovalRequest({
      root: temporaryRoot,
      configurationBasis: 'private-active',
      lockPath: primary.lockPath,
      runPath: committedProposal.runPath,
      batch: compiled.batch,
      changeSet: compiled.changeSet,
      id: 'approval-request.contact-capture.connected-selftest',
      reason: 'Review and approve this exact Contact create and email-or-name absence precondition.',
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
      approvalId: 'approval.contact-capture.connected-selftest',
      actor: 'operator.selftest',
      reason: 'The exact private Contact fields, duplicate precondition, and verification were reviewed.',
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
      response: recordResponse([], 'RAW_CONTACT_PRECONDITION_RESPONSE_SENTINEL'),
      at: '2026-07-21T14:00:13.000Z',
      expectedHost: 'codex'
    });
    assert.equal(precondition.currentCall.capability.id, 'crm.records.create');
    assert.equal(precondition.checkpoint.current.stage, 'write');
    assert(!JSON.stringify(precondition).includes('RAW_CONTACT_PRECONDITION_RESPONSE_SENTINEL'));

    const createdRecordId = 'https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const written = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: precondition.checkpoint.id,
      callId: precondition.currentCall.id,
      response: createResponse(createdRecordId, 'RAW_CONTACT_CREATE_RESPONSE_SENTINEL'),
      at: '2026-07-21T14:00:14.000Z',
      expectedHost: 'codex'
    });
    assert.equal(written.currentCall.capability.id, 'crm.records.read');
    assert.equal(written.checkpoint.current.stage, 'verify');
    assert(!JSON.stringify(written).includes('RAW_CONTACT_CREATE_RESPONSE_SENTINEL'));
    const exactContactFields = compiled.batch.operations[0].input.fields;
    const exactVerificationInput = {
      recordTypes: ['person'],
      ids: [createdRecordId],
      limit: 2
    };
    assert.equal(
      written.currentCall.inputFingerprint,
      fingerprintJson(exactVerificationInput)
    );
    assert.equal(evaluateContactCaptureConnectedVerification({
      operation: compiled.batch.operations[0],
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'person',
          id: 'https://www.notion.so/cccccccccccccccccccccccccccccccc',
          fields: structuredClone(exactContactFields)
        }]
      }
    }).state, 'failed');
    assert.equal(evaluateContactCaptureConnectedVerification({
      operation: compiled.batch.operations[0],
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'person',
          id: createdRecordId,
          fields: {
            ...structuredClone(exactContactFields),
            discordId: 'UNREVIEWED_CONTACT_FIELD_SENTINEL'
          }
        }]
      }
    }).reasonCode, 'READ_AFTER_WRITE_MISMATCH');
    const verified = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: written.checkpoint.id,
      callId: written.currentCall.id,
      response: recordResponse([{
        type: 'person',
        id: createdRecordId,
        fields: providerPersonFields({
          ...exactContactFields,
          authority: JSON.stringify(exactContactFields.authority),
          tags: JSON.stringify(exactContactFields.tags),
          organizationUris: JSON.stringify(exactContactFields.organizationUris)
        })
      }], 'RAW_CONTACT_VERIFICATION_RESPONSE_SENTINEL'),
      at: '2026-07-21T14:00:15.000Z',
      expectedHost: 'codex'
    });
    assert.equal(verified.checkpoint.state, 'completed');
    assert.equal(verified.checkpoint.result.state, 'completed');
    assert.equal(verified.checkpoint.operations[0].state, 'applied');
    assert.equal(verified.currentCall, null);
    assert(!JSON.stringify(verified).includes('RAW_CONTACT_VERIFICATION_RESPONSE_SENTINEL'));

    const duplicateName = 'CONNECTED_PRIVATE_DUPLICATE_CONTACT_SENTINEL';
    const duplicatePrepared = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.contact-capture',
      configurationName: 'contact-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        name: duplicateName,
        email: 'connected.duplicate@example.invalid'
      },
      createdAt: '2026-07-21T14:00:16.000Z'
    });
    const duplicateRun = createRun(temporaryRoot, lock, duplicatePrepared.id);
    let duplicateExecution = await prepareContactCaptureConnectedAcquisition({
      root: temporaryRoot,
      workId: duplicatePrepared.id,
      at: '2026-07-21T14:00:17.000Z',
      expectedHost: 'codex'
    });
    duplicateExecution = await completeAcquisition({
      root: temporaryRoot,
      execution: duplicateExecution,
      policyId: notion.recordUris['policy.contact-capture'],
      duplicateRecords: [{
        type: 'person',
        id: 'https://www.notion.so/dddddddddddddddddddddddddddddddd',
        fields: providerPersonFields({
          name: duplicateName,
          email: 'connected.duplicate@example.invalid',
          role: 'Engineering',
          status: 'Prospect',
          disposition: 'Neutral',
          authority: JSON.stringify(['User']),
          tags: JSON.stringify(['Prospect']),
          telegram: null,
          signal: null,
          discordId: null,
          github: null,
          timezoneUtc: null,
          source: null,
          skyForum: null,
          scheduleAppointment: null,
          organizationUris: '[]'
        })
      }],
      prefix: 'CONTACT_DUPLICATE',
      atSecond: 18,
      targetUri: contactTarget
    });
    const duplicateFinalized = finalizeContactCaptureConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: duplicateExecution.checkpoint.id,
      expectedHost: 'codex'
    });
    const duplicateInspection = inspectContactCaptureDecisionContext({
      root: temporaryRoot,
      lockPath: duplicateRun.lockPath,
      snapshotId: duplicateFinalized.snapshot.id,
      expectedHost: 'codex'
    });
    assert.equal(duplicateInspection.outcome.state, 'needs-input');
    assert.equal(duplicateInspection.outcome.duplicateCandidateCount, 1);
    const duplicateDecision = commitContactCaptureDecision({
      root: temporaryRoot,
      lockPath: duplicateRun.lockPath,
      snapshotId: duplicateFinalized.snapshot.id,
      id: 'decision.contact-capture.duplicate-selftest',
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-21T14:00:21.000Z',
      expectedHost: 'codex'
    });
    assert.equal(duplicateDecision.decision.state, 'needs-input');
    assert.throws(() => inspectContactCaptureProposalDecision({
      root: temporaryRoot,
      lockPath: duplicateRun.lockPath,
      decisionId: duplicateDecision.decision.id,
      expectedHost: 'codex'
    }), /requires a ready grounded decision/);

    const workspaceText = JSON.stringify(inspectWorkspace(temporaryRoot));
    for (const privateValue of [
      privateName,
      privateEmail,
      privateOrganization,
      privateTelegram,
      privateSignal,
      privateGithub,
      privateSource,
      contactTarget,
      duplicateName,
      'RAW_CONTACT_POLICY_SENTINEL',
      'RAW_CONTACT_SCHEMA_SENTINEL',
      'RAW_CONTACT_DUPLICATE_SENTINEL',
      'RAW_CONTACT_ORGANIZATION_SENTINEL',
      'RAW_CONTACT_PRECONDITION_RESPONSE_SENTINEL',
      'RAW_CONTACT_CREATE_RESPONSE_SENTINEL',
      'RAW_CONTACT_VERIFICATION_RESPONSE_SENTINEL',
      'RAW_CONTACT_DUPLICATE_POLICY_SENTINEL',
      'RAW_CONTACT_DUPLICATE_SCHEMA_SENTINEL',
      'RAW_CONTACT_DUPLICATE_DUPLICATE_SENTINEL',
      PRIVATE_CONTACT_OPTION_PREFIX
    ]) {
      assert(!workspaceText.includes(privateValue), privateValue + ' entered workspace inspection.');
    }
    assert.equal(
      fingerprintPath(path.join(temporaryRoot, 'soter')),
      canonicalBefore,
      'Connected Contact workflow must not mutate canonical Soter artifacts.'
    );
    return createContainedConnectedWorkflowEvidence({
      lock,
      privateContainedBasis,
      id: 'evidence.contact-capture.connected-workflow.fixture',
      createdAt: AT,
      automationId: 'automation.contact-capture',
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

export async function selftestContactCaptureConnectedContext(root = defaultRoot) {
  const evidence = await runContainedContactCaptureConnectedWorkflow(root);
  assert.equal(evidence.result, 'passed');
  process.stdout.write('Contact Capture connected-context selftest passed.\n');
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestContactCaptureConnectedContext().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
