import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import {
  evaluateConfigurationDocument,
  fingerprintLock,
  resolveConfiguration,
  resolveConfigurationDocument
} from './resolve.mjs';
import {
  activeConfigurationLockStatePath,
  configurationChangeConfirmationStatePath,
  configurationChangeConsumptionStatePath,
  configurationChangePlanStatePath,
  configurationChangeRequestStatePath,
  configurationTransactionCheckpointStatePath,
  createConfigurationChangeConfirmationState,
  createConfigurationChangeConsumptionState,
  createConfigurationChangePlanState,
  createConfigurationChangeRequestState,
  createConfigurationTransactionCheckpointState,
  hasActiveConfigurationLockState,
  hasConfigurationChangeConfirmationState,
  hasConfigurationChangeConsumptionState,
  hasConfigurationChangePlanState,
  hasConfigurationChangeRequestState,
  hasConfigurationTransactionCheckpointState,
  readActiveConfigurationLockState,
  readConfigurationChangeConfirmationState,
  readConfigurationChangeConsumptionState,
  readConfigurationChangePlanState,
  readConfigurationChangeRequestState,
  readConfigurationTransactionCheckpointState,
  removeActiveConfigurationLockState,
  writeActiveConfigurationLockState,
  writeConfigurationChangeConsumptionState,
  writeConfigurationTransactionCheckpointState
} from './runtime-state.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = '1.0.0';
const CONTRACTS = {
  plan: ['soter://contracts/configuration-change-plan/v1', 'soter/contracts/configuration-change-plan.schema.json'],
  request: ['soter://contracts/configuration-change-request/v1', 'soter/contracts/configuration-change-request.schema.json'],
  confirmation: ['soter://contracts/configuration-change-confirmation/v1', 'soter/contracts/configuration-change-confirmation.schema.json'],
  consumption: ['soter://contracts/configuration-change-consumption/v1', 'soter/contracts/configuration-change-consumption.schema.json'],
  checkpoint: ['soter://contracts/configuration-transaction-checkpoint/v1', 'soter/contracts/configuration-transaction-checkpoint.schema.json'],
  inspection: ['soter://contracts/configuration-change-inspection/v1', 'soter/contracts/configuration-change-inspection.schema.json']
};

export class ConfigurationTransactionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigurationTransactionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ConfigurationTransactionError(code, message);
}

function clone(value) {
  return structuredClone(value);
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function unsignedFingerprint(value, property) {
  const unsigned = clone(value);
  delete unsigned[property];
  return fingerprintJson(unsigned);
}

function validate(root, value, kind, label) {
  const [contract, schemaPath] = CONTRACTS[kind];
  if (value?.$contract !== contract || value?.contractVersion !== VERSION) {
    fail('CONFIGURATION_' + kind.toUpperCase() + '_MALFORMED', label + ' contract identity is invalid.');
  }
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    fail(
      'CONFIGURATION_' + kind.toUpperCase() + '_MALFORMED',
      label + ' does not satisfy its contract: '
        + failures.slice(0, 6).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function assertFingerprint(root, value, kind, property, label) {
  validate(root, value, kind, label);
  if (value[property] !== unsignedFingerprint(value, property)) {
    fail('CONFIGURATION_' + kind.toUpperCase() + '_TAMPERED', label + ' fingerprint is stale or invalid.');
  }
  return value;
}

function walkJson(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJson(target);
    return entry.isFile() && entry.name.endsWith('.json') ? [target] : [];
  }).sort(compareText);
}

function findConfiguration(root, name) {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    fail('CONFIGURATION_NAME_INVALID', 'Configuration name is invalid.');
  }
  const matches = walkJson(path.join(root, 'soter', 'configurations')).filter((file) => {
    try {
      const value = readJson(file);
      return value.$contract === 'soter://contracts/configuration/v1' && value.name === name;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    fail('CONFIGURATION_NOT_FOUND', 'Expected exactly one desired configuration with the requested name.');
  }
  return matches[0];
}

function iso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('CONFIGURATION_TIME_INVALID', label + ' must be an ISO date-time string.');
  }
  return value;
}

function requireWindow(createdAt, expiresAt) {
  iso(createdAt, 'createdAt');
  iso(expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail('CONFIGURATION_REQUEST_WINDOW_INVALID', 'Configuration request expiry must be after creation.');
  }
}

function requireNotExpired(expiresAt, at) {
  iso(at, 'at');
  if (Date.parse(at) > Date.parse(expiresAt)) {
    fail('CONFIGURATION_REQUEST_EXPIRED', 'The exact configuration change request has expired.');
  }
}

function projectionFingerprint(lock) {
  return fingerprintJson(lock.projections.map((item) => ({
    path: item.path,
    role: item.role,
    fingerprint: item.fingerprint
  })));
}

function keyedRows(category, current, candidate, key, descriptor = key) {
  const before = new Map(current.map((item) => [key(item), item]));
  const after = new Map(candidate.map((item) => [key(item), item]));
  return [...new Set([...before.keys(), ...after.keys()])].sort(compareText).flatMap((subject) => {
    const left = before.get(subject);
    const right = after.get(subject);
    const beforeFingerprint = left === undefined ? null : fingerprintJson(left);
    const afterFingerprint = right === undefined ? null : fingerprintJson(right);
    if (beforeFingerprint === afterFingerprint) return [];
    return [{
      id: 'configuration-change.' + category + '.' + subject,
      category,
      subject,
      state: left === undefined ? 'added' : right === undefined ? 'removed' : 'changed',
      beforeDescriptor: left === undefined ? null : descriptor(left),
      afterDescriptor: right === undefined ? null : descriptor(right),
      beforeFingerprint,
      afterFingerprint
    }];
  });
}

