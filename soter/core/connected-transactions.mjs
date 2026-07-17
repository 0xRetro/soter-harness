import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { listProviderDeclarations } from './capabilities.mjs';
import { loadProviderMappings } from './host-runtime.mjs';
import { fingerprintJson, readJson } from './lib/canonical-json.mjs';
import { fingerprintLock } from './resolve.mjs';
import { changeSetScopeFingerprint } from './transaction.mjs';
import { assertContextRecordInput } from './context-records.mjs';
import { assertProposalConnectedBatch } from './proposal-connected-batches.mjs';

const CONNECTED_BATCH_V2 = 'soter://contracts/connected-operation-batch/v2';

function isPackCompiledBatch(batch) {
  return batch?.$contract === CONNECTED_BATCH_V2;
}

function assertAnyConnectedOperationBatch({ root, batch, changeSet }) {
  if (isPackCompiledBatch(batch)) {
    assertProposalConnectedBatch({ root, batch, changeSet });
    return true;
  }
  return assertConnectedOperationBatch({ root, batch, changeSet });
}

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(label + ' does not satisfy its contract: '
      + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; '));
  }
}

function selectedProvider(root, lock, operation) {
  const binding = lock.bindings.find((item) => item.capability === operation.capability);
  if (!binding || !binding.authorities.includes(operation.authority)) {
    throw new Error(operation.id + ' is outside the exact resolved capability and authority binding.');
  }
  const providers = listProviderDeclarations(root).filter((provider) => {
    return provider.containment === 'connected'
      && provider.pack === binding.providerPack
      && provider.capabilities.some((item) => {
        return item.id === operation.capability && item.version === binding.capabilityVersion;
      });
  });
  if (providers.length !== 1) {
    throw new Error(operation.id + ' requires exactly one connected implementation of '
      + operation.capability + '; found ' + providers.length + '.');
  }
  return providers[0];
}

function recordMapping(root, provider, operation) {
  const mappings = loadProviderMappings(root, provider);
  const candidates = mappings.filter((mapping) => {
    return mapping.capabilities?.includes(operation.capability)
      && mapping.recordTypes?.some((record) => {
        return record.id === operation.input.recordType
          && record.capabilities?.includes(operation.capability);
      });
  });
  if (candidates.length !== 1) {
    throw new Error(operation.id + ' has no unique connected mapping for '
      + operation.input.recordType + '/' + operation.capability + '.');
  }
  const mapping = candidates[0];
  return {
    mapping,
    definition: mapping.recordTypes.find((record) => {
      return record.id === operation.input.recordType
        && record.capabilities.includes(operation.capability);
    })
  };
}

function assertMappedFields(operation, definition, values, label) {
  const mapped = new Set(definition.fields.map((field) => field.portable));
  const unknown = Object.keys(values).filter((field) => !mapped.has(field));
  if (unknown.length) {
    throw new Error(operation.id + ' cannot compile for connected execution: '
      + label + ' field(s) are not mapped for ' + definition.id + ': '
      + unknown.sort().join(', ') + '.');
  }
}

