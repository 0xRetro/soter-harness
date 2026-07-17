import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  beginHostRealizationRequest,
  confirmHostRealizationRequest,
  executeHostRealization,
  inspectHostRealization,
  prepareHostRealization,
  prepareHostRealizationExecution,
  recoverHostRealization
} from './host-realizations.mjs';
import { renderHostProjectionCandidates } from './host-projections.mjs';
import { fingerprintLock, resolveConfiguration } from './resolve.mjs';
import {
  activeConfigurationLockStatePath,
  hostManagedManifestStatePath,
  hostRealizationCheckpointStatePath,
  hostRealizationConfirmationStatePath,
  hostRealizationConsumptionStatePath,
  hostRealizationPlanStatePath,
  hostRealizationRequestStatePath,
  readHostManagedManifestState,
  writeActiveConfigurationLockState,
  writeHostManagedManifestState
} from './runtime-state.mjs';
import { fingerprintJson, readJson, sha256 } from './lib/canonical-json.mjs';
import { validateJsonSchema } from '../kernel/verify.mjs';

const CREATED = '2026-07-16T12:00:00.000Z';
const CONFIRMED = '2026-07-16T12:05:00.000Z';
const STARTED = '2026-07-16T12:06:00.000Z';
const EXECUTED = '2026-07-16T12:07:00.000Z';
const VALID_UNTIL = '2026-07-16T13:00:00.000Z';

