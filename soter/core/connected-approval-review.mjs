import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { assertConnectedOperationBatchApprovalRequest } from './connected-transactions.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import { fingerprintJson, readJson, resolveRepoPath } from './lib/canonical-json.mjs';
import { fingerprintLock, lockMatchesResolution } from './resolve.mjs';
import {
  hasApprovalRequestState,
  hasContextSnapshotState,
  readApprovalRequestState,
  readContextSnapshotState
} from './runtime-state.mjs';

const CONTRACT = 'soter://contracts/connected-approval-review-material/v1';
const VERSION = '1.0.0';

export const CONNECTED_APPROVAL_REVIEW_REASON_CODES = Object.freeze({
  LOCK_CURRENT: 'LOCK_CURRENT',
  CHECKPOINT_STALE: 'CHECKPOINT_STALE',
  LOCK_APPLICABILITY_UNKNOWN: 'LOCK_APPLICABILITY_UNKNOWN',
  SOURCE_CONTEXT_BOUND: 'SOURCE_CONTEXT_BOUND',
  SOURCE_CONTEXT_UNAVAILABLE: 'SOURCE_CONTEXT_UNAVAILABLE',
  DEDUPLICATION_ABSENCE_REQUIRED: 'DEDUPLICATION_ABSENCE_REQUIRED',
  PRIOR_VALUE_NOT_REQUIRED: 'PRIOR_VALUE_NOT_REQUIRED'
});

function reviewError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(label + ' does not satisfy its contract: '
      + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '));
  }
}

function materialFingerprint(material) {
  const unsigned = structuredClone(material);
  delete unsigned.fingerprint;
  delete unsigned.configuration.applicability;
  return fingerprintJson(unsigned);
}

function operationFingerprint(operation) {
  const unsigned = structuredClone(operation);
  delete unsigned.operationFingerprint;
  return fingerprintJson(unsigned);
}

function applicability(root, request) {
  try {
    const lock = readJson(resolveRepoPath(root, request.configuration.lockPath));
    const current = lockMatchesResolution({ lock, root });
    const exact = current.matches
      && fingerprintLock(lock) === request.configuration.lockFingerprint
      && lock.graphFingerprint === request.configuration.graphFingerprint
      && lock.host.id === request.configuration.host;
    return {
      state: exact ? 'current' : 'stale',
      expectedLockFingerprint: current.expectedFingerprint || null,
      observedLockFingerprint: current.observedFingerprint || null,
      reasonCode: exact
        ? CONNECTED_APPROVAL_REVIEW_REASON_CODES.LOCK_CURRENT
        : CONNECTED_APPROVAL_REVIEW_REASON_CODES.CHECKPOINT_STALE
    };
  } catch {
    return {
      state: 'unknown',
      expectedLockFingerprint: null,
      observedLockFingerprint: null,
      reasonCode: CONNECTED_APPROVAL_REVIEW_REASON_CODES.LOCK_APPLICABILITY_UNKNOWN
    };
  }
}

function basisSnapshot(root, request) {
  const basis = request.changeSet.basis;
  if (!basis || !hasContextSnapshotState(root, basis.contextSnapshotId)) return null;
  let snapshot;
  try {
    snapshot = readContextSnapshotState(root, basis.contextSnapshotId).snapshot;
    validate(root, snapshot, 'soter/contracts/context-snapshot.schema.json', 'Context snapshot');
  } catch (error) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_MALFORMED',
      'The bound private context snapshot does not satisfy its contract.',
      error
    );
  }
  if (snapshot.id !== basis.contextSnapshotId
    || fingerprintJson(snapshot) !== basis.contextSnapshotFingerprint
    || snapshot.runId !== request.run.id
    || snapshot.configurationLockFingerprint !== request.configuration.lockFingerprint
    || snapshot.graphFingerprint !== request.configuration.graphFingerprint) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_BINDING_INVALID',
      'The private context snapshot does not match the exact request, run, lock, and change-set basis.'
    );
  }
  return snapshot;
}

function recordWriteKind(operation) {
  const match = typeof operation?.capability === 'string'
    ? operation.capability.match(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.records\.(create|update)$/)
    : null;
  return match?.[1] || null;
}

function matchingRecord(snapshot, operation) {
  if (!snapshot || recordWriteKind(operation) !== 'update') return null;
  const matches = snapshot.entries.flatMap((entry) => {
    return Array.isArray(entry.value?.records) ? entry.value.records : [];
  }).filter((record) => {
    return record.type === operation.input.recordType && record.id === operation.input.id;
  });
  if (matches.length > 1) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_BINDING_INVALID',
      'The bound context snapshot contains more than one record for an exact update subject.'
    );
  }
  return matches[0] || null;
}

