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
const FINALIZER_PRIVATE_MATERIAL_CODE =
  'PROVIDER_PROBE_FINALIZER_PRIVATE_MATERIAL';
const PRIVATE_STRING_INVENTORY_LIMIT = 4096;
const FINALIZER_PROSE_STRING_LIMIT = 16384;
const FINALIZER_PRIVACY_DEPTH_LIMIT = 16;

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

function durablePlan(fullPlan) {
  return {
    id: fullPlan.id,
    probeId: fullPlan.probeId,
    configuration: structuredClone(fullPlan.configuration),
    scope: structuredClone(fullPlan.scope),
    validForSeconds: fullPlan.validForSeconds,
    steps: fullPlan.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      subject: fingerprintJson(step.subject),
      scopeFingerprint: step.scopeFingerprint,
      transport: structuredClone(step.transport),
      argumentsFingerprint: step.argumentsFingerprint
    }))
  };
}

function validationError(message) {
  return Object.assign(new Error(message), { kind: 'validation' });
}

function finalizerPrivacyError() {
  return Object.assign(
    validationError('Provider probe finalizer returned private material in durable prose.'),
    {
      code: FINALIZER_PRIVATE_MATERIAL_CODE,
      reasonCode: FINALIZER_PRIVATE_MATERIAL_CODE
    }
  );
}

function strongPrivateMaterialKey(key) {
  return /^(?:id|uri|url|target|targetUri|source|sourceId|input|inputs|data_source_urls)$/.test(
    key
  ) || /(?:Id|Uri|Url)$/.test(key);
}

function canonicalPublicControlValue(pathSegments, key) {
  const container = pathSegments.at(-1);
  if (container === 'fieldBindings') {
    return new Set([
      'mapping',
      'recordType',
      'field',
      'state',
      'mode',
      'reasonCode'
    ]).has(key);
  }
  if (container === 'optionMappings') {
    return new Set([
      'mapping',
      'recordType',
      'field',
      'state',
      'mode',
      'reasonCode'
    ]).has(key);
  }
  if (container === 'entries'
    && pathSegments.at(-2) === 'optionMappings') {
    return new Set(['portable', 'state', 'reasonCode']).has(key);
  }
  return false;
}

function addPrivateStringMaterial(inventory, value, embedded = false, structural = false) {
  if (value.length === 0) return;
  if (value.length > FINALIZER_PROSE_STRING_LIMIT) throw finalizerPrivacyError();
  const embeddedMatch = !structural && (
    (embedded && value !== 'self')
      || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      || /^[^\s@]+@[^\s@]+$/.test(value)
      || /^[a-f0-9]{8}(?:-?[a-f0-9]{4}){3}-?[a-f0-9]{12}$/i.test(value)
  );
  inventory.set(value, Boolean(inventory.get(value)) || embeddedMatch);
  if (inventory.size > PRIVATE_STRING_INVENTORY_LIMIT) throw finalizerPrivacyError();
}

function collectPrivateStringMaterial(
  value,
  inventory,
  depth = 0,
  embedded = false,
  pathSegments = []
) {
  if (depth > FINALIZER_PRIVACY_DEPTH_LIMIT) throw finalizerPrivacyError();
  if (typeof value === 'string') {
    addPrivateStringMaterial(inventory, value, embedded);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPrivateStringMaterial(item, inventory, depth + 1, embedded, pathSegments);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    addPrivateStringMaterial(inventory, key, false, true);
    collectPrivateStringMaterial(
      child,
      inventory,
      depth + 1,
      canonicalPublicControlValue(pathSegments, key)
        ? false
        : embedded || strongPrivateMaterialKey(key),
      [...pathSegments, key]
    );
  }
}

