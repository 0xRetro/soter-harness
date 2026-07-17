import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { assertConnectedTransactionCheckpoint } from './connected-transaction-runtime.mjs';
import { assertVerifiedConnectedTransactionCheckpoint } from './verified-connected-transaction-runtime.mjs';
import { connectedApprovalFingerprint } from './connected-transactions.mjs';
import { fingerprintJson, readJson, resolveRepoPath } from './lib/canonical-json.mjs';
import {
  approvalConsumptionId,
  assertApprovalConsumptionDocument,
  readConnectedApproval,
  readConnectedApprovalRequest
} from './operator-authority.mjs';
import { fingerprintLock, lockMatchesResolution } from './resolve.mjs';
import {
  hasApprovalConsumptionState,
  listConnectedApprovalDocuments,
  readApprovalConsumptionState,
  readHostCallCheckpoint
} from './runtime-state.mjs';

export const OPERATOR_REASON_CODES = Object.freeze({
  AUTHORITY_PERMISSION_MISSING: 'AUTHORITY_PERMISSION_MISSING',
  REQUIRED_INPUT_MISSING: 'REQUIRED_INPUT_MISSING',
  CHECKPOINT_STALE: 'CHECKPOINT_STALE',
  READ_AFTER_WRITE_MISMATCH: 'READ_AFTER_WRITE_MISMATCH',
  COMPENSATION_FAILED: 'COMPENSATION_FAILED',
  APPROVAL_REQUEST_EXPIRED: 'APPROVAL_REQUEST_EXPIRED',
  APPROVAL_REQUEST_PENDING: 'APPROVAL_REQUEST_PENDING',
  APPROVAL_CONFIRMED_NOT_STARTED: 'APPROVAL_CONFIRMED_NOT_STARTED',
  APPROVAL_CONSUMPTION_RESERVED: 'APPROVAL_CONSUMPTION_RESERVED',
  APPROVAL_CONSUMED: 'APPROVAL_CONSUMED',
  CURRENT_CALL_PENDING: 'CURRENT_CALL_PENDING',
  RECONCILIATION_AVAILABLE: 'RECONCILIATION_AVAILABLE',
  RECONCILIATION_IN_PROGRESS: 'RECONCILIATION_IN_PROGRESS',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  TRANSACTION_COMPLETED: 'TRANSACTION_COMPLETED',
  TRANSACTION_ROLLED_BACK: 'TRANSACTION_ROLLED_BACK',
  CHECKPOINT_MISSING: 'CHECKPOINT_MISSING',
  LOCK_APPLICABILITY_UNKNOWN: 'LOCK_APPLICABILITY_UNKNOWN',
  LOCK_CURRENT: 'LOCK_CURRENT',
  RESUME_DECISION_UNAVAILABLE: 'RESUME_DECISION_UNAVAILABLE',
  VERIFICATION_PENDING: 'VERIFICATION_PENDING',
  VERIFICATION_PASSED: 'VERIFICATION_PASSED',
  FAMILY_NOT_EVALUATED_BY_OPERATOR_INSPECTION:
    'FAMILY_NOT_EVALUATED_BY_OPERATOR_INSPECTION'
});

function validate(root, value) {
  const failures = validateJsonSchema(
    value,
    readJson(path.join(root, 'soter/contracts/operator-inspection.schema.json'))
  );
  if (failures.length) {
    throw new Error('Operator inspection does not satisfy its contract: '
      + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '));
  }
}

function inspectionFingerprint(inspection) {
  const value = structuredClone(inspection);
  delete value.inspectionFingerprint;
  return fingerprintJson(value);
}

export function assertOperatorInspection(root, inspection) {
  const resolvedRoot = path.resolve(root);
  validate(resolvedRoot, inspection);
  if (inspection.inspectionFingerprint !== inspectionFingerprint(inspection)) {
    throw new Error('Operator inspection fingerprint is stale.');
  }
  return inspection;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => {
    return left.localeCompare(right, 'en');
  });
}

