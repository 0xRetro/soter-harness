import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  completeHostToolCall,
  failHostToolCall,
  prepareHostToolCall
} from './host-tools.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import { fingerprintJson, readJson, repoRelativePath, resolveRepoPath } from './lib/canonical-json.mjs';
import {
  assertConnectedTransactionCheckpoint,
  completeConnectedTransactionCall,
  connectedTransactionCurrentCall,
  createConnectedTransactionCheckpoint,
  failConnectedTransactionCall,
  prepareConnectedTransactionReconciliation
} from './connected-transaction-runtime.mjs';
import {
  assertVerifiedConnectedTransactionCheckpoint,
  completeVerifiedConnectedTransactionCall,
  createVerifiedConnectedTransactionCheckpoint,
  failVerifiedConnectedTransactionCall,
  prepareVerifiedConnectedTransactionReconciliation,
  verifiedConnectedTransactionCurrentCall
} from './verified-connected-transaction-runtime.mjs';
import {
  assertOperationPlanCheckpoint,
  assertOperationPlanDocument,
  completeOperationPlanStep,
  createOperationPlanCheckpoint,
  failOperationPlanStep,
  operationPlanCurrentCall,
  preflightOperationPlanSteps,
  requestNextOperationPlanStep
} from './operation-plans.mjs';
import {
  completeProviderProbeCall,
  failProviderProbeCall,
  prepareProviderProbeCall
} from './provider-probes.mjs';
import {
  assertProviderProbePlanCheckpoint,
  completeProviderProbePlanStep,
  createProviderProbePlanCheckpoint,
  failProviderProbePlanStep,
  providerProbePlanCurrentCall,
  providerUsesProbePlan
} from './provider-probe-plans.mjs';
import { fingerprintLock, lockMatchesResolution } from './resolve.mjs';
import {
  approvalConsumptionId,
  completeApprovalConsumption,
  readConnectedApproval,
  reserveApprovalConsumption
} from './operator-authority.mjs';
import {
  hasAutomationDecisionState,
  hasApprovalConsumptionState,
  hasContextSnapshotState,
  hasHostCallCheckpoint,
  hasRunState,
  listHostCallCheckpointDocuments,
  readAutomationDecisionState,
  readContextSnapshotState,
  readHostCallCheckpoint,
  readRunState,
  writeAutomationDecisionState,
  writeContextSnapshotState,
  writeHostCallCheckpoint,
  writeRunState
} from './runtime-state.mjs';
import { connectedApprovalFingerprint } from './connected-transactions.mjs';

const EXECUTABLE_RUN_STATES = new Set(['effects-established', 'executing']);
const DURABLE_RUN_STATES = new Set(['effects-established', 'executing', 'paused']);

