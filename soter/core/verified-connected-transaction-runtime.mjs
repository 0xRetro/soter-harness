import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { evaluateAutomationConnectedObservation } from './connected-compilers.mjs';
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
import { assertExactProposalConnectedBatch } from './proposal-connected-batches.mjs';
import { fingerprintLock } from './resolve.mjs';
import { resolveConnectedObservationInput } from './connected-input-bindings.mjs';

const CONTRACT = 'soter://contracts/connected-transaction-checkpoint/v2';

function idPart(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function checkpointFingerprint(checkpoint) {
  const unsigned = structuredClone(checkpoint);
  delete unsigned.checkpointFingerprint;
  return fingerprintJson(unsigned);
}

function approvalConfigurationSelection(approval) {
  const configuration = approval.request.configuration;
  return {
    name: configuration.name,
    configurationBasis: configuration.configurationBasis,
    path: configuration.path,
    lockPath: configuration.lockPath,
    lockFingerprint: configuration.lockFingerprint,
    graphFingerprint: configuration.graphFingerprint
  };
}

function seal(checkpoint) {
  return { ...checkpoint, checkpointFingerprint: checkpointFingerprint(checkpoint) };
}

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(label + ' does not satisfy its contract: '
      + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '));
  }
}

function sourceOperation(checkpoint, operationId) {
  const source = checkpoint.batch.operations.find((operation) => operation.id === operationId);
  if (!source) throw new Error('Verified connected transaction operation source is missing.');
  return source;
}

function runtimeOperation(checkpoint, operationId) {
  const operation = checkpoint.operations.find((item) => item.id === operationId);
  if (!operation) throw new Error('Verified connected transaction runtime operation is missing.');
  return operation;
}

function stageRecord(operation, stage) {
  if (stage === 'precondition') return operation.precondition;
  if (stage === 'write') return operation.write;
  if (stage === 'verify') return operation.verification;
  return null;
}

function stageDescriptor(source, stage, operation = null) {
  if (stage === 'precondition') {
    if (source.precondition.kind !== 'expectation') {
      throw new Error('Verified connected transaction requested an absent precondition.');
    }
    return {
      capability: source.precondition.capability,
      provider: source.precondition.provider,
      input: source.precondition.input,
      approvedEffects: []
    };
  }
  if (stage === 'write') {
    return {
      capability: source.capability,
      provider: source.provider,
      input: source.input,
      approvedEffects: ['write']
    };
  }
  if (stage === 'verify' || stage === 'reconcile') {
    return {
      capability: source.verification.capability,
      provider: source.verification.provider,
      input: resolveConnectedObservationInput(
        source.verification,
        operation?.write?.output || null
      ),
      approvedEffects: []
    };
  }
  throw new Error('Unsupported verified connected transaction stage ' + stage + '.');
}

function phase(call, output = null, error = null) {
  return {
    call: structuredClone(call),
    output: output ? structuredClone(output) : null,
    outputFingerprint: output ? fingerprintJson(output) : null,
    error: error ? structuredClone(error) : null
  };
}

function currentPhase(checkpoint) {
  if (!checkpoint.current) return null;
  const operation = runtimeOperation(checkpoint, checkpoint.current.operationId);
  if (checkpoint.current.stage === 'reconcile') {
    return operation.reconciliations.find((item) => {
      return item.id === checkpoint.current.reconciliationId;
    })?.phase || null;
  }
  return stageRecord(operation, checkpoint.current.stage);
}

export function verifiedConnectedTransactionCurrentCall(checkpoint) {
  return currentPhase(checkpoint)?.call || null;
}

function appliedOperationIds(checkpoint) {
  return checkpoint.operations
    .filter((operation) => operation.state === 'applied')
    .map((operation) => operation.id);
}

function result(checkpoint, state, error = null) {
  return {
    state,
    appliedOperationIds: appliedOperationIds(checkpoint),
    error: error ? structuredClone(error) : null
  };
}

