import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  assertHostToolCall,
  completeHostToolCall,
  failHostToolCall,
  prepareHostToolCall
} from './host-tools.mjs';
import {
  containsCredentialMaterial,
  isHostFailureKind,
  normalizedError
} from './host-runtime.mjs';
import { fingerprintJson, readJson, repoRelativePath, resolveRepoPath } from './lib/canonical-json.mjs';
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
  operationPlanRequestedCallFingerprint,
  preflightOperationPlanSteps,
  recoverOperationPlanReadStep,
  requestNextOperationPlanStep
} from './operation-plans.mjs';
import {
  assertProviderProbePlanCheckpoint,
  completeProviderProbePlanStep,
  createProviderProbePlanCheckpoint,
  failProviderProbePlanStep,
  providerProbePlanCurrentCall
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
  hostCallCheckpointPath,
  readAutomationDecisionState,
  readContextSnapshotState,
  readHostCallCheckpoint,
  readRunState,
  runStatePath,
  writeAutomationDecisionState,
  writeContextSnapshotState,
  writeHostCallCheckpoint,
  writeRunState
} from './runtime-state.mjs';
import { connectedApprovalFingerprint } from './connected-transactions.mjs';
import {
  ConnectedConfigurationError,
  revalidateExactConnectedConfiguration,
  selectExactConnectedConfiguration
} from './connected-configuration.mjs';

const EXECUTABLE_RUN_STATES = new Set(['effects-established', 'executing']);
const DURABLE_RUN_STATES = new Set(['effects-established', 'executing', 'paused']);
const READ_ONLY_FOLLOWUP_RUN_STATES = new Set([
  ...DURABLE_RUN_STATES,
  'context-assembled'
]);
const READ_ONLY_PLAN_EFFECTS = new Set(['read', 'disclosure']);

export const SOTER_NATIVE_RESPONSE_MAX_BYTES = 6 * 1024 * 1024;
export const SOTER_SDK_STDIO_TRANSPORT_MAX_BYTES = 8 * 1024 * 1024;
export const SOTER_PROVIDER_PROBE_ID_MAX_LENGTH = 200;
export const SOTER_NATIVE_RESPONSE_ENVELOPE_EXCEEDED =
  'SOTER_NATIVE_RESPONSE_ENVELOPE_EXCEEDED';
export const SOTER_NATIVE_RESPONSE_ENVELOPE_MESSAGE =
  'The native provider response exceeds the supported Soter ingress envelope. Do not retry the provider call. Inspect the exact checkpoint; if it remains requested, record the exact call through soter_fail_host_call before continuing.';

export function nativeResponseEnvelopeByteLength(response) {
  const serialized = JSON.stringify(response);
  if (typeof serialized !== 'string') {
    throw new Error('Native provider response must be one JSON value.');
  }
  return Buffer.byteLength(serialized, 'utf8');
}

export function assertNativeResponseEnvelope(response) {
  if (nativeResponseEnvelopeByteLength(response) <= SOTER_NATIVE_RESPONSE_MAX_BYTES) {
    return;
  }
  const error = new Error(SOTER_NATIVE_RESPONSE_ENVELOPE_MESSAGE);
  error.code = SOTER_NATIVE_RESPONSE_ENVELOPE_EXCEEDED;
  throw error;
}

async function assertDurableNativeResponseEnvelope({
  root,
  checkpointId,
  callId,
  response,
  at,
  expectedHost,
  recordFailure
}) {
  try {
    assertNativeResponseEnvelope(response);
  } catch (error) {
    if (error?.code === SOTER_NATIVE_RESPONSE_ENVELOPE_EXCEEDED && recordFailure) {
      try {
        await failDurableHostExecution({
          root,
          checkpointId,
          callId,
          errorKind: 'validation',
          at,
          expectedHost
        });
      } catch {
        // Preserve one fixed, payload-independent boundary error. The caller must inspect
        // the exact checkpoint and explicitly fail any still-requested call before recovery.
      }
    }
    throw error;
  }
}

function hostCallContainsId(call, callId) {
  return call?.id === callId
    || Boolean(call?.pagination?.pages?.some((page) => page.callId === callId));
}

function planCheckpointContainsCallId(checkpoint, callId) {
  return checkpoint.steps.some((step) => hostCallContainsId(step.call, callId));
}

function connectedCheckpointContainsCallId(checkpoint, callId) {
  return checkpoint.operations.some((operation) => {
    const records = [
      operation.precondition,
      operation.write,
      operation.verification,
      ...operation.reconciliations.map((item) => item.phase)
    ];
    return records.some((record) => hostCallContainsId(record?.call, callId));
  });
}

function assertExactServiceArguments(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(label + ' accepts only its exact declared arguments.');
  }
}

function operationProviderImplementations(operation) {
  return [
    operation.provider?.connectedImplementation,
    operation.precondition?.provider?.connectedImplementation,
    operation.verification?.provider?.connectedImplementation
  ].filter(Boolean);
}