function contractFailures(root, value, schemaPath, label) {
  const schema = readJson(path.join(root, schemaPath));
  const failures = validateJsonSchema(value, schema);
  if (failures.length) {
    throw new Error(
      label + ' does not satisfy its contract: '
        + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function exactLock(root, lockPath, expectedHost) {
  const resolvedRoot = path.resolve(root);
  const file = resolveRepoPath(resolvedRoot, lockPath);
  const lock = readJson(file);
  contractFailures(resolvedRoot, lock, 'soter/contracts/lock.schema.json', 'Configuration lock');
  if (expectedHost && lock.host.id !== expectedHost) {
    throw new Error(
      'Configuration lock host ' + lock.host.id
        + ' does not match the active host projection ' + expectedHost + '.'
    );
  }
  const current = lockMatchesResolution({
    lock,
    root: resolvedRoot,
    configPath: lock.configuration.path
  });
  if (!current.matches) {
    throw new Error(
      'Configuration lock is stale: expected ' + current.expectedFingerprint
        + ' but observed ' + current.observedFingerprint + '.'
    );
  }
  return { file, lock };
}

function assertExactRun(root, lockFile, lock, run, allowedStates = EXECUTABLE_RUN_STATES) {
  contractFailures(root, run, 'soter/contracts/run-envelope.schema.json', 'Run envelope');
  const expectedLockPath = repoRelativePath(root, lockFile);
  if (run.configurationLock.path !== expectedLockPath
    || run.configurationLock.fingerprint !== fingerprintLock(lock)
    || run.graphFingerprint !== lock.graphFingerprint
    || fingerprintJson(run.host) !== fingerprintJson(lock.host)
    || fingerprintJson(run.bindings) !== fingerprintJson(lock.bindings)
    || fingerprintJson(run.effectPolicies) !== fingerprintJson(lock.effectPolicies)) {
    throw new Error('Run envelope does not match the exact lock, graph, host, bindings, and effect policy.');
  }
  const selectedAutomation = lock.packs.filter((pack) => {
    return pack.id === run.automation.id && pack.layer === 'automation';
  });
  const runAuthorities = run.context.map((item) => ({
    id: item.authority,
    subject: item.subject,
    role: item.role,
    uri: item.uri,
    declarationFingerprint: item.declarationFingerprint
  })).sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const lockAuthorities = lock.authorities.map((item) => ({
    id: item.id,
    subject: item.subject,
    role: item.role,
    uri: item.uri,
    declarationFingerprint: item.declarationFingerprint
  })).sort((left, right) => left.id.localeCompare(right.id, 'en'));
  if (selectedAutomation.length !== 1
    || selectedAutomation[0].version !== run.automation.version
    || fingerprintJson(runAuthorities) !== fingerprintJson(lockAuthorities)) {
    throw new Error(
      'Run envelope does not match the exact selected automation and authority declarations.'
    );
  }
  if (!allowedStates.has(run.lifecycleState)) {
    throw new Error(
      'Run envelope state ' + run.lifecycleState
        + ' cannot continue this host request.'
    );
  }
  return run;
}

function exactRun(root, lockFile, lock, runPath, allowedStates = EXECUTABLE_RUN_STATES) {
  const file = resolveRepoPath(root, runPath);
  const run = assertExactRun(root, lockFile, lock, readJson(file), allowedStates);
  return { file, run };
}

function atOrNow(at) {
  return at || new Date().toISOString();
}

function idPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function checkpointFingerprint(checkpoint) {
  const value = structuredClone(checkpoint);
  delete value.checkpointFingerprint;
  return fingerprintJson(value);
}

function sealCheckpoint(checkpoint) {
  return {
    ...checkpoint,
    checkpointFingerprint: checkpointFingerprint(checkpoint)
  };
}

function assertCheckpoint(root, checkpoint) {
  if (checkpoint?.$contract === 'soter://contracts/connected-transaction-checkpoint/v1') {
    return assertConnectedTransactionCheckpoint(root, checkpoint);
  }
  if (checkpoint?.$contract === 'soter://contracts/connected-transaction-checkpoint/v2') {
    return assertVerifiedConnectedTransactionCheckpoint(root, checkpoint);
  }
  if (checkpoint?.$contract === 'soter://contracts/operation-plan-checkpoint/v1'
    || checkpoint?.$contract === 'soter://contracts/operation-plan-checkpoint/v2') {
    return assertOperationPlanCheckpoint(root, checkpoint);
  }
  if (checkpoint?.$contract === 'soter://contracts/provider-probe-plan-checkpoint/v1') {
    return assertProviderProbePlanCheckpoint(root, checkpoint);
  }
  contractFailures(
    root,
    checkpoint,
    'soter/contracts/host-call-checkpoint.schema.json',
    'Host call checkpoint'
  );
  if (checkpoint.checkpointFingerprint !== checkpointFingerprint(checkpoint)) {
    throw new Error('Host call checkpoint fingerprint does not match its durable contents.');
  }
  if (checkpoint.state !== checkpoint.call.state
    || checkpoint.configurationLock.fingerprint
      !== checkpoint.call.configurationLockFingerprint
    || checkpoint.graphFingerprint !== checkpoint.call.graphFingerprint
    || fingerprintJson(checkpoint.host) !== fingerprintJson(checkpoint.call.host)) {
    throw new Error('Host call checkpoint metadata does not match its exact call record.');
  }
  if ((checkpoint.kind === 'capability') !== Boolean(checkpoint.run)
    || (checkpoint.kind === 'capability') !== Boolean(checkpoint.input)) {
    throw new Error('Host call checkpoint kind does not match its run and input state.');
  }
  const expectedCallContract = checkpoint.kind === 'capability'
    ? 'soter://contracts/host-tool-call/v1'
    : 'soter://contracts/provider-probe-call/v1';
  if (checkpoint.call.$contract !== expectedCallContract) {
    throw new Error('Host call checkpoint kind does not match its nested call contract.');
  }
  contractFailures(
    root,
    checkpoint.call,
    checkpoint.kind === 'capability'
      ? 'soter/contracts/host-tool-call.schema.json'
      : 'soter/contracts/provider-probe-call.schema.json',
    'Checkpoint call'
  );
  return checkpoint;
}

function durableRunIdentity(run) {
  return fingerprintJson({
    id: run.id,
    createdAt: run.createdAt,
    requestedOutcome: run.requestedOutcome,
    initiation: run.initiation,
    intent: run.intent,
    automation: run.automation,
    configurationLock: run.configurationLock,
    graphFingerprint: run.graphFingerprint,
    scenario: run.scenario || null,
    context: run.context,
    bindings: run.bindings,
    host: run.host,
    effectPolicies: run.effectPolicies
  });
}

function runCheckpointEntry(call) {
  return {
    id: 'host-call.' + call.id,
    kind: 'host-tool-call',
    callId: call.id,
    state: call.state,
    callFingerprint: fingerprintJson(call),
    updatedAt: call.completedAt || call.createdAt,
    details: call.state === 'requested'
      ? 'Core emitted one provider-neutral operation resolved to an exact native host tool; the native result is pending.'
      : 'Core closed the exact resolved provider request in state ' + call.state + '.'
  };
}

function effectIdForCall(call) {
  return 'effect.' + call.id.slice('toolcall.'.length);
}

function invocationFromCall(call) {
  if (call.state === 'requested') return null;
  return {
    id: effectIdForCall(call),
    capability: call.capability.id,
    capabilityVersion: call.capability.version,
    providerPack: call.provider.pack,
    providerImplementation: call.provider.implementation,
    providerVersion: call.provider.version,
    containment: call.provider.containment,
    authority: call.authority,
    startedAt: call.createdAt,
    completedAt: call.completedAt,
    declaredEffects: call.declaredEffects,
    policyDecisions: call.policyDecisions,
    state: call.state === 'completed' ? 'passed' : call.state,
    inputFingerprint: call.inputFingerprint,
    outputFingerprint: call.outputFingerprint,
    error: call.error
  };
}

function syncRunWithCheckpoint(run, checkpoint) {
  if (checkpoint.kind !== 'capability') return run;
  const next = structuredClone(run);
  const entry = runCheckpointEntry(checkpoint.call);
  const checkpointIndex = next.checkpoints.findIndex((item) => item.id === entry.id);
  if (checkpointIndex >= 0) {
    const current = next.checkpoints[checkpointIndex];
    if (checkpoint.call.state === 'requested'
      && ['completed', 'failed', 'blocked'].includes(current.state)) {
      return next;
    }
    next.checkpoints[checkpointIndex] = entry;
  } else {
    next.checkpoints.push(entry);
  }
  if (checkpoint.call.state === 'requested') {
    next.lifecycleState = 'executing';
    return next;
  }
  const invocation = invocationFromCall(checkpoint.call);
  const effectIndex = next.effects.findIndex((item) => item.id === invocation.id);
  if (effectIndex >= 0) next.effects[effectIndex] = invocation;
  else next.effects.push(invocation);
  if (checkpoint.call.state === 'completed' && checkpoint.call.outputFingerprint) {
    const output = {
      id: 'output.' + checkpoint.call.id.slice('toolcall.'.length),
      callId: checkpoint.call.id,
      capability: checkpoint.call.capability.id,
      fingerprint: checkpoint.call.outputFingerprint
    };
    const outputIndex = next.outputs.findIndex((item) => item.id === output.id);
    if (outputIndex >= 0) next.outputs[outputIndex] = output;
    else next.outputs.push(output);
    next.lifecycleState = 'executing';
  } else {
    next.lifecycleState = 'paused';
  }
  return next;
}

function operationPlanRunEntry(checkpoint) {
  const currentCall = operationPlanCurrentCall(checkpoint);
  return {
    id: 'operation-plan.' + checkpoint.plan.id,
    kind: 'operation-plan',
    planId: checkpoint.plan.id,
    state: checkpoint.state,
    planFingerprint: checkpoint.planFingerprint,
    currentStepId: checkpoint.currentStepId,
    currentCallId: currentCall?.id || null,
    updatedAt: checkpoint.updatedAt,
    details: checkpoint.state === 'requested'
      ? 'Core is waiting for the exact native result for step ' + checkpoint.currentStepId + '.'
      : 'Core closed the sequential operation plan in state ' + checkpoint.state + '.'
  };
}

function syncRunWithOperationPlan(run, checkpoint) {
  const priorLifecycle = run.lifecycleState;
  let next = structuredClone(run);
  for (const step of checkpoint.steps) {
    if (!step.call) continue;
    next = syncRunWithCheckpoint(next, { kind: 'capability', call: step.call });
  }
  const entry = operationPlanRunEntry(checkpoint);
  const index = next.checkpoints.findIndex((item) => item.id === entry.id);
  if (index >= 0) next.checkpoints[index] = entry;
  else next.checkpoints.push(entry);
  const laterLifecycle = ['verifying', 'completed', 'failed', 'paused'].includes(priorLifecycle);
  if (checkpoint.state === 'requested') {
    next.lifecycleState = 'executing';
  } else if (checkpoint.state === 'completed') {
    next.lifecycleState = laterLifecycle ? priorLifecycle : 'executing';
  } else {
    next.lifecycleState = ['completed', 'failed'].includes(priorLifecycle)
      ? priorLifecycle
      : 'paused';
  }
  return next;
}

function connectedTransactionRunEntry(checkpoint) {
  const verified = checkpoint.$contract
    === 'soter://contracts/connected-transaction-checkpoint/v2';
  const currentCall = verified
    ? verifiedConnectedTransactionCurrentCall(checkpoint)
    : connectedTransactionCurrentCall(checkpoint);
  const progressFingerprint = fingerprintJson({
    batchFingerprint: checkpoint.batchFingerprint,
    changeSetFingerprint: checkpoint.changeSetFingerprint,
    approvalFingerprint: checkpoint.approvalFingerprint,
    startedAt: checkpoint.startedAt,
    state: checkpoint.state,
    operations: checkpoint.operations.map((operation) => ({
      id: operation.id,
      state: operation.state,
      callFingerprints: (verified
        ? [
            operation.precondition,
            operation.write,
            operation.verification,
            ...operation.reconciliations.map((item) => item.phase)
          ]
        : [
            operation.compare,
            operation.write,
            operation.verification,
            operation.contentVerification,
            operation.compensation,
            operation.compensationVerification,
            ...operation.reconciliations.map((item) => item.phase)
          ]).filter(Boolean).map((phase) => fingerprintJson(phase.call)),
      ambiguities: verified ? (operation.ambiguity ? [operation.ambiguity] : []) : operation.ambiguities,
      reconciliations: operation.reconciliations.map((item) => ({
        id: item.id,
        ambiguityId: item.ambiguityId,
        outcome: item.outcome,
        observedVersion: item.observedVersion || null,
        observedFingerprint: item.observedFingerprint || null,
        outputFingerprint: item.phase.outputFingerprint
      }))
    })),
    current: checkpoint.current,
    result: checkpoint.result
  });
  return {
    id: 'connected-transaction.' + checkpoint.batch.id,
    kind: 'connected-transaction',
    batchId: checkpoint.batch.id,
    batchFingerprint: checkpoint.batch.batchFingerprint,
    changeSetId: checkpoint.changeSet.id,
    approvalId: checkpoint.approval.id,
    progressFingerprint,
    state: checkpoint.state,
    currentOperationId: checkpoint.current?.operationId || null,
    currentStage: checkpoint.current?.stage || null,
    currentCallId: currentCall?.id || null,
    updatedAt: checkpoint.updatedAt,
    details: checkpoint.state === 'requested'
      ? 'Core is waiting for the exact native result for connected transaction stage '
        + checkpoint.current.stage + '.'
      : 'Core closed the approval-bound connected transaction in state '
        + checkpoint.state + '.'
  };
}

function syncRunWithConnectedTransaction(run, checkpoint) {
  const priorLifecycle = run.lifecycleState;
  let next = structuredClone(run);
  const approvalIndex = next.approvals.findIndex((item) => item.id === checkpoint.approval.id);
  if (approvalIndex >= 0) {
    if (connectedApprovalFingerprint(next.approvals[approvalIndex])
      !== checkpoint.approvalFingerprint) {
      throw new Error('Durable run contains a conflicting connected transaction approval.');
    }
  } else {
    next.approvals.push(structuredClone(checkpoint.approval));
  }
  const verified = checkpoint.$contract
    === 'soter://contracts/connected-transaction-checkpoint/v2';
  for (const operation of checkpoint.operations) {
    for (const name of (verified
      ? ['precondition', 'write', 'verification']
      : [
          'compare', 'write', 'verification', 'contentVerification',
          'compensation', 'compensationVerification'
        ])) {
      const call = operation[name]?.call;
      if (call) next = syncRunWithCheckpoint(next, { kind: 'capability', call });
    }
    for (const reconciliation of operation.reconciliations) {
      next = syncRunWithCheckpoint(next, {
        kind: 'capability',
        call: reconciliation.phase.call
      });
    }
  }
  const entry = connectedTransactionRunEntry(checkpoint);
  const index = next.checkpoints.findIndex((item) => item.id === entry.id);
  if (index >= 0) next.checkpoints[index] = entry;
  else next.checkpoints.push(entry);
  const laterLifecycle = ['verifying', 'completed', 'failed', 'paused'].includes(priorLifecycle);
  if (checkpoint.state === 'requested') {
    next.lifecycleState = 'executing';
  } else if (checkpoint.state === 'completed') {
    next.lifecycleState = laterLifecycle ? priorLifecycle : 'executing';
  } else {
    next.lifecycleState = ['completed', 'failed'].includes(priorLifecycle)
      ? priorLifecycle
      : 'paused';
  }
  return next;
}

export async function prepareProviderProbeExecution({
  root,
  lockPath,
  providerImplementation,
  callId,
  probeId,
  at,
  validForSeconds = 300,
  expectedHost
}) {
  const createdAt = atOrNow(at);
  const { lock } = exactLock(root, lockPath, expectedHost);
  const providerPart = idPart(
    providerImplementation.startsWith('provider.')
      ? providerImplementation.slice('provider.'.length)
      : providerImplementation
  );
  return prepareProviderProbeCall({
    root,
    lock,
    providerImplementation,
    callId: callId || 'probecall.' + idPart(lock.configuration.name) + '.' + idPart(createdAt),
    probeId: probeId || 'probe.' + providerPart + '.' + idPart(createdAt),
    at: createdAt,
    validForSeconds
  });
}

export async function completeProviderProbeExecution({
  root,
  lockPath,
  call,
  response,
  at,
  expectedHost
}) {
  const { lock } = exactLock(root, lockPath, expectedHost);
  return completeProviderProbeCall({
    root,
    lock,
    call,
    response,
    at: atOrNow(at)
  });
}

export async function prepareCapabilityExecution({
  root,
  lockPath,
  runPath,
  capability,
  authority,
  providerImplementation,
  input,
  callId,
  at,
  expectedHost
}) {
  const createdAt = atOrNow(at);
  const { file: lockFile, lock } = exactLock(root, lockPath, expectedHost);
  const { run } = exactRun(path.resolve(root), lockFile, lock, runPath);
  return prepareHostToolCall({
    root,
    lock,
    runId: run.id,
    callId: callId || 'toolcall.' + idPart(run.id.slice('run.'.length)) + '.' + idPart(createdAt),
    capability,
    authority,
    containment: 'connected',
    providerImplementation,
    input,
    at: createdAt,
    approvedEffects: []
  });
}

export async function completeCapabilityExecution({
  root,
  lockPath,
  runPath,
  call,
  input,
  response,
  at,
  expectedHost
}) {
  const { file: lockFile, lock } = exactLock(root, lockPath, expectedHost);
  const { run } = exactRun(path.resolve(root), lockFile, lock, runPath);
  if (call.runId !== run.id) {
    throw new Error('Host tool call does not belong to the supplied exact run envelope.');
  }
  return completeHostToolCall({
    root,
    lock,
    call,
    input,
    response,
    at: atOrNow(at)
  });
}

export function failHostExecution({
  root,
  lockPath,
  runPath,
  call,
  errorKind,
  message,
  at,
  expectedHost
}) {
  const { file: lockFile, lock } = exactLock(root, lockPath, expectedHost);
  const error = { kind: errorKind, message };
  if (call?.$contract === 'soter://contracts/provider-probe-call/v1') {
    if (runPath) {
      throw new Error('Provider probe failures do not accept a run envelope.');
    }
    return {
      call: failProviderProbeCall({ root, lock, call, error, at: atOrNow(at) })
    };
  }
  if (call?.$contract === 'soter://contracts/host-tool-call/v1') {
    if (!runPath) throw new Error('Capability call failures require runPath.');
    const { run } = exactRun(path.resolve(root), lockFile, lock, runPath);
    if (call.runId !== run.id) {
      throw new Error('Host tool call does not belong to the supplied exact run envelope.');
    }
    return {
      call: failHostToolCall({ root, lock, call, error, at: atOrNow(at) })
    };
  }
  throw new Error('Unsupported host call contract.');
}

function baseDurableCheckpoint({ root, lockFile, lock, kind, call, input, result, run, at }) {
  return {
    $contract: 'soter://contracts/host-call-checkpoint/v1',
    contractVersion: '1.0.0',
    id: 'checkpoint.' + call.id,
    kind,
    createdAt: call.createdAt,
    updatedAt: at,
    state: call.state,
    configurationLock: {
      path: repoRelativePath(root, lockFile),
      fingerprint: fingerprintLock(lock)
    },
    graphFingerprint: lock.graphFingerprint,
    host: structuredClone(call.host),
    run,
    call: structuredClone(call),
    input: input ? structuredClone(input) : null,
    result: result ? structuredClone(result) : null,
    privacy: {
      scope: 'private',
      rawProviderResponsePersisted: false,
      hostCredentialValuesPersisted: false
    },
    checkpointFingerprint: fingerprintJson(null)
  };
}

function persistDurableCheckpoint(root, checkpoint, run = null) {
  let next = structuredClone(checkpoint);
  let nextRun = run
    ? (next.kind === 'operation-plan'
      ? syncRunWithOperationPlan(run, next)
      : next.kind === 'connected-transaction'
        ? syncRunWithConnectedTransaction(run, next)
        : syncRunWithCheckpoint(run, next))
    : null;
  if (nextRun) {
    next.run.fingerprint = fingerprintJson(nextRun);
  }
  next = sealCheckpoint(next);
  const checkpointState = writeHostCallCheckpoint(root, next);
  const runState = nextRun ? writeRunState(root, nextRun) : null;
  const persisted = {
    checkpoint: next,
    checkpointPath: checkpointState.path,
    run: nextRun,
    runPath: runState?.path || null
  };
  if (next.kind === 'operation-plan') {
    persisted.currentCall = operationPlanCurrentCall(next);
  } else if (next.kind === 'connected-transaction') {
    persisted.currentCall = next.$contract
      === 'soter://contracts/connected-transaction-checkpoint/v2'
      ? verifiedConnectedTransactionCurrentCall(next)
      : connectedTransactionCurrentCall(next);
  } else if (next.$contract === 'soter://contracts/provider-probe-plan-checkpoint/v1') {
    persisted.currentCall = providerProbePlanCurrentCall(next);
  }
  return persisted;
}

function stageDurableRun(root, lockFile, lock, runPath, allowedStates = EXECUTABLE_RUN_STATES) {
  const source = exactRun(root, lockFile, lock, runPath, allowedStates);
  const sourcePath = repoRelativePath(root, source.file);
  if (!hasRunState(root, source.run.id)) {
    const state = writeRunState(root, structuredClone(source.run));
    return {
      run: structuredClone(source.run),
      sourcePath,
      statePath: state.path
    };
  }
  const state = readRunState(root, source.run.id);
  const run = assertExactRun(root, lockFile, lock, state.run, allowedStates);
  if (durableRunIdentity(run) !== durableRunIdentity(source.run)) {
    throw new Error('Durable run state does not match the supplied run envelope identity.');
  }
  return {
    run,
    sourcePath,
    statePath: repoRelativePath(root, state.file)
  };
}

function loadedCheckpoint(root, checkpointId, expectedHost) {
  const state = readHostCallCheckpoint(root, checkpointId);
  const checkpoint = assertCheckpoint(path.resolve(root), state.checkpoint);
  if (expectedHost && checkpoint.host.id !== expectedHost) {
    throw new Error(
      'Host call checkpoint belongs to ' + checkpoint.host.id
        + ', not the active ' + expectedHost + ' host projection.'
    );
  }
  return { checkpointFile: state.file, checkpoint };
}

function exactCheckpoint(root, checkpointId, expectedHost) {
  const state = loadedCheckpoint(root, checkpointId, expectedHost);
  const lockState = exactLock(root, state.checkpoint.configurationLock.path, expectedHost);
  if (state.checkpoint.configurationLock.fingerprint !== fingerprintLock(lockState.lock)
    || state.checkpoint.graphFingerprint !== lockState.lock.graphFingerprint) {
    throw new Error('Host call checkpoint does not match the current exact lock and graph.');
  }
  return {
    checkpointFile: state.checkpointFile,
    checkpoint: state.checkpoint,
    lockFile: lockState.file,
    lock: lockState.lock
  };
}

function durableRunForCheckpoint(root, lockFile, lock, checkpoint) {
  if (!checkpoint.run) return null;
  const state = readRunState(root, checkpoint.run.id);
  if (repoRelativePath(root, state.file) !== checkpoint.run.statePath) {
    throw new Error('Host call checkpoint points to an unexpected durable run path.');
  }
  const allowedStates = checkpoint.state === 'requested'
    ? EXECUTABLE_RUN_STATES
    : DURABLE_RUN_STATES;
  let run = assertExactRun(root, lockFile, lock, state.run, allowedStates);
  if (checkpoint.kind === 'connected-transaction') {
    const expectedEntry = connectedTransactionRunEntry(checkpoint);
    const currentEntry = run.checkpoints.find((item) => item.id === expectedEntry.id);
    if (currentEntry
      && currentEntry.progressFingerprint !== expectedEntry.progressFingerprint
      && Date.parse(currentEntry.updatedAt) > Date.parse(checkpoint.updatedAt)) {
      throw new Error(
        'Durable run contains connected transaction state newer than the checkpoint.'
      );
    }
    const repaired = syncRunWithConnectedTransaction(run, checkpoint);
    if (fingerprintJson(repaired) !== fingerprintJson(run)) {
      writeRunState(root, repaired);
      run = repaired;
    }
    return run;
  }
  if (checkpoint.kind === 'operation-plan') {
    const currentPlanEntry = run.checkpoints.find((item) => {
      return item.id === 'operation-plan.' + checkpoint.plan.id;
    });
    if (currentPlanEntry
      && (currentPlanEntry.planFingerprint !== checkpoint.planFingerprint
        || Date.parse(currentPlanEntry.updatedAt) > Date.parse(checkpoint.updatedAt))) {
      throw new Error('Durable run contains operation-plan state newer than or unrelated to the checkpoint.');
    }
    const repaired = syncRunWithOperationPlan(run, checkpoint);
    if (fingerprintJson(repaired) !== fingerprintJson(run)) {
      writeRunState(root, repaired);
      run = repaired;
    }
    return run;
  }
  const expectedEntry = runCheckpointEntry(checkpoint.call);
  const currentEntry = run.checkpoints.find((item) => item.id === expectedEntry.id);
  if (currentEntry && currentEntry.callFingerprint !== expectedEntry.callFingerprint) {
    const checkpointProgressed = currentEntry.state === 'requested'
      && ['completed', 'failed', 'blocked'].includes(checkpoint.call.state);
    const runProgressed = checkpoint.call.state === 'requested'
      && ['completed', 'failed', 'blocked'].includes(currentEntry.state);
    if (checkpointProgressed) {
      run = syncRunWithCheckpoint(run, checkpoint);
      writeRunState(root, run);
    } else if (!runProgressed) {
      throw new Error('Durable run checkpoint conflicts with the exact host call checkpoint.');
    }
  } else if (!currentEntry) {
    run = syncRunWithCheckpoint(run, checkpoint);
    writeRunState(root, run);
  }
  return run;
}

function pendingCheckpointForRun(root, runId, expectedHost) {
  return listHostCallCheckpointDocuments(root)
    .map((item) => assertCheckpoint(path.resolve(root), item.checkpoint))
    .find((checkpoint) => {
      return (!expectedHost || checkpoint.host.id === expectedHost)
        && (checkpoint.kind === 'capability'
          || checkpoint.kind === 'operation-plan'
          || checkpoint.kind === 'connected-transaction')
        && checkpoint.run?.id === runId
        && checkpoint.state === 'requested';
    }) || null;
}

export async function prepareDurableOperationPlanExecution({
  root,
  lockPath,
  runPath,
  plan,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  assertOperationPlanDocument(resolvedRoot, plan);
  if (containsCredentialMaterial(plan)) {
    throw new Error('Operation plan contains credential-like material and cannot enter durable state.');
  }
  const { file: lockFile, lock } = exactLock(resolvedRoot, lockPath, expectedHost);
  const createdAt = atOrNow(at || plan.createdAt);
  await preflightOperationPlanSteps({
    root: resolvedRoot,
    lock,
    plan,
    at: createdAt
  });
  const durable = stageDurableRun(resolvedRoot, lockFile, lock, runPath);
  const pending = pendingCheckpointForRun(resolvedRoot, durable.run.id, expectedHost);
  if (pending) {
    throw new Error(
      'Run ' + durable.run.id + ' already has pending host checkpoint ' + pending.id + '.'
    );
  }
  let checkpoint = createOperationPlanCheckpoint({
    root: resolvedRoot,
    lock,
    lockPath: repoRelativePath(resolvedRoot, lockFile),
    run: durable.run,
    runSourcePath: durable.sourcePath,
    runStatePath: durable.statePath,
    plan,
    at: createdAt
  });
  if (hasHostCallCheckpoint(resolvedRoot, checkpoint.id)) {
    throw new Error('Durable operation plan checkpoint already exists: ' + checkpoint.id + '.');
  }
  checkpoint = await requestNextOperationPlanStep({
    root: resolvedRoot,
    lock,
    checkpoint,
    at: createdAt
  });
  return persistDurableCheckpoint(resolvedRoot, checkpoint, durable.run);
}

async function createApprovedConnectedCheckpoint(options) {
  return options.batch.$contract === 'soter://contracts/connected-operation-batch/v2'
    ? createVerifiedConnectedTransactionCheckpoint(options)
    : createConnectedTransactionCheckpoint(options);
}

export async function prepareDurableConnectedTransactionExecution({
  root,
  approvalId,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const requestedAt = atOrNow(at);
  const approval = readConnectedApproval({
    root: resolvedRoot,
    approvalId,
    at: requestedAt,
    allowExpired: true
  });
  const { batch, changeSet } = approval.request;
  if (containsCredentialMaterial({ approval })) {
    throw new Error(
      'Connected transaction sources contain credential-like material and cannot enter durable state.'
    );
  }
  const { file: lockFile, lock } = exactLock(
    resolvedRoot,
    approval.request.configuration.lockPath,
    expectedHost
  );
  const hasConsumption = hasApprovalConsumptionState(
    resolvedRoot,
    approvalConsumptionId(approval.id)
  );
  if (!hasConsumption) {
    readConnectedApproval({
      root: resolvedRoot,
      approvalId,
      at: requestedAt,
      allowExpired: true,
      lock,
      run: readJson(resolveRepoPath(resolvedRoot, approval.request.run.path))
    });
  }
  const durable = stageDurableRun(
    resolvedRoot,
    lockFile,
    lock,
    approval.request.run.path,
    DURABLE_RUN_STATES
  );
  const pending = pendingCheckpointForRun(resolvedRoot, durable.run.id, expectedHost);
  const checkpointId = 'checkpoint.transaction.' + batch.id.slice('batch.'.length);
  if (pending && pending.id !== checkpointId) {
    throw new Error(
      'Run ' + durable.run.id + ' already has pending host checkpoint ' + pending.id + '.'
    );
  }
  if (!hasConsumption && hasHostCallCheckpoint(resolvedRoot, checkpointId)) {
    throw new Error('Durable checkpoint exists without its one-time approval consumption.');
  }
  let checkpoint = null;
  let reservation = null;
  if (hasConsumption) {
    reservation = reserveApprovalConsumption({
      root: resolvedRoot,
      approval,
      checkpointId,
      at: requestedAt
    });
  } else {
    checkpoint = await createApprovedConnectedCheckpoint({
      root: resolvedRoot,
      lock,
      lockPath: repoRelativePath(resolvedRoot, lockFile),
      run: durable.run,
      runSourcePath: durable.sourcePath,
      runStatePath: durable.statePath,
      batch,
      changeSet,
      approval,
      at: requestedAt
    });
    reservation = reserveApprovalConsumption({
      root: resolvedRoot,
      approval,
      checkpointId,
      at: requestedAt
    });
  }
  if (hasHostCallCheckpoint(resolvedRoot, checkpointId)) {
    const existing = exactCheckpoint(resolvedRoot, checkpointId, expectedHost);
    if (existing.checkpoint.approvalFingerprint !== connectedApprovalFingerprint(approval)) {
      throw new Error('Durable checkpoint belongs to a different exact approval.');
    }
    const completed = completeApprovalConsumption({
      root: resolvedRoot,
      consumption: reservation.consumption,
      checkpoint: existing.checkpoint,
      at: requestedAt
    });
    return {
      ...durableResult(resolvedRoot, existing),
      approvalConsumption: completed.consumption
    };
  }
  if (reservation.consumption.state === 'started') {
    throw new Error('Started approval consumption is missing its durable checkpoint.');
  }
  if (!checkpoint || checkpoint.createdAt !== reservation.consumption.createdAt) {
    checkpoint = await createApprovedConnectedCheckpoint({
      root: resolvedRoot,
      lock,
      lockPath: repoRelativePath(resolvedRoot, lockFile),
      run: durable.run,
      runSourcePath: durable.sourcePath,
      runStatePath: durable.statePath,
      batch,
      changeSet,
      approval,
      at: reservation.consumption.createdAt
    });
  }
  const persisted = persistDurableCheckpoint(resolvedRoot, checkpoint, durable.run);
  const completed = completeApprovalConsumption({
    root: resolvedRoot,
    consumption: reservation.consumption,
    checkpoint: persisted.checkpoint,
    at: requestedAt
  });
  return { ...persisted, approvalConsumption: completed.consumption };
}

export async function prepareDurableConnectedTransactionReconciliation({
  root,
  checkpointId,
  at,
  expectedHost
}) {
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  const checkpoint = state.checkpoint;
  if (checkpoint.kind !== 'connected-transaction') {
    throw new Error('Checkpoint ' + checkpointId + ' is not a connected transaction.');
  }
  if (checkpoint.state === 'requested' && checkpoint.current?.stage === 'reconcile') {
    return durableResult(root, state);
  }
  const run = durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint);
  const reconcile = checkpoint.$contract
    === 'soter://contracts/connected-transaction-checkpoint/v2'
    ? prepareVerifiedConnectedTransactionReconciliation
    : prepareConnectedTransactionReconciliation;
  const next = await reconcile({ root, lock: state.lock, checkpoint, at: atOrNow(at) });
  return persistDurableCheckpoint(root, next, run);
}

export async function prepareDurableProviderProbeExecution(options) {
  const { file: lockFile, lock } = exactLock(
    options.root,
    options.lockPath,
    options.expectedHost
  );
  const createdAt = atOrNow(options.at);
  const providerPart = idPart(
    options.providerImplementation.startsWith('provider.')
      ? options.providerImplementation.slice('provider.'.length)
      : options.providerImplementation
  );
  const probeId = options.probeId || 'probe.' + providerPart + '.' + idPart(createdAt);
  if (providerUsesProbePlan(options.root, lock, options.providerImplementation)) {
    if (options.callId) {
      throw new Error('Multi-step provider probes use deterministic per-step call IDs.');
    }
    const checkpoint = await createProviderProbePlanCheckpoint({
      root: options.root,
      lock,
      lockPath: repoRelativePath(options.root, lockFile),
      providerImplementation: options.providerImplementation,
      probeId,
      validForSeconds: options.validForSeconds ?? 300,
      at: createdAt
    });
    if (hasHostCallCheckpoint(options.root, checkpoint.id)) {
      throw new Error('Durable provider probe checkpoint already exists: ' + checkpoint.id + '.');
    }
    return persistDurableCheckpoint(options.root, checkpoint);
  }
  const prepared = await prepareProviderProbeExecution({
    ...options,
    probeId,
    at: createdAt
  });
  const at = prepared.call.createdAt;
  const checkpoint = baseDurableCheckpoint({
    root: options.root,
    lockFile,
    lock,
    kind: 'provider-probe',
    call: prepared.call,
    input: null,
    result: null,
    run: null,
    at
  });
  if (hasHostCallCheckpoint(options.root, checkpoint.id)) {
    throw new Error('Durable host call checkpoint already exists: ' + checkpoint.id + '.');
  }
  return persistDurableCheckpoint(options.root, checkpoint);
}

export async function prepareDurableCapabilityExecution(options) {
  const { file: lockFile, lock } = exactLock(
    options.root,
    options.lockPath,
    options.expectedHost
  );
  if (containsCredentialMaterial(options.input)) {
    throw new Error('Capability input contains credential-like material and cannot enter durable state.');
  }
  const durable = stageDurableRun(path.resolve(options.root), lockFile, lock, options.runPath);
  const pending = pendingCheckpointForRun(options.root, durable.run.id, options.expectedHost);
  if (pending) {
    throw new Error(
      'Run ' + durable.run.id + ' already has pending host call checkpoint ' + pending.id + '.'
    );
  }
  const createdAt = atOrNow(options.at);
  const prepared = await prepareHostToolCall({
    root: options.root,
    lock,
    runId: durable.run.id,
    callId: options.callId || 'toolcall.'
      + idPart(durable.run.id.slice('run.'.length)) + '.' + idPart(createdAt),
    capability: options.capability,
    authority: options.authority,
    containment: 'connected',
    providerImplementation: options.providerImplementation,
    input: options.input,
    at: createdAt,
    approvedEffects: []
  });
  const checkpoint = baseDurableCheckpoint({
    root: options.root,
    lockFile,
    lock,
    kind: 'capability',
    call: prepared.call,
    input: options.input,
    result: null,
    run: {
      id: durable.run.id,
      sourcePath: durable.sourcePath,
      statePath: durable.statePath,
      fingerprint: fingerprintJson(durable.run)
    },
    at: createdAt
  });
  if (hasHostCallCheckpoint(options.root, checkpoint.id)) {
    throw new Error('Durable host call checkpoint already exists: ' + checkpoint.id + '.');
  }
  return persistDurableCheckpoint(options.root, checkpoint, durable.run);
}

function durableResult(root, state) {
  const run = state.checkpoint.kind === 'capability'
    || state.checkpoint.kind === 'operation-plan'
    || state.checkpoint.kind === 'connected-transaction'
    ? durableRunForCheckpoint(root, state.lockFile, state.lock, state.checkpoint)
    : null;
  const result = {
    checkpoint: state.checkpoint,
    checkpointPath: repoRelativePath(root, state.checkpointFile),
    run,
    runPath: run ? repoRelativePath(root, readRunState(root, run.id).file) : null
  };
  if (state.checkpoint.kind === 'operation-plan') {
    result.currentCall = operationPlanCurrentCall(state.checkpoint);
  } else if (state.checkpoint.kind === 'connected-transaction') {
    result.currentCall = connectedTransactionCurrentCall(state.checkpoint);
  } else if (state.checkpoint.$contract
    === 'soter://contracts/provider-probe-plan-checkpoint/v1') {
    result.currentCall = providerProbePlanCurrentCall(state.checkpoint);
  }
  return result;
}

export async function completeDurableOperationPlanExecution({
  root,
  checkpointId,
  callId,
  response,
  at,
  expectedHost
}) {
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  const checkpoint = state.checkpoint;
  if (checkpoint.kind !== 'operation-plan') {
    throw new Error('Checkpoint ' + checkpointId + ' is not an operation plan.');
  }
  const run = durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint);
  const completed = await completeOperationPlanStep({
    root,
    lock: state.lock,
    checkpoint,
    callId,
    response,
    at: atOrNow(at)
  });
  if (completed.idempotent) return durableResult(root, state);
  return persistDurableCheckpoint(root, completed.checkpoint, run);
}

export async function completeDurableConnectedTransactionExecution({
  root,
  checkpointId,
  callId,
  response,
  at,
  expectedHost
}) {
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  const checkpoint = state.checkpoint;
  if (checkpoint.kind !== 'connected-transaction') {
    throw new Error('Checkpoint ' + checkpointId + ' is not a connected transaction.');
  }
  if (!callId) throw new Error('Connected transaction completion requires the exact current call ID.');
  const run = durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint);
  const complete = checkpoint.$contract
    === 'soter://contracts/connected-transaction-checkpoint/v2'
    ? completeVerifiedConnectedTransactionCall
    : completeConnectedTransactionCall;
  const completed = await complete({
    root, lock: state.lock, checkpoint, callId, response, at: atOrNow(at)
  });
  if (completed.idempotent) return durableResult(root, state);
  return persistDurableCheckpoint(root, completed.checkpoint, run);
}

export async function completeDurableProviderProbeExecution({
  root,
  checkpointId,
  callId,
  response,
  at,
  expectedHost
}) {
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  const checkpoint = state.checkpoint;
  if (checkpoint.kind !== 'provider-probe') {
    throw new Error('Checkpoint ' + checkpointId + ' is not a provider probe call.');
  }
  if (checkpoint.$contract === 'soter://contracts/provider-probe-plan-checkpoint/v1') {
    if (!callId) throw new Error('Provider probe plans require the exact current call ID.');
    const completed = await completeProviderProbePlanStep({
      root,
      lock: state.lock,
      checkpoint,
      callId,
      response,
      at: atOrNow(at)
    });
    if (completed.idempotent) return durableResult(root, state);
    return persistDurableCheckpoint(root, completed.checkpoint);
  }
  const responseFingerprint = fingerprintJson(response);
  if (checkpoint.state !== 'requested') {
    if (checkpoint.call.responseFingerprint === responseFingerprint) {
      return durableResult(root, state);
    }
    throw new Error('Only a requested provider probe checkpoint can accept a response.');
  }
  const completedAt = atOrNow(at);
  const completed = await completeProviderProbeCall({
    root,
    lock: state.lock,
    call: checkpoint.call,
    response,
    at: completedAt
  });
  const next = {
    ...checkpoint,
    updatedAt: completedAt,
    state: completed.call.state,
    call: completed.call,
    result: completed.call.state === 'completed' ? completed.probe : null
  };
  return persistDurableCheckpoint(root, next);
}

export async function completeDurableCapabilityExecution({
  root,
  checkpointId,
  response,
  at,
  expectedHost
}) {
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  const checkpoint = state.checkpoint;
  if (checkpoint.kind !== 'capability') {
    throw new Error('Checkpoint ' + checkpointId + ' is not a capability call.');
  }
  const responseFingerprint = fingerprintJson(response);
  if (checkpoint.state !== 'requested') {
    if (checkpoint.call.responseFingerprint === responseFingerprint) {
      return durableResult(root, state);
    }
    throw new Error('Only a requested capability checkpoint can accept a response.');
  }
  const run = durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint);
  const completedAt = atOrNow(at);
  const completed = await completeHostToolCall({
    root,
    lock: state.lock,
    call: checkpoint.call,
    input: checkpoint.input,
    response,
    at: completedAt
  });
  const next = {
    ...checkpoint,
    updatedAt: completedAt,
    state: completed.call.state,
    call: completed.call,
    result: completed.call.state === 'completed' ? completed.output : null
  };
  return persistDurableCheckpoint(root, next, run);
}

export async function failDurableHostExecution({
  root,
  checkpointId,
  errorKind,
  message,
  callId,
  at,
  expectedHost
}) {
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  const checkpoint = state.checkpoint;
  if (checkpoint.kind === 'connected-transaction') {
    if (!callId) throw new Error('Connected transaction failures require the exact current call ID.');
    const run = durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint);
    const fail = checkpoint.$contract
      === 'soter://contracts/connected-transaction-checkpoint/v2'
      ? failVerifiedConnectedTransactionCall
      : failConnectedTransactionCall;
    const failed = await fail({
      root, lock: state.lock, checkpoint, callId,
      error: { kind: errorKind, message }, at: atOrNow(at)
    });
    return persistDurableCheckpoint(root, failed, run);
  }
  if (checkpoint.kind === 'operation-plan') {
    if (!callId) throw new Error('Operation plan failures require the exact current call ID.');
    const run = durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint);
    const failed = failOperationPlanStep({
      root,
      lock: state.lock,
      checkpoint,
      callId,
      error: { kind: errorKind, message },
      at: atOrNow(at)
    });
    if (failed.idempotent) return durableResult(root, state);
    return persistDurableCheckpoint(root, failed.checkpoint, run);
  }
  if (checkpoint.$contract === 'soter://contracts/provider-probe-plan-checkpoint/v1') {
    if (!callId) throw new Error('Provider probe plan failures require the exact current call ID.');
    const failed = failProviderProbePlanStep({
      root,
      lock: state.lock,
      checkpoint,
      callId,
      error: { kind: errorKind, message },
      at: atOrNow(at)
    });
    if (failed.idempotent) return durableResult(root, state);
    return persistDurableCheckpoint(root, failed.checkpoint);
  }
  if (checkpoint.state !== 'requested') {
    if (checkpoint.call.error?.kind === errorKind && checkpoint.call.error?.message === message) {
      return durableResult(root, state);
    }
    throw new Error('Only a requested host call checkpoint can record a host failure.');
  }
  if (callId && checkpoint.call.id !== callId) {
    throw new Error('Host failure does not match the exact checkpoint call ID.');
  }
  const completedAt = atOrNow(at);
  const failedCall = checkpoint.kind === 'capability'
    ? failHostToolCall({
      root,
      lock: state.lock,
      call: checkpoint.call,
      error: { kind: errorKind, message },
      at: completedAt
    })
    : failProviderProbeCall({
      root,
      lock: state.lock,
      call: checkpoint.call,
      error: { kind: errorKind, message },
      at: completedAt
    });
  const next = {
    ...checkpoint,
    updatedAt: completedAt,
    state: failedCall.state,
    call: failedCall,
    result: null
  };
  const run = checkpoint.kind === 'capability'
    ? durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint)
    : null;
  return persistDurableCheckpoint(root, next, run);
}

