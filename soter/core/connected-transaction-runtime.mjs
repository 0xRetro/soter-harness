import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  assertConnectedOperationBatchApproval,
  connectedApprovalFingerprint
} from './connected-transactions.mjs';
import {
  completeHostToolCall,
  failHostToolCall,
  preflightHostToolBinding,
  prepareHostToolCall
} from './host-tools.mjs';
import { fingerprintJson, readJson } from './lib/canonical-json.mjs';
import { fingerprintLock } from './resolve.mjs';

const CONTRACT = 'soter://contracts/connected-transaction-checkpoint/v1';

function idPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function checkpointFingerprint(checkpoint) {
  const value = structuredClone(checkpoint);
  delete value.checkpointFingerprint;
  return fingerprintJson(value);
}

function seal(checkpoint) {
  return { ...checkpoint, checkpointFingerprint: checkpointFingerprint(checkpoint) };
}

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(label + ' does not satisfy its contract: '
      + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; '));
  }
}

function phaseName(stage) {
  return stage === 'verify' ? 'verification'
    : stage === 'content-verify' ? 'contentVerification'
    : stage === 'compensate' ? 'compensation'
      : stage === 'compensation-verify' ? 'compensationVerification'
        : stage;
}

function stageName(name) {
  return name === 'verification' ? 'verify'
    : name === 'contentVerification' ? 'content-verify'
    : name === 'compensation' ? 'compensate'
      : name === 'compensationVerification' ? 'compensation-verify'
        : name;
}

function sourceOperation(checkpoint, runtimeOperation) {
  return checkpoint.batch.operations.find((operation) => operation.id === runtimeOperation.id);
}

function isCreate(source) {
  return source.capability === 'crm.records.create';
}

function expectedFields(source) {
  return isCreate(source) ? source.input.fields : source.input.patch;
}

function inputForStage(source, runtimeOperation, stage) {
  if (stage === 'compare') return source.precondition.readInput;
  if (stage === 'write') return source.input;
  if (stage === 'verify') {
    return runtimeOperation.createdRecordId
      ? { recordTypes: [source.input.recordType], ids: [runtimeOperation.createdRecordId], limit: 1 }
      : source.precondition.readInput;
  }
  if (stage === 'content-verify') {
    if (!runtimeOperation.createdRecordId || !source.contentVerification) {
      throw new Error('Connected create content verification is missing its exact record identity.');
    }
    return {
      uri: runtimeOperation.createdRecordId,
      expectedTitle: source.contentVerification.expectedTitle
    };
  }
  if (stage === 'compensation-verify') {
    return { recordTypes: [source.input.recordType], ids: [source.input.id], limit: 1 };
  }
  if (stage === 'compensate') {
    return {
      recordType: source.input.recordType,
      id: source.input.id,
      expectedVersion: runtimeOperation.appliedVersion,
      patch: runtimeOperation.priorFields
    };
  }
  throw new Error('Unsupported connected transaction stage ' + stage + '.');
}

function capabilityForStage(source, stage) {
  if (stage === 'content-verify') return source.contentVerification.capability;
  return stage === 'write' || stage === 'compensate'
    ? source.capability
    : 'crm.records.read';
}

function callIdForStage(checkpoint, runtimeOperation, stage) {
  return 'toolcall.transaction.' + idPart(checkpoint.batch.id.slice('batch.'.length))
    + '.' + idPart(runtimeOperation.id) + '.' + idPart(stage);
}

function reconciliationId(runtimeOperation) {
  return 'reconciliation.' + idPart(runtimeOperation.id) + '.'
    + (runtimeOperation.reconciliations.length + 1);
}

function callIdForReconciliation(checkpoint, runtimeOperation, id) {
  return 'toolcall.transaction.' + idPart(checkpoint.batch.id.slice('batch.'.length))
    + '.' + idPart(runtimeOperation.id) + '.reconcile.' + id.split('.').at(-1);
}

function unresolvedAmbiguity(checkpoint) {
  const matches = checkpoint.operations.flatMap((operation) => {
    return operation.ambiguities
      .filter((ambiguity) => ambiguity.status === 'unresolved')
      .map((ambiguity) => ({ operation, ambiguity }));
  });
  if (matches.length > 1) {
    throw new Error('Connected transaction has more than one unresolved ambiguity.');
  }
  return matches[0] || null;
}

function reconciliationForCurrent(checkpoint) {
  if (checkpoint.current?.stage !== 'reconcile') return null;
  const operation = checkpoint.operations.find((item) => {
    return item.id === checkpoint.current.operationId;
  });
  const reconciliation = operation?.reconciliations.find((item) => {
    return item.id === checkpoint.current.reconciliationId;
  });
  return reconciliation ? { operation, reconciliation } : null;
}

