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
  findConfigurationTemplate,
  fingerprintLock,
  resolveConfiguration,
  resolveConfigurationDocument
} from './resolve.mjs';
import {
  hasPrivateConfigurationState,
  privateConfigurationStatePath,
  readPrivateConfigurationState,
  removePrivateConfigurationState,
  writePrivateConfigurationState
} from './private-configurations.mjs';
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

function findConfiguration(root, name) {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    fail('CONFIGURATION_NAME_INVALID', 'Configuration name is invalid.');
  }
  try {
    return findConfigurationTemplate(root, name);
  } catch {
    fail('CONFIGURATION_NOT_FOUND', 'Expected exactly one portable configuration template with the requested name.');
  }
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

function occursBefore(value, lowerBound) {
  return Date.parse(value) < Date.parse(lowerBound);
}

function occursAfter(value, upperBound) {
  return Date.parse(value) > Date.parse(upperBound);
}

function projectionFingerprint(lock) {
  return fingerprintJson(lock.projections.map((item) => ({
    path: item.path,
    role: item.role,
    fingerprint: item.fingerprint
  })));
}

function targetIdentity(root) {
  const requestedPath = path.resolve(root);
  const requestedStat = fs.lstatSync(requestedPath, { throwIfNoEntry: false });
  if (!requestedStat?.isDirectory() || requestedStat.isSymbolicLink()) {
    fail('CONFIGURATION_TARGET_INVALID', 'Configuration target root must be one ordinary directory.');
  }
  const realPath = fs.realpathSync(requestedPath);
  if (realPath !== requestedPath) {
    fail('CONFIGURATION_TARGET_INVALID', 'Configuration target root cannot contain symbolic-link traversal.');
  }
  const stat = fs.statSync(realPath);
  const identity = {
    requestedPath,
    realPath,
    device: Number(stat.dev),
    inode: Number(stat.ino)
  };
  return { ...identity, fingerprint: fingerprintJson(identity) };
}

function assertTargetIdentity(root, expected) {
  if (fingerprintJson(targetIdentity(root)) !== fingerprintJson(expected)) {
    fail('CONFIGURATION_TARGET_DRIFT', 'Configuration target root identity changed after planning.');
  }
}

function hasDuplicateSubjects(items, key) {
  const observed = new Set();
  for (const item of items) {
    const subject = key(item);
    if (observed.has(subject)) return true;
    observed.add(subject);
  }
  return false;
}

function assertHistoricalActiveLock(root, lock, {
  name,
  desiredStatePath,
  configurationFingerprint
}) {
  let failures;
  try {
    failures = validateJsonSchema(
      lock,
      readJson(path.join(root, 'soter/contracts/lock.schema.json'))
    );
  } catch {
    fail(
      'CONFIGURATION_ACTIVE_LOCK_STALE',
      'Private active lock contract is unavailable or invalid.'
    );
  }
  if (failures.length || !lock || typeof lock !== 'object' || Array.isArray(lock)) {
    fail(
      'CONFIGURATION_ACTIVE_LOCK_STALE',
      'Private active lock does not satisfy the governed lock contract.'
    );
  }
  const unsigned = clone(lock);
  delete unsigned.graphFingerprint;
  if (lock.graphFingerprint !== fingerprintJson(unsigned)
    || lock.configuration.name !== name
    || lock.configuration.path !== desiredStatePath
    || lock.configuration.fingerprint !== configurationFingerprint
    || hasDuplicateSubjects(lock.packs, (item) => item.id)
    || hasDuplicateSubjects(lock.dependencies, (item) => item.from + '\u0000' + item.to)
    || hasDuplicateSubjects(lock.capabilities, (item) => item.id)
    || hasDuplicateSubjects(
      lock.bindings,
      (item) => item.capability + '\u0000' + item.providerPack
    )
    || hasDuplicateSubjects(lock.sources, (item) => item.id)
    || hasDuplicateSubjects(lock.authorities, (item) => item.id)
    || hasDuplicateSubjects(lock.projections, (item) => item.id)) {
    fail(
      'CONFIGURATION_ACTIVE_LOCK_STALE',
      'Private active lock does not bind the exact private desired configuration.'
    );
  }
  return lock;
}