export function getDurableHostExecution({ root, checkpointId, expectedHost }) {
  const state = loadedCheckpoint(root, checkpointId, expectedHost);
  const result = {
    checkpoint: state.checkpoint,
    checkpointPath: repoRelativePath(root, state.checkpointFile)
  };
  if (state.checkpoint.kind === 'operation-plan') {
    result.currentCall = operationPlanCurrentCall(state.checkpoint);
  } else if (state.checkpoint.kind === 'connected-transaction') {
    result.currentCall = connectedTransactionCurrentCall(state.checkpoint);
  } else if (state.checkpoint.$contract
    === 'soter://contracts/provider-probe-plan-checkpoint/v1') {
    result.currentCall = providerProbePlanCurrentCall(state.checkpoint);
  }
  return result;
}

export function getExactDurableHostExecution({ root, checkpointId, expectedHost }) {
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  return durableResult(root, state);
}

function replaceExactById(items, value, label) {
  const next = structuredClone(items);
  const index = next.findIndex((item) => item.id === value.id);
  if (index >= 0) {
    if (fingerprintJson(next[index]) !== fingerprintJson(value)) {
      throw new Error(label + ' conflicts with existing durable state: ' + value.id + '.');
    }
  } else {
    next.push(value);
  }
  return next;
}