function decodeEscapedProseLayer(value) {
  let changed = false;
  const decoded = value.replace(
    /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\(["\\/bfnrt])/g,
    (token, codePoint, codeUnit, escaped) => {
      changed = true;
      if (codePoint !== undefined) {
        const numeric = Number.parseInt(codePoint, 16);
        if (numeric > 0x10ffff) throw finalizerPrivacyError();
        return String.fromCodePoint(numeric);
      }
      if (codeUnit !== undefined) {
        return String.fromCharCode(Number.parseInt(codeUnit, 16));
      }
      return {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t'
      }[escaped];
    }
  );
  return changed ? decoded : null;
}

function proseStringContainsPrivateMaterial(value, privateStrings) {
  if (value.length > FINALIZER_PROSE_STRING_LIMIT) throw finalizerPrivacyError();
  let candidate = value;
  for (let layer = 0; layer <= 4; layer += 1) {
    if (privateStrings.some(({ value: privateValue, embedded }) => {
      return embedded ? candidate.includes(privateValue) : candidate === privateValue;
    })) {
      return true;
    }
    if (layer === 4) {
      const overflow = decodeEscapedProseLayer(candidate);
      if (overflow !== null && overflow !== candidate) throw finalizerPrivacyError();
      break;
    }
    const decoded = decodeEscapedProseLayer(candidate);
    if (decoded === null || decoded === candidate) break;
    candidate = decoded;
  }
  return false;
}

function finalizerProseContainsPrivateMaterial(value, privateStrings, depth = 0) {
  if (depth > FINALIZER_PRIVACY_DEPTH_LIMIT) throw finalizerPrivacyError();
  if (typeof value === 'string') {
    return proseStringContainsPrivateMaterial(value, privateStrings);
  }
  if (Array.isArray(value)) {
    return value.some((item) => {
      return finalizerProseContainsPrivateMaterial(item, privateStrings, depth + 1);
    });
  }
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    return proseStringContainsPrivateMaterial(key, privateStrings)
      || finalizerProseContainsPrivateMaterial(child, privateStrings, depth + 1);
  });
}

export function assertProviderProbeFinalizerPrivacy({ lock, fullPlan, observations }) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)
    || !fullPlan || typeof fullPlan !== 'object' || Array.isArray(fullPlan)
    || !Array.isArray(fullPlan.steps)
    || !observations || typeof observations !== 'object' || Array.isArray(observations)) {
    throw finalizerPrivacyError();
  }
  const privateStrings = new Map();
  collectPrivateStringMaterial(lock.settings || {}, privateStrings, 0, true);
  for (const source of Array.isArray(lock.sources) ? lock.sources : []) {
    collectPrivateStringMaterial(source?.input, privateStrings, 0, true);
  }
  for (const step of fullPlan.steps) {
    collectPrivateStringMaterial(step?.scope, privateStrings, 0, true);
    collectPrivateStringMaterial(step?.arguments, privateStrings, 0, true);
  }
  const inventory = [...privateStrings].map(([value, embedded]) => ({
    value,
    embedded
  }));
  const proseSurfaces = [
    ...(Array.isArray(observations.credentials)
      ? observations.credentials.map((item) => item?.details)
      : []),
    observations.reachability?.details,
    ...(Array.isArray(observations.authorities)
      ? observations.authorities.map((item) => item?.details)
      : []),
    ...(Array.isArray(observations.capabilities)
      ? observations.capabilities.map((item) => item?.details)
      : []),
    ...(Array.isArray(observations.checks)
      ? observations.checks.map((item) => item?.details)
      : []),
    observations.limitations
  ];
  if (inventory.length > 0 && proseSurfaces.some((surface) => {
    return finalizerProseContainsPrivateMaterial(surface, inventory);
  })) {
    throw finalizerPrivacyError();
  }
  return true;
}

