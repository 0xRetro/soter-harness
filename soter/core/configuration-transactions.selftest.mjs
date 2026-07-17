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
    version: '0.1.0',
    reason: 'Exercise the exact local configuration transaction through the declared Claude projection.'
  };
  value.authorities = value.authorities.map((authority) => authority.id === 'authority.crm.instance'
    ? { ...authority, uri: 'notion://private-configuration-' + marker }
    : authority);
  return value;
}

function prepareAuthority(root, suffix, candidateConfiguration) {
  const planId = 'configuration-change-plan.' + suffix;
  const requestId = 'configuration-change-request.' + suffix;
  const confirmationId = 'configuration-change-confirmation.' + suffix;
  const checkpointId = 'checkpoint.configuration.' + suffix;
  const prepared = prepareConfigurationChange({
    root,
    name: 'meeting-intake',
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
  assert((fs.statSync(planFile).mode & 0o777) === 0o600, 'Configuration plan is not mode 0600.');
  assert((fs.statSync(path.dirname(planFile)).mode & 0o777) === 0o700,
    'Configuration plan directory is not mode 0700.');
  const lockFile = activeConfigurationLockStatePath(root, configurationName);
  if (fs.existsSync(lockFile)) {
    assert((fs.statSync(lockFile).mode & 0o777) === 0o600, 'Active configuration lock is not mode 0600.');
    assert((fs.statSync(path.dirname(lockFile)).mode & 0o777) === 0o700,
      'Active configuration lock directory is not mode 0700.');
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
    const fixtureLockText = fs.readFileSync(fixtureLockPath, 'utf8');
    const privateMarker = 'HOSTILE_PRIVATE_CONFIGURATION_SENTINEL';
    const exactCandidate = candidate(happy, privateMarker);
    const authority = prepareAuthority(happy, 'happy-selftest', exactCandidate);
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
    const hostileInspection = structuredClone(beforeInspection);
    hostileInspection.configuration.candidateConfiguration = exactCandidate;
    hostileInspection.scope.changes[0].before = 'HOSTILE_RAW_BEFORE_SENTINEL';
    hostileInspection.scope.changes[0].after = 'HOSTILE_RAW_AFTER_SENTINEL';
    hostileInspection.scope.changes[0].uri = 'notion://HOSTILE_PRIVATE_URI_SENTINEL';
    const inspectionSchema = readJson(path.join(
      happy,
      'soter/contracts/configuration-change-inspection.schema.json'
    ));
    assert(validateJsonSchema(hostileInspection, inspectionSchema).length >= 4,
      'Sanitized configuration inspection schema accepted raw configuration escape fields.');
    const completed = executeConfigurationChange({
      root: happy,
      checkpointId: authority.checkpointId,
      at: APPLIED
    });
    assert(completed.state === 'completed', 'Exact configuration transaction did not complete.');
    assert(fingerprintJson(readJson(configPath)) === fingerprintJson(exactCandidate),
      'Exact candidate was not written to desired configuration.');
    const activeLock = readJson(activeConfigurationLockStatePath(happy, 'meeting-intake'));
    const resolved = resolveConfiguration({ root: happy, configPath });
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
    const staleCurrentLock = resolveConfiguration({
      root: stale,
      configPath: path.join(stale, 'soter/configurations/meeting-intake.config.json')
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
    writeJson(path.join(recovered, 'soter/configurations/meeting-intake.config.json'), recoveryCandidate);
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
    writeJson(path.join(rolledBack, 'soter/configurations/meeting-intake.config.json'), unknown);
    const rollbackCheckpoint = recoverConfigurationChange({
      root: rolledBack,
      checkpointId: rollbackAuthority.checkpointId,
      at: APPLIED
    });
    assert(rollbackCheckpoint.state === 'rolled-back'
      && fingerprintJson(readJson(path.join(rolledBack, 'soter/configurations/meeting-intake.config.json')))
        === fingerprintJson(originalConfiguration)
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
