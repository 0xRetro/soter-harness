import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { createAutomationPreparationEvidence } from './evidence.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import {
  fingerprintJson,
  importGovernedModule,
  readJson,
  readGovernedJson,
  repoRelativePath,
  resolveGovernedFile,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import { fingerprintLock, lockMatchesResolution, resolveConfiguration } from './resolve.mjs';
import { prepareRunEnvelope } from './run.mjs';
import {
  hasPrivateConfigurationState,
  privateConfigurationStatePath
} from './private-configurations.mjs';
import {
  assertAutomationReviewProjection,
  assertDerivedReviewDeclaration,
  assertReviewProjectionSemantics,
  derivedReviewContentFingerprint,
  derivedReviewDefinitionMap,
  derivedReviewItemFingerprint
} from './review-projections.mjs';
import {
  createPreparedWorkDerivedReviewMaterialState,
  createPreparedWorkReviewMaterialState,
  activeConfigurationLockStatePath,
  hasActiveConfigurationLockState,
  hasPreparedWorkDerivedReviewMaterialState,
  hasPreparedWorkState,
  hasPreparedWorkReviewMaterialState,
  readPreparedWorkDerivedReviewMaterialState,
  readPreparedWorkReviewMaterialState,
  readPreparedWorkState,
  readActiveConfigurationLockState,
  readRunState,
  runStatePath,
  writeContextSnapshotState,
  writePreparedWorkEvidenceState,
  writePreparedWorkState,
  writeRunState
} from './runtime-state.mjs';

const CONTRACT = 'soter://contracts/prepared-work/v1';
const VERSION = '1.0.0';
const REVIEW_CONTRACT = 'soter://contracts/prepared-work-review-material/v1';
const REVIEW_VERSION = '1.0.0';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/prepared-work-derived-review-material/v1';
const DERIVED_REVIEW_VERSION = '1.0.0';
const PREPARED_STATES = new Set([
  'draft',
  'preparing',
  'needs-input',
  'ready-for-review',
  'ready-for-acquisition'
]);
const CONFIGURATION_BASES = new Set(['tracked-contained', 'private-active']);
const PREPARATION_MODES = new Set(['contained', 'connected-acquisition']);
const ACQUISITION_RUN_STATES = new Set([
  'effects-established',
  'executing',
  'verifying',
  'completed',
  'failed',
  'paused'
]);

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function walkJson(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJson(target);
    return entry.isFile() && entry.name.endsWith('.json') ? [target] : [];
  }).sort(compareText);
}

function validate(root, value, contractPath, label) {
  const failures = validateJsonSchema(value, readGovernedJson(root, contractPath));
  if (failures.length) {
    throw new Error(label + ' does not satisfy its contract: '
      + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '));
  }
}

function invalidAdapter(message) {
  const error = new Error(message);
  error.code = 'PREPARATION_ADAPTER_INVALID';
  return error;
}

function receiptFingerprint(value) {
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function withFingerprint(value) {
  return { ...value, fingerprint: receiptFingerprint(value) };
}

function reviewMaterialError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function reviewMaterialFingerprint(value) {
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  delete unsigned.applicability;
  return fingerprintJson(unsigned);
}

function withReviewMaterialFingerprint(value) {
  return { ...value, fingerprint: reviewMaterialFingerprint(value) };
}

function derivedReviewMaterialError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function derivedReviewMaterialFingerprint(value) {
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  delete unsigned.applicability;
  return fingerprintJson(unsigned);
}

function withDerivedReviewMaterialFingerprint(value) {
  return { ...value, fingerprint: derivedReviewMaterialFingerprint(value) };
}

function identityPayload({
  automationId,
  inputContractFingerprint,
  fields,
  configurationBasis,
  lockFingerprint,
  preparationMode = 'contained'
}) {
  const identity = {
    automationId,
    inputContractFingerprint,
    fields,
    configurationBasis,
    lockFingerprint
  };
  if (preparationMode === 'connected-acquisition') {
    identity.preparationMode = preparationMode;
  }
  return identity;
}

function workIdFor(identity) {
  const digest = fingerprintJson(identity).slice('sha256:'.length, 'sha256:'.length + 24);
  return 'work.' + identity.automationId.slice('automation.'.length) + '.' + digest;
}

function normalizeScalar(field, value) {
  if (value === undefined || value === null || value === '') return null;
  if (field.type === 'string-list') {
    if (!Array.isArray(value)) throw new Error(field.label + ' must be a list of text values.');
    const normalized = value.map((item) => {
      if (typeof item !== 'string') throw new Error(field.label + ' contains a non-text value.');
      return item.trim();
    });
    if (normalized.some((item) => !item)) {
      throw new Error(field.label + ' contains an empty value.');
    }
    if (new Set(normalized).size !== normalized.length) {
      throw new Error(field.label + ' contains duplicate values.');
    }
    if (normalized.length < field.constraints.minItems
      || normalized.length > field.constraints.maxItems) {
      throw new Error(field.label + ' is outside its declared item-count bounds.');
    }
    if (field.constraints.itemMinLength !== undefined
      && normalized.some((item) => item.length < field.constraints.itemMinLength)) {
      throw new Error(field.label + ' contains a value shorter than its declared minimum.');
    }
    if (field.constraints.itemMaxLength !== undefined
      && normalized.some((item) => item.length > field.constraints.itemMaxLength)) {
      throw new Error(field.label + ' contains a value longer than its declared maximum.');
    }
    if (field.constraints.itemPattern
      && normalized.some((item) => !new RegExp(field.constraints.itemPattern).test(item))) {
      throw new Error(field.label + ' contains a value outside its declared format.');
    }
    return normalized.length ? normalized : null;
  }
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(field.label + ' must be a boolean.');
    return value;
  }
  if (typeof value !== 'string') throw new Error(field.label + ' must be text.');
  const normalized = value.trim();
  if (field.type === 'enum' && !field.options.includes(normalized)) {
    throw new Error(field.label + ' must use a declared option.');
  }
  if (field.type === 'date') {
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const observed = match
      ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
      : null;
    if (!match
      || observed.getUTCFullYear() !== Number(match[1])
      || observed.getUTCMonth() !== Number(match[2]) - 1
      || observed.getUTCDate() !== Number(match[3])) {
      throw new Error(field.label + ' must use a real calendar date in YYYY-MM-DD form.');
    }
  }
  if (field.type === 'uri') {
    try {
      new URL(normalized);
    } catch {
      throw new Error(field.label + ' must be an absolute URI.');
    }
  }
  if (field.constraints?.minLength !== undefined && normalized.length < field.constraints.minLength) {
    throw new Error(field.label + ' is shorter than its declared minimum.');
  }
  if (field.constraints?.maxLength !== undefined && normalized.length > field.constraints.maxLength) {
    throw new Error(field.label + ' exceeds its declared maximum.');
  }
  if (field.constraints?.pattern && !new RegExp(field.constraints.pattern).test(normalized)) {
    throw new Error(field.label + ' does not match its declared format.');
  }
  return normalized;
}

function summarizeInput(definition, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Automation preparation input must be an object.');
  }
  const declared = new Set(definition.fields.map((field) => field.id));
  const unknown = Object.keys(input).filter((key) => !declared.has(key));
  if ((!definition.additionalInputs && unknown.length) || Object.keys(input).some((key) => key.startsWith('$'))) {
    throw new Error('Automation preparation input contains undeclared fields.');
  }
  const blockers = [];
  const normalized = {};
  const fields = definition.fields.map((field) => {
    let value = null;
    try {
      value = normalizeScalar(field, input[field.id]);
    } catch (error) {
      blockers.push({
        reasonCode: 'INPUT_INVALID',
        fieldId: field.id,
        message: error.message,
        remediation: 'Provide a value that satisfies the automation input declaration.'
      });
    }
    if (value === null && field.required) {
      blockers.push({
        reasonCode: 'REQUIRED_INPUT_MISSING',
        fieldId: field.id,
        message: field.label + ' is required before preparation can acquire context.',
        remediation: 'Provide ' + field.label + ' and prepare the run again.'
      });
    }
    if (value !== null) normalized[field.id] = value;
    const common = {
      id: field.id,
      state: value === null ? 'omitted' : 'provided',
      fingerprint: value === null ? null : fingerprintJson(value),
      exposure: field.exposure
    };
    return field.exposure === 'identifier'
      ? { ...common, value: value === null ? null : value }
      : common;
  });
  return { fields, blockers, normalized };
}