function beforeReview(snapshot, operation) {
  if (recordWriteKind(operation) === 'create') {
    return {
      state: 'absent-required',
      reasonCode: CONNECTED_APPROVAL_REVIEW_REASON_CODES.DEDUPLICATION_ABSENCE_REQUIRED,
      fingerprint: null
    };
  }
  const record = matchingRecord(snapshot, operation);
  if (!record) {
    return {
      state: 'unavailable',
      reasonCode: CONNECTED_APPROVAL_REVIEW_REASON_CODES.SOURCE_CONTEXT_UNAVAILABLE,
      fingerprint: null
    };
  }
  if (record.version !== operation.input.expectedVersion) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_BINDING_INVALID',
      'The bound context record version does not match the exact update precondition.'
    );
  }
  if (!record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_BINDING_INVALID',
      'The bound context record does not expose portable fields for exact private review.'
    );
  }
  const fields = {};
  for (const field of Object.keys(operation.input.patch).sort((left, right) => {
    return left.localeCompare(right, 'en');
  })) {
    if (Object.hasOwn(record.fields, field)) fields[field] = structuredClone(record.fields[field]);
  }
  const reviewValue = {
    recordType: record.type,
    recordId: record.id,
    version: record.version,
    fields
  };
  return {
    state: 'provided',
    reasonCode: CONNECTED_APPROVAL_REVIEW_REASON_CODES.SOURCE_CONTEXT_BOUND,
    fingerprint: fingerprintJson(reviewValue),
    reviewValue
  };
}

function afterReview(operation) {
  const input = operation.input;
  const reviewValue = recordWriteKind(operation) === 'create'
    ? {
        recordType: input.recordType,
        fields: structuredClone(input.fields),
        ...(typeof input.body === 'string' ? { body: input.body } : {})
      }
    : {
        recordType: input.recordType,
        recordId: input.id,
        expectedVersion: input.expectedVersion,
        fields: structuredClone(input.patch)
      };
  return {
    state: 'provided',
    fingerprint: fingerprintJson(reviewValue),
    reviewValue
  };
}

function reviewOperation(source, compiled, snapshot, sequence) {
  const preconditionValue = structuredClone(compiled.precondition);
  const before = beforeReview(snapshot, source);
  const operation = {
    id: source.id,
    sequence,
    capability: source.capability,
    authority: source.authority,
    reason: source.reason,
    changeSetOperationFingerprint: fingerprintJson(source),
    batchOperationFingerprint: fingerprintJson(compiled),
    inputFingerprint: source.inputFingerprint,
    subject: {
      kind: 'portable-resource',
      type: source.input.recordType,
      id: recordWriteKind(source) === 'update' ? source.input.id : null
    },
    before,
    after: afterReview(source),
    precondition: {
      fingerprint: fingerprintJson(preconditionValue),
      reviewValue: preconditionValue
    },
    verification: {
      kind: compiled.verification.kind,
      expectedFingerprint: compiled.verification.expectedFieldsFingerprint,
      contentFingerprint: compiled.contentVerification
        ? fingerprintJson(compiled.contentVerification)
        : null
    },
    recovery: structuredClone(compiled.recovery),
    operationFingerprint: fingerprintJson(null)
  };
  operation.operationFingerprint = operationFingerprint(operation);
  return operation;
}

function compiledReviewOperation(source, compiled, sequence) {
  if (!compiled
    || source.id !== compiled.id
    || source.sourceActionId !== compiled.sourceActionId
    || source.capability !== compiled.capability
    || source.authority !== compiled.authority
    || source.inputFingerprint !== compiled.inputFingerprint
    || fingerprintJson(source.input) !== fingerprintJson(compiled.input)) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_BINDING_INVALID',
      'The selected approval request does not preserve one exact change-set to pack-compiled operation join.'
    );
  }
  const operation = {
    id: source.id,
    sequence,
    capability: source.capability,
    authority: source.authority,
    reason: source.reason,
    changeSetOperationFingerprint: fingerprintJson(source),
    batchOperationFingerprint: fingerprintJson(compiled),
    inputFingerprint: source.inputFingerprint,
    subject: structuredClone(compiled.review.subject),
    before: compiled.review.before.state === 'provided'
      ? {
          ...structuredClone(compiled.review.before),
          reasonCode: CONNECTED_APPROVAL_REVIEW_REASON_CODES.SOURCE_CONTEXT_BOUND
        }
      : structuredClone(compiled.review.before),
    after: structuredClone(compiled.review.after),
    precondition: structuredClone(compiled.review.precondition),
    verification: {
      kind: compiled.verification.expectation.kind,
      expectedFingerprint: compiled.verification.expectation.expectedFingerprint,
      contentFingerprint: null
    },
    recovery: {
      mode: compiled.recovery.mode,
      reason: compiled.recovery.reasonCode
    },
    operationFingerprint: fingerprintJson(null)
  };
  operation.operationFingerprint = operationFingerprint(operation);
  return operation;
}