function checkpointProviderImplementations(checkpoint) {
  if (checkpoint.kind === 'capability') {
    return [checkpoint.call.provider.implementation];
  }
  if (checkpoint.kind === 'operation-plan') {
    return [...new Set(checkpoint.plan.steps.map((step) => {
      return step.providerImplementation;
    }))];
  }
  if (checkpoint.kind === 'connected-transaction') {
    return [...new Set(checkpoint.batch.operations.flatMap(operationProviderImplementations))];
  }
  if (checkpoint.$contract === 'soter://contracts/provider-probe-plan-checkpoint/v1') {
    return [checkpoint.provider.implementation];
  }
  throw new Error('Unsupported durable host checkpoint contract.');
}

function approvalProviderImplementations(approval) {
  return [...new Set(approval.request.batch.operations.flatMap(
    operationProviderImplementations
  ))];
}

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

function assertExactPrivateStateFile(root, file, expected, label) {
  if (file !== expected || !fs.existsSync(file)) {
    throw new Error(label + ' requires an existing exact Core-owned private state file.');
  }
  const relative = path.relative(path.resolve(root), file);
  if (!relative
    || relative === '..'
    || relative.startsWith('..' + path.sep)
    || path.isAbsolute(relative)) {
    throw new Error(label + ' is outside the exact Core-owned private state root.');
  }
  let current = path.resolve(root);
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const component = fs.lstatSync(current);
    if (component.isSymbolicLink()) {
      throw new Error(label + ' cannot traverse symbolic links.');
    }
  }
  const fileStat = fs.lstatSync(file);
  const directoryStat = fs.lstatSync(path.dirname(file));
  if (!fileStat.isFile()
    || fileStat.nlink !== 1
    || !directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || (process.platform !== 'win32'
      && ((fileStat.mode & 0o7777) !== 0o600
        || (directoryStat.mode & 0o7777) !== 0o700))) {
    throw new Error(
      label + ' must be one non-linked 0600 file in its exact 0700 directory.'
    );
  }
}

function exactPrivateRun(root, lockFile, lock, runPath, allowedStates) {
  let file;
  try {
    file = resolveRepoPath(root, runPath);
  } catch {
    throw new Error(
      'Private-active execution requires an exact Core-owned durable run state path.'
    );
  }
  const extension = path.extname(file);
  const runId = path.basename(file, extension);
  let expected;
  try {
    expected = runStatePath(root, runId);
  } catch {
    throw new Error(
      'Private-active execution requires an exact Core-owned durable run state path.'
    );
  }
  if (extension !== '.json') {
    throw new Error(
      'Private-active execution requires an existing exact Core-owned durable run state.'
    );
  }
  assertExactPrivateStateFile(
    root,
    file,
    expected,
    'Private-active durable run state'
  );
  const state = readRunState(root, runId);
  if (state.file !== file || state.run.id !== runId) {
    throw new Error('Private-active durable run identity does not match its exact state path.');
  }
  return {
    file,
    run: assertExactRun(root, lockFile, lock, state.run, allowedStates)
  };
}

function operationPlanIsReadOnly(root, lock, plan) {
  return plan.steps.every((step) => {
    const selected = lock.capabilities.filter((capability) => capability.id === step.capability);
    if (selected.length !== 1) return false;
    const capability = readJson(resolveRepoPath(
      root,
      'soter/capabilities/' + step.capability + '.json'
    ));
    return capability.id === selected[0].id
      && capability.version === selected[0].version
      && fingerprintJson(capability) === selected[0].contractFingerprint
      && capability.effects.length > 0
      && capability.effects.every((effect) => READ_ONLY_PLAN_EFFECTS.has(effect));
  });
}

function readOnlyInvocation(effect) {
  return effect.declaredEffects.length > 0
    && effect.declaredEffects.every((declared) => READ_ONLY_PLAN_EFFECTS.has(declared));
}

function recoveryInvocationBasis(effect) {
  return {
    capability: effect.capability,
    capabilityVersion: effect.capabilityVersion,
    providerPack: effect.providerPack,
    providerImplementation: effect.providerImplementation,
    providerVersion: effect.providerVersion,
    containment: effect.containment,
    authority: effect.authority,
    declaredEffects: effect.declaredEffects,
    policyDecisions: effect.policyDecisions,
    inputFingerprint: effect.inputFingerprint
  };
}

function exactRunCallCheckpoint(run, callId) {
  const matches = run.checkpoints.filter((checkpoint) => {
    return checkpoint.kind === 'host-tool-call'
      && checkpoint.id === 'host-call.' + callId
      && checkpoint.callId === callId;
  });
  return matches.length === 1 ? matches[0] : null;
}

function recoveredReadFailure(run, effect) {
  if (effect.state !== 'failed' || !readOnlyInvocation(effect)) return false;
  if (run.effects.filter((candidate) => candidate.id === effect.id).length !== 1) {
    return false;
  }
  const matchingRecoveries = run.checkpoints
    .filter((checkpoint) => checkpoint.kind === 'operation-plan')
    .flatMap((checkpoint) => checkpoint.recoveries || [])
    .filter((recovery) => {
      return recovery.failedEffectId === effect.id
        && recovery.failedEffectId === effectIdForCallId(recovery.failedCallId);
    });
  if (matchingRecoveries.length !== 1) return false;
  const recovery = matchingRecoveries[0];
  const replacements = run.effects.filter((candidate) => {
    return candidate.id === recovery.replacementEffectId
      && candidate.id === effectIdForCallId(recovery.replacementCallId);
  });
  if (replacements.length !== 1) return false;
  const replacement = replacements[0];
  if (replacement.state !== 'passed'
    || !readOnlyInvocation(replacement)
    || fingerprintJson(recoveryInvocationBasis(effect))
      !== fingerprintJson(recoveryInvocationBasis(replacement))) {
    return false;
  }
  const failedCall = exactRunCallCheckpoint(run, recovery.failedCallId);
  const replacementCall = exactRunCallCheckpoint(run, recovery.replacementCallId);
  return failedCall?.state === 'failed'
    && failedCall.callFingerprint === recovery.failedCallFingerprint
    && replacementCall?.state === 'completed'
    && replacementCall.requestFingerprint === recovery.replacementRequestFingerprint;
}