function callId(checkpoint, operation, stage, attempt = null) {
  return 'toolcall.transaction.' + idPart(checkpoint.batch.id.slice('batch.'.length))
    + '.' + idPart(operation.id) + '.' + idPart(stage)
    + (attempt === null ? '' : '.' + attempt);
}

function ambiguityId(operation) {
  return 'ambiguity.' + idPart(operation.id) + '.'
    + (operation.ambiguity ? 2 : 1);
}

function reconciliationId(operation) {
  return 'reconciliation.' + idPart(operation.id) + '.'
    + (operation.reconciliations.length + 1);
}

function nextStage(source) {
  return source.precondition.kind === 'expectation' ? 'precondition' : 'write';
}

function markTerminal(checkpoint, operation, state, error) {
  operation.state = state;
  operation.error = structuredClone(error);
  checkpoint.state = state === 'failed' ? 'failed' : 'needs-attention';
  checkpoint.current = null;
  checkpoint.result = result(checkpoint, checkpoint.state, error);
}

function markAmbiguous(checkpoint, operation, stage, call, at, error) {
  operation.state = 'needs-attention';
  operation.error = structuredClone(error);
  operation.ambiguity = {
    id: ambiguityId(operation),
    stage,
    callId: call?.id || null,
    createdAt: at,
    error: structuredClone(error),
    status: 'unresolved',
    resolvedAt: null,
    resolution: null
  };
  checkpoint.state = 'needs-attention';
  checkpoint.current = null;
  checkpoint.result = result(checkpoint, 'needs-attention', error);
}

function connectedTransactionPreflightError(error) {
  if (error?.code === 'CONNECTED_TRANSACTION_PREFLIGHT_FAILED') return error;
  const failure = new Error(
    'Verified connected transaction preflight could not prepare one exact host call.'
  );
  failure.code = 'CONNECTED_TRANSACTION_PREFLIGHT_FAILED';
  failure.reasonCode = typeof error?.reasonCode === 'string'
    ? error.reasonCode
    : typeof error?.code === 'string'
      ? error.code
      : 'HOST_REQUEST_NOT_EMITTED';
  return failure;
}

export function assertVerifiedConnectedWriteIsNotPaginated(call) {
  if (call?.pagination) {
    throw new Error(
      'Verified connected transaction writes cannot use a paginated provider call.'
    );
  }
  return true;
}

async function requestStage({ root, lock, checkpoint, operation, stage, at }) {
  const source = sourceOperation(checkpoint, operation.id);
  const descriptor = stageDescriptor(source, stage, operation);
  const prepared = await prepareHostToolCall({
    root,
    lock,
    configuration: checkpoint.configuration,
    runId: checkpoint.run.id,
    callId: callId(checkpoint, operation, stage),
    capability: descriptor.capability,
    authority: source.authority,
    containment: 'connected',
    providerImplementation: descriptor.provider.connectedImplementation,
    input: descriptor.input,
    at,
    approvedEffects: descriptor.approvedEffects
  });
  if (stage === 'write') assertVerifiedConnectedWriteIsNotPaginated(prepared.call);
  operation[stage === 'verify' ? 'verification' : stage] = phase(
    prepared.call,
    null,
    prepared.call.error
  );
  checkpoint.updatedAt = at;
  if (prepared.call.state !== 'requested') {
    const error = prepared.call.error || {
      kind: 'validation',
      code: 'HOST_REQUEST_NOT_EMITTED',
      reasonCode: 'HOST_REQUEST_NOT_EMITTED',
      message: 'The exact host request was not emitted.'
    };
    if (stage === 'precondition') markTerminal(checkpoint, operation, 'failed', error);
    else markAmbiguous(checkpoint, operation, stage, prepared.call, at, error);
    return;
  }
  operation.state = stage === 'precondition' ? 'preconditioning'
    : stage === 'write' ? 'writing' : 'verifying';
  checkpoint.state = 'requested';
  checkpoint.current = {
    operationId: operation.id,
    stage,
    callId: prepared.call.id,
    reconciliationId: null
  };
  checkpoint.result = null;
}

