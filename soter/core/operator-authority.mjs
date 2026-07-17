import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  approveConnectedOperationBatch,
  assertConnectedOperationBatchApproval,
  assertConnectedOperationBatchApprovalRequest,
  connectedApprovalFingerprint,
  createBoundConnectedApprovalRequest,
  createConnectedOperationBatchApprovalRequest
} from './connected-transactions.mjs';
import { assertExactProposalConnectedBatch } from './proposal-connected-batches.mjs';
import {
  fingerprintJson,
  readJson,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import {
  fingerprintLock,
  lockMatchesResolution
} from './resolve.mjs';
import { inspectConnectedApprovalReviewMaterial } from './connected-approval-review.mjs';
import {
  createApprovalConsumptionState,
  hasApprovalConsumptionState,
  readApprovalConsumptionState,
  readApprovalRequestState,
  readConnectedApprovalState,
  writeApprovalConsumptionState,
  writeApprovalRequestState,
  writeConnectedApprovalState
} from './runtime-state.mjs';

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(label + ' does not satisfy its contract: '
      + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '));
  }
}

function approvalConsumptionFingerprint(consumption) {
  const value = structuredClone(consumption);
  delete value.consumptionFingerprint;
  return fingerprintJson(value);
}

export function assertApprovalConsumptionDocument(root, consumption) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    consumption,
    'soter/contracts/approval-consumption.schema.json',
    'Approval consumption'
  );
  if (consumption.consumptionFingerprint !== approvalConsumptionFingerprint(consumption)
    || (consumption.state === 'reserved') !== (consumption.checkpointFingerprint === null)) {
    throw new Error('Approval consumption fingerprint or lifecycle fields are stale.');
  }
  return consumption;
}

export function readConnectedApprovalRequest({ root, requestId, at, allowExpired = true }) {
  const resolvedRoot = path.resolve(root);
  const request = readApprovalRequestState(resolvedRoot, requestId).request;
  assertConnectedOperationBatchApprovalRequest({
    root: resolvedRoot,
    request,
    at: at || request.createdAt,
    allowExpired
  });
  return request;
}

export function readConnectedApproval({
  root,
  approvalId,
  at,
  allowExpired = true,
  lock = null,
  run = null
}) {
  const resolvedRoot = path.resolve(root);
  const approval = readConnectedApprovalState(resolvedRoot, approvalId).approval;
  assertConnectedOperationBatchApproval({
    root: resolvedRoot,
    batch: approval.request.batch,
    changeSet: approval.request.changeSet,
    approval,
    at: at || approval.createdAt,
    allowExpired
  });
  assertConnectedOperationBatchApprovalRequest({
    root: resolvedRoot,
    request: approval.request,
    lock,
    run,
    at: at || approval.createdAt,
    allowExpired
  });
  return approval;
}

export function approvalConsumptionId(approvalId) {
  if (typeof approvalId !== 'string' || !approvalId.startsWith('approval.')) {
    throw new Error('Connected approval id must begin with approval.');
  }
  return 'approval-consumption.' + approvalId.slice('approval.'.length);
}

export function beginConnectedApprovalRequest({
  root,
  lockPath,
  runPath,
  batch,
  changeSet,
  id,
  reason,
  createdAt,
  expiresAt
}) {
  const resolvedRoot = path.resolve(root);
  const lock = readJson(resolveRepoPath(resolvedRoot, lockPath));
  const exact = lockMatchesResolution({ lock, root: resolvedRoot });
  if (!exact.matches) {
    throw new Error('Connected approval request requires a current exact lock.');
  }
  const run = readJson(resolveRepoPath(resolvedRoot, runPath));
  if (run.id !== batch.runId
    || run.configurationLock.fingerprint !== fingerprintLock(lock)
    || run.graphFingerprint !== lock.graphFingerprint
    || run.host.id !== lock.host.id) {
    throw new Error('Connected approval request requires an exact run for the current lock and host.');
  }
  const request = createConnectedOperationBatchApprovalRequest({
    root: resolvedRoot,
    lock,
    lockPath,
    run,
    runPath,
    batch,
    changeSet,
    id,
    reason,
    createdAt,
    expiresAt
  });
  const persisted = writeApprovalRequestState(resolvedRoot, request);
  return { request, requestPath: persisted.path };
}

