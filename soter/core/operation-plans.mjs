import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  assertHostToolCall,
  completeHostToolCall,
  failHostToolCall,
  preflightHostToolBinding,
  prepareHostToolCall
} from './host-tools.mjs';
import { normalizedError } from './host-runtime.mjs';
import { fingerprintJson, readJson } from './lib/canonical-json.mjs';

const PLAN_V2 = 'soter://contracts/operation-plan/v2';
const CHECKPOINT_V2 = 'soter://contracts/operation-plan-checkpoint/v2';

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

function idPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function operationPlanCallId(plan, step) {
  return 'toolcall.' + idPart(plan.id) + '.' + idPart(step.id);
}

function checkpointFingerprint(checkpoint) {
  const value = structuredClone(checkpoint);
  delete value.checkpointFingerprint;
  return fingerprintJson(value);
}

function planSchemaPath(plan) {
  if (plan?.$contract === PLAN_V2) return 'soter/contracts/operation-plan-v2.schema.json';
  throw new Error('Unsupported operation plan contract: ' + plan?.$contract + '.');
}

function checkpointSchemaPath(checkpoint) {
  if (checkpoint?.$contract === CHECKPOINT_V2) {
    return 'soter/contracts/operation-plan-checkpoint-v2.schema.json';
  }
  throw new Error('Unsupported operation plan checkpoint contract: ' + checkpoint?.$contract + '.');
}

function expectedResult(plan, steps) {
  return {
    stepResults: steps.map((step) => ({
      stepId: step.id,
      state: step.state,
      resolvedInputFingerprint: step.resolvedInputFingerprint,
      outputFingerprint: step.outputFingerprint
    }))
  };
}

function pathKey(pathParts) {
  return pathParts.join('.');
}

function pathExists(value, pathParts) {
  let current = value;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, part)) {
      return false;
    }
    current = current[part];
  }
  return true;
}

function targetPathTraversesFixedScalar(value, pathParts) {
  let current = value;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    if (!current || typeof current !== 'object' || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, part)) {
      return false;
    }
    current = current[part];
    if (!current || typeof current !== 'object' || Array.isArray(current)) return true;
  }
  return false;
}

function pathsOverlap(left, right) {
  const sharedLength = Math.min(left.length, right.length);
  return left.slice(0, sharedLength).every((part, index) => part === right[index]);
}

function setBoundPath(value, pathParts, boundValue) {
  let current = value;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    if (!Object.prototype.hasOwnProperty.call(current, part)) current[part] = {};
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      throw new Error('Binding target ' + pathKey(pathParts) + ' traverses a non-object value.');
    }
    current = current[part];
  }
  current[pathParts.at(-1)] = boundValue;
}

function selectedValues(value, pathParts, bindingId) {
  let current = [value];
  for (const part of pathParts) {
    if (part === '*') {
      const expanded = [];
      for (const item of current) {
        if (!Array.isArray(item)) {
          throw new Error('Binding ' + bindingId + ' wildcard source is not an array.');
        }
        expanded.push(...item);
      }
      current = expanded;
      continue;
    }
    current = current.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || !Object.prototype.hasOwnProperty.call(item, part)) {
        throw new Error('Binding ' + bindingId + ' source is missing ' + part + '.');
      }
      return item[part];
    });
  }
  return current;
}

function flattenStrings(values, bindingId, into = []) {
  for (const value of values) {
    if (value === null) continue;
    if (Array.isArray(value)) {
      flattenStrings(value, bindingId, into);
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Binding ' + bindingId + ' requires only non-empty string values.');
    }
    into.push(value);
  }
  return into;
}

function resolveBindingValue(sourceRuntime, binding) {
  if (sourceRuntime.state === 'skipped') return [];
  if (sourceRuntime.state !== 'completed' || !sourceRuntime.output) {
    throw new Error(
      'Binding ' + binding.id + ' source step ' + binding.sourceStepId
        + ' has no completed output.'
    );
  }
  const selected = selectedValues(sourceRuntime.output, binding.sourcePath, binding.id);
  const strings = flattenStrings(selected, binding.id);
  if (binding.transform === 'unique-string-list') {
    return [...new Set(strings)]
      .sort((left, right) => left.localeCompare(right, 'en'));
  }
  if (binding.transform === 'exact-string') {
    if (strings.length !== 1) {
      throw new Error(
        'Binding ' + binding.id + ' requires exactly one non-empty string value.'
      );
    }
    return strings[0];
  }
  throw new Error('Unsupported binding transform ' + binding.transform + '.');
}