function assertReadOnlyFollowupRun(run) {
  if (!['context-assembled', 'paused'].includes(run.lifecycleState)) return;
  const priorEffectsAreClosedReads = run.effects.every((effect) => {
    return (effect.state === 'passed' || recoveredReadFailure(run, effect))
      && readOnlyInvocation(effect);
  });
  if (run.approvals.length !== 0
    || !priorEffectsAreClosedReads
    || run.checkpoints.length === 0
    || run.checkpoints.some((checkpoint) => checkpoint.state !== 'passed')) {
    throw new Error(
      'Paused run cannot start a read-only follow-up because its exact prior checkpoints, effects, or approval boundary are not clean.'
    );
  }
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
  if (checkpoint?.$contract === 'soter://contracts/connected-transaction-checkpoint/v2') {
    return assertVerifiedConnectedTransactionCheckpoint(root, checkpoint);
  }
  if (checkpoint?.$contract === 'soter://contracts/operation-plan-checkpoint/v2') {
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
    || !checkpoint.call.configuration
    || fingerprintJson(checkpoint.call.configuration)
      !== fingerprintJson(checkpoint.configuration)
    || checkpoint.configuration.lockPath !== checkpoint.configurationLock.path
    || checkpoint.configuration.lockFingerprint
      !== checkpoint.configurationLock.fingerprint
    || checkpoint.configuration.graphFingerprint !== checkpoint.graphFingerprint
    || checkpoint.configurationLock.fingerprint
      !== checkpoint.call.configurationLockFingerprint
    || checkpoint.graphFingerprint !== checkpoint.call.graphFingerprint
    || fingerprintJson(checkpoint.host) !== fingerprintJson(checkpoint.call.host)) {
    throw new Error('Host call checkpoint metadata does not match its exact call record.');
  }
  if (checkpoint.kind !== 'capability' || !checkpoint.run || !checkpoint.input) {
    throw new Error('Host call checkpoint must contain one exact capability run and input.');
  }
  if (checkpoint.call.$contract !== 'soter://contracts/host-tool-call/v1') {
    throw new Error('Host call checkpoint must contain one host-tool call.');
  }
  contractFailures(
    root,
    checkpoint.call,
    'soter/contracts/host-tool-call.schema.json',
    'Checkpoint call'
  );
  assertHostToolCall(root, checkpoint.call);
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
    requestFingerprint: operationPlanRequestedCallFingerprint(call),
    updatedAt: call.completedAt || call.createdAt,
    details: call.state === 'requested'
      ? 'Core emitted one provider-neutral operation resolved to an exact native host tool; the native result is pending.'
      : 'Core closed the exact resolved provider request in state ' + call.state + '.'
  };
}

function effectIdForCallId(callId) {
  return 'effect.' + callId.slice('toolcall.'.length);
}