function reviewFields(definition, summary) {
  return definition.fields.map((declaration, index) => {
    const sanitized = summary.fields[index];
    if (!sanitized
      || sanitized.id !== declaration.id
      || sanitized.exposure !== declaration.exposure) {
      throw reviewMaterialError(
        'PREPARED_REVIEW_MATERIAL_BINDING_INVALID',
        'Prepared-work review fields do not match the declared input order.'
      );
    }
    if (sanitized.state === 'omitted') {
      return {
        id: declaration.id,
        exposure: declaration.exposure,
        state: 'omitted',
        fingerprint: null
      };
    }
    if (!Object.hasOwn(summary.normalized, declaration.id)) {
      throw reviewMaterialError(
        'PREPARED_REVIEW_MATERIAL_BINDING_INVALID',
        'Prepared-work review values do not match the sanitized input summary.'
      );
    }
    return {
      id: declaration.id,
      exposure: declaration.exposure,
      state: 'provided',
      fingerprint: sanitized.fingerprint,
      reviewValue: summary.normalized[declaration.id]
    };
  });
}

function buildReviewMaterial(work, automation, summary) {
  return withReviewMaterialFingerprint({
    $contract: REVIEW_CONTRACT,
    contractVersion: REVIEW_VERSION,
    fingerprint: 'sha256:' + '0'.repeat(64),
    createdAt: work.updatedAt,
    workId: work.id,
    preparedWorkFingerprint: work.fingerprint,
    checkpointId: work.checkpoint.id,
    checkpointFingerprint: work.checkpoint.fingerprint,
    automation: { id: work.automation.id, version: work.automation.version },
    configuration: {
      name: work.configuration.name,
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: work.configuration.lockFingerprint
    },
    inputContractFingerprint: work.inputSummary.inputContractFingerprint,
    applicability: 'current',
    fields: reviewFields(automation.input, summary),
    privacy: {
      scope: 'private-local-review',
      authority: 'none',
      projection: 'selected-work-only'
    }
  });
}

function buildDerivedReviewMaterial(work, derivedReview, automation) {
  if (!derivedReview || typeof derivedReview !== 'object' || Array.isArray(derivedReview)) {
    throw derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_MALFORMED',
      'Prepared-work derived review material is not a closed provider-neutral object.'
    );
  }
  return withDerivedReviewMaterialFingerprint({
    $contract: DERIVED_REVIEW_CONTRACT,
    contractVersion: DERIVED_REVIEW_VERSION,
    fingerprint: 'sha256:' + '0'.repeat(64),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview),
    createdAt: work.updatedAt,
    workId: work.id,
    preparedWorkFingerprint: work.fingerprint,
    checkpointId: work.checkpoint.id,
    checkpointFingerprint: work.checkpoint.fingerprint,
    automation: { id: work.automation.id, version: work.automation.version },
    configuration: {
      name: work.configuration.name,
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: work.configuration.lockFingerprint
    },
    inputContractFingerprint: work.inputSummary.inputContractFingerprint,
    reviewContractId: automation.derivedReviewDefinition.$contract,
    reviewContractFingerprint: fingerprintJson(automation.derivedReviewDefinition),
    applicability: 'current',
    kind: derivedReview.kind,
    items: structuredClone(derivedReview.items),
    privacy: {
      scope: 'private-local-derived-review',
      authority: 'none',
      projection: 'selected-work-only',
      rawProviderResponsesIncluded: false,
      rawMessageBodiesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsIncluded: false
    }
  });
}

function loadAutomation(root, automationId) {
  if (typeof automationId !== 'string' || !/^automation\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(automationId)) {
    throw new TypeError('Automation id is invalid.');
  }
  const packRelativePath = 'soter/packs/' + automationId + '/pack.json';
  const pack = readGovernedJson(root, packRelativePath);
  validate(root, pack, 'soter/contracts/pack.schema.json', 'Automation pack');
  if (pack.id !== automationId || pack.layer !== 'automation') {
    throw new Error('Prepared work requires one exact Automation pack.');
  }
  if (!pack.operator?.preparation) {
    throw new Error(automationId + ' does not declare a prepared-work adapter.');
  }
  const input = readGovernedJson(root, pack.operator.input);
  if (input.$contract !== 'soter://contracts/automation-input/v1' || input.automation !== automationId) {
    throw new Error('Automation input declaration does not match ' + automationId + '.');
  }
  validate(root, input, 'soter/contracts/automation-input.schema.json', 'Automation input');
  const modulePath = resolveGovernedFile(root, pack.operator.preparation.module);
  const artifact = pack.artifacts.find((item) => item.path === pack.operator.preparation.module
    && item.role === 'implementation');
  if (!artifact) {
    throw new Error('Prepared-work adapter must be a declared Automation implementation artifact.');
  }
  let acquisition = null;
  if (pack.operator.acquisition) {
    const acquisitionPath = resolveGovernedFile(root, pack.operator.acquisition.module);
    const acquisitionArtifact = pack.artifacts.find((item) => {
      return item.path === pack.operator.acquisition.module && item.role === 'implementation';
    });
    if (!acquisitionArtifact) {
      throw new Error(
        'Connected-acquisition adapter must be a declared Automation implementation artifact.'
      );
    }
    for (const schemaKey of ['inspectSchema', 'privateInspectSchema']) {
      const schemaPath = pack.operator.acquisition[schemaKey];
      if (!schemaPath) continue;
      const schemaArtifact = pack.artifacts.find((item) => {
        return item.path === schemaPath && item.role === 'definition';
      });
      if (!schemaArtifact) {
        throw new Error(
          'Connected-acquisition inspection schema must be a declared Automation definition artifact.'
        );
      }
      resolveGovernedFile(root, schemaPath);
    }
    acquisition = {
      module: pack.operator.acquisition.module,
      modulePath: acquisitionPath,
      prepareExport: pack.operator.acquisition.prepareExport,
      finalizeExport: pack.operator.acquisition.finalizeExport,
      inspectExport: pack.operator.acquisition.inspectExport || null,
      privateInspectExport: pack.operator.acquisition.privateInspectExport || null,
      inspectSchema: pack.operator.acquisition.inspectSchema || null,
      privateInspectSchema: pack.operator.acquisition.privateInspectSchema || null,
      availability: structuredClone(
        pack.operator.acquisition.availability || { state: 'available' }
      ),
      recordRequirements: structuredClone(pack.operator.acquisition.recordRequirements)
    };
  }
  let derivedReviewDefinition = null;
  const derivedReviewPath = pack.operator.preparation.derivedReviewContract || null;
  if (derivedReviewPath) {
    const definitionArtifact = pack.artifacts.find((item) => {
      return item.path === derivedReviewPath && item.role === 'definition';
    });
    if (!definitionArtifact) {
      throw new Error('Automation derived review contract must be a declared definition artifact.');
    }
    derivedReviewDefinition = readGovernedJson(root, derivedReviewPath);
    validate(
      root,
      derivedReviewDefinition,
      'soter/contracts/automation-derived-review.schema.json',
      'Automation derived review contract'
    );
    if (derivedReviewDefinition.automation !== automationId) {
      throw new Error('Automation derived review contract does not match ' + automationId + '.');
    }
    derivedReviewDefinitionMap(derivedReviewDefinition);
  }
  return {
    root,
    pack,
    input,
    module: pack.operator.preparation.module,
    modulePath,
    exportName: pack.operator.preparation.export,
    derivedReviewDefinition,
    acquisition
  };
}

function assertPreparationMode(preparationMode) {
  const mode = preparationMode || 'contained';
  if (!PREPARATION_MODES.has(mode)) {
    throw new TypeError(
      'Automation preparation mode must be contained or connected-acquisition.'
    );
  }
  return mode;
}

function requireConnectedAcquisitionDeclaration(automation) {
  if (!automation.acquisition) {
    throw invalidAdapter(
      automation.pack.id + ' does not declare one exact connected-acquisition adapter.'
    );
  }
  if (automation.acquisition.availability.state !== 'available') {
    const error = new Error(
      'Connected acquisition is unavailable for this Automation.'
    );
    error.code = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(
      automation.acquisition.availability.reasonCode || ''
    )
      ? automation.acquisition.availability.reasonCode
      : 'PREPARATION_MODE_UNAVAILABLE';
    throw error;
  }
  return automation.acquisition;
}