export async function beginProposalConnectedApprovalRequest({
  root,
  lockPath,
  runPath,
  batch,
  changeSet,
  id,
  reason,
  createdAt,
  expiresAt
}) {
  const resolvedRoot = path.resolve(root);
  const lock = readJson(resolveRepoPath(resolvedRoot, lockPath));
  const exact = lockMatchesResolution({ lock, root: resolvedRoot });
  if (!exact.matches) {
    throw new Error('Connected approval request requires a current exact lock.');
  }
  const run = readJson(resolveRepoPath(resolvedRoot, runPath));
  if (run.id !== batch.runId
    || run.configurationLock.fingerprint !== fingerprintLock(lock)
    || run.graphFingerprint !== lock.graphFingerprint
    || run.host.id !== lock.host.id) {
    throw new Error('Connected approval request requires an exact run for the current lock and host.');
  }
  await assertExactProposalConnectedBatch({
    root: resolvedRoot,
    lockPath,
    batch,
    changeSet,
    expectedHost: lock.host.id
  });
  const request = createBoundConnectedApprovalRequest({
    root: resolvedRoot,
    lock,
    lockPath,
    run,
    runPath,
    batch,
    changeSet,
    id,
    reason,
    createdAt,
    expiresAt
  });
  const persisted = writeApprovalRequestState(resolvedRoot, request);
  return { request, requestPath: persisted.path };
}

export function confirmConnectedApprovalRequest({
  root,
  requestId,
  approvalId,
  actor,
  reason,
  confirmedAt
}) {
  const resolvedRoot = path.resolve(root);
  const request = readConnectedApprovalRequest({
    root: resolvedRoot,
    requestId,
    at: confirmedAt,
    allowExpired: false
  });
  const lock = readJson(resolveRepoPath(resolvedRoot, request.configuration.lockPath));
  const exact = lockMatchesResolution({ lock, root: resolvedRoot });
  if (!exact.matches
    || fingerprintLock(lock) !== request.configuration.lockFingerprint
    || lock.graphFingerprint !== request.configuration.graphFingerprint
    || lock.host.id !== request.configuration.host) {
    throw new Error('Connected approval confirmation requires the request exact lock to remain current.');
  }
  const run = readJson(resolveRepoPath(resolvedRoot, request.run.path));
  assertConnectedOperationBatchApprovalRequest({
    root: resolvedRoot,
    request,
    lock,
    run,
    at: confirmedAt,
    allowExpired: false
  });
  const review = inspectConnectedApprovalReviewMaterial({ root: resolvedRoot, requestId });
  if (review.configuration.applicability.state !== 'current') {
    throw new Error('Connected approval confirmation requires current exact private review material.');
  }
  const approval = approveConnectedOperationBatch({
    root: resolvedRoot,
    request,
    id: approvalId,
    actor,
    reason,
    createdAt: confirmedAt
  });
  const persisted = writeConnectedApprovalState(resolvedRoot, approval);
  return { approval, approvalPath: persisted.path };
}

export async function confirmProposalConnectedApprovalRequest({
  root,
  requestId,
  approvalId,
  actor,
  reason,
  confirmedAt
}) {
  const resolvedRoot = path.resolve(root);
  const request = readConnectedApprovalRequest({
    root: resolvedRoot,
    requestId,
    at: confirmedAt,
    allowExpired: false
  });
  if (request.batch.$contract !== 'soter://contracts/connected-operation-batch/v2') {
    throw new Error('Proposal approval confirmation requires a pack-compiled connected batch.');
  }
  const lock = readJson(resolveRepoPath(resolvedRoot, request.configuration.lockPath));
  const exact = lockMatchesResolution({ lock, root: resolvedRoot });
  if (!exact.matches
    || fingerprintLock(lock) !== request.configuration.lockFingerprint
    || lock.graphFingerprint !== request.configuration.graphFingerprint
    || lock.host.id !== request.configuration.host) {
    throw new Error('Connected approval confirmation requires the request exact lock to remain current.');
  }
  const run = readJson(resolveRepoPath(resolvedRoot, request.run.path));
  assertConnectedOperationBatchApprovalRequest({
    root: resolvedRoot,
    request,
    lock,
    run,
    at: confirmedAt,
    allowExpired: false
  });
  await assertExactProposalConnectedBatch({
    root: resolvedRoot,
    lockPath: request.configuration.lockPath,
    batch: request.batch,
    changeSet: request.changeSet,
    expectedHost: request.configuration.host
  });
  const review = inspectConnectedApprovalReviewMaterial({ root: resolvedRoot, requestId });
  if (review.configuration.applicability.state !== 'current'
    || review.completeness.state !== 'complete') {
    throw new Error('Connected approval confirmation requires current complete exact private review material.');
  }
  const approval = approveConnectedOperationBatch({
    root: resolvedRoot,
    request,
    id: approvalId,
    actor,
    reason,
    createdAt: confirmedAt
  });
  const persisted = writeConnectedApprovalState(resolvedRoot, approval);
  return { approval, approvalPath: persisted.path };
}