export function assertConnectedTransactionCheckpoint(root, checkpoint) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    checkpoint,
    'soter/contracts/connected-transaction-checkpoint.schema.json',
    'Connected transaction checkpoint'
  );
  if (checkpoint.$contract !== CONTRACT
    || checkpoint.checkpointFingerprint !== checkpointFingerprint(checkpoint)
    || checkpoint.batchFingerprint !== fingerprintJson(checkpoint.batch)
    || checkpoint.changeSetFingerprint !== fingerprintJson(checkpoint.changeSet)
    || checkpoint.approvalFingerprint !== connectedApprovalFingerprint(checkpoint.approval)
    || checkpoint.operations.length !== checkpoint.batch.operations.length) {
    throw new Error('Connected transaction checkpoint fingerprint or embedded source is stale.');
  }
  assertConnectedOperationBatchApproval({
    root: resolvedRoot,
    batch: checkpoint.batch,
    changeSet: checkpoint.changeSet,
    approval: checkpoint.approval,
    at: checkpoint.updatedAt,
    allowExpired: true
  });
  if (checkpoint.batch.runId !== checkpoint.run.id
    || checkpoint.batch.configurationLockFingerprint !== checkpoint.configurationLock.fingerprint
    || checkpoint.batch.operations.some((operation, index) => {
      const update = operation.capability === 'crm.records.update'
        && operation.recovery.mode === 'restore-prior-fields';
      const terminalCreate = operation.capability === 'crm.records.create'
        && operation.recovery.mode === 'terminal-idempotent-create'
        && index === checkpoint.batch.operations.length - 1;
      return !update && !terminalCreate;
    })) {
    throw new Error('Connected transaction checkpoint is not an exact compensatable-update and terminal-create batch.');
  }
  checkpoint.operations.forEach((operation, index) => {
    if (operation.id !== checkpoint.batch.operations[index].id
      || operation.sequence !== index + 1) {
      throw new Error('Connected transaction operations do not preserve exact batch order.');
    }
  });
  const requested = [];
  const ambiguityIds = [];
  const reconciliationIds = [];
  for (const runtimeOperation of checkpoint.operations) {
    const source = sourceOperation(checkpoint, runtimeOperation);
    const create = isCreate(source);
    const deduplicationFilter = source.input.deduplicationFilter;
    const expectedPreconditionInput = create
      && deduplicationFilter
      && typeof deduplicationFilter.field === 'string'
      ? {
          recordTypes: [source.input.recordType],
          filters: {
            [deduplicationFilter.field]: deduplicationFilter.value
          },
          limit: 2
        }
      : create
        ? null
        : { recordTypes: [source.input.recordType], ids: [source.input.id], limit: 1 };
    if (source.verification.expectedFieldsFingerprint !== fingerprintJson(expectedFields(source))
      || source.verification.kind !== 'record-fields-match'
      || source.verification.recordType !== source.input.recordType
      || source.verification.recordId !== (create ? null : source.input.id)
      || fingerprintJson(source.precondition.readInput)
        !== fingerprintJson(expectedPreconditionInput)
      || (create && (source.precondition.kind !== 'deduplication-absent'
        || source.precondition.expectedCount !== 0
        || source.precondition.expectedVersion !== null
        || (typeof source.input.body === 'string'
          && (source.contentVerification?.expectedBodyFingerprint
            !== fingerprintJson(source.input.body)
            || source.contentVerification.expectedTitle !== source.input.fields.title))
        || (typeof source.input.body !== 'string' && source.contentVerification !== null)
        || (!source.contentVerification && runtimeOperation.contentVerification !== null)))
      || (!create && (source.precondition.kind !== 'expected-version'
        || source.precondition.expectedCount !== 1
        || source.precondition.expectedVersion !== source.input.expectedVersion
        || source.contentVerification !== null
        || runtimeOperation.contentVerification !== null
        || runtimeOperation.createdRecordId !== null))
      || (create && (runtimeOperation.priorFields !== null
        || runtimeOperation.priorVersion !== null
        || runtimeOperation.compensation !== null
        || runtimeOperation.compensationVerification !== null))) {
      throw new Error('Connected transaction operation does not preserve its exact recovery contract.');
    }
    for (const name of [
      'compare', 'write', 'verification', 'contentVerification',
      'compensation', 'compensationVerification'
    ]) {
      const stage = stageName(name);
      const record = runtimeOperation[name];
      if (!record) continue;
      validate(
        resolvedRoot,
        record.call,
        'soter/contracts/host-tool-call.schema.json',
        'Connected transaction host call'
      );
      const expectedInput = inputForStage(source, runtimeOperation, stage);
      if (record.call.id !== callIdForStage(checkpoint, runtimeOperation, stage)
        || record.call.runId !== checkpoint.run.id
        || record.call.configurationLockFingerprint !== checkpoint.configurationLock.fingerprint
        || record.call.graphFingerprint !== checkpoint.graphFingerprint
        || fingerprintJson(record.call.host) !== fingerprintJson(checkpoint.host)
        || record.call.provider.implementation !== source.provider.implementation
        || record.call.provider.pack !== source.provider.pack
        || record.call.provider.version !== source.provider.version
        || record.call.provider.containment !== 'connected'
        || record.call.capability.id !== capabilityForStage(source, stage)
        || record.call.authority !== source.authority
        || record.call.inputFingerprint !== fingerprintJson(expectedInput)
        || record.outputFingerprint !== (record.output ? fingerprintJson(record.output) : null)
        || record.call.outputFingerprint !== record.outputFingerprint
        || fingerprintJson(record.call.error) !== fingerprintJson(record.error)) {
        throw new Error('Connected transaction phase does not match its exact source and host call.');
      }
      if (record.call.state === 'requested') requested.push({ runtimeOperation, stage, record });
    }
    for (const ambiguity of runtimeOperation.ambiguities) {
      ambiguityIds.push(ambiguity.id);
      const sourcePhase = runtimeOperation[phaseName(ambiguity.stage)];
      if ((ambiguity.status === 'unresolved') !== (ambiguity.resolvedAt === null)
        || (ambiguity.status === 'unresolved') !== (ambiguity.resolution === null)
        || (ambiguity.callId !== null && sourcePhase?.call.id !== ambiguity.callId)) {
        throw new Error('Connected transaction ambiguity resolution state is inconsistent.');
      }
    }
    for (const reconciliation of runtimeOperation.reconciliations) {
      reconciliationIds.push(reconciliation.id);
      const ambiguity = runtimeOperation.ambiguities.find((item) => {
        return item.id === reconciliation.ambiguityId;
      });
      const record = reconciliation.phase;
      validate(
        resolvedRoot,
        record.call,
        'soter/contracts/host-tool-call.schema.json',
        'Connected transaction reconciliation call'
      );
      const observationStage = ambiguity ? reconciliationStage(ambiguity) : 'verify';
      const expectedInput = ambiguity
        ? inputForReconciliation(source, runtimeOperation, ambiguity)
        : source.precondition.readInput;
      const observation = record.call.state === 'completed' && ambiguity
        ? classifyReconciliation(record.output, source, runtimeOperation, ambiguity)
        : { record: null, outcome: 'read-failed' };
      if (!ambiguity
        || record.call.id !== callIdForReconciliation(
          checkpoint,
          runtimeOperation,
          reconciliation.id
        )
        || record.call.runId !== checkpoint.run.id
        || record.call.configurationLockFingerprint !== checkpoint.configurationLock.fingerprint
        || record.call.graphFingerprint !== checkpoint.graphFingerprint
        || fingerprintJson(record.call.host) !== fingerprintJson(checkpoint.host)
        || record.call.provider.implementation !== source.provider.implementation
        || record.call.provider.pack !== source.provider.pack
        || record.call.provider.version !== source.provider.version
        || record.call.provider.containment !== 'connected'
        || record.call.capability.id !== capabilityForStage(source, observationStage)
        || record.call.authority !== source.authority
        || record.call.inputFingerprint !== fingerprintJson(expectedInput)
        || record.outputFingerprint !== (record.output ? fingerprintJson(record.output) : null)
        || record.call.outputFingerprint !== record.outputFingerprint
        || fingerprintJson(record.call.error) !== fingerprintJson(record.error)
        || (record.call.state === 'requested') !== (reconciliation.outcome === null)
        || (['failed', 'blocked'].includes(record.call.state))
          !== (reconciliation.outcome === 'read-failed')
        || (record.call.state === 'completed'
          && (reconciliation.outcome !== observation.outcome
            || reconciliation.observedVersion !== (observation.record?.version || null)))
        || (record.call.state !== 'completed' && reconciliation.observedVersion !== null)) {
        throw new Error('Connected transaction reconciliation does not match its ambiguity and read call.');
      }
      if (record.call.state === 'requested') {
        requested.push({
          runtimeOperation,
          stage: 'reconcile',
          record,
          reconciliation
        });
      }
    }
    for (const ambiguity of runtimeOperation.ambiguities) {
      const resolvingOutcomes = runtimeOperation.reconciliations
        .filter((item) => item.ambiguityId === ambiguity.id)
        .map((item) => item.outcome)
        .filter((outcome) => [
          'prior-fields', 'approved-fields', 'approved-content', 'absent'
        ].includes(outcome));
      const compensation = ambiguity.stage === 'compensate'
        || ambiguity.stage === 'compensation-verify';
      const expectedResolution = ambiguity.stage === 'content-verify'
        ? resolvingOutcomes.includes('approved-content') ? 'approved-content' : null
        : compensation
          ? resolvingOutcomes.includes('prior-fields') ? 'prior-fields' : null
          : isCreate(source)
            ? resolvingOutcomes.includes('approved-fields')
              ? 'approved-fields'
              : resolvingOutcomes.includes('absent') ? 'absent' : null
            : resolvingOutcomes.includes('approved-fields')
              ? 'approved-fields'
              : resolvingOutcomes.includes('prior-fields')
                ? 'prior-fields'
                : null;
      if ((ambiguity.status === 'resolved' && ambiguity.resolution !== expectedResolution)
        || (ambiguity.status === 'unresolved' && expectedResolution !== null)) {
        throw new Error('Connected transaction ambiguity does not match its reconciliation history.');
      }
    }
  }
  if (new Set(ambiguityIds).size !== ambiguityIds.length
    || new Set(reconciliationIds).size !== reconciliationIds.length) {
    throw new Error('Connected transaction ambiguity and reconciliation IDs must be unique.');
  }
  if (requested.length > 1) {
    throw new Error('Connected transaction has more than one outstanding host call.');
  }
  if (checkpoint.current) {
    const operation = checkpoint.operations.find((item) => {
      return item.id === checkpoint.current.operationId;
    });
    const reconciliation = checkpoint.current.stage === 'reconcile'
      ? operation?.reconciliations.find((item) => {
        return item.id === checkpoint.current.reconciliationId;
      })
      : null;
    const phase = reconciliation?.phase || operation?.[phaseName(checkpoint.current.stage)];
    const expectedState = checkpoint.current.stage === 'compare' ? 'comparing'
      : checkpoint.current.stage === 'write' ? 'writing'
        : checkpoint.current.stage === 'verify' ? 'verifying'
          : checkpoint.current.stage === 'content-verify' ? 'content-verifying'
            : checkpoint.current.stage === 'compensate' ? 'compensating'
            : checkpoint.current.stage === 'compensation-verify'
              ? 'compensation-verifying'
              : 'reconciling';
    if (!phase || phase.call.id !== checkpoint.current.callId
      || phase.call.state !== 'requested' || checkpoint.state !== 'requested'
      || operation.state !== expectedState || requested.length !== 1
      || (checkpoint.current.stage === 'reconcile') !== Boolean(reconciliation)
      || (checkpoint.current.stage === 'reconcile')
        !== (checkpoint.current.reconciliationId !== null)) {
      throw new Error('Connected transaction current call is not the exact requested phase.');
    }
  } else if (checkpoint.state === 'requested') {
    throw new Error('Requested connected transaction does not identify one exact current call.');
  } else if (requested.length) {
    throw new Error('Terminal connected transaction retains an outstanding host call.');
  } else if (checkpoint.result?.state !== checkpoint.state) {
    throw new Error('Terminal connected transaction result does not match checkpoint state.');
  }
  const unresolved = unresolvedAmbiguity(checkpoint);
  const expectsUnresolved = checkpoint.state === 'needs-attention'
    || checkpoint.current?.stage === 'reconcile';
  if (expectsUnresolved !== Boolean(unresolved)
    || (checkpoint.current?.stage === 'reconcile'
      && unresolved?.ambiguity.id
        !== reconciliationForCurrent(checkpoint)?.reconciliation.ambiguityId)) {
    throw new Error('Connected transaction state does not match its unresolved ambiguity.');
  }
  if (checkpoint.result) {
    const expectedApplied = checkpoint.operations
      .filter((operation) => operation.state === 'applied')
      .map((operation) => operation.id);
    const expectedCompensated = checkpoint.operations
      .filter((operation) => operation.state === 'compensated')
      .map((operation) => operation.id);
    if (fingerprintJson(checkpoint.result.appliedOperationIds) !== fingerprintJson(expectedApplied)
      || fingerprintJson(checkpoint.result.compensatedOperationIds)
        !== fingerprintJson(expectedCompensated)) {
      throw new Error('Connected transaction result operation sets do not match runtime state.');
    }
  }
  if (checkpoint.startedAt !== null
    && (Date.parse(checkpoint.startedAt) < Date.parse(checkpoint.approval.createdAt)
      || Date.parse(checkpoint.startedAt) > Date.parse(checkpoint.approval.expiresAt))) {
    throw new Error('Connected transaction began outside its exact approval window.');
  }
  return checkpoint;
}

