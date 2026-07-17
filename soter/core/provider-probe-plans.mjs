import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  assertObservationScope,
  assertProbeContract,
  probePlan,
  providerProbeSources,
  selectedProvider,
  validUntil
} from './provider-probes.mjs';
import {
  assertMcpRuntime,
  containsCredentialMaterial,
  loadProviderMappings,
  loadProviderModule,
  normalizedError,
  resolveHostTool
} from './host-runtime.mjs';
import { fingerprintJson, readJson } from './lib/canonical-json.mjs';
import { fingerprintLock } from './resolve.mjs';

const CHECKPOINT_CONTRACT = 'soter://contracts/provider-probe-plan-checkpoint/v1';
const REQUIRED_PLAN_EXPORTS = [
  'probePlanExport',
  'probeStepCompleteExport',
  'probeFinalizeExport'
];
const STEP_KINDS = new Set(['identity', 'schema', 'read', 'document']);

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

function providerIdentity(provider) {
  return {
    pack: provider.pack,
    implementation: provider.id,
    version: provider.version,
    containment: provider.containment
  };
}

function hostIdentity(lock) {
  return {
    id: lock.host.id,
    adapter: lock.host.adapter,
    version: lock.host.version
  };
}

function checkpointFingerprint(checkpoint) {
  const value = structuredClone(checkpoint);
  delete value.checkpointFingerprint;
  return fingerprintJson(value);
}

function stepCallId(plan, step) {
  return 'probecall.' + plan.probeId.slice('probe.'.length)
    + '.' + step.id.slice('step.'.length);
}

function probePlanId(probeId) {
  return 'probeplan.' + probeId.slice('probe.'.length);
}

function assertPlanRuntime(provider) {
  assertMcpRuntime(provider);
  const missing = REQUIRED_PLAN_EXPORTS.filter((field) => !provider.runtime[field]);
  if (missing.length) {
    throw new Error(
      provider.id + ' does not declare a complete provider probe plan runtime: '
        + missing.join(', ') + '.'
    );
  }
}

export function providerUsesProbePlan(root, lock, providerImplementation) {
  const { provider } = selectedProvider(path.resolve(root), lock, providerImplementation);
  return REQUIRED_PLAN_EXPORTS.every((field) => typeof provider.runtime[field] === 'string');
}

function validateTranslatorStep(root, lock, provider, step, ids) {
  if (!step || typeof step !== 'object' || Array.isArray(step)
    || typeof step.id !== 'string' || !/^step\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(step.id)
    || ids.has(step.id)
    || !STEP_KINDS.has(step.kind)
    || typeof step.subject !== 'string' || step.subject.length < 3
    || !step.scope || typeof step.scope !== 'object' || Array.isArray(step.scope)
    || typeof step.tool !== 'string'
    || !step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments)) {
    throw Object.assign(
      new Error('Provider probe plan translator returned an invalid or duplicate step.'),
      { kind: 'validation' }
    );
  }
  ids.add(step.id);
  if (!provider.runtime.probeTools.includes(step.tool)
    || !provider.runtime.tools.includes(step.tool)) {
    throw Object.assign(
      new Error('Provider probe plan requested undeclared MCP probe tool ' + step.tool + '.'),
      { kind: 'validation' }
    );
  }
  if (containsCredentialMaterial(step.scope) || containsCredentialMaterial(step.arguments)) {
    throw Object.assign(
      new Error('Provider probe plan contains credential-like material; authentication belongs to the host.'),
      { kind: 'validation' }
    );
  }
  const hostTool = resolveHostTool(root, lock, provider, step.tool);
  return {
    id: step.id,
    kind: step.kind,
    subject: step.subject,
    scope: structuredClone(step.scope),
    scopeFingerprint: fingerprintJson(step.scope),
    transport: {
      protocol: 'mcp',
      server: provider.runtime.server,
      operation: step.tool,
      tool: hostTool.nativeTool
    },
    arguments: structuredClone(step.arguments),
    argumentsFingerprint: fingerprintJson(step.arguments)
  };
}

