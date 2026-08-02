#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackRelease } from '../kernel/distribution.mjs';
import { validateJsonSchema } from '../kernel/verify.mjs';
import { fingerprintJson } from './lib/canonical-json.mjs';
import {
  beginPackInstallRequest,
  confirmPackInstallRequest,
  executePackInstall,
  inspectPackInstall,
  PackInstallError,
  preparePackInstall,
  preparePackInstallExecution,
  recoverPackInstall
} from './pack-installs.mjs';
import {
  packInstallCheckpointStatePath,
  packInstallConsumptionStatePath,
  packInstallManagedManifestStatePath
} from './runtime-state.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(moduleDirectory, '..', '..');
const createdAt = '2026-07-16T12:00:00.000Z';
const confirmedAt = '2026-07-16T12:01:00.000Z';
const startedAt = '2026-07-16T12:02:00.000Z';
const executedAt = '2026-07-16T12:03:00.000Z';
const recoveredAt = '2026-07-16T12:04:00.000Z';
const requestExpiresAt = '2026-07-16T12:10:00.000Z';
const validUntil = '2026-07-16T12:20:00.000Z';
const distributionContracts = [
  'pack.schema.json',
  'pack-release.schema.json',
  'pack-release-inspection.schema.json',
  'evidence-v2.schema.json'
];

function writeJson(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  fs.chmodSync(file, mode);
}