export function connectedTransactionCurrentCall(checkpoint) {
  if (checkpoint?.$contract !== CONTRACT || !checkpoint.current) return null;
  if (checkpoint.current.stage === 'reconcile') {
    return reconciliationForCurrent(checkpoint)?.reconciliation.phase.call || null;
  }
  const operation = checkpoint.operations.find((item) => {
    return item.id === checkpoint.current.operationId;
  });
  return operation?.[phaseName(checkpoint.current.stage)]?.call || null;
}

function phase(call, output = null, error = null) {
  return {
    call,
    output: output ? structuredClone(output) : null,
    outputFingerprint: output ? fingerprintJson(output) : null,
    error
  };
}

function recordFor(output, source, runtimeOperation = null) {
  const records = output?.records;
  if (!Array.isArray(records) || records.length !== 1
    || records[0].type !== source.input.recordType) return null;
  const expectedId = runtimeOperation?.createdRecordId || source.input.id;
  if (expectedId && records[0].id !== expectedId) return null;
  return records[0];
}

function createdRecordFor(output, source) {
  const record = output?.record;
  if (output?.created !== true
    || !record
    || record.type !== source.input.recordType
    || typeof record.id !== 'string'
    || !record.id) return null;
  return record;
}

function fieldsMatch(record, expected) {
  return Object.entries(expected).every(([field, value]) => {
    return fingerprintJson(record?.fields?.[field] ?? null) === fingerprintJson(value);
  });
}