async function continueAfterApplied({ root, lock, checkpoint, at }) {
  const pending = checkpoint.operations.find((operation) => operation.state === 'pending');
  if (pending) {
    await requestStage({
      root,
      lock,
      checkpoint,
      operation: pending,
      stage: nextStage(sourceOperation(checkpoint, pending.id)),
      at
    });
    return;
  }
  checkpoint.state = 'completed';
  checkpoint.current = null;
  checkpoint.result = result(checkpoint, 'completed');
}

function assertCallBinding(checkpoint, source, operation, stage, record) {
  if (!record) return;
  const descriptor = stageDescriptor(source, stage, operation);
  const call = record.call;
  if (call.runId !== checkpoint.run.id
    || !call.configuration
    || fingerprintJson(call.configuration) !== fingerprintJson(checkpoint.configuration)
    || call.capability.id !== descriptor.capability
    || call.authority !== source.authority
    || call.provider.implementation !== descriptor.provider.connectedImplementation
    || call.inputFingerprint !== fingerprintJson(descriptor.input)
    || call.policyDecisions.some((item) => item.decision === 'blocked')
    || (stage === 'write' && !call.policyDecisions.some((item) => {
      return item.effect === 'write' && item.decision === 'confirmed';
    }))
    || (stage !== 'write' && call.policyDecisions.some((item) => {
      return item.decision === 'confirmed';
    }))) {
    throw new Error('Verified connected transaction phase does not match its exact source and policy.');
  }
}

export function assertVerifiedConnectedTransactionCheckpoint(root, checkpoint) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    checkpoint,
    'soter/contracts/connected-transaction-checkpoint-v2.schema.json',
    'Verified connected transaction checkpoint'
  );
  if (checkpoint.$contract !== CONTRACT
    || checkpoint.checkpointFingerprint !== checkpointFingerprint(checkpoint)
    || checkpoint.batchFingerprint !== fingerprintJson(checkpoint.batch)
    || checkpoint.changeSetFingerprint !== fingerprintJson(checkpoint.changeSet)
    || checkpoint.approvalFingerprint !== connectedApprovalFingerprint(checkpoint.approval)
    || checkpoint.batch.$contract !== 'soter://contracts/connected-operation-batch/v2'
    || checkpoint.batch.profile !== checkpoint.profile
    || checkpoint.configuration.configurationBasis !== 'private-active'
    || checkpoint.configuration.name
      !== checkpoint.approval.request.configuration.name
    || fingerprintJson(checkpoint.configuration)
      !== fingerprintJson(approvalConfigurationSelection(checkpoint.approval))
    || checkpoint.configuration.lockPath !== checkpoint.configurationLock.path
    || checkpoint.configuration.lockFingerprint
      !== checkpoint.configurationLock.fingerprint
    || checkpoint.configuration.graphFingerprint !== checkpoint.graphFingerprint
    || checkpoint.operations.length !== checkpoint.batch.operations.length) {
    throw new Error('Verified connected transaction checkpoint fingerprint or embedded source is stale.');
  }
  assertConnectedOperationBatchApproval({
    root: resolvedRoot,
    batch: checkpoint.batch,
    changeSet: checkpoint.changeSet,
    approval: checkpoint.approval,
    at: checkpoint.updatedAt,
    allowExpired: true
  });
  const ids = new Set();
  for (let index = 0; index < checkpoint.operations.length; index += 1) {
    const operation = checkpoint.operations[index];
    const source = checkpoint.batch.operations[index];
    if (!source || ids.has(operation.id) || operation.id !== source.id
      || operation.sequence !== index + 1) {
      throw new Error('Verified connected transaction operation order or identity is stale.');
    }
    ids.add(operation.id);
    assertCallBinding(checkpoint, source, operation, 'precondition', operation.precondition);
    assertCallBinding(checkpoint, source, operation, 'write', operation.write);
    assertCallBinding(checkpoint, source, operation, 'verify', operation.verification);
    for (const reconciliation of operation.reconciliations) {
      assertCallBinding(checkpoint, source, operation, 'reconcile', reconciliation.phase);
      if (reconciliation.ambiguityId !== operation.ambiguity?.id) {
        throw new Error('Verified connected transaction reconciliation does not bind its ambiguity.');
      }
    }
    if (operation.ambiguity && operation.ambiguity.callId !== null) {
      const ambiguous = [operation.write, operation.verification]
        .filter(Boolean).find((record) => record.call.id === operation.ambiguity.callId);
      if (!ambiguous) {
        throw new Error('Verified connected transaction ambiguity does not bind a write or verification call.');
      }
    }
  }
  const current = verifiedConnectedTransactionCurrentCall(checkpoint);
  if ((checkpoint.state === 'requested') !== Boolean(checkpoint.current)
    || (checkpoint.current && (!current
      || current.id !== checkpoint.current.callId
      || current.state !== 'requested'))
    || (checkpoint.state === 'completed'
      && checkpoint.operations.some((operation) => operation.state !== 'applied'))
    || (checkpoint.result === null) !== (checkpoint.state === 'requested')) {
    throw new Error('Verified connected transaction lifecycle is internally inconsistent.');
  }
  return checkpoint;
}