async function assertConnectedAcquisitionDeclaration(automation) {
  const acquisition = requireConnectedAcquisitionDeclaration(automation);
  const module = await importGovernedModule(
    automation.root,
    automation.acquisition.module
  );
  const declaredExports = [
    acquisition.prepareExport,
    acquisition.finalizeExport,
    acquisition.inspectExport,
    acquisition.privateInspectExport
  ].filter(Boolean);
  if (new Set(declaredExports).size !== declaredExports.length
    || declaredExports.some((name) => typeof module[name] !== 'function')) {
    throw invalidAdapter(
      'Connected-acquisition declared exports must be distinct and callable.'
    );
  }
  return acquisition;
}

function assertConfigurationBasis(configurationBasis) {
  if (!CONFIGURATION_BASES.has(configurationBasis)) {
    throw new TypeError(
      'Prepared work requires configurationBasis tracked-contained or private-active.'
    );
  }
  return configurationBasis;
}

function configurationStatePair(root, configurationName) {
  const desired = fs.existsSync(privateConfigurationStatePath(root, configurationName));
  const activeLock = hasActiveConfigurationLockState(root, configurationName);
  if (desired !== activeLock) {
    throw new Error(
      'Private desired configuration and active exact lock must either both exist or both be absent; tracked fallback is prohibited.'
    );
  }
  return { desired, activeLock };
}

function exactConfiguration(root, automationId, configurationName, configurationBasis) {
  if (typeof configurationName !== 'string' || !configurationName.trim()) {
    throw new TypeError('Prepared work requires one explicit configuration name.');
  }
  const basis = assertConfigurationBasis(configurationBasis);
  const state = configurationStatePair(root, configurationName);
  if (basis === 'private-active') {
    if (!state.desired || !state.activeLock) {
      throw new Error(
        'Prepared work with configurationBasis private-active requires private desired configuration and its active exact lock; tracked fallback is prohibited.'
      );
    }
    try {
      hasPrivateConfigurationState(root, configurationName);
      const lock = readActiveConfigurationLockState(root, configurationName).lock;
      const configPath = repoRelativePath(
        root,
        privateConfigurationStatePath(root, configurationName)
      );
      if (lock.configuration.name !== configurationName
        || lock.configuration.path !== configPath
        || !lock.packs.some((pack) => pack.id === automationId)) {
        throw new Error('Active private configuration does not select the requested Automation.');
      }
      const current = lockMatchesResolution({
        root,
        lock,
        configPath,
        host: lock.host.id
      });
      if (!current.matches) {
        throw new Error('Active private configuration lock is stale.');
      }
      return {
        lock,
        lockPath: repoRelativePath(
          root,
          activeConfigurationLockStatePath(root, configurationName)
        ),
        configPath,
        configurationBasis: basis
      };
    } catch (error) {
      throw new Error(
        'Prepared work requires a current exact active private configuration; tracked fallback is prohibited.',
        { cause: error }
      );
    }
  }
  const candidates = fs.readdirSync(path.join(root, 'soter', 'configurations'))
    .filter((name) => name.endsWith('.config.json'))
    .sort(compareText)
    .map((name) => 'soter/configurations/' + name)
    .map((configPath) => ({ configPath, resolvedLock: resolveConfiguration({ root, configPath }) }))
    .filter(({ resolvedLock }) => resolvedLock.configuration.name === configurationName
      && resolvedLock.packs.some((pack) => pack.id === automationId));
  if (candidates.length !== 1) {
    throw new Error(
      'Prepared work requires exactly one desired configuration named '
        + configurationName + ' selecting ' + automationId + '.'
    );
  }
  const { configPath, resolvedLock } = candidates[0];
  const matchingLocks = walkJson(path.join(root, 'soter', 'fixtures'))
    .map((file) => ({ file, value: readJson(file) }))
    .filter(({ value }) => value.$contract === 'soter://contracts/lock/v1'
      && value.configuration.path === configPath
      && value.configuration.name === resolvedLock.configuration.name);
  if (matchingLocks.length !== 1) {
    throw new Error('Prepared work requires exactly one checked-in exact lock for ' + resolvedLock.configuration.name + '.');
  }
  const observed = matchingLocks[0].value;
  const current = lockMatchesResolution({ root, lock: observed, configPath });
  if (!current.matches || fingerprintLock(observed) !== fingerprintLock(resolvedLock)) {
    throw new Error('Prepared work requires a current exact configuration lock.');
  }
  return {
    lock: observed,
    lockPath: repoRelativePath(root, matchingLocks[0].file),
    configPath,
    configurationBasis: basis
  };
}

function effectFacts(lock, completedEffects = []) {
  const completed = new Set(completedEffects.flatMap((effect) => effect.declaredEffects));
  return Object.entries(lock.effectPolicies).map(([effect, policy]) => ({
    effect,
    mode: policy.mode,
    state: completed.has(effect) ? 'completed-contained' : 'not-executed',
    reason: policy.reason
  }));
}

function emptyPreview() {
  return {
    kind: 'unavailable',
    fingerprint: null,
    facts: [],
    contradictions: [],
    collections: [],
    privateReview: {
      state: 'unavailable',
      kind: null,
      contractId: null,
      contractFingerprint: null,
      contentFingerprint: null
    },
    proposedChanges: []
  };
}

function assertPreparedReviewProjection(
  prepared,
  { automationPack, lock, derivedReviewDefinition }
) {
  return assertAutomationReviewProjection({
    preview: prepared.preview,
    derivedReview: prepared.derivedReview ?? null,
    automationPack,
    lock,
    derivedReviewDefinition,
    invalid: invalidAdapter,
    materialInvalid: (code, message) => derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_' + code,
      message
    )
  });
}

export function assertAutomationPreparationAdapterResult(
  root,
  prepared,
  { automationId, automationPack, lock, derivedReviewDefinition = null }
) {
  if (!prepared?.envelope || !prepared?.snapshot || !prepared?.preview
    || !Array.isArray(prepared.contextPlan) || !Array.isArray(prepared.outcomes)) {
    throw invalidAdapter('Automation preparation adapter returned an invalid provider-neutral result.');
  }
  validate(root, prepared.envelope, 'soter/contracts/run-envelope.schema.json', 'Prepared run envelope');
  validate(root, prepared.snapshot, 'soter/contracts/context-snapshot.schema.json', 'Prepared context snapshot');
  const lockFingerprint = fingerprintLock(lock);
  if (prepared.envelope.automation.id !== automationId
    || prepared.envelope.configurationLock.fingerprint !== lockFingerprint
    || prepared.envelope.graphFingerprint !== lock.graphFingerprint
    || prepared.snapshot.runId !== prepared.envelope.id
    || prepared.snapshot.configurationLockFingerprint !== lockFingerprint
    || prepared.snapshot.graphFingerprint !== lock.graphFingerprint
    || prepared.snapshot.containment !== 'fixture'
    || prepared.envelope.effects.some((effect) => effect.containment !== 'fixture')) {
    throw invalidAdapter('Automation preparation adapter result is not bound to the exact fixture-contained work.');
  }
  const declaredCapabilities = new Set(
    automationPack.capabilities.requires.map((requirement) => requirement.id)
  );
  const boundCapabilities = new Map(lock.bindings.map((binding) => [binding.capability, binding]));
  assertPreparedReviewProjection(prepared, {
    automationPack,
    lock,
    derivedReviewDefinition
  });
  for (const effect of prepared.envelope.effects) {
    const binding = boundCapabilities.get(effect.capability);
    if (!declaredCapabilities.has(effect.capability)
      || !binding
      || binding.providerPack !== effect.providerPack
      || !binding.authorities.includes(effect.authority)
      || effect.declaredEffects.some((item) => {
        return !automationPack.effects.includes(item) || !binding.effects.includes(item);
      })) {
      throw invalidAdapter(
        'Prepared effect ' + effect.id
          + ' exceeds the Automation capability, authority, provider, or effect declarations.'
      );
    }
  }
  for (const step of prepared.contextPlan) {
    const binding = boundCapabilities.get(step.capability);
    if (!declaredCapabilities.has(step.capability)
      || !binding
      || !binding.authorities.includes(step.authority)) {
      throw invalidAdapter(
        'Prepared context step ' + step.id
          + ' exceeds the Automation capability or exact authority bindings.'
      );
    }
  }
  for (const change of prepared.preview.proposedChanges) {
    const binding = boundCapabilities.get(change.effect);
    if (!declaredCapabilities.has(change.effect)
      || !binding
      || !binding.effects.some((item) => ['write', 'dispatch', 'destructive'].includes(item))
      || binding.effects.some((item) => !automationPack.effects.includes(item))) {
      throw invalidAdapter(
        'Prepared preview change ' + change.id
          + ' names an undeclared or unbound Automation effect capability.'
      );
    }
  }
  const effectIds = prepared.envelope.effects.map((effect) => effect.id);
  if (fingerprintJson(effectIds) !== fingerprintJson(prepared.snapshot.effectIds)) {
    throw invalidAdapter('Prepared run effects do not match the context snapshot effects.');
  }
  return prepared;
}