function contentMatches(output, source, runtimeOperation) {
  const document = output?.document;
  return Boolean(source.contentVerification
    && runtimeOperation.createdRecordId
    && document?.uri === runtimeOperation.createdRecordId
    && document.title === source.contentVerification.expectedTitle
    && document.bodyFingerprint === source.contentVerification.expectedBodyFingerprint
    && fingerprintJson(document.body) === source.contentVerification.expectedBodyFingerprint);
}

function reconciliationStage(ambiguity) {
  return ambiguity.stage === 'content-verify' ? 'content-verify' : 'verify';
}

function inputForReconciliation(source, runtimeOperation, ambiguity) {
  if (isCreate(source) && ambiguity.stage === 'write') {
    return source.precondition.readInput;
  }
  return inputForStage(source, runtimeOperation, reconciliationStage(ambiguity));
}

function classifyReconciliation(output, source, runtimeOperation, ambiguity) {
  if (ambiguity.stage === 'content-verify') {
    return {
      record: null,
      outcome: contentMatches(output, source, runtimeOperation)
        ? 'approved-content'
        : 'diverged-content'
    };
  }
  const records = output?.records;
  if (isCreate(source) && Array.isArray(records) && records.length === 0) {
    return { record: null, outcome: 'absent' };
  }
  const record = recordFor(output, source, runtimeOperation);
  if (!record) return { record: null, outcome: 'missing' };
  const compensation = ambiguity.stage === 'compensate'
    || ambiguity.stage === 'compensation-verify';
  const approved = fieldsMatch(record, expectedFields(source));
  const prior = Boolean(runtimeOperation.priorFields
    && fieldsMatch(record, runtimeOperation.priorFields));
  const outcome = compensation && prior ? 'prior-fields'
    : !compensation && approved ? 'approved-fields'
      : prior ? 'prior-fields'
        : approved ? 'approved-fields'
          : 'diverged';
  return { record, outcome };
}

function completedResult(checkpoint, state, error = null) {
  return {
    state,
    appliedOperationIds: checkpoint.operations
      .filter((operation) => operation.state === 'applied')
      .map((operation) => operation.id),
    compensatedOperationIds: checkpoint.operations
      .filter((operation) => operation.state === 'compensated')
      .map((operation) => operation.id),
    error: error || (state === 'completed'
      ? null
      : checkpoint.operations.findLast((operation) => operation.error)?.error || null)
  };
}

function markNeedsAttention({ checkpoint, runtimeOperation, stage, callId, at, error }) {
  if (!['write', 'verify', 'content-verify', 'compensate', 'compensation-verify'].includes(stage)) {
    throw new Error('Unsupported connected transaction ambiguity stage ' + stage + '.');
  }
  if (unresolvedAmbiguity(checkpoint)) {
    throw new Error('Connected transaction already has an unresolved ambiguity.');
  }
  const ambiguity = {
    id: 'ambiguity.' + idPart(runtimeOperation.id) + '.'
      + (runtimeOperation.ambiguities.length + 1),
    stage,
    callId,
    createdAt: at,
    error: structuredClone(error),
    status: 'unresolved',
    resolvedAt: null,
    resolution: null
  };
  runtimeOperation.ambiguities.push(ambiguity);
  runtimeOperation.state = 'needs-attention';
  runtimeOperation.error = structuredClone(error);
  checkpoint.state = 'needs-attention';
  checkpoint.current = null;
  checkpoint.updatedAt = at;
  checkpoint.result = completedResult(checkpoint, 'needs-attention', error);
  return checkpoint;
}