function assertSnapshotEntryMatchesStep(entry, step) {
  const call = step.call;
  if (entry.valueFingerprint !== step.outputFingerprint
    || fingerprintJson(entry.value) !== step.outputFingerprint
    || entry.authority !== call.authority
    || entry.capability !== call.capability.id
    || entry.providerPack !== call.provider.pack
    || entry.providerImplementation !== call.provider.implementation
    || entry.providerVersion !== call.provider.version
    || entry.observedAt !== step.output.observedAt
    || fingerprintJson(entry.provenance) !== fingerprintJson(step.output.provenance)) {
    return false;
  }
  return true;
}

export function commitDurableContextSnapshot({
  root,
  checkpointId,
  snapshot,
  contextUpdates,
  checkpointDetails,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const state = exactCheckpoint(resolvedRoot, checkpointId, expectedHost);
  const checkpoint = state.checkpoint;
  if (checkpoint.kind !== 'operation-plan' || checkpoint.state !== 'completed') {
    throw new Error('Context snapshots can commit only from a completed operation plan.');
  }
  contractFailures(
    resolvedRoot,
    snapshot,
    'soter/contracts/context-snapshot.schema.json',
    'Context snapshot'
  );
  if (snapshot.privacy.scope !== 'private'
    || snapshot.containment !== 'connected'
    || containsCredentialMaterial(snapshot)) {
    throw new Error('Connected context snapshots must remain private and credential-free.');
  }
  if (typeof checkpointDetails !== 'string'
    || checkpointDetails.length < 12
    || containsCredentialMaterial(checkpointDetails)
    || containsCredentialMaterial(contextUpdates)) {
    throw new Error('Context snapshot commit metadata must be explicit and credential-free.');
  }
  if (snapshot.runId !== checkpoint.run.id
    || snapshot.createdAt !== checkpoint.updatedAt
    || snapshot.configurationLockFingerprint !== checkpoint.configurationLock.fingerprint
    || snapshot.graphFingerprint !== checkpoint.graphFingerprint) {
    throw new Error(
      'Context snapshot does not match the exact operation plan run, completion, lock, and graph.'
    );
  }

  const completedSteps = checkpoint.steps.filter((step) => {
    return step.state === 'completed' && step.call && step.output && step.outputFingerprint;
  });
  const terminalContextSteps = checkpoint.steps.every((step) => {
    return step.state === 'completed' || step.state === 'skipped';
  });
  if (!terminalContextSteps
    || completedSteps.length < 1
    || snapshot.entries.length !== completedSteps.length) {
    throw new Error(
      'Context snapshot must represent every completed output exactly once and omit only explicitly skipped steps.'
    );
  }
  if (new Set(snapshot.entries.map((entry) => entry.id)).size !== snapshot.entries.length) {
    throw new Error('Context snapshot entry identifiers must be unique.');
  }
  const matchedStepIds = new Set();
  for (const entry of snapshot.entries) {
    const matches = completedSteps.filter((step) => {
      return !matchedStepIds.has(step.id) && assertSnapshotEntryMatchesStep(entry, step);
    });
    if (matches.length !== 1) {
      throw new Error(
        'Context snapshot entry ' + entry.id
          + ' does not bind exactly one normalized operation-plan output.'
      );
    }
    matchedStepIds.add(matches[0].id);
  }
  const expectedEffectIds = completedSteps.map((step) => effectIdForCall(step.call)).sort();
  const snapshotEffectIds = [...snapshot.effectIds].sort();
  if (fingerprintJson(snapshotEffectIds) !== fingerprintJson(expectedEffectIds)) {
    throw new Error('Context snapshot effects do not match the completed operation plan exactly.');
  }

  const run = durableRunForCheckpoint(
    resolvedRoot,
    state.lockFile,
    state.lock,
    checkpoint
  );
  if (!run || run.id !== snapshot.runId) {
    throw new Error('Context snapshot does not match its durable run.');
  }
  for (const entry of snapshot.entries) {
    const authorities = run.context.filter((item) => item.authority === entry.authority);
    if (authorities.length !== 1
      || authorities[0].subject !== entry.subject
      || authorities[0].role !== entry.role) {
      throw new Error(
        'Context snapshot entry ' + entry.id
          + ' does not match its run authority subject and role.'
      );
    }
  }
  for (const effectId of expectedEffectIds) {
    if (!run.effects.some((item) => item.id === effectId && item.state === 'passed')) {
      throw new Error('Durable run is missing completed context effect ' + effectId + '.');
    }
  }
  if (!Array.isArray(contextUpdates)
    || contextUpdates.length < 1
    || contextUpdates.some((update) => {
      return !update
        || typeof update.authority !== 'string'
        || typeof update.status !== 'string'
        || typeof update.provenance !== 'string'
        || typeof update.freshness !== 'string';
    })) {
    throw new Error('Context snapshot commit requires explicit run context updates.');
  }
  const entryAuthorities = new Set(snapshot.entries.map((entry) => entry.authority));
  const updateAuthorities = new Set(contextUpdates.map((update) => update.authority));
  if (updateAuthorities.size !== contextUpdates.length
    || fingerprintJson([...updateAuthorities].sort())
      !== fingerprintJson([...entryAuthorities].sort())) {
    throw new Error('Context updates must cover each snapshot authority exactly once.');
  }

  const nextRun = structuredClone(run);
  for (const update of contextUpdates) {
    const index = nextRun.context.findIndex((item) => item.authority === update.authority);
    if (index < 0) {
      throw new Error('Durable run does not declare context authority ' + update.authority + '.');
    }
    nextRun.context[index] = {
      ...nextRun.context[index],
      status: update.status,
      provenance: update.provenance,
      freshness: update.freshness
    };
  }
  const snapshotFingerprint = fingerprintJson(snapshot);
  nextRun.checkpoints = replaceExactById(nextRun.checkpoints, {
    id: 'context-assembly.' + snapshot.id,
    kind: 'context-assembly',
    state: 'passed',
    planId: checkpoint.plan.id,
    planFingerprint: checkpoint.planFingerprint,
    snapshotId: snapshot.id,
    snapshotFingerprint,
    updatedAt: snapshot.createdAt,
    details: checkpointDetails
  }, 'Context assembly checkpoint');
  nextRun.outputs = replaceExactById(nextRun.outputs, {
    id: snapshot.id,
    type: 'context-snapshot',
    fingerprint: snapshotFingerprint
  }, 'Context snapshot output');
  nextRun.lifecycleState = 'paused';
  contractFailures(
    resolvedRoot,
    nextRun,
    'soter/contracts/run-envelope.schema.json',
    'Context-updated run envelope'
  );
  assertExactRun(
    resolvedRoot,
    state.lockFile,
    state.lock,
    nextRun,
    DURABLE_RUN_STATES
  );

  let snapshotState;
  if (hasContextSnapshotState(resolvedRoot, snapshot.id)) {
    snapshotState = readContextSnapshotState(resolvedRoot, snapshot.id);
    contractFailures(
      resolvedRoot,
      snapshotState.snapshot,
      'soter/contracts/context-snapshot.schema.json',
      'Durable context snapshot'
    );
    if (fingerprintJson(snapshotState.snapshot) !== snapshotFingerprint) {
      throw new Error('Context snapshot conflicts with existing durable state.');
    }
    snapshotState.path = repoRelativePath(resolvedRoot, snapshotState.file);
  } else {
    snapshotState = writeContextSnapshotState(resolvedRoot, snapshot);
  }
  const runState = writeRunState(resolvedRoot, nextRun);
  return {
    checkpoint,
    checkpointPath: repoRelativePath(resolvedRoot, state.checkpointFile),
    snapshot,
    snapshotPath: snapshotState.path,
    run: nextRun,
    runPath: runState.path
  };
}

export function getExactDurableContextSnapshot({
  root,
  lockPath,
  snapshotId,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const lockState = exactLock(resolvedRoot, lockPath, expectedHost);
  const snapshotState = readContextSnapshotState(resolvedRoot, snapshotId);
  const snapshot = snapshotState.snapshot;
  contractFailures(
    resolvedRoot,
    snapshot,
    'soter/contracts/context-snapshot.schema.json',
    'Durable context snapshot'
  );
  if (snapshot.containment !== 'connected'
    || snapshot.privacy.scope !== 'private'
    || snapshot.configurationLockFingerprint !== fingerprintLock(lockState.lock)
    || snapshot.graphFingerprint !== lockState.lock.graphFingerprint
    || containsCredentialMaterial(snapshot)) {
    throw new Error('Durable context snapshot does not match the exact private connected lock and graph.');
  }
  for (const entry of snapshot.entries) {
    if (entry.valueFingerprint !== fingerprintJson(entry.value)) {
      throw new Error('Durable context snapshot entry fingerprint is stale: ' + entry.id + '.');
    }
  }
  const runState = readRunState(resolvedRoot, snapshot.runId);
  const run = runState.run;
  assertExactRun(
    resolvedRoot,
    lockState.file,
    lockState.lock,
    run,
    DURABLE_RUN_STATES
  );
  const output = run.outputs.find((item) => item.id === snapshot.id);
  if (run.lifecycleState !== 'paused'
    || !output
    || output.type !== 'context-snapshot'
    || output.fingerprint !== fingerprintJson(snapshot)) {
    throw new Error('Durable context snapshot is not registered on its exact paused run.');
  }
  return {
    lock: lockState.lock,
    snapshot,
    snapshotPath: repoRelativePath(resolvedRoot, snapshotState.file),
    run,
    runPath: repoRelativePath(resolvedRoot, runState.file)
  };
}

function automationDecisionFingerprint(decision) {
  const value = structuredClone(decision);
  delete value.decisionFingerprint;
  return fingerprintJson(value);
}

function exactAutomationDecision({
  root,
  lockPath,
  decision,
  expectedHost,
  requireRegistered
}) {
  const resolvedRoot = path.resolve(root);
  const lockState = exactLock(resolvedRoot, lockPath, expectedHost);
  const lock = lockState.lock;
  contractFailures(
    resolvedRoot,
    decision,
    'soter/contracts/automation-decision.schema.json',
    'Automation decision'
  );
  if (decision.configurationLockFingerprint !== fingerprintLock(lock)
    || decision.graphFingerprint !== lock.graphFingerprint
    || decision.privacy.scope !== 'private'
    || containsCredentialMaterial(decision)
    || decision.decisionFingerprint !== automationDecisionFingerprint(decision)) {
    throw new Error(
      'Automation decision does not match the exact lock, graph, private-state, and fingerprint contract.'
    );
  }
  if ((decision.state === 'ready' && decision.issues.length !== 0)
    || (decision.state === 'needs-input' && decision.issues.length < 1)
    || (decision.producer.kind === 'host'
      ? typeof decision.producer.host !== 'string'
      : decision.producer.host !== null)) {
    throw new Error('Automation decision state, issues, and producer binding are inconsistent.');
  }
  const selected = lock.packs.filter((pack) => {
    return pack.id === decision.automation.id && pack.layer === 'automation';
  });
  if (selected.length !== 1 || selected[0].version !== decision.automation.version) {
    throw new Error('Automation decision does not match the exact selected Automation pack.');
  }
  if (decision.producer.kind === 'host'
    && (decision.producer.host !== lock.host.id
      || (expectedHost && decision.producer.host !== expectedHost))) {
    throw new Error('Automation decision producer does not match the exact active host projection.');
  }

  const snapshotState = readContextSnapshotState(
    resolvedRoot,
    decision.context.snapshotId
  );
  const snapshot = snapshotState.snapshot;
  contractFailures(
    resolvedRoot,
    snapshot,
    'soter/contracts/context-snapshot.schema.json',
    'Automation decision context snapshot'
  );
  if (snapshot.containment !== 'connected'
    || snapshot.privacy.scope !== 'private'
    || snapshot.runId !== decision.runId
    || snapshot.configurationLockFingerprint !== decision.configurationLockFingerprint
    || snapshot.graphFingerprint !== decision.graphFingerprint
    || fingerprintJson(snapshot) !== decision.context.snapshotFingerprint) {
    throw new Error('Automation decision does not bind the exact private connected context snapshot.');
  }
  if (snapshot.entries.some((entry) => {
    return entry.valueFingerprint !== fingerprintJson(entry.value);
  })) {
    throw new Error('Automation decision context snapshot contains a stale entry fingerprint.');
  }

  const runState = readRunState(resolvedRoot, decision.runId);
  const run = runState.run;
  assertExactRun(
    resolvedRoot,
    lockState.file,
    lock,
    run,
    DURABLE_RUN_STATES
  );
  const snapshotOutput = run.outputs.find((item) => item.id === snapshot.id);
  const createdAt = Date.parse(decision.createdAt);
  if (run.lifecycleState !== 'paused'
    || run.automation.id !== decision.automation.id
    || run.automation.version !== decision.automation.version
    || !snapshotOutput
    || snapshotOutput.type !== 'context-snapshot'
    || snapshotOutput.fingerprint !== decision.context.snapshotFingerprint
    || !Number.isFinite(createdAt)
    || createdAt < Date.parse(snapshot.createdAt)) {
    throw new Error(
      'Automation decision requires the exact paused run and its committed context snapshot.'
    );
  }
  if (requireRegistered) {
    const decisionOutput = run.outputs.find((item) => item.id === decision.id);
    const decisionCheckpoint = run.checkpoints.find((item) => {
      return item.id === 'automation-decision.' + decision.id.slice('decision.'.length);
    });
    if (!decisionOutput
      || decisionOutput.type !== 'automation-decision'
      || decisionOutput.fingerprint !== decision.decisionFingerprint
      || decisionCheckpoint?.decisionFingerprint !== decision.decisionFingerprint) {
      throw new Error('Durable run does not register the exact automation decision.');
    }
  }
  return {
    root: resolvedRoot,
    lock,
    lockFile: lockState.file,
    snapshot,
    snapshotFile: snapshotState.file,
    run,
    runFile: runState.file,
    decision
  };
}

export function commitDurableAutomationDecision({
  root,
  lockPath,
  decision,
  expectedHost
}) {
  const exact = exactAutomationDecision({
    root,
    lockPath,
    decision,
    expectedHost,
    requireRegistered: false
  });
  const checkpointId = 'automation-decision.' + decision.id.slice('decision.'.length);
  const nextRun = structuredClone(exact.run);
  const competingDecision = nextRun.checkpoints.find((checkpoint) => {
    return checkpoint.kind === 'automation-decision'
      && checkpoint.snapshotId === decision.context.snapshotId
      && checkpoint.decisionId !== decision.id;
  });
  if (competingDecision) {
    throw new Error(
      'Context snapshot already has a different durable automation decision: '
        + competingDecision.decisionId + '.'
    );
  }
  let decisionState;
  if (hasAutomationDecisionState(exact.root, decision.id)) {
    decisionState = readAutomationDecisionState(exact.root, decision.id);
    contractFailures(
      exact.root,
      decisionState.decision,
      'soter/contracts/automation-decision.schema.json',
      'Durable automation decision'
    );
    if (fingerprintJson(decisionState.decision) !== fingerprintJson(decision)) {
      throw new Error('Automation decision conflicts with existing durable state.');
    }
    decisionState.path = repoRelativePath(exact.root, decisionState.file);
  } else {
    decisionState = writeAutomationDecisionState(exact.root, decision);
  }

  nextRun.checkpoints = replaceExactById(nextRun.checkpoints, {
    id: checkpointId,
    kind: 'automation-decision',
    state: decision.state === 'ready' ? 'passed' : 'blocked',
    snapshotId: decision.context.snapshotId,
    snapshotFingerprint: decision.context.snapshotFingerprint,
    decisionId: decision.id,
    decisionFingerprint: decision.decisionFingerprint,
    updatedAt: decision.createdAt,
    details: decision.state === 'ready'
      ? 'Automation recorded a complete grounded decision; no write approval or provider call was created.'
      : 'Automation recorded an explicit abstention and paused for the stated missing input.'
  }, 'Automation decision checkpoint');
  nextRun.outputs = replaceExactById(nextRun.outputs, {
    id: decision.id,
    type: 'automation-decision',
    fingerprint: decision.decisionFingerprint
  }, 'Automation decision output');
  nextRun.lifecycleState = 'paused';
  contractFailures(
    exact.root,
    nextRun,
    'soter/contracts/run-envelope.schema.json',
    'Automation decision run envelope'
  );
  assertExactRun(
    exact.root,
    exact.lockFile,
    exact.lock,
    nextRun,
    DURABLE_RUN_STATES
  );
  const runState = writeRunState(exact.root, nextRun);
  return {
    decision,
    decisionPath: decisionState.path,
    run: nextRun,
    runPath: runState.path
  };
}

export function getExactDurableAutomationDecision({
  root,
  lockPath,
  decisionId,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const state = readAutomationDecisionState(resolvedRoot, decisionId);
  const exact = exactAutomationDecision({
    root: resolvedRoot,
    lockPath,
    decision: state.decision,
    expectedHost,
    requireRegistered: true
  });
  return {
    lock: exact.lock,
    snapshot: exact.snapshot,
    decision: exact.decision,
    decisionPath: repoRelativePath(exact.root, state.file),
    run: exact.run,
    runPath: repoRelativePath(exact.root, exact.runFile)
  };
}

export function getDurableProviderProbe({ root, checkpointId, expectedHost }) {
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  if (state.checkpoint.kind !== 'provider-probe'
    || state.checkpoint.state !== 'completed'
    || !state.checkpoint.result) {
    throw new Error('Checkpoint ' + checkpointId + ' is not a completed provider probe.');
  }
  return structuredClone(state.checkpoint.result);
}

function failedProbeAttempt(root, state) {
  const checkpoint = state.checkpoint;
  const planned = checkpoint.$contract
    === 'soter://contracts/provider-probe-plan-checkpoint/v1';
  const runtimeStep = planned
    ? checkpoint.steps.find((step) => step.state === 'failed')
    : null;
  const sourceStep = runtimeStep
    ? checkpoint.plan.steps.find((step) => step.id === runtimeStep.id)
    : null;
  const call = planned ? runtimeStep?.call : checkpoint.call;
  const error = planned ? runtimeStep?.error : call?.error;
  const scope = planned ? checkpoint.plan.scope : call?.plan;
  const provider = planned ? checkpoint.provider : call?.provider;
  const probeId = planned ? checkpoint.plan.probeId : call?.probeId;
  const validForSeconds = planned ? checkpoint.plan.validForSeconds : call?.validForSeconds;
  const failedAt = call?.completedAt || checkpoint.updatedAt;
  if (!call || !error || !scope || !provider || !probeId
    || !Number.isInteger(validForSeconds) || !Number.isFinite(Date.parse(failedAt))) {
    throw new Error(
      'Failed provider probe checkpoint does not contain one exact terminal failure.'
    );
  }
  const attempt = {
    $contract: 'soter://contracts/provider-probe-attempt/v1',
    contractVersion: '1.0.0',
    id: 'probeattempt.' + checkpoint.id.slice('checkpoint.'.length),
    probeId,
    checkpointId: checkpoint.id,
    attemptedAt: checkpoint.createdAt,
    failedAt,
    validUntil: new Date(Date.parse(failedAt) + validForSeconds * 1000).toISOString(),
    state: 'failed',
    configuration: {
      name: state.lock.configuration.name,
      lockFingerprint: checkpoint.configurationLock.fingerprint
    },
    host: structuredClone(checkpoint.host),
    provider: structuredClone(provider),
    scope: structuredClone(scope),
    failure: {
      kind: error.kind,
      errorFingerprint: fingerprintJson(error),
      step: sourceStep
        ? {
          id: sourceStep.id,
          kind: sourceStep.kind,
          subject: sourceStep.subject,
          scopeFingerprint: sourceStep.scopeFingerprint
        }
        : null,
      callId: call.id,
      transport: structuredClone(call.transport)
    },
    sourceCheckpointFingerprint: checkpoint.checkpointFingerprint,
    privacy: {
      scope: 'private',
      rawProviderResponsePersisted: false,
      hostCredentialValuesPersisted: false,
      providerArgumentsIncluded: false,
      providerErrorMessageIncluded: false
    }
  };
  contractFailures(
    path.resolve(root),
    attempt,
    'soter/contracts/provider-probe-attempt.schema.json',
    'Provider probe attempt'
  );
  return attempt;
}

export function getDurableProviderProbeObservation({ root, checkpointId, expectedHost }) {
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  if (state.checkpoint.kind !== 'provider-probe') {
    throw new Error('Checkpoint ' + checkpointId + ' is not a provider probe.');
  }
  if (state.checkpoint.state === 'completed' && state.checkpoint.result) {
    return structuredClone(state.checkpoint.result);
  }
  if (state.checkpoint.state === 'failed' && !state.checkpoint.result) {
    return failedProbeAttempt(root, state);
  }
  throw new Error(
    'Checkpoint ' + checkpointId + ' is still pending and cannot inform connected readiness.'
  );
}

export function listDurableHostExecutions({ root, state, expectedHost }) {
  const checkpoints = listHostCallCheckpointDocuments(root)
    .map((item) => assertCheckpoint(path.resolve(root), item.checkpoint))
    .filter((checkpoint) => !expectedHost || checkpoint.host.id === expectedHost)
    .filter((checkpoint) => !state || checkpoint.state === state)
    .map((checkpoint) => {
      const planned = checkpoint.kind === 'operation-plan'
        || checkpoint.$contract === 'soter://contracts/provider-probe-plan-checkpoint/v1';
      const call = checkpoint.kind === 'operation-plan'
        ? operationPlanCurrentCall(checkpoint)
          || checkpoint.steps.findLast((step) => step.call)?.call
        : checkpoint.kind === 'connected-transaction'
          ? connectedTransactionCurrentCall(checkpoint)
            || checkpoint.operations.flatMap((operation) => [
              operation.compare,
              operation.write,
              operation.verification,
              operation.contentVerification,
              operation.compensation,
              operation.compensationVerification,
              ...operation.reconciliations.map((item) => item.phase)
            ]).filter(Boolean).findLast((phase) => phase.call)?.call
        : checkpoint.$contract === 'soter://contracts/provider-probe-plan-checkpoint/v1'
          ? providerProbePlanCurrentCall(checkpoint)
            || checkpoint.steps.findLast((step) => step.call)?.call
          : checkpoint.call;
      return {
        id: checkpoint.id,
        kind: checkpoint.kind,
        state: checkpoint.state,
        callId: call?.id || null,
        updatedAt: checkpoint.updatedAt,
        host: checkpoint.host.id,
        provider: checkpoint.provider?.implementation
          || call?.provider?.implementation || null,
        capability: checkpoint.kind === 'provider-probe'
          ? null
          : call?.capability.id || null,
        runId: checkpoint.run?.id || null,
        planId: planned ? checkpoint.plan.id : null,
        currentStepId: planned ? checkpoint.currentStepId : null,
        batchId: checkpoint.kind === 'connected-transaction' ? checkpoint.batch.id : null,
        currentStage: checkpoint.kind === 'connected-transaction'
          ? checkpoint.current?.stage || null
          : null
      };
    });
  return { checkpoints };
}