function selectedOperatorRecordRequirements(root, lock, provider) {
  const requirements = new Map();
  const selectedAutomations = lock.packs.filter((pack) => pack.layer === 'automation');
  for (const locked of selectedAutomations) {
    const manifest = readJson(path.join(root, 'soter', 'packs', locked.id, 'pack.json'));
    if (manifest.id !== locked.id
      || manifest.version !== locked.version
      || manifest.layer !== 'automation'
      || fingerprintJson(manifest) !== locked.manifestFingerprint) {
      throw validationError(
        'Selected Automation manifest does not match the exact provider probe lock: '
          + locked.id + '.'
      );
    }
    const phases = [
      manifest.operator?.acquisition?.recordRequirements || [],
      manifest.operator?.connection?.recordRequirements || []
    ];
    for (const phase of phases) {
      for (const requirement of phase) {
        const bindings = lock.bindings.filter((binding) => {
          return binding.capability === requirement.capability;
        });
        if (bindings.length !== 1) {
          throw validationError(
            'Selected Automation record requirement must resolve one exact provider binding: '
              + requirement.capability + '; found ' + bindings.length + '.'
          );
        }
        if (bindings[0].providerPack !== provider.pack) continue;
        if (!requirements.has(requirement.capability)) {
          requirements.set(requirement.capability, new Set());
        }
        const recordTypes = requirements.get(requirement.capability);
        for (const recordType of requirement.recordTypes) recordTypes.add(recordType);
      }
    }
  }
  return [...requirements].sort(([left], [right]) => {
    return compareCodepoint(left, right);
  }).map(([capability, recordTypes]) => ({
    capability,
    recordTypes: [...recordTypes].sort(compareCodepoint)
  }));
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
      tool: hostTool.nativeTool,
      responseProfile: hostTool.responseProfile
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
  configuration,
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
  const operatorRecordRequirements = selectedOperatorRecordRequirements(
    resolvedRoot,
    lock,
    provider
  );
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
    operatorRecordRequirements,
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
      configuration: structuredClone(configuration),
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

function requestNextStep(checkpoint, fullPlan, at) {
  const next = structuredClone(checkpoint);
  const runtimeStep = next.steps.find((step) => step.state === 'pending');
  if (!runtimeStep) return next;
  const source = fullPlan.steps.find((step) => step.id === runtimeStep.id);
  if (!source) {
    throw new Error('Provider probe plan cannot reconstruct its exact next step.');
  }
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
    || call.argumentsFingerprint !== source.argumentsFingerprint
    || call.state !== runtimeStep.state) {
    throw new Error('Provider probe runtime step does not match its exact host call.');
  }
  if (runtimeStep.state === 'requested') {
    if (!Object.hasOwn(call, 'arguments')
      || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)
      || fingerprintJson(call.arguments) !== source.argumentsFingerprint
      || call.completedAt !== null || call.responseFingerprint !== null
      || call.error !== null || runtimeStep.result !== null
      || runtimeStep.resultFingerprint !== null || runtimeStep.error !== null) {
      throw new Error('Requested provider probe step contains terminal state.');
    }
  } else if (runtimeStep.state === 'completed') {
    if (Object.hasOwn(call, 'arguments')
      || !call.completedAt || !call.responseFingerprint || call.error !== null
      || !runtimeStep.result
      || !durableStepResult(runtimeStep.result)
      || runtimeStep.resultFingerprint !== fingerprintJson(runtimeStep.result)
      || runtimeStep.error !== null) {
      throw new Error('Completed provider probe step has inconsistent minimized state.');
    }
  } else if (Object.hasOwn(call, 'arguments') || !call.completedAt || !call.error
    || runtimeStep.result !== null || runtimeStep.resultFingerprint !== null
    || fingerprintJson(runtimeStep.error) !== fingerprintJson(failureSummary(call.error))) {
    throw new Error('Failed provider probe step has inconsistent error state.');
  }
}

function terminalCheckMethod(kind) {
  return kind === 'identity' || kind === 'schema'
    ? 'metadata'
    : 'read-only';
}

function terminalIntegrityError() {
  return validationError(
    'Provider probe terminal result does not match its minimized durable plan.'
  );
}