async function requestStage({ root, lock, checkpoint, runtimeOperation, stage, at }) {
  const source = sourceOperation(checkpoint, runtimeOperation);
  const capability = capabilityForStage(source, stage);
  const input = inputForStage(source, runtimeOperation, stage);
  let approvedEffects = [];
  if (stage === 'write') {
    approvedEffects = ['write'];
  }
  if (stage === 'compensate') {
    approvedEffects = ['write'];
  }
  try {
    assertConnectedOperationBatchApproval({
      root,
      batch: checkpoint.batch,
      changeSet: checkpoint.changeSet,
      approval: checkpoint.approval,
      at,
      allowExpired: checkpoint.startedAt !== null || stage === 'compensate'
    });
  } catch (error) {
    const authorizationError = { kind: 'authorization', message: error.message };
    if (checkpoint.startedAt === null) {
      runtimeOperation.state = 'failed';
      runtimeOperation.error = authorizationError;
      checkpoint.state = 'failed';
      checkpoint.current = null;
      checkpoint.result = completedResult(checkpoint, 'failed', authorizationError);
      checkpoint.updatedAt = at;
    } else if (stage === 'compare' || stage === 'write') {
      runtimeOperation.state = 'failed';
      runtimeOperation.error = authorizationError;
      await beginRollback({ root, lock, checkpoint, at, error: authorizationError });
    } else {
      markNeedsAttention({
        checkpoint,
        runtimeOperation,
        stage,
        callId: null,
        at,
        error: authorizationError
      });
    }
    return checkpoint;
  }
  const prepared = await prepareHostToolCall({
    root,
    lock,
    runId: checkpoint.run.id,
    callId: callIdForStage(checkpoint, runtimeOperation, stage),
    capability,
    authority: source.authority,
    containment: 'connected',
    providerImplementation: source.provider.implementation,
    input,
    at,
    approvedEffects
  });
  if (prepared.call.state !== 'requested') {
    runtimeOperation[phaseName(stage)] = phase(prepared.call, null, prepared.call.error);
    runtimeOperation.error = prepared.call.error;
    runtimeOperation.state = 'failed';
    checkpoint.current = null;
    checkpoint.updatedAt = at;
    const applied = checkpoint.operations.some((operation) => operation.state === 'applied');
    if ((stage === 'compare' || stage === 'write') && applied) {
      return beginRollback({ root, lock, checkpoint, at, error: prepared.call.error });
    }
    if (stage === 'verify' || stage === 'content-verify' || stage.startsWith('compensat')) {
      markNeedsAttention({
        checkpoint,
        runtimeOperation,
        stage,
        callId: prepared.call.id,
        at,
        error: prepared.call.error
      });
    } else {
      checkpoint.state = 'failed';
      checkpoint.result = completedResult(checkpoint, 'failed', prepared.call.error);
    }
    return checkpoint;
  }
  runtimeOperation.state = stage === 'compare' ? 'comparing'
    : stage === 'write' ? 'writing'
      : stage === 'verify' ? 'verifying'
        : stage === 'content-verify' ? 'content-verifying'
          : stage === 'compensate' ? 'compensating'
            : 'compensation-verifying';
  runtimeOperation[phaseName(stage)] = phase(prepared.call);
  checkpoint.state = 'requested';
  checkpoint.current = {
    operationId: runtimeOperation.id,
    stage,
    callId: prepared.call.id,
    reconciliationId: null
  };
  checkpoint.updatedAt = at;
  checkpoint.result = null;
  return checkpoint;
}

async function beginRollback({ root, lock, checkpoint, at, error }) {
  const target = [...checkpoint.operations].reverse().find((operation) => {
    return operation.state === 'applied';
  });
  if (!target) {
    checkpoint.state = 'failed';
    checkpoint.current = null;
    checkpoint.updatedAt = at;
    checkpoint.result = completedResult(checkpoint, 'failed', error);
    return checkpoint;
  }
  return requestStage({ root, lock, checkpoint, runtimeOperation: target, stage: 'compensate', at });
}

async function preflightConnectedTransaction({ root, lock, runId, batch, at }) {
  for (const source of batch.operations) {
    const create = isCreate(source);
    const priorFields = create ? null : structuredClone(source.input.patch);
    const runtimeOperation = {
      id: source.id,
      appliedVersion: create ? null : source.input.expectedVersion,
      createdRecordId: null,
      priorFields
    };
    const stages = create
      ? ['compare', 'write', 'verify', ...(source.contentVerification ? ['content-verify'] : [])]
      : ['compare', 'write', 'verify', 'compensate', 'compensation-verify'];
    for (const stage of stages) {
      if (create && (stage === 'verify' || stage === 'content-verify')) {
        try {
          await preflightHostToolBinding({
            root,
            lock,
            capability: capabilityForStage(source, stage),
            authority: source.authority,
            containment: 'connected',
            providerImplementation: source.provider.implementation,
            approvedEffects: []
          });
        } catch (error) {
          throw new Error(
            'Connected transaction preflight rejected ' + source.id + '/' + stage + ': '
              + error.message
          );
        }
        continue;
      }
      const prepared = await prepareHostToolCall({
        root,
        lock,
        runId,
        callId: callIdForStage({ batch }, runtimeOperation, 'preflight-' + stage),
        capability: capabilityForStage(source, stage),
        authority: source.authority,
        containment: 'connected',
        providerImplementation: source.provider.implementation,
        input: inputForStage(source, runtimeOperation, stage),
        at,
        approvedEffects: stage === 'write' || stage === 'compensate' ? ['write'] : []
      });
      if (prepared.call.state !== 'requested') {
        throw new Error(
          'Connected transaction preflight rejected ' + source.id + '/' + stage + ': '
            + prepared.call.error.message
        );
      }
    }
  }
}

export async function createConnectedTransactionCheckpoint({
  root, lock, lockPath, run, runSourcePath, runStatePath, batch, changeSet, approval, at
}) {
  const resolvedRoot = path.resolve(root);
  assertConnectedOperationBatchApproval({
    root: resolvedRoot, batch, changeSet, approval, at
  });
  if (batch.configurationLockFingerprint !== fingerprintLock(lock)
    || batch.runId !== run.id) {
    throw new Error('Connected transaction sources do not match the exact lock and run.');
  }
  if (batch.operations.some((operation, index) => {
    const update = operation.capability === 'crm.records.update'
      && operation.recovery.mode === 'restore-prior-fields';
    const terminalCreate = operation.capability === 'crm.records.create'
      && operation.recovery.mode === 'terminal-idempotent-create'
      && index === batch.operations.length - 1;
    return !update && !terminalCreate;
  })) {
    throw new Error(
      'Connected transaction execution requires compensatable updates followed by at most one terminal idempotent create.'
    );
  }
  await preflightConnectedTransaction({
    root: resolvedRoot,
    lock,
    runId: run.id,
    batch,
    at
  });
  const checkpoint = {
    $contract: CONTRACT,
    contractVersion: '1.0.0',
    id: 'checkpoint.transaction.' + batch.id.slice('batch.'.length),
    kind: 'connected-transaction',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    state: 'failed',
    configurationLock: { path: lockPath, fingerprint: fingerprintLock(lock) },
    graphFingerprint: lock.graphFingerprint,
    host: { id: lock.host.id, adapter: lock.host.adapter, version: lock.host.version },
    run: {
      id: run.id,
      sourcePath: runSourcePath,
      statePath: runStatePath,
      fingerprint: fingerprintJson(run)
    },
    batch: structuredClone(batch),
    batchFingerprint: fingerprintJson(batch),
    changeSet: structuredClone(changeSet),
    changeSetFingerprint: fingerprintJson(changeSet),
    approval: structuredClone(approval),
    approvalFingerprint: connectedApprovalFingerprint(approval),
    operations: batch.operations.map((operation, index) => ({
      id: operation.id,
      sequence: index + 1,
      state: 'pending',
      priorFields: null,
      priorVersion: null,
      appliedVersion: null,
      createdRecordId: null,
      compare: null,
      write: null,
      verification: null,
      contentVerification: null,
      compensation: null,
      compensationVerification: null,
      ambiguities: [],
      reconciliations: [],
      error: null
    })),
    current: null,
    result: null,
    privacy: {
      scope: 'private',
      rawProviderResponsePersisted: false,
      hostCredentialValuesPersisted: false
    },
    checkpointFingerprint: fingerprintJson(null)
  };
  await requestStage({
    root: resolvedRoot,
    lock,
    checkpoint,
    runtimeOperation: checkpoint.operations[0],
    stage: 'compare',
    at
  });
  return seal(checkpoint);
}