async function derivePlan({
  root,
  lock,
  providerImplementation,
  probeId,
  validForSeconds,
  at,
  translator
}) {
  const resolvedRoot = path.resolve(root);
  const { provider, bindings } = selectedProvider(
    resolvedRoot,
    lock,
    providerImplementation
  );
  assertPlanRuntime(provider);
  const scope = probePlan(resolvedRoot, lock, provider, bindings);
  const sources = providerProbeSources(lock, bindings);
  const implementation = await loadProviderModule(resolvedRoot, provider, translator);
  const prepare = implementation[provider.runtime.probePlanExport];
  if (typeof prepare !== 'function') {
    throw Object.assign(
      new Error('MCP probe plan export is not a function: ' + provider.runtime.probePlanExport),
      { kind: 'validation' }
    );
  }
  const prepared = await prepare({
    plan: scope,
    sources,
    settings: lock.settings || {},
    mappings: loadProviderMappings(resolvedRoot, provider),
    at
  });
  if (!prepared || !Array.isArray(prepared.steps)
    || prepared.steps.length < 1 || prepared.steps.length > 50) {
    throw Object.assign(
      new Error('MCP probe plan translator must return 1 through 50 explicit steps.'),
      { kind: 'validation' }
    );
  }
  const ids = new Set();
  const steps = prepared.steps.map((step) => {
    return validateTranslatorStep(resolvedRoot, lock, provider, step, ids);
  });
  return {
    provider,
    plan: {
      id: probePlanId(probeId),
      probeId,
      scope,
      validForSeconds,
      steps
    }
  };
}

function requestedCall(plan, step, at) {
  return {
    id: stepCallId(plan, step),
    createdAt: at,
    completedAt: null,
    state: 'requested',
    transport: structuredClone(step.transport),
    arguments: structuredClone(step.arguments),
    argumentsFingerprint: step.argumentsFingerprint,
    responseFingerprint: null,
    error: null
  };
}

function requestNextStep(checkpoint, at) {
  const next = structuredClone(checkpoint);
  const runtimeStep = next.steps.find((step) => step.state === 'pending');
  if (!runtimeStep) return next;
  const source = next.plan.steps.find((step) => step.id === runtimeStep.id);
  runtimeStep.state = 'requested';
  runtimeStep.call = requestedCall(next.plan, source, at);
  runtimeStep.error = null;
  next.updatedAt = at;
  next.state = 'requested';
  next.currentStepId = runtimeStep.id;
  next.result = null;
  return next;
}

function assertRuntimeStep(checkpoint, runtimeStep, source, index) {
  if (runtimeStep.id !== source.id || runtimeStep.sequence !== index + 1) {
    throw new Error('Provider probe runtime steps do not preserve exact source order.');
  }
  if (source.scopeFingerprint !== fingerprintJson(source.scope)
    || source.argumentsFingerprint !== fingerprintJson(source.arguments)) {
    throw new Error('Provider probe source step contains a stale scope or argument fingerprint.');
  }
  if (runtimeStep.state === 'pending') {
    if (runtimeStep.call !== null || runtimeStep.result !== null
      || runtimeStep.resultFingerprint !== null || runtimeStep.error !== null) {
      throw new Error('Pending provider probe step contains execution state.');
    }
    return;
  }
  const call = runtimeStep.call;
  if (!call
    || call.id !== stepCallId(checkpoint.plan, source)
    || fingerprintJson(call.transport) !== fingerprintJson(source.transport)
    || fingerprintJson(call.arguments) !== fingerprintJson(source.arguments)
    || call.argumentsFingerprint !== source.argumentsFingerprint
    || call.state !== runtimeStep.state) {
    throw new Error('Provider probe runtime step does not match its exact host call.');
  }
  if (runtimeStep.state === 'requested') {
    if (call.completedAt !== null || call.responseFingerprint !== null
      || call.error !== null || runtimeStep.result !== null
      || runtimeStep.resultFingerprint !== null || runtimeStep.error !== null) {
      throw new Error('Requested provider probe step contains terminal state.');
    }
  } else if (runtimeStep.state === 'completed') {
    if (!call.completedAt || !call.responseFingerprint || call.error !== null
      || !runtimeStep.result
      || !minimizedStepResult(runtimeStep.result)
      || runtimeStep.resultFingerprint !== fingerprintJson(runtimeStep.result)
      || runtimeStep.error !== null) {
      throw new Error('Completed provider probe step has inconsistent minimized state.');
    }
  } else if (!call.completedAt || !call.error
    || runtimeStep.result !== null || runtimeStep.resultFingerprint !== null
    || fingerprintJson(runtimeStep.error) !== fingerprintJson(call.error)) {
    throw new Error('Failed provider probe step has inconsistent error state.');
  }
}