function approvalForRequest(root, requestId, observedAt) {
  const matches = listConnectedApprovalDocuments(root)
    .filter(({ approval }) => approval.request?.id === requestId);
  if (matches.length > 1) {
    throw new Error('Approval request has more than one durable approval decision.');
  }
  return matches.length
    ? readConnectedApproval({
        root,
        approvalId: matches[0].approval.id,
        at: observedAt,
        allowExpired: true
      })
    : null;
}

function loadSources({ root, requestId, approvalId, checkpointId, observedAt }) {
  let checkpoint = null;
  let approval = null;
  let request = null;
  if (checkpointId) {
    checkpoint = readHostCallCheckpoint(root, checkpointId).checkpoint;
    if (checkpoint.$contract === 'soter://contracts/connected-transaction-checkpoint/v2') {
      assertVerifiedConnectedTransactionCheckpoint(root, checkpoint);
    } else {
      assertConnectedTransactionCheckpoint(root, checkpoint);
    }
    approval = checkpoint.approval;
    request = approval.request;
  }
  if (approvalId) {
    const supplied = readConnectedApproval({ root, approvalId, at: observedAt, allowExpired: true });
    if (approval && fingerprintJson(supplied) !== fingerprintJson(approval)) {
      throw new Error('Operator inspection approval does not match its checkpoint.');
    }
    approval = supplied;
    request = supplied.request;
  }
  if (requestId) {
    const supplied = readConnectedApprovalRequest({
      root,
      requestId,
      at: observedAt,
      allowExpired: true
    });
    if (request && fingerprintJson(supplied) !== fingerprintJson(request)) {
      throw new Error('Operator inspection request does not match its approval or checkpoint.');
    }
    request = supplied;
  }
  if (!request) throw new Error('Operator inspection requires a request, approval, or checkpoint id.');
  if (!approval) approval = approvalForRequest(root, request.id, observedAt);
  let consumption = null;
  if (approval) {
    const id = approvalConsumptionId(approval.id);
    if (hasApprovalConsumptionState(root, id)) {
      consumption = readApprovalConsumptionState(root, id).consumption;
      assertApprovalConsumptionDocument(root, consumption);
    }
  }
  return { request, approval, consumption, checkpoint };
}

function configurationFacts(root, request) {
  let lock = null;
  let current = null;
  try {
    lock = readJson(resolveRepoPath(root, request.configuration.lockPath));
    current = lockMatchesResolution({ lock, root });
  } catch {
    // The projection reports unknown applicability without widening authority.
  }
  const state = current
    ? current.matches && fingerprintLock(lock) === request.configuration.lockFingerprint
      ? 'current'
      : 'stale'
    : 'unknown';
  return {
    name: lock?.configuration?.name || null,
    path: request.configuration.path,
    lockPath: request.configuration.lockPath,
    lockFingerprint: request.configuration.lockFingerprint,
    graphFingerprint: request.configuration.graphFingerprint,
    host: request.configuration.host,
    applicability: {
      state,
      expectedLockFingerprint: current?.expectedFingerprint || null,
      observedLockFingerprint: current?.observedFingerprint || null,
      reasonCode: state === 'current'
        ? OPERATOR_REASON_CODES.LOCK_CURRENT
        : state === 'stale'
          ? OPERATOR_REASON_CODES.CHECKPOINT_STALE
          : OPERATOR_REASON_CODES.LOCK_APPLICABILITY_UNKNOWN
    }
  };
}

function runtimeStepState(operation) {
  if (!operation) return 'pending';
  if (operation.state === 'applied') return 'applied';
  if (operation.state === 'failed') return 'failed';
  if (operation.state === 'needs-attention') return 'needs-attention';
  if (operation.state === 'compensated') return 'compensated';
  if (['compensating', 'compensation-verifying'].includes(operation.state)) {
    return 'compensating';
  }
  return operation.state === 'pending' ? 'pending' : 'current';
}

function capabilityFacts(request, checkpoint) {
  const runtime = new Map((checkpoint?.operations || []).map((operation) => {
    return [operation.id, operation];
  }));
  const steps = request.batch.operations.map((operation) => ({
    id: operation.id,
    sequence: operation.sequence,
    capability: operation.capability,
    authority: operation.authority,
    effects: ['write'],
    state: runtimeStepState(runtime.get(operation.id))
  }));
  const completedPrefix = [];
  for (const step of steps) {
    if (!['applied', 'compensated'].includes(step.state)) break;
    completedPrefix.push(step.id);
  }
  return {
    steps,
    completedPrefix,
    current: checkpoint?.current
      ? {
          stepId: checkpoint.current.operationId,
          stage: checkpoint.current.stage,
          callId: checkpoint.current.callId,
          reconciliationId: checkpoint.current.reconciliationId
        }
      : null,
    pending: steps.filter((step) => step.state === 'pending').map((step) => step.id)
  };
}

