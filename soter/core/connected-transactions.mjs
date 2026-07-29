import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { fingerprintJson, readJson } from './lib/canonical-json.mjs';
import { fingerprintLock } from './resolve.mjs';
import { changeSetScopeFingerprint } from './connected-scope.mjs';
import { assertProposalConnectedBatch } from './proposal-connected-batches.mjs';

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(label + ' does not satisfy its contract: '
      + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; '));
  }
}

function batchFingerprint(batch) {
  const value = structuredClone(batch);
  delete value.batchFingerprint;
  return fingerprintJson(value);
}

function approvalRequestFingerprint(request) {
  const value = structuredClone(request);
  delete value.requestFingerprint;
  return fingerprintJson(value);
}

export function connectedApprovalFingerprint(approval) {
  const value = structuredClone(approval);
  delete value.approvalFingerprint;
  return fingerprintJson(value);
}

export function assertConnectedOperationBatchApprovalRequest({
  root,
  request,
  batch = request?.batch,
  changeSet = request?.changeSet,
  lock = null,
  run = null,
  at,
  allowExpired = false
}) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    request,
    'soter/contracts/approval-request.schema.json',
    'Connected approval request'
  );
  validate(
    resolvedRoot,
    batch,
    'soter/contracts/connected-operation-batch-v2.schema.json',
    'Connected operation batch'
  );
  validate(
    resolvedRoot,
    changeSet,
    'soter/contracts/connected-change-set-v2.schema.json',
    'Connected change set'
  );
  assertProposalConnectedBatch({ root: resolvedRoot, batch, changeSet });
  const createdAt = Date.parse(request.createdAt);
  const expiresAt = Date.parse(request.expiresAt);
  const observedAt = Date.parse(at);
  if (request.requestFingerprint !== approvalRequestFingerprint(request)
    || request.batchFingerprint !== fingerprintJson(batch)
    || request.changeSetFingerprint !== fingerprintJson(changeSet)
    || fingerprintJson(request.batch) !== fingerprintJson(batch)
    || fingerprintJson(request.changeSet) !== fingerprintJson(changeSet)
    || request.run.id !== batch.runId
    || request.configuration.configurationBasis !== 'private-active'
    || request.configuration.lockFingerprint
      !== batch.configurationLockFingerprint
    || request.scope.changeSetId !== changeSet.id
    || request.scope.changeSetFingerprint !== changeSet.scopeFingerprint
    || request.scope.operationBatchId !== batch.id
    || request.scope.operationBatchFingerprint !== batch.batchFingerprint
    || request.scope.configurationLockFingerprint !== batch.configurationLockFingerprint
    || fingerprintJson(request.scope.effects) !== fingerprintJson(['write'])
    || !Number.isFinite(createdAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= createdAt
    || expiresAt - createdAt > 15 * 60 * 1000) {
    throw new Error('Connected approval request does not match the exact executable batch and change set.');
  }
  if (lock && (request.configuration.name !== lock.configuration.name
    || request.configuration.configurationBasis !== 'private-active'
    || request.configuration.path !== lock.configuration.path
    || request.configuration.lockFingerprint !== fingerprintLock(lock)
    || request.configuration.graphFingerprint !== lock.graphFingerprint
    || request.configuration.host !== lock.host.id)) {
    throw new Error('Connected approval request does not match the exact current lock and host.');
  }
  if (run && (request.run.id !== run.id
    || request.run.fingerprint !== fingerprintJson(run))) {
    throw new Error('Connected approval request does not match the exact source run.');
  }
  if (!allowExpired && (!Number.isFinite(observedAt)
    || observedAt < createdAt
    || observedAt > expiresAt)) {
    throw new Error('Connected approval request is not current.');
  }
  return true;
}

export function createBoundConnectedApprovalRequest({
  root,
  lock,
  lockPath,
  run,
  runPath,
  configuration,
  batch,
  changeSet,
  id,
  reason,
  createdAt,
  expiresAt
}) {
  const resolvedRoot = path.resolve(root);
  assertProposalConnectedBatch({ root: resolvedRoot, batch, changeSet });
  const request = {
    $contract: 'soter://contracts/approval-request/v1',
    contractVersion: '1.0.0',
    id,
    createdAt,
    expiresAt,
    configuration: {
      ...structuredClone(configuration),
      host: lock.host.id
    },
    run: {
      id: run.id,
      path: runPath,
      fingerprint: fingerprintJson(run)
    },
    batch: structuredClone(batch),
    batchFingerprint: fingerprintJson(batch),
    changeSet: structuredClone(changeSet),
    changeSetFingerprint: fingerprintJson(changeSet),
    scope: {
      changeSetId: changeSet.id,
      changeSetFingerprint: changeSet.scopeFingerprint,
      operationBatchId: batch.id,
      operationBatchFingerprint: batch.batchFingerprint,
      configurationLockFingerprint: fingerprintLock(lock),
      effects: ['write']
    },
    reason,
    requestFingerprint: fingerprintJson(null)
  };
  if (!configuration
    || configuration.configurationBasis !== 'private-active'
    || configuration.name !== lock.configuration.name
    || configuration.path !== lock.configuration.path
    || configuration.lockPath !== lockPath
    || configuration.lockFingerprint !== fingerprintLock(lock)
    || configuration.graphFingerprint !== lock.graphFingerprint) {
    throw new Error(
      'Connected approval request requires the exact private-active configuration selection.'
    );
  }
  request.requestFingerprint = approvalRequestFingerprint(request);
  assertConnectedOperationBatchApprovalRequest({
    root: resolvedRoot,
    request,
    lock,
    run,
    at: createdAt
  });
  return request;
}