function contextFailure(work, at, reasonCode = 'PREPARATION_CONTEXT_UNAVAILABLE') {
  const adapterInvalid = reasonCode === 'PREPARATION_ADAPTER_INVALID';
  const inputInvalid = reasonCode === 'PREPARATION_INPUT_INVALID';
  return withFingerprint({
    ...work,
    state: 'needs-input',
    updatedAt: at,
    history: [...work.history, {
      state: 'needs-input',
      at,
      reasonCode
    }],
    readiness: {
      ...work.readiness,
      state: 'needs-input',
      blockers: [{
        reasonCode,
        fieldId: null,
        message: adapterInvalid
          ? 'The Automation preparation adapter exceeded or violated its declared provider-neutral contract.'
          : inputInvalid
            ? 'The supplied inputs do not form a valid domain preparation request.'
          : 'The declared contained context could not be acquired or validated for this exact work.',
        remediation: adapterInvalid
          ? 'Repair and verify the Automation pack before preparing this work again.'
          : inputInvalid
            ? 'Review the declared input combination and prepare a new exact work item.'
          : 'Review the selected identifier, exact lock, and contained fixture records before preparing again.'
      }]
    },
    checkpoint: { ...work.checkpoint, state: 'needs-input' },
    resume: {
      classification: 'requires-review',
      reasonCode,
      reason: adapterInvalid
        ? 'The declared Automation preparation adapter did not satisfy Core validation.'
        : inputInvalid
          ? 'The exact input combination is not valid for this preparation mode.'
        : 'Contained context acquisition or validation did not complete.',
      permittedNextAction: adapterInvalid ? 'repair-automation-pack' : 'review-preparation-inputs'
    }
  });
}

export function classifyPreparationFailure(error) {
  if (error?.code === 'PREPARATION_INPUT_INVALID') return 'PREPARATION_INPUT_INVALID';
  return error?.code === 'PREPARATION_ADAPTER_INVALID'
    || error?.code?.startsWith('PREPARED_DERIVED_REVIEW_MATERIAL_')
    ? 'PREPARATION_ADAPTER_INVALID'
    : 'PREPARATION_CONTEXT_UNAVAILABLE';
}

function baseReceipt({
  id,
  createdAt,
  automation,
  configuration,
  inputSummary,
  blockers,
  preparationMode = 'contained'
}) {
  const state = blockers.length ? 'needs-input' : 'draft';
  const automationIdentity = { id: automation.pack.id, version: automation.pack.version };
  const checkpointFingerprint = fingerprintJson({
    id,
    automation: automationIdentity,
    configuration,
    inputSummary
  });
  const receipt = {
    $contract: CONTRACT,
    contractVersion: VERSION,
    id,
    fingerprint: 'sha256:' + '0'.repeat(64),
    createdAt,
    updatedAt: createdAt,
    automation: automationIdentity,
    state,
    history: [{ state, at: createdAt, reasonCode: blockers.length ? 'REQUIRED_INPUT_MISSING' : 'PREPARATION_DRAFTED' }],
    configuration,
    inputSummary,
    contextPlan: [],
    outcomes: [],
    capabilities: { steps: [], completedPrefix: [], current: null, pending: [] },
    effects: [],
    approval: {
      state: 'not-requested',
      requiredFor: [],
      reason: 'Preparation creates no approval or execution authority.'
    },
    readiness: {
      state: blockers.length ? 'needs-input' : 'preparing',
      blockers,
      limitations: preparationMode === 'connected-acquisition'
        ? [
          'Connected acquisition is staged but no provider call or context acquisition has occurred.',
          'The receipt grants no approval, continuation, execution, write, readiness, verification, proof, maturity, or migration authority.'
        ]
        : [
          'Preparation is fixture-contained and does not establish connected readiness or provider health.',
          'The receipt grants no approval, execution, write, verification, proof, maturity, or migration authority.'
        ]
    },
    preview: emptyPreview(),
    evidence: [],
    checkpoint: { id: 'checkpoint.' + id, fingerprint: checkpointFingerprint, runId: null, contextSnapshotId: null, state },
    resume: blockers.length
      ? { classification: 'requires-review', reasonCode: 'REQUIRED_INPUT_MISSING', reason: 'Required declared inputs are missing or invalid.', permittedNextAction: 'supply-required-inputs' }
      : { classification: 'unavailable', reasonCode: 'PREPARATION_DRAFTED', reason: 'Preparation has not acquired contained context yet.', permittedNextAction: 'prepare-work' },
    continuationRequest: null,
    privacy: {
      scope: 'private-derived',
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      privateInputValuesIncluded: false,
      canonicalArtifactsWritten: false,
      externalWritesPerformed: false
    }
  };
  if (preparationMode === 'connected-acquisition') {
    receipt.preparationMode = preparationMode;
  }
  return withFingerprint(receipt);
}

export function assertPreparedWork(root, work) {
  const resolvedRoot = path.resolve(root);
  validate(resolvedRoot, work, 'soter/contracts/prepared-work.schema.json', 'Prepared work');
  const checkpointFingerprint = fingerprintJson({
    id: work.id,
    automation: work.automation,
    configuration: work.configuration,
    inputSummary: work.inputSummary
  });
  const preparationMode = work.preparationMode || 'contained';
  const readinessForState = {
    draft: 'preparing',
    preparing: 'preparing',
    'needs-input': 'needs-input',
    'ready-for-review': 'ready-for-review',
    'ready-for-acquisition': 'ready-for-acquisition'
  };
  const crossedModeHistory = work.history.some((entry) => {
    return preparationMode === 'connected-acquisition'
      ? entry.state === 'ready-for-review'
      : entry.state === 'ready-for-acquisition';
  });
  if (!PREPARED_STATES.has(work.state)
    || (preparationMode === 'connected-acquisition' && work.state === 'ready-for-review')
    || (preparationMode === 'contained' && work.state === 'ready-for-acquisition')
    || crossedModeHistory
    || work.history.at(-1)?.state !== work.state
    || work.checkpoint.state !== work.state
    || work.readiness.state !== readinessForState[work.state]
    || work.fingerprint !== receiptFingerprint(work)
    || work.checkpoint.fingerprint !== checkpointFingerprint) {
    throw new Error('Prepared work fingerprint or lifecycle state is invalid.');
  }
  assertReviewProjectionSemantics(work.preview, (message) => new Error(message));
  const identity = identityPayload({
    automationId: work.automation.id,
    inputContractFingerprint: work.inputSummary.inputContractFingerprint,
    fields: work.inputSummary.fields,
    configurationBasis: work.configuration.configurationBasis,
    lockFingerprint: work.configuration.lockFingerprint,
    preparationMode: work.preparationMode || 'contained'
  });
  if (work.id !== workIdFor(identity) || work.inputSummary.workId !== work.id) {
    throw new Error('Prepared work identity does not match its exact inputs and lock.');
  }
  return work;
}

