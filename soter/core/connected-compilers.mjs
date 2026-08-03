import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { listProviderDeclarations } from './capabilities.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import {
  assertConnectedObservationInputBindings,
  connectedObservationInputFingerprint
} from './connected-input-bindings.mjs';
import { assertContextRecordOutput } from './context-records.mjs';
import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  resolveRepoPath
} from './lib/canonical-json.mjs';

const OPERATION_KEYS = [
  'ambiguity', 'capability', 'effect', 'id', 'input', 'inputFingerprint',
  'precondition', 'recovery', 'review', 'sequence', 'sourceActionId',
  'verification'
];
const OBSERVATION_KEYS = ['capability', 'expectation', 'input', 'inputFingerprint'];
const BOUND_OBSERVATION_KEYS = [...OBSERVATION_KEYS, 'inputBindings'].sort(compareText);
const EXPECTATION_KEYS = ['expectedFingerprint', 'kind'];
const NONE_PRECONDITION_KEYS = ['capability', 'expectation', 'input', 'inputFingerprint', 'kind'];
const EXPECTATION_PRECONDITION_KEYS = NONE_PRECONDITION_KEYS;
const AMBIGUITY_KEYS = ['reasonCode', 'reconcileWith', 'retry', 'unresolvedState'];
const RECOVERY_KEYS = ['mode', 'reasonCode'];
const REVIEW_KEYS = ['after', 'before', 'precondition', 'subject'];
const SUBJECT_KEYS = ['id', 'kind', 'type'];
const BEFORE_KEYS = ['fingerprint', 'reasonCode', 'state'];
const PROVIDED_BEFORE_KEYS = ['fingerprint', 'reasonCode', 'reviewValue', 'state'];
const AFTER_KEYS = ['fingerprint', 'reviewValue', 'state'];
const PRIVATE_OBJECT_KEYS = ['fingerprint', 'reviewValue'];

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function codedError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && fingerprintJson(Object.keys(value).sort(compareText)) === fingerprintJson(expected));
}

function assertExactKeys(value, expected, label) {
  if (!exactKeys(value, expected)) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      label + ' does not have the exact provider-neutral compiler shape.'
    );
  }
}

function validateCapabilityInput(input, contract, label) {
  const failures = validateJsonSchema(input, contract.inputSchema);
  if (failures.length) {
    throw codedError(
      'CONNECTED_COMPILER_BINDING_INVALID',
      label + ' does not satisfy the exact portable capability input contract.'
    );
  }
}

function exactCapability(root, lock, manifest, capabilityId, requiredAuthority = null) {
  const requirement = manifest.capabilities.requires.find((item) => item.id === capabilityId);
  const lockCapability = lock.capabilities.find((item) => item.id === capabilityId);
  const binding = lock.bindings.find((item) => item.capability === capabilityId);
  let contract;
  try {
    contract = readJson(path.join(root, 'soter', 'capabilities', capabilityId + '.json'));
  } catch (error) {
    throw codedError(
      'CONNECTED_COMPILER_BINDING_INVALID',
      'A compiler capability contract could not be read.',
      error
    );
  }
  if (!requirement || !lockCapability || !binding
    || lockCapability.version !== contract.version
    || lockCapability.contractFingerprint !== fingerprintJson(contract)
    || binding.capabilityVersion !== contract.version
    || binding.authorities.length < 1
    || (requiredAuthority === null
      ? binding.authorities.length !== 1
      : !binding.authorities.includes(requiredAuthority))) {
    throw codedError(
      'CONNECTED_COMPILER_BINDING_INVALID',
      'A compiler capability is undeclared, stale, unbound, or authority-ambiguous.'
    );
  }
  return {
    contract,
    binding,
    authority: requiredAuthority === null ? binding.authorities[0] : requiredAuthority
  };
}

