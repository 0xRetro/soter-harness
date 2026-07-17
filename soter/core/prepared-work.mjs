import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { createAutomationPreparationEvidence } from './evidence.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import { fingerprintJson, readJson, repoRelativePath, resolveRepoPath } from './lib/canonical-json.mjs';
import { fingerprintLock, lockMatchesResolution, resolveConfiguration } from './resolve.mjs';
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
  hasPreparedWorkDerivedReviewMaterialState,
  hasPreparedWorkState,
  hasPreparedWorkReviewMaterialState,
  readPreparedWorkDerivedReviewMaterialState,
  readPreparedWorkReviewMaterialState,
  readPreparedWorkState,
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
const PREPARED_STATES = new Set(['draft', 'preparing', 'needs-input', 'ready-for-review']);

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
  const failures = validateJsonSchema(value, readJson(path.join(root, contractPath)));
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

function identityPayload({ automationId, inputContractFingerprint, fields, lockFingerprint }) {
  return { automationId, inputContractFingerprint, fields, lockFingerprint };
}

function workIdFor(identity) {
  const digest = fingerprintJson(identity).slice('sha256:'.length, 'sha256:'.length + 24);
  return 'work.' + identity.automationId.slice('automation.'.length) + '.' + digest;
}

function normalizeScalar(field, value) {
  if (value === undefined || value === null || value === '') return null;
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
  const packPath = path.join(root, 'soter', 'packs', automationId, 'pack.json');
  const pack = readJson(packPath);
  if (pack.id !== automationId || pack.layer !== 'automation') {
    throw new Error('Prepared work requires one exact Automation pack.');
  }
  if (!pack.operator?.preparation) {
    throw new Error(automationId + ' does not declare a prepared-work adapter.');
  }
  const inputPath = resolveRepoPath(root, pack.operator.input);
  const input = readJson(inputPath);
  if (input.$contract !== 'soter://contracts/automation-input/v1' || input.automation !== automationId) {
    throw new Error('Automation input declaration does not match ' + automationId + '.');
  }
  validate(root, input, 'soter/contracts/automation-input.schema.json', 'Automation input');
  const modulePath = resolveRepoPath(root, pack.operator.preparation.module);
  const artifact = pack.artifacts.find((item) => item.path === pack.operator.preparation.module
    && item.role === 'implementation');
  if (!artifact || !fs.statSync(modulePath).isFile()) {
    throw new Error('Prepared-work adapter must be a declared Automation implementation artifact.');
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
    derivedReviewDefinition = readJson(resolveRepoPath(root, derivedReviewPath));
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
    pack,
    input,
    modulePath,
    exportName: pack.operator.preparation.export,
    derivedReviewDefinition
  };
}

function exactConfiguration(root, automationId, configurationName) {
  if (typeof configurationName !== 'string' || !configurationName.trim()) {
    throw new TypeError('Prepared work requires one explicit configuration name.');
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
    configPath
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
          : 'The declared contained context could not be acquired or validated for this exact work.',
        remediation: adapterInvalid
          ? 'Repair and verify the Automation pack before preparing this work again.'
          : 'Review the selected identifier, exact lock, and contained fixture records before preparing again.'
      }]
    },
    checkpoint: { ...work.checkpoint, state: 'needs-input' },
    resume: {
      classification: 'requires-review',
      reasonCode,
      reason: adapterInvalid
        ? 'The declared Automation preparation adapter did not satisfy Core validation.'
        : 'Contained context acquisition or validation did not complete.',
      permittedNextAction: adapterInvalid ? 'repair-automation-pack' : 'review-preparation-inputs'
    }
  });
}

export function classifyPreparationFailure(error) {
  return error?.code === 'PREPARATION_ADAPTER_INVALID'
    || error?.code?.startsWith('PREPARED_DERIVED_REVIEW_MATERIAL_')
    ? 'PREPARATION_ADAPTER_INVALID'
    : 'PREPARATION_CONTEXT_UNAVAILABLE';
}

function baseReceipt({ id, createdAt, automation, configuration, inputSummary, blockers }) {
  const state = blockers.length ? 'needs-input' : 'draft';
  const checkpointFingerprint = fingerprintJson({ id, automation, configuration, inputSummary });
  return withFingerprint({
    $contract: CONTRACT,
    contractVersion: VERSION,
    id,
    fingerprint: 'sha256:' + '0'.repeat(64),
    createdAt,
    updatedAt: createdAt,
    automation: { id: automation.pack.id, version: automation.pack.version },
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
      limitations: [
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
  });
}

export function assertPreparedWork(root, work) {
  const resolvedRoot = path.resolve(root);
  validate(resolvedRoot, work, 'soter/contracts/prepared-work.schema.json', 'Prepared work');
  if (!PREPARED_STATES.has(work.state) || work.fingerprint !== receiptFingerprint(work)) {
    throw new Error('Prepared work fingerprint or lifecycle state is invalid.');
  }
  assertReviewProjectionSemantics(work.preview, (message) => new Error(message));
  const identity = identityPayload({
    automationId: work.automation.id,
    inputContractFingerprint: work.inputSummary.inputContractFingerprint,
    fields: work.inputSummary.fields,
    lockFingerprint: work.configuration.lockFingerprint
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
    const lock = readJson(resolveRepoPath(resolvedRoot, valid.configuration.lockPath));
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
  input = {},
  createdAt = new Date().toISOString()
}) {
  const resolvedRoot = path.resolve(root);
  const at = new Date(createdAt).toISOString();
  const automation = loadAutomation(resolvedRoot, automationId);
  const exact = exactConfiguration(resolvedRoot, automationId, configurationName);
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
    lockFingerprint: fingerprintLock(exact.lock)
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
    if (existing.preview.privateReview.state === 'available') {
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
    lockFingerprint: fingerprintLock(exact.lock),
    graphFingerprint: exact.lock.graphFingerprint,
    host: exact.lock.host.id,
    applicability: 'current'
  };
  let work = baseReceipt({ id: workId, createdAt: at, automation, configuration, inputSummary, blockers: summary.blockers });
  validate(resolvedRoot, work, 'soter/contracts/prepared-work.schema.json', 'Prepared work');
  writePreparedWorkState(resolvedRoot, work);
  if (summary.blockers.length) {
    work = assertPreparedWork(resolvedRoot, work);
    persistPreparedAutomationReviewMaterial({ root: resolvedRoot, work, automation, summary });
    return work;
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
    const module = await import(pathToFileURL(automation.modulePath).href);
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