export function assertProviderProbePlanCheckpoint(root, checkpoint) {
  const resolvedRoot = path.resolve(root);
  contractFailures(
    resolvedRoot,
    checkpoint,
    'soter/contracts/provider-probe-plan-checkpoint.schema.json',
    'Provider probe plan checkpoint'
  );
  if (checkpoint.checkpointFingerprint !== checkpointFingerprint(checkpoint)
    || checkpoint.planFingerprint !== fingerprintJson(checkpoint.plan)
    || checkpoint.steps.length !== checkpoint.plan.steps.length) {
    throw new Error('Provider probe checkpoint fingerprint or plan is stale.');
  }
  checkpoint.steps.forEach((step, index) => {
    assertRuntimeStep(checkpoint, step, checkpoint.plan.steps[index], index);
  });
  let completedPrefix = 0;
  while (checkpoint.steps[completedPrefix]?.state === 'completed') completedPrefix += 1;
  const active = checkpoint.steps[completedPrefix] || null;
  if (checkpoint.steps.slice(completedPrefix + 1).some((step) => step.state !== 'pending')) {
    throw new Error('Provider probe steps must execute sequentially.');
  }
  if (!active) {
    if (checkpoint.state !== 'completed' || checkpoint.currentStepId !== null
      || checkpoint.result?.$contract !== 'soter://contracts/provider-probe/v2') {
      throw new Error('Completed provider probe checkpoint has inconsistent terminal state.');
    }
    assertProbeContract(resolvedRoot, checkpoint.result);
  } else if (checkpoint.state === 'requested') {
    if (active.state !== 'requested' || checkpoint.currentStepId !== active.id
      || checkpoint.result !== null) {
      throw new Error('Requested provider probe checkpoint does not identify one exact step.');
    }
  } else if (checkpoint.state === 'failed') {
    if (active.state !== 'failed' || checkpoint.currentStepId !== null
      || checkpoint.result !== null) {
      throw new Error('Failed provider probe checkpoint has inconsistent terminal state.');
    }
  } else {
    throw new Error('Provider probe checkpoint state does not match its sequential steps.');
  }
  return checkpoint;
}

export function providerProbePlanCurrentCall(checkpoint) {
  if (checkpoint?.$contract !== CHECKPOINT_CONTRACT
    || checkpoint.state !== 'requested' || !checkpoint.currentStepId) return null;
  return checkpoint.steps.find((step) => step.id === checkpoint.currentStepId)?.call || null;
}

export async function createProviderProbePlanCheckpoint({
  root,
  lock,
  lockPath,
  providerImplementation,
  probeId,
  validForSeconds = 300,
  at,
  translator = null
}) {
  if (!Number.isInteger(validForSeconds) || validForSeconds < 60 || validForSeconds > 900) {
    throw new Error('Provider probes must be valid for an integer duration from 60 through 900 seconds.');
  }
  if (typeof probeId !== 'string'
    || !/^probe\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(probeId)) {
    throw new Error('Provider probe plan requires a valid probe.* identifier.');
  }
  if (!Number.isFinite(Date.parse(at))) {
    throw new Error('Provider probe plan requires a valid creation timestamp.');
  }
  const derived = await derivePlan({
    root,
    lock,
    providerImplementation,
    probeId,
    validForSeconds,
    at,
    translator
  });
  const checkpoint = {
    $contract: CHECKPOINT_CONTRACT,
    contractVersion: '1.0.0',
    id: 'checkpoint.' + derived.plan.id,
    kind: 'provider-probe',
    createdAt: at,
    updatedAt: at,
    state: 'failed',
    configurationLock: {
      path: lockPath,
      fingerprint: fingerprintLock(lock)
    },
    graphFingerprint: lock.graphFingerprint,
    host: hostIdentity(lock),
    provider: providerIdentity(derived.provider),
    plan: derived.plan,
    planFingerprint: fingerprintJson(derived.plan),
    steps: derived.plan.steps.map((step, index) => ({
      id: step.id,
      sequence: index + 1,
      state: 'pending',
      call: null,
      result: null,
      resultFingerprint: null,
      error: null
    })),
    currentStepId: null,
    result: null,
    privacy: {
      scope: 'private',
      rawProviderResponsePersisted: false,
      hostCredentialValuesPersisted: false
    },
    checkpointFingerprint: fingerprintJson(null)
  };
  return requestNextStep(checkpoint, at);
}