function verificationCriterion(operation, name, stage) {
  const phase = operation?.[name] || null;
  const ambiguity = Array.isArray(operation?.ambiguities)
    ? operation.ambiguities.find((item) => item.stage === stage) || null
    : operation?.ambiguity?.stage === stage ? operation.ambiguity : null;
  const reconciledPassed = ambiguity?.status === 'resolved'
    && ambiguity.resolution === 'expected-state';
  const failed = Boolean((ambiguity && !reconciledPassed)
    || (operation?.error && phase));
  const state = reconciledPassed || (operation?.state === 'applied'
    && operation?.observedFingerprint) ? 'passed'
    : failed ? 'failed'
    : phase?.call?.state === 'requested' ? 'running'
      : phase?.call?.state === 'completed' ? 'passed'
        : phase?.call && ['failed', 'blocked'].includes(phase.call.state) ? 'failed'
          : 'pending';
  return {
    state,
    reasonCode: state === 'failed'
      ? OPERATOR_REASON_CODES.READ_AFTER_WRITE_MISMATCH
      : state === 'passed'
        ? OPERATOR_REASON_CODES.VERIFICATION_PASSED
        : OPERATOR_REASON_CODES.VERIFICATION_PENDING,
    observedFingerprint: operation?.observedFingerprint || phase?.outputFingerprint || null
  };
}

function verificationFacts(request, checkpoint) {
  const runtime = new Map((checkpoint?.operations || []).map((operation) => {
    return [operation.id, operation];
  }));
  const criteria = request.batch.operations.flatMap((source) => {
    const operation = runtime.get(source.id);
    const records = [{
      id: 'verification.' + source.id + '.record',
      ...verificationCriterion(operation, 'verification', 'verify')
    }];
    if (source.contentVerification) {
      records.push({
        id: 'verification.' + source.id + '.content',
        ...verificationCriterion(operation, 'contentVerification', 'content-verify')
      });
    }
    return records;
  });
  const state = criteria.some((item) => item.state === 'failed') ? 'failed'
    : criteria.length && criteria.every((item) => item.state === 'passed') ? 'verified'
      : criteria.some((item) => item.state === 'running') ? 'running'
        : checkpoint ? 'unknown' : 'not-started';
  const observed = criteria.map((item) => item.observedFingerprint).filter(Boolean);
  return {
    state,
    criteria,
    observedFingerprint: observed.length ? fingerprintJson(observed) : null
  };
}

function compensationFacts(request, checkpoint) {
  const plan = request.batch.operations.map((operation) => ({
    stepId: operation.id,
    mode: operation.recovery.mode
  }));
  if (request.batch.$contract === 'soter://contracts/connected-operation-batch/v2') {
    return {
      state: 'not-required',
      plan,
      completedStepIds: [],
      remainingStepIds: [],
      restoredFingerprint: null
    };
  }
  if (!checkpoint) {
    return { state: 'not-required', plan, completedStepIds: [], remainingStepIds: [], restoredFingerprint: null };
  }
  const eligible = checkpoint.operations.filter((operation) => operation.priorFields !== null);
  const completed = eligible.filter((operation) => operation.state === 'compensated');
  const compensating = eligible.some((operation) => {
    return ['compensating', 'compensation-verifying'].includes(operation.state);
  });
  const failed = checkpoint.operations.some((operation) => {
    return operation.ambiguities.some((item) => {
      return ['compensate', 'compensation-verify'].includes(item.stage)
        && item.status === 'unresolved';
    });
  });
  const touched = eligible.some((operation) => {
    return operation.compensation || operation.compensationVerification
      || operation.state === 'compensated';
  });
  const state = checkpoint.state === 'rolled-back' ? 'verified'
    : failed ? 'failed'
      : compensating ? 'running'
        : touched ? 'pending'
          : 'not-required';
  return {
    state,
    plan,
    completedStepIds: completed.map((operation) => operation.id),
    remainingStepIds: ['pending', 'running', 'failed'].includes(state)
      ? eligible.filter((operation) => operation.state !== 'compensated').map((operation) => operation.id)
      : [],
    restoredFingerprint: completed.length
      ? fingerprintJson(completed.map((operation) => ({
          id: operation.id,
          priorFields: operation.priorFields
        })))
      : null
  };
}