function keyedRows(category, current, candidate, key, descriptor = key) {
  if (hasDuplicateSubjects(current, key) || hasDuplicateSubjects(candidate, key)) {
    fail(
      'CONFIGURATION_CHANGE_SCOPE_INVALID',
      'Configuration change scope contains duplicate semantic subjects.'
    );
  }
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

function resolvedLockChanges(current, candidate) {
  const changes = [];
  changes.push(...keyedRows(
    'resolution',
    [current.resolver],
    [candidate.resolver],
    () => 'resolver'
  ));
  changes.push(...keyedRows(
    'resolution',
    [current.host],
    [candidate.host],
    () => 'host.adapter'
  ));
  changes.push(...keyedRows(
    'resolution',
    current.packs,
    candidate.packs,
    (item) => 'pack.' + item.id
  ));
  changes.push(...keyedRows(
    'resolution',
    current.dependencies,
    candidate.dependencies,
    (item) => 'dependency.' + item.from + '.' + item.to
  ));
  changes.push(...keyedRows(
    'resolution',
    current.capabilities,
    candidate.capabilities,
    (item) => 'capability.' + item.id
  ));
  changes.push(...keyedRows(
    'resolution',
    current.bindings,
    candidate.bindings,
    (item) => 'binding.' + item.capability + '.' + item.providerPack
  ));
  changes.push(...keyedRows(
    'resolution',
    current.sources,
    candidate.sources,
    (item) => 'source.' + item.id
  ));
  changes.push(...keyedRows(
    'resolution',
    current.authorities,
    candidate.authorities,
    (item) => 'authority.' + item.id
  ));
  changes.push(...keyedRows(
    'resolution',
    Object.entries(current.effectPolicies).map(([id, value]) => ({ id, value })),
    Object.entries(candidate.effectPolicies).map(([id, value]) => ({ id, value })),
    (item) => 'effect-policy.' + item.id
  ));
  changes.push(...keyedRows(
    'resolution',
    Object.entries(current.settings || {}).map(([id, value]) => ({ id, value })),
    Object.entries(candidate.settings || {}).map(([id, value]) => ({ id, value })),
    (item) => 'setting.' + item.id
  ));
  changes.push(...keyedRows(
    'resolution',
    current.projections,
    candidate.projections,
    (item) => 'projection.' + item.id
  ));
  return changes.sort((left, right) => compareText(left.id, right.id));
}

function configurationPlanChanges({
  currentConfiguration,
  candidateConfiguration,
  currentLock,
  candidateLock,
  priorActiveLock
}) {
  const changes = configurationChanges(currentConfiguration, candidateConfiguration);
  if (priorActiveLock.state === 'absent') {
    changes.push({
      id: 'configuration-change.lock.active',
      category: 'lock',
      subject: 'active-lock',
      state: 'added',
      beforeDescriptor: null,
      afterDescriptor: 'candidate-active-lock',
      beforeFingerprint: null,
      afterFingerprint: fingerprintLock(candidateLock)
    });
  } else if (priorActiveLock.fingerprint !== fingerprintLock(candidateLock)) {
    changes.push(...resolvedLockChanges(priorActiveLock.lock, candidateLock));
    changes.push({
      id: 'configuration-change.lock.active',
      category: 'lock',
      subject: 'active-lock',
      state: 'changed',
      beforeDescriptor: 'prior-active-lock',
      afterDescriptor: 'candidate-active-lock',
      beforeFingerprint: priorActiveLock.fingerprint,
      afterFingerprint: fingerprintLock(candidateLock)
    });
  }
  return changes.sort((left, right) => compareText(left.id, right.id));
}

function isLockOnlyRefresh(plan) {
  return plan.configuration.currentSourceKind === 'private-active'
    && plan.priorActiveLock.state === 'present'
    && plan.configuration.currentDocumentFingerprint
      === plan.configuration.candidateDocumentFingerprint
    && plan.changes.some((change) => change.id === 'configuration-change.lock.active'
      && change.category === 'lock')
    && plan.changes.every((change) => change.category === 'lock'
      || change.category === 'resolution');
}

function assertCandidate(root, desiredStateFile, candidate, expectedName) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('CONFIGURATION_CANDIDATE_INVALID', 'Configuration candidate must be an object.');
  }
  if (candidate.$contract !== 'soter://contracts/configuration/v1'
    || candidate.contractVersion !== '1.0.0'
    || candidate.name !== expectedName) {
    fail('CONFIGURATION_CANDIDATE_INVALID', 'Candidate must replace the same named configuration/v1 document.');
  }
  const evaluated = evaluateConfigurationDocument({
    root,
    configPath: desiredStateFile,
    configuration: candidate
  });
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

function assertHistoricalDesiredConfiguration(root, configuration) {
  let failures;
  try {
    failures = validateJsonSchema(
      configuration,
      readJson(path.join(root, 'soter/contracts/configuration.schema.json'))
    );
  } catch {
    fail(
      'CONFIGURATION_PRIVATE_STATE_INVALID',
      'Private desired configuration contract is unavailable or invalid.'
    );
  }
  if (failures.length) {
    fail(
      'CONFIGURATION_PRIVATE_STATE_INVALID',
      'Private desired configuration does not satisfy the governed contract.'
    );
  }
  return configuration;
}

function currentDesiredConfiguration(root, name, templateFile) {
  let privatePresent;
  let activePresent;
  try {
    privatePresent = hasPrivateConfigurationState(root, name);
  } catch (error) {
    fail(
      error?.code || 'CONFIGURATION_PRIVATE_STATE_INVALID',
      'Private desired configuration state is invalid.'
    );
  }
  try {
    activePresent = hasActiveConfigurationLockState(root, name);
  } catch {
    fail('CONFIGURATION_ACTIVE_LOCK_STALE', 'Private active lock state is invalid.');
  }
  if (privatePresent !== activePresent) {
    fail(
      'CONFIGURATION_PRIVATE_STATE_UNBOUND',
      'Private desired configuration and its exact active lock must either both exist or both be absent.'
    );
  }
  if (!privatePresent) {
    const configuration = readJson(templateFile);
    return {
      sourceKind: 'tracked-template',
      configuration,
      lock: resolveConfiguration({ root, configPath: templateFile }),
      priorActiveLock: { state: 'absent', fingerprint: null, lock: null }
    };
  }
  const privateState = readPrivateConfigurationState(root, name);
  assertHistoricalDesiredConfiguration(root, privateState.configuration);
  let activeLock;
  try {
    activeLock = readActiveConfigurationLockState(root, name).lock;
  } catch {
    fail('CONFIGURATION_ACTIVE_LOCK_STALE', 'Private desired configuration or its active lock is invalid.');
  }
  assertHistoricalActiveLock(root, activeLock, {
    name,
    desiredStatePath: repoRelativePath(root, privateState.file),
    configurationFingerprint: fingerprintJson(privateState.configuration)
  });
  const activeFingerprint = fingerprintLock(activeLock);
  return {
    sourceKind: 'private-active',
    configuration: privateState.configuration,
    lock: activeLock,
    priorActiveLock: { state: 'present', fingerprint: activeFingerprint, lock: activeLock }
  };
}