function expectCode(code, action) {
  try {
    action();
  } catch (error) {
    assert(error instanceof PackInstallError, `${code}: expected PackInstallError, received ${error}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`${code}: expected operation to fail`);
}

function syntheticRelease(parent, root, {
  id,
  version,
  dependencies = [],
  artifacts = null,
  label = `${id}-${version}`
}) {
  const source = path.join(parent, 'sources', label);
  fs.mkdirSync(path.join(source, 'soter', 'contracts'), { recursive: true });
  for (const contract of distributionContracts) {
    fs.copyFileSync(
      path.join(root, 'soter', 'contracts', contract),
      path.join(source, 'soter', 'contracts', contract)
    );
  }
  writeJson(path.join(source, 'package.json'), { name: label, private: true });
  const suffix = id.slice(id.indexOf('.') + 1);
  const declared = artifacts || [
    {
      path: `soter/contexts/${suffix}/model.json`,
      role: 'definition',
      value: { id, version, privateValue: false, statement: `Contained ${id} ${version} model.` }
    }
  ];
  const manifest = {
    $contract: 'soter://contracts/pack/v1',
    contractVersion: '1.0.0',
    id,
    version,
    layer: 'context',
    releaseStage: 'experimental',
    evidenceMaturity: 'declared',
    summary: `Contained ${id} ${version} release used only by the pack install selftest.`,
    dependencies,
    capabilities: { requires: [], provides: [] },
    authorities: [],
    effects: [],
    artifacts: declared.map(({ path: artifactPath, role }) => ({ path: artifactPath, role })),
    compatibility: { baseContract: '^1.0.0', hosts: ['codex', 'claude'] },
    verification: { maxLevel: 'static', scenarios: [] }
  };
  const manifestFailures = validateJsonSchema(
    manifest,
    JSON.parse(fs.readFileSync(path.join(root, 'soter/contracts/pack.schema.json'), 'utf8'))
  );
  assert.equal(
    manifestFailures.length,
    0,
    manifestFailures.map((failure) => `${failure.path} ${failure.message}`).join('; ')
  );
  writeJson(path.join(source, 'soter', 'packs', id, 'pack.json'), manifest);
  for (const artifact of declared) writeJson(path.join(source, artifact.path), artifact.value);
  return buildPackRelease({
    root: source,
    pack: id,
    outputDirectory: path.join(parent, 'capsules'),
    createdAt
  });
}

function ids(label) {
  return {
    planId: `pack-install-plan.${label}`,
    requestId: `pack-install-request.${label}`,
    confirmationId: `pack-install-confirmation.${label}`,
    checkpointId: `checkpoint.pack-install.${label}`
  };
}

function prepareCeremony(root, targetRoot, capsulePaths, label, overrides = {}) {
  const references = ids(label);
  const plan = preparePackInstall({
    sourceRoot: root,
    targetRoot,
    capsulePaths,
    baseContract: '1.0.0',
    planId: references.planId,
    createdAt,
    validUntil,
    ...overrides
  });
  const request = beginPackInstallRequest({
    sourceRoot: root,
    targetRoot,
    planId: references.planId,
    requestId: references.requestId,
    reason: 'Review the exact contained local install plan.',
    createdAt,
    expiresAt: requestExpiresAt
  });
  const confirmation = confirmPackInstallRequest({
    sourceRoot: root,
    targetRoot,
    requestId: references.requestId,
    confirmationId: references.confirmationId,
    actor: 'operator.selftest',
    reason: 'Start only this exact contained local install plan.',
    confirmedAt
  });
  const started = preparePackInstallExecution({
    sourceRoot: root,
    targetRoot,
    confirmationId: references.confirmationId,
    checkpointId: references.checkpointId,
    at: startedAt
  });
  return { ...references, plan, request, confirmation, started };
}

function runInstall(root, targetRoot, capsulePaths, label) {
  const ceremony = prepareCeremony(root, targetRoot, capsulePaths, label);
  const inspection = executePackInstall({
    sourceRoot: root,
    targetRoot,
    checkpointId: ceremony.checkpointId,
    at: executedAt
  });
  assert.equal(inspection.checkpoint.state, 'completed');
  assert.equal(inspection.claims.localMaterialization, 'passed');
  assert.equal(inspection.claims.installedRegistry, 'passed');
  return { ...ceremony, inspection };
}

function reseal(value, property) {
  const updated = structuredClone(value);
  delete updated[property];
  updated[property] = fingerprintJson(updated);
  return updated;
}

function copyTarget(parent, source, label) {
  const target = path.join(parent, label);
  fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
  return target;
}

export async function selftestPackInstalls(root = defaultRoot) {
  const sourceRoot = fs.realpathSync(path.resolve(root));
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soter-pack-installs-'));
  try {
    const sharedV1 = {
      path: 'soter/contexts/install-base/model.json',
      role: 'definition',
      value: { id: 'context.install-base', version: '1.0.0', statement: 'PRIVATE_CANDIDATE_SENTINEL is sealed only in private plan bytes.' }
    };
    const obsoleteV1 = {
      path: 'soter/contexts/install-base/obsolete.json',
      role: 'projection',
      value: { state: 'obsolete', version: '1.0.0' }
    };
    const sharedV2 = {
      ...sharedV1,
      value: { id: 'context.install-base', version: '2.0.0', statement: 'Upgraded contained model.' }
    };
    const addedV2 = {
      path: 'soter/contexts/install-base/added.json',
      role: 'projection',
      value: { state: 'added', version: '2.0.0' }
    };
    const baseV1 = syntheticRelease(temporary, sourceRoot, {
      id: 'context.install-base', version: '1.0.0', artifacts: [sharedV1, obsoleteV1]
    });
    const baseV2 = syntheticRelease(temporary, sourceRoot, {
      id: 'context.install-base', version: '2.0.0', artifacts: [sharedV2, addedV2]
    });
    const baseV0 = syntheticRelease(temporary, sourceRoot, {
      id: 'context.install-base', version: '0.9.0', artifacts: [{ ...sharedV1, value: { version: '0.9.0' } }]
    });
    const requiredConsumer = syntheticRelease(temporary, sourceRoot, {
      id: 'context.install-consumer', version: '1.0.0',
      dependencies: [{ pack: 'context.install-base', version: '^1.0.0', optional: false, reason: 'The contained consumer requires its exact base context.' }]
    });
    const optionalConsumer = syntheticRelease(temporary, sourceRoot, {
      id: 'context.install-optional-consumer', version: '1.0.0',
      dependencies: [{ pack: 'context.install-optional-peer', version: '^1.0.0', optional: true, reason: 'The contained peer adds optional review context.' }]
    });
    const incompatibleOptional = syntheticRelease(temporary, sourceRoot, {
      id: 'context.install-optional-peer', version: '2.0.0'
    });

    const installTarget = path.join(temporary, 'target-install');
    fs.mkdirSync(installTarget);
    const first = runInstall(sourceRoot, installTarget, [baseV1.capsulePath], 'create');
    assert.equal(first.plan.plan.effects.some((effect) => Object.hasOwn(effect, 'path')), false);
    assert.equal(fs.existsSync(path.join(installTarget, sharedV1.path)), true);
    assert.equal(fs.existsSync(path.join(installTarget, obsoleteV1.path)), true);
    assert.equal((fs.statSync(packInstallManagedManifestStatePath(installTarget)).mode & 0o777), 0o600);
    assert.equal(
      executePackInstall({ sourceRoot, targetRoot: installTarget, checkpointId: first.checkpointId, at: executedAt }).checkpoint.state,
      'completed'
    );
    expectCode('PACK_INSTALL_CONFIRMATION_CONSUMED', () => preparePackInstallExecution({
      sourceRoot,
      targetRoot: installTarget,
      confirmationId: first.confirmationId,
      checkpointId: 'checkpoint.pack-install.reuse-blocked',
      at: startedAt
    }));

    const upgraded = runInstall(sourceRoot, installTarget, [baseV2.capsulePath], 'upgrade');
    const actions = new Set(upgraded.plan.plan.effects.map((effect) => effect.action));
    assert.deepEqual(actions, new Set(['create', 'replace', 'remove']));
    assert.equal(fs.existsSync(path.join(installTarget, obsoleteV1.path)), false);
    assert.equal(fs.existsSync(path.join(installTarget, addedV2.path)), true);
    expectCode('PACK_INSTALL_DOWNGRADE_UNSUPPORTED', () => preparePackInstall({
      sourceRoot,
      targetRoot: installTarget,
      capsulePaths: [baseV0.capsulePath],
      baseContract: '1.0.0',
      planId: 'pack-install-plan.downgrade',
      createdAt,
      validUntil
    }));

    const requiredTarget = path.join(temporary, 'target-required');
    fs.mkdirSync(requiredTarget);
    expectCode('PACK_INSTALL_DEPENDENCY_MISSING', () => preparePackInstall({
      sourceRoot,
      targetRoot: requiredTarget,
      capsulePaths: [requiredConsumer.capsulePath],
      baseContract: '1.0.0',
      planId: 'pack-install-plan.required-missing',
      createdAt,
      validUntil
    }));
    const optionalTarget = path.join(temporary, 'target-optional');
    fs.mkdirSync(optionalTarget);
    const optional = preparePackInstall({
      sourceRoot,
      targetRoot: optionalTarget,
      capsulePaths: [optionalConsumer.capsulePath],
      baseContract: '1.0.0',
      planId: 'pack-install-plan.optional-absent',
      createdAt,
      validUntil
    });
    assert.equal(optional.plan.dependencyCheck.rows[0].state, 'degraded');
    assert.equal(optional.plan.dependencyCheck.rows[0].reasonCode, 'PACK_INSTALL_OPTIONAL_DEPENDENCY_ABSENT');
    const incompatibleTarget = path.join(temporary, 'target-optional-incompatible');
    fs.mkdirSync(incompatibleTarget);
    expectCode('PACK_INSTALL_DEPENDENCY_VERSION_MISMATCH', () => preparePackInstall({
      sourceRoot,
      targetRoot: incompatibleTarget,
      capsulePaths: [optionalConsumer.capsulePath, incompatibleOptional.capsulePath],
      baseContract: '1.0.0',
      planId: 'pack-install-plan.optional-incompatible',
      createdAt,
      validUntil
    }));

    const collisionPath = 'soter/contexts/shared-collision/model.json';
    const collisionA = syntheticRelease(temporary, sourceRoot, {
      id: 'context.install-collision-a', version: '1.0.0',
      artifacts: [{ path: collisionPath, role: 'definition', value: { owner: 'a' } }]
    });
    const collisionB = syntheticRelease(temporary, sourceRoot, {
      id: 'context.install-collision-b', version: '1.0.0',
      artifacts: [{ path: collisionPath, role: 'definition', value: { owner: 'b' } }]
    });
    const collisionTarget = path.join(temporary, 'target-cross-pack');
    fs.mkdirSync(collisionTarget);
    expectCode('PACK_INSTALL_CROSS_PACK_COLLISION', () => preparePackInstall({
      sourceRoot,
      targetRoot: collisionTarget,
      capsulePaths: [collisionA.capsulePath, collisionB.capsulePath],
      baseContract: '1.0.0',
      planId: 'pack-install-plan.cross-pack',
      createdAt,
      validUntil
    }));
    const unmanagedTarget = path.join(temporary, 'target-unmanaged');
    writeJson(path.join(unmanagedTarget, sharedV1.path), { unmanaged: true });
    expectCode('PACK_INSTALL_UNMANAGED_COLLISION', () => preparePackInstall({
      sourceRoot,
      targetRoot: unmanagedTarget,
      capsulePaths: [baseV1.capsulePath],
      baseContract: '1.0.0',
      planId: 'pack-install-plan.unmanaged',
      createdAt,
      validUntil
    }));

    const actualTarget = path.join(temporary, 'target-real');
    const linkedTarget = path.join(temporary, 'target-link');
    fs.mkdirSync(actualTarget);
    fs.symlinkSync(actualTarget, linkedTarget);
    expectCode('PACK_INSTALL_TARGET_SYMLINK_REJECTED', () => preparePackInstall({
      sourceRoot,
      targetRoot: linkedTarget,
      capsulePaths: [baseV1.capsulePath],
      baseContract: '1.0.0',
      planId: 'pack-install-plan.symlink-target',
      createdAt,
      validUntil
    }));

    const hardlinkTarget = path.join(temporary, 'target-hardlink');
    fs.mkdirSync(hardlinkTarget);
    runInstall(sourceRoot, hardlinkTarget, [baseV1.capsulePath], 'hardlink-base');
    const managedHardlink = path.join(hardlinkTarget, sharedV1.path);
    const externalHardlink = path.join(temporary, 'external-hardlink.json');
    fs.copyFileSync(managedHardlink, externalHardlink);
    fs.chmodSync(externalHardlink, 0o600);
    fs.unlinkSync(managedHardlink);
    fs.linkSync(externalHardlink, managedHardlink);
    expectCode('PACK_INSTALL_OUTPUT_INVALID', () => preparePackInstall({
      sourceRoot,
      targetRoot: hardlinkTarget,
      capsulePaths: [baseV2.capsulePath],
      baseContract: '1.0.0',
      planId: 'pack-install-plan.hardlink-rejected',
      createdAt,
      validUntil
    }));
    assert.equal((fs.statSync(externalHardlink).mode & 0o777), 0o600);

    const specialModeTarget = path.join(temporary, 'target-special-mode');
    fs.mkdirSync(specialModeTarget);
    runInstall(sourceRoot, specialModeTarget, [baseV1.capsulePath], 'special-mode-base');
    fs.chmodSync(path.join(specialModeTarget, sharedV1.path), 0o1644);
    expectCode('PACK_INSTALL_OUTPUT_MODE_INVALID', () => preparePackInstall({
      sourceRoot,
      targetRoot: specialModeTarget,
      capsulePaths: [baseV2.capsulePath],
      baseContract: '1.0.0',
      planId: 'pack-install-plan.special-mode-rejected',
      createdAt,
      validUntil
    }));

    const expiryTarget = path.join(temporary, 'target-expiry');
    fs.mkdirSync(expiryTarget);
    preparePackInstall({
      sourceRoot,
      targetRoot: expiryTarget,
      capsulePaths: [baseV1.capsulePath],
      baseContract: '1.0.0',
      planId: 'pack-install-plan.expiry',
      createdAt,
      validUntil: '2026-07-16T12:01:00.000Z'
    });
    expectCode('PACK_INSTALL_REQUEST_WINDOW_INVALID', () => beginPackInstallRequest({
      sourceRoot,
      targetRoot: expiryTarget,
      planId: 'pack-install-plan.expiry',
      requestId: 'pack-install-request.expiry',
      reason: 'This request is deliberately too late.',
      createdAt: '2026-07-16T12:02:00.000Z',
      expiresAt: '2026-07-16T12:03:00.000Z'
    }));
    assert.equal(inspectPackInstall({
      sourceRoot,
      targetRoot: expiryTarget,
      planId: 'pack-install-plan.expiry',
      at: '2026-07-16T12:02:00.000Z'
    }).resume.reasonCode, 'PACK_INSTALL_PLAN_EXPIRED');

    const reservedTarget = path.join(temporary, 'target-reserved-reentry');
    fs.mkdirSync(reservedTarget);
    const reserved = prepareCeremony(sourceRoot, reservedTarget, [baseV1.capsulePath], 'reserved-reentry');
    const consumptionPath = packInstallConsumptionStatePath(
      reservedTarget,
      `pack-install-consumption.${reserved.confirmationId.slice('pack-install-confirmation.'.length)}`
    );
    const checkpointPath = packInstallCheckpointStatePath(reservedTarget, reserved.checkpointId);
    const startedConsumption = JSON.parse(fs.readFileSync(consumptionPath, 'utf8'));
    const restoredReservation = reseal({
      ...startedConsumption,
      updatedAt: startedConsumption.createdAt,
      state: 'reserved',
      checkpointFingerprint: null
    }, 'consumptionFingerprint');
    fs.rmSync(checkpointPath);
    writeJson(consumptionPath, restoredReservation, 0o600);
    const resumedStart = preparePackInstallExecution({
      sourceRoot,
      targetRoot: reservedTarget,
      confirmationId: reserved.confirmationId,
      checkpointId: reserved.checkpointId,
      at: startedAt
    });
    assert.equal(resumedStart.consumption.state, 'started');
    assert.equal(resumedStart.checkpoint.state, 'prepared');

    const crashMarkers = [
      'directory:0:before-write',
      'directory:0:write',
      'file:0:before-write',
      'file:0:write',
      'file:0:checkpoint',
      'manifest:before-write',
      'manifest:write'
    ];
    for (const [index, marker] of crashMarkers.entries()) {
      const target = path.join(temporary, `target-crash-${index}`);
      fs.mkdirSync(target);
      const ceremony = prepareCeremony(sourceRoot, target, [baseV1.capsulePath], `crash-${index}`);
      expectCode('PACK_INSTALL_FAULT_INJECTED', () => executePackInstall({
        sourceRoot,
        targetRoot: target,
        checkpointId: ceremony.checkpointId,
        at: executedAt,
        faultAfter: marker
      }));
      const recovered = recoverPackInstall({
        sourceRoot,
        targetRoot: target,
        checkpointId: ceremony.checkpointId,
        at: recoveredAt
      });
      assert.equal(recovered.checkpoint.state, 'completed', marker);
      assert.equal(recovered.claims.installedRegistry, 'passed', marker);
    }

    const executionFailureTarget = path.join(temporary, 'target-filesystem-execution-failure');
    fs.mkdirSync(executionFailureTarget);
    const executionFailure = prepareCeremony(
      sourceRoot,
      executionFailureTarget,
      [baseV1.capsulePath],
      'filesystem-execution-failure'
    );
    expectCode('PACK_INSTALL_FAULT_INJECTED', () => executePackInstall({
      sourceRoot,
      targetRoot: executionFailureTarget,
      checkpointId: executionFailure.checkpointId,
      at: executedAt,
      faultAfter: 'file:0:write'
    }));
    const executionFailureOutput = path.join(executionFailureTarget, sharedV1.path);
    const originalLstatSync = fs.lstatSync;
    try {
      fs.lstatSync = function guardedLstatSync(file, options) {
        if (path.resolve(file) === executionFailureOutput) {
          const error = new Error('Contained filesystem permission failure.');
          error.code = 'EACCES';
          throw error;
        }
        return originalLstatSync.call(fs, file, options);
      };
      expectCode('PACK_INSTALL_EXECUTION_FAILED', () => executePackInstall({
        sourceRoot,
        targetRoot: executionFailureTarget,
        checkpointId: executionFailure.checkpointId,
        at: executedAt
      }));
    } finally {
      fs.lstatSync = originalLstatSync;
    }
    const executionFailureInspection = inspectPackInstall({
      sourceRoot,
      targetRoot: executionFailureTarget,
      checkpointId: executionFailure.checkpointId,
      at: recoveredAt
    });
    assert.equal(executionFailureInspection.checkpoint.state, 'needs-attention');
    assert.equal(
      executionFailureInspection.checkpoint.reasonCode,
      'PACK_INSTALL_ROLLBACK_FAILED'
    );
    assert(!JSON.stringify(executionFailureInspection).includes('EACCES'));

    const recoveryFailureTarget = path.join(temporary, 'target-filesystem-recovery-failure');
    fs.mkdirSync(recoveryFailureTarget);
    const recoveryFailure = prepareCeremony(
      sourceRoot,
      recoveryFailureTarget,
      [baseV1.capsulePath],
      'filesystem-recovery-failure'
    );
    expectCode('PACK_INSTALL_FAULT_INJECTED', () => executePackInstall({
      sourceRoot,
      targetRoot: recoveryFailureTarget,
      checkpointId: recoveryFailure.checkpointId,
      at: executedAt,
      faultAfter: 'file:0:write'
    }));
    const recoveryFailureOutput = path.join(recoveryFailureTarget, sharedV1.path);
    try {
      fs.lstatSync = function guardedLstatSync(file, options) {
        if (path.resolve(file) === recoveryFailureOutput) {
          const error = new Error('Contained filesystem permission failure.');
          error.code = 'EPERM';
          throw error;
        }
        return originalLstatSync.call(fs, file, options);
      };
      expectCode('PACK_INSTALL_RECOVERY_FAILED', () => recoverPackInstall({
        sourceRoot,
        targetRoot: recoveryFailureTarget,
        checkpointId: recoveryFailure.checkpointId,
        at: recoveredAt
      }));
    } finally {
      fs.lstatSync = originalLstatSync;
    }
    const recoveryFailureInspection = inspectPackInstall({
      sourceRoot,
      targetRoot: recoveryFailureTarget,
      checkpointId: recoveryFailure.checkpointId,
      at: recoveredAt
    });
    assert.equal(recoveryFailureInspection.checkpoint.state, 'needs-attention');
    assert.equal(
      recoveryFailureInspection.checkpoint.reasonCode,
      'PACK_INSTALL_RECOVERY_FAILED'
    );
    assert(!JSON.stringify(recoveryFailureInspection).includes('EPERM'));

    const attentionTarget = path.join(temporary, 'target-needs-attention');
    fs.mkdirSync(attentionTarget);
    const attention = prepareCeremony(sourceRoot, attentionTarget, [baseV1.capsulePath], 'needs-attention');
    expectCode('PACK_INSTALL_FAULT_INJECTED', () => executePackInstall({
      sourceRoot,
      targetRoot: attentionTarget,
      checkpointId: attention.checkpointId,
      at: executedAt,
      faultAfter: 'file:0:write'
    }));
    const checkpointDocument = JSON.parse(fs.readFileSync(
      packInstallCheckpointStatePath(attentionTarget, attention.checkpointId),
      'utf8'
    ));
    const attentionCheckpoint = reseal({
      ...checkpointDocument,
      state: 'needs-attention',
      reasonCode: 'PACK_INSTALL_RECOVERY_REQUIRED',
      blocker: { state: 'present', reasonCode: 'PACK_INSTALL_RECOVERY_REQUIRED' }
    }, 'checkpointFingerprint');
    writeJson(packInstallCheckpointStatePath(attentionTarget, attention.checkpointId), attentionCheckpoint, 0o600);
    fs.writeFileSync(path.join(attentionTarget, sharedV1.path), '{"hostile":"ROLLBACK_DRIFT_SENTINEL"}\n');
    fs.chmodSync(path.join(attentionTarget, sharedV1.path), 0o644);
    expectCode('PACK_INSTALL_ROLLBACK_OUTPUT_DRIFT', () => recoverPackInstall({
      sourceRoot,
      targetRoot: attentionTarget,
      checkpointId: attention.checkpointId,
      at: recoveredAt
    }));
    const needsAttention = inspectPackInstall({
      sourceRoot,
      targetRoot: attentionTarget,
      checkpointId: attention.checkpointId,
      at: recoveredAt
    });
    assert.equal(needsAttention.checkpoint.state, 'needs-attention');
    assert.equal(needsAttention.resume.classification, 'requires-review');

    const serializedInspection = JSON.stringify(first.plan);
    assert.equal(serializedInspection.includes(temporary), false);
    assert.equal(serializedInspection.includes(baseV1.capsulePath), false);
    assert.equal(serializedInspection.includes('PRIVATE_CANDIDATE_SENTINEL'), false);
    assert.equal(serializedInspection.includes('content'), false);
    const inspectionSchema = JSON.parse(fs.readFileSync(
      path.join(sourceRoot, 'soter/contracts/pack-install-inspection.schema.json'),
      'utf8'
    ));
    assert.equal(validateJsonSchema(first.plan, inspectionSchema).length, 0);
    const hostileInspection = structuredClone(first.plan);
    hostileInspection.plan.effects[0].path = '/private/target/PATH_SENTINEL';
    assert(validateJsonSchema(hostileInspection, inspectionSchema).length > 0);
    const implementation = fs.readFileSync(path.join(sourceRoot, 'soter/core/pack-installs.mjs'), 'utf8');
    assert.equal(/node:(?:http|https|net|child_process)/.test(implementation), false);
    assert.equal(/\b(?:fetch|spawn|execFile|npm|pnpm|yarn)\s*\(/.test(implementation), false);

    process.stdout.write(
      'Pack install selftest: exact local create/upgrade/remove, dependencies, collision and path safety, '
        + 'expiring confirmation, single-use start, crash recovery, rollback attention, privacy, and zero network/package-manager effects passed.\n'
    );
    return true;
  } catch (error) {
    process.stderr.write(`Pack install selftest failed${error?.code ? ` [${error.code}]` : ''}: ${error?.stack || error}\n`);
    return false;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await selftestPackInstalls(defaultRoot) ? 0 : 1;
}