function resolveBoundStepInput(checkpoint, source) {
  const input = structuredClone(source.input);
  const resolutions = [];
  let action = 'ready';
  try {
    for (const binding of source.inputBindings) {
      const sourceRuntime = checkpoint.steps.find((step) => step.id === binding.sourceStepId);
      const value = resolveBindingValue(sourceRuntime, binding);
      setBoundPath(input, binding.targetPath, value);
      const valueCount = Array.isArray(value) ? value.length : value ? 1 : 0;
      const empty = valueCount === 0;
      resolutions.push({
        id: binding.id,
        sourceStepId: binding.sourceStepId,
        sourceOutputFingerprint: sourceRuntime.outputFingerprint,
        sourcePath: structuredClone(binding.sourcePath),
        targetPath: structuredClone(binding.targetPath),
        transform: binding.transform,
        onEmpty: binding.onEmpty,
        state: empty ? 'empty' : 'bound',
        valueCount,
        valueFingerprint: fingerprintJson(value)
      });
      if (empty && binding.onEmpty === 'fail-plan') action = 'fail';
      if (empty && binding.onEmpty === 'skip-step' && action !== 'fail') action = 'skip';
    }
  } catch (error) {
    return {
      action: 'fail',
      input: null,
      inputFingerprint: null,
      resolutions,
      error: {
        kind: 'validation',
        code: 'OPERATION_PLAN_BINDING_INVALID',
        message: 'The exact operation-plan binding was invalid.'
      }
    };
  }
  const inputFingerprint = fingerprintJson(input);
  if (action === 'fail') {
    const empty = resolutions.find((item) => {
      return item.state === 'empty' && item.onEmpty === 'fail-plan';
    });
    return {
      action,
      input,
      inputFingerprint,
      resolutions,
      error: {
        kind: 'validation',
        code: 'OPERATION_PLAN_BINDING_EMPTY',
        message: 'An exact required operation-plan binding resolved no values.'
      }
    };
  }
  return { action, input, inputFingerprint, resolutions, error: null };
}

function sourceStep(checkpoint, runtimeStep) {
  return checkpoint.plan.steps.find((step) => step.id === runtimeStep.id);
}

function assertStepCall(root, checkpoint, runtimeStep, source) {
  if (!runtimeStep.call) {
    throw new Error('Operation plan step ' + runtimeStep.id + ' has no call record.');
  }
  assertHostToolCall(root, runtimeStep.call);
  const call = runtimeStep.call;
  const input = runtimeStep.resolvedInput;
  if (call.runId !== checkpoint.plan.runId
    || !call.configuration
    || fingerprintJson(call.configuration) !== fingerprintJson(checkpoint.configuration)
    || call.configurationLockFingerprint !== checkpoint.configurationLock.fingerprint
    || call.graphFingerprint !== checkpoint.graphFingerprint
    || fingerprintJson(call.host) !== fingerprintJson(checkpoint.host)
    || call.capability.id !== source.capability
    || call.authority !== source.authority
    || call.provider.implementation !== source.providerImplementation
    || call.inputFingerprint !== fingerprintJson(input)
    || runtimeStep.state !== call.state) {
    throw new Error('Operation plan step ' + runtimeStep.id + ' does not match its exact call.');
  }
  if (runtimeStep.state === 'completed') {
    if (!runtimeStep.output
      || runtimeStep.outputFingerprint !== fingerprintJson(runtimeStep.output)
      || runtimeStep.outputFingerprint !== call.outputFingerprint
      || runtimeStep.error !== null) {
      throw new Error('Completed operation plan step ' + runtimeStep.id + ' has inconsistent output state.');
    }
  } else if (runtimeStep.output !== null
    || runtimeStep.outputFingerprint !== null
    || fingerprintJson(runtimeStep.error) !== fingerprintJson(call.error)) {
    throw new Error('Open or failed operation plan step ' + runtimeStep.id + ' has inconsistent result state.');
  }
}

