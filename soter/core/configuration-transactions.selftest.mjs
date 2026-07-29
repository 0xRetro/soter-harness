import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  beginConfigurationChangeRequest,
  confirmConfigurationChangeRequest,
  executeConfigurationChange,
  inspectConfigurationChange,
  prepareConfigurationChange,
  prepareConfigurationChangeExecution,
  recoverConfigurationChange
} from './configuration-transactions.mjs';
import { fingerprintJson, readJson, writeJson } from './lib/canonical-json.mjs';
import { fingerprintLock, resolveConfiguration } from './resolve.mjs';
import {
  privateConfigurationStatePath,
  readPrivateConfigurationState,
  removePrivateConfigurationState,
  writePrivateConfigurationState
} from './private-configurations.mjs';
import { prepareAutomationRun } from './prepared-work.mjs';
import {
  activeConfigurationLockStatePath,
  configurationChangeConsumptionStatePath,
  configurationChangePlanStatePath,
  configurationTransactionCheckpointStatePath,
  removeActiveConfigurationLockState,
  readConfigurationTransactionCheckpointState,
  writeActiveConfigurationLockState
} from './runtime-state.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATED = '2026-07-16T15:00:00.000Z';
const CONFIRMED = '2026-07-16T15:01:00.000Z';
const EXPIRES = '2026-07-16T15:10:00.000Z';
const APPLIED = '2026-07-16T15:02:00.000Z';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function copyRoot(root, prefix) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(root, temporary, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      return relative !== '.git'
        && !relative.startsWith('.git' + path.sep)
        && relative !== '.soter'
        && !relative.startsWith('.soter' + path.sep);
    }
  });
  return temporary;
}

function candidate(root, marker) {
  const file = path.join(root, 'soter/configurations/meeting-intake.config.json');
  const value = readJson(file);
  value.host = {
    id: 'claude',
    adapter: 'host.claude',
    version: '0.3.1',
    reason: 'Exercise the exact local configuration transaction through the declared Claude projection.'
  };
  value.authorities = value.authorities.map((authority) => authority.id === 'authority.crm.instance'
    ? { ...authority, uri: 'notion://private-configuration-' + marker }
    : authority);
  return value;
}

function taskOptionMappingCandidate(root, statusProvider, contextProvider) {
  const file = path.join(root, 'soter/configurations/task-capture.config.json');
  const value = readJson(file);
  value.settings['integration.notion'].optionMappings = [
    {
      mapping: 'mapping.integration.notion.tasks-records',
      recordType: 'task',
      field: 'status',
      mode: 'exact-bijection',
      entries: [{ portable: 'To Do', provider: statusProvider }]
    },
    {
      mapping: 'mapping.integration.notion.tasks-records',
      recordType: 'task',
      field: 'context',
      mode: 'exact-bijection',
      entries: [{ portable: 'Project', provider: contextProvider }]
    },
    {
      mapping: 'mapping.integration.notion.projects-records',
      recordType: 'project',
      field: 'projectType',
      mode: 'exact-bijection',
      entries: [{
        portable: 'Internal Project',
        provider: 'PRIVATE_PROVIDER_PROJECT_TYPE_CONFIGURATION_SENTINEL'
      }]
    },
    {
      mapping: 'mapping.integration.notion.projects-records',
      recordType: 'project',
      field: 'status',
      mode: 'exact-bijection',
      entries: [{
        portable: 'Active',
        provider: 'PRIVATE_PROVIDER_PROJECT_STATUS_CONFIGURATION_SENTINEL'
      }]
    }
  ];
  return value;
}

function prepareAuthority(
  root,
  suffix,
  candidateConfiguration,
  configurationName = 'meeting-intake'
) {
  const planId = 'configuration-change-plan.' + suffix;
  const requestId = 'configuration-change-request.' + suffix;
  const confirmationId = 'configuration-change-confirmation.' + suffix;
  const checkpointId = 'checkpoint.configuration.' + suffix;
  const prepared = prepareConfigurationChange({
    root,
    name: configurationName,
    candidateConfiguration,
    id: planId,
    createdAt: CREATED
  });
  const request = beginConfigurationChangeRequest({
    root,
    planId,
    id: requestId,
    reason: 'Request confirmation for the exact selftest configuration candidate.',
    createdAt: CREATED,
    expiresAt: EXPIRES
  });
  const confirmation = confirmConfigurationChangeRequest({
    root,
    requestId,
    id: confirmationId,
    actor: { type: 'local-operator', id: 'operator.selftest' },
    reason: 'Confirm the exact selftest configuration candidate for local application.',
    confirmedAt: CONFIRMED
  });
  const execution = prepareConfigurationChangeExecution({
    root,
    confirmationId,
    checkpointId,
    at: APPLIED
  });
  return { planId, requestId, confirmationId, checkpointId, prepared, request, confirmation, execution };
}