export async function prepareConnectedTransactionReconciliation({ root, lock, checkpoint, at }) {
  const resolvedRoot = path.resolve(root);
  assertConnectedTransactionCheckpoint(resolvedRoot, checkpoint);
  if (checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Connected transaction reconciliation does not match the exact lock and graph.');
  }
  if (checkpoint.state !== 'needs-attention') {
    throw new Error('Only a needs-attention connected transaction can begin reconciliation.');
  }
  const unresolved = unresolvedAmbiguity(checkpoint);
  if (!unresolved) {
    throw new Error('Connected transaction has no unresolved ambiguity to reconcile.');
  }
  const next = structuredClone(checkpoint);
  delete next.checkpointFingerprint;
  const runtimeOperation = next.operations.find((operation) => {
    return operation.id === unresolved.operation.id;
  });
  const ambiguity = runtimeOperation.ambiguities.find((item) => {
    return item.id === unresolved.ambiguity.id;
  });
  if (runtimeOperation.reconciliations.length >= 20) {
    throw new Error('Connected transaction reconciliation attempt limit has been reached.');
  }
  const id = reconciliationId(runtimeOperation);
  const source = sourceOperation(next, runtimeOperation);
  const observationStage = reconciliationStage(ambiguity);
  const input = inputForReconciliation(source, runtimeOperation, ambiguity);
  const prepared = await prepareHostToolCall({
    root: resolvedRoot,
    lock,
    runId: next.run.id,
    callId: callIdForReconciliation(next, runtimeOperation, id),
    capability: capabilityForStage(source, observationStage),
    authority: source.authority,
    containment: 'connected',
    providerImplementation: source.provider.implementation,
    input,
    at,
    approvedEffects: []
  });
  const reconciliation = {
    id,
    ambiguityId: ambiguity.id,
    createdAt: at,
    phase: phase(prepared.call, null, prepared.call.error),
    outcome: prepared.call.state === 'requested' ? null : 'read-failed',
    observedVersion: null
  };
  runtimeOperation.reconciliations.push(reconciliation);
  next.updatedAt = at;
  if (prepared.call.state === 'requested') {
    runtimeOperation.state = 'reconciling';
    next.state = 'requested';
    next.current = {
      operationId: runtimeOperation.id,
      stage: 'reconcile',
      callId: prepared.call.id,
      reconciliationId: reconciliation.id
    };
    next.result = null;
  } else {
    runtimeOperation.state = 'needs-attention';
    next.state = 'needs-attention';
    next.current = null;
    next.result = completedResult(next, 'needs-attention', prepared.call.error);
  }
  return seal(next);
}

async function continueAfterApplied({ root, lock, checkpoint, at }) {
  const pending = checkpoint.operations.find((operation) => operation.state === 'pending');
  if (pending) {
    return requestStage({
      root,
      lock,
      checkpoint,
      runtimeOperation: pending,
      stage: 'compare',
      at
    });
  }
  checkpoint.state = 'completed';
  checkpoint.current = null;
  checkpoint.result = completedResult(checkpoint, 'completed');
  return checkpoint;
}

async function continueRollback({ root, lock, checkpoint, at }) {
  const prior = [...checkpoint.operations].reverse().find((operation) => {
    return operation.state === 'applied';
  });
  if (prior) {
    return requestStage({
      root,
      lock,
      checkpoint,
      runtimeOperation: prior,
      stage: 'compensate',
      at
    });
  }
  checkpoint.state = 'rolled-back';
  checkpoint.current = null;
  checkpoint.result = completedResult(checkpoint, 'rolled-back');
  return checkpoint;
}