function assertBoundRuntimeStep(root, checkpoint, runtimeStep, source) {
  if (runtimeStep.state === 'pending') {
    if (runtimeStep.resolvedInput !== null
      || runtimeStep.resolvedInputFingerprint !== null
      || runtimeStep.bindingResolutions.length !== 0
      || runtimeStep.call !== null
      || runtimeStep.output !== null
      || runtimeStep.outputFingerprint !== null
      || runtimeStep.error !== null) {
      throw new Error('Pending bound step ' + runtimeStep.id + ' contains execution state.');
    }
    return;
  }
  const expected = resolveBoundStepInput(checkpoint, source);
  if (fingerprintJson(runtimeStep.resolvedInput) !== fingerprintJson(expected.input)
    || runtimeStep.resolvedInputFingerprint !== expected.inputFingerprint
    || fingerprintJson(runtimeStep.bindingResolutions) !== fingerprintJson(expected.resolutions)) {
    throw new Error('Bound step ' + runtimeStep.id + ' does not match its exact source outputs.');
  }
  if (expected.action === 'skip') {
    if (runtimeStep.state !== 'skipped'
      || runtimeStep.call !== null
      || runtimeStep.output !== null
      || runtimeStep.outputFingerprint !== null
      || runtimeStep.error !== null) {
      throw new Error('Empty bound step ' + runtimeStep.id + ' did not preserve skip semantics.');
    }
    return;
  }
  if (expected.action === 'fail') {
    if (runtimeStep.state !== 'failed'
      || runtimeStep.call !== null
      || runtimeStep.output !== null
      || runtimeStep.outputFingerprint !== null
      || fingerprintJson(runtimeStep.error) !== fingerprintJson(expected.error)) {
      throw new Error('Invalid bound step ' + runtimeStep.id + ' did not fail deterministically.');
    }
    return;
  }
  if (!runtimeStep.call) {
    throw new Error('Resolved bound step ' + runtimeStep.id + ' has no exact call record.');
  }
  assertStepCall(root, checkpoint, runtimeStep, source);
}

export function assertOperationPlanDocument(root, plan) {
  contractFailures(
    path.resolve(root),
    plan,
    planSchemaPath(plan),
    'Operation plan'
  );
  const ids = plan.steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Operation plan step identifiers must be unique.');
  }
  const bindingIds = [];
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    const priorIds = new Set(plan.steps.slice(0, index).map((item) => item.id));
    const targetPaths = [];
    for (const binding of step.inputBindings) {
      bindingIds.push(binding.id);
      targetPaths.push(binding.targetPath);
      if (!priorIds.has(binding.sourceStepId)) {
        throw new Error(
          'Operation plan binding ' + binding.id
            + ' must reference an earlier step in the same plan.'
        );
      }
      if (pathExists(step.input, binding.targetPath)) {
        throw new Error(
          'Operation plan binding ' + binding.id
            + ' cannot overwrite a fixed input value at ' + pathKey(binding.targetPath) + '.'
        );
      }
      if (targetPathTraversesFixedScalar(step.input, binding.targetPath)) {
        throw new Error(
          'Operation plan binding ' + binding.id
            + ' cannot traverse a fixed non-object input at '
            + pathKey(binding.targetPath) + '.'
        );
      }
    }
    if (targetPaths.some((target, targetIndex) => {
      return targetPaths.some((other, otherIndex) => {
        return targetIndex !== otherIndex && pathsOverlap(target, other);
      });
    })) {
      throw new Error('Operation plan binding target paths cannot duplicate or overlap.');
    }
  }
  if (new Set(bindingIds).size !== bindingIds.length) {
    throw new Error('Operation plan binding identifiers must be unique.');
  }
  return plan;
}