export function assertPreparedWorkReviewMaterial(root, material, work, loadedAutomation = null) {
  const resolvedRoot = path.resolve(root);
  try {
    validate(
      resolvedRoot,
      material,
      'soter/contracts/prepared-work-review-material.schema.json',
      'Prepared-work review material'
    );
  } catch (error) {
    throw reviewMaterialError(
      'PREPARED_REVIEW_MATERIAL_MALFORMED',
      'Prepared-work review material does not satisfy its private contract.',
      error
    );
  }
  if (material.fingerprint !== reviewMaterialFingerprint(material)) {
    throw reviewMaterialError(
      'PREPARED_REVIEW_MATERIAL_TAMPERED',
      'Prepared-work review material fingerprint does not match its durable contents.'
    );
  }
  const validWork = assertPreparedWork(resolvedRoot, work);
  const automation = loadedAutomation || loadAutomation(resolvedRoot, validWork.automation.id);
  const bindingMismatch = material.createdAt !== validWork.updatedAt
    || material.workId !== validWork.id
    || material.preparedWorkFingerprint !== validWork.fingerprint
    || material.checkpointId !== validWork.checkpoint.id
    || material.checkpointFingerprint !== validWork.checkpoint.fingerprint
    || fingerprintJson(material.automation) !== fingerprintJson(validWork.automation)
    || material.configuration.name !== validWork.configuration.name
    || material.configuration.configurationBasis
      !== validWork.configuration.configurationBasis
    || material.configuration.lockFingerprint !== validWork.configuration.lockFingerprint
    || material.inputContractFingerprint !== validWork.inputSummary.inputContractFingerprint
    || material.inputContractFingerprint !== fingerprintJson(automation.input)
    || material.fields.length !== automation.input.fields.length
    || material.fields.length !== validWork.inputSummary.fields.length;
  if (bindingMismatch) {
    throw reviewMaterialError(
      'PREPARED_REVIEW_MATERIAL_BINDING_INVALID',
      'Prepared-work review material does not match the exact receipt, checkpoint, lock, and input contract.'
    );
  }
  const credentialShape = {};
  for (let index = 0; index < material.fields.length; index += 1) {
    const field = material.fields[index];
    const declaration = automation.input.fields[index];
    const sanitized = validWork.inputSummary.fields[index];
    if (field.id !== declaration.id
      || field.id !== sanitized.id
      || field.exposure !== declaration.exposure
      || field.exposure !== sanitized.exposure
      || field.state !== sanitized.state
      || field.fingerprint !== sanitized.fingerprint) {
      throw reviewMaterialError(
        'PREPARED_REVIEW_MATERIAL_BINDING_INVALID',
        'Prepared-work review material field order or fingerprints do not match the sanitized receipt.'
      );
    }
    if (field.state === 'omitted') continue;
    let normalized;
    try {
      normalized = normalizeScalar(declaration, field.reviewValue);
    } catch (error) {
      throw reviewMaterialError(
        'PREPARED_REVIEW_MATERIAL_MALFORMED',
        'Prepared-work review material contains a value outside its declared input contract.',
        error
      );
    }
    if (normalized === null
      || fingerprintJson(normalized) !== field.fingerprint
      || fingerprintJson(normalized) !== fingerprintJson(field.reviewValue)
      || (field.exposure === 'identifier'
        && fingerprintJson(field.reviewValue) !== fingerprintJson(sanitized.value))) {
      throw reviewMaterialError(
        'PREPARED_REVIEW_MATERIAL_BINDING_INVALID',
        'Prepared-work review material value fingerprints do not match the sanitized receipt.'
      );
    }
    credentialShape[field.id] = field.reviewValue;
  }
  if (containsCredentialMaterial(credentialShape)) {
    throw reviewMaterialError(
      'PREPARED_REVIEW_MATERIAL_CREDENTIAL_REJECTED',
      'Prepared-work review material cannot contain credential material.'
    );
  }
  return material;
}

export function assertPreparedWorkDerivedReviewMaterial(root, material, work) {
  const resolvedRoot = path.resolve(root);
  try {
    validate(
      resolvedRoot,
      material,
      'soter/contracts/prepared-work-derived-review-material.schema.json',
      'Prepared-work derived review material'
    );
  } catch (error) {
    throw derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_MALFORMED',
      'Prepared-work derived review material does not satisfy its private contract.',
      error
    );
  }
  if (material.fingerprint !== derivedReviewMaterialFingerprint(material)) {
    throw derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_TAMPERED',
      'Prepared-work derived review fingerprint does not match its durable contents.'
    );
  }
  const validWork = assertPreparedWork(resolvedRoot, work);
  const automation = loadAutomation(resolvedRoot, validWork.automation.id);
  const reference = validWork.preview.privateReview;
  const contentFingerprint = fingerprintJson({ kind: material.kind, items: material.items });
  const bindingMismatch = material.createdAt !== validWork.updatedAt
    || material.workId !== validWork.id
    || material.preparedWorkFingerprint !== validWork.fingerprint
    || material.checkpointId !== validWork.checkpoint.id
    || material.checkpointFingerprint !== validWork.checkpoint.fingerprint
    || fingerprintJson(material.automation) !== fingerprintJson(validWork.automation)
    || material.configuration.name !== validWork.configuration.name
    || material.configuration.configurationBasis
      !== validWork.configuration.configurationBasis
    || material.configuration.lockFingerprint !== validWork.configuration.lockFingerprint
    || material.inputContractFingerprint !== validWork.inputSummary.inputContractFingerprint
    || material.reviewContractId !== automation.derivedReviewDefinition?.$contract
    || material.reviewContractFingerprint !== fingerprintJson(automation.derivedReviewDefinition)
    || reference.state !== 'available'
    || reference.kind !== material.kind
    || reference.contractId !== material.reviewContractId
    || reference.contractFingerprint !== material.reviewContractFingerprint
    || reference.contentFingerprint !== material.contentFingerprint
    || material.contentFingerprint !== contentFingerprint;
  if (bindingMismatch) {
    throw derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_BINDING_INVALID',
      'Prepared-work derived review does not match the exact receipt, checkpoint, lock, input contract, and sanitized reference.'
    );
  }
  assertDerivedReviewDeclaration(
    { kind: material.kind, items: material.items },
    automation.derivedReviewDefinition,
    (message) => derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_MALFORMED',
      message
    )
  );
  const { rowBindings, actions, changes } = assertReviewProjectionSemantics(
    validWork.preview,
    (message) => derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_BINDING_INVALID',
      message
    )
  );
  const itemIds = new Set();
  const itemFingerprints = new Map();
  const credentialShape = {};
  for (const item of material.items) {
    if (itemIds.has(item.id)
      || !item.sources.every((source) => {
        return rowBindings.get(source.collectionId + '\u0000' + source.rowId)
          ?.rowFingerprint === source.rowFingerprint;
      })) {
      throw derivedReviewMaterialError(
        'PREPARED_DERIVED_REVIEW_MATERIAL_BINDING_INVALID',
        'Prepared-work derived review item identity or source-row binding is invalid.'
      );
    }
    itemIds.add(item.id);
    const fieldIds = new Set();
    for (const field of item.fields) {
      if (fieldIds.has(field.id)
        || field.fingerprint !== fingerprintJson(field.reviewValue)) {
        throw derivedReviewMaterialError(
          'PREPARED_DERIVED_REVIEW_MATERIAL_MALFORMED',
          'Prepared-work derived review field exceeds its closed normalized contract.'
        );
      }
      fieldIds.add(field.id);
      credentialShape[item.id + '.' + field.id] = field.reviewValue;
    }
    if (item.fingerprint !== derivedReviewItemFingerprint(item)) {
      throw derivedReviewMaterialError(
        'PREPARED_DERIVED_REVIEW_MATERIAL_TAMPERED',
        'Prepared-work derived review item fingerprint does not match its normalized fields.'
      );
    }
    if (itemFingerprints.has(item.fingerprint)) {
      throw derivedReviewMaterialError(
        'PREPARED_DERIVED_REVIEW_MATERIAL_BINDING_INVALID',
        'Prepared-work derived review item fingerprints must be unique.'
      );
    }
    itemFingerprints.set(item.fingerprint, item);
  }
  if (containsCredentialMaterial(credentialShape)) {
    throw derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_CREDENTIAL_REJECTED',
      'Prepared-work derived review material cannot contain credential material.'
    );
  }
  for (const binding of rowBindings.values()) {
    if (binding.privateDetailFingerprint === null) continue;
    const detail = itemFingerprints.get(binding.privateDetailFingerprint);
    if (!detail || !detail.sources.some((source) => {
      return source.collectionId === binding.collectionId
        && source.rowId === binding.rowId
        && source.rowFingerprint === binding.rowFingerprint;
    })) {
      throw derivedReviewMaterialError(
        'PREPARED_DERIVED_REVIEW_MATERIAL_BINDING_INVALID',
        'Prepared-work private-detail reference does not bind an exact private item and row.'
      );
    }
  }
  for (const { action, source } of actions.filter(({ action }) => action.state === 'proposed')) {
    const change = changes.get(action.id);
    const privateItem = itemFingerprints.get(change.afterFingerprint);
    if (!privateItem || !privateItem.sources.some((candidate) => {
      return candidate.collectionId === source.collectionId
        && candidate.rowId === source.rowId
        && candidate.rowFingerprint === source.rowFingerprint;
    })) {
      throw derivedReviewMaterialError(
        'PREPARED_DERIVED_REVIEW_MATERIAL_BINDING_INVALID',
        'Prepared-work proposed change does not bind exact private material for its row.'
      );
    }
  }
  return material;
}