function checkpointHasVerificationFailure(checkpoint) {
  return Boolean(checkpoint?.operations.some((operation) => {
    const ambiguities = Array.isArray(operation.ambiguities)
      ? operation.ambiguities
      : operation.ambiguity ? [operation.ambiguity] : [];
    return ambiguities.some((item) => {
      return ['verify', 'content-verify'].includes(item.stage) && item.status === 'unresolved';
    }) || (operation.error?.kind === 'conflict'
      && (operation.verification || operation.contentVerification));
  }));
}

function activityFacts(request, approval, consumption, checkpoint, verification, compensation) {
  const expired = Date.parse(request.expiresAt) < Date.parse(request.observedAt);
  let workState = !approval ? (expired ? 'approval-expired' : 'awaiting-approval')
    : !consumption ? (expired ? 'approval-expired' : 'approved-not-started')
      : 'running';
  let phase = workState.startsWith('approval') || workState === 'awaiting-approval'
    ? 'approval'
    : 'execution';
  if (consumption && !checkpoint) {
    workState = 'blocked';
    phase = 'execution';
  } else if (checkpoint?.current?.stage === 'reconcile') {
    workState = 'blocked';
    phase = 'execution';
  } else if (checkpoint?.state === 'completed') {
    workState = 'completed';
    phase = 'complete';
  } else if (checkpoint?.state === 'rolled-back') {
    workState = 'rolled-back';
    phase = 'compensation';
  } else if (compensation.state === 'running') {
    workState = 'rolling-back';
    phase = 'compensation';
  } else if (verification.state === 'failed' || checkpointHasVerificationFailure(checkpoint)) {
    workState = 'verification-failed';
    phase = 'verification';
  } else if (checkpoint?.state === 'needs-attention') {
    workState = 'blocked';
    phase = 'execution';
  } else if (checkpoint?.state === 'failed') {
    workState = 'failed';
    phase = 'execution';
  } else if (checkpoint?.current?.stage === 'verify'
    || checkpoint?.current?.stage === 'content-verify') {
    phase = 'verification';
  }
  let automationId = null;
  try {
    automationId = readJson(resolveRepoPath(request.root, request.run.path)).automation?.id || null;
  } catch {
    // The exact run ID remains available even if its optional display source is unavailable.
  }
  const suffix = request.batch.id.slice('batch.'.length);
  return {
    id: 'activity.' + suffix,
    automationId,
    workId: 'work.' + suffix,
    workState,
    phase,
    runId: request.run.id
  };
}

function approvalFacts(request, approval, consumption, observedAt) {
  const expired = Date.parse(observedAt) > Date.parse(request.expiresAt);
  let state = !approval ? (expired ? 'expired' : 'awaiting')
    : consumption ? 'consumed'
      : expired ? 'expired' : 'confirmed';
  return {
    state,
    request: {
      id: request.id,
      fingerprint: request.requestFingerprint,
      requestedAt: request.createdAt,
      expiresAt: request.expiresAt
    },
    confirmation: approval
      ? {
          id: approval.id,
          fingerprint: connectedApprovalFingerprint(approval),
          confirmedAt: approval.createdAt,
          actor: approval.actor
        }
      : null,
    consumption: consumption
      ? {
          id: consumption.id,
          state: consumption.state,
          startedAt: consumption.createdAt,
          checkpointId: consumption.checkpointId,
          checkpointFingerprint: consumption.checkpointFingerprint
        }
      : null,
    reasonCode: state === 'awaiting' ? OPERATOR_REASON_CODES.APPROVAL_REQUEST_PENDING
      : state === 'expired' ? OPERATOR_REASON_CODES.APPROVAL_REQUEST_EXPIRED
        : state === 'confirmed' ? OPERATOR_REASON_CODES.APPROVAL_CONFIRMED_NOT_STARTED
          : state === 'consumed' ? OPERATOR_REASON_CODES.APPROVAL_CONSUMED
            : OPERATOR_REASON_CODES.CHECKPOINT_STALE
  };
}