export async function preflightOperationPlanSteps({ root, lock, plan, at }) {
  assertOperationPlanDocument(root, plan);
  for (const step of plan.steps) {
    try {
      if (step.inputBindings.length > 0) {
        await preflightHostToolBinding({
          root,
          lock,
          capability: step.capability,
          authority: step.authority,
          containment: 'connected',
          providerImplementation: step.providerImplementation,
          approvedEffects: []
        });
      } else {
        const prepared = await prepareHostToolCall({
          root,
          lock,
          configuration: plan.configuration || null,
          runId: plan.runId,
          callId: operationPlanCallId(plan, step),
          capability: step.capability,
          authority: step.authority,
          containment: 'connected',
          providerImplementation: step.providerImplementation,
          input: step.input,
          at,
          approvedEffects: []
        });
        if (prepared.call.state === 'failed' || prepared.call.state === 'blocked') {
          throw new Error(prepared.call.error.message);
        }
      }
    } catch (error) {
      throw new Error(
        'Operation plan step ' + step.id + ' cannot be prepared: ' + error.message
      );
    }
  }
  return plan;
}

export function assertOperationPlanCheckpoint(root, checkpoint) {
  const resolvedRoot = path.resolve(root);
  contractFailures(
    resolvedRoot,
    checkpoint,
    checkpointSchemaPath(checkpoint),
    'Operation plan checkpoint'
  );
  assertOperationPlanDocument(resolvedRoot, checkpoint.plan);
  if (checkpoint.checkpointFingerprint !== checkpointFingerprint(checkpoint)) {
    throw new Error('Operation plan checkpoint fingerprint does not match its durable contents.');
  }
  if (checkpoint.planFingerprint !== fingerprintJson(checkpoint.plan)
    || checkpoint.plan.runId !== checkpoint.run.id
    || !checkpoint.plan.configuration
    || fingerprintJson(checkpoint.configuration)
      !== fingerprintJson(checkpoint.plan.configuration)
    || checkpoint.configuration.lockPath !== checkpoint.configurationLock.path
    || checkpoint.configuration.lockFingerprint
      !== checkpoint.configurationLock.fingerprint
    || checkpoint.configuration.graphFingerprint !== checkpoint.graphFingerprint
    || checkpoint.steps.length !== checkpoint.plan.steps.length) {
    throw new Error('Operation plan checkpoint does not match its source plan and run.');
  }

  let completedPrefix = 0;
  while (checkpoint.steps[completedPrefix]
    && (checkpoint.steps[completedPrefix].state === 'completed'
      || checkpoint.steps[completedPrefix].state === 'skipped')) {
    completedPrefix += 1;
  }
  for (let index = 0; index < checkpoint.steps.length; index += 1) {
    const runtimeStep = checkpoint.steps[index];
    const source = checkpoint.plan.steps[index];
    if (runtimeStep.id !== source.id || runtimeStep.sequence !== index + 1) {
      throw new Error('Operation plan runtime steps do not preserve source order.');
    }
    assertBoundRuntimeStep(resolvedRoot, checkpoint, runtimeStep, source);
  }

  const active = checkpoint.steps[completedPrefix] || null;
  const tail = active ? checkpoint.steps.slice(completedPrefix + 1) : [];
  if (tail.some((step) => step.state !== 'pending')) {
    throw new Error('Operation plan steps must execute sequentially without skipped work.');
  }
  if (!active) {
    if (checkpoint.state !== 'completed'
      || checkpoint.currentStepId !== null
      || fingerprintJson(checkpoint.result)
        !== fingerprintJson(expectedResult(checkpoint.plan, checkpoint.steps))) {
      throw new Error('Completed operation plan checkpoint has inconsistent terminal state.');
    }
  } else if (checkpoint.state === 'requested') {
    if (active.state !== 'requested'
      || checkpoint.currentStepId !== active.id
      || checkpoint.result !== null) {
      throw new Error('Requested operation plan checkpoint does not identify exactly one active step.');
    }
  } else if (checkpoint.state === 'failed' || checkpoint.state === 'blocked') {
    if (active.state !== checkpoint.state
      || checkpoint.currentStepId !== null
      || checkpoint.result !== null) {
      throw new Error('Stopped operation plan checkpoint has inconsistent failure state.');
    }
  } else {
    throw new Error('Operation plan checkpoint state does not match its sequential steps.');
  }
  return checkpoint;
}