function effectIdForCall(call) {
  return effectIdForCallId(call.id);
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
    recoveries: (checkpoint.recoveries || []).map((recovery) => ({
      id: recovery.id,
      stepId: recovery.stepId,
      attempt: recovery.attempt,
      failedCallId: recovery.failedCallId,
      failedEffectId: effectIdForCallId(recovery.failedCallId),
      failedCallFingerprint: recovery.failedCallFingerprint,
      replacementCallId: recovery.replacementCallId,
      replacementEffectId: effectIdForCallId(recovery.replacementCallId),
      replacementRequestFingerprint: recovery.replacementRequestFingerprint
    })),
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
    for (const priorCall of step.priorCalls || []) {
      next = syncRunWithCheckpoint(next, { kind: 'capability', call: priorCall });
    }
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
  const currentCall = verifiedConnectedTransactionCurrentCall(checkpoint);
  const progressFingerprint = fingerprintJson({
    batchFingerprint: checkpoint.batchFingerprint,
    changeSetFingerprint: checkpoint.changeSetFingerprint,
    approvalFingerprint: checkpoint.approvalFingerprint,
    startedAt: checkpoint.startedAt,
    state: checkpoint.state,
    operations: checkpoint.operations.map((operation) => ({
      id: operation.id,
      state: operation.state,
      callFingerprints: [
        operation.precondition,
        operation.write,
        operation.verification,
        ...operation.reconciliations.map((item) => item.phase)
      ].filter(Boolean).map((phase) => fingerprintJson(phase.call)),
      ambiguities: operation.ambiguity ? [operation.ambiguity] : [],
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
  for (const operation of checkpoint.operations) {
    for (const name of ['precondition', 'write', 'verification']) {
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

export async function prepareCapabilityExecution({
  root,
  lockPath,
  configurationBasis,
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
  const selected = selectExactConnectedConfiguration({
    root,
    configurationBasis,
    lockPath,
    expectedHost,
    providerImplementations: [providerImplementation]
  });
  const { lockFile, lock } = selected;
  const { run } = exactRun(path.resolve(root), lockFile, lock, runPath);
  return prepareHostToolCall({
    root,
    lock,
    configuration: selected.selection,
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
  configurationBasis,
  runPath,
  call,
  input,
  response,
  at,
  expectedHost
}) {
  const selected = selectExactConnectedConfiguration({
    root,
    configurationBasis,
    lockPath,
    expectedHost,
    providerImplementations: [call.provider.implementation]
  });
  const { lockFile, lock } = selected;
  const { run } = exactRun(path.resolve(root), lockFile, lock, runPath);
  if (call.runId !== run.id) {
    throw new Error('Host tool call does not belong to the supplied exact run envelope.');
  }
  if (!call.configuration
    || fingerprintJson(call.configuration) !== fingerprintJson(selected.selection)) {
    throw new Error(
      'Host tool call does not match the exact selected configuration basis.'
    );
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

export function failHostExecution(options) {
  assertExactServiceArguments(options, new Set([
    'root',
    'lockPath',
    'configurationBasis',
    'runPath',
    'call',
    'errorKind',
    'at',
    'expectedHost'
  ]), 'Host failure recording');
  const {
    root,
    lockPath,
    configurationBasis,
    runPath,
    call,
    errorKind,
    at,
    expectedHost
  } = options;
  if (!isHostFailureKind(errorKind)) {
    throw new Error(
      'Host failure requires an explicit closed error kind; use unknown when no narrower kind applies.'
    );
  }
  const selected = selectExactConnectedConfiguration({
    root,
    configurationBasis,
    lockPath,
    expectedHost,
    providerImplementations: [call?.provider?.implementation].filter(Boolean)
  });
  const { lockFile, lock } = selected;
  const error = normalizedError({ kind: errorKind });
  if (call?.$contract === 'soter://contracts/host-tool-call/v1') {
    if (!runPath) throw new Error('Capability call failures require runPath.');
    const { run } = exactRun(path.resolve(root), lockFile, lock, runPath);
    if (call.runId !== run.id) {
      throw new Error('Host tool call does not belong to the supplied exact run envelope.');
    }
    if (!call.configuration
      || fingerprintJson(call.configuration) !== fingerprintJson(selected.selection)) {
      throw new Error(
        'Host tool call does not match the exact selected configuration basis.'
      );
    }
    return {
      call: failHostToolCall({ root, lock, call, error, at: atOrNow(at) })
    };
  }
  throw new Error('Unsupported host call contract.');
}

function baseDurableCheckpoint({
  root,
  lockFile,
  lock,
  configuration,
  kind,
  call,
  input,
  result,
  run,
  at
}) {
  return {
    $contract: 'soter://contracts/host-call-checkpoint/v1',
    contractVersion: '1.0.0',
    id: 'checkpoint.' + call.id,
    kind,
    createdAt: call.createdAt,
    updatedAt: at,
    state: call.state,
    configuration: structuredClone(configuration),
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
    persisted.currentCall = verifiedConnectedTransactionCurrentCall(next);
  } else if (next.$contract === 'soter://contracts/provider-probe-plan-checkpoint/v1') {
    persisted.currentCall = providerProbePlanCurrentCall(next);
  }
  return persisted;
}

function stageDurableRun(
  root,
  lockFile,
  lock,
  runPath,
  configuration,
  allowedStates = EXECUTABLE_RUN_STATES,
  runGuard = null
) {
  const privateActive = configuration?.configurationBasis === 'private-active';
  const source = privateActive
    ? exactPrivateRun(root, lockFile, lock, runPath, allowedStates)
    : exactRun(root, lockFile, lock, runPath, allowedStates);
  if (runGuard) runGuard(source.run);
  const sourcePath = repoRelativePath(root, source.file);
  if (privateActive) {
    return {
      run: structuredClone(source.run),
      sourcePath,
      statePath: sourcePath
    };
  }
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
  if (runGuard) runGuard(run);
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
  const expected = hostCallCheckpointPath(root, checkpointId);
  assertExactPrivateStateFile(
    path.resolve(root),
    expected,
    expected,
    'Durable host call checkpoint'
  );
  const state = readHostCallCheckpoint(root, checkpointId);
  if (state.file !== expected) {
    throw new Error('Durable host call checkpoint path does not match its exact identity.');
  }
  const checkpoint = assertCheckpoint(path.resolve(root), state.checkpoint);
  if (checkpoint.id !== checkpointId
    || hostCallCheckpointPath(root, checkpoint.id) !== state.file) {
    throw new Error(
      'Durable host call checkpoint identity does not match its exact private state path.'
    );
  }
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
  const lockState = revalidateExactConnectedConfiguration({
    root,
    selection: state.checkpoint.configuration,
    expectedHost,
    providerImplementations: checkpointProviderImplementations(state.checkpoint)
  });
  if (state.checkpoint.configurationLock.fingerprint !== fingerprintLock(lockState.lock)
    || state.checkpoint.configurationLock.path !== lockState.selection.lockPath
    || state.checkpoint.graphFingerprint !== lockState.lock.graphFingerprint) {
    throw new Error('Host call checkpoint does not match the current exact lock and graph.');
  }
  return {
    checkpointFile: state.checkpointFile,
    checkpoint: state.checkpoint,
    lockFile: lockState.lockFile,
    lock: lockState.lock
  };
}

function durableRunForCheckpoint(root, lockFile, lock, checkpoint) {
  if (!checkpoint.run) return null;
  const expectedRunPath = runStatePath(root, checkpoint.run.id);
  if (repoRelativePath(root, expectedRunPath) !== checkpoint.run.statePath) {
    throw new Error('Host call checkpoint points to an unexpected durable run path.');
  }
  assertExactPrivateStateFile(
    path.resolve(root),
    expectedRunPath,
    expectedRunPath,
    'Durable run state'
  );
  const state = readRunState(root, checkpoint.run.id);
  if (state.file !== expectedRunPath) {
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
    if (fingerprintJson(repaired) !== checkpoint.run.fingerprint) {
      throw new Error(
        'Durable run state does not match the exact connected transaction checkpoint.'
      );
    }
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
    if (fingerprintJson(repaired) !== checkpoint.run.fingerprint) {
      throw new Error(
        'Durable run state does not match the exact operation-plan checkpoint.'
      );
    }
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
    } else if (!runProgressed) {
      throw new Error('Durable run checkpoint conflicts with the exact host call checkpoint.');
    }
  } else if (!currentEntry) {
    run = syncRunWithCheckpoint(run, checkpoint);
  }
  if (fingerprintJson(run) !== checkpoint.run.fingerprint) {
    throw new Error(
      'Durable run state does not match the exact capability checkpoint.'
    );
  }
  if (fingerprintJson(run) !== fingerprintJson(state.run)) {
    writeRunState(root, run);
  }
  return run;
}

function listDurableCheckpointDocuments(root) {
  const resolvedRoot = path.resolve(root);
  const directory = path.dirname(
    hostCallCheckpointPath(resolvedRoot, 'checkpoint.private-list-check')
  );
  if (!fs.existsSync(directory)) return [];
  const directoryRelative = path.relative(resolvedRoot, directory);
  let current = resolvedRoot;
  for (const part of directoryRelative.split(path.sep)) {
    current = path.join(current, part);
    const component = fs.lstatSync(current);
    if (component.isSymbolicLink()) {
      throw new Error('Durable host call state directory cannot traverse symbolic links.');
    }
  }
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || (process.platform !== 'win32' && (directoryStat.mode & 0o7777) !== 0o700)) {
    throw new Error('Durable host call state directory must be the exact private 0700 directory.');
  }
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.json'))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .map((entry) => {
      const file = path.join(directory, entry.name);
      const candidate = entry.name.slice(0, -'.json'.length);
      const id = /^checkpoint\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(candidate)
        ? candidate
        : null;
      try {
        assertExactPrivateStateFile(
          resolvedRoot,
          file,
          file,
          'Durable host call checkpoint'
        );
        return { file, checkpoint: readJson(file), id, error: null };
      } catch (error) {
        return { file, checkpoint: null, id, error };
      }
    });
}

function assertCheckpointDocumentIdentity(root, item, checkpoint) {
  if (!item.id
    || checkpoint.id !== item.id
    || item.file !== hostCallCheckpointPath(root, checkpoint.id)) {
    throw new Error(
      'Durable host call checkpoint identity does not match its exact private state path.'
    );
  }
}

function pendingCheckpointForRun(root, runId, expectedHost) {
  return listDurableCheckpointDocuments(root)
    .flatMap((item) => {
      try {
        const checkpoint = assertCheckpoint(path.resolve(root), item.checkpoint);
        assertCheckpointDocumentIdentity(path.resolve(root), item, checkpoint);
        const state = exactCheckpoint(root, checkpoint.id, expectedHost);
        durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint);
        return [checkpoint];
      } catch {
        return [];
      }
    })
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
  configurationBasis,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  assertOperationPlanDocument(resolvedRoot, plan);
  if (containsCredentialMaterial(plan)) {
    throw new Error('Operation plan contains credential-like material and cannot enter durable state.');
  }
  const selected = selectExactConnectedConfiguration({
    root: resolvedRoot,
    configurationBasis,
    lockPath,
    expectedHost,
    providerImplementations: [...new Set(plan.steps.map((step) => {
      return step.providerImplementation;
    }))]
  });
  const { lockFile, lock } = selected;
  const boundPlan = {
    ...structuredClone(plan),
    configuration: structuredClone(selected.selection)
  };
  if (plan.configuration
    && fingerprintJson(plan.configuration) !== fingerprintJson(selected.selection)) {
    throw new Error(
      'Operation plan configuration binding does not match the exact selected basis.'
    );
  }
  assertOperationPlanDocument(resolvedRoot, boundPlan);
  const createdAt = atOrNow(at || plan.createdAt);
  await preflightOperationPlanSteps({
    root: resolvedRoot,
    lock,
    plan: boundPlan,
    at: createdAt
  });
  const readOnlyFollowup = operationPlanIsReadOnly(resolvedRoot, lock, plan);
  const durable = stageDurableRun(
    resolvedRoot,
    lockFile,
    lock,
    runPath,
    selected.selection,
    readOnlyFollowup ? READ_ONLY_FOLLOWUP_RUN_STATES : EXECUTABLE_RUN_STATES,
    readOnlyFollowup ? assertReadOnlyFollowupRun : null
  );
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
    plan: boundPlan,
    configuration: selected.selection,
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
  const selected = revalidateExactConnectedConfiguration({
    root: resolvedRoot,
    selection: {
      name: approval.request.configuration.name,
      configurationBasis: approval.request.configuration.configurationBasis,
      path: approval.request.configuration.path,
      lockPath: approval.request.configuration.lockPath,
      lockFingerprint: approval.request.configuration.lockFingerprint,
      graphFingerprint: approval.request.configuration.graphFingerprint
    },
    expectedHost,
    providerImplementations: approvalProviderImplementations(approval)
  });
  const { lockFile, lock } = selected;
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
    selected.selection,
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
    reservation = await reserveApprovalConsumption({
      root: resolvedRoot,
      approval,
      checkpointId,
      at: requestedAt
    });
  } else {
    checkpoint = await createVerifiedConnectedTransactionCheckpoint({
      root: resolvedRoot,
      lock,
      lockPath: repoRelativePath(resolvedRoot, lockFile),
      run: durable.run,
      runSourcePath: durable.sourcePath,
      runStatePath: durable.statePath,
      batch,
      changeSet,
      approval,
      configuration: selected.selection,
      at: requestedAt
    });
    reservation = await reserveApprovalConsumption({
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
    checkpoint = await createVerifiedConnectedTransactionCheckpoint({
      root: resolvedRoot,
      lock,
      lockPath: repoRelativePath(resolvedRoot, lockFile),
      run: durable.run,
      runSourcePath: durable.sourcePath,
      runStatePath: durable.statePath,
      batch,
      changeSet,
      approval,
      configuration: selected.selection,
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
  const next = await prepareVerifiedConnectedTransactionReconciliation({
    root,
    lock: state.lock,
    checkpoint,
    at: atOrNow(at)
  });
  return persistDurableCheckpoint(root, next, run);
}

export async function prepareDurableProviderProbeExecution(options) {
  if (options.probeId !== undefined
    && (typeof options.probeId !== 'string'
      || options.probeId.length > SOTER_PROVIDER_PROBE_ID_MAX_LENGTH
      || !/^probe\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(options.probeId))) {
    throw new Error(
      'Provider probe ID must be one canonical probe.* identifier no longer than '
        + SOTER_PROVIDER_PROBE_ID_MAX_LENGTH + ' characters.'
    );
  }
  const selected = selectExactConnectedConfiguration({
    root: options.root,
    configurationBasis: options.configurationBasis,
    lockPath: options.lockPath,
    expectedHost: options.expectedHost,
    providerImplementations: [options.providerImplementation]
  });
  const { lockFile, lock } = selected;
  const createdAt = atOrNow(options.at);
  const providerPart = idPart(
    options.providerImplementation.startsWith('provider.')
      ? options.providerImplementation.slice('provider.'.length)
      : options.providerImplementation
  );
  const probeId = options.probeId || 'probe.' + providerPart + '.' + idPart(createdAt);
  if (options.callId) {
    throw new Error('Provider probe plans use deterministic per-step call IDs.');
  }
  const checkpoint = await createProviderProbePlanCheckpoint({
    root: options.root,
    lock,
    lockPath: repoRelativePath(options.root, lockFile),
    providerImplementation: options.providerImplementation,
    probeId,
    configuration: selected.selection,
    validForSeconds: options.validForSeconds ?? 300,
    at: createdAt
  });
  if (hasHostCallCheckpoint(options.root, checkpoint.id)) {
    throw new Error('Durable provider probe checkpoint already exists: ' + checkpoint.id + '.');
  }
  return persistDurableCheckpoint(options.root, checkpoint);
}

export async function prepareDurableCapabilityExecution(options) {
  const selected = selectExactConnectedConfiguration({
    root: options.root,
    configurationBasis: options.configurationBasis,
    lockPath: options.lockPath,
    expectedHost: options.expectedHost,
    providerImplementations: [options.providerImplementation]
  });
  const { lockFile, lock } = selected;
  if (containsCredentialMaterial(options.input)) {
    throw new Error('Capability input contains credential-like material and cannot enter durable state.');
  }
  const durable = stageDurableRun(
    path.resolve(options.root),
    lockFile,
    lock,
    options.runPath,
    selected.selection
  );
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
    configuration: selected.selection,
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
    configuration: selected.selection,
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
    runPath: run ? repoRelativePath(root, runStatePath(root, run.id)) : null
  };
  if (state.checkpoint.kind === 'operation-plan') {
    result.currentCall = operationPlanCurrentCall(state.checkpoint);
  } else if (state.checkpoint.kind === 'connected-transaction') {
    result.currentCall = verifiedConnectedTransactionCurrentCall(state.checkpoint);
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
  const currentCall = operationPlanCurrentCall(checkpoint);
  if (!planCheckpointContainsCallId(checkpoint, callId)) {
    throw new Error('Operation plan response does not match the exact current step call.');
  }
  await assertDurableNativeResponseEnvelope({
    root,
    checkpointId,
    callId,
    response,
    at,
    expectedHost,
    recordFailure: Boolean(currentCall && currentCall.id === callId)
  });
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

export async function recoverDurableOperationPlanReadExecution(options) {
  assertExactServiceArguments(options, new Set([
    'root',
    'checkpointId',
    'checkpointFingerprint',
    'stepId',
    'callId',
    'callFingerprint',
    'at',
    'expectedHost'
  ]), 'Durable operation-plan read recovery');
  const {
    root,
    checkpointId,
    checkpointFingerprint: expectedCheckpointFingerprint,
    stepId,
    callId,
    callFingerprint,
    at,
    expectedHost
  } = options;
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  const checkpoint = state.checkpoint;
  if (checkpoint.kind !== 'operation-plan') {
    throw new Error('Checkpoint ' + checkpointId + ' is not an operation plan.');
  }
  if (!operationPlanIsReadOnly(root, state.lock, checkpoint.plan)) {
    throw new Error(
      'Durable operation-plan recovery cannot reopen a plan containing non-read effects.'
    );
  }
  const run = durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint);
  if (!run || run.approvals.length !== 0) {
    throw new Error(
      'Durable operation-plan read recovery requires a run with no approval authority.'
    );
  }
  const recovered = await recoverOperationPlanReadStep({
    root,
    lock: state.lock,
    checkpoint,
    checkpointFingerprint: expectedCheckpointFingerprint,
    stepId,
    callId,
    callFingerprint,
    at: atOrNow(at)
  });
  if (recovered.idempotent) {
    return {
      ...durableResult(root, state),
      recovery: recovered.recovery,
      idempotent: true
    };
  }
  return {
    ...persistDurableCheckpoint(root, recovered.checkpoint, run),
    recovery: recovered.recovery,
    idempotent: false
  };
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
  const currentCall = verifiedConnectedTransactionCurrentCall(checkpoint);
  if (!connectedCheckpointContainsCallId(checkpoint, callId)) {
    throw new Error('Connected transaction response does not match the exact current call ID.');
  }
  await assertDurableNativeResponseEnvelope({
    root,
    checkpointId,
    callId,
    response,
    at,
    expectedHost,
    recordFailure: Boolean(currentCall && currentCall.id === callId)
  });
  const run = durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint);
  const completed = await completeVerifiedConnectedTransactionCall({
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
  if (checkpoint.$contract !== 'soter://contracts/provider-probe-plan-checkpoint/v1') {
    throw new Error('Provider probe checkpoint does not use the required plan contract.');
  }
  if (!callId) throw new Error('Provider probe plans require the exact current call ID.');
  const currentCall = providerProbePlanCurrentCall(checkpoint);
  if (!planCheckpointContainsCallId(checkpoint, callId)) {
    throw new Error('Provider probe response does not match the exact current call ID.');
  }
  await assertDurableNativeResponseEnvelope({
    root,
    checkpointId,
    callId,
    response,
    at,
    expectedHost,
    recordFailure: Boolean(currentCall && currentCall.id === callId)
  });
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

export async function completeDurableCapabilityExecution({
  root,
  checkpointId,
  callId,
  response,
  at,
  expectedHost
}) {
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  const checkpoint = state.checkpoint;
  if (checkpoint.kind !== 'capability') {
    throw new Error('Checkpoint ' + checkpointId + ' is not a capability call.');
  }
  const priorPage = checkpoint.call.pagination?.pages.find((page) => page.callId === callId);
  if (checkpoint.call.pagination && !callId) {
    throw new Error('Paginated capability completion requires the exact current call ID.');
  }
  if (!priorPage && callId && checkpoint.call.id !== callId) {
    throw new Error('Capability response does not match the exact current call ID.');
  }
  await assertDurableNativeResponseEnvelope({
    root,
    checkpointId,
    callId,
    response,
    at,
    expectedHost,
    recordFailure: checkpoint.state === 'requested'
      && (!callId || checkpoint.call.id === callId)
  });
  const responseFingerprint = fingerprintJson(response);
  if (priorPage) {
    if (priorPage.responseFingerprint !== responseFingerprint) {
      throw new Error('Capability response does not match the exact completed page call.');
    }
    return durableResult(root, state);
  }
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

export async function failDurableHostExecution(options) {
  assertExactServiceArguments(options, new Set([
    'root',
    'checkpointId',
    'errorKind',
    'callId',
    'at',
    'expectedHost'
  ]), 'Durable host failure recording');
  const {
    root,
    checkpointId,
    errorKind,
    callId,
    at,
    expectedHost
  } = options;
  if (!isHostFailureKind(errorKind)) {
    throw new Error(
      'Durable host failure requires an explicit closed error kind; use unknown when no narrower kind applies.'
    );
  }
  const state = exactCheckpoint(root, checkpointId, expectedHost);
  const checkpoint = state.checkpoint;
  const failure = normalizedError({ kind: errorKind });
  if (checkpoint.kind === 'connected-transaction') {
    if (!callId) throw new Error('Connected transaction failures require the exact current call ID.');
    const run = durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint);
    const failed = await failVerifiedConnectedTransactionCall({
      root, lock: state.lock, checkpoint, callId,
      error: failure, at: atOrNow(at)
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
      error: failure,
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
      error: failure,
      at: atOrNow(at)
    });
    if (failed.idempotent) return durableResult(root, state);
    return persistDurableCheckpoint(root, failed.checkpoint);
  }
  if (checkpoint.kind !== 'capability') {
    throw new Error('Unsupported durable host checkpoint contract.');
  }
  if (checkpoint.state !== 'requested') {
    if (checkpoint.call.error
      && fingerprintJson(checkpoint.call.error) === fingerprintJson(failure)) {
      return durableResult(root, state);
    }
    throw new Error('Only a requested host call checkpoint can record a host failure.');
  }
  if (checkpoint.kind === 'capability' && checkpoint.call.pagination && !callId) {
    throw new Error('Paginated capability failures require the exact current call ID.');
  }
  if (callId && checkpoint.call.id !== callId) {
    throw new Error('Host failure does not match the exact checkpoint call ID.');
  }
  const completedAt = atOrNow(at);
  const failedCall = failHostToolCall({
    root,
    lock: state.lock,
    call: checkpoint.call,
    error: failure,
    at: completedAt
  });
  const next = {
    ...checkpoint,
    updatedAt: completedAt,
    state: failedCall.state,
    call: failedCall,
    result: null
  };
  const run = durableRunForCheckpoint(root, state.lockFile, state.lock, checkpoint);
  return persistDurableCheckpoint(root, next, run);
}

export function getDurableHostExecution({ root, checkpointId, expectedHost }) {
  return durableResult(root, exactCheckpoint(root, checkpointId, expectedHost));
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
  const progressedCheckpoint = sealCheckpoint({
    ...structuredClone(checkpoint),
    run: {
      ...structuredClone(checkpoint.run),
      fingerprint: fingerprintJson(nextRun)
    }
  });
  const progressedCheckpointState = writeHostCallCheckpoint(
    resolvedRoot,
    progressedCheckpoint
  );
  return {
    checkpoint: progressedCheckpoint,
    checkpointPath: progressedCheckpointState.path,
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
  if (checkpoint.$contract !== 'soter://contracts/provider-probe-plan-checkpoint/v1') {
    throw new Error('Provider probe checkpoint does not use the required plan contract.');
  }
  const runtimeStep = checkpoint.steps.find((step) => step.state === 'failed');
  const sourceStep = runtimeStep
    ? checkpoint.plan.steps.find((step) => step.id === runtimeStep.id)
    : null;
  const call = runtimeStep?.call;
  const error = runtimeStep?.error;
  const scope = checkpoint.plan.scope;
  const provider = checkpoint.provider;
  const probeId = checkpoint.plan.probeId;
  const validForSeconds = checkpoint.plan.validForSeconds;
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
      transport: {
        protocol: call.transport.protocol,
        server: call.transport.server,
        operation: call.transport.operation,
        tool: call.transport.tool
      }
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
  const resolvedRoot = path.resolve(root);
  const checkpoints = listDurableCheckpointDocuments(resolvedRoot)
    .flatMap((item) => {
      let checkpoint;
      try {
        if (item.error) throw item.error;
        checkpoint = assertCheckpoint(resolvedRoot, item.checkpoint);
        assertCheckpointDocumentIdentity(resolvedRoot, item, checkpoint);
      } catch {
        const id = item.id || (typeof item.checkpoint?.id === 'string'
          && /^checkpoint\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(item.checkpoint.id)
          ? item.checkpoint.id
          : null);
        return [{
          id,
          kind: null,
          state: null,
          availability: 'unavailable',
          reasonCode: 'CONNECTED_EXECUTION_STATE_INVALID',
          callId: null,
          updatedAt: null,
          host: null,
          provider: null,
          capability: null,
          runId: null,
          planId: null,
          currentStepId: null,
          batchId: null,
          currentStage: null
        }];
      }
      if (expectedHost && checkpoint.host.id !== expectedHost) return [];
      if (state && checkpoint.state !== state) return [];
      let exact;
      try {
        exact = exactCheckpoint(resolvedRoot, checkpoint.id, expectedHost);
        durableResult(resolvedRoot, exact);
      } catch (error) {
        return [{
          id: checkpoint.id,
          kind: checkpoint.kind,
          state: checkpoint.state,
          availability: 'unavailable',
          reasonCode: error instanceof ConnectedConfigurationError
            ? error.code
            : 'CONNECTED_EXECUTION_STATE_STALE',
          callId: null,
          updatedAt: checkpoint.updatedAt,
          host: checkpoint.host.id,
          provider: null,
          capability: null,
          runId: null,
          planId: null,
          currentStepId: null,
          batchId: null,
          currentStage: null
        }];
      }
      const planned = checkpoint.kind === 'operation-plan'
        || checkpoint.$contract === 'soter://contracts/provider-probe-plan-checkpoint/v1';
      const call = checkpoint.kind === 'operation-plan'
        ? operationPlanCurrentCall(checkpoint)
          || checkpoint.steps.findLast((step) => step.call)?.call
        : checkpoint.kind === 'connected-transaction'
          ? verifiedConnectedTransactionCurrentCall(checkpoint)
            || checkpoint.operations.flatMap((operation) => [
              operation.precondition,
              operation.write,
              operation.verification,
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
        availability: 'current',
        reasonCode: 'CONNECTED_EXECUTION_CURRENT',
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