function blockers(configuration, approval, checkpoint, verification, compensation) {
  const items = [];
  if (configuration.applicability.state !== 'current') {
    items.push({
      reasonCode: configuration.applicability.reasonCode,
      summary: 'Exact configuration applicability is not current.',
      details: [
        { key: 'state', value: configuration.applicability.state },
        { key: 'lockFingerprint', value: configuration.lockFingerprint }
      ],
      requiredInputs: [],
      requiredPermissions: []
    });
  }
  if (approval.state === 'expired') {
    items.push({
      reasonCode: OPERATOR_REASON_CODES.APPROVAL_REQUEST_EXPIRED,
      summary: 'The exact approval request expired before one-time start consumption.',
      details: [{ key: 'expiresAt', value: approval.request.expiresAt }],
      requiredInputs: [],
      requiredPermissions: []
    });
  }
  if (verification.state === 'failed') {
    items.push({
      reasonCode: OPERATOR_REASON_CODES.READ_AFTER_WRITE_MISMATCH,
      summary: 'Exact read-after-write verification did not establish the approved result.',
      details: verification.criteria.filter((item) => item.state === 'failed')
        .map((item) => ({ key: 'criterionId', value: item.id })),
      requiredInputs: [],
      requiredPermissions: []
    });
  }
  if (compensation.state === 'failed') {
    items.push({
      reasonCode: OPERATOR_REASON_CODES.COMPENSATION_FAILED,
      summary: 'Compensation has not established the captured prior state.',
      details: [{ key: 'checkpointId', value: checkpoint?.id || null }],
      requiredInputs: [],
      requiredPermissions: []
    });
  }
  if (checkpoint?.state === 'needs-attention'
    && verification.state !== 'failed'
    && compensation.state !== 'failed') {
    items.push({
      reasonCode: OPERATOR_REASON_CODES.RECONCILIATION_AVAILABLE,
      summary: 'An ambiguous external effect requires exact read-only reconciliation.',
      details: checkpoint.operations.flatMap((operation) => {
        const ambiguities = Array.isArray(operation.ambiguities)
          ? operation.ambiguities
          : operation.ambiguity ? [operation.ambiguity] : [];
        return ambiguities
          .filter((item) => item.status === 'unresolved')
          .map((item) => ({ key: 'ambiguityId', value: item.id }));
      }),
      requiredInputs: [],
      requiredPermissions: []
    });
  }
  if (checkpoint?.state === 'failed' && verification.state !== 'failed') {
    items.push({
      reasonCode: OPERATOR_REASON_CODES.EXECUTION_FAILED,
      summary: 'The connected transaction closed without completion.',
      details: [{ key: 'checkpointState', value: checkpoint.state }],
      requiredInputs: [],
      requiredPermissions: []
    });
  }
  return items;
}