async function completeReconciliation({ root, lock, checkpoint, currentCall, response, at }) {
  const current = reconciliationForCurrent(checkpoint);
  if (!current) throw new Error('Connected transaction reconciliation current call is missing.');
  const { operation: runtimeOperation, reconciliation } = current;
  const source = sourceOperation(checkpoint, runtimeOperation);
  const ambiguity = runtimeOperation.ambiguities.find((item) => {
    return item.id === reconciliation.ambiguityId && item.status === 'unresolved';
  });
  if (!ambiguity) throw new Error('Connected transaction reconciliation ambiguity is missing.');
  const input = inputForReconciliation(source, runtimeOperation, ambiguity);
  const completed = await completeHostToolCall({
    root,
    lock,
    call: currentCall,
    input,
    response,
    at
  });
  reconciliation.phase = phase(completed.call, completed.output, completed.call.error);
  checkpoint.current = null;
  checkpoint.updatedAt = at;
  if (completed.call.state !== 'completed') {
    reconciliation.outcome = 'read-failed';
    reconciliation.observedVersion = null;
    runtimeOperation.state = 'needs-attention';
    runtimeOperation.error = completed.call.error;
    checkpoint.state = 'needs-attention';
    checkpoint.result = completedResult(checkpoint, 'needs-attention', completed.call.error);
    return checkpoint;
  }

  const observation = classifyReconciliation(
    completed.output,
    source,
    runtimeOperation,
    ambiguity
  );
  const { record } = observation;
  reconciliation.observedVersion = record?.version || null;
  const compensation = ambiguity.stage === 'compensate'
    || ambiguity.stage === 'compensation-verify';
  reconciliation.outcome = observation.outcome;

  if (reconciliation.outcome === 'approved-content') {
    ambiguity.status = 'resolved';
    ambiguity.resolvedAt = at;
    ambiguity.resolution = 'approved-content';
    runtimeOperation.state = 'applied';
    return continueAfterApplied({ root, lock, checkpoint, at });
  }

  if ((!compensation && reconciliation.outcome === 'approved-fields')
    || (compensation && reconciliation.outcome === 'prior-fields')) {
    ambiguity.status = 'resolved';
    ambiguity.resolvedAt = at;
    ambiguity.resolution = reconciliation.outcome;
    if (compensation) {
      runtimeOperation.state = 'compensated';
      return continueRollback({ root, lock, checkpoint, at });
    }
    if (isCreate(source)) {
      runtimeOperation.createdRecordId = record.id;
      runtimeOperation.appliedVersion = record.version || null;
      if (source.contentVerification) {
        return requestStage({
          root,
          lock,
          checkpoint,
          runtimeOperation,
          stage: 'content-verify',
          at
        });
      }
      runtimeOperation.state = 'applied';
      return continueAfterApplied({ root, lock, checkpoint, at });
    }
    runtimeOperation.state = 'applied';
    runtimeOperation.appliedVersion = record.version;
    return continueAfterApplied({ root, lock, checkpoint, at });
  }

  if (isCreate(source) && reconciliation.outcome === 'absent') {
    ambiguity.status = 'resolved';
    ambiguity.resolvedAt = at;
    ambiguity.resolution = 'absent';
    runtimeOperation.state = 'failed';
    return beginRollback({
      root,
      lock,
      checkpoint,
      at,
      error: ambiguity.error
    });
  }

  if (!compensation && reconciliation.outcome === 'prior-fields') {
    ambiguity.status = 'resolved';
    ambiguity.resolvedAt = at;
    ambiguity.resolution = 'prior-fields';
    runtimeOperation.state = 'failed';
    return beginRollback({
      root,
      lock,
      checkpoint,
      at,
      error: ambiguity.error
    });
  }

  runtimeOperation.state = 'needs-attention';
  checkpoint.state = 'needs-attention';
  checkpoint.result = completedResult(checkpoint, 'needs-attention', ambiguity.error);
  return checkpoint;
}

function priorReplay(checkpoint, callId, response) {
  for (const operation of checkpoint.operations) {
    const records = [
      operation.compare,
      operation.write,
      operation.verification,
      operation.contentVerification,
      operation.compensation,
      operation.compensationVerification,
      ...operation.reconciliations.map((item) => item.phase)
    ];
    for (const record of records) {
      const call = record?.call;
      if (call?.id !== callId || !call.responseFingerprint) continue;
      if (call.responseFingerprint !== fingerprintJson(response)) {
        throw new Error('Connected transaction replay does not match the exact completed call response.');
      }
      return true;
    }
  }
  return false;
}