export function assertConnectedOperationBatchApproval({
  root,
  batch,
  changeSet,
  approval,
  at,
  allowExpired = false
}) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    batch,
    'soter/contracts/connected-operation-batch-v2.schema.json',
    'Connected operation batch'
  );
  validate(
    resolvedRoot,
    changeSet,
    'soter/contracts/connected-change-set-v2.schema.json',
    'Connected change set'
  );
  validate(resolvedRoot, approval, 'soter/contracts/approval-v2.schema.json', 'Connected approval');
  const approvalCreatedAt = Date.parse(approval.createdAt);
  const approvalExpiresAt = Date.parse(approval.expiresAt);
  assertConnectedOperationBatchApprovalRequest({
    root: resolvedRoot,
    request: approval.request,
    batch,
    changeSet,
    at,
    allowExpired
  });
  assertProposalConnectedBatch({ root: resolvedRoot, batch, changeSet });
  if (approval.decision !== 'approved'
    || approval.runId !== batch.runId
    || approval.scope.requestId !== approval.request.id
    || approval.scope.requestFingerprint !== approval.request.requestFingerprint
    || approval.scope.changeSetId !== changeSet.id
    || approval.scope.changeSetFingerprint !== changeSet.scopeFingerprint
    || approval.scope.operationBatchId !== batch.id
    || approval.scope.operationBatchFingerprint !== batch.batchFingerprint
    || approval.scope.configurationLockFingerprint !== batch.configurationLockFingerprint
    || fingerprintJson(approval.scope.effects) !== fingerprintJson(['write'])
    || approval.approvalFingerprint !== connectedApprovalFingerprint(approval)
    || !Number.isFinite(approvalCreatedAt)
    || !Number.isFinite(approvalExpiresAt)
    || approvalExpiresAt <= approvalCreatedAt
    || approvalExpiresAt !== Date.parse(approval.request.expiresAt)
    || approvalCreatedAt < Date.parse(approval.request.createdAt)
    || approvalExpiresAt - approvalCreatedAt > 15 * 60 * 1000) {
    throw new Error('Connected approval does not match the exact executable change set and operation batch.');
  }
  const observedAt = Date.parse(at);
  if (!allowExpired && (!Number.isFinite(observedAt)
    || observedAt < approvalCreatedAt
    || observedAt > approvalExpiresAt)) {
    throw new Error('Connected approval is not current for transaction initiation.');
  }
  return true;
}

export function approveConnectedOperationBatch({
  root,
  request,
  batch = request?.batch,
  changeSet = request?.changeSet,
  id,
  actor,
  reason,
  createdAt
}) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    batch,
    'soter/contracts/connected-operation-batch-v2.schema.json',
    'Connected operation batch'
  );
  validate(
    resolvedRoot,
    changeSet,
    'soter/contracts/connected-change-set-v2.schema.json',
    'Connected change set'
  );
  assertProposalConnectedBatch({ root: resolvedRoot, batch, changeSet });
  if (!batch.executable || batch.state !== 'proposed'
    || batch.batchFingerprint !== batchFingerprint(batch)
    || batch.changeSet.id !== changeSet.id
    || batch.changeSet.scopeFingerprint !== changeSetScopeFingerprint(changeSet)) {
    throw new Error('Blocked, stale, or mismatched connected operation batch cannot be approved.');
  }
  assertConnectedOperationBatchApprovalRequest({
    root: resolvedRoot,
    request,
    batch,
    changeSet,
    at: createdAt
  });
  const approval = {
    $contract: 'soter://contracts/approval/v2',
    contractVersion: '2.0.0',
    id,
    runId: batch.runId,
    createdAt,
    expiresAt: request.expiresAt,
    actor,
    decision: 'approved',
    request: structuredClone(request),
    scope: {
      requestId: request.id,
      requestFingerprint: request.requestFingerprint,
      changeSetId: changeSet.id,
      changeSetFingerprint: changeSet.scopeFingerprint,
      operationBatchId: batch.id,
      operationBatchFingerprint: batch.batchFingerprint,
      configurationLockFingerprint: batch.configurationLockFingerprint,
      effects: ['write']
    },
    reason,
    approvalFingerprint: fingerprintJson(null)
  };
  approval.approvalFingerprint = connectedApprovalFingerprint(approval);
  validate(resolvedRoot, approval, 'soter/contracts/approval-v2.schema.json', 'Connected approval');
  assertConnectedOperationBatchApproval({
    root: resolvedRoot,
    batch,
    changeSet,
    approval,
    at: createdAt
  });
  return approval;
}