export function projectPreparedWorkApplicability(root, work) {
  const resolvedRoot = path.resolve(root);
  const valid = structuredClone(assertPreparedWork(resolvedRoot, work));
  let current = false;
  try {
    const state = configurationStatePair(resolvedRoot, valid.configuration.name);
    const privatePath = repoRelativePath(
      resolvedRoot,
      privateConfigurationStatePath(resolvedRoot, valid.configuration.name)
    );
    const activeLockPath = repoRelativePath(
      resolvedRoot,
      activeConfigurationLockStatePath(resolvedRoot, valid.configuration.name)
    );
    const basisPathsMatch = valid.configuration.configurationBasis === 'private-active'
      ? state.desired
        && state.activeLock
        && valid.configuration.path === privatePath
        && valid.configuration.lockPath === activeLockPath
      : !valid.configuration.path.startsWith('.soter/')
        && valid.configuration.path.startsWith('soter/configurations/')
        && valid.configuration.lockPath.startsWith('soter/fixtures/');
    if (!basisPathsMatch) throw new Error('Prepared-work configuration basis no longer applies.');
    if (valid.configuration.configurationBasis === 'private-active') {
      hasPrivateConfigurationState(resolvedRoot, valid.configuration.name);
    }
    const lock = valid.configuration.configurationBasis === 'private-active'
      ? readActiveConfigurationLockState(resolvedRoot, valid.configuration.name).lock
      : readJson(resolveRepoPath(resolvedRoot, valid.configuration.lockPath));
    const exact = lockMatchesResolution({
      root: resolvedRoot,
      lock,
      configPath: valid.configuration.path,
      host: valid.configuration.host
    });
    current = exact.matches
      && fingerprintLock(lock) === valid.configuration.lockFingerprint
      && lock.graphFingerprint === valid.configuration.graphFingerprint
      && lock.configuration.name === valid.configuration.name;
  } catch {
    current = false;
  }
  if (current) return valid;
  return withFingerprint({
    ...valid,
    configuration: { ...valid.configuration, applicability: 'stale' },
    readiness: {
      ...valid.readiness,
      limitations: [
        ...new Set([
          ...valid.readiness.limitations,
          'The exact preparation lock is stale; this historical receipt cannot support continuation.'
        ])
      ]
    },
    resume: {
      classification: 'unavailable',
      reasonCode: 'CHECKPOINT_STALE',
      reason: 'The prepared receipt no longer applies to the current exact configuration lock.',
      permittedNextAction: 'prepare-work-again'
    },
    continuationRequest: null
  });
}

export function inspectPreparedAutomationWork({ root, workId }) {
  const resolvedRoot = path.resolve(root);
  const work = readPreparedWorkState(resolvedRoot, workId).work;
  return projectPreparedWorkApplicability(resolvedRoot, work);
}

export function inspectPreparedAutomationReviewMaterial({ root, workId }) {
  const resolvedRoot = path.resolve(root);
  let work;
  try {
    work = readPreparedWorkState(resolvedRoot, workId).work;
  } catch (error) {
    throw reviewMaterialError(
      'PREPARED_REVIEW_MATERIAL_BINDING_INVALID',
      'Prepared-work review material has no valid prepared-work receipt binding.',
      error
    );
  }
  if (!hasPreparedWorkReviewMaterialState(resolvedRoot, workId)) {
    throw reviewMaterialError(
      'PREPARED_REVIEW_MATERIAL_MISSING',
      'Private review material is unavailable for this prepared work.'
    );
  }
  let material;
  try {
    material = readPreparedWorkReviewMaterialState(resolvedRoot, workId).material;
  } catch (error) {
    throw reviewMaterialError(
      'PREPARED_REVIEW_MATERIAL_MALFORMED',
      'Private review material could not be read for this prepared work.',
      error
    );
  }
  let valid;
  try {
    valid = assertPreparedWorkReviewMaterial(resolvedRoot, material, work);
  } catch (error) {
    if (error?.code?.startsWith('PREPARED_REVIEW_MATERIAL_')) throw error;
    throw reviewMaterialError(
      'PREPARED_REVIEW_MATERIAL_MALFORMED',
      'Private review material could not be validated for this prepared work.',
      error
    );
  }
  const projected = projectPreparedWorkApplicability(resolvedRoot, work);
  return {
    ...structuredClone(valid),
    applicability: projected.configuration.applicability
  };
}

export function inspectPreparedAutomationDerivedReviewMaterial({ root, workId }) {
  const resolvedRoot = path.resolve(root);
  let work;
  try {
    work = readPreparedWorkState(resolvedRoot, workId).work;
  } catch (error) {
    throw derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_BINDING_INVALID',
      'Prepared-work derived review material has no valid prepared-work receipt binding.',
      error
    );
  }
  if (!hasPreparedWorkDerivedReviewMaterialState(resolvedRoot, workId)) {
    throw derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_MISSING',
      'Private derived review material is unavailable for this prepared work.'
    );
  }
  let material;
  try {
    material = readPreparedWorkDerivedReviewMaterialState(resolvedRoot, workId).material;
  } catch (error) {
    throw derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_MALFORMED',
      'Private derived review material could not be read for this prepared work.',
      error
    );
  }
  let valid;
  try {
    valid = assertPreparedWorkDerivedReviewMaterial(resolvedRoot, material, work);
  } catch (error) {
    if (error?.code?.startsWith('PREPARED_DERIVED_REVIEW_MATERIAL_')) throw error;
    throw derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_MALFORMED',
      'Private derived review material could not be validated for this prepared work.',
      error
    );
  }
  const projected = projectPreparedWorkApplicability(resolvedRoot, work);
  return {
    ...structuredClone(valid),
    applicability: projected.configuration.applicability
  };
}

function acquisitionError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