function compileOperation(root, lock, operation, sequence) {
  if (operation.inputFingerprint !== fingerprintJson(operation.input)) {
    throw new Error(operation.id + ' input fingerprint is stale.');
  }
  const provider = selectedProvider(root, lock, operation);
  const selectedMapping = recordMapping(root, provider, operation);
  const definition = selectedMapping.definition;
  const input = structuredClone(operation.input);
  assertContextRecordInput(root, operation.capability, input, {
    modelId: selectedMapping.mapping.contextModel,
    packIds: lock.packs.filter((pack) => pack.layer === 'context').map((pack) => pack.id)
  });
  let precondition;
  let verificationId;
  let expectedFields;
  let contentVerification = null;
  let recovery;
  if (operation.capability === 'crm.records.create') {
    assertMappedFields(operation, definition, input.fields, 'create');
    const readBinding = lock.bindings.find((binding) => {
      return binding.capability === 'crm.records.read'
        && binding.providerPack === provider.pack
        && binding.authorities.includes(operation.authority);
    });
    if (!definition.capabilities.includes('crm.records.read')
      || !readBinding
      || !provider.capabilities.some((capability) => {
        return capability.id === 'crm.records.read'
          && capability.version === readBinding.capabilityVersion;
      })) {
      throw new Error(
        operation.id + ' has no exact same-provider record-read verification route under '
          + operation.authority + '.'
      );
    }
    const filter = input.deduplicationFilter;
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)
      || typeof filter.field !== 'string' || typeof filter.value !== 'string'
      || input.deduplicationKey !== filter.value
      || input.fields[filter.field] !== filter.value) {
      throw new Error(operation.id + ' requires deduplicationFilter.field/value to name '
        + 'one mapped field whose value exactly equals deduplicationKey.');
    }
    assertMappedFields(operation, definition, { [filter.field]: filter.value }, 'deduplication');
    precondition = {
      kind: 'deduplication-absent',
      readInput: {
        recordTypes: [input.recordType],
        filters: { [filter.field]: filter.value },
        limit: 2
      },
      expectedVersion: null,
      expectedCount: 0
    };
    verificationId = null;
    expectedFields = input.fields;
    if (typeof input.body === 'string') {
      const contentBinding = lock.bindings.find((binding) => {
        return binding.capability === 'documents.content.read'
          && binding.providerPack === provider.pack
          && binding.authorities.includes(operation.authority);
      });
      if (!contentBinding
        || !provider.capabilities.some((capability) => {
          return capability.id === 'documents.content.read'
            && capability.version === contentBinding.capabilityVersion;
        })) {
        throw new Error(
          operation.id + ' has no exact same-provider content-read route under '
            + operation.authority + '.'
        );
      }
      contentVerification = {
        kind: 'exact-document-content',
        capability: 'documents.content.read',
        expectedTitle: input.fields.title,
        expectedBodyFingerprint: fingerprintJson(input.body)
      };
    }
    recovery = {
      mode: 'terminal-idempotent-create',
      reason: 'This deduplicated create may execute only as the final batch effect; ambiguity is reconciled by exact record and content reads rather than deletion or replay.'
    };
  } else {
    assertMappedFields(operation, definition, input.patch, 'update');
    precondition = {
      kind: 'expected-version',
      readInput: { recordTypes: [input.recordType], ids: [input.id], limit: 1 },
      expectedVersion: input.expectedVersion,
      expectedCount: 1
    };
    verificationId = input.id;
    expectedFields = input.patch;
    recovery = {
      mode: 'restore-prior-fields',
      reason: 'Core must retain the compared prior mapped fields and restore them in reverse order after a later failure.'
    };
  }
  return {
    id: operation.id,
    sequence,
    capability: operation.capability,
    authority: operation.authority,
    provider: {
      pack: provider.pack,
      implementation: provider.id,
      version: provider.version
    },
    input,
    inputFingerprint: operation.inputFingerprint,
    precondition,
    verification: {
      kind: 'record-fields-match',
      recordType: input.recordType,
      recordId: verificationId,
      expectedFieldsFingerprint: fingerprintJson(expectedFields)
    },
    contentVerification,
    recovery
  };
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
  if (isPackCompiledBatch(batch)) {
    validate(resolvedRoot, batch, 'soter/contracts/connected-operation-batch-v2.schema.json', 'Connected operation batch');
    validate(resolvedRoot, changeSet, 'soter/contracts/connected-change-set-v2.schema.json', 'Change set');
  } else {
    validate(resolvedRoot, batch, 'soter/contracts/connected-operation-batch.schema.json', 'Connected operation batch');
    validate(resolvedRoot, changeSet, 'soter/contracts/change-set.schema.json', 'Change set');
  }
  assertAnyConnectedOperationBatch({ root: resolvedRoot, batch, changeSet });
  const createdAt = Date.parse(request.createdAt);
  const expiresAt = Date.parse(request.expiresAt);
  const observedAt = Date.parse(at);
  if (request.requestFingerprint !== approvalRequestFingerprint(request)
    || request.batchFingerprint !== fingerprintJson(batch)
    || request.changeSetFingerprint !== fingerprintJson(changeSet)
    || fingerprintJson(request.batch) !== fingerprintJson(batch)
    || fingerprintJson(request.changeSet) !== fingerprintJson(changeSet)
    || request.run.id !== batch.runId
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
  if (lock && (request.configuration.path !== lock.configuration.path
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

export function createConnectedOperationBatchApprovalRequest({
  root,
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
}) {
  const resolvedRoot = path.resolve(root);
  validate(resolvedRoot, batch, 'soter/contracts/connected-operation-batch.schema.json', 'Connected operation batch');
  validate(resolvedRoot, changeSet, 'soter/contracts/change-set.schema.json', 'Change set');
  assertConnectedOperationBatch({ root: resolvedRoot, batch, changeSet });
  const expectedBatch = compileConnectedOperationBatch({
    root: resolvedRoot,
    lock,
    changeSet,
    id: batch.id,
    createdAt: batch.createdAt
  });
  if (batch.runId !== run.id
    || batch.configurationLockFingerprint !== fingerprintLock(lock)
    || batch.changeSet.id !== changeSet.id
    || batch.changeSet.scopeFingerprint !== changeSetScopeFingerprint(changeSet)
    || fingerprintJson(batch) !== fingerprintJson(expectedBatch)) {
    throw new Error('Connected approval request sources do not match one exact lock, run, batch, and change set.');
  }
  return createBoundConnectedApprovalRequest({
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
}

export function createBoundConnectedApprovalRequest({
  root,
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
}) {
  const resolvedRoot = path.resolve(root);
  assertAnyConnectedOperationBatch({ root: resolvedRoot, batch, changeSet });
  const request = {
    $contract: 'soter://contracts/approval-request/v1',
    contractVersion: '1.0.0',
    id,
    createdAt,
    expiresAt,
    configuration: {
      path: lock.configuration.path,
      lockPath,
      lockFingerprint: fingerprintLock(lock),
      graphFingerprint: lock.graphFingerprint,
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

function compiledOperationMatchesInput(operation) {
  const input = operation.input;
  const create = operation.capability === 'crm.records.create';
  const expectedFields = create ? input.fields : input.patch;
  if (!expectedFields
    || operation.inputFingerprint !== fingerprintJson(input)
    || operation.verification.kind !== 'record-fields-match'
    || operation.verification.recordType !== input.recordType
    || operation.verification.recordId !== (create ? null : input.id)
    || operation.verification.expectedFieldsFingerprint !== fingerprintJson(expectedFields)) {
    return false;
  }
  if (create) {
    const filter = input.deduplicationFilter;
    const expectedReadInput = filter && typeof filter.field === 'string'
      ? {
          recordTypes: [input.recordType],
          filters: { [filter.field]: filter.value },
          limit: 2
        }
      : null;
    const expectedContent = typeof input.body === 'string'
      ? {
          kind: 'exact-document-content',
          capability: 'documents.content.read',
          expectedTitle: input.fields.title,
          expectedBodyFingerprint: fingerprintJson(input.body)
        }
      : null;
    return operation.precondition.kind === 'deduplication-absent'
      && operation.precondition.expectedVersion === null
      && operation.precondition.expectedCount === 0
      && fingerprintJson(operation.precondition.readInput)
        === fingerprintJson(expectedReadInput)
      && fingerprintJson(operation.contentVerification) === fingerprintJson(expectedContent)
      && operation.recovery.mode === 'terminal-idempotent-create';
  }
  return operation.precondition.kind === 'expected-version'
    && operation.precondition.expectedVersion === input.expectedVersion
    && operation.precondition.expectedCount === 1
    && fingerprintJson(operation.precondition.readInput) === fingerprintJson({
      recordTypes: [input.recordType],
      ids: [input.id],
      limit: 1
    })
    && operation.contentVerification === null
    && operation.recovery.mode === 'restore-prior-fields';
}

export function assertConnectedOperationBatch({ root, batch, changeSet }) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    batch,
    'soter/contracts/connected-operation-batch.schema.json',
    'Connected operation batch'
  );
  validate(resolvedRoot, changeSet, 'soter/contracts/change-set.schema.json', 'Change set');
  const operationIds = batch.operations.map((operation) => operation.id);
  if (!batch.executable
    || batch.state !== 'proposed'
    || batch.blockers.length
    || batch.batchFingerprint !== batchFingerprint(batch)
    || new Set(operationIds).size !== operationIds.length
    || batch.operations.some((operation, index) => {
      return operation.sequence !== index + 1 || !compiledOperationMatchesInput(operation);
    })
    || batch.operations.length !== changeSet.operations.length
    || batch.operations.some((operation, index) => {
      const source = changeSet.operations[index];
      return !source
        || operation.id !== source.id
        || operation.capability !== source.capability
        || operation.authority !== source.authority
        || operation.inputFingerprint !== source.inputFingerprint
        || fingerprintJson(operation.input) !== fingerprintJson(source.input);
    })
    || changeSet.state !== 'proposed'
    || batch.runId !== changeSet.runId
    || batch.configurationLockFingerprint !== changeSet.configurationLockFingerprint
    || batch.changeSet.id !== changeSet.id
    || batch.changeSet.scopeFingerprint !== changeSetScopeFingerprint(changeSet)) {
    throw new Error(
      'Connected operation batch does not match one exact executable proposed change set.'
    );
  }
  return true;
}

export function assertConnectedOperationBatchApproval({ root, batch, changeSet, approval, at, allowExpired = false }) {
  const resolvedRoot = path.resolve(root);
  if (isPackCompiledBatch(batch)) {
    validate(resolvedRoot, batch, 'soter/contracts/connected-operation-batch-v2.schema.json', 'Connected operation batch');
    validate(resolvedRoot, changeSet, 'soter/contracts/connected-change-set-v2.schema.json', 'Change set');
  } else {
    validate(resolvedRoot, batch, 'soter/contracts/connected-operation-batch.schema.json', 'Connected operation batch');
    validate(resolvedRoot, changeSet, 'soter/contracts/change-set.schema.json', 'Change set');
  }
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
  assertAnyConnectedOperationBatch({ root: resolvedRoot, batch, changeSet });
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

export function compileConnectedOperationBatch({ root, lock, changeSet, id, createdAt }) {
  const resolvedRoot = path.resolve(root);
  validate(resolvedRoot, changeSet, 'soter/contracts/change-set.schema.json', 'Change set');
  if (changeSet.state !== 'proposed'
    || changeSet.configurationLockFingerprint !== fingerprintLock(lock)
    || changeSet.scopeFingerprint !== changeSetScopeFingerprint(changeSet)) {
    throw new Error('Connected operation batch requires an exact proposed change set for the current lock.');
  }
  const operations = changeSet.operations.map((operation, index) => {
    return compileOperation(resolvedRoot, lock, operation, index + 1);
  });
  const terminalCreates = operations.filter((operation) => {
    return operation.recovery.mode === 'terminal-idempotent-create';
  });
  const blockers = operations.filter((operation) => {
    return operation.recovery.mode === 'manual-required';
  }).map((operation) => operation.id + ' has no automatic compensation route.');
  if (terminalCreates.length > 1) {
    blockers.push('A connected batch may contain at most one terminal idempotent create.');
  }
  for (const operation of terminalCreates) {
    if (operation.sequence !== operations.length) {
      blockers.push(operation.id + ' must be the final operation because it has no delete compensation.');
    }
    if (typeof operation.input.body === 'string' && !operation.contentVerification) {
      blockers.push(operation.id + ' requires exact post-create content verification.');
    }
  }
  const batch = {
    $contract: 'soter://contracts/connected-operation-batch/v1',
    contractVersion: '1.0.0',
    id,
    runId: changeSet.runId,
    createdAt,
    configurationLockFingerprint: fingerprintLock(lock),
    changeSet: { id: changeSet.id, scopeFingerprint: changeSet.scopeFingerprint },
    state: blockers.length ? 'blocked' : 'proposed',
    executable: blockers.length === 0,
    blockers,
    operations,
    batchFingerprint: fingerprintJson(null)
  };
  batch.batchFingerprint = batchFingerprint(batch);
  validate(
    resolvedRoot,
    batch,
    'soter/contracts/connected-operation-batch.schema.json',
    'Connected operation batch'
  );
  return batch;
}

export function approveConnectedOperationBatch({ root, request, batch = request?.batch, changeSet = request?.changeSet, id, actor, reason, createdAt }) {
  const resolvedRoot = path.resolve(root);
  if (isPackCompiledBatch(batch)) {
    validate(resolvedRoot, batch, 'soter/contracts/connected-operation-batch-v2.schema.json', 'Connected operation batch');
    validate(resolvedRoot, changeSet, 'soter/contracts/connected-change-set-v2.schema.json', 'Change set');
  } else {
    validate(resolvedRoot, batch, 'soter/contracts/connected-operation-batch.schema.json', 'Connected operation batch');
    validate(resolvedRoot, changeSet, 'soter/contracts/change-set.schema.json', 'Change set');
  }
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