function connectedProvider(root, lock, binding, capability, authority) {
  const authorityDeclaration = lock.authorities.find((item) => item.id === authority);
  if (!authorityDeclaration) {
    throw codedError(
      'CONNECTED_COMPILER_BINDING_INVALID',
      'A compiled operation references an unknown resolved authority.'
    );
  }
  const matches = listProviderDeclarations(root).filter((provider) => {
    return provider.pack === binding.providerPack
      && provider.containment === 'connected'
      && provider.capabilities.some((item) => item.id === capability)
      && provider.authorities.some((item) => {
        return item.role === authorityDeclaration.role
          && item.subject === authorityDeclaration.subject;
      });
  });
  if (matches.length > 1) {
    throw codedError(
      'CONNECTED_COMPILER_BINDING_INVALID',
      'A compiled operation has more than one connected provider implementation.'
    );
  }
  return matches[0] || null;
}

function assertExpectation(value, label) {
  assertExactKeys(value, EXPECTATION_KEYS, label + ' expectation');
  if (typeof value.kind !== 'string'
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.kind)
    || !/^sha256:[a-f0-9]{64}$/.test(value.expectedFingerprint || '')) {
    throw codedError('CONNECTED_COMPILER_INVALID', label + ' expectation is invalid.');
  }
}

function assertObservation(value, label) {
  assertExactKeys(
    value,
    Object.hasOwn(value || {}, 'inputBindings') ? BOUND_OBSERVATION_KEYS : OBSERVATION_KEYS,
    label
  );
  assertExpectation(value.expectation, label);
  try {
    assertConnectedObservationInputBindings(value);
  } catch (error) {
    throw codedError('CONNECTED_COMPILER_INVALID', label + ' input binding is invalid.', error);
  }
  if (typeof value.capability !== 'string'
    || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)
    || value.inputFingerprint !== connectedObservationInputFingerprint(value)) {
    throw codedError('CONNECTED_COMPILER_INVALID', label + ' is invalid.');
  }
}

function assertPrecondition(value) {
  if (value?.kind === 'none') {
    assertExactKeys(value, NONE_PRECONDITION_KEYS, 'Compiler precondition');
    if (value.capability !== null || value.input !== null
      || value.inputFingerprint !== null || value.expectation !== null) {
      throw codedError('CONNECTED_COMPILER_INVALID', 'No-op precondition contains observation state.');
    }
    return;
  }
  if (value?.kind !== 'expectation') {
    throw codedError('CONNECTED_COMPILER_INVALID', 'Compiler precondition kind is invalid.');
  }
  assertExactKeys(value, EXPECTATION_PRECONDITION_KEYS, 'Compiler precondition');
  assertObservation({
    capability: value.capability,
    input: value.input,
    inputFingerprint: value.inputFingerprint,
    expectation: value.expectation
  }, 'Compiler precondition');
}

function assertPrivateValue(value, label) {
  assertExactKeys(value, PRIVATE_OBJECT_KEYS, label);
  if (!value.reviewValue || typeof value.reviewValue !== 'object'
    || Array.isArray(value.reviewValue)
    || value.fingerprint !== fingerprintJson(value.reviewValue)) {
    throw codedError('CONNECTED_COMPILER_INVALID', label + ' fingerprint is invalid.');
  }
}