function resumeFacts(configuration, approval, consumption, checkpoint) {
  if (configuration.applicability.state !== 'current') {
    return {
      classification: 'unavailable',
      reasonCode: configuration.applicability.reasonCode,
      reason: 'The exact lock is not currently applicable; no execution continuation is authorized.',
      permittedNextAction: configuration.applicability.state === 'stale' ? 'rebuild-work' : 'inspect-checkpoint'
    };
  }
  if (!checkpoint) {
    if (consumption?.state === 'started') {
      return {
        classification: 'requires-review',
        reasonCode: OPERATOR_REASON_CODES.CHECKPOINT_MISSING,
        reason: 'One-time start was consumed but its durable checkpoint is unavailable.',
        permittedNextAction: 'inspect-checkpoint'
      };
    }
    if (consumption?.state === 'reserved') {
      return {
        classification: 'requires-review',
        reasonCode: OPERATOR_REASON_CODES.APPROVAL_CONSUMPTION_RESERVED,
        reason: 'One-time start is reserved and requires private-state recovery before continuation.',
        permittedNextAction: 'inspect-checkpoint'
      };
    }
    if (approval.state === 'awaiting') {
      return {
        classification: 'unavailable',
        reasonCode: OPERATOR_REASON_CODES.APPROVAL_REQUEST_PENDING,
        reason: 'The exact request has not been confirmed.',
        permittedNextAction: 'confirm-approval'
      };
    }
    if (approval.state === 'expired') {
      return {
        classification: 'requires-review',
        reasonCode: OPERATOR_REASON_CODES.APPROVAL_REQUEST_EXPIRED,
        reason: 'The exact request expired before one-time start.',
        permittedNextAction: 'renew-approval-request'
      };
    }
    if (approval.state === 'confirmed') {
      return {
        classification: 'safe',
        reasonCode: OPERATOR_REASON_CODES.APPROVAL_CONFIRMED_NOT_STARTED,
        reason: 'The current exact approval may be consumed once to create its bound checkpoint.',
        permittedNextAction: 'start-transaction'
      };
    }
  }
  if (checkpoint?.state === 'requested' && checkpoint.current) {
    return {
      classification: 'safe',
      reasonCode: checkpoint.current.stage === 'reconcile'
        ? OPERATOR_REASON_CODES.RECONCILIATION_IN_PROGRESS
        : OPERATOR_REASON_CODES.CURRENT_CALL_PENDING,
      reason: 'Only the exact current checkpoint call is authorized to continue.',
      permittedNextAction: 'execute-current-call'
    };
  }
  if (checkpoint?.state === 'needs-attention') {
    const unresolved = checkpoint.operations.some((operation) => {
      return Array.isArray(operation.ambiguities)
        ? operation.ambiguities.some((item) => item.status === 'unresolved')
        : operation.ambiguity?.status === 'unresolved';
    });
    if (!unresolved) {
      return {
        classification: 'requires-review',
        reasonCode: OPERATOR_REASON_CODES.READ_AFTER_WRITE_MISMATCH,
        reason: 'Reconciliation established that the exact approved state is not present.',
        permittedNextAction: 'inspect-checkpoint'
      };
    }
    return {
      classification: 'safe',
      reasonCode: OPERATOR_REASON_CODES.RECONCILIATION_AVAILABLE,
      reason: 'Core authorizes preparation of one read-only reconciliation for the unresolved ambiguity.',
      permittedNextAction: 'prepare-reconciliation'
    };
  }
  const terminalCode = checkpoint?.state === 'completed'
    ? OPERATOR_REASON_CODES.TRANSACTION_COMPLETED
    : checkpoint?.state === 'rolled-back'
      ? OPERATOR_REASON_CODES.TRANSACTION_ROLLED_BACK
      : OPERATOR_REASON_CODES.EXECUTION_FAILED;
  return {
    classification: 'unavailable',
    reasonCode: terminalCode,
    reason: 'The checkpoint has no authorized execution continuation.',
    permittedNextAction: checkpoint ? 'none' : 'inspect-checkpoint'
  };
}

function continuationRequest(checkpoint, resume) {
  if (!checkpoint || resume.classification !== 'safe') return null;
  const kind = resume.permittedNextAction === 'execute-current-call'
    ? 'execute-current-call'
    : resume.permittedNextAction === 'prepare-reconciliation'
      ? 'prepare-reconciliation'
      : null;
  if (!kind) return null;
  const request = {
    kind,
    checkpointId: checkpoint.id,
    checkpointFingerprint: checkpoint.checkpointFingerprint,
    callId: kind === 'execute-current-call' ? checkpoint.current?.callId || null : null
  };
  if (kind === 'execute-current-call' && !request.callId) return null;
  return { ...request, requestFingerprint: fingerprintJson(request) };
}