async function preflight({
  root,
  lock,
  batch,
  configuration,
  run,
  at
}) {
  for (const operation of batch.operations) {
    const descriptors = [
      { stage: 'write', ...stageDescriptor(operation, 'write') }
    ];
    if (operation.precondition.kind === 'expectation') {
      descriptors.unshift({
        stage: 'precondition',
        ...stageDescriptor(operation, 'precondition')
      });
    }
    if (!Object.hasOwn(operation.verification, 'inputBindings')) {
      descriptors.push({
        stage: 'verify',
        ...stageDescriptor(operation, 'verify')
      });
    } else {
      descriptors.push({
        stage: 'verify-binding',
        capability: operation.verification.capability,
        provider: operation.verification.provider,
        approvedEffects: []
      });
    }
    for (const descriptor of descriptors) {
      try {
        if (descriptor.input === undefined) {
          await preflightHostToolBinding({
            root,
            lock,
            capability: descriptor.capability,
            authority: operation.authority,
            containment: 'connected',
            providerImplementation: descriptor.provider.connectedImplementation,
            approvedEffects: descriptor.approvedEffects
          });
          continue;
        }
        const prepared = await prepareHostToolCall({
          root,
          lock,
          configuration,
          runId: run.id,
          callId: callId({ batch }, operation, 'preflight-' + descriptor.stage),
          capability: descriptor.capability,
          authority: operation.authority,
          containment: 'connected',
          providerImplementation: descriptor.provider.connectedImplementation,
          input: descriptor.input,
          at,
          approvedEffects: descriptor.approvedEffects
        });
        if (prepared.call.state !== 'requested') {
          throw connectedTransactionPreflightError(prepared.call.error);
        }
        if (descriptor.approvedEffects.includes('write')) {
          assertVerifiedConnectedWriteIsNotPaginated(prepared.call);
        }
      } catch (error) {
        throw connectedTransactionPreflightError(error);
      }
    }
  }
}