export function loadExactPreparedAutomationAcquisition({
  root,
  workId,
  automationId,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const automation = loadAutomation(resolvedRoot, automationId);
  if (!automation.acquisition) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_DECLARATION_INVALID',
      'Automation does not declare a connected-acquisition adapter.'
    );
  }
  if (automation.acquisition.availability.state !== 'available') {
    throw acquisitionError(
      /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(
        automation.acquisition.availability.reasonCode || ''
      )
        ? automation.acquisition.availability.reasonCode
        : 'PREPARED_ACQUISITION_MODE_UNAVAILABLE',
      'Connected acquisition is unavailable for this Automation.'
    );
  }
  let work;
  let material;
  try {
    work = inspectPreparedAutomationWork({ root: resolvedRoot, workId });
    material = inspectPreparedAutomationReviewMaterial({ root: resolvedRoot, workId });
  } catch (error) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_WORK_INVALID',
      'Connected acquisition prepared work or its private input is unavailable or invalid.',
      error
    );
  }
  if (work.automation.id !== automationId || material.automation.id !== automationId) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_BINDING_INVALID',
      'Connected acquisition does not match the requested Automation.'
    );
  }
  let lock;
  let run;
  try {
    lock = readJson(resolveRepoPath(resolvedRoot, work.configuration.lockPath));
    run = readRunState(resolvedRoot, work.checkpoint.runId).run;
  } catch (error) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_BINDING_INVALID',
      'Connected acquisition exact lock or durable run is unavailable.',
      error
    );
  }
  const noPreparedReview = fingerprintJson(work.preview) === fingerprintJson(emptyPreview());
  const exactBinding = work.preparationMode === 'connected-acquisition'
    && work.state === 'ready-for-acquisition'
    && work.configuration.configurationBasis === 'private-active'
    && work.configuration.applicability === 'current'
    && material.applicability === 'current'
    && work.configuration.lockFingerprint === fingerprintLock(lock)
    && work.configuration.graphFingerprint === lock.graphFingerprint
    && work.configuration.host === lock.host.id
    && work.configuration.name === lock.configuration.name
    && work.configuration.path === lock.configuration.path
    && material.configuration.lockFingerprint === fingerprintLock(lock)
    && material.preparedWorkFingerprint === work.fingerprint
    && material.checkpointFingerprint === work.checkpoint.fingerprint
    && material.inputContractFingerprint === work.inputSummary.inputContractFingerprint
    && typeof work.checkpoint.runId === 'string'
    && work.checkpoint.runId
    && work.checkpoint.contextSnapshotId === null
    && run.id === work.checkpoint.runId
    && run.configurationLock.path === work.configuration.lockPath
    && run.configurationLock.fingerprint === work.configuration.lockFingerprint
    && run.graphFingerprint === work.configuration.graphFingerprint
    && run.host.id === work.configuration.host
    && run.automation.id === automationId
    && run.automation.version === work.automation.version
    && ACQUISITION_RUN_STATES.has(run.lifecycleState)
    && Array.isArray(run.effects)
    && Array.isArray(run.evidenceIds)
    && run.evidenceIds.length === 0
    && work.contextPlan.length === 0
    && work.outcomes.length === 0
    && work.capabilities.steps.length === 0
    && work.capabilities.completedPrefix.length === 0
    && work.capabilities.current === null
    && work.capabilities.pending.length === 0
    && work.effects.length === 0
    && work.approval.state === 'not-requested'
    && work.approval.requiredFor.length === 0
    && work.readiness.state === 'ready-for-acquisition'
    && work.readiness.blockers.length === 0
    && noPreparedReview
    && work.evidence.length === 0
    && work.resume.classification === 'unavailable'
    && work.continuationRequest === null
    && !hasPreparedWorkDerivedReviewMaterialState(resolvedRoot, workId)
    && (!expectedHost || lock.host.id === expectedHost);
  if (!exactBinding) {
    throw acquisitionError(
      work.configuration.applicability === 'stale'
        ? 'PREPARED_ACQUISITION_STALE'
        : 'PREPARED_ACQUISITION_BINDING_INVALID',
      'Connected acquisition requires current exact staged private-active work, lock, host, and its Core-owned durable run.'
    );
  }
  return {
    work,
    material,
    lock,
    lockPath: work.configuration.lockPath,
    run,
    runPath: repoRelativePath(
      resolvedRoot,
      runStatePath(resolvedRoot, run.id)
    ),
    acquisition: structuredClone(automation.pack.operator.acquisition)
  };
}

function persistPreparedAutomationReviewMaterial({ root, work, automation, summary }) {
  const expected = buildReviewMaterial(work, automation, summary);
  assertPreparedWorkReviewMaterial(root, expected, work, automation);
  if (hasPreparedWorkReviewMaterialState(root, work.id)) {
    const existing = inspectPreparedAutomationReviewMaterial({ root, workId: work.id });
    if (existing.fingerprint !== expected.fingerprint
      || fingerprintJson(existing.fields) !== fingerprintJson(expected.fields)) {
      throw reviewMaterialError(
        'PREPARED_REVIEW_MATERIAL_MISMATCH',
        'Exact prepared-work re-entry does not match its durable private review material.'
      );
    }
    return existing;
  }
  try {
    createPreparedWorkReviewMaterialState(root, expected);
  } catch (error) {
    throw reviewMaterialError(
      'PREPARED_REVIEW_MATERIAL_WRITE_FAILED',
      'Private review material could not be stored atomically.',
      error
    );
  }
  return expected;
}

function persistPreparedAutomationDerivedReviewMaterial({ root, work, derivedReview, automation }) {
  const expected = buildDerivedReviewMaterial(work, derivedReview, automation);
  assertPreparedWorkDerivedReviewMaterial(root, expected, work);
  if (hasPreparedWorkDerivedReviewMaterialState(root, work.id)) {
    const existing = inspectPreparedAutomationDerivedReviewMaterial({ root, workId: work.id });
    if (existing.fingerprint !== expected.fingerprint
      || existing.contentFingerprint !== expected.contentFingerprint) {
      throw derivedReviewMaterialError(
        'PREPARED_DERIVED_REVIEW_MATERIAL_MISMATCH',
        'Exact prepared-work re-entry does not match its durable private derived review material.'
      );
    }
    return existing;
  }
  try {
    createPreparedWorkDerivedReviewMaterialState(root, expected);
  } catch (error) {
    throw derivedReviewMaterialError(
      'PREPARED_DERIVED_REVIEW_MATERIAL_WRITE_FAILED',
      'Private derived review material could not be stored atomically.',
      error
    );
  }
  return expected;
}