export function inspectConnectedOperatorActivity({
  root,
  requestId = null,
  approvalId = null,
  checkpointId = null,
  observedAt = new Date().toISOString()
}) {
  const resolvedRoot = path.resolve(root);
  const sources = loadSources({
    root: resolvedRoot,
    requestId,
    approvalId,
    checkpointId,
    observedAt
  });
  const request = { ...sources.request, root: resolvedRoot, observedAt };
  const configuration = configurationFacts(resolvedRoot, sources.request);
  const approval = approvalFacts(
    sources.request,
    sources.approval,
    sources.consumption,
    observedAt
  );
  const capabilities = capabilityFacts(sources.request, sources.checkpoint);
  const verification = verificationFacts(sources.request, sources.checkpoint);
  const compensation = compensationFacts(sources.request, sources.checkpoint);
  const activity = activityFacts(
    request,
    sources.approval,
    sources.consumption,
    sources.checkpoint,
    verification,
    compensation
  );
  const packCompiled = sources.request.batch.$contract
    === 'soter://contracts/connected-operation-batch/v2';
  const recordIds = packCompiled
    ? unique(sources.request.batch.operations.map((operation) => operation.review.subject.id))
    : unique([
        ...sources.request.batch.operations.map((operation) => operation.input?.id),
        ...(sources.checkpoint?.operations || []).map((operation) => operation.createdRecordId)
      ]);
  const runtimeById = new Map((sources.checkpoint?.operations || []).map((operation) => {
    return [operation.id, operation];
  }));
  const changes = sources.request.batch.operations.map((operation) => {
    const runtime = runtimeById.get(operation.id);
    if (packCompiled) {
      return {
        id: operation.id,
        recordId: operation.review.subject.id,
        effect: operation.capability,
        beforeFingerprint: operation.review.before.fingerprint,
        afterFingerprint: operation.review.after.fingerprint
      };
    }
    const after = operation.capability === 'crm.records.update'
      ? operation.input.patch
      : {
          fields: operation.input.fields,
          bodyFingerprint: typeof operation.input.body === 'string'
            ? fingerprintJson(operation.input.body)
            : null
        };
    return {
      id: operation.id,
      recordId: operation.input.id || runtime?.createdRecordId || null,
      effect: operation.capability,
      beforeFingerprint: runtime?.priorFields ? fingerprintJson(runtime.priorFields) : null,
      afterFingerprint: fingerprintJson(after)
    };
  });
  const resume = resumeFacts(
    configuration,
    approval,
    sources.consumption,
    sources.checkpoint
  );
  const inspection = {
    $contract: 'soter://contracts/operator-inspection/v1',
    contractVersion: '1.0.0',
    generatedAt: observedAt,
    activity,
    configuration,
    scope: {
      changeSet: {
        id: sources.request.changeSet.id,
        fingerprint: sources.request.changeSetFingerprint
      },
      batch: {
        id: sources.request.batch.id,
        fingerprint: sources.request.batchFingerprint
      },
      effects: unique(sources.request.scope.effects),
      authorities: unique(sources.request.batch.operations.map((operation) => operation.authority)),
      recordIds,
      changes
    },
    approval,
    capabilities,
    blockers: blockers(
      configuration,
      approval,
      sources.checkpoint,
      verification,
      compensation
    ),
    checkpoint: sources.checkpoint
      ? {
          id: sources.checkpoint.id,
          fingerprint: sources.checkpoint.checkpointFingerprint,
          state: sources.checkpoint.state,
          updatedAt: sources.checkpoint.updatedAt
        }
      : null,
    resume,
    continuationRequest: continuationRequest(sources.checkpoint, resume),
    verification,
    compensation,
    families: {
      proof: {
        state: 'not-evaluated',
        reasonCode: OPERATOR_REASON_CODES.FAMILY_NOT_EVALUATED_BY_OPERATOR_INSPECTION
      },
      maturity: {
        state: 'not-evaluated',
        reasonCode: OPERATOR_REASON_CODES.FAMILY_NOT_EVALUATED_BY_OPERATOR_INSPECTION
      },
      migration: {
        state: 'not-evaluated',
        reasonCode: OPERATOR_REASON_CODES.FAMILY_NOT_EVALUATED_BY_OPERATOR_INSPECTION
      }
    },
    privacy: {
      scope: 'private-derived',
      rawProviderResponseIncluded: false,
      credentialValuesIncluded: false
    },
    inspectionFingerprint: fingerprintJson(null)
  };
  inspection.inspectionFingerprint = inspectionFingerprint(inspection);
  return assertOperatorInspection(resolvedRoot, inspection);
}