async function exactDerivedPlan({ root, lock, checkpoint, translator }) {
  const derived = await derivePlan({
    root,
    lock,
    providerImplementation: checkpoint.provider.implementation,
    probeId: checkpoint.plan.probeId,
    validForSeconds: checkpoint.plan.validForSeconds,
    at: checkpoint.createdAt,
    translator
  });
  if (fingerprintJson(derived.plan) !== checkpoint.planFingerprint
    || fingerprintJson(providerIdentity(derived.provider))
      !== fingerprintJson(checkpoint.provider)) {
    throw new Error('Provider probe checkpoint does not match the current exact provider plan.');
  }
  return derived;
}

function assertCheckScope(plan, checks) {
  if (!Array.isArray(checks) || checks.length !== plan.steps.length) {
    throw Object.assign(
      new Error('Probe finalizer must return one exact check per probe plan step.'),
      { kind: 'validation' }
    );
  }
  const byStep = new Map(checks.map((check) => [check?.stepId, check]));
  if (byStep.size !== checks.length) {
    throw Object.assign(new Error('Probe finalizer returned duplicate step checks.'), {
      kind: 'validation'
    });
  }
  for (const step of plan.steps) {
    const check = byStep.get(step.id);
    if (!check || check.id !== 'check.' + step.id.slice('step.'.length)
      || check.kind !== step.kind || check.subject !== step.subject
      || check.scopeFingerprint !== step.scopeFingerprint) {
      throw Object.assign(
        new Error('Probe finalizer widened or changed an exact step check.'),
        { kind: 'validation' }
      );
    }
  }
}

async function finalizeCheckpoint({ root, lock, checkpoint, implementation, provider, at }) {
  const finalize = implementation[provider.runtime.probeFinalizeExport];
  if (typeof finalize !== 'function') {
    throw Object.assign(
      new Error('MCP probe finalize export is not a function: ' + provider.runtime.probeFinalizeExport),
      { kind: 'validation' }
    );
  }
  const observations = await finalize({
    plan: checkpoint.plan.scope,
    steps: structuredClone(checkpoint.plan.steps),
    results: checkpoint.steps.map((step) => ({
      stepId: step.id,
      result: structuredClone(step.result),
      resultFingerprint: step.resultFingerprint
    })),
    settings: lock.settings || {},
    mappings: loadProviderMappings(root, provider),
    at
  });
  assertObservationScope(checkpoint.plan.scope, observations);
  assertCheckScope(checkpoint.plan, observations.checks);
  const probe = {
    $contract: 'soter://contracts/provider-probe/v2',
    contractVersion: '2.0.0',
    id: checkpoint.plan.probeId,
    probedAt: at,
    validUntil: validUntil(at, checkpoint.plan.validForSeconds),
    configuration: {
      name: lock.configuration.name,
      lockFingerprint: fingerprintLock(lock)
    },
    provider: structuredClone(checkpoint.provider),
    credentials: observations.credentials,
    reachability: observations.reachability,
    authorities: observations.authorities,
    capabilities: observations.capabilities,
    checks: observations.checks,
    secretValuesExcluded: true,
    limitations: observations.limitations
  };
  assertProbeContract(root, probe);
  return probe;
}

function priorResponse(checkpoint, callId, response) {
  const step = checkpoint.steps.find((item) => item.call?.id === callId);
  if (!step?.call?.responseFingerprint) return false;
  if (step.call.responseFingerprint !== fingerprintJson(response)) {
    throw new Error('Provider probe response does not match the exact completed step call.');
  }
  return true;
}