function configurationChanges(current, candidate) {
  const changes = [];
  if (fingerprintJson(current.host) !== fingerprintJson(candidate.host)) {
    changes.push({
      id: 'configuration-change.host.adapter',
      category: 'host',
      subject: 'host.adapter',
      state: 'changed',
      beforeDescriptor: current.host.adapter,
      afterDescriptor: candidate.host.adapter,
      beforeFingerprint: fingerprintJson(current.host),
      afterFingerprint: fingerprintJson(candidate.host)
    });
  }
  changes.push(...keyedRows('pack', current.packs, candidate.packs, (item) => item.id));
  changes.push(...keyedRows(
    'binding',
    current.bindings,
    candidate.bindings,
    (item) => item.capability + '.' + item.providerPack
  ));
  changes.push(...keyedRows('source', current.sources, candidate.sources, (item) => item.id));
  changes.push(...keyedRows('authority', current.authorities, candidate.authorities, (item) => item.id));
  changes.push(...keyedRows('secret-reference', current.secretRefs, candidate.secretRefs, (item) => item.id));
  for (const effect of ['read', 'disclosure', 'write', 'dispatch', 'destructive']) {
    const left = current.effectPolicies[effect];
    const right = candidate.effectPolicies[effect];
    if (fingerprintJson(left) !== fingerprintJson(right)) {
      changes.push({
        id: 'configuration-change.effect-policy.' + effect,
        category: 'effect-policy',
        subject: 'effect.' + effect,
        state: 'changed',
        beforeDescriptor: left.mode,
        afterDescriptor: right.mode,
        beforeFingerprint: fingerprintJson(left),
        afterFingerprint: fingerprintJson(right)
      });
    }
  }
  const settingKeys = [...new Set([
    ...Object.keys(current.settings || {}),
    ...Object.keys(candidate.settings || {})
  ])].sort(compareText);
  for (const subject of settingKeys) {
    const left = current.settings?.[subject];
    const right = candidate.settings?.[subject];
    const beforeFingerprint = left === undefined ? null : fingerprintJson(left);
    const afterFingerprint = right === undefined ? null : fingerprintJson(right);
    if (beforeFingerprint === afterFingerprint) continue;
    changes.push({
      id: 'configuration-change.setting.' + subject,
      category: 'setting',
      subject,
      state: left === undefined ? 'added' : right === undefined ? 'removed' : 'changed',
      beforeDescriptor: left === undefined ? null : subject,
      afterDescriptor: right === undefined ? null : subject,
      beforeFingerprint,
      afterFingerprint
    });
  }
  return changes.sort((left, right) => compareText(left.id, right.id));
}

function assertCandidate(root, file, candidate, expectedName) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('CONFIGURATION_CANDIDATE_INVALID', 'Configuration candidate must be an object.');
  }
  if (candidate.$contract !== 'soter://contracts/configuration/v1'
    || candidate.contractVersion !== '1.0.0'
    || candidate.name !== expectedName) {
    fail('CONFIGURATION_CANDIDATE_INVALID', 'Candidate must replace the same named configuration/v1 document.');
  }
  const evaluated = evaluateConfigurationDocument({ root, configPath: file, configuration: candidate });
  if (evaluated.verification.health.valid !== 'passed' || !evaluated.lock) {
    const codes = evaluated.verification.violations
      .filter((item) => item.level !== 'warn')
      .map((item) => item.code)
      .slice(0, 8)
      .join(', ');
    fail('CONFIGURATION_CANDIDATE_INVALID', 'Candidate does not resolve through Kernel and Core' + (codes ? ': ' + codes : '.'));
  }
  return evaluated.lock;
}