export async function createVerifiedConnectedTransactionCheckpoint({
  root,
  lock,
  lockPath,
  run,
  runSourcePath,
  runStatePath,
  batch,
  changeSet,
  approval,
  configuration,
  at
}) {
  const resolvedRoot = path.resolve(root);
  assertConnectedOperationBatchApproval({
    root: resolvedRoot,
    batch,
    changeSet,
    approval,
    at
  });
  if (batch.configurationLockFingerprint !== fingerprintLock(lock)
    || batch.runId !== run.id
    || !configuration
    || configuration.configurationBasis !== 'private-active'
    || configuration.name !== lock.configuration.name
    || configuration.path !== lock.configuration.path
    || configuration.lockPath !== lockPath
    || configuration.lockFingerprint !== fingerprintLock(lock)
    || configuration.graphFingerprint !== lock.graphFingerprint
    || fingerprintJson(configuration)
      !== fingerprintJson(approvalConfigurationSelection(approval))) {
    throw new Error('Verified connected transaction sources do not match the exact lock and run.');
  }
  await assertExactProposalConnectedBatch({
    root: resolvedRoot,
    lockPath,
    batch,
    changeSet,
    expectedHost: lock.host.id,
    at
  });
  await preflight({
    root: resolvedRoot,
    lock,
    batch,
    configuration,
    run,
    at
  });
  const checkpoint = {
    $contract: CONTRACT,
    contractVersion: '2.0.0',
    id: 'checkpoint.transaction.' + batch.id.slice('batch.'.length),
    kind: 'connected-transaction',
    profile: 'verified-write-sequence',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    state: 'failed',
    configuration: structuredClone(configuration),
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
      precondition: null,
      write: null,
      verification: null,
      ambiguity: null,
      reconciliations: [],
      observedFingerprint: null,
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
    operation: checkpoint.operations[0],
    stage: nextStage(batch.operations[0]),
    at
  });
  return seal(checkpoint);
}

function priorReplay(checkpoint, callId, response) {
  const responseFingerprint = fingerprintJson(response);
  const phases = checkpoint.operations.flatMap((operation) => [
    operation.precondition,
    operation.write,
    operation.verification,
    ...operation.reconciliations.map((item) => item.phase)
  ]).filter(Boolean);
  for (const record of phases) {
    const page = record.call.pagination?.pages.find((item) => item.callId === callId);
    const observed = page?.responseFingerprint
      || (record.call.id === callId && record.call.state === 'completed'
        ? record.call.responseFingerprint
        : null);
    if (!observed) continue;
    if (observed !== responseFingerprint) {
      throw new Error(
        'Verified connected transaction replay does not match the exact completed page response.'
      );
    }
    return true;
  }
  return false;
}

async function evaluate({ root, lock, checkpoint, source, phaseName, output, resolvedInput }) {
  return evaluateAutomationConnectedObservation({
    root,
    lock,
    automationId: checkpoint.batch.automation.id,
    compiler: checkpoint.batch.compiler,
    operation: source,
    phase: phaseName,
    output,
    resolvedInput
  });
}