function assertTerminalResultIntegrity(checkpoint) {
  const result = checkpoint.result;
  const terminalRuntimeStep = checkpoint.steps.at(-1);
  const expectedConfiguration = {
    name: checkpoint.configuration.name,
    lockFingerprint: checkpoint.configuration.lockFingerprint
  };
  if (result.id !== checkpoint.plan.probeId
    || fingerprintJson(result.configuration) !== fingerprintJson(expectedConfiguration)
    || fingerprintJson(result.provider) !== fingerprintJson(checkpoint.provider)
    || result.probedAt !== checkpoint.updatedAt
    || terminalRuntimeStep?.call?.completedAt !== checkpoint.updatedAt
    || result.validUntil !== validUntil(
      checkpoint.updatedAt,
      checkpoint.plan.validForSeconds
    )
    || !Array.isArray(result.checks)
    || result.checks.length !== checkpoint.plan.steps.length) {
    throw terminalIntegrityError();
  }
  try {
    assertObservationScope(checkpoint.plan.scope, result);
  } catch {
    throw terminalIntegrityError();
  }
  // A minimized unkeyed checkpoint cannot detect a fully coherent rewrite of an
  // already-declared capability state. This assertion binds internal semantics;
  // it does not establish cryptographic authenticity or infer that promotion.
  for (let index = 0; index < checkpoint.plan.steps.length; index += 1) {
    const source = checkpoint.plan.steps[index];
    const runtimeStep = checkpoint.steps[index];
    const check = result.checks[index];
    if (runtimeStep.state !== 'completed'
      || check.id !== 'check.' + source.id.slice('step.'.length)
      || check.stepId !== source.id
      || check.kind !== source.kind
      || check.subject !== source.subject
      || check.scopeFingerprint !== source.scopeFingerprint
      || check.state !== 'passed'
      || check.method !== terminalCheckMethod(source.kind)
      || check.expectedFingerprint !== source.argumentsFingerprint
      || check.observedFingerprint !== runtimeStep.resultFingerprint) {
      throw terminalIntegrityError();
    }
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
    || fingerprintJson(checkpoint.configuration)
      !== fingerprintJson(checkpoint.plan.configuration)
    || checkpoint.configuration.lockPath !== checkpoint.configurationLock.path
    || checkpoint.configuration.lockFingerprint
      !== checkpoint.configurationLock.fingerprint
    || checkpoint.configuration.graphFingerprint !== checkpoint.graphFingerprint
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
    assertTerminalResultIntegrity(checkpoint);
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
  configuration,
  validForSeconds = 300,
  at,
  translator = null
}) {
  if (!configuration
    || configuration.configurationBasis !== 'private-active'
    || configuration.lockPath !== lockPath
    || configuration.lockFingerprint !== fingerprintLock(lock)
    || configuration.graphFingerprint !== lock.graphFingerprint
    || configuration.name !== lock.configuration.name
    || configuration.path !== lock.configuration.path) {
    throw new Error(
      'Provider probe plan requires the exact private-active configuration selection.'
    );
  }
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
    configuration,
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
    configuration: structuredClone(configuration),
    configurationLock: {
      path: lockPath,
      fingerprint: fingerprintLock(lock)
    },
    graphFingerprint: lock.graphFingerprint,
    host: hostIdentity(lock),
    provider: providerIdentity(derived.provider),
    plan: durablePlan(derived.plan),
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
  return requestNextStep(checkpoint, derived.plan, at);
}

async function exactDerivedPlan({ root, lock, checkpoint, translator }) {
  const derived = await derivePlan({
    root,
    lock,
    providerImplementation: checkpoint.provider.implementation,
    probeId: checkpoint.plan.probeId,
    validForSeconds: checkpoint.plan.validForSeconds,
    configuration: checkpoint.configuration,
    at: checkpoint.createdAt,
    translator
  });
  if (fingerprintJson(derived.plan) !== checkpoint.planFingerprint
    || fingerprintJson(durablePlan(derived.plan)) !== fingerprintJson(checkpoint.plan)
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
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    const check = checks[index];
    if (!check || check.id !== 'check.' + step.id.slice('step.'.length)
      || check.stepId !== step.id || check.kind !== step.kind
      || check.subject !== step.subject
      || check.scopeFingerprint !== step.scopeFingerprint
      || check.state !== 'passed'
      || check.method !== terminalCheckMethod(step.kind)) {
      throw Object.assign(
        new Error('Probe finalizer widened or changed an exact step check.'),
        { kind: 'validation' }
      );
    }
  }
}