function copyRuntime(sourceRoot, label) {
  const root = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    'soter-host-realization-' + label + '-'
  ));
  fs.cpSync(path.join(sourceRoot, 'soter'), path.join(root, 'soter'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(root, 'package.json'));
  fs.copyFileSync(path.join(sourceRoot, 'package-lock.json'), path.join(root, 'package-lock.json'));
  for (const name of fs.readdirSync(path.join(root, 'soter/migrations'))) {
    if (!name.endsWith('.json')) continue;
    const migration = readJson(path.join(root, 'soter/migrations', name));
    for (const item of migration.items || []) {
      const source = path.join(sourceRoot, item.sourcePath);
      const target = path.join(root, item.sourcePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
  return root;
}

function activate(root, configurationName) {
  const configPath = 'soter/configurations/' + configurationName + '.config.json';
  const lock = resolveConfiguration({ root, configPath });
  writeActiveConfigurationLockState(root, configurationName, lock);
  return lock;
}

function authorizePlan(root, label, plan, times = {}) {
  const createdAt = times.createdAt || CREATED;
  const confirmedAt = times.confirmedAt || CONFIRMED;
  const startedAt = times.startedAt || STARTED;
  const request = beginHostRealizationRequest({
    root,
    planId: plan.id,
    id: 'host-realization-request.' + label,
    reason: 'Confirm the exact contained host projection plan.',
    createdAt,
    expiresAt: times.requestExpiresAt || '2026-07-16T12:30:00.000Z'
  }).request;
  const confirmation = confirmHostRealizationRequest({
    root,
    requestId: request.id,
    id: 'host-realization-confirmation.' + label,
    actor: { type: 'local-operator', id: 'operator.selftest' },
    reason: 'Confirm the exact contained host projection scope.',
    confirmedAt
  }).confirmation;
  const execution = prepareHostRealizationExecution({
    root,
    confirmationId: confirmation.id,
    checkpointId: 'checkpoint.host-realization.' + label,
    at: startedAt
  });
  return { plan, request, confirmation, execution };
}

function authority(root, label, configurationName = 'meeting-intake', times = {}) {
  const plan = prepareHostRealization({
    root,
    configurationName,
    id: 'host-realization-plan.' + label,
    createdAt: times.createdAt || CREATED,
    validUntil: times.validUntil || VALID_UNTIL
  }).plan;
  return authorizePlan(root, label, plan, times);
}

function assertMode(file, expected) {
  if (process.platform === 'win32') return;
  assert.equal((fs.statSync(file).mode & 0o777).toString(8).padStart(4, '0'), expected);
}

function resealManifest(manifest) {
  manifest.manifestFingerprint = null;
  const unsigned = { ...manifest };
  delete unsigned.manifestFingerprint;
  manifest.manifestFingerprint = fingerprintJson(unsigned);
  return manifest;
}

function resealPlan(plan) {
  plan.scopeFingerprint = fingerprintJson(plan.operations.map((operation) => ({
    id: operation.id,
    sequence: operation.sequence,
    action: operation.action,
    path: operation.path,
    role: operation.role,
    mode: operation.after.mode,
    beforeFingerprint: operation.before.fingerprint,
    afterFingerprint: operation.after.fingerprint
  })));
  plan.planFingerprint = null;
  const unsigned = { ...plan };
  delete unsigned.planFingerprint;
  plan.planFingerprint = fingerprintJson(unsigned);
  return plan;
}

export async function selftestHostRealizations(sourceRoot) {
  const roots = [];
  try {
    const independence = copyRuntime(sourceRoot, 'candidate-independence');
    roots.push(independence);
    const firstLock = resolveConfiguration({
      root: independence,
      configPath: 'soter/configurations/meeting-intake.config.json'
    });
    fs.writeFileSync(path.join(independence, 'AGENTS.md'), 'HOSTILE_DEVELOPMENT_GUIDANCE\n');
    fs.mkdirSync(path.join(independence, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(independence, '.codex/config.toml'), 'HOSTILE_DEVELOPMENT_CONFIG\n');
    const secondLock = resolveConfiguration({
      root: independence,
      configPath: 'soter/configurations/meeting-intake.config.json'
    });
    assert.equal(
      fingerprintLock(secondLock),
      fingerprintLock(firstLock),
      'Resolved host candidates depended on current developer projection bytes.'
    );
    writeActiveConfigurationLockState(independence, 'meeting-intake', secondLock);
    assert.throws(
      () => prepareHostRealization({
        root: independence,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.collision',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_UNMANAGED_COLLISION'
    );

    const credentialTemplate = copyRuntime(sourceRoot, 'credential-template');
    roots.push(credentialTemplate);
    fs.appendFileSync(
      path.join(credentialTemplate, 'soter/hosts/codex/templates/AGENTS.md.tmpl'),
      'sk-' + 'HOSTILECREDENTIALMATERIAL1234567890\n'
    );
    assert.throws(
      () => resolveConfiguration({
        root: credentialTemplate,
        configPath: 'soter/configurations/meeting-intake.config.json'
      }),
      (error) => error.code === 'HOST_PROJECTION_CREDENTIAL_REJECTED'
    );

    const redirected = copyRuntime(sourceRoot, 'redirected-plan');
    roots.push(redirected);
    activate(redirected, 'meeting-intake');
    const redirectedPlan = prepareHostRealization({
      root: redirected,
      configurationName: 'meeting-intake',
      id: 'host-realization-plan.redirected',
      createdAt: CREATED,
      validUntil: VALID_UNTIL
    }).plan;
    redirectedPlan.operations[0].path = 'HOSTILE-redirected-output';
    fs.writeFileSync(
      hostRealizationPlanStatePath(redirected, redirectedPlan.id),
      JSON.stringify(resealPlan(redirectedPlan), null, 2) + '\n',
      { mode: 0o600 }
    );
    assert.throws(
      () => beginHostRealizationRequest({
        root: redirected,
        planId: redirectedPlan.id,
        id: 'host-realization-request.redirected',
        reason: 'Reject the re-signed operation that no longer matches exact ownership.',
        createdAt: CREATED,
        expiresAt: '2026-07-16T12:30:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_PLAN_TAMPERED'
    );

    const happy = copyRuntime(sourceRoot, 'happy');
    roots.push(happy);
    const lock = activate(happy, 'meeting-intake');
    const exact = authority(happy, 'happy');
    for (const file of [
      hostRealizationPlanStatePath(happy, exact.plan.id),
      hostRealizationRequestStatePath(happy, exact.request.id),
      hostRealizationConfirmationStatePath(happy, exact.confirmation.id),
      hostRealizationConsumptionStatePath(happy, exact.execution.consumption.id),
      hostRealizationCheckpointStatePath(happy, exact.execution.checkpoint.id)
    ]) {
      assertMode(file, '0600');
      assertMode(path.dirname(file), '0700');
    }
    const inspection = inspectHostRealization({
      root: happy,
      planId: exact.plan.id,
      requestId: exact.request.id,
      confirmationId: exact.confirmation.id,
      consumptionId: exact.execution.consumption.id,
      checkpointId: exact.execution.checkpoint.id,
      at: STARTED
    });
    assert.equal(inspection.resume.permittedNextAction, 'execute-checkpoint');
    assert.equal(inspection.confirmation.actor, 'operator.selftest');
    assert(!JSON.stringify(inspection).includes(happy)
      && !JSON.stringify(inspection).includes('Soter host projection'),
    'Sanitized host inspection exposed the private target path or candidate bytes.');
    const hostileInspection = structuredClone(inspection);
    hostileInspection.target.path = '/private/HOSTILE_TARGET_SENTINEL';
    hostileInspection.scope.outputs[0].content = 'HOSTILE_RAW_OUTPUT_SENTINEL';
    hostileInspection.scope.outputs[0].before = 'HOSTILE_RAW_BEFORE_SENTINEL';
    const inspectionSchema = readJson(path.join(
      happy,
      'soter/contracts/host-realization-inspection.schema.json'
    ));
    assert(validateJsonSchema(hostileInspection, inspectionSchema).length >= 3,
      'Sanitized host inspection accepted private target or raw output escape fields.');
    const completed = executeHostRealization({
      root: happy,
      checkpointId: exact.execution.checkpoint.id,
      at: EXECUTED
    });
    assert.equal(completed.state, 'completed');
    const adapter = readJson(path.join(happy, 'soter/hosts/codex/adapter.json'));
    const rendered = renderHostProjectionCandidates({
      root: happy,
      adapter,
      configurationId: lock.configuration.name,
      packIds: lock.packs.map((pack) => pack.id),
      capabilityIds: lock.capabilities.map((capability) => capability.id)
    });
    for (const output of rendered.outputs) {
      const file = path.join(happy, output.path);
      assert.equal(fs.readFileSync(file, 'utf8'), output.content);
      assertMode(file, '0644');
    }
    assertMode(path.join(happy, '.codex'), '0755');
    assertMode(activeConfigurationLockStatePath(happy, 'meeting-intake'), '0600');
    assertMode(hostManagedManifestStatePath(happy, 'codex'), '0600');
    const after = inspectHostRealization({
      root: happy,
      planId: exact.plan.id,
      requestId: exact.request.id,
      confirmationId: exact.confirmation.id,
      consumptionId: exact.execution.consumption.id,
      checkpointId: exact.execution.checkpoint.id,
      at: EXECUTED
    });
    assert.equal(after.claims.localProjection, 'passed');
    assert.equal(after.claims.hostLaunch, 'unknown');
    assert.equal(after.claims.authentication, 'unknown');
    assert.equal(after.claims.connectedBehavior, 'unknown');
    assert.throws(
      () => prepareHostRealization({
        root: happy,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.already-current',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_ALREADY_CURRENT'
    );

    const switchedLock = activate(happy, 'project-pulse');
    const switched = authority(happy, 'switch', 'project-pulse');
    assert(switched.plan.operations.some((operation) => operation.action === 'replace'));
    const switchedCompleted = executeHostRealization({
      root: happy,
      checkpointId: switched.execution.checkpoint.id,
      at: EXECUTED
    });
    assert.equal(switchedCompleted.state, 'completed');
    const switchedManifest = readHostManagedManifestState(happy, 'codex').manifest;
    assert.equal(switchedManifest.configuration.lockFingerprint, fingerprintLock(switchedLock));

    const drift = copyRuntime(sourceRoot, 'managed-drift');
    roots.push(drift);
    activate(drift, 'meeting-intake');
    const driftInitial = authority(drift, 'managed-drift-initial');
    executeHostRealization({ root: drift, checkpointId: driftInitial.execution.checkpoint.id, at: EXECUTED });
    fs.writeFileSync(path.join(drift, 'AGENTS.md'), 'HOSTILE_LOCAL_EDIT_SENTINEL\n', { mode: 0o644 });
    assert.throws(
      () => prepareHostRealization({
        root: drift,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.managed-drift',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_MANAGED_DRIFT'
    );

    const crash = copyRuntime(sourceRoot, 'crash');
    roots.push(crash);
    activate(crash, 'meeting-intake');
    const crashing = authority(crash, 'crash');
    assert.throws(
      () => executeHostRealization({
        root: crash,
        checkpointId: crashing.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'after-output:output.codex.tools'
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    const recovered = recoverHostRealization({
      root: crash,
      checkpointId: crashing.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    });
    assert.equal(recovered.state, 'completed');
    assert.equal(recoverHostRealization({
      root: crash,
      checkpointId: crashing.execution.checkpoint.id,
      at: '2026-07-16T12:09:00.000Z'
    }).state, 'completed');

    const beforeOutputCrash = copyRuntime(sourceRoot, 'before-output-crash');
    roots.push(beforeOutputCrash);
    activate(beforeOutputCrash, 'meeting-intake');
    const beforeOutputAuthority = authority(beforeOutputCrash, 'before-output-crash');
    const firstOutputId = beforeOutputAuthority.plan.operations[0].id;
    assert.throws(
      () => executeHostRealization({
        root: beforeOutputCrash,
        checkpointId: beforeOutputAuthority.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'before-output:' + firstOutputId
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    assert.equal(recoverHostRealization({
      root: beforeOutputCrash,
      checkpointId: beforeOutputAuthority.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    }).state, 'completed');

    const beforeManifestCrash = copyRuntime(sourceRoot, 'before-manifest-crash');
    roots.push(beforeManifestCrash);
    activate(beforeManifestCrash, 'meeting-intake');
    const beforeManifestAuthority = authority(beforeManifestCrash, 'before-manifest-crash');
    assert.throws(
      () => executeHostRealization({
        root: beforeManifestCrash,
        checkpointId: beforeManifestAuthority.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'before-manifest'
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    assert.equal(recoverHostRealization({
      root: beforeManifestCrash,
      checkpointId: beforeManifestAuthority.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    }).state, 'completed');

    const directoryCrash = copyRuntime(sourceRoot, 'directory-crash');
    roots.push(directoryCrash);
    activate(directoryCrash, 'meeting-intake');
    const crashingDirectory = authority(directoryCrash, 'directory-crash');
    assert.throws(
      () => executeHostRealization({
        root: directoryCrash,
        checkpointId: crashingDirectory.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'after-directory:.codex'
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    assert.equal(recoverHostRealization({
      root: directoryCrash,
      checkpointId: crashingDirectory.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    }).state, 'completed');

    const manifestCrash = copyRuntime(sourceRoot, 'manifest-crash');
    roots.push(manifestCrash);
    activate(manifestCrash, 'meeting-intake');
    const crashingManifest = authority(manifestCrash, 'manifest-crash');
    assert.throws(
      () => executeHostRealization({
        root: manifestCrash,
        checkpointId: crashingManifest.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'after-manifest'
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    assert.equal(recoverHostRealization({
      root: manifestCrash,
      checkpointId: crashingManifest.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    }).state, 'completed');

    const expired = copyRuntime(sourceRoot, 'expired');
    roots.push(expired);
    activate(expired, 'meeting-intake');
    const expiredAuthority = authority(expired, 'expired', 'meeting-intake', {
      validUntil: '2026-07-16T12:10:00.000Z',
      requestExpiresAt: '2026-07-16T12:08:00.000Z',
      confirmedAt: '2026-07-16T12:04:00.000Z',
      startedAt: '2026-07-16T12:05:00.000Z'
    });
    const expiredResult = executeHostRealization({
      root: expired,
      checkpointId: expiredAuthority.execution.checkpoint.id,
      at: '2026-07-16T12:11:00.000Z'
    });
    assert.equal(expiredResult.state, 'rolled-back');
    assert(!fs.existsSync(path.join(expired, 'AGENTS.md')));

    const attention = copyRuntime(sourceRoot, 'needs-attention');
    roots.push(attention);
    activate(attention, 'meeting-intake');
    const attentionAuthority = authority(attention, 'needs-attention');
    assert.throws(
      () => executeHostRealization({
        root: attention,
        checkpointId: attentionAuthority.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'after-output:output.codex.tools'
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    fs.writeFileSync(path.join(attention, '.codex/config.toml'), 'HOSTILE_UNKNOWN_OUTPUT_SENTINEL\n', { mode: 0o644 });
    const needsAttention = recoverHostRealization({
      root: attention,
      checkpointId: attentionAuthority.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    });
    assert.equal(needsAttention.state, 'needs-attention');
    const attentionInspection = inspectHostRealization({
      root: attention,
      planId: attentionAuthority.plan.id,
      requestId: attentionAuthority.request.id,
      confirmationId: attentionAuthority.confirmation.id,
      consumptionId: attentionAuthority.execution.consumption.id,
      checkpointId: attentionAuthority.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    });
    assert(!JSON.stringify(attentionInspection).includes('HOSTILE_UNKNOWN_OUTPUT_SENTINEL'));

    const previewDrift = copyRuntime(sourceRoot, 'preview-drift');
    roots.push(previewDrift);
    activate(previewDrift, 'meeting-intake');
    const previewAuthority = authority(previewDrift, 'preview-drift');
    fs.writeFileSync(path.join(previewDrift, 'AGENTS.md'), 'HOSTILE_POST_PREVIEW_SENTINEL\n', { mode: 0o644 });
    const previewStopped = executeHostRealization({
      root: previewDrift,
      checkpointId: previewAuthority.execution.checkpoint.id,
      at: EXECUTED
    });
    assert.equal(previewStopped.state, 'needs-attention');
    assert(!fs.existsSync(path.join(previewDrift, '.codex/config.toml')),
      'Per-effect revalidation did not stop before the first affected write.');

    const retirement = copyRuntime(sourceRoot, 'retirement');
    roots.push(retirement);
    activate(retirement, 'meeting-intake');
    const initial = authority(retirement, 'retirement-initial');
    executeHostRealization({ root: retirement, checkpointId: initial.execution.checkpoint.id, at: EXECUTED });
    const retiredPath = '.codex/retired-managed.txt';
    const retiredContent = 'retired managed output\n';
    fs.writeFileSync(path.join(retirement, retiredPath), retiredContent, { mode: 0o644 });
    const retiredContentFingerprint = sha256(Buffer.from(retiredContent, 'utf8'));
    const oldManifest = readHostManagedManifestState(retirement, 'codex').manifest;
    oldManifest.outputs.push({
      id: 'output.codex.retired',
      path: retiredPath,
      role: 'configuration',
      mode: '0644',
      contentFingerprint: retiredContentFingerprint,
      fingerprint: fingerprintJson({ contentFingerprint: retiredContentFingerprint, mode: '0644' })
    });
    oldManifest.outputs.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    writeHostManagedManifestState(retirement, resealManifest(oldManifest));
    const removalPlan = prepareHostRealization({
      root: retirement,
      configurationName: 'meeting-intake',
      id: 'host-realization-plan.retirement',
      createdAt: CREATED,
      validUntil: VALID_UNTIL
    }).plan;
    assert(removalPlan.operations.some((operation) => operation.action === 'remove'
      && operation.path === retiredPath));
    const removalAuthority = authorizePlan(retirement, 'retirement', removalPlan);
    assert.equal(executeHostRealization({
      root: retirement,
      checkpointId: removalAuthority.execution.checkpoint.id,
      at: EXECUTED
    }).state, 'completed');
    assert(!fs.existsSync(path.join(retirement, retiredPath)));

    const symlink = copyRuntime(sourceRoot, 'symlink');
    roots.push(symlink);
    activate(symlink, 'meeting-intake');
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soter-host-outside-'));
    roots.push(outside);
    fs.symlinkSync(outside, path.join(symlink, '.codex'));
    assert.throws(
      () => prepareHostRealization({
        root: symlink,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.symlink',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_SYMLINK_REJECTED'
    );

    const originalRoot = copyRuntime(sourceRoot, 'wrong-root-source');
    const wrongRoot = copyRuntime(sourceRoot, 'wrong-root-target');
    roots.push(originalRoot, wrongRoot);
    activate(originalRoot, 'meeting-intake');
    activate(wrongRoot, 'meeting-intake');
    const originalPlan = prepareHostRealization({
      root: originalRoot,
      configurationName: 'meeting-intake',
      id: 'host-realization-plan.wrong-root',
      createdAt: CREATED,
      validUntil: VALID_UNTIL
    }).plan;
    const copiedPlanPath = hostRealizationPlanStatePath(wrongRoot, originalPlan.id);
    fs.mkdirSync(path.dirname(copiedPlanPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(hostRealizationPlanStatePath(originalRoot, originalPlan.id), copiedPlanPath);
    assert.throws(
      () => beginHostRealizationRequest({
        root: wrongRoot,
        planId: originalPlan.id,
        id: 'host-realization-request.wrong-root',
        reason: 'This request must fail because the exact target identity changed.',
        createdAt: CREATED,
        expiresAt: '2026-07-16T12:30:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_TARGET_DRIFT'
    );

    const crossHost = copyRuntime(sourceRoot, 'cross-host');
    roots.push(crossHost);
    activate(crossHost, 'meeting-intake');
    const crossInitial = authority(crossHost, 'cross-host-initial');
    executeHostRealization({ root: crossHost, checkpointId: crossInitial.execution.checkpoint.id, at: EXECUTED });
    const codexManifest = readHostManagedManifestState(crossHost, 'codex').manifest;
    const claudeManifest = structuredClone(codexManifest);
    claudeManifest.id = 'host-managed-manifest.claude';
    claudeManifest.host = 'claude';
    writeHostManagedManifestState(crossHost, resealManifest(claudeManifest));
    assert.throws(
      () => prepareHostRealization({
        root: crossHost,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.cross-host',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_CROSS_HOST_COLLISION'
    );

    const malformedManifest = copyRuntime(sourceRoot, 'malformed-manifest');
    roots.push(malformedManifest);
    activate(malformedManifest, 'meeting-intake');
    const malformedPath = hostManagedManifestStatePath(malformedManifest, 'codex');
    fs.mkdirSync(path.dirname(malformedPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(malformedPath, '{"private":"HOSTILE_RAW_MANIFEST_SENTINEL"}\n', { mode: 0o600 });
    assert.throws(
      () => prepareHostRealization({
        root: malformedManifest,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.malformed-manifest',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_MANIFEST_MALFORMED'
        || error.code === 'HOST_REALIZATION_MANIFEST_TAMPERED'
    );

    console.log('Host realization self-test passed.');
    return true;
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  selftestHostRealizations(sourceRoot).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