function minimizedStepResult(value, depth = 0) {
  if (depth > 5) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0;
  if (typeof value === 'string') return /^sha256:[a-f0-9]{64}$/.test(value);
  if (Array.isArray(value)) {
    return value.length <= 50 && value.every((item) => minimizedStepResult(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return false;
  const entries = Object.entries(value);
  return entries.length <= 50 && entries.every(([key, child]) => {
    return /^[A-Za-z][A-Za-z0-9]*$/.test(key)
      && minimizedStepResult(child, depth + 1);
  });
}

export async function completeProviderProbePlanStep({
  root,
  lock,
  checkpoint,
  callId,
  response,
  at,
  translator = null
}) {
  const resolvedRoot = path.resolve(root);
  assertProviderProbePlanCheckpoint(resolvedRoot, checkpoint);
  const currentCall = providerProbePlanCurrentCall(checkpoint);
  if (!currentCall || currentCall.id !== callId) {
    if (priorResponse(checkpoint, callId, response)) {
      return { checkpoint: structuredClone(checkpoint), idempotent: true };
    }
    throw new Error('Provider probe response does not match the exact current step call.');
  }
  if (checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Provider probe response does not match the exact lock and graph request.');
  }
  const { provider } = await exactDerivedPlan({
    root: resolvedRoot,
    lock,
    checkpoint,
    translator
  });
  const implementation = await loadProviderModule(resolvedRoot, provider, translator);
  const complete = implementation[provider.runtime.probeStepCompleteExport];
  if (typeof complete !== 'function') {
    throw new Error(
      'MCP probe step complete export is not a function: '
        + provider.runtime.probeStepCompleteExport
    );
  }
  const next = structuredClone(checkpoint);
  const runtimeStep = next.steps.find((step) => step.id === next.currentStepId);
  const source = next.plan.steps.find((step) => step.id === next.currentStepId);
  const responseFingerprint = fingerprintJson(response);
  try {
    const result = await complete({
      step: structuredClone(source),
      response,
      plan: next.plan.scope,
      settings: lock.settings || {},
      mappings: loadProviderMappings(resolvedRoot, provider),
      at
    });
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || containsCredentialMaterial(result) || !minimizedStepResult(result)) {
      throw Object.assign(
        new Error(
          'Probe step translator must return minimized credential-free state containing only booleans, non-negative integers, fingerprints, arrays, and named objects.'
        ),
        { kind: 'validation' }
      );
    }
    runtimeStep.state = 'completed';
    runtimeStep.call = {
      ...runtimeStep.call,
      completedAt: at,
      state: 'completed',
      responseFingerprint,
      error: null
    };
    runtimeStep.result = structuredClone(result);
    runtimeStep.resultFingerprint = fingerprintJson(result);
    runtimeStep.error = null;
    next.updatedAt = at;
    next.currentStepId = null;
    const pending = next.steps.find((step) => step.state === 'pending');
    if (pending) {
      return {
        checkpoint: requestNextStep(next, at),
        idempotent: false
      };
    }
    next.result = await finalizeCheckpoint({
      root: resolvedRoot,
      lock,
      checkpoint: next,
      implementation,
      provider,
      at
    });
    next.state = 'completed';
    return { checkpoint: next, idempotent: false };
  } catch (error) {
    const normalized = normalizedError(error, 'validation');
    runtimeStep.state = 'failed';
    runtimeStep.call = {
      ...runtimeStep.call,
      completedAt: at,
      state: 'failed',
      responseFingerprint,
      error: normalized
    };
    runtimeStep.result = null;
    runtimeStep.resultFingerprint = null;
    runtimeStep.error = normalized;
    next.updatedAt = at;
    next.state = 'failed';
    next.currentStepId = null;
    next.result = null;
    return { checkpoint: next, idempotent: false };
  }
}

export function failProviderProbePlanStep({
  root,
  lock,
  checkpoint,
  callId,
  error,
  at
}) {
  assertProviderProbePlanCheckpoint(root, checkpoint);
  const currentCall = providerProbePlanCurrentCall(checkpoint);
  if (!currentCall || currentCall.id !== callId) {
    const previous = checkpoint.steps.find((step) => step.call?.id === callId);
    if (previous?.call?.error?.kind === error.kind
      && previous.call.error.message === error.message) {
      return { checkpoint: structuredClone(checkpoint), idempotent: true };
    }
    throw new Error('Provider probe failure does not match the exact current step call.');
  }
  if (checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Provider probe failure does not match the exact lock and graph request.');
  }
  const next = structuredClone(checkpoint);
  const runtimeStep = next.steps.find((step) => step.id === next.currentStepId);
  const normalized = normalizedError(error);
  runtimeStep.state = 'failed';
  runtimeStep.call = {
    ...runtimeStep.call,
    completedAt: at,
    state: 'failed',
    responseFingerprint: null,
    error: normalized
  };
  runtimeStep.result = null;
  runtimeStep.resultFingerprint = null;
  runtimeStep.error = normalized;
  next.updatedAt = at;
  next.state = 'failed';
  next.currentStepId = null;
  next.result = null;
  return { checkpoint: next, idempotent: false };
}