function assertReview(value, precondition) {
  assertExactKeys(value, REVIEW_KEYS, 'Compiler private review');
  assertExactKeys(value.subject, SUBJECT_KEYS, 'Compiler review subject');
  if (value.subject.kind !== 'portable-resource'
    || typeof value.subject.type !== 'string'
    || (value.subject.id !== null && typeof value.subject.id !== 'string')) {
    throw codedError('CONNECTED_COMPILER_INVALID', 'Compiler review subject is invalid.');
  }
  if (value.before?.state === 'provided') {
    assertExactKeys(value.before, PROVIDED_BEFORE_KEYS, 'Compiler before review');
    if (precondition.kind !== 'expectation'
      || value.before.reasonCode !== 'PRIOR_VALUE_REQUIRED'
      || !value.before.reviewValue || typeof value.before.reviewValue !== 'object'
      || Array.isArray(value.before.reviewValue)
      || value.before.fingerprint !== fingerprintJson(value.before.reviewValue)) {
      throw codedError('CONNECTED_COMPILER_INVALID', 'Compiler provided before review is invalid.');
    }
  } else {
    assertExactKeys(value.before, BEFORE_KEYS, 'Compiler before review');
    const expectedBeforeState = precondition.kind === 'expectation'
      ? 'absent-required'
      : 'not-required';
    const expectedBeforeReason = precondition.kind === 'expectation'
      ? 'DEDUPLICATION_ABSENCE_REQUIRED'
      : 'PRIOR_VALUE_NOT_REQUIRED';
    if (value.before.state !== expectedBeforeState
      || value.before.reasonCode !== expectedBeforeReason
      || value.before.fingerprint !== null) {
      throw codedError('CONNECTED_COMPILER_INVALID', 'Compiler before review is invalid.');
    }
  }
  assertExactKeys(value.after, AFTER_KEYS, 'Compiler after review');
  if (value.after.state !== 'provided'
    || !value.after.reviewValue || typeof value.after.reviewValue !== 'object'
    || Array.isArray(value.after.reviewValue)
    || value.after.fingerprint !== fingerprintJson(value.after.reviewValue)) {
    throw codedError('CONNECTED_COMPILER_INVALID', 'Compiler after review is invalid.');
  }
  assertPrivateValue(value.precondition, 'Compiler precondition review');
  if (value.precondition.fingerprint !== fingerprintJson(precondition)) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'Compiler precondition review does not bind the exact precondition.'
    );
  }
}

function assertCompilerOperationShape(operation) {
  assertExactKeys(operation, OPERATION_KEYS, 'Compiler operation');
  assertObservation(operation.verification, 'Compiler verification');
  assertPrecondition(operation.precondition);
  assertReview(operation.review, operation.precondition);
  assertExactKeys(operation.ambiguity, AMBIGUITY_KEYS, 'Compiler ambiguity policy');
  assertExactKeys(operation.recovery, RECOVERY_KEYS, 'Compiler recovery policy');
  if (typeof operation.id !== 'string'
    || typeof operation.sourceActionId !== 'string'
    || typeof operation.capability !== 'string'
    || !Number.isInteger(operation.sequence)
    || !operation.input || typeof operation.input !== 'object' || Array.isArray(operation.input)
    || operation.inputFingerprint !== fingerprintJson(operation.input)
    || operation.effect !== 'write'
    || operation.ambiguity.retry !== 'prohibited'
    || operation.ambiguity.reconcileWith !== 'verification'
    || operation.ambiguity.unresolvedState !== 'needs-attention'
    || operation.recovery.mode !== 'manual-required') {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'The Automation compiler emitted an invalid operation or recovery policy.'
    );
  }
}

function resolveReadObservation(root, lock, manifest, execution, observation, label) {
  const resolved = exactCapability(
    root,
    lock,
    manifest,
    observation.capability,
    execution.authority
  );
  if (resolved.binding.providerPack !== execution.binding.providerPack
    || resolved.authority !== execution.authority
    || resolved.contract.effects.some((effect) => {
      return effect === 'write' || effect === 'dispatch' || effect === 'destructive';
    })
    || !resolved.contract.effects.includes('read')) {
    throw codedError(
      'CONNECTED_COMPILER_BINDING_INVALID',
      label + ' must be a read-only capability under the exact operation provider and authority.'
    );
  }
  validateCapabilityInput(observation.input, resolved.contract, label + ' input');
  const provider = connectedProvider(
    root,
    lock,
    resolved.binding,
    observation.capability,
    resolved.authority
  );
  return {
    ...structuredClone(observation),
    provider: {
      pack: resolved.binding.providerPack,
      connectedImplementation: provider?.id || null,
      version: provider?.version || null
    }
  };
}