async function finalizeCheckpoint({
  root,
  lock,
  checkpoint,
  fullPlan,
  implementation,
  provider,
  at
}) {
  const finalize = implementation[provider.runtime.probeFinalizeExport];
  if (typeof finalize !== 'function') {
    throw Object.assign(
      new Error('MCP probe finalize export is not a function: ' + provider.runtime.probeFinalizeExport),
      { kind: 'validation' }
    );
  }
  const observations = await finalize({
    plan: structuredClone(fullPlan.scope),
    steps: structuredClone(fullPlan.steps),
    results: checkpoint.steps.map((step) => ({
      stepId: step.id,
      result: rehydrateStepResult(step.result),
      resultFingerprint: step.resultFingerprint
    })),
    settings: lock.settings || {},
    mappings: loadProviderMappings(root, provider),
    at
  });
  assertProviderProbeFinalizerPrivacy({ lock, fullPlan, observations });
  assertObservationScope(fullPlan.scope, observations);
  assertCheckScope(fullPlan, observations.checks);
  const durableChecks = observations.checks.map((check, index) => {
    const source = fullPlan.steps[index];
    const runtimeStep = checkpoint.steps[index];
    return {
      ...structuredClone(check),
      subject: fingerprintJson(source.subject),
      expectedFingerprint: source.argumentsFingerprint,
      observedFingerprint: runtimeStep.resultFingerprint
    };
  });
  const probe = {
    $contract: 'soter://contracts/provider-probe/v2',
    contractVersion: '2.0.0',
    id: fullPlan.probeId,
    probedAt: at,
    validUntil: validUntil(at, fullPlan.validForSeconds),
    configuration: {
      name: lock.configuration.name,
      lockFingerprint: fingerprintLock(lock)
    },
    provider: structuredClone(checkpoint.provider),
    credentials: observations.credentials,
    reachability: observations.reachability,
    authorities: observations.authorities,
    capabilities: observations.capabilities,
    checks: durableChecks,
    secretValuesExcluded: true,
    limitations: observations.limitations
  };
  assertProbeContract(root, probe);
  return probe;
}

function terminalCall(call, { completedAt, state, responseFingerprint, error }) {
  const terminal = structuredClone(call);
  delete terminal.arguments;
  terminal.completedAt = completedAt;
  terminal.state = state;
  terminal.responseFingerprint = responseFingerprint;
  terminal.error = error;
  return terminal;
}

function priorResponse(checkpoint, callId, response) {
  const step = checkpoint.steps.find((item) => item.call?.id === callId);
  if (!step?.call?.responseFingerprint) return false;
  if (step.call.responseFingerprint !== fingerprintJson(response)) {
    throw new Error('Provider probe response does not match the exact completed step call.');
  }
  return true;
}

function failureSummary(error) {
  const summary = structuredClone(error);
  delete summary.diagnosticFingerprint;
  return summary;
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

function encodeMinimizedValue(value, depth = 0) {
  if (depth > 5) throw validationError('Probe step minimized state exceeded its depth bound.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw validationError('Probe step minimized state contained an invalid integer.');
    }
    return value;
  }
  if (typeof value === 'string') {
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
      throw validationError('Probe step minimized state contained an invalid fingerprint.');
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) {
      throw validationError('Probe step minimized state exceeded its array bound.');
    }
    return value.map((item) => encodeMinimizedValue(item, depth + 1));
  }
  const fields = Object.entries(value).map(([key, child]) => ({
    identityFingerprint: fingerprintJson(key),
    value: encodeMinimizedValue(child, depth + 1)
  })).sort((left, right) => {
    return compareCodepoint(left.identityFingerprint, right.identityFingerprint);
  });
  if (fields.length > 50
    || fields.some((field, index) => {
      return index > 0
        && field.identityFingerprint === fields[index - 1].identityFingerprint;
    })) {
    throw validationError('Probe step minimized state exceeded its exact field bound.');
  }
  return { fields };
}

function encodeStepResult(value) {
  if (!minimizedStepResult(value)
    || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('Probe step translator returned invalid minimized state.');
  }
  return encodeMinimizedValue(value);
}

function durableMinimizedValue(value, depth = 0) {
  if (depth > 5) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0;
  if (typeof value === 'string') return /^sha256:[a-f0-9]{64}$/.test(value);
  if (Array.isArray(value)) {
    return value.length <= 50
      && value.every((item) => durableMinimizedValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1
    || !Array.isArray(value.fields) || value.fields.length > 50) return false;
  let prior = null;
  return value.fields.every((field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)
      || Object.keys(field).sort().join(',') !== 'identityFingerprint,value'
      || !/^sha256:[a-f0-9]{64}$/.test(field.identityFingerprint)
      || (prior !== null && compareCodepoint(prior, field.identityFingerprint) >= 0)
      || !durableMinimizedValue(field.value, depth + 1)) return false;
    prior = field.identityFingerprint;
    return true;
  });
}

function durableStepResult(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && durableMinimizedValue(value));
}

function rehydrateMinimizedValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(rehydrateMinimizedValue);
  const fields = new Map(value.fields.map((field) => [
    field.identityFingerprint,
    field.value
  ]));
  const cache = new Map();
  const resolved = (property) => {
    if (typeof property !== 'string') return undefined;
    const identityFingerprint = fingerprintJson(property);
    if (!fields.has(identityFingerprint)) return undefined;
    if (!cache.has(identityFingerprint)) {
      cache.set(identityFingerprint, rehydrateMinimizedValue(fields.get(identityFingerprint)));
    }
    return cache.get(identityFingerprint);
  };
  return new Proxy(Object.create(null), {
    get(_target, property) {
      return resolved(property);
    },
    has(_target, property) {
      return typeof property === 'string' && fields.has(fingerprintJson(property));
    },
    getOwnPropertyDescriptor(_target, property) {
      const child = resolved(property);
      return child === undefined ? undefined : {
        configurable: true,
        enumerable: true,
        writable: false,
        value: child
      };
    },
    ownKeys() {
      return [];
    }
  });
}

function rehydrateStepResult(value) {
  if (!durableStepResult(value)) {
    throw validationError('Provider probe finalization received invalid durable step state.');
  }
  return rehydrateMinimizedValue(value);
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
  if (checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Provider probe response does not match the exact lock and graph request.');
  }
  const { provider, plan: fullPlan } = await exactDerivedPlan({
    root: resolvedRoot,
    lock,
    checkpoint,
    translator
  });
  const currentCall = providerProbePlanCurrentCall(checkpoint);
  if (!currentCall || currentCall.id !== callId) {
    if (priorResponse(checkpoint, callId, response)) {
      return { checkpoint: structuredClone(checkpoint), idempotent: true };
    }
    throw new Error('Provider probe response does not match the exact current call.');
  }
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
  const source = fullPlan.steps.find((step) => step.id === next.currentStepId);
  const responseFingerprint = fingerprintJson(response);
  try {
    const result = await complete({
      step: structuredClone(source),
      responseProfile: currentCall.transport.responseProfile,
      response,
      plan: fullPlan.scope,
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
    runtimeStep.call = terminalCall(runtimeStep.call, {
      completedAt: at,
      state: 'completed',
      responseFingerprint,
      error: null
    });
    runtimeStep.result = encodeStepResult(result);
    runtimeStep.resultFingerprint = fingerprintJson(runtimeStep.result);
    runtimeStep.error = null;
    next.updatedAt = at;
    next.currentStepId = null;
    const pending = next.steps.find((step) => step.state === 'pending');
    if (pending) {
      return {
        checkpoint: requestNextStep(next, fullPlan, at),
        idempotent: false
      };
    }
    next.result = await finalizeCheckpoint({
      root: resolvedRoot,
      lock,
      checkpoint: next,
      fullPlan,
      implementation,
      provider,
      at
    });
    next.state = 'completed';
    return { checkpoint: next, idempotent: false };
  } catch (error) {
    const normalized = normalizedError(error, 'validation');
    runtimeStep.state = 'failed';
    runtimeStep.call = terminalCall(runtimeStep.call, {
      completedAt: at,
      state: 'failed',
      responseFingerprint,
      error: normalized
    });
    runtimeStep.result = null;
    runtimeStep.resultFingerprint = null;
    runtimeStep.error = failureSummary(normalized);
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
  if (checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Provider probe failure does not match the exact lock and graph request.');
  }
  const normalized = normalizedError(error);
  const currentCall = providerProbePlanCurrentCall(checkpoint);
  if (!currentCall || currentCall.id !== callId) {
    const previous = checkpoint.steps.find((step) => step.call?.id === callId);
    if (previous?.call?.error
      && fingerprintJson(previous.call.error) === fingerprintJson(normalized)) {
      return { checkpoint: structuredClone(checkpoint), idempotent: true };
    }
    throw new Error('Provider probe failure does not match the exact current call.');
  }
  const next = structuredClone(checkpoint);
  const runtimeStep = next.steps.find((step) => step.id === next.currentStepId);
  runtimeStep.state = 'failed';
  runtimeStep.call = terminalCall(runtimeStep.call, {
    completedAt: at,
    state: 'failed',
    responseFingerprint: null,
    error: normalized
  });
  runtimeStep.result = null;
  runtimeStep.resultFingerprint = null;
  runtimeStep.error = failureSummary(normalized);
  next.updatedAt = at;
  next.state = 'failed';
  next.currentStepId = null;
  next.result = null;
  return { checkpoint: next, idempotent: false };
}