export async function prepareAutomationRun({
  root,
  automationId,
  configurationName,
  configurationBasis,
  preparationMode = 'contained',
  expectedHost = null,
  input = {},
  createdAt = new Date().toISOString()
}) {
  const resolvedRoot = path.resolve(root);
  const at = new Date(createdAt).toISOString();
  const mode = assertPreparationMode(preparationMode);
  const automation = loadAutomation(resolvedRoot, automationId);
  if (mode === 'connected-acquisition') {
    requireConnectedAcquisitionDeclaration(automation);
    if (configurationBasis !== 'private-active') {
      throw new Error(
        'Connected acquisition staging requires configurationBasis private-active; contained fallback is prohibited.'
      );
    }
  }
  const exact = exactConfiguration(
    resolvedRoot,
    automationId,
    configurationName,
    configurationBasis
  );
  if (expectedHost && exact.lock.host.id !== expectedHost) {
    throw new Error('Connected acquisition staging does not match the exact active host.');
  }
  if (mode === 'connected-acquisition') {
    await assertConnectedAcquisitionDeclaration(automation);
  }
  const summary = summarizeInput(automation.input, input);
  if (containsCredentialMaterial(summary.normalized)) {
    throw reviewMaterialError(
      'PREPARED_REVIEW_MATERIAL_CREDENTIAL_REJECTED',
      'Automation preparation input contains credential material; use configured secret references instead.'
    );
  }
  const inputContractFingerprint = fingerprintJson(automation.input);
  const identity = identityPayload({
    automationId,
    inputContractFingerprint,
    fields: summary.fields,
    configurationBasis: exact.configurationBasis,
    lockFingerprint: fingerprintLock(exact.lock),
    preparationMode: mode
  });
  const workId = workIdFor(identity);
  if (hasPreparedWorkState(resolvedRoot, workId)) {
    const existing = inspectPreparedAutomationWork({ root: resolvedRoot, workId });
    const material = inspectPreparedAutomationReviewMaterial({ root: resolvedRoot, workId });
    const expected = buildReviewMaterial(existing, automation, summary);
    if (material.fingerprint !== expected.fingerprint
      || fingerprintJson(material.fields) !== fingerprintJson(expected.fields)) {
      throw reviewMaterialError(
        'PREPARED_REVIEW_MATERIAL_MISMATCH',
        'Exact prepared-work re-entry does not match its durable private review material.'
      );
    }
    if (mode === 'connected-acquisition' && existing.state === 'ready-for-acquisition') {
      loadExactPreparedAutomationAcquisition({
        root: resolvedRoot,
        workId,
        automationId,
        expectedHost
      });
    } else if (mode === 'contained' && existing.preview.privateReview.state === 'available') {
      inspectPreparedAutomationDerivedReviewMaterial({ root: resolvedRoot, workId });
    } else if (hasPreparedWorkDerivedReviewMaterialState(resolvedRoot, workId)) {
      throw derivedReviewMaterialError(
        'PREPARED_DERIVED_REVIEW_MATERIAL_BINDING_INVALID',
        'Prepared work without a private derived-review reference cannot own derived review material.'
      );
    }
    return existing;
  }
  const inputSummary = {
    $contract: 'soter://contracts/operator-input-summary/v1',
    contractVersion: '1.0.0',
    workId,
    inputContractFingerprint,
    fields: summary.fields,
    privacy: { privateValuesIncluded: false, identifierValuesSanitized: true }
  };
  validate(resolvedRoot, inputSummary, 'soter/contracts/operator-input-summary.schema.json', 'Operator input summary');
  const configuration = {
    name: exact.lock.configuration.name,
    path: exact.lock.configuration.path,
    lockPath: exact.lockPath,
    configurationBasis: exact.configurationBasis,
    lockFingerprint: fingerprintLock(exact.lock),
    graphFingerprint: exact.lock.graphFingerprint,
    host: exact.lock.host.id,
    applicability: 'current'
  };
  let work = baseReceipt({
    id: workId,
    createdAt: at,
    automation,
    configuration,
    inputSummary,
    blockers: summary.blockers,
    preparationMode: mode
  });
  validate(resolvedRoot, work, 'soter/contracts/prepared-work.schema.json', 'Prepared work');
  if (summary.blockers.length) {
    writePreparedWorkState(resolvedRoot, work);
    work = assertPreparedWork(resolvedRoot, work);
    persistPreparedAutomationReviewMaterial({ root: resolvedRoot, work, automation, summary });
    return work;
  }

  if (mode === 'connected-acquisition') {
    const runId = 'run.' + automationId.slice('automation.'.length)
      + '.connected-acquisition.' + workId.slice(workId.lastIndexOf('.') + 1);
    const stagedRun = {
      ...prepareRunEnvelope({
        root: resolvedRoot,
        lock: exact.lock,
        lockPath: exact.lockPath,
        automationId,
        runId,
        createdAt: at,
        requestedOutcome: 'Stage exact private operator input for a separately checkpointed connected acquisition without calling a provider.',
        evidenceIds: []
      }),
      lifecycleState: 'effects-established',
      checkpoints: [{
        id: 'connected-acquisition-staged',
        state: 'passed',
        details: 'Exact private input and current lock are staged; no provider call, context snapshot, effect, approval, or continuation exists.'
      }],
      outputs: [],
      effects: [],
      evidenceIds: []
    };
    validate(
      resolvedRoot,
      stagedRun,
      'soter/contracts/run-envelope.schema.json',
      'Connected-acquisition staged run'
    );
    work = withFingerprint({
      ...work,
      state: 'ready-for-acquisition',
      updatedAt: at,
      history: [
        ...work.history,
        {
          state: 'ready-for-acquisition',
          at,
          reasonCode: 'PREPARATION_READY_FOR_ACQUISITION'
        }
      ],
      readiness: {
        state: 'ready-for-acquisition',
        blockers: [],
        limitations: work.readiness.limitations
      },
      checkpoint: {
        ...work.checkpoint,
        runId,
        contextSnapshotId: null,
        state: 'ready-for-acquisition'
      },
      resume: {
        classification: 'unavailable',
        reasonCode: 'PREPARATION_READY_FOR_ACQUISITION',
        reason: 'Private input and the exact current lock are staged; connected acquisition has not started.',
        permittedNextAction: 'prepare-connected-acquisition'
      }
    });
    work = assertPreparedWork(resolvedRoot, work);
    writeRunState(resolvedRoot, stagedRun);
    writePreparedWorkState(resolvedRoot, work);
    persistPreparedAutomationReviewMaterial({
      root: resolvedRoot,
      work,
      automation,
      summary
    });
    return loadExactPreparedAutomationAcquisition({
      root: resolvedRoot,
      workId,
      automationId,
      expectedHost
    }).work;
  }

  work = withFingerprint({
    ...work,
    state: 'preparing',
    updatedAt: at,
    history: [...work.history, { state: 'preparing', at, reasonCode: 'PREPARATION_STARTED' }],
    checkpoint: { ...work.checkpoint, state: 'preparing' },
    resume: { classification: 'unavailable', reasonCode: 'PREPARATION_IN_PROGRESS', reason: 'Contained context preparation has started.', permittedNextAction: 'inspect-preparation' }
  });
  writePreparedWorkState(resolvedRoot, work);

  let prepared;
  try {
    const module = await importGovernedModule(automation.root, automation.module);
    const adapter = module[automation.exportName];
    if (typeof adapter !== 'function') throw invalidAdapter('Automation preparation export is not callable.');
    prepared = assertAutomationPreparationAdapterResult(resolvedRoot, await adapter({
      root: resolvedRoot,
      lock: exact.lock,
      lockPath: exact.lockPath,
      workId,
      input: summary.normalized,
      createdAt: at
    }), {
      automationId,
      automationPack: automation.pack,
      lock: exact.lock,
      derivedReviewDefinition: automation.derivedReviewDefinition
    });
  } catch (error) {
    work = contextFailure(work, at, classifyPreparationFailure(error));
    writePreparedWorkState(resolvedRoot, work);
    work = assertPreparedWork(resolvedRoot, work);
    persistPreparedAutomationReviewMaterial({ root: resolvedRoot, work, automation, summary });
    return work;
  }
  writeRunState(resolvedRoot, prepared.envelope);
  writeContextSnapshotState(resolvedRoot, prepared.snapshot);
  const evidence = createAutomationPreparationEvidence({
    lock: exact.lock,
    envelope: prepared.envelope,
    snapshot: prepared.snapshot,
    workId,
    inputSummaryFingerprint: fingerprintJson(inputSummary),
    previewFingerprint: prepared.preview.fingerprint,
    id: 'evidence.' + workId,
    createdAt: at
  });
  validate(resolvedRoot, evidence, 'soter/contracts/evidence-v2.schema.json', 'Prepared-work evidence');
  writePreparedWorkEvidenceState(resolvedRoot, evidence);
  const completedPrefix = prepared.contextPlan.filter((step) => step.state === 'completed').map((step) => step.id);
  const pending = prepared.contextPlan.filter((step) => step.state === 'pending').map((step) => step.id);
  work = withFingerprint({
    ...work,
    state: 'ready-for-review',
    updatedAt: at,
    history: [...work.history, { state: 'ready-for-review', at, reasonCode: 'PREPARATION_READY_FOR_REVIEW' }],
    contextPlan: prepared.contextPlan,
    outcomes: prepared.outcomes,
    capabilities: {
      steps: prepared.contextPlan,
      completedPrefix,
      current: null,
      pending
    },
    effects: effectFacts(exact.lock, prepared.envelope.effects),
    approval: {
      state: 'not-requested',
      requiredFor: Object.entries(exact.lock.effectPolicies)
        .filter(([effect, policy]) => {
          return policy.mode === 'confirm' && automation.pack.effects.includes(effect);
        })
        .map(([effect]) => effect),
      reason: 'The preview stops before writes; any later exact change batch requires a separate canonical approval request.'
    },
    readiness: {
      state: 'ready-for-review',
      blockers: [],
      limitations: work.readiness.limitations
    },
    preview: prepared.preview,
    evidence: [{
      id: evidence.id,
      claim: evidence.claim,
      result: evidence.result,
      level: evidence.evaluator.level,
      createdAt: evidence.createdAt,
      limitations: [...evidence.limitations]
    }],
    checkpoint: {
      ...work.checkpoint,
      runId: prepared.envelope.id,
      contextSnapshotId: prepared.snapshot.id,
      state: 'ready-for-review'
    },
    resume: {
      classification: 'requires-review',
      reasonCode: 'PREPARATION_READY_FOR_REVIEW',
      reason: 'Contained context, contradictions, preview fingerprints, and limitations are ready for operator review.',
      permittedNextAction: 'review-prepared-work'
    }
  });
  writePreparedWorkState(resolvedRoot, work);
  work = assertPreparedWork(resolvedRoot, work);
  persistPreparedAutomationReviewMaterial({ root: resolvedRoot, work, automation, summary });
  if (prepared.derivedReview) {
    persistPreparedAutomationDerivedReviewMaterial({
      root: resolvedRoot,
      work,
      derivedReview: prepared.derivedReview,
      automation
    });
  }
  return work;
}