export async function completeConnectedTransactionCall({ root, lock, checkpoint, callId, response, at }) {
  const resolvedRoot = path.resolve(root);
  assertConnectedTransactionCheckpoint(resolvedRoot, checkpoint);
  const currentCall = connectedTransactionCurrentCall(checkpoint);
  if (!currentCall || currentCall.id !== callId) {
    if (priorReplay(checkpoint, callId, response)) {
      return { checkpoint: structuredClone(checkpoint), idempotent: true };
    }
    throw new Error('Connected transaction response does not match the exact current call.');
  }
  if (checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Connected transaction response does not match the exact lock and graph.');
  }
  const next = structuredClone(checkpoint);
  delete next.checkpointFingerprint;
  const runtimeOperation = next.operations.find((operation) => {
    return operation.id === next.current.operationId;
  });
  const source = sourceOperation(next, runtimeOperation);
  const stage = next.current.stage;
  if (stage === 'reconcile') {
    await completeReconciliation({
      root: resolvedRoot,
      lock,
      checkpoint: next,
      currentCall,
      response,
      at
    });
    return { checkpoint: seal(next), idempotent: false };
  }
  const input = inputForStage(source, runtimeOperation, stage);
  const completed = await completeHostToolCall({
    root: resolvedRoot,
    lock,
    call: currentCall,
    input,
    response,
    at
  });
  runtimeOperation[phaseName(stage)] = phase(
    completed.call,
    completed.output,
    completed.call.error
  );
  next.current = null;
  next.updatedAt = at;
  if (completed.call.state !== 'completed') {
    runtimeOperation.error = completed.call.error;
    if (stage === 'compare') {
      runtimeOperation.state = 'failed';
      await beginRollback({ root: resolvedRoot, lock, checkpoint: next, at, error: completed.call.error });
    } else {
      markNeedsAttention({
        checkpoint: next,
        runtimeOperation,
        stage,
        callId: completed.call.id,
        at,
        error: completed.call.error
      });
    }
    return { checkpoint: seal(next), idempotent: false };
  }

  if (stage === 'compare') {
    const records = completed.output?.records;
    if (isCreate(source)) {
      if (!Array.isArray(records) || records.length !== source.precondition.expectedCount) {
        runtimeOperation.state = 'failed';
        runtimeOperation.error = {
          kind: 'conflict',
          message: 'Create precondition did not prove the deduplication key was absent.'
        };
        await beginRollback({
          root: resolvedRoot,
          lock,
          checkpoint: next,
          at,
          error: runtimeOperation.error
        });
      } else {
        await requestStage({
          root: resolvedRoot,
          lock,
          checkpoint: next,
          runtimeOperation,
          stage: 'write',
          at
        });
      }
      return { checkpoint: seal(next), idempotent: false };
    }
    const record = recordFor(completed.output, source, runtimeOperation);
    if (!record || record.version !== source.precondition.expectedVersion) {
      runtimeOperation.state = 'failed';
      runtimeOperation.error = {
        kind: 'conflict',
        message: 'Compare-before-write did not observe the exact expected record version.'
      };
      await beginRollback({ root: resolvedRoot, lock, checkpoint: next, at, error: runtimeOperation.error });
    } else {
      runtimeOperation.priorVersion = record.version;
      runtimeOperation.priorFields = Object.fromEntries(
        Object.keys(source.input.patch).map((field) => [
          field,
          Object.hasOwn(record.fields, field) ? record.fields[field] : null
        ])
      );
      await requestStage({ root: resolvedRoot, lock, checkpoint: next, runtimeOperation, stage: 'write', at });
    }
  } else if (stage === 'write') {
    if (isCreate(source)) {
      const record = createdRecordFor(completed.output, source);
      if (!record) {
        runtimeOperation.error = {
          kind: 'conflict',
          message: 'Create result did not prove one newly created record identity.'
        };
        markNeedsAttention({
          checkpoint: next,
          runtimeOperation,
          stage,
          callId: completed.call.id,
          at,
          error: runtimeOperation.error
        });
        return { checkpoint: seal(next), idempotent: false };
      }
      runtimeOperation.createdRecordId = record.id;
    }
    await requestStage({ root: resolvedRoot, lock, checkpoint: next, runtimeOperation, stage: 'verify', at });
  } else if (stage === 'verify') {
    const record = recordFor(completed.output, source, runtimeOperation);
    runtimeOperation.appliedVersion = record?.version || null;
    if (!record || !fieldsMatch(record, expectedFields(source))) {
      runtimeOperation.error = {
        kind: 'conflict',
        message: 'Read-after-write did not observe the exact approved field patch.'
      };
      if (isCreate(source) || !runtimeOperation.appliedVersion) {
        markNeedsAttention({
          checkpoint: next,
          runtimeOperation,
          stage,
          callId: completed.call.id,
          at,
          error: runtimeOperation.error
        });
      } else {
        runtimeOperation.state = 'applied';
        await beginRollback({ root: resolvedRoot, lock, checkpoint: next, at, error: runtimeOperation.error });
      }
    } else {
      if (isCreate(source) && source.contentVerification) {
        await requestStage({
          root: resolvedRoot,
          lock,
          checkpoint: next,
          runtimeOperation,
          stage: 'content-verify',
          at
        });
      } else {
        runtimeOperation.state = 'applied';
        await continueAfterApplied({ root: resolvedRoot, lock, checkpoint: next, at });
      }
    }
  } else if (stage === 'content-verify') {
    if (!contentMatches(completed.output, source, runtimeOperation)) {
      runtimeOperation.error = {
        kind: 'conflict',
        message: 'Post-create content verification did not observe the exact approved title and body.'
      };
      markNeedsAttention({
        checkpoint: next,
        runtimeOperation,
        stage,
        callId: completed.call.id,
        at,
        error: runtimeOperation.error
      });
    } else {
      runtimeOperation.state = 'applied';
      await continueAfterApplied({ root: resolvedRoot, lock, checkpoint: next, at });
    }
  } else if (stage === 'compensate') {
    await requestStage({
      root: resolvedRoot,
      lock,
      checkpoint: next,
      runtimeOperation,
      stage: 'compensation-verify',
      at
    });
  } else if (stage === 'compensation-verify') {
    const record = recordFor(completed.output, source, runtimeOperation);
    if (!record || !fieldsMatch(record, runtimeOperation.priorFields)) {
      runtimeOperation.error = {
        kind: 'conflict',
        message: 'Compensation verification did not observe the captured prior fields.'
      };
      markNeedsAttention({
        checkpoint: next,
        runtimeOperation,
        stage,
        callId: completed.call.id,
        at,
        error: runtimeOperation.error
      });
    } else {
      runtimeOperation.state = 'compensated';
      await continueRollback({ root: resolvedRoot, lock, checkpoint: next, at });
    }
  }
  return { checkpoint: seal(next), idempotent: false };
}

export async function failConnectedTransactionCall({ root, lock, checkpoint, callId, error, at }) {
  const resolvedRoot = path.resolve(root);
  assertConnectedTransactionCheckpoint(resolvedRoot, checkpoint);
  const currentCall = connectedTransactionCurrentCall(checkpoint);
  if (!currentCall || currentCall.id !== callId) {
    const prior = checkpoint.operations.flatMap((operation) => [
      operation.compare,
      operation.write,
      operation.verification,
      operation.contentVerification,
      operation.compensation,
      operation.compensationVerification,
      ...operation.reconciliations.map((item) => item.phase)
    ]).filter(Boolean).find((record) => record.call.id === callId);
    if (prior?.call.state === 'failed'
      && prior.error?.kind === error.kind
      && prior.error?.message === error.message) {
      return structuredClone(checkpoint);
    }
    throw new Error('Connected transaction failure does not match the exact current call.');
  }
  const next = structuredClone(checkpoint);
  delete next.checkpointFingerprint;
  const operation = next.operations.find((item) => item.id === next.current.operationId);
  const stage = next.current.stage;
  const failedCall = failHostToolCall({ root: resolvedRoot, lock, call: currentCall, error, at });
  if (stage === 'reconcile') {
    const reconciliation = operation.reconciliations.find((item) => {
      return item.id === next.current.reconciliationId;
    });
    if (!reconciliation) {
      throw new Error('Connected transaction reconciliation failure is missing its exact attempt.');
    }
    reconciliation.phase = phase(failedCall, null, failedCall.error);
    reconciliation.outcome = 'read-failed';
    reconciliation.observedVersion = null;
    operation.error = failedCall.error;
    operation.state = 'needs-attention';
    next.current = null;
    next.updatedAt = at;
    next.state = 'needs-attention';
    next.result = completedResult(next, 'needs-attention', failedCall.error);
    return seal(next);
  }
  operation[phaseName(stage)] = phase(failedCall, null, failedCall.error);
  operation.error = failedCall.error;
  operation.state = 'failed';
  next.current = null;
  next.updatedAt = at;
  if (stage === 'compare' && next.operations.some((item) => item.state === 'applied')) {
    await beginRollback({ root: resolvedRoot, lock, checkpoint: next, at, error: failedCall.error });
  } else if (stage === 'compare') {
    next.state = 'failed';
    next.result = completedResult(next, 'failed', failedCall.error);
  } else {
    markNeedsAttention({
      checkpoint: next,
      runtimeOperation: operation,
      stage,
      callId: failedCall.id,
      at,
      error: failedCall.error
    });
  }
  return seal(next);
}