function assertPrivateModes(root, planId, configurationName) {
  if (process.platform === 'win32') return;
  const planFile = configurationChangePlanStatePath(root, planId);
  assert((fs.statSync(planFile).mode & 0o7777) === 0o600, 'Configuration plan is not mode 0600.');
  assert((fs.statSync(path.dirname(planFile)).mode & 0o7777) === 0o700,
    'Configuration plan directory is not mode 0700.');
  const lockFile = activeConfigurationLockStatePath(root, configurationName);
  if (fs.existsSync(lockFile)) {
    assert((fs.statSync(lockFile).mode & 0o7777) === 0o600, 'Active configuration lock is not mode 0600.');
    assert((fs.statSync(path.dirname(lockFile)).mode & 0o7777) === 0o700,
      'Active configuration lock directory is not mode 0700.');
  }
  const desiredFile = privateConfigurationStatePath(root, configurationName);
  if (fs.existsSync(desiredFile)) {
    assert((fs.statSync(desiredFile).mode & 0o7777) === 0o600,
      'Private desired configuration is not mode 0600.');
    assert((fs.statSync(path.dirname(desiredFile)).mode & 0o7777) === 0o700,
      'Private desired configuration directory is not mode 0700.');
  }
}

export async function selftestConfigurationTransactions(root = defaultRoot) {
  const roots = [];
  try {
    const happy = copyRoot(root, 'soter-configuration-transaction-');
    roots.push(happy);
    const configPath = path.join(happy, 'soter/configurations/meeting-intake.config.json');
    const fixtureLockPath = path.join(happy, 'soter/fixtures/meeting-intake/meeting-intake.lock.json');
    const originalConfiguration = readJson(configPath);
    const originalConfigurationText = fs.readFileSync(configPath, 'utf8');
    const fixtureLockText = fs.readFileSync(fixtureLockPath, 'utf8');
    const portableEmailTemplate = readJson(path.join(
      happy,
      'soter/configurations/email-triage.config.json'
    ));
    const portableSelfAddresses = portableEmailTemplate.settings['integration.gmail'].selfAddresses;
    assert(portableSelfAddresses.length >= 1
      && portableSelfAddresses.every((address) => address.endsWith('.example'))
      && !JSON.stringify(portableEmailTemplate).includes('@soterlabs.com'),
    'Tracked configuration template retained user-specific mailbox identities.');
    const privateMarker = 'HOSTILE_PRIVATE_CONFIGURATION_SENTINEL';
    const exactCandidate = candidate(happy, privateMarker);
    const authority = prepareAuthority(happy, 'happy-selftest', exactCandidate);
    for (const [value, schemaName] of [
      [authority.prepared.plan, 'configuration-change-plan.schema.json'],
      [authority.request.request, 'configuration-change-request.schema.json'],
      [authority.execution.checkpoint, 'configuration-transaction-checkpoint.schema.json']
    ]) {
      const schema = readJson(path.join(happy, 'soter/contracts', schemaName));
      assert(validateJsonSchema(value, schema).length === 0,
        schemaName + ' rejected the exact private configuration transaction document.');
    }
    assertPrivateModes(happy, authority.planId, 'meeting-intake');
    const beforeInspection = inspectConfigurationChange({
      root: happy,
      planId: authority.planId,
      requestId: authority.requestId,
      confirmationId: authority.confirmationId,
      consumptionId: authority.execution.consumption.id,
      checkpointId: authority.checkpointId,
      at: APPLIED
    });
    assert(beforeInspection.resume.permittedNextAction === 'inspect-checkpoint',
      'Prepared configuration checkpoint did not project checkpoint-only continuation guidance.');
    assert(!JSON.stringify(beforeInspection).includes(privateMarker)
      && !JSON.stringify(beforeInspection).includes('notion://'),
    'Sanitized configuration inspection exposed private configuration values.');
    assert(!JSON.stringify(authority.request.request).includes(privateMarker)
      && !JSON.stringify(authority.execution.checkpoint).includes(privateMarker),
    'Request or checkpoint exposed private desired configuration values.');
    assert(beforeInspection.configuration.sourceKind === 'tracked-template'
      && !Object.hasOwn(beforeInspection.configuration, 'path')
      && !JSON.stringify(beforeInspection).includes('.soter/state')
      && !JSON.stringify(beforeInspection).includes('soter/configurations/'),
    'Sanitized configuration inspection exposed a private or portable configuration path.');
    const hostileInspection = structuredClone(beforeInspection);
    hostileInspection.configuration.candidateConfiguration = exactCandidate;
    hostileInspection.configuration.path = '.soter/state/configurations/meeting-intake.json';
    hostileInspection.scope.changes[0].before = 'HOSTILE_RAW_BEFORE_SENTINEL';
    hostileInspection.scope.changes[0].after = 'HOSTILE_RAW_AFTER_SENTINEL';
    hostileInspection.scope.changes[0].uri = 'notion://HOSTILE_PRIVATE_URI_SENTINEL';
    const inspectionSchema = readJson(path.join(
      happy,
      'soter/contracts/configuration-change-inspection.schema.json'
    ));
    assert(validateJsonSchema(hostileInspection, inspectionSchema).length >= 5,
      'Sanitized configuration inspection schema accepted raw configuration escape fields.');
    const completed = executeConfigurationChange({
      root: happy,
      checkpointId: authority.checkpointId,
      at: APPLIED
    });
    assert(completed.state === 'completed', 'Exact configuration transaction did not complete.');
    assert(fingerprintJson(readPrivateConfigurationState(happy, 'meeting-intake').configuration)
        === fingerprintJson(exactCandidate),
    'Exact candidate was not written to private desired configuration.');
    assert(fs.readFileSync(configPath, 'utf8') === originalConfigurationText,
      'Configuration transaction overwrote the portable tracked template.');
    const activeLock = readJson(activeConfigurationLockStatePath(happy, 'meeting-intake'));
    const resolved = resolveConfiguration({
      root: happy,
      configPath: privateConfigurationStatePath(happy, 'meeting-intake')
    });
    assert(fingerprintLock(activeLock) === fingerprintLock(resolved),
      'Private active lock does not equal the exact post-apply resolution.');
    assert(fs.readFileSync(fixtureLockPath, 'utf8') === fixtureLockText,
      'Configuration transaction changed checked-in fixture lock evidence.');
    assertPrivateModes(happy, authority.planId, 'meeting-intake');
    const afterInspection = inspectConfigurationChange({
      root: happy,
      planId: authority.planId,
      requestId: authority.requestId,
      confirmationId: authority.confirmationId,
      consumptionId: authority.execution.consumption.id,
      checkpointId: authority.checkpointId,
      at: APPLIED
    });
    assert(afterInspection.configuration.applicability === 'applied'
      && afterInspection.configuration.sourceKind === 'private-active'
      && afterInspection.checkpoint.state === 'completed'
      && afterInspection.resume.permittedNextAction === 'none',
    'Completed configuration inspection projected incorrect lifecycle state.');
    const repeatedPlan = prepareConfigurationChange({
      root: happy,
      name: 'meeting-intake',
      candidateConfiguration: exactCandidate,
      id: authority.planId,
      createdAt: CREATED
    });
    const repeatedRequest = beginConfigurationChangeRequest({
      root: happy,
      planId: authority.planId,
      id: authority.requestId,
      reason: 'Request confirmation for the exact selftest configuration candidate.',
      createdAt: CREATED,
      expiresAt: EXPIRES
    });
    const repeatedConfirmation = confirmConfigurationChangeRequest({
      root: happy,
      requestId: authority.requestId,
      id: authority.confirmationId,
      actor: { type: 'local-operator', id: 'operator.selftest' },
      reason: 'Confirm the exact selftest configuration candidate for local application.',
      confirmedAt: CONFIRMED
    });
    const repeatedExecution = prepareConfigurationChangeExecution({
      root: happy,
      confirmationId: authority.confirmationId,
      checkpointId: authority.checkpointId,
      at: '2026-07-16T16:00:00.000Z'
    });
    assert(repeatedPlan.plan.planFingerprint === authority.prepared.plan.planFingerprint
      && repeatedRequest.request.requestFingerprint === authority.request.request.requestFingerprint
      && repeatedConfirmation.confirmation.confirmationFingerprint
        === authority.confirmation.confirmation.confirmationFingerprint
      && repeatedExecution.checkpoint.state === 'completed',
    'Exact configuration transaction re-entry was not idempotent after completion and expiry.');
    let reuseRejected = false;
    try {
      prepareConfigurationChangeExecution({
        root: happy,
        confirmationId: authority.confirmationId,
        checkpointId: 'checkpoint.configuration.reuse-selftest',
        at: APPLIED
      });
    } catch (error) {
      reuseRejected = error.code === 'CONFIGURATION_CONFIRMATION_ALREADY_CONSUMED';
    }
    assert(reuseRejected, 'One-time configuration confirmation was reusable.');

    const optionMappings = copyRoot(root, 'soter-configuration-option-mappings-');
    roots.push(optionMappings);
    const taskConfigPath = path.join(
      optionMappings,
      'soter/configurations/task-capture.config.json'
    );
    const trackedTaskConfigurationText = fs.readFileSync(taskConfigPath, 'utf8');
    const trackedTaskLock = resolveConfiguration({
      root: optionMappings,
      configPath: taskConfigPath
    });
    const privateStatus = 'PRIVATE_PROVIDER_STATUS_CONFIGURATION_SENTINEL';
    const privateContext = 'PRIVATE_PROVIDER_CONTEXT_CONFIGURATION_SENTINEL';
    const taskCandidate = taskOptionMappingCandidate(
      optionMappings,
      privateStatus,
      privateContext
    );
    for (const [suffix, mutate] of [
      ['duplicate-option-scope', (value) => {
        const duplicate = structuredClone(
          value.settings['integration.notion'].optionMappings[0]
        );
        duplicate.entries = [{
          portable: 'In Progress',
          provider: 'PRIVATE_PROVIDER_STATUS_DUPLICATE_SCOPE_SENTINEL'
        }];
        value.settings['integration.notion'].optionMappings.push(duplicate);
      }],
      ['non-bijective-option-values', (value) => {
        value.settings['integration.notion'].optionMappings[0].entries.push({
          portable: 'In Progress',
          provider: privateStatus
        });
      }],
      ['unresolved-option-scope', (value) => {
        value.settings['integration.notion'].optionMappings[0].mapping
          = 'mapping.integration.notion.nonexistent';
      }],
      ['incomplete-option-scope-set', (value) => {
        value.settings['integration.notion'].optionMappings
          = value.settings['integration.notion'].optionMappings.filter((scope) => {
            return !(scope.mapping === 'mapping.integration.notion.tasks-records'
              && scope.recordType === 'task'
              && scope.field === 'context');
          });
      }],
      ['missing-option-scope-set', (value) => {
        delete value.settings['integration.notion'].optionMappings;
        value.settings['integration.notion'].targets.tasks
          = 'collection://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      }],
      ['trailing-option-control', (value) => {
        value.settings['integration.notion'].optionMappings[0].entries[0].provider
          = 'PRIVATE_PROVIDER_STATUS_TRAILING_CONTROL_SENTINEL\u007f';
      }]
    ]) {
      const invalidCandidate = structuredClone(taskCandidate);
      mutate(invalidCandidate);
      const invalidPlanId = 'configuration-change-plan.' + suffix;
      let rejected = false;
      try {
        prepareConfigurationChange({
          root: optionMappings,
          name: 'task-capture',
          candidateConfiguration: invalidCandidate,
          id: invalidPlanId,
          createdAt: CREATED
        });
      } catch (error) {
        rejected = error.code === 'CONFIGURATION_CANDIDATE_INVALID'
          && (suffix === 'trailing-option-control'
            ? /SOTER_PACK_SETTINGS_SCHEMA/.test(error.message)
            : /SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT/.test(error.message));
      }
      assert(rejected
        && !fs.existsSync(configurationChangePlanStatePath(
          optionMappings,
          invalidPlanId
        )),
      'Configuration planning admitted an invalid exact option bijection: ' + suffix + '.');
    }
    const optionAuthority = prepareAuthority(
      optionMappings,
      'option-mappings-selftest',
      taskCandidate,
      'task-capture'
    );
    const privatePlan = readJson(configurationChangePlanStatePath(
      optionMappings,
      optionAuthority.planId
    ));
    assert(JSON.stringify(privatePlan).includes(privateStatus)
      && JSON.stringify(privatePlan).includes(privateContext),
    'Private configuration plan did not retain the exact provider option values.');
    const optionInspection = inspectConfigurationChange({
      root: optionMappings,
      planId: optionAuthority.planId,
      requestId: optionAuthority.requestId,
      confirmationId: optionAuthority.confirmationId,
      consumptionId: optionAuthority.execution.consumption.id,
      checkpointId: optionAuthority.checkpointId,
      at: APPLIED
    });
    const sanitizedOptionDocuments = JSON.stringify({
      inspection: optionInspection,
      request: optionAuthority.request.request,
      checkpoint: optionAuthority.execution.checkpoint
    });
    assert(![
      privateStatus,
      privateContext,
      'PRIVATE_PROVIDER_PROJECT_TYPE_CONFIGURATION_SENTINEL',
      'PRIVATE_PROVIDER_PROJECT_STATUS_CONFIGURATION_SENTINEL'
    ].some((value) => sanitizedOptionDocuments.includes(value))
      && !sanitizedOptionDocuments.includes('optionMappings')
      && !sanitizedOptionDocuments.includes('.soter/state'),
    'Sanitized configuration authority exposed private provider option mappings.');
    const settingChanges = optionInspection.scope.changes.filter(
      (change) => change.category === 'setting'
    );
    assert(settingChanges.length === 1
      && settingChanges[0].id === 'configuration-change.setting.integration.notion'
      && settingChanges[0].beforeFingerprint === fingerprintJson(
        readJson(taskConfigPath).settings['integration.notion']
      )
      && settingChanges[0].afterFingerprint === fingerprintJson(
        taskCandidate.settings['integration.notion']
      )
      && !Object.hasOwn(settingChanges[0], 'before')
      && !Object.hasOwn(settingChanges[0], 'after'),
    'Private option mappings were not reduced to one exact fingerprint-only settings change.');
    const completedOptionMappings = executeConfigurationChange({
      root: optionMappings,
      checkpointId: optionAuthority.checkpointId,
      at: APPLIED
    });
    const activeTaskConfiguration = readPrivateConfigurationState(
      optionMappings,
      'task-capture'
    ).configuration;
    const activeTaskLock = readJson(activeConfigurationLockStatePath(
      optionMappings,
      'task-capture'
    ));
    assert(completedOptionMappings.state === 'completed'
      && fingerprintJson(activeTaskConfiguration) === fingerprintJson(taskCandidate)
      && fingerprintJson(
        activeTaskLock.settings['integration.notion'].optionMappings
      ) === fingerprintJson(
        taskCandidate.settings['integration.notion'].optionMappings
      )
      && fingerprintLock(activeTaskLock) !== fingerprintLock(trackedTaskLock)
      && fs.readFileSync(taskConfigPath, 'utf8') === trackedTaskConfigurationText,
    'Configuration transaction did not bind private option mappings without changing the tracked template.');
    assertPrivateModes(optionMappings, optionAuthority.planId, 'task-capture');

    const reservation = copyRoot(root, 'soter-configuration-reservation-');
    roots.push(reservation);
    const reservationAuthority = prepareAuthority(
      reservation,
      'reservation-selftest',
      candidate(reservation, 'reservation')
    );
    const consumptionPath = configurationChangeConsumptionStatePath(
      reservation,
      reservationAuthority.execution.consumption.id
    );
    const reservedConsumption = readJson(consumptionPath);
    reservedConsumption.updatedAt = reservedConsumption.createdAt;
    reservedConsumption.state = 'reserved';
    reservedConsumption.checkpointFingerprint = null;
    delete reservedConsumption.consumptionFingerprint;
    reservedConsumption.consumptionFingerprint = fingerprintJson(reservedConsumption);
    writeJson(consumptionPath, reservedConsumption);
    fs.rmSync(configurationTransactionCheckpointStatePath(
      reservation,
      reservationAuthority.checkpointId
    ));
    const resumedReservation = prepareConfigurationChangeExecution({
      root: reservation,
      confirmationId: reservationAuthority.confirmationId,
      checkpointId: reservationAuthority.checkpointId,
      at: APPLIED
    });
    assert(resumedReservation.consumption.state === 'started'
      && resumedReservation.checkpoint.state === 'prepared',
    'Crash recovery did not resume the same reserved one-time configuration start.');

    const stale = copyRoot(root, 'soter-configuration-stale-');
    roots.push(stale);
    const staleCandidate = candidate(stale, 'stale');
    writePrivateConfigurationState(stale, 'meeting-intake', readJson(
      path.join(stale, 'soter/configurations/meeting-intake.config.json')
    ));
    const staleCurrentLock = resolveConfiguration({
      root: stale,
      configPath: privateConfigurationStatePath(stale, 'meeting-intake')
    });
    writeActiveConfigurationLockState(stale, 'meeting-intake', {
      ...staleCurrentLock,
      graphFingerprint: 'sha256:' + '0'.repeat(64)
    });
    let activeLockRejected = false;
    try {
      prepareConfigurationChange({
        root: stale,
        name: 'meeting-intake',
        candidateConfiguration: staleCandidate,
        id: 'configuration-change-plan.active-lock-stale-selftest',
        createdAt: CREATED
      });
    } catch (error) {
      activeLockRejected = error.code === 'CONFIGURATION_ACTIVE_LOCK_STALE';
    }
    assert(activeLockRejected, 'A stale private active lock was silently replaced by a new plan.');
    removeActiveConfigurationLockState(stale, 'meeting-intake');
    removePrivateConfigurationState(stale, 'meeting-intake');
    const stalePlan = prepareConfigurationChange({
      root: stale,
      name: 'meeting-intake',
      candidateConfiguration: staleCandidate,
      id: 'configuration-change-plan.stale-selftest',
      createdAt: CREATED
    });
    const drifted = readJson(path.join(stale, 'soter/configurations/meeting-intake.config.json'));
    drifted.effectPolicies.read.reason = 'A different local edit makes the prepared exact configuration plan stale.';
    writeJson(path.join(stale, 'soter/configurations/meeting-intake.config.json'), drifted);
    let staleRejected = false;
    try {
      beginConfigurationChangeRequest({
        root: stale,
        planId: stalePlan.plan.id,
        id: 'configuration-change-request.stale-selftest',
        reason: 'This request must fail because its exact current configuration drifted.',
        createdAt: CREATED,
        expiresAt: EXPIRES
      });
    } catch (error) {
      staleRejected = error.code === 'CONFIGURATION_PLAN_STALE';
    }
    assert(staleRejected, 'Configuration drift did not invalidate the exact plan before request.');

    const expired = copyRoot(root, 'soter-configuration-expired-');
    roots.push(expired);
    const expiredPlan = prepareConfigurationChange({
      root: expired,
      name: 'meeting-intake',
      candidateConfiguration: candidate(expired, 'expired'),
      id: 'configuration-change-plan.expired-selftest',
      createdAt: CREATED
    });
    beginConfigurationChangeRequest({
      root: expired,
      planId: expiredPlan.plan.id,
      id: 'configuration-change-request.expired-selftest',
      reason: 'Exercise rejection of an expired exact configuration change request.',
      createdAt: CREATED,
      expiresAt: '2026-07-16T15:00:30.000Z'
    });
    let expiryRejected = false;
    try {
      confirmConfigurationChangeRequest({
        root: expired,
        requestId: 'configuration-change-request.expired-selftest',
        id: 'configuration-change-confirmation.expired-selftest',
        actor: { type: 'local-operator', id: 'operator.selftest' },
        reason: 'This confirmation is deliberately outside the exact request window.',
        confirmedAt: CONFIRMED
      });
    } catch (error) {
      expiryRejected = error.code === 'CONFIGURATION_REQUEST_EXPIRED';
    }
    assert(expiryRejected, 'Expired configuration request was confirmable.');

    const recovered = copyRoot(root, 'soter-configuration-recovery-');
    roots.push(recovered);
    const recoveryCandidate = candidate(recovered, 'recovery');
    const recoveryAuthority = prepareAuthority(recovered, 'recovery-selftest', recoveryCandidate);
    writePrivateConfigurationState(recovered, 'meeting-intake', recoveryCandidate);
    const recoveredCheckpoint = recoverConfigurationChange({
      root: recovered,
      checkpointId: recoveryAuthority.checkpointId,
      at: APPLIED
    });
    assert(recoveredCheckpoint.state === 'completed'
      && hasActiveLock(recovered, 'meeting-intake'),
    'Recovery did not complete a checkpoint after the candidate configuration write.');

    const rolledBack = copyRoot(root, 'soter-configuration-rollback-');
    roots.push(rolledBack);
    const rollbackCandidate = candidate(rolledBack, 'rollback');
    const rollbackAuthority = prepareAuthority(rolledBack, 'rollback-selftest', rollbackCandidate);
    const unknown = readJson(path.join(rolledBack, 'soter/configurations/meeting-intake.config.json'));
    unknown.host.reason = 'An unrecognized partial write must never be adopted as the prepared candidate.';
    writePrivateConfigurationState(rolledBack, 'meeting-intake', unknown);
    const rollbackCheckpoint = recoverConfigurationChange({
      root: rolledBack,
      checkpointId: rollbackAuthority.checkpointId,
      at: APPLIED
    });
    assert(rollbackCheckpoint.state === 'rolled-back'
      && fingerprintJson(readJson(path.join(rolledBack, 'soter/configurations/meeting-intake.config.json')))
        === fingerprintJson(originalConfiguration)
      && !fs.existsSync(privateConfigurationStatePath(rolledBack, 'meeting-intake'))
      && !fs.existsSync(activeConfigurationLockStatePath(rolledBack, 'meeting-intake')),
    'Unknown partial configuration state was not rolled back to the exact prior state.');

    const tampered = copyRoot(root, 'soter-configuration-tamper-');
    roots.push(tampered);
    const tamperedPlan = prepareConfigurationChange({
      root: tampered,
      name: 'meeting-intake',
      candidateConfiguration: candidate(tampered, 'tamper'),
      id: 'configuration-change-plan.tamper-selftest',
      createdAt: CREATED
    });
    const planPath = configurationChangePlanStatePath(tampered, tamperedPlan.plan.id);
    const invalidPlan = readJson(planPath);
    invalidPlan.candidateConfiguration.authorities[0].uri = 'notion://tampered-after-fingerprint';
    writeJson(planPath, invalidPlan);
    let tamperRejected = false;
    try {
      inspectConfigurationChange({
        root: tampered,
        planId: tamperedPlan.plan.id,
        at: APPLIED
      });
    } catch (error) {
      tamperRejected = error.code === 'CONFIGURATION_PLAN_TAMPERED';
    }
    assert(tamperRejected, 'Tampered private configuration plan was accepted.');

    const noFallback = copyRoot(root, 'soter-configuration-no-fallback-');
    roots.push(noFallback);
    const noFallbackCandidate = candidate(noFallback, 'no-fallback');
    const noFallbackAuthority = prepareAuthority(
      noFallback,
      'no-fallback-selftest',
      noFallbackCandidate
    );
    const activatedNoFallback = executeConfigurationChange({
      root: noFallback,
      checkpointId: noFallbackAuthority.checkpointId,
      at: APPLIED
    });
    assert(activatedNoFallback.state === 'completed',
      'No-fallback fixture did not activate its private desired configuration.');
    const driftedPrivate = structuredClone(noFallbackCandidate);
    driftedPrivate.host.reason = 'Private desired-state drift must invalidate the exact active lock.';
    writePrivateConfigurationState(noFallback, 'meeting-intake', driftedPrivate);
    let privateDriftRejected = false;
    try {
      prepareConfigurationChange({
        root: noFallback,
        name: 'meeting-intake',
        candidateConfiguration: candidate(noFallback, 'drift-replacement'),
        id: 'configuration-change-plan.private-drift-selftest',
        createdAt: CREATED
      });
    } catch (error) {
      privateDriftRejected = error.code === 'CONFIGURATION_ACTIVE_LOCK_STALE';
    }
    assert(privateDriftRejected,
      'Private desired-configuration drift did not invalidate its exact active lock.');
    writePrivateConfigurationState(noFallback, 'meeting-intake', noFallbackCandidate);
    removePrivateConfigurationState(noFallback, 'meeting-intake');
    let missingPrivateRejected = false;
    try {
      prepareConfigurationChange({
        root: noFallback,
        name: 'meeting-intake',
        candidateConfiguration: candidate(noFallback, 'missing-private'),
        id: 'configuration-change-plan.missing-private-selftest',
        createdAt: CREATED
      });
    } catch (error) {
      missingPrivateRejected = error.code === 'CONFIGURATION_PRIVATE_STATE_UNBOUND';
    }
    assert(missingPrivateRejected,
      'Missing private desired state silently fell back to the tracked template while an active lock existed.');
    let preparedWorkFallbackRejected = false;
    try {
      await prepareAutomationRun({
        root: noFallback,
        automationId: 'automation.meeting-intake',
        configurationName: 'meeting-intake',
        configurationBasis: 'private-active',
        input: {},
        createdAt: APPLIED
      });
    } catch (error) {
      preparedWorkFallbackRejected = /tracked fallback is prohibited/.test(error.message);
    }
    assert(preparedWorkFallbackRejected,
      'Prepared work silently used a tracked configuration after private desired state disappeared.');
    fs.writeFileSync(
      privateConfigurationStatePath(noFallback, 'meeting-intake'),
      '{not-json\n',
      { mode: 0o600 }
    );
    let malformedPrivateRejected = false;
    try {
      await prepareAutomationRun({
        root: noFallback,
        automationId: 'automation.meeting-intake',
        configurationName: 'meeting-intake',
        configurationBasis: 'private-active',
        input: {},
        createdAt: APPLIED
      });
    } catch (error) {
      malformedPrivateRejected = /tracked fallback is prohibited/.test(error.message);
    }
    assert(malformedPrivateRejected,
      'Malformed private desired state silently fell back to the tracked template.');

    const desiredWithoutLock = copyRoot(root, 'soter-configuration-desired-without-lock-');
    roots.push(desiredWithoutLock);
    writePrivateConfigurationState(
      desiredWithoutLock,
      'meeting-intake',
      candidate(desiredWithoutLock, 'desired-without-lock')
    );
    for (const configurationBasis of ['tracked-contained', 'private-active']) {
      let desiredWithoutLockRejected = false;
      try {
        await prepareAutomationRun({
          root: desiredWithoutLock,
          automationId: 'automation.meeting-intake',
          configurationName: 'meeting-intake',
          configurationBasis,
          input: {},
          createdAt: APPLIED
        });
      } catch (error) {
        desiredWithoutLockRejected = /must either both exist or both be absent/.test(error.message);
      }
      assert(desiredWithoutLockRejected,
        'Private desired state without an active lock silently selected '
          + configurationBasis + ' preparation.');
    }

    const permissionDrift = copyRoot(root, 'soter-configuration-permission-drift-');
    roots.push(permissionDrift);
    const permissionAuthority = prepareAuthority(
      permissionDrift,
      'permission-drift-selftest',
      candidate(permissionDrift, 'permission-drift')
    );
    executeConfigurationChange({
      root: permissionDrift,
      checkpointId: permissionAuthority.checkpointId,
      at: APPLIED
    });
    if (process.platform !== 'win32') {
      const privateFile = privateConfigurationStatePath(permissionDrift, 'meeting-intake');
      for (const unsafeMode of [0o644]) {
        fs.chmodSync(privateFile, unsafeMode);
        let permissionRejected = false;
        try {
          resolveConfiguration({
            root: permissionDrift,
            configPath: privateFile
          });
        } catch (error) {
          permissionRejected = error.code === 'CONFIGURATION_PRIVATE_STATE_PERMISSIONS_INVALID';
        }
        assert(permissionRejected,
          'Unsafe private desired-configuration mode ' + unsafeMode.toString(8) + ' was accepted.');
        fs.chmodSync(privateFile, 0o600);
      }
    }

    const replaceRollback = copyRoot(root, 'soter-configuration-private-rollback-');
    roots.push(replaceRollback);
    const firstAuthority = prepareAuthority(
      replaceRollback,
      'private-first-selftest',
      candidate(replaceRollback, 'private-first')
    );
    executeConfigurationChange({ root: replaceRollback, checkpointId: firstAuthority.checkpointId, at: APPLIED });
    const firstPrivate = readPrivateConfigurationState(
      replaceRollback,
      'meeting-intake'
    ).configuration;
    const firstActiveLock = readJson(activeConfigurationLockStatePath(replaceRollback, 'meeting-intake'));
    const secondAuthority = prepareAuthority(
      replaceRollback,
      'private-second-selftest',
      candidate(replaceRollback, 'private-second')
    );
    const unknownReplacement = structuredClone(firstPrivate);
    unknownReplacement.host.reason = 'An unknown private replacement must roll back to the exact prior private state.';
    writePrivateConfigurationState(replaceRollback, 'meeting-intake', unknownReplacement);
    const restoredPrivate = recoverConfigurationChange({
      root: replaceRollback,
      checkpointId: secondAuthority.checkpointId,
      at: APPLIED
    });
    assert(restoredPrivate.state === 'rolled-back'
      && fingerprintJson(readPrivateConfigurationState(replaceRollback, 'meeting-intake').configuration)
        === fingerprintJson(firstPrivate)
      && fingerprintLock(readJson(activeConfigurationLockStatePath(replaceRollback, 'meeting-intake')))
        === fingerprintLock(firstActiveLock),
    'Rollback did not restore the exact prior private desired configuration and active lock.');

    const persistedCheckpoint = readConfigurationTransactionCheckpointState(
      recovered,
      recoveryAuthority.checkpointId
    ).checkpoint;
    assert(!JSON.stringify(persistedCheckpoint).includes('notion://private-configuration'),
      'Checkpoint persisted private desired configuration values.');
    process.stdout.write('Configuration transaction selftest passed.\n');
    return true;
  } catch (error) {
    process.stderr.write('CONFIGURATION TRANSACTION SELFTEST FAIL: ' + (error.stack || error.message) + '\n');
    return false;
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
}

function hasActiveLock(root, name) {
  return fs.existsSync(activeConfigurationLockStatePath(root, name));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  selftestConfigurationTransactions().then((passed) => {
    if (!passed) process.exitCode = 1;
  });
}