function atomicWriteRepositoryJson(file, value) {
  const directory = path.dirname(file);
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  const mode = fs.statSync(file).mode & 0o777;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode || 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    try {
      const directoryDescriptor = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch {
      // Directory fsync is not available on every filesystem.
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function planCurrentness(root, plan) {
  const file = resolveRepoPath(root, plan.configuration.path);
  if (!fs.existsSync(file)) return { state: 'stale', reasonCode: 'CONFIGURATION_SOURCE_MISSING' };
  const observedDocumentFingerprint = fingerprintJson(readJson(file));
  let observedLockFingerprint = null;
  try {
    observedLockFingerprint = fingerprintLock(resolveConfiguration({ root, configPath: file }));
  } catch {
    return { state: 'stale', reasonCode: 'CONFIGURATION_CURRENT_RESOLUTION_INVALID' };
  }
  let observedActiveLockFingerprint = null;
  try {
    observedActiveLockFingerprint = hasActiveConfigurationLockState(root, plan.configuration.name)
      ? fingerprintLock(readActiveConfigurationLockState(root, plan.configuration.name).lock)
      : null;
  } catch {
    return { state: 'stale', reasonCode: 'CONFIGURATION_ACTIVE_LOCK_INVALID' };
  }
  if (observedDocumentFingerprint === plan.configuration.candidateDocumentFingerprint
    && observedLockFingerprint === plan.configuration.candidateLockFingerprint
    && observedActiveLockFingerprint === plan.configuration.candidateLockFingerprint) {
    return { state: 'applied', reasonCode: 'CONFIGURATION_CANDIDATE_APPLIED' };
  }
  if (observedDocumentFingerprint !== plan.configuration.currentDocumentFingerprint
    || observedLockFingerprint !== plan.configuration.currentLockFingerprint
    || observedActiveLockFingerprint !== plan.priorActiveLock.fingerprint) {
    return { state: 'stale', reasonCode: 'CONFIGURATION_PLAN_STALE' };
  }
  try {
    const candidateLock = resolveConfigurationDocument({
      root,
      configPath: file,
      configuration: plan.candidateConfiguration
    });
    if (fingerprintLock(candidateLock) !== plan.configuration.candidateLockFingerprint
      || candidateLock.graphFingerprint !== plan.configuration.candidateGraphFingerprint
      || projectionFingerprint(candidateLock) !== plan.configuration.projectionFingerprint) {
      return { state: 'stale', reasonCode: 'CONFIGURATION_CANDIDATE_STALE' };
    }
  } catch {
    return { state: 'stale', reasonCode: 'CONFIGURATION_CANDIDATE_STALE' };
  }
  return { state: 'current', reasonCode: 'CONFIGURATION_PLAN_CURRENT' };
}

function assertPlan(root, plan) {
  assertFingerprint(root, plan, 'plan', 'planFingerprint', 'Configuration change plan');
  if (fingerprintJson(plan.currentConfiguration) !== plan.configuration.currentDocumentFingerprint
    || fingerprintJson(plan.candidateConfiguration) !== plan.configuration.candidateDocumentFingerprint
    || fingerprintLock(plan.currentLock) !== plan.configuration.currentLockFingerprint
    || plan.currentLock.graphFingerprint !== plan.configuration.currentGraphFingerprint
    || fingerprintLock(plan.candidateLock) !== plan.configuration.candidateLockFingerprint
    || plan.candidateLock.graphFingerprint !== plan.configuration.candidateGraphFingerprint
    || projectionFingerprint(plan.candidateLock) !== plan.configuration.projectionFingerprint
    || fingerprintJson(plan.changes) !== plan.scopeFingerprint) {
    fail('CONFIGURATION_PLAN_TAMPERED', 'Configuration change plan exact bindings are invalid.');
  }
  if (plan.priorActiveLock.state === 'present'
    && fingerprintLock(plan.priorActiveLock.lock) !== plan.priorActiveLock.fingerprint) {
    fail('CONFIGURATION_PLAN_TAMPERED', 'Configuration change plan prior active lock is invalid.');
  }
  return plan;
}

function readPlan(root, planId) {
  try {
    return assertPlan(root, readConfigurationChangePlanState(root, planId).plan);
  } catch (error) {
    if (error instanceof ConfigurationTransactionError) throw error;
    fail('CONFIGURATION_PLAN_MISSING', 'Configuration change plan is unavailable.');
  }
}

function assertRequest(root, request) {
  assertFingerprint(root, request, 'request', 'requestFingerprint', 'Configuration change request');
  const plan = readPlan(root, request.plan.id);
  if (plan.planFingerprint !== request.plan.fingerprint
    || plan.scopeFingerprint !== request.scopeFingerprint
    || plan.configuration.name !== request.configuration.name
    || plan.configuration.path !== request.configuration.path
    || plan.configuration.currentLockFingerprint !== request.configuration.currentLockFingerprint
    || plan.configuration.candidateLockFingerprint !== request.configuration.candidateLockFingerprint
    || plan.configuration.candidateGraphFingerprint !== request.configuration.candidateGraphFingerprint) {
    fail('CONFIGURATION_REQUEST_BINDING_INVALID', 'Configuration change request does not bind its exact plan.');
  }
  requireWindow(request.createdAt, request.expiresAt);
  return { request, plan };
}

function readRequest(root, requestId) {
  try {
    return assertRequest(root, readConfigurationChangeRequestState(root, requestId).request);
  } catch (error) {
    if (error instanceof ConfigurationTransactionError) throw error;
    fail('CONFIGURATION_REQUEST_MISSING', 'Configuration change request is unavailable.');
  }
}

function assertConfirmation(root, confirmation) {
  assertFingerprint(
    root,
    confirmation,
    'confirmation',
    'confirmationFingerprint',
    'Configuration change confirmation'
  );
  const { request, plan } = readRequest(root, confirmation.request.id);
  if (request.requestFingerprint !== confirmation.request.fingerprint
    || plan.id !== confirmation.plan.id
    || plan.planFingerprint !== confirmation.plan.fingerprint
    || plan.scopeFingerprint !== confirmation.scopeFingerprint) {
    fail('CONFIGURATION_CONFIRMATION_BINDING_INVALID', 'Configuration confirmation does not bind its exact request and plan.');
  }
  requireNotExpired(request.expiresAt, confirmation.confirmedAt);
  return { confirmation, request, plan };
}

function readConfirmation(root, confirmationId) {
  try {
    return assertConfirmation(
      root,
      readConfigurationChangeConfirmationState(root, confirmationId).confirmation
    );
  } catch (error) {
    if (error instanceof ConfigurationTransactionError) throw error;
    fail('CONFIGURATION_CONFIRMATION_MISSING', 'Configuration change confirmation is unavailable.');
  }
}

function assertConsumption(root, consumption) {
  assertFingerprint(
    root,
    consumption,
    'consumption',
    'consumptionFingerprint',
    'Configuration change consumption'
  );
  const { confirmation, request, plan } = readConfirmation(root, consumption.confirmation.id);
  if (confirmation.confirmationFingerprint !== consumption.confirmation.fingerprint
    || request.id !== consumption.request.id
    || request.requestFingerprint !== consumption.request.fingerprint
    || plan.id !== consumption.plan.id
    || plan.planFingerprint !== consumption.plan.fingerprint
    || (consumption.state === 'reserved') !== (consumption.checkpointFingerprint === null)) {
    fail('CONFIGURATION_CONSUMPTION_BINDING_INVALID', 'Configuration consumption does not bind its exact authority chain.');
  }
  return { consumption, confirmation, request, plan };
}

function assertCheckpoint(root, checkpoint) {
  assertFingerprint(
    root,
    checkpoint,
    'checkpoint',
    'checkpointFingerprint',
    'Configuration transaction checkpoint'
  );
  const plan = readPlan(root, checkpoint.plan.id);
  const { request } = readRequest(root, checkpoint.request.id);
  const { confirmation } = readConfirmation(root, checkpoint.confirmation.id);
  const consumption = readConfigurationChangeConsumptionState(root, checkpoint.consumption.id).consumption;
  const reservedConsumption = seal({
    ...consumption,
    updatedAt: consumption.createdAt,
    state: 'reserved',
    checkpointFingerprint: null
  }, 'consumptionFingerprint');
  if (plan.planFingerprint !== checkpoint.plan.fingerprint
    || request.requestFingerprint !== checkpoint.request.fingerprint
    || confirmation.confirmationFingerprint !== checkpoint.confirmation.fingerprint
    || reservedConsumption.consumptionFingerprint !== checkpoint.consumption.fingerprint
    || consumption.checkpointId !== checkpoint.id
    || consumption.state !== 'started'
    || consumption.checkpointFingerprint === null
    || (checkpoint.state === 'prepared'
      && consumption.checkpointFingerprint !== checkpoint.checkpointFingerprint)) {
    fail('CONFIGURATION_CHECKPOINT_BINDING_INVALID', 'Configuration checkpoint does not bind its exact authority chain.');
  }
  return { checkpoint, plan, request, confirmation, consumption };
}

function seal(value, property) {
  value[property] = unsignedFingerprint(value, property);
  return value;
}

function persistCheckpoint(root, checkpoint) {
  checkpoint.updatedAt = checkpoint.updatedAt || checkpoint.createdAt;
  seal(checkpoint, 'checkpointFingerprint');
  validate(root, checkpoint, 'checkpoint', 'Configuration transaction checkpoint');
  writeConfigurationTransactionCheckpointState(root, checkpoint);
  return checkpoint;
}

function preparedCheckpoint({ plan, request, confirmation, consumption, checkpointId, at, observation }) {
  return seal({
    $contract: CONTRACTS.checkpoint[0],
    contractVersion: VERSION,
    id: checkpointId,
    createdAt: at,
    updatedAt: at,
    state: 'prepared',
    phase: 'prepared',
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    request: { id: request.id, fingerprint: request.requestFingerprint },
    confirmation: { id: confirmation.id, fingerprint: confirmation.confirmationFingerprint },
    consumption: { id: consumption.id, fingerprint: consumption.consumptionFingerprint },
    configuration: {
      name: plan.configuration.name,
      path: plan.configuration.path,
      activeLockPath: plan.configuration.activeLockPath,
      currentDocumentFingerprint: plan.configuration.currentDocumentFingerprint,
      candidateDocumentFingerprint: plan.configuration.candidateDocumentFingerprint,
      currentLockFingerprint: plan.configuration.currentLockFingerprint,
      candidateLockFingerprint: plan.configuration.candidateLockFingerprint
    },
    observation,
    failure: null,
    checkpointFingerprint: null
  }, 'checkpointFingerprint');
}

function assertPreparedCheckpointReservation(root, checkpoint, plan, request, confirmation, consumption) {
  assertFingerprint(
    root,
    checkpoint,
    'checkpoint',
    'checkpointFingerprint',
    'Prepared configuration transaction checkpoint'
  );
  if (checkpoint.state !== 'prepared'
    || checkpoint.phase !== 'prepared'
    || checkpoint.plan.id !== plan.id
    || checkpoint.plan.fingerprint !== plan.planFingerprint
    || checkpoint.request.id !== request.id
    || checkpoint.request.fingerprint !== request.requestFingerprint
    || checkpoint.confirmation.id !== confirmation.id
    || checkpoint.confirmation.fingerprint !== confirmation.confirmationFingerprint
    || checkpoint.consumption.id !== consumption.id
    || checkpoint.consumption.fingerprint !== consumption.consumptionFingerprint) {
    fail('CONFIGURATION_CHECKPOINT_BINDING_INVALID', 'Prepared checkpoint does not bind the exact reserved consumption.');
  }
  return checkpoint;
}

function startReservedExecution(root, { plan, request, confirmation, consumption, checkpointId, at }) {
  let checkpoint;
  if (hasConfigurationTransactionCheckpointState(root, checkpointId)) {
    checkpoint = assertPreparedCheckpointReservation(
      root,
      readConfigurationTransactionCheckpointState(root, checkpointId).checkpoint,
      plan,
      request,
      confirmation,
      consumption
    );
  } else {
    checkpoint = preparedCheckpoint({
      plan,
      request,
      confirmation,
      consumption,
      checkpointId,
      at,
      observation: observe(root, plan)
    });
    createConfigurationTransactionCheckpointState(root, checkpoint);
  }
  const started = seal({
    ...consumption,
    updatedAt: at,
    state: 'started',
    checkpointFingerprint: checkpoint.checkpointFingerprint
  }, 'consumptionFingerprint');
  writeConfigurationChangeConsumptionState(root, started);
  return { consumption: started, checkpoint };
}

function observe(root, plan) {
  const file = resolveRepoPath(root, plan.configuration.path);
  let resolutionFingerprint = null;
  try {
    resolutionFingerprint = fingerprintLock(resolveConfiguration({ root, configPath: file }));
  } catch {
    // A half-applied or externally edited configuration can be temporarily invalid.
  }
  return {
    documentFingerprint: fs.existsSync(file) ? fingerprintJson(readJson(file)) : null,
    activeLockFingerprint: hasActiveConfigurationLockState(root, plan.configuration.name)
      ? fingerprintLock(readActiveConfigurationLockState(root, plan.configuration.name).lock)
      : null,
    resolutionFingerprint
  };
}

function restorePrior(root, checkpoint, plan, at, reasonCode, summary) {
  checkpoint.state = 'rolling-back';
  checkpoint.phase = 'rollback-configuration';
  checkpoint.failure = { reasonCode, summary };
  checkpoint.updatedAt = at;
  persistCheckpoint(root, checkpoint);
  try {
    atomicWriteRepositoryJson(resolveRepoPath(root, plan.configuration.path), plan.currentConfiguration);
    checkpoint.phase = 'rollback-active-lock';
    checkpoint.observation = observe(root, plan);
    persistCheckpoint(root, checkpoint);
    if (plan.priorActiveLock.state === 'present') {
      writeActiveConfigurationLockState(root, plan.configuration.name, plan.priorActiveLock.lock);
    } else {
      removeActiveConfigurationLockState(root, plan.configuration.name);
    }
    const restored = observe(root, plan);
    const expectedActive = plan.priorActiveLock.fingerprint;
    if (restored.documentFingerprint !== plan.configuration.currentDocumentFingerprint
      || restored.resolutionFingerprint !== plan.configuration.currentLockFingerprint
      || restored.activeLockFingerprint !== expectedActive) {
      fail('CONFIGURATION_ROLLBACK_VERIFICATION_FAILED', 'Configuration rollback could not establish the exact prior state.');
    }
    checkpoint.state = 'rolled-back';
    checkpoint.phase = 'terminal';
    checkpoint.observation = restored;
    checkpoint.updatedAt = at;
    persistCheckpoint(root, checkpoint);
    return checkpoint;
  } catch (error) {
    checkpoint.state = 'needs-attention';
    checkpoint.phase = 'terminal';
    checkpoint.observation = observe(root, plan);
    checkpoint.failure = {
      reasonCode: 'CONFIGURATION_ROLLBACK_FAILED',
      summary: 'The exact prior configuration state could not be restored automatically.'
    };
    checkpoint.updatedAt = at;
    persistCheckpoint(root, checkpoint);
    if (error instanceof ConfigurationTransactionError) throw error;
    fail('CONFIGURATION_ROLLBACK_FAILED', 'The exact prior configuration state could not be restored automatically.');
  }
}

export function prepareConfigurationChange({
  root = DEFAULT_ROOT,
  name,
  candidateConfiguration,
  id,
  createdAt
} = {}) {
  const resolvedRoot = path.resolve(root);
  iso(createdAt, 'createdAt');
  const file = findConfiguration(resolvedRoot, name);
  const candidate = clone(candidateConfiguration);
  if (hasConfigurationChangePlanState(resolvedRoot, id)) {
    const existing = readPlan(resolvedRoot, id);
    if (existing.createdAt !== createdAt
      || existing.configuration.name !== name
      || existing.configuration.path !== repoRelativePath(resolvedRoot, file)
      || existing.configuration.candidateDocumentFingerprint !== fingerprintJson(candidate)) {
      fail('CONFIGURATION_PLAN_CONFLICT', 'Configuration change plan ID already binds different exact content.');
    }
    return { plan: existing, planPath: repoRelativePath(resolvedRoot, configurationChangePlanStatePath(resolvedRoot, id)) };
  }
  const currentConfiguration = readJson(file);
  const currentLock = resolveConfiguration({ root: resolvedRoot, configPath: file });
  const candidateLock = assertCandidate(resolvedRoot, file, candidate, currentConfiguration.name);
  const changes = configurationChanges(currentConfiguration, candidate);
  if (!changes.length) fail('CONFIGURATION_CHANGE_EMPTY', 'Candidate resolves from an unchanged desired configuration.');
  const activeLockPath = activeConfigurationLockStatePath(resolvedRoot, name);
  const priorActiveLock = fs.existsSync(activeLockPath)
    ? (() => {
        const lock = readJson(activeLockPath);
        return { state: 'present', fingerprint: fingerprintLock(lock), lock };
      })()
    : { state: 'absent', fingerprint: null, lock: null };
  if (priorActiveLock.state === 'present'
    && priorActiveLock.fingerprint !== fingerprintLock(currentLock)) {
    fail(
      'CONFIGURATION_ACTIVE_LOCK_STALE',
      'The private active lock does not match the current desired configuration resolution.'
    );
  }
  const plan = seal({
    $contract: CONTRACTS.plan[0],
    contractVersion: VERSION,
    id,
    createdAt,
    configuration: {
      name,
      path: repoRelativePath(resolvedRoot, file),
      activeLockPath: repoRelativePath(resolvedRoot, activeLockPath),
      currentDocumentFingerprint: fingerprintJson(currentConfiguration),
      currentLockFingerprint: fingerprintLock(currentLock),
      currentGraphFingerprint: currentLock.graphFingerprint,
      candidateDocumentFingerprint: fingerprintJson(candidate),
      candidateLockFingerprint: fingerprintLock(candidateLock),
      candidateGraphFingerprint: candidateLock.graphFingerprint,
      projectionFingerprint: projectionFingerprint(candidateLock)
    },
    currentConfiguration,
    candidateConfiguration: candidate,
    currentLock,
    candidateLock,
    priorActiveLock,
    changes,
    scopeFingerprint: fingerprintJson(changes),
    planFingerprint: null
  }, 'planFingerprint');
  assertPlan(resolvedRoot, plan);
  if (hasConfigurationChangePlanState(resolvedRoot, id)) {
    const existing = readPlan(resolvedRoot, id);
    if (existing.planFingerprint !== plan.planFingerprint) {
      fail('CONFIGURATION_PLAN_CONFLICT', 'Configuration change plan ID already binds different exact content.');
    }
    return { plan: existing, planPath: repoRelativePath(resolvedRoot, configurationChangePlanStatePath(resolvedRoot, id)) };
  }
  const persisted = createConfigurationChangePlanState(resolvedRoot, plan);
  return { plan, planPath: persisted.path };
}

export function beginConfigurationChangeRequest({
  root = DEFAULT_ROOT,
  planId,
  id,
  reason,
  createdAt,
  expiresAt
} = {}) {
  const resolvedRoot = path.resolve(root);
  requireWindow(createdAt, expiresAt);
  const plan = readPlan(resolvedRoot, planId);
  const request = seal({
    $contract: CONTRACTS.request[0],
    contractVersion: VERSION,
    id,
    createdAt,
    expiresAt,
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    configuration: {
      name: plan.configuration.name,
      path: plan.configuration.path,
      currentLockFingerprint: plan.configuration.currentLockFingerprint,
      candidateLockFingerprint: plan.configuration.candidateLockFingerprint,
      candidateGraphFingerprint: plan.configuration.candidateGraphFingerprint
    },
    scopeFingerprint: plan.scopeFingerprint,
    reason,
    requestFingerprint: null
  }, 'requestFingerprint');
  assertRequest(resolvedRoot, request);
  if (hasConfigurationChangeRequestState(resolvedRoot, id)) {
    const existing = readRequest(resolvedRoot, id).request;
    if (existing.requestFingerprint !== request.requestFingerprint) {
      fail('CONFIGURATION_REQUEST_CONFLICT', 'Configuration request ID already binds different exact content.');
    }
    return { request: existing, requestPath: repoRelativePath(resolvedRoot, configurationChangeRequestStatePath(resolvedRoot, id)) };
  }
  if (planCurrentness(resolvedRoot, plan).state !== 'current') {
    fail('CONFIGURATION_PLAN_STALE', 'Configuration request requires an exact current plan.');
  }
  const persisted = createConfigurationChangeRequestState(resolvedRoot, request);
  return { request, requestPath: persisted.path };
}

export function confirmConfigurationChangeRequest({
  root = DEFAULT_ROOT,
  requestId,
  id,
  actor,
  reason,
  confirmedAt
} = {}) {
  const resolvedRoot = path.resolve(root);
  const { request, plan } = readRequest(resolvedRoot, requestId);
  requireNotExpired(request.expiresAt, confirmedAt);
  const confirmation = seal({
    $contract: CONTRACTS.confirmation[0],
    contractVersion: VERSION,
    id,
    confirmedAt,
    actor: clone(actor),
    reason,
    request: { id: request.id, fingerprint: request.requestFingerprint },
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    scopeFingerprint: plan.scopeFingerprint,
    confirmationFingerprint: null
  }, 'confirmationFingerprint');
  assertConfirmation(resolvedRoot, confirmation);
  if (hasConfigurationChangeConfirmationState(resolvedRoot, id)) {
    const existing = readConfirmation(resolvedRoot, id).confirmation;
    if (existing.confirmationFingerprint !== confirmation.confirmationFingerprint) {
      fail('CONFIGURATION_CONFIRMATION_CONFLICT', 'Configuration confirmation ID already binds different exact content.');
    }
    return {
      confirmation: existing,
      confirmationPath: repoRelativePath(resolvedRoot, configurationChangeConfirmationStatePath(resolvedRoot, id))
    };
  }
  if (planCurrentness(resolvedRoot, plan).state !== 'current') {
    fail('CONFIGURATION_PLAN_STALE', 'Configuration confirmation requires the exact plan to remain current.');
  }
  const persisted = createConfigurationChangeConfirmationState(resolvedRoot, confirmation);
  return { confirmation, confirmationPath: persisted.path };
}

export function configurationChangeConsumptionId(confirmationId) {
  const prefix = 'configuration-change-confirmation.';
  if (typeof confirmationId !== 'string' || !confirmationId.startsWith(prefix)) {
    fail('CONFIGURATION_CONFIRMATION_ID_INVALID', 'Configuration confirmation ID is invalid.');
  }
  return 'configuration-change-consumption.' + confirmationId.slice(prefix.length);
}

export function prepareConfigurationChangeExecution({
  root = DEFAULT_ROOT,
  confirmationId,
  checkpointId,
  at
} = {}) {
  const resolvedRoot = path.resolve(root);
  const { confirmation, request, plan } = readConfirmation(resolvedRoot, confirmationId);
  const consumptionId = configurationChangeConsumptionId(confirmation.id);
  if (hasConfigurationChangeConsumptionState(resolvedRoot, consumptionId)) {
    const existingResult = assertConsumption(
      resolvedRoot,
      readConfigurationChangeConsumptionState(resolvedRoot, consumptionId).consumption
    );
    const existing = existingResult.consumption;
    if (existing.checkpointId !== checkpointId) {
      fail('CONFIGURATION_CONFIRMATION_ALREADY_CONSUMED', 'Configuration confirmation was already consumed by another checkpoint.');
    }
    const resumed = existing.state === 'reserved'
      ? startReservedExecution(resolvedRoot, {
          plan: existingResult.plan,
          request: existingResult.request,
          confirmation: existingResult.confirmation,
          consumption: existing,
          checkpointId,
          at
        })
      : {
          consumption: existing,
          checkpoint: assertCheckpoint(
            resolvedRoot,
            readConfigurationTransactionCheckpointState(resolvedRoot, checkpointId).checkpoint
          ).checkpoint
        };
    return {
      consumption: resumed.consumption,
      consumptionPath: repoRelativePath(resolvedRoot, configurationChangeConsumptionStatePath(resolvedRoot, consumptionId)),
      checkpoint: resumed.checkpoint,
      checkpointPath: repoRelativePath(resolvedRoot, configurationTransactionCheckpointStatePath(resolvedRoot, checkpointId))
    };
  }
  requireNotExpired(request.expiresAt, at);
  if (planCurrentness(resolvedRoot, plan).state !== 'current') {
    fail('CONFIGURATION_PLAN_STALE', 'Configuration execution requires the exact plan to remain current.');
  }
  if (hasConfigurationTransactionCheckpointState(resolvedRoot, checkpointId)) {
    fail('CONFIGURATION_CHECKPOINT_CONFLICT', 'Configuration checkpoint ID already exists.');
  }
  let consumption = seal({
    $contract: CONTRACTS.consumption[0],
    contractVersion: VERSION,
    id: consumptionId,
    createdAt: at,
    updatedAt: at,
    state: 'reserved',
    confirmation: { id: confirmation.id, fingerprint: confirmation.confirmationFingerprint },
    request: { id: request.id, fingerprint: request.requestFingerprint },
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    checkpointId,
    checkpointFingerprint: null,
    consumptionFingerprint: null
  }, 'consumptionFingerprint');
  assertConsumption(resolvedRoot, consumption);
  createConfigurationChangeConsumptionState(resolvedRoot, consumption);
  const started = startReservedExecution(resolvedRoot, {
    plan,
    request,
    confirmation,
    consumption,
    checkpointId,
    at
  });
  consumption = started.consumption;
  const checkpoint = started.checkpoint;
  return {
    consumption,
    consumptionPath: repoRelativePath(resolvedRoot, configurationChangeConsumptionStatePath(resolvedRoot, consumption.id)),
    checkpoint,
    checkpointPath: repoRelativePath(resolvedRoot, configurationTransactionCheckpointStatePath(resolvedRoot, checkpoint.id))
  };
}

export function executeConfigurationChange({ root = DEFAULT_ROOT, checkpointId, at } = {}) {
  const resolvedRoot = path.resolve(root);
  iso(at, 'at');
  const loaded = readConfigurationTransactionCheckpointState(resolvedRoot, checkpointId).checkpoint;
  const { checkpoint, plan } = assertCheckpoint(resolvedRoot, loaded);
  if (checkpoint.state === 'completed' || checkpoint.state === 'rolled-back') return checkpoint;
  if (checkpoint.state !== 'prepared') {
    fail('CONFIGURATION_CHECKPOINT_NOT_EXECUTABLE', 'Configuration checkpoint must be recovered before execution.');
  }
  if (planCurrentness(resolvedRoot, plan).state !== 'current') {
    fail('CONFIGURATION_PLAN_STALE', 'Configuration execution checkpoint is no longer current.');
  }
  try {
    checkpoint.state = 'applying';
    checkpoint.updatedAt = at;
    persistCheckpoint(resolvedRoot, checkpoint);
    atomicWriteRepositoryJson(resolveRepoPath(resolvedRoot, plan.configuration.path), plan.candidateConfiguration);
    checkpoint.phase = 'configuration-written';
    checkpoint.observation = observe(resolvedRoot, plan);
    persistCheckpoint(resolvedRoot, checkpoint);
    writeActiveConfigurationLockState(resolvedRoot, plan.configuration.name, plan.candidateLock);
    checkpoint.phase = 'active-lock-written';
    checkpoint.observation = observe(resolvedRoot, plan);
    persistCheckpoint(resolvedRoot, checkpoint);
    checkpoint.state = 'verifying';
    checkpoint.phase = 'verifying';
    checkpoint.observation = observe(resolvedRoot, plan);
    persistCheckpoint(resolvedRoot, checkpoint);
    if (checkpoint.observation.documentFingerprint !== plan.configuration.candidateDocumentFingerprint
      || checkpoint.observation.activeLockFingerprint !== plan.configuration.candidateLockFingerprint
      || checkpoint.observation.resolutionFingerprint !== plan.configuration.candidateLockFingerprint) {
      fail('CONFIGURATION_APPLY_VERIFICATION_FAILED', 'Applied configuration did not reproduce the exact candidate lock.');
    }
    checkpoint.state = 'completed';
    checkpoint.phase = 'terminal';
    checkpoint.failure = null;
    checkpoint.updatedAt = at;
    persistCheckpoint(resolvedRoot, checkpoint);
    return checkpoint;
  } catch (error) {
    const code = error instanceof ConfigurationTransactionError
      ? error.code
      : 'CONFIGURATION_APPLY_FAILED';
    return restorePrior(
      resolvedRoot,
      checkpoint,
      plan,
      at,
      code,
      'The exact configuration change could not be applied and was rolled back.'
    );
  }
}

export function recoverConfigurationChange({ root = DEFAULT_ROOT, checkpointId, at } = {}) {
  const resolvedRoot = path.resolve(root);
  iso(at, 'at');
  const loaded = readConfigurationTransactionCheckpointState(resolvedRoot, checkpointId).checkpoint;
  const { checkpoint, plan } = assertCheckpoint(resolvedRoot, loaded);
  if (checkpoint.state === 'completed' || checkpoint.state === 'rolled-back' || checkpoint.state === 'needs-attention') {
    return checkpoint;
  }
  const observed = observe(resolvedRoot, plan);
  const candidateDocument = observed.documentFingerprint === plan.configuration.candidateDocumentFingerprint;
  const candidateLock = observed.activeLockFingerprint === plan.configuration.candidateLockFingerprint;
  if (candidateDocument && candidateLock && observed.resolutionFingerprint === plan.configuration.candidateLockFingerprint) {
    checkpoint.state = 'completed';
    checkpoint.phase = 'terminal';
    checkpoint.observation = observed;
    checkpoint.failure = null;
    checkpoint.updatedAt = at;
    persistCheckpoint(resolvedRoot, checkpoint);
    return checkpoint;
  }
  if (candidateDocument && !candidateLock) {
    try {
      writeActiveConfigurationLockState(resolvedRoot, plan.configuration.name, plan.candidateLock);
      checkpoint.state = 'verifying';
      checkpoint.phase = 'verifying';
      checkpoint.observation = observe(resolvedRoot, plan);
      checkpoint.updatedAt = at;
      persistCheckpoint(resolvedRoot, checkpoint);
      if (checkpoint.observation.activeLockFingerprint === plan.configuration.candidateLockFingerprint
        && checkpoint.observation.resolutionFingerprint === plan.configuration.candidateLockFingerprint) {
        checkpoint.state = 'completed';
        checkpoint.phase = 'terminal';
        persistCheckpoint(resolvedRoot, checkpoint);
        return checkpoint;
      }
    } catch {
      // The exact prior state below is the safe fallback.
    }
  }
  if (observed.documentFingerprint === plan.configuration.currentDocumentFingerprint
    && observed.resolutionFingerprint === plan.configuration.currentLockFingerprint
    && observed.activeLockFingerprint === plan.priorActiveLock.fingerprint
    && checkpoint.state === 'prepared') {
    return executeConfigurationChange({ root: resolvedRoot, checkpointId, at });
  }
  return restorePrior(
    resolvedRoot,
    checkpoint,
    plan,
    at,
    'CONFIGURATION_RECOVERY_ROLLBACK',
    'Recovery found a partial or unknown local apply state and restored the exact prior configuration.'
  );
}

function optionalDocument(root, id, has, read, property, assert) {
  if (!id) return null;
  if (!has(root, id)) {
    fail('CONFIGURATION_INSPECTION_REFERENCE_MISSING', 'A requested configuration transaction reference is unavailable.');
  }
  const value = read(root, id)[property];
  return assert(value);
}

export function inspectConfigurationChange({
  root = DEFAULT_ROOT,
  planId,
  requestId = null,
  confirmationId = null,
  consumptionId = null,
  checkpointId = null,
  at
} = {}) {
  const resolvedRoot = path.resolve(root);
  iso(at, 'at');
  const plan = readPlan(resolvedRoot, planId);
  const applicability = planCurrentness(resolvedRoot, plan);
  let request = optionalDocument(
    resolvedRoot,
    requestId,
    hasConfigurationChangeRequestState,
    readConfigurationChangeRequestState,
    'request',
    (value) => assertRequest(resolvedRoot, value).request
  );
  let confirmation = optionalDocument(
    resolvedRoot,
    confirmationId,
    hasConfigurationChangeConfirmationState,
    readConfigurationChangeConfirmationState,
    'confirmation',
    (value) => assertConfirmation(resolvedRoot, value).confirmation
  );
  let consumption = optionalDocument(
    resolvedRoot,
    consumptionId,
    hasConfigurationChangeConsumptionState,
    readConfigurationChangeConsumptionState,
    'consumption',
    (value) => assertConsumption(resolvedRoot, value).consumption
  );
  let checkpoint = optionalDocument(
    resolvedRoot,
    checkpointId,
    hasConfigurationTransactionCheckpointState,
    readConfigurationTransactionCheckpointState,
    'checkpoint',
    (value) => assertCheckpoint(resolvedRoot, value).checkpoint
  );
  if (!consumption && checkpoint) {
    consumption = assertConsumption(
      resolvedRoot,
      readConfigurationChangeConsumptionState(resolvedRoot, checkpoint.consumption.id).consumption
    ).consumption;
  }
  if (!consumption && confirmation) {
    const deterministicConsumptionId = configurationChangeConsumptionId(confirmation.id);
    if (hasConfigurationChangeConsumptionState(resolvedRoot, deterministicConsumptionId)) {
      consumption = assertConsumption(
        resolvedRoot,
        readConfigurationChangeConsumptionState(resolvedRoot, deterministicConsumptionId).consumption
      ).consumption;
    }
  }
  if (!confirmation && (checkpoint || consumption)) {
    const id = checkpoint?.confirmation.id || consumption.confirmation.id;
    confirmation = assertConfirmation(
      resolvedRoot,
      readConfigurationChangeConfirmationState(resolvedRoot, id).confirmation
    ).confirmation;
  }
  if (!checkpoint && consumption?.state === 'started'
    && hasConfigurationTransactionCheckpointState(resolvedRoot, consumption.checkpointId)) {
    checkpoint = assertCheckpoint(
      resolvedRoot,
      readConfigurationTransactionCheckpointState(resolvedRoot, consumption.checkpointId).checkpoint
    ).checkpoint;
  }
  if (!request && (checkpoint || consumption || confirmation)) {
    const id = checkpoint?.request.id || consumption?.request.id || confirmation.request.id;
    request = assertRequest(
      resolvedRoot,
      readConfigurationChangeRequestState(resolvedRoot, id).request
    ).request;
  }
  if ((request && request.plan.id !== plan.id)
    || (confirmation && confirmation.plan.id !== plan.id)
    || (consumption && consumption.plan.id !== plan.id)
    || (checkpoint && checkpoint.plan.id !== plan.id)
    || (confirmation && request && confirmation.request.id !== request.id)
    || (consumption && request && consumption.request.id !== request.id)
    || (consumption && confirmation && consumption.confirmation.id !== confirmation.id)
    || (checkpoint && request && checkpoint.request.id !== request.id)
    || (checkpoint && confirmation && checkpoint.confirmation.id !== confirmation.id)
    || (checkpoint && consumption && checkpoint.consumption.id !== consumption.id)) {
    fail('CONFIGURATION_INSPECTION_BINDING_INVALID', 'Inspection references do not belong to the selected exact plan.');
  }
  let resume;
  if (checkpoint?.state === 'completed' || checkpoint?.state === 'rolled-back') {
    resume = {
      classification: 'unavailable',
      reasonCode: checkpoint.state === 'completed' ? 'CONFIGURATION_APPLY_COMPLETED' : 'CONFIGURATION_APPLY_ROLLED_BACK',
      reason: checkpoint.state === 'completed'
        ? 'The exact configuration transaction is complete.'
        : 'The exact configuration transaction was rolled back.',
      permittedNextAction: 'none'
    };
  } else if (checkpoint) {
    resume = {
      classification: checkpoint.state === 'needs-attention' ? 'requires-review' : 'safe',
      reasonCode: checkpoint.failure?.reasonCode || 'CONFIGURATION_CHECKPOINT_RECOVERABLE',
      reason: checkpoint.failure?.summary || 'Core can inspect and reconcile the exact durable configuration checkpoint.',
      permittedNextAction: 'inspect-checkpoint'
    };
  } else if (confirmation && applicability.state === 'current') {
    resume = {
      classification: 'safe',
      reasonCode: 'CONFIGURATION_CONFIRMATION_CURRENT',
      reason: 'The exact confirmation is current and has not been consumed.',
      permittedNextAction: 'apply'
    };
  } else if (request && !confirmation && applicability.state === 'current') {
    const expired = Date.parse(at) > Date.parse(request.expiresAt);
    resume = {
      classification: expired ? 'unavailable' : 'safe',
      reasonCode: expired ? 'CONFIGURATION_REQUEST_EXPIRED' : 'CONFIGURATION_REQUEST_AWAITING_CONFIRMATION',
      reason: expired
        ? 'The exact configuration request expired and cannot be confirmed.'
        : 'The exact configuration request is awaiting local operator confirmation.',
      permittedNextAction: expired ? 'request-confirmation' : 'confirm'
    };
  } else if (applicability.state === 'current') {
    resume = {
      classification: 'safe',
      reasonCode: 'CONFIGURATION_PLAN_CURRENT',
      reason: 'The exact configuration plan is current and may be submitted for confirmation.',
      permittedNextAction: 'request-confirmation'
    };
  } else {
    resume = {
      classification: 'unavailable',
      reasonCode: applicability.reasonCode,
      reason: 'The exact configuration plan no longer matches the current workspace state.',
      permittedNextAction: 'none'
    };
  }
  const requestState = request
    ? confirmation
      ? 'confirmed'
      : Date.parse(at) > Date.parse(request.expiresAt) ? 'expired' : 'awaiting'
    : null;
  const inspection = {
    $contract: CONTRACTS.inspection[0],
    contractVersion: VERSION,
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    configuration: {
      name: plan.configuration.name,
      path: plan.configuration.path,
      baselineLockFingerprint: plan.configuration.currentLockFingerprint,
      candidateLockFingerprint: plan.configuration.candidateLockFingerprint,
      candidateGraphFingerprint: plan.configuration.candidateGraphFingerprint,
      observedLockFingerprint: observe(resolvedRoot, plan).resolutionFingerprint,
      applicability: applicability.state
    },
    scope: { fingerprint: plan.scopeFingerprint, changes: clone(plan.changes) },
    request: request ? {
      id: request.id,
      fingerprint: request.requestFingerprint,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      state: requestState
    } : null,
    confirmation: confirmation ? {
      id: confirmation.id,
      fingerprint: confirmation.confirmationFingerprint,
      confirmedAt: confirmation.confirmedAt,
      actor: confirmation.actor.id
    } : null,
    consumption: consumption ? {
      id: consumption.id,
      fingerprint: consumption.consumptionFingerprint,
      state: consumption.state
    } : null,
    checkpoint: checkpoint ? {
      id: checkpoint.id,
      fingerprint: checkpoint.checkpointFingerprint,
      state: checkpoint.state,
      phase: checkpoint.phase,
      updatedAt: checkpoint.updatedAt,
      reasonCode: checkpoint.failure?.reasonCode || null
    } : null,
    resume,
    authority: { kind: 'inspection-only', grantsExecution: false, grantsProviderWrite: false }
  };
  validate(resolvedRoot, inspection, 'inspection', 'Configuration change inspection');
  return inspection;
}

export function configurationTransactionStatePaths(root = DEFAULT_ROOT, ids = {}) {
  const resolvedRoot = path.resolve(root);
  return {
    plan: ids.planId ? repoRelativePath(resolvedRoot, configurationChangePlanStatePath(resolvedRoot, ids.planId)) : null,
    request: ids.requestId ? repoRelativePath(resolvedRoot, configurationChangeRequestStatePath(resolvedRoot, ids.requestId)) : null,
    confirmation: ids.confirmationId
      ? repoRelativePath(resolvedRoot, configurationChangeConfirmationStatePath(resolvedRoot, ids.confirmationId))
      : null,
    consumption: ids.consumptionId
      ? repoRelativePath(resolvedRoot, configurationChangeConsumptionStatePath(resolvedRoot, ids.consumptionId))
      : null,
    checkpoint: ids.checkpointId
      ? repoRelativePath(resolvedRoot, configurationTransactionCheckpointStatePath(resolvedRoot, ids.checkpointId))
      : null
  };
}