function createMaterial(root, request) {
  const packCompiled = request.batch.$contract
    === 'soter://contracts/connected-operation-batch/v2';
  const snapshot = packCompiled ? null : basisSnapshot(root, request);
  const operations = request.changeSet.operations.map((source, index) => {
    const compiled = request.batch.operations[index];
    if (packCompiled) return compiledReviewOperation(source, compiled, index + 1);
    if (!compiled
      || source.id !== compiled.id
      || source.capability !== compiled.capability
      || source.authority !== compiled.authority
      || source.inputFingerprint !== compiled.inputFingerprint
      || fingerprintJson(source.input) !== fingerprintJson(compiled.input)) {
      throw reviewError(
        'CONNECTED_APPROVAL_REVIEW_MATERIAL_BINDING_INVALID',
        'The selected approval request does not preserve one exact change-set to batch operation join.'
      );
    }
    return reviewOperation(source, compiled, snapshot, index + 1);
  });
  const incomplete = operations.some((operation) => operation.before.state === 'unavailable');
  const material = {
    $contract: CONTRACT,
    contractVersion: VERSION,
    fingerprint: fingerprintJson(null),
    request: {
      id: request.id,
      fingerprint: request.requestFingerprint,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      reason: request.reason
    },
    configuration: {
      path: request.configuration.path,
      lockPath: request.configuration.lockPath,
      lockFingerprint: request.configuration.lockFingerprint,
      graphFingerprint: request.configuration.graphFingerprint,
      host: request.configuration.host,
      applicability: applicability(root, request)
    },
    run: {
      id: request.run.id,
      fingerprint: request.run.fingerprint
    },
    changeSet: {
      id: request.changeSet.id,
      documentFingerprint: request.changeSetFingerprint,
      scopeFingerprint: request.changeSet.scopeFingerprint
    },
    batch: {
      id: request.batch.id,
      documentFingerprint: request.batchFingerprint,
      scopeFingerprint: request.batch.batchFingerprint
    },
    effects: structuredClone(request.scope.effects),
    completeness: {
      state: incomplete ? 'incomplete' : 'complete',
      reasonCodes: incomplete
        ? [CONNECTED_APPROVAL_REVIEW_REASON_CODES.SOURCE_CONTEXT_UNAVAILABLE]
        : []
    },
    operations,
    privacy: {
      scope: 'private-local-approval-review',
      authority: 'none',
      projection: 'selected-activity-only',
      providerArgumentsIncluded: false,
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsIncluded: false,
      approvalAuthorityIncluded: false,
      continuationAuthorityIncluded: false
    }
  };
  if (containsCredentialMaterial(material.operations)) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_CREDENTIAL_REJECTED',
      'Connected approval review material cannot contain credential material.'
    );
  }
  material.fingerprint = materialFingerprint(material);
  return material;
}

function loadRequest(root, requestId) {
  let exists;
  try {
    exists = hasApprovalRequestState(root, requestId);
  } catch (error) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_MALFORMED',
      'The selected approval request identifier is invalid.',
      error
    );
  }
  if (!exists) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_MISSING',
      'The selected connected approval request does not exist in private local state.'
    );
  }
  let request;
  try {
    request = readApprovalRequestState(root, requestId).request;
  } catch (error) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_MALFORMED',
      'The selected connected approval request is not readable private JSON.',
      error
    );
  }
  try {
    assertConnectedOperationBatchApprovalRequest({
      root,
      request,
      at: request.createdAt,
      allowExpired: true
    });
  } catch (error) {
    const code = error.message.includes('does not satisfy its contract')
      ? 'CONNECTED_APPROVAL_REVIEW_MATERIAL_MALFORMED'
      : 'CONNECTED_APPROVAL_REVIEW_MATERIAL_TAMPERED';
    throw reviewError(
      code,
      'The selected connected approval request is malformed, stale, or fingerprint-invalid.',
      error
    );
  }
  return request;
}

export function assertConnectedApprovalReviewMaterial(root, material, request) {
  const resolvedRoot = path.resolve(root);
  try {
    validate(
      resolvedRoot,
      material,
      'soter/contracts/connected-approval-review-material.schema.json',
      'Connected approval review material'
    );
  } catch (error) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_MALFORMED',
      'Connected approval review material does not satisfy its private contract.',
      error
    );
  }
  if (material.fingerprint !== materialFingerprint(material)
    || material.operations.some((operation) => {
      return operation.operationFingerprint !== operationFingerprint(operation)
        || operation.after.fingerprint !== fingerprintJson(operation.after.reviewValue)
        || operation.precondition.fingerprint
          !== fingerprintJson(operation.precondition.reviewValue)
        || (operation.before.state === 'provided'
          && operation.before.fingerprint !== fingerprintJson(operation.before.reviewValue));
    })) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_TAMPERED',
      'Connected approval review material fingerprints do not match its private values.'
    );
  }
  if (containsCredentialMaterial(material.operations)) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_CREDENTIAL_REJECTED',
      'Connected approval review material cannot contain credential material.'
    );
  }
  const expected = createMaterial(resolvedRoot, request);
  if (fingerprintJson(material) !== fingerprintJson(expected)) {
    throw reviewError(
      'CONNECTED_APPROVAL_REVIEW_MATERIAL_BINDING_INVALID',
      'Connected approval review material does not match the exact request, lock, change set, batch, and private context basis.'
    );
  }
  return material;
}

export function inspectConnectedApprovalReviewMaterial({ root, requestId }) {
  const resolvedRoot = path.resolve(root);
  const request = loadRequest(resolvedRoot, requestId);
  const material = createMaterial(resolvedRoot, request);
  return assertConnectedApprovalReviewMaterial(resolvedRoot, material, request);
}