function planCurrentness(root, plan) {
  const observed = observe(root, plan);
  if (observed.templateFingerprint !== plan.configuration.templateFingerprint) {
    return { state: 'stale', reasonCode: 'CONFIGURATION_TEMPLATE_DRIFT' };
  }
  if (observed.sourceKind === 'private-active'
    && observed.documentFingerprint === plan.configuration.candidateDocumentFingerprint
    && observed.resolutionFingerprint === plan.configuration.candidateLockFingerprint
    && observed.activeLockFingerprint === plan.configuration.candidateLockFingerprint) {
    return { state: 'applied', reasonCode: 'CONFIGURATION_CANDIDATE_APPLIED' };
  }
  const baselineMatches = observed.sourceKind === plan.configuration.currentSourceKind
    && observed.documentFingerprint === plan.configuration.currentDocumentFingerprint
    && observed.activeLockFingerprint === plan.priorActiveLock.fingerprint
    && (plan.configuration.currentSourceKind === 'private-active'
      || observed.resolutionFingerprint === plan.configuration.currentLockFingerprint);
  if (!baselineMatches) {
    return { state: 'stale', reasonCode: 'CONFIGURATION_PLAN_STALE' };
  }
  try {
    const candidateLock = resolveConfigurationDocument({
      root,
      configPath: resolveRepoPath(root, plan.configuration.desiredStatePath),
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
  iso(plan.createdAt, 'plan.createdAt');
  assertTargetIdentity(root, plan.target);
  const expectedTemplatePath = repoRelativePath(root, findConfiguration(root, plan.configuration.name));
  const expectedDesiredPath = repoRelativePath(
    root,
    privateConfigurationStatePath(root, plan.configuration.name)
  );
  const expectedActiveLockPath = repoRelativePath(
    root,
    activeConfigurationLockStatePath(root, plan.configuration.name)
  );
  let expectedChanges;
  try {
    expectedChanges = configurationPlanChanges({
      currentConfiguration: plan.currentConfiguration,
      candidateConfiguration: plan.candidateConfiguration,
      currentLock: plan.currentLock,
      candidateLock: plan.candidateLock,
      priorActiveLock: plan.priorActiveLock
    });
  } catch {
    fail('CONFIGURATION_PLAN_TAMPERED', 'Configuration change plan scope cannot be reconstructed.');
  }
  if (plan.configuration.templatePath !== expectedTemplatePath
    || plan.configuration.desiredStatePath !== expectedDesiredPath
    || plan.configuration.activeLockPath !== expectedActiveLockPath
    || fingerprintJson(plan.currentConfiguration) !== plan.configuration.currentDocumentFingerprint
    || fingerprintJson(plan.candidateConfiguration) !== plan.configuration.candidateDocumentFingerprint
    || fingerprintLock(plan.currentLock) !== plan.configuration.currentLockFingerprint
    || plan.currentLock.graphFingerprint !== plan.configuration.currentGraphFingerprint
    || fingerprintLock(plan.candidateLock) !== plan.configuration.candidateLockFingerprint
    || plan.candidateLock.graphFingerprint !== plan.configuration.candidateGraphFingerprint
    || plan.candidateLock.configuration.path !== plan.configuration.desiredStatePath
    || plan.candidateLock.configuration.name !== plan.configuration.name
    || plan.currentLock.configuration.name !== plan.configuration.name
    || (plan.configuration.currentSourceKind === 'tracked-template'
      ? plan.currentLock.configuration.path !== plan.configuration.templatePath
      : plan.currentLock.configuration.path !== plan.configuration.desiredStatePath)
    || projectionFingerprint(plan.candidateLock) !== plan.configuration.projectionFingerprint
    || fingerprintJson(plan.changes) !== plan.scopeFingerprint
    || fingerprintJson(plan.changes) !== fingerprintJson(expectedChanges)) {
    fail('CONFIGURATION_PLAN_TAMPERED', 'Configuration change plan exact bindings are invalid.');
  }
  if (plan.priorActiveLock.state === 'present') {
    if (fingerprintLock(plan.priorActiveLock.lock) !== plan.priorActiveLock.fingerprint) {
      fail('CONFIGURATION_PLAN_TAMPERED', 'Configuration change plan prior active lock is invalid.');
    }
    try {
      assertHistoricalActiveLock(root, plan.priorActiveLock.lock, {
        name: plan.configuration.name,
        desiredStatePath: plan.configuration.desiredStatePath,
        configurationFingerprint: plan.configuration.currentDocumentFingerprint
      });
    } catch {
      fail('CONFIGURATION_PLAN_TAMPERED', 'Configuration change plan prior active lock is invalid.');
    }
  }
  if ((plan.configuration.currentSourceKind === 'private-active')
    !== (plan.priorActiveLock.state === 'present')) {
    fail('CONFIGURATION_PLAN_TAMPERED', 'Configuration plan prior source and active-lock state disagree.');
  }
  if (plan.configuration.currentSourceKind === 'private-active'
    && plan.configuration.currentLockFingerprint !== plan.priorActiveLock.fingerprint) {
    fail(
      'CONFIGURATION_PLAN_TAMPERED',
      'Private configuration plan baseline does not equal its exact historical active lock.'
    );
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
    || request.configuration.sourceKind !== 'private-active'
    || plan.configuration.currentLockFingerprint !== request.configuration.currentLockFingerprint
    || plan.configuration.candidateLockFingerprint !== request.configuration.candidateLockFingerprint
    || plan.configuration.candidateGraphFingerprint !== request.configuration.candidateGraphFingerprint) {
    fail('CONFIGURATION_REQUEST_BINDING_INVALID', 'Configuration change request does not bind its exact plan.');
  }
  requireWindow(request.createdAt, request.expiresAt);
  if (occursBefore(request.createdAt, plan.createdAt)) {
    fail(
      'CONFIGURATION_REQUEST_BINDING_INVALID',
      'Configuration request cannot predate its exact plan.'
    );
  }
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
  iso(confirmation.confirmedAt, 'confirmation.confirmedAt');
  if (occursBefore(confirmation.confirmedAt, request.createdAt)
    || occursAfter(confirmation.confirmedAt, request.expiresAt)) {
    fail(
      'CONFIGURATION_CONFIRMATION_BINDING_INVALID',
      'Configuration confirmation time is outside its exact request window.'
    );
  }
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
  iso(consumption.createdAt, 'consumption.createdAt');
  iso(consumption.updatedAt, 'consumption.updatedAt');
  if (confirmation.confirmationFingerprint !== consumption.confirmation.fingerprint
    || request.id !== consumption.request.id
    || request.requestFingerprint !== consumption.request.fingerprint
    || plan.id !== consumption.plan.id
    || plan.planFingerprint !== consumption.plan.fingerprint
    || consumption.id !== configurationChangeConsumptionId(confirmation.id)
    || occursBefore(consumption.createdAt, confirmation.confirmedAt)
    || occursAfter(consumption.createdAt, request.expiresAt)
    || (consumption.state === 'reserved'
      ? consumption.updatedAt !== consumption.createdAt
      : occursBefore(consumption.updatedAt, consumption.createdAt))
    || (consumption.state === 'reserved') !== (consumption.checkpointFingerprint === null)) {
    fail('CONFIGURATION_CONSUMPTION_BINDING_INVALID', 'Configuration consumption does not bind its exact authority chain.');
  }
  return { consumption, confirmation, request, plan };
}

function checkpointConfiguration(plan) {
  return {
    name: plan.configuration.name,
    sourceKind: 'private-active',
    currentDocumentFingerprint: plan.configuration.currentDocumentFingerprint,
    candidateDocumentFingerprint: plan.configuration.candidateDocumentFingerprint,
    currentLockFingerprint: plan.configuration.currentLockFingerprint,
    candidateLockFingerprint: plan.configuration.candidateLockFingerprint
  };
}

function checkpointObservation(plan, state) {
  if (state === 'completed') {
    return {
      sourceKind: 'private-active',
      templateFingerprint: plan.configuration.templateFingerprint,
      documentFingerprint: plan.configuration.candidateDocumentFingerprint,
      activeLockFingerprint: plan.configuration.candidateLockFingerprint,
      resolutionFingerprint: plan.configuration.candidateLockFingerprint
    };
  }
  return null;
}

function planReference(plan) {
  return { id: plan.id, fingerprint: plan.planFingerprint };
}

function requestReference(request) {
  return { id: request.id, fingerprint: request.requestFingerprint };
}

function confirmationReference(confirmation) {
  return { id: confirmation.id, fingerprint: confirmation.confirmationFingerprint };
}

function consumptionReference(consumption) {
  return { id: consumption.id, fingerprint: consumption.consumptionFingerprint };
}

function referencesEqual(expected, references) {
  return references.every((reference) => reference?.id === expected.id
    && reference?.fingerprint === expected.fingerprint);
}

function reservedConsumption(consumption) {
  if (consumption.state === 'reserved') return consumption;
  return seal({
    ...consumption,
    updatedAt: consumption.createdAt,
    state: 'reserved',
    checkpointFingerprint: null
  }, 'consumptionFingerprint');
}

function checkpointAuthorityChain(root, checkpoint) {
  const plan = readPlan(root, checkpoint.plan.id);
  const requestChain = readRequest(root, checkpoint.request.id);
  const confirmationChain = readConfirmation(root, checkpoint.confirmation.id);
  const consumptionChain = assertConsumption(
    root,
    readConfigurationChangeConsumptionState(root, checkpoint.consumption.id).consumption
  );
  const consumption = consumptionChain.consumption;
  const reserved = reservedConsumption(consumption);
  if (!referencesEqual(checkpoint.plan, [
    planReference(plan),
    requestChain.request.plan,
    planReference(requestChain.plan),
    confirmationChain.confirmation.plan,
    confirmationChain.request.plan,
    planReference(confirmationChain.plan),
    consumptionChain.consumption.plan,
    consumptionChain.confirmation.plan,
    consumptionChain.request.plan,
    planReference(consumptionChain.plan)
  ]) || !referencesEqual(checkpoint.request, [
    requestReference(requestChain.request),
    confirmationChain.confirmation.request,
    requestReference(confirmationChain.request),
    consumptionChain.consumption.request,
    consumptionChain.confirmation.request,
    requestReference(consumptionChain.request)
  ]) || !referencesEqual(checkpoint.confirmation, [
    confirmationReference(confirmationChain.confirmation),
    consumptionChain.consumption.confirmation,
    confirmationReference(consumptionChain.confirmation)
  ]) || !referencesEqual(checkpoint.consumption, [
    consumptionReference(reserved)
  ]) || checkpoint.id !== consumption.checkpointId) {
    fail(
      'CONFIGURATION_CHECKPOINT_BINDING_INVALID',
      'Configuration checkpoint does not bind one exact authority chain.'
    );
  }
  return {
    plan,
    request: requestChain.request,
    confirmation: confirmationChain.confirmation,
    consumption,
    reservedConsumption: reserved
  };
}

function assertCheckpointPlanState(checkpoint, plan) {
  const expectedObservation = checkpointObservation(plan, checkpoint.state);
  const baselineObservation = checkpoint.state === 'prepared'
    || checkpoint.state === 'rolled-back';
  const baselineObservationMatches = !baselineObservation || (
    checkpoint.observation?.sourceKind === plan.configuration.currentSourceKind
    && checkpoint.observation?.templateFingerprint
      === plan.configuration.templateFingerprint
    && checkpoint.observation?.documentFingerprint
      === plan.configuration.currentDocumentFingerprint
    && checkpoint.observation?.activeLockFingerprint
      === plan.priorActiveLock.fingerprint
    && (plan.configuration.currentSourceKind === 'private-active'
      || checkpoint.observation?.resolutionFingerprint
        === plan.configuration.currentLockFingerprint)
  );
  if (fingerprintJson(checkpoint.configuration) !== fingerprintJson(checkpointConfiguration(plan))
    || !baselineObservationMatches
    || (expectedObservation
      && fingerprintJson(checkpoint.observation) !== fingerprintJson(expectedObservation))) {
    fail(
      'CONFIGURATION_CHECKPOINT_BINDING_INVALID',
      'Configuration checkpoint metadata or observation does not bind its exact plan state.'
    );
  }
}

function assertCheckpoint(root, checkpoint) {
  assertFingerprint(
    root,
    checkpoint,
    'checkpoint',
    'checkpointFingerprint',
    'Configuration transaction checkpoint'
  );
  const allowedPhases = {
    prepared: ['prepared'],
    applying: ['prepared', 'configuration-written', 'configuration-unchanged', 'active-lock-written'],
    verifying: ['verifying'],
    completed: ['terminal'],
    'rolling-back': ['rollback-configuration', 'rollback-active-lock'],
    'rolled-back': ['terminal'],
    'needs-attention': ['terminal']
  };
  const failureRequired = checkpoint.state === 'rolling-back'
    || checkpoint.state === 'rolled-back'
    || checkpoint.state === 'needs-attention';
  if (!allowedPhases[checkpoint.state]?.includes(checkpoint.phase)
    || failureRequired === (checkpoint.failure === null)) {
    fail(
      'CONFIGURATION_CHECKPOINT_BINDING_INVALID',
      'Configuration checkpoint state, phase, and failure are mechanically inconsistent.'
    );
  }
  iso(checkpoint.createdAt, 'checkpoint.createdAt');
  iso(checkpoint.updatedAt, 'checkpoint.updatedAt');
  const { plan, request, confirmation, consumption } = checkpointAuthorityChain(
    root,
    checkpoint
  );
  if (consumption.state !== 'started'
    || consumption.checkpointFingerprint === null
    || checkpoint.createdAt !== consumption.updatedAt
    || occursBefore(checkpoint.updatedAt, checkpoint.createdAt)
    || (checkpoint.state === 'prepared'
      && consumption.checkpointFingerprint !== checkpoint.checkpointFingerprint)) {
    fail('CONFIGURATION_CHECKPOINT_BINDING_INVALID', 'Configuration checkpoint does not bind its exact authority chain.');
  }
  assertCheckpointPlanState(checkpoint, plan);
  return { checkpoint, plan, request, confirmation, consumption };
}

function seal(value, property) {
  value[property] = unsignedFingerprint(value, property);
  return value;
}

function persistCheckpoint(root, checkpoint) {
  checkpoint.updatedAt = checkpoint.updatedAt || checkpoint.createdAt;
  iso(checkpoint.createdAt, 'checkpoint.createdAt');
  iso(checkpoint.updatedAt, 'checkpoint.updatedAt');
  if (occursBefore(checkpoint.updatedAt, checkpoint.createdAt)) {
    fail(
      'CONFIGURATION_CHECKPOINT_BINDING_INVALID',
      'Configuration checkpoint update time cannot predate its exact start.'
    );
  }
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
      ...checkpointConfiguration(plan)
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
  iso(checkpoint.createdAt, 'checkpoint.createdAt');
  iso(checkpoint.updatedAt, 'checkpoint.updatedAt');
  const chain = checkpointAuthorityChain(root, checkpoint);
  const directPlan = assertPlan(root, plan);
  const directRequest = assertRequest(root, request).request;
  const directConfirmation = assertConfirmation(root, confirmation).confirmation;
  const directConsumption = assertConsumption(root, consumption).consumption;
  if (checkpoint.state !== 'prepared'
    || checkpoint.phase !== 'prepared'
    || checkpoint.failure !== null
    || chain.consumption.state !== 'reserved'
    || directConsumption.state !== 'reserved'
    || directConsumption.checkpointFingerprint !== null
    || occursBefore(checkpoint.createdAt, directConsumption.createdAt)
    || checkpoint.updatedAt !== checkpoint.createdAt
    || !referencesEqual(planReference(chain.plan), [planReference(directPlan)])
    || !referencesEqual(requestReference(chain.request), [requestReference(directRequest)])
    || !referencesEqual(confirmationReference(chain.confirmation), [
      confirmationReference(directConfirmation)
    ])
    || !referencesEqual(consumptionReference(chain.consumption), [
      consumptionReference(directConsumption)
    ])) {
    fail('CONFIGURATION_CHECKPOINT_BINDING_INVALID', 'Prepared checkpoint does not bind the exact reserved consumption.');
  }
  assertCheckpointPlanState(checkpoint, chain.plan);
  return checkpoint;
}

function startReservedExecution(root, { plan, request, confirmation, consumption, checkpointId, at }) {
  iso(at, 'at');
  if (planCurrentness(root, plan).state !== 'current') {
    fail('CONFIGURATION_PLAN_STALE', 'Reserved configuration execution requires the exact plan to remain current.');
  }
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
    if (occursBefore(at, checkpoint.createdAt)) {
      fail(
        'CONFIGURATION_CHECKPOINT_BINDING_INVALID',
        'Reserved configuration execution cannot move its exact checkpoint time backward.'
      );
    }
  } else {
    if (occursBefore(at, consumption.createdAt)) {
      fail(
        'CONFIGURATION_CONSUMPTION_BINDING_INVALID',
        'Reserved configuration execution cannot predate its exact reservation.'
      );
    }
    checkpoint = preparedCheckpoint({
      plan,
      request,
      confirmation,
      consumption,
      checkpointId,
      at,
      observation: observe(root, plan)
    });
    assertPreparedCheckpointReservation(
      root,
      checkpoint,
      plan,
      request,
      confirmation,
      consumption
    );
    if (planCurrentness(root, plan).state !== 'current') {
      fail('CONFIGURATION_PLAN_STALE', 'Reserved configuration execution requires the exact plan to remain current.');
    }
    createConfigurationTransactionCheckpointState(root, checkpoint);
  }
  if (planCurrentness(root, plan).state !== 'current') {
    fail('CONFIGURATION_PLAN_STALE', 'Reserved configuration execution requires the exact plan to remain current.');
  }
  const started = seal({
    ...consumption,
    updatedAt: checkpoint.createdAt,
    state: 'started',
    checkpointFingerprint: checkpoint.checkpointFingerprint
  }, 'consumptionFingerprint');
  assertConsumption(root, started);
  writeConfigurationChangeConsumptionState(root, started);
  return { consumption: started, checkpoint };
}

function observe(root, plan) {
  const templateFile = resolveRepoPath(root, plan.configuration.templatePath);
  const desiredFile = resolveRepoPath(root, plan.configuration.desiredStatePath);
  let templateFingerprint = null;
  try {
    templateFingerprint = fingerprintJson(readJson(templateFile));
  } catch {
    // A removed or malformed portable template invalidates every private resolution.
  }
  let privateExists = false;
  let activeExists = false;
  let statePathsValid = true;
  try {
    privateExists = hasPrivateConfigurationState(root, plan.configuration.name);
    activeExists = hasActiveConfigurationLockState(root, plan.configuration.name);
  } catch {
    statePathsValid = false;
  }
  let documentFingerprint = null;
  let resolutionFingerprint = null;
  try {
    if (!statePathsValid) {
      // Unsafe private ancestry, permissions, or linked leaves are invalid state.
    } else if (privateExists) {
      const privateState = readPrivateConfigurationState(root, plan.configuration.name);
      documentFingerprint = fingerprintJson(privateState.configuration);
      resolutionFingerprint = fingerprintLock(resolveConfiguration({
        root,
        configPath: privateState.file
      }));
    } else if (!activeExists) {
      documentFingerprint = templateFingerprint;
      resolutionFingerprint = fingerprintLock(resolveConfiguration({ root, configPath: templateFile }));
    }
  } catch {
    // A half-applied, permission-drifted, or externally edited configuration is invalid.
  }
  let activeLockFingerprint = null;
  try {
    activeLockFingerprint = activeExists
      ? fingerprintLock(readActiveConfigurationLockState(root, plan.configuration.name).lock)
      : null;
  } catch {
    // Malformed private authority never falls back to the portable template.
  }
  return {
    sourceKind: statePathsValid && privateExists && activeExists
      ? 'private-active'
      : statePathsValid && !privateExists && !activeExists ? 'tracked-template' : 'invalid',
    templateFingerprint,
    documentFingerprint,
    activeLockFingerprint,
    resolutionFingerprint
  };
}

function restorePrior(root, checkpoint, plan, at, reasonCode, summary) {
  if (occursBefore(at, checkpoint.updatedAt)) {
    fail(
      'CONFIGURATION_CHECKPOINT_BINDING_INVALID',
      'Configuration rollback cannot move its exact checkpoint time backward.'
    );
  }
  checkpoint.state = 'rolling-back';
  checkpoint.phase = 'rollback-configuration';
  checkpoint.failure = { reasonCode, summary };
  checkpoint.updatedAt = at;
  persistCheckpoint(root, checkpoint);
  try {
    if (plan.configuration.currentSourceKind === 'private-active') {
      const beforeConfigurationRestore = observe(root, plan);
      if (beforeConfigurationRestore.documentFingerprint
        !== plan.configuration.currentDocumentFingerprint) {
        writePrivateConfigurationState(
          root,
          plan.configuration.name,
          plan.currentConfiguration
        );
      }
    } else {
      removePrivateConfigurationState(root, plan.configuration.name);
    }
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
    if (restored.sourceKind !== plan.configuration.currentSourceKind
      || restored.templateFingerprint !== plan.configuration.templateFingerprint
      || restored.documentFingerprint !== plan.configuration.currentDocumentFingerprint
      || (plan.configuration.currentSourceKind === 'tracked-template'
        && restored.resolutionFingerprint !== plan.configuration.currentLockFingerprint)
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
  const templateFile = findConfiguration(resolvedRoot, name);
  const desiredStateFile = privateConfigurationStatePath(resolvedRoot, name);
  const candidate = clone(candidateConfiguration);
  if (hasConfigurationChangePlanState(resolvedRoot, id)) {
    const existing = readPlan(resolvedRoot, id);
    if (existing.createdAt !== createdAt
      || existing.configuration.name !== name
      || existing.configuration.templatePath !== repoRelativePath(resolvedRoot, templateFile)
      || existing.configuration.desiredStatePath !== repoRelativePath(resolvedRoot, desiredStateFile)
      || existing.configuration.candidateDocumentFingerprint !== fingerprintJson(candidate)) {
      fail('CONFIGURATION_PLAN_CONFLICT', 'Configuration change plan ID already binds different exact content.');
    }
    return { plan: existing, planPath: repoRelativePath(resolvedRoot, configurationChangePlanStatePath(resolvedRoot, id)) };
  }
  const templateConfiguration = readJson(templateFile);
  const current = currentDesiredConfiguration(resolvedRoot, name, templateFile);
  const currentConfiguration = current.configuration;
  const currentLock = current.lock;
  const priorActiveLock = current.priorActiveLock;
  const candidateLock = assertCandidate(
    resolvedRoot,
    desiredStateFile,
    candidate,
    templateConfiguration.name
  );
  const changes = configurationPlanChanges({
    currentConfiguration,
    candidateConfiguration: candidate,
    currentLock,
    candidateLock,
    priorActiveLock
  });
  if (!changes.length) fail('CONFIGURATION_CHANGE_EMPTY', 'Candidate resolves from an unchanged desired configuration.');
  const activeLockPath = activeConfigurationLockStatePath(resolvedRoot, name);
  const plan = seal({
    $contract: CONTRACTS.plan[0],
    contractVersion: VERSION,
    id,
    createdAt,
    target: targetIdentity(resolvedRoot),
    configuration: {
      name,
      templatePath: repoRelativePath(resolvedRoot, templateFile),
      desiredStatePath: repoRelativePath(resolvedRoot, desiredStateFile),
      activeLockPath: repoRelativePath(resolvedRoot, activeLockPath),
      permissions: {
        privateDirectories: '0700',
        desiredConfiguration: '0600',
        activeLock: '0600',
        authorityFiles: '0600'
      },
      templateFingerprint: fingerprintJson(templateConfiguration),
      currentSourceKind: current.sourceKind,
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
      sourceKind: 'private-active',
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

export function resumeConfigurationChangeExecution({
  root = DEFAULT_ROOT,
  confirmationId,
  checkpointId,
  at
} = {}) {
  const resolvedRoot = path.resolve(root);
  const { confirmation } = readConfirmation(resolvedRoot, confirmationId);
  const consumptionId = configurationChangeConsumptionId(confirmation.id);
  if (!hasConfigurationChangeConsumptionState(resolvedRoot, consumptionId)) {
    fail(
      'CONFIGURATION_CONSUMPTION_MISSING',
      'Configuration start re-entry requires an existing exact reserved consumption.'
    );
  }
  const existingResult = assertConsumption(
    resolvedRoot,
    readConfigurationChangeConsumptionState(resolvedRoot, consumptionId).consumption
  );
  if (existingResult.consumption.state !== 'reserved') {
    fail(
      'CONFIGURATION_CONSUMPTION_NOT_RESERVED',
      'Configuration start re-entry requires the exact consumption to remain reserved.'
    );
  }
  if (existingResult.consumption.checkpointId !== checkpointId) {
    fail(
      'CONFIGURATION_CONFIRMATION_ALREADY_CONSUMED',
      'Configuration confirmation was already reserved for another checkpoint.'
    );
  }
  const resumed = startReservedExecution(resolvedRoot, {
    plan: existingResult.plan,
    request: existingResult.request,
    confirmation: existingResult.confirmation,
    consumption: existingResult.consumption,
    checkpointId,
    at
  });
  return {
    consumption: resumed.consumption,
    consumptionPath: repoRelativePath(
      resolvedRoot,
      configurationChangeConsumptionStatePath(resolvedRoot, resumed.consumption.id)
    ),
    checkpoint: resumed.checkpoint,
    checkpointPath: repoRelativePath(
      resolvedRoot,
      configurationTransactionCheckpointStatePath(resolvedRoot, resumed.checkpoint.id)
    )
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
  if (occursBefore(at, checkpoint.updatedAt)) {
    fail(
      'CONFIGURATION_CHECKPOINT_BINDING_INVALID',
      'Configuration execution cannot move its exact checkpoint time backward.'
    );
  }
  if (planCurrentness(resolvedRoot, plan).state !== 'current') {
    fail('CONFIGURATION_PLAN_STALE', 'Configuration execution checkpoint is no longer current.');
  }
  try {
    checkpoint.state = 'applying';
    checkpoint.updatedAt = at;
    persistCheckpoint(resolvedRoot, checkpoint);
    if (isLockOnlyRefresh(plan)) {
      checkpoint.observation = observe(resolvedRoot, plan);
      if (checkpoint.observation.sourceKind !== 'private-active'
        || checkpoint.observation.templateFingerprint !== plan.configuration.templateFingerprint
        || checkpoint.observation.documentFingerprint
          !== plan.configuration.currentDocumentFingerprint
        || checkpoint.observation.activeLockFingerprint
          !== plan.priorActiveLock.fingerprint) {
        fail(
          'CONFIGURATION_PLAN_STALE',
          'Lock refresh requires the exact desired document and historical active lock.'
        );
      }
      checkpoint.phase = 'configuration-unchanged';
    } else {
      writePrivateConfigurationState(
        resolvedRoot,
        plan.configuration.name,
        plan.candidateConfiguration
      );
      checkpoint.phase = 'configuration-written';
      checkpoint.observation = observe(resolvedRoot, plan);
    }
    persistCheckpoint(resolvedRoot, checkpoint);
    writeActiveConfigurationLockState(resolvedRoot, plan.configuration.name, plan.candidateLock);
    checkpoint.phase = 'active-lock-written';
    checkpoint.observation = observe(resolvedRoot, plan);
    persistCheckpoint(resolvedRoot, checkpoint);
    checkpoint.state = 'verifying';
    checkpoint.phase = 'verifying';
    checkpoint.observation = observe(resolvedRoot, plan);
    persistCheckpoint(resolvedRoot, checkpoint);
    if (checkpoint.observation.sourceKind !== 'private-active'
      || checkpoint.observation.templateFingerprint !== plan.configuration.templateFingerprint
      || checkpoint.observation.documentFingerprint !== plan.configuration.candidateDocumentFingerprint
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
  if (occursBefore(at, checkpoint.updatedAt)) {
    fail(
      'CONFIGURATION_CHECKPOINT_BINDING_INVALID',
      'Configuration recovery cannot move its exact checkpoint time backward.'
    );
  }
  if (checkpoint.state === 'rolling-back') {
    return restorePrior(
      resolvedRoot,
      checkpoint,
      plan,
      at,
      checkpoint.failure?.reasonCode || 'CONFIGURATION_RECOVERY_ROLLBACK',
      checkpoint.failure?.summary
        || 'Recovery continued the exact in-progress configuration rollback.'
    );
  }
  const observed = observe(resolvedRoot, plan);
  const candidateDocument = observed.templateFingerprint === plan.configuration.templateFingerprint
    && observed.documentFingerprint === plan.configuration.candidateDocumentFingerprint;
  const candidateLock = observed.activeLockFingerprint === plan.configuration.candidateLockFingerprint;
  if (observed.sourceKind === plan.configuration.currentSourceKind
    && observed.templateFingerprint === plan.configuration.templateFingerprint
    && observed.documentFingerprint === plan.configuration.currentDocumentFingerprint
    && (plan.configuration.currentSourceKind === 'private-active'
      || observed.resolutionFingerprint === plan.configuration.currentLockFingerprint)
    && observed.activeLockFingerprint === plan.priorActiveLock.fingerprint
    && checkpoint.state === 'prepared') {
    return executeConfigurationChange({ root: resolvedRoot, checkpointId, at });
  }
  if (observed.sourceKind === 'private-active'
    && candidateDocument
    && candidateLock
    && observed.resolutionFingerprint === plan.configuration.candidateLockFingerprint) {
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
        && checkpoint.observation.sourceKind === 'private-active'
        && checkpoint.observation.templateFingerprint === plan.configuration.templateFingerprint
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
  const observation = observe(resolvedRoot, plan);
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
  let checkpointDocument = null;
  if (checkpointId) {
    if (!hasConfigurationTransactionCheckpointState(resolvedRoot, checkpointId)) {
      fail(
        'CONFIGURATION_INSPECTION_REFERENCE_MISSING',
        'A requested configuration transaction reference is unavailable.'
      );
    }
    checkpointDocument = readConfigurationTransactionCheckpointState(
      resolvedRoot,
      checkpointId
    ).checkpoint;
    assertFingerprint(
      resolvedRoot,
      checkpointDocument,
      'checkpoint',
      'checkpointFingerprint',
      'Configuration transaction checkpoint'
    );
  }
  if (!consumption && checkpointDocument) {
    consumption = assertConsumption(
      resolvedRoot,
      readConfigurationChangeConsumptionState(
        resolvedRoot,
        checkpointDocument.consumption.id
      ).consumption
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
  if (!confirmation && (checkpointDocument || consumption)) {
    const id = checkpointDocument?.confirmation.id || consumption.confirmation.id;
    confirmation = assertConfirmation(
      resolvedRoot,
      readConfigurationChangeConfirmationState(resolvedRoot, id).confirmation
    ).confirmation;
  }
  if (!request && (checkpointDocument || consumption || confirmation)) {
    const id = checkpointDocument?.request.id || consumption?.request.id || confirmation.request.id;
    request = assertRequest(
      resolvedRoot,
      readConfigurationChangeRequestState(resolvedRoot, id).request
    ).request;
  }
  if (!checkpointDocument && consumption
    && hasConfigurationTransactionCheckpointState(resolvedRoot, consumption.checkpointId)) {
    checkpointDocument = readConfigurationTransactionCheckpointState(
      resolvedRoot,
      consumption.checkpointId
    ).checkpoint;
    assertFingerprint(
      resolvedRoot,
      checkpointDocument,
      'checkpoint',
      'checkpointFingerprint',
      'Configuration transaction checkpoint'
    );
  }
  if (checkpointDocument && consumption?.checkpointId !== checkpointDocument.id) {
    fail(
      'CONFIGURATION_INSPECTION_BINDING_INVALID',
      'Inspection checkpoint does not equal the consumption-bound checkpoint.'
    );
  }
  const checkpoint = checkpointDocument
    ? consumption?.state === 'reserved'
      ? assertPreparedCheckpointReservation(
          resolvedRoot,
          checkpointDocument,
          plan,
          request,
          confirmation,
          consumption
        )
      : assertCheckpoint(resolvedRoot, checkpointDocument).checkpoint
    : null;
  const startedCheckpointMissing = consumption?.state === 'started' && !checkpoint;
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
  } else if (consumption?.state === 'reserved' && applicability.state !== 'current') {
    resume = {
      classification: 'unavailable',
      reasonCode: applicability.reasonCode,
      reason: 'The exact configuration plan no longer matches the current workspace state.',
      permittedNextAction: 'none'
    };
  } else if (consumption?.state === 'reserved' && checkpoint) {
    resume = {
      classification: 'safe',
      reasonCode: 'CONFIGURATION_RESERVED_CHECKPOINT_PREPARED',
      reason: 'The reserved one-time start has its exact prepared checkpoint and may only resume that start.',
      permittedNextAction: 'resume-start'
    };
  } else if (consumption?.state === 'reserved') {
    resume = {
      classification: 'safe',
      reasonCode: 'CONFIGURATION_CONSUMPTION_RESERVED',
      reason: 'The exact one-time start is reserved and may only resume with its bound checkpoint ID.',
      permittedNextAction: 'resume-start'
    };
  } else if (checkpoint) {
    if (checkpoint.state === 'needs-attention') {
      resume = {
        classification: 'requires-review',
        reasonCode: 'CONFIGURATION_CHECKPOINT_REQUIRES_REVIEW',
        reason: 'The exact durable configuration checkpoint requires local operator review.',
        permittedNextAction: 'inspect-checkpoint'
      };
    } else if (checkpoint.state === 'rolling-back') {
      resume = {
        classification: 'safe',
        reasonCode: 'CONFIGURATION_CHECKPOINT_ROLLBACK_IN_PROGRESS',
        reason: 'Core can inspect and continue the exact durable configuration rollback.',
        permittedNextAction: 'inspect-checkpoint'
      };
    } else {
      resume = {
        classification: 'safe',
        reasonCode: 'CONFIGURATION_CHECKPOINT_RECOVERABLE',
        reason: 'Core can inspect and reconcile the exact durable configuration checkpoint.',
        permittedNextAction: 'inspect-checkpoint'
      };
    }
  } else if (startedCheckpointMissing) {
    resume = {
      classification: 'requires-review',
      reasonCode: 'CONFIGURATION_CHECKPOINT_MISSING',
      reason: 'The one-time start was consumed but its exact checkpoint is unavailable.',
      permittedNextAction: 'none'
    };
  } else if (confirmation && applicability.state === 'current') {
    const expired = Date.parse(at) > Date.parse(request.expiresAt);
    resume = {
      classification: expired ? 'unavailable' : 'safe',
      reasonCode: expired
        ? 'CONFIGURATION_REQUEST_EXPIRED'
        : 'CONFIGURATION_CONFIRMATION_CURRENT',
      reason: expired
        ? 'The exact configuration request expired and requires a new confirmation.'
        : 'The exact confirmation is current and has not been consumed.',
      permittedNextAction: expired ? 'request-confirmation' : 'apply'
    };
  } else if (request && !confirmation && applicability.state === 'current') {
    const expired = Date.parse(at) > Date.parse(request.expiresAt);
    resume = {
      classification: expired ? 'unavailable' : 'safe',
      reasonCode: expired ? 'CONFIGURATION_REQUEST_EXPIRED' : 'CONFIGURATION_REQUEST_AWAITING_CONFIRMATION',
      reason: expired
        ? 'The exact configuration request expired and requires a new confirmation.'
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
      sourceKind: applicability.state === 'applied'
        ? 'private-active'
        : plan.configuration.currentSourceKind,
      baselineLockFingerprint: plan.priorActiveLock.fingerprint
        || plan.configuration.currentLockFingerprint,
      candidateLockFingerprint: plan.configuration.candidateLockFingerprint,
      candidateGraphFingerprint: plan.configuration.candidateGraphFingerprint,
      observedLockFingerprint: observation.activeLockFingerprint,
      observedResolution: observation.resolutionFingerprint
        ? { state: 'resolved', fingerprint: observation.resolutionFingerprint }
        : { state: 'unavailable', fingerprint: null },
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
      state: consumption.state,
      checkpointId: consumption.checkpointId
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