export function reserveApprovalConsumption({ root, approval, checkpointId, at }) {
  const resolvedRoot = path.resolve(root);
  const id = approvalConsumptionId(approval.id);
  if (hasApprovalConsumptionState(resolvedRoot, id)) {
    const existing = readApprovalConsumptionState(resolvedRoot, id).consumption;
    assertApprovalConsumptionDocument(resolvedRoot, existing);
    assertConnectedOperationBatchApproval({
      root: resolvedRoot,
      batch: approval.request.batch,
      changeSet: approval.request.changeSet,
      approval,
      at: existing.createdAt
    });
    const sameScope = existing.request.id === approval.request.id
      && existing.request.fingerprint === approval.request.requestFingerprint
      && existing.approval.id === approval.id
      && existing.approval.fingerprint === connectedApprovalFingerprint(approval)
      && existing.configurationLockFingerprint
        === approval.request.configuration.lockFingerprint
      && existing.runId === approval.request.run.id
      && existing.batchId === approval.request.batch.id
      && existing.batchFingerprint === approval.request.batch.batchFingerprint
      && existing.checkpointId === checkpointId;
    if (!sameScope) {
      throw new Error('Approval consumption id already belongs to different exact work.');
    }
    return { consumption: existing, consumptionPath: null, created: false };
  }
  assertConnectedOperationBatchApproval({
    root: resolvedRoot,
    batch: approval.request.batch,
    changeSet: approval.request.changeSet,
    approval,
    at
  });
  const request = approval.request;
  const consumption = {
    $contract: 'soter://contracts/approval-consumption/v1',
    contractVersion: '1.0.0',
    id,
    createdAt: at,
    updatedAt: at,
    state: 'reserved',
    request: { id: request.id, fingerprint: request.requestFingerprint },
    approval: { id: approval.id, fingerprint: connectedApprovalFingerprint(approval) },
    configurationLockFingerprint: request.configuration.lockFingerprint,
    runId: request.run.id,
    batchId: request.batch.id,
    batchFingerprint: request.batch.batchFingerprint,
    checkpointId,
    checkpointFingerprint: null,
    consumptionFingerprint: fingerprintJson(null)
  };
  consumption.consumptionFingerprint = approvalConsumptionFingerprint(consumption);
  assertApprovalConsumptionDocument(resolvedRoot, consumption);
  try {
    const persisted = createApprovalConsumptionState(resolvedRoot, consumption);
    return { consumption, consumptionPath: persisted.path, created: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = readApprovalConsumptionState(resolvedRoot, id).consumption;
    assertApprovalConsumptionDocument(resolvedRoot, existing);
    const sameScope = existing.request.id === consumption.request.id
      && existing.request.fingerprint === consumption.request.fingerprint
      && existing.approval.id === consumption.approval.id
      && existing.approval.fingerprint === consumption.approval.fingerprint
      && existing.configurationLockFingerprint === consumption.configurationLockFingerprint
      && existing.runId === consumption.runId
      && existing.batchId === consumption.batchId
      && existing.batchFingerprint === consumption.batchFingerprint
      && existing.checkpointId === consumption.checkpointId;
    if (!sameScope) {
      throw new Error('Approval consumption id already belongs to different exact work.');
    }
    return { consumption: existing, consumptionPath: null, created: false };
  }
}

export function completeApprovalConsumption({ root, consumption, checkpoint, at }) {
  const resolvedRoot = path.resolve(root);
  assertApprovalConsumptionDocument(resolvedRoot, consumption);
  if (consumption.state === 'started') {
    if (consumption.checkpointId !== checkpoint.id
      || consumption.checkpointFingerprint !== checkpoint.checkpointFingerprint) {
      throw new Error('Started approval consumption does not match the durable checkpoint.');
    }
    return { consumption, consumptionPath: null };
  }
  if (consumption.state !== 'reserved'
    || consumption.checkpointId !== checkpoint.id
    || consumption.batchId !== checkpoint.batch.id
    || consumption.batchFingerprint !== checkpoint.batch.batchFingerprint
    || consumption.approval.id !== checkpoint.approval.id
    || consumption.approval.fingerprint !== checkpoint.approvalFingerprint) {
    throw new Error('Approval consumption cannot start an unrelated or already consumed checkpoint.');
  }
  const started = {
    ...structuredClone(consumption),
    updatedAt: at,
    state: 'started',
    checkpointFingerprint: checkpoint.checkpointFingerprint,
    consumptionFingerprint: fingerprintJson(null)
  };
  started.consumptionFingerprint = approvalConsumptionFingerprint(started);
  assertApprovalConsumptionDocument(resolvedRoot, started);
  const persisted = writeApprovalConsumptionState(resolvedRoot, started);
  return { consumption: started, consumptionPath: persisted.path };
}