export function operationPlanCurrentCall(checkpoint) {
  if (checkpoint.state !== 'requested' || !checkpoint.currentStepId) return null;
  const step = checkpoint.steps.find((item) => item.id === checkpoint.currentStepId);
  return step?.call || null;
}

export function createOperationPlanCheckpoint({
  root,
  lock,
  lockPath,
  run,
  runSourcePath,
  runStatePath,
  plan,
  configuration,
  at
}) {
  assertOperationPlanDocument(root, plan);
  if (plan.runId !== run.id) {
    throw new Error('Operation plan does not belong to the supplied exact run.');
  }
  if (!plan.configuration
    || fingerprintJson(plan.configuration) !== fingerprintJson(configuration)
    || configuration.lockPath !== lockPath
    || configuration.lockFingerprint !== fingerprintJson(lock)
    || configuration.graphFingerprint !== lock.graphFingerprint) {
    throw new Error(
      'Operation plan does not bind the exact selected configuration and lock.'
    );
  }
  return {
    $contract: CHECKPOINT_V2,
    contractVersion: '2.0.0',
    id: 'checkpoint.' + plan.id,
    kind: 'operation-plan',
    createdAt: plan.createdAt,
    updatedAt: at,
    state: 'failed',
    configuration: structuredClone(configuration),
    configurationLock: {
      path: lockPath,
      fingerprint: fingerprintJson(lock)
    },
    graphFingerprint: lock.graphFingerprint,
    host: {
      id: lock.host.id,
      adapter: lock.host.adapter,
      version: lock.host.version
    },
    run: {
      id: run.id,
      sourcePath: runSourcePath,
      statePath: runStatePath,
      fingerprint: fingerprintJson(run)
    },
    plan: structuredClone(plan),
    planFingerprint: fingerprintJson(plan),
    steps: plan.steps.map((step, index) => ({
      id: step.id,
      sequence: index + 1,
      state: 'pending',
      resolvedInput: null,
      resolvedInputFingerprint: null,
      bindingResolutions: [],
      call: null,
      output: null,
      outputFingerprint: null,
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
}

export async function requestNextOperationPlanStep({ root, lock, checkpoint, at }) {
  const next = structuredClone(checkpoint);
  while (true) {
    const runtimeStep = next.steps.find((step) => step.state === 'pending');
    if (!runtimeStep) {
      next.updatedAt = at;
      next.state = 'completed';
      next.currentStepId = null;
      next.result = expectedResult(next.plan, next.steps);
      return next;
    }
    const source = sourceStep(next, runtimeStep);
    let input = source.input;
    const resolved = resolveBoundStepInput(next, source);
    runtimeStep.resolvedInput = structuredClone(resolved.input);
    runtimeStep.resolvedInputFingerprint = resolved.inputFingerprint;
    runtimeStep.bindingResolutions = structuredClone(resolved.resolutions);
    if (resolved.action === 'skip') {
      runtimeStep.state = 'skipped';
      runtimeStep.error = null;
      next.updatedAt = at;
      continue;
    }
    if (resolved.action === 'fail') {
      runtimeStep.state = 'failed';
      runtimeStep.error = structuredClone(resolved.error);
      next.updatedAt = at;
      next.state = 'failed';
      next.currentStepId = null;
      next.result = null;
      return next;
    }
    input = resolved.input;
    const callId = operationPlanCallId(next.plan, source);
    const prepared = await prepareHostToolCall({
      root,
      lock,
      configuration: next.configuration,
      runId: next.plan.runId,
      callId,
      capability: source.capability,
      authority: source.authority,
      containment: 'connected',
      providerImplementation: source.providerImplementation,
      input,
      at,
      approvedEffects: []
    });
    runtimeStep.call = prepared.call;
    runtimeStep.state = prepared.call.state;
    runtimeStep.error = structuredClone(prepared.call.error);
    next.updatedAt = at;
    next.state = prepared.call.state;
    next.currentStepId = prepared.call.state === 'requested' ? runtimeStep.id : null;
    next.result = null;
    return next;
  }
}

function previousResponse(checkpoint, callId, response) {
  const step = checkpoint.steps.find((item) => {
    return item.call?.id === callId
      || item.call?.pagination?.pages.some((page) => page.callId === callId);
  });
  if (!step) return false;
  const responseFingerprint = step.call.id === callId
    ? step.call.responseFingerprint
    : step.call.pagination.pages.find((page) => page.callId === callId)?.responseFingerprint;
  if (!responseFingerprint) return false;
  if (responseFingerprint !== fingerprintJson(response)) {
    throw new Error('Operation plan response does not match the exact completed step call.');
  }
  return true;
}

export async function completeOperationPlanStep({
  root,
  lock,
  checkpoint,
  callId,
  response,
  at
}) {
  assertOperationPlanCheckpoint(root, checkpoint);
  const currentCall = operationPlanCurrentCall(checkpoint);
  if (!currentCall || currentCall.id !== callId) {
    if (previousResponse(checkpoint, callId, response)) {
      return { checkpoint: structuredClone(checkpoint), idempotent: true };
    }
    throw new Error('Operation plan response does not match the exact current step call.');
  }
  const next = structuredClone(checkpoint);
  const runtimeStep = next.steps.find((step) => step.id === next.currentStepId);
  const source = sourceStep(next, runtimeStep);
  const completed = await completeHostToolCall({
    root,
    lock,
    call: runtimeStep.call,
    input: runtimeStep.resolvedInput,
    response,
    at
  });
  if (completed.call.state === 'requested') {
    runtimeStep.call = completed.call;
    runtimeStep.state = 'requested';
    runtimeStep.output = null;
    runtimeStep.outputFingerprint = null;
    runtimeStep.error = null;
    next.updatedAt = at;
    next.state = 'requested';
    next.currentStepId = runtimeStep.id;
    next.result = null;
    return { checkpoint: next, idempotent: false };
  }
  runtimeStep.call = completed.call;
  runtimeStep.state = completed.call.state;
  runtimeStep.output = completed.call.state === 'completed'
    ? structuredClone(completed.output)
    : null;
  runtimeStep.outputFingerprint = completed.call.state === 'completed'
    ? completed.call.outputFingerprint
    : null;
  runtimeStep.error = structuredClone(completed.call.error);
  next.updatedAt = at;
  next.currentStepId = null;
  next.result = null;
  if (completed.call.state !== 'completed') {
    next.state = completed.call.state;
    return { checkpoint: next, idempotent: false };
  }
  next.state = 'requested';
  return {
    checkpoint: await requestNextOperationPlanStep({ root, lock, checkpoint: next, at }),
    idempotent: false
  };
}

export function failOperationPlanStep({
  root,
  lock,
  checkpoint,
  callId,
  error,
  at
}) {
  assertOperationPlanCheckpoint(root, checkpoint);
  const normalized = normalizedError(error);
  const currentCall = operationPlanCurrentCall(checkpoint);
  if (!currentCall || currentCall.id !== callId) {
    const previous = checkpoint.steps.find((step) => step.call?.id === callId);
    if (previous?.call.error
      && fingerprintJson(previous.call.error) === fingerprintJson(normalized)) {
      return { checkpoint: structuredClone(checkpoint), idempotent: true };
    }
    throw new Error('Operation plan failure does not match the exact current step call.');
  }
  const next = structuredClone(checkpoint);
  const runtimeStep = next.steps.find((step) => step.id === next.currentStepId);
  const failed = failHostToolCall({
    root,
    lock,
    call: runtimeStep.call,
    error: normalized,
    at
  });
  runtimeStep.call = failed;
  runtimeStep.state = failed.state;
  runtimeStep.error = structuredClone(failed.error);
  next.updatedAt = at;
  next.state = failed.state;
  next.currentStepId = null;
  next.result = null;
  return { checkpoint: next, idempotent: false };
}