export function resolveAutomationConnection({ root, lock, automationId }) {
  const resolvedRoot = path.resolve(root);
  const manifestPath = path.join(resolvedRoot, 'soter', 'packs', automationId, 'pack.json');
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'Connected compilation could not read the owning Automation manifest.',
      error
    );
  }
  if (manifest.id !== automationId || !manifest.operator?.connection) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'The owning Automation does not declare a connected compiler.'
    );
  }
  const declaration = manifest.operator.connection;
  const artifact = manifest.artifacts.find((item) => {
    return item.path === declaration.module && item.role === 'implementation';
  });
  const lockedPack = lock.packs.find((item) => item.id === manifest.id);
  const lockedArtifact = lockedPack?.artifacts.find((item) => {
    return item.path === declaration.module && item.role === 'implementation';
  });
  const modulePath = resolveRepoPath(resolvedRoot, declaration.module);
  const moduleFingerprint = fingerprintPath(modulePath);
  if (!artifact || !lockedArtifact || lockedArtifact.fingerprint !== moduleFingerprint) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'The Automation compiler is unowned, absent from the exact lock, or fingerprint-mismatched.'
    );
  }
  return {
    root: resolvedRoot,
    lock,
    manifest,
    declaration,
    modulePath,
    compiler: {
      module: declaration.module,
      moduleFingerprint,
      compileExport: declaration.compileExport,
      evaluateExport: declaration.evaluateExport
    }
  };
}

export async function loadAutomationConnectionImplementation(context) {
  let implementation;
  try {
    implementation = await import(pathToFileURL(context.modulePath).href);
  } catch (error) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'The Automation connected compiler module could not be loaded.',
      error
    );
  }
  const compile = implementation[context.declaration.compileExport];
  const evaluate = implementation[context.declaration.evaluateExport];
  if (typeof compile !== 'function' || typeof evaluate !== 'function') {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'The Automation connected compiler or verification evaluator export is unavailable.'
    );
  }
  return { compile, evaluate };
}

export async function compileAutomationConnectedSelection({
  root,
  lock,
  automationId,
  batch,
  material
}) {
  const context = resolveAutomationConnection({ root, lock, automationId });
  const { compile } = await loadAutomationConnectionImplementation(context);
  let compiled;
  try {
    compiled = await compile({ batch: structuredClone(batch), material: structuredClone(material) });
  } catch (error) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'The Automation connected compiler rejected or failed its exact candidate selection.',
      error
    );
  }
  if (!exactKeys(compiled, ['operations'])
    || !Array.isArray(compiled.operations)
    || compiled.operations.length < 1
    || compiled.operations.length > 100) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'The Automation compiler must return one closed non-empty operation list.'
    );
  }
  const selected = new Map(batch.actions.map((action) => [action.id, action]));
  const represented = new Set();
  const ids = new Set();
  const operations = compiled.operations.map((operation, index) => {
    assertCompilerOperationShape(operation);
    const selection = selected.get(operation.sourceActionId);
    if (!selection
      || ids.has(operation.id)
      || operation.sequence !== index + 1
      || operation.capability !== selection.capability
      || operation.effect !== selection.effect) {
      throw codedError(
        'CONNECTED_COMPILER_INVALID',
        'Compiled operations must preserve exact selected-action scope, order, capability, and effect.'
      );
    }
    if (represented.has(selection.id)) {
      throw codedError(
        'CONNECTED_COMPILER_INVALID',
        'The verified-write-sequence profile requires exactly one operation per selected action.'
      );
    }
    ids.add(operation.id);
    represented.add(selection.id);
    const execution = exactCapability(root, lock, context.manifest, operation.capability);
    if (!execution.contract.effects.includes(operation.effect)) {
      throw codedError(
        'CONNECTED_COMPILER_BINDING_INVALID',
        'Compiled operation effect is not declared by its portable capability.'
      );
    }
    validateCapabilityInput(operation.input, execution.contract, 'Compiled operation input');
    const provider = connectedProvider(
      root,
      lock,
      execution.binding,
      operation.capability,
      execution.authority
    );
    const verification = resolveReadObservation(
      root,
      lock,
      context.manifest,
      execution,
      operation.verification,
      'Verification'
    );
    const precondition = operation.precondition.kind === 'expectation'
      ? {
          kind: 'expectation',
          ...resolveReadObservation(
            root,
            lock,
            context.manifest,
            execution,
            operation.precondition,
            'Precondition'
          )
        }
      : structuredClone(operation.precondition);
    return {
      ...structuredClone(operation),
      authority: execution.authority,
      provider: {
        pack: execution.binding.providerPack,
        connectedImplementation: provider?.id || null,
        version: provider?.version || null
      },
      precondition,
      verification
    };
  });
  if (represented.size !== selected.size
    || [...selected.keys()].some((id) => !represented.has(id))) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'Every selected candidate action must compile to at least one exact operation.'
    );
  }
  if (containsCredentialMaterial(operations)) {
    throw codedError(
      'CONNECTED_COMPILER_CREDENTIAL_REJECTED',
      'Compiled private provider arguments cannot contain credential values.'
    );
  }
  return { operations, compiler: context.compiler };
}