export async function completeVerifiedConnectedTransactionCall({
  root,
  lock,
  checkpoint,
  callId: exactCallId,
  response,
  at
}) {
  const resolvedRoot = path.resolve(root);
  assertVerifiedConnectedTransactionCheckpoint(resolvedRoot, checkpoint);
  const currentCall = verifiedConnectedTransactionCurrentCall(checkpoint);
  if (!currentCall || currentCall.id !== exactCallId) {
    if (priorReplay(checkpoint, exactCallId, response)) {
      return { checkpoint: structuredClone(checkpoint), idempotent: true };
    }
    throw new Error('Verified connected transaction response does not match the exact current call.');
  }
  if (checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Verified connected transaction response does not match the exact lock and graph.');
  }
  const next = structuredClone(checkpoint);
  delete next.checkpointFingerprint;
  const operation = runtimeOperation(next, next.current.operationId);
  const source = sourceOperation(next, operation.id);
  const stage = next.current.stage;
  const descriptor = stageDescriptor(source, stage, operation);
  const completed = await completeHostToolCall({
    root: resolvedRoot,
    lock,
    call: currentCall,
    input: descriptor.input,
    response,
    at
  });
  next.updatedAt = at;
  if (completed.call.state === 'requested') {
    if (stage === 'write') {
      throw new Error(
        'Verified connected transaction write returned an unsafe paginated continuation.'
      );
    }
    if (stage === 'reconcile') {
      const reconciliation = operation.reconciliations.find((item) => {
        return item.id === checkpoint.current.reconciliationId;
      });
      reconciliation.phase = phase(completed.call);
    } else {
      operation[stage === 'verify' ? 'verification' : stage] = phase(completed.call);
    }
    next.current.callId = completed.call.id;
    next.state = 'requested';
    next.result = null;
    return { checkpoint: seal(next), idempotent: false };
  }
  next.current = null;
  if (stage === 'reconcile') {
    const reconciliation = operation.reconciliations.find((item) => {
      return item.id === checkpoint.current.reconciliationId;
    });
    reconciliation.phase = phase(completed.call, completed.output, completed.call.error);
    if (completed.call.state !== 'completed') {
      reconciliation.outcome = 'read-failed';
      operation.state = 'needs-attention';
      operation.error = structuredClone(completed.call.error);
      next.state = 'needs-attention';
      next.result = result(next, 'needs-attention', completed.call.error);
      return { checkpoint: seal(next), idempotent: false };
    }
    const observed = await evaluate({
      root: resolvedRoot,
      lock,
      checkpoint: next,
      source,
      phaseName: 'verification',
      output: completed.output,
      resolvedInput: descriptor.input
    });
    reconciliation.outcome = observed.state;
    reconciliation.observedFingerprint = observed.observedFingerprint;
    operation.observedFingerprint = observed.observedFingerprint;
    operation.ambiguity.status = 'resolved';
    operation.ambiguity.resolvedAt = at;
    operation.ambiguity.resolution = observed.state === 'passed'
      ? 'expected-state' : 'unexpected-state';
    if (observed.state === 'passed') {
      operation.state = 'applied';
      operation.error = null;
      await continueAfterApplied({ root: resolvedRoot, lock, checkpoint: next, at });
    } else {
      const error = {
        kind: 'conflict',
        code: 'CONNECTED_RECONCILIATION_MISMATCH',
        reasonCode: observed.reasonCode,
        message: 'Reconciliation did not observe the exact approved state.'
      };
      markTerminal(next, operation, 'needs-attention', error);
    }
    return { checkpoint: seal(next), idempotent: false };
  }

  operation[stage === 'verify' ? 'verification' : stage] = phase(
    completed.call,
    completed.output,
    completed.call.error
  );
  if (completed.call.state !== 'completed') {
    if (stage === 'precondition') {
      markTerminal(next, operation, 'failed', completed.call.error);
    } else {
      markAmbiguous(next, operation, stage, completed.call, at, completed.call.error);
    }
    return { checkpoint: seal(next), idempotent: false };
  }
  if (stage === 'precondition') {
    const observed = await evaluate({
      root: resolvedRoot,
      lock,
      checkpoint: next,
      source,
      phaseName: 'precondition',
      output: completed.output,
      resolvedInput: descriptor.input
    });
    operation.observedFingerprint = observed.observedFingerprint;
    if (observed.state !== 'passed') {
      markTerminal(next, operation, 'failed', {
        kind: 'conflict',
        code: 'CONNECTED_PRECONDITION_MISMATCH',
        reasonCode: observed.reasonCode,
        message: 'The exact compare-before-write precondition was not satisfied.'
      });
    } else {
      await requestStage({ root: resolvedRoot, lock, checkpoint: next, operation, stage: 'write', at });
    }
  } else if (stage === 'write') {
    await requestStage({ root: resolvedRoot, lock, checkpoint: next, operation, stage: 'verify', at });
  } else if (stage === 'verify') {
    const observed = await evaluate({
      root: resolvedRoot,
      lock,
      checkpoint: next,
      source,
      phaseName: 'verification',
      output: completed.output,
      resolvedInput: descriptor.input
    });
    operation.observedFingerprint = observed.observedFingerprint;
    if (observed.state === 'passed') {
      operation.state = 'applied';
      operation.error = null;
      await continueAfterApplied({ root: resolvedRoot, lock, checkpoint: next, at });
    } else {
      markAmbiguous(next, operation, 'verify', completed.call, at, {
        kind: 'conflict',
        code: 'CONNECTED_VERIFICATION_MISMATCH',
        reasonCode: observed.reasonCode,
        message: 'Read-after-write verification did not observe the exact approved state.'
      });
    }
  }
  return { checkpoint: seal(next), idempotent: false };
}