export async function evaluateAutomationConnectedObservation({
  root,
  lock,
  automationId,
  compiler,
  operation,
  phase,
  output,
  resolvedInput = null
}) {
  const context = resolveAutomationConnection({ root, lock, automationId });
  if (fingerprintJson(context.compiler) !== fingerprintJson(compiler)) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'Connected verification evaluator does not match the exact candidate preview.'
    );
  }
  const observation = phase === 'precondition' ? operation.precondition : operation.verification;
  if (!observation || observation.kind === 'none') {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'Connected verification requires one exact compiled read observation.'
    );
  }
  const resolved = exactCapability(
    root,
    lock,
    context.manifest,
    observation.capability,
    operation.authority
  );
  if (observation.provider?.pack !== resolved.binding.providerPack
    || observation.provider?.connectedImplementation === undefined) {
    throw codedError(
      'CONNECTED_COMPILER_BINDING_INVALID',
      'Connected verification observation does not retain its exact operation authority and provider binding.'
    );
  }
  const outputFailures = validateJsonSchema(output, resolved.contract.outputSchema);
  if (outputFailures.length) {
    throw codedError(
      'CONNECTED_COMPILER_BINDING_INVALID',
      'Connected verification output does not satisfy its exact minimized capability contract.'
    );
  }
  assertContextRecordOutput(root, observation.capability, output, {
    packIds: lock.packs.filter((pack) => pack.layer === 'context').map((pack) => pack.id)
  });
  if (resolvedInput !== null) {
    const inputFailures = validateJsonSchema(resolvedInput, resolved.contract.inputSchema);
    if (inputFailures.length) {
      throw codedError(
        'CONNECTED_COMPILER_BINDING_INVALID',
        'Connected verification resolved input does not satisfy its exact minimized capability contract.'
      );
    }
    if (!Object.hasOwn(observation, 'inputBindings')
      && fingerprintJson(resolvedInput) !== fingerprintJson(observation.input)) {
      throw codedError(
        'CONNECTED_COMPILER_BINDING_INVALID',
        'Connected verification resolved input changed an observation without an exact output binding.'
      );
    }
  }
  const { evaluate } = await loadAutomationConnectionImplementation(context);
  let result;
  try {
    result = await evaluate({
      operation: structuredClone(operation),
      phase,
      output: structuredClone(output),
      resolvedInput: resolvedInput === null ? null : structuredClone(resolvedInput)
    });
  } catch (error) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'The Automation verification evaluator rejected the normalized provider output.',
      error
    );
  }
  if (!exactKeys(result, ['observedFingerprint', 'reasonCode', 'retryPermitted', 'state'])
    || !['passed', 'failed'].includes(result.state)
    || !/^[A-Z][A-Z0-9_]*$/.test(result.reasonCode || '')
    || !/^sha256:[a-f0-9]{64}$/.test(result.observedFingerprint || '')
    || result.retryPermitted !== false) {
    throw codedError(
      'CONNECTED_COMPILER_INVALID',
      'The Automation verification evaluator returned an invalid no-retry result.'
    );
  }
  return result;
}