export async function prepareVerifiedConnectedTransactionReconciliation({
  root,
  lock,
  checkpoint,
  at
}) {
  const resolvedRoot = path.resolve(root);
  assertVerifiedConnectedTransactionCheckpoint(resolvedRoot, checkpoint);
  if (checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Verified connected reconciliation does not match the exact lock and graph.');
  }
  const unresolved = checkpoint.operations.filter((operation) => {
    return operation.ambiguity?.status === 'unresolved';
  });
  if (checkpoint.state !== 'needs-attention' || unresolved.length !== 1) {
    throw new Error('Only one exact unresolved verified-write ambiguity may be reconciled.');
  }
  const next = structuredClone(checkpoint);
  delete next.checkpointFingerprint;
  const operation = runtimeOperation(next, unresolved[0].id);
  if (operation.reconciliations.length >= 20) {
    throw new Error('Verified connected reconciliation attempt limit has been reached.');
  }
  const source = sourceOperation(next, operation.id);
  const descriptor = stageDescriptor(source, 'reconcile', operation);
  const id = reconciliationId(operation);
  const prepared = await prepareHostToolCall({
    root: resolvedRoot,
    lock,
    configuration: next.configuration,
    runId: next.run.id,
    callId: callId(next, operation, 'reconcile', operation.reconciliations.length + 1),
    capability: descriptor.capability,
    authority: source.authority,
    containment: 'connected',
    providerImplementation: descriptor.provider.connectedImplementation,
    input: descriptor.input,
    at,
    approvedEffects: []
  });
  const reconciliation = {
    id,
    ambiguityId: operation.ambiguity.id,
    createdAt: at,
    phase: phase(prepared.call, null, prepared.call.error),
    outcome: prepared.call.state === 'requested' ? null : 'read-failed',
    observedFingerprint: null
  };
  operation.reconciliations.push(reconciliation);
  next.updatedAt = at;
  if (prepared.call.state === 'requested') {
    operation.state = 'reconciling';
    next.state = 'requested';
    next.current = {
      operationId: operation.id,
      stage: 'reconcile',
      callId: prepared.call.id,
      reconciliationId: id
    };
    next.result = null;
  } else {
    operation.state = 'needs-attention';
    operation.error = structuredClone(prepared.call.error);
    next.state = 'needs-attention';
    next.current = null;
    next.result = result(next, 'needs-attention', prepared.call.error);
  }
  return seal(next);
}

export function failVerifiedConnectedTransactionCall({
  root,
  lock,
  checkpoint,
  callId: exactCallId,
  error,
  at
}) {
  const resolvedRoot = path.resolve(root);
  assertVerifiedConnectedTransactionCheckpoint(resolvedRoot, checkpoint);
  const currentCall = verifiedConnectedTransactionCurrentCall(checkpoint);
  if (!currentCall || currentCall.id !== exactCallId) {
    throw new Error('Verified connected transaction failure does not match the exact current call.');
  }
  const next = structuredClone(checkpoint);
  delete next.checkpointFingerprint;
  const operation = runtimeOperation(next, next.current.operationId);
  const stage = next.current.stage;
  const failedCall = failHostToolCall({ root: resolvedRoot, lock, call: currentCall, error, at });
  next.updatedAt = at;
  next.current = null;
  if (stage === 'reconcile') {
    const reconciliation = operation.reconciliations.find((item) => {
      return item.id === checkpoint.current.reconciliationId;
    });
    reconciliation.phase = phase(failedCall, null, failedCall.error);
    reconciliation.outcome = 'read-failed';
    operation.state = 'needs-attention';
    operation.error = structuredClone(failedCall.error);
    next.state = 'needs-attention';
    next.result = result(next, 'needs-attention', failedCall.error);
  } else {
    operation[stage === 'verify' ? 'verification' : stage] = phase(
      failedCall,
      null,
      failedCall.error
    );
    if (stage === 'precondition') markTerminal(next, operation, 'failed', failedCall.error);
    else markAmbiguous(next, operation, stage, failedCall, at, failedCall.error);
  }
  return seal(next);
}
