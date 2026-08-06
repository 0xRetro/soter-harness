#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from './inspection.mjs';
import {
  assertDevelopmentRequest,
  buildDevelopmentEvaluationInvocation,
  inspectDevelopmentRun,
  prepareDevelopmentRequest,
  recordHostDevelopmentResult,
  recordDevelopmentResult
} from './development-runs.mjs';
import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  resolveRepoPath,
  writeJson
} from './lib/canonical-json.mjs';
import { materializeDevelopmentCandidateLock } from './development-candidate-locks.mjs';
import { renderHostProjectionCandidates } from './host-projections.mjs';
import { privateConfigurationStatePath, writePrivateConfigurationState } from './private-configurations.mjs';
import { fingerprintLock, resolveConfiguration } from './resolve.mjs';
import {
  createDevelopmentRequestState,
  readDevelopmentRequestState,
  readDevelopmentResultState,
  writeActiveConfigurationLockState,
  writeHostManagedManifestState
} from './runtime-state.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FP = (value) => fingerprintJson(value);

function expectCode(action, code) {
  let observed = null;
  try {
    action();
  } catch (error) {
    observed = error?.code || null;
  }
  assert.equal(observed, code, 'expected stable failure code ' + code);
}

function mode(file) {
  return fs.statSync(file).mode & 0o7777;
}

function assertPrivateStateSymlinkAncestorsRejected() {
  for (const depth of ['soter', 'state', 'leaf']) {
    const root = fs.mkdtempSync(path.join(
      fs.realpathSync(os.tmpdir()),
      'soter-development-state-symlink-'
    ));
    const outside = fs.mkdtempSync(path.join(
      fs.realpathSync(os.tmpdir()),
      'soter-development-state-outside-'
    ));
    const marker = path.join(outside, 'marker.txt');
    fs.writeFileSync(marker, 'outside-private-state-sentinel\n', { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(outside, 0o755);
    try {
      if (depth === 'soter') {
        fs.symlinkSync(outside, path.join(root, '.soter'));
      } else {
        fs.mkdirSync(path.join(root, '.soter'), { mode: 0o755 });
        if (depth === 'state') {
          fs.symlinkSync(outside, path.join(root, '.soter/state'));
        } else {
          fs.mkdirSync(path.join(root, '.soter/state'), { mode: 0o755 });
          fs.symlinkSync(outside, path.join(root, '.soter/state/development-requests'));
        }
      }
      assert.throws(() => createDevelopmentRequestState(root, {
        id: 'development-request.symlink-' + depth
      }));
      assert.equal(fs.readFileSync(marker, 'utf8'), 'outside-private-state-sentinel\n');
      assert.deepEqual(fs.readdirSync(outside), ['marker.txt']);
      if (process.platform !== 'win32') {
        assert.equal(mode(outside), 0o755, 'rejected symlink must not chmod its external target');
        assert.equal(mode(marker), 0o644, 'rejected symlink must not mutate external file mode');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
}

function assertPrivateStateFileReadGuards({ file, read, code }) {
  const outside = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    'soter-development-read-outside-'
  ));
  const external = path.join(outside, 'external-state.json');
  const held = file + '.held';
  const originalBytes = fs.readFileSync(file);
  try {
    fs.copyFileSync(file, external);
    if (process.platform !== 'win32') fs.chmodSync(external, 0o600);
    fs.renameSync(file, held);
    fs.symlinkSync(external, file);
    expectCode(read, code);
    fs.unlinkSync(file);
    fs.renameSync(held, file);

    fs.renameSync(file, held);
    fs.linkSync(external, file);
    expectCode(read, code);
    fs.unlinkSync(file);
    fs.renameSync(held, file);

    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o644);
      expectCode(read, code);
      fs.chmodSync(file, 0o600);
      assert.equal(mode(external), 0o600);
    }
    assert.deepEqual(fs.readFileSync(external), originalBytes);
    assert.deepEqual(fs.readFileSync(file), originalBytes);
  } finally {
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(file);
    if (!fs.existsSync(file) && fs.existsSync(held)) fs.renameSync(held, file);
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function assertPrivateStateParentModeReadGuards({ file, read, code }) {
  if (process.platform === 'win32') return;
  const leaf = path.dirname(file);
  const state = path.dirname(leaf);
  const soter = path.dirname(state);
  for (const directory of [soter, state, leaf]) {
    assert.equal(mode(directory), 0o700);
    fs.chmodSync(directory, 0o755);
    try {
      expectCode(read, code);
      assert.equal(mode(directory), 0o755, 'private state reads must not repair unsafe parent modes');
    } finally {
      fs.chmodSync(directory, 0o700);
    }
  }
}

function copyHarnessRoot(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.soter' || entry.name === 'node_modules') continue;
    fs.cpSync(path.join(source, entry.name), path.join(target, entry.name), { recursive: true });
  }
}

function consumerTargetFingerprint(root) {
  const requestedPath = path.resolve(root);
  const realPath = fs.realpathSync(requestedPath);
  const stat = fs.statSync(realPath);
  return fingerprintJson({
    requestedPath,
    realPath,
    device: Number(stat.dev),
    inode: Number(stat.ino)
  });
}

export function materializeExactDevelopmentHost(
  root,
  configurationName = 'harness-development-catalog',
  host = 'codex'
) {
  const tracked = readJson(path.join(
    root,
    'soter/configurations',
    configurationName + '.config.json'
  ));
  writePrivateConfigurationState(root, configurationName, tracked);
  const lock = resolveConfiguration({
    root,
    configPath: privateConfigurationStatePath(root, configurationName),
    host
  });
  writeActiveConfigurationLockState(root, configurationName, lock);
  const adapter = readJson(path.join(root, `soter/hosts/${host}/adapter.json`));
  const rendered = renderHostProjectionCandidates({
    root,
    adapter,
    configurationId: configurationName,
    packIds: lock.packs.map((pack) => pack.id),
    capabilityIds: lock.capabilities.map((capability) => capability.id),
    effectPolicies: lock.effectPolicies,
    currentLock: lock
  });
  assert.equal(
    fingerprintJson(rendered.outputs.map((output) => ({
      id: output.id,
      path: output.path,
      role: output.role,
      mode: output.mode,
      templatePath: output.templatePath,
      templateFingerprint: output.templateFingerprint,
      contentFingerprint: output.contentFingerprint,
      fingerprint: output.fingerprint
    }))),
    fingerprintJson(lock.projections)
  );
  for (const output of rendered.outputs) {
    const target = resolveRepoPath(root, output.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, output.content, { encoding: 'utf8', mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(target, 0o644);
    assert.equal(fingerprintPath(target), output.contentFingerprint);
  }
  const manifest = {
    $contract: 'soter://contracts/host-managed-manifest/v1',
    contractVersion: '1.0.0',
    id: `host-managed-manifest.${host}`,
    host,
    targetFingerprint: consumerTargetFingerprint(root),
    configuration: {
      name: configurationName,
      lockFingerprint: fingerprintLock(lock),
      graphFingerprint: lock.graphFingerprint
    },
    definition: {
      id: rendered.definition.id,
      version: rendered.definition.version,
      fingerprint: rendered.definition.fingerprint
    },
    generator: {
      id: rendered.generator.id,
      version: rendered.generator.version,
      fingerprint: fingerprintJson(rendered.generator)
    },
    outputs: rendered.outputs.map((output) => ({
      id: output.id,
      path: output.path,
      role: output.role,
      mode: output.mode,
      contentFingerprint: output.contentFingerprint,
      fingerprint: output.fingerprint
    })).sort((left, right) => left.path.localeCompare(right.path, 'en')),
    checkpoint: {
      id: `checkpoint.host-realization.development-selftest-${host}`,
      fingerprint: FP({ kind: 'development-selftest-host-realization', host })
    },
    manifestFingerprint: null
  };
  const unsigned = { ...manifest };
  delete unsigned.manifestFingerprint;
  manifest.manifestFingerprint = fingerprintJson(unsigned);
  writeHostManagedManifestState(root, manifest);
  const currentLock = resolveConfiguration({
    root,
    configPath: privateConfigurationStatePath(root, configurationName),
    host
  });
  const currentRendered = renderHostProjectionCandidates({
    root,
    adapter,
    configurationId: configurationName,
    packIds: currentLock.packs.map((pack) => pack.id),
    capabilityIds: currentLock.capabilities.map((capability) => capability.id),
    effectPolicies: currentLock.effectPolicies,
    currentLock
  });
  assert.deepEqual({
    host: currentLock.host.id,
    targetFingerprint: consumerTargetFingerprint(root),
    configuration: {
      name: currentLock.configuration.name,
      lockFingerprint: fingerprintLock(currentLock),
      graphFingerprint: currentLock.graphFingerprint
    },
    definition: {
      id: currentRendered.definition.id,
      version: currentRendered.definition.version,
      fingerprint: currentRendered.definition.fingerprint
    },
    generator: {
      id: currentRendered.generator.id,
      version: currentRendered.generator.version,
      fingerprint: fingerprintJson(currentRendered.generator)
    },
    outputs: currentRendered.outputs.map((output) => ({
      id: output.id,
      path: output.path,
      role: output.role,
      mode: output.mode,
      contentFingerprint: output.contentFingerprint,
      fingerprint: output.fingerprint
    })).sort((left, right) => left.path.localeCompare(right.path, 'en'))
  }, {
    host: manifest.host,
    targetFingerprint: manifest.targetFingerprint,
    configuration: manifest.configuration,
    definition: manifest.definition,
    generator: manifest.generator,
    outputs: manifest.outputs
  });
  return lock;
}

function criterionRows(testCase) {
  return [
    ...testCase.expectedObservations.map((_, index) => ({
      id: testCase.id + '.expected.' + String(index + 1),
      kind: 'expected',
      sequence: index + 1,
      state: 'observed',
      evidenceFingerprint: FP({ case: testCase.id, kind: 'expected', index })
    })),
    ...testCase.prohibitedOutcomes.map((_, index) => ({
      id: testCase.id + '.prohibited.' + String(index + 1),
      kind: 'prohibited',
      sequence: index + 1,
      state: 'not-observed',
      evidenceFingerprint: FP({ case: testCase.id, kind: 'prohibited', index })
    }))
  ];
}

function passingOutcome(invocation, evaluations) {
  const cases = new Map(evaluations.cases.map((item) => [item.id, item]));
  const workerRuns = invocation.plannedRuns.map((run, index) => ({
    id: 'worker-run.forge.' + String(index + 1),
    sequence: index + 1,
    requestRunId: run.id,
    caseId: run.caseId,
    arm: run.arm,
    guideState: run.guideState,
    workerFingerprint: FP({ worker: index + 1 }),
    dispatchFingerprint: FP({ dispatch: run.id }),
    expectationsIncluded: false,
    answerKeyAccess: 'not-observed',
    transcriptFingerprint: FP({ transcript: run.id }),
    state: 'passed'
  }));
  const outcome = {
    state: 'passed',
    workerRuns,
    judgments: workerRuns.map((run, index) => ({
      id: 'judgment.forge.' + String(index + 1),
      workerRunId: run.id,
      caseId: run.caseId,
      verdict: 'passed',
      criteria: criterionRows(cases.get(run.caseId))
    })),
    changes: [{
      id: 'change.forge.result',
      path: 'soter/scratch/forge-result.mjs',
      kind: 'modify',
      beforeFingerprint: FP({ state: 'before' }),
      afterFingerprint: FP({ state: 'after' })
    }],
    checks: [{
      id: 'check.forge.result',
      state: 'passed',
      observedFingerprint: FP({ check: 'passed' })
    }],
    effects: [
      {
        category: 'local-workspace-read',
        scope: 'request-scoped',
        state: 'observed',
        count: 1,
        observedFingerprint: FP({ read: 1 })
      },
      {
        category: 'local-workspace-write',
        scope: 'request-scoped',
        state: 'observed',
        count: 1,
        observedFingerprint: FP({ changed: 1 })
      },
      {
        category: 'local-command',
        scope: 'request-scoped',
        state: 'observed',
        count: 1,
        observedFingerprint: FP({ command: 1 })
      },
      {
        category: 'subagent-dispatch',
        scope: 'request-scoped',
        state: 'observed',
        count: workerRuns.length,
        observedFingerprint: FP({ dispatched: workerRuns.length })
      },
      ...[
        'provider-write',
        'provider-read',
        'publication',
        'merge',
        'protected-root-mutation',
        'host-realization'
      ].map((category) => ({
        category,
        scope: 'separate-authority',
        state: 'not-observed',
        count: 0,
        observedFingerprint: null
      }))
    ],
    promotion: {
      state: 'held',
      artifactFingerprint: null,
      reasonCode: 'PROMOTION_AUTHORITY_NOT_GRANTED'
    },
    decisionEvidence: [],
    limitations: ['This contained result is scoped evidence and grants no operational authority.']
  };
  const baselineRun = outcome.workerRuns.find((run) => run.arm === 'baseline');
  const baselineJudgment = outcome.judgments.find((item) => item.workerRunId === baselineRun.id);
  baselineRun.state = 'failed';
  baselineJudgment.verdict = 'failed';
  baselineJudgment.criteria.find((criterion) => criterion.kind === 'expected').state = 'not-observed';
  return outcome;
}

function passingDevelopOutcome({ target, beforeFingerprint, afterFingerprint }) {
  return {
    state: 'passed',
    workerRuns: [],
    judgments: [],
    changes: [{
      id: 'change.governed-target',
      path: target,
      kind: 'modify',
      beforeFingerprint,
      afterFingerprint
    }],
    checks: [{
      id: 'check.governed-target',
      state: 'passed',
      observedFingerprint: FP({ target, afterFingerprint })
    }],
    effects: [
      {
        category: 'local-workspace-read',
        scope: 'request-scoped',
        state: 'observed',
        count: 1,
        observedFingerprint: FP({ target, effect: 'read' })
      },
      {
        category: 'local-workspace-write',
        scope: 'request-scoped',
        state: 'observed',
        count: 1,
        observedFingerprint: FP({ target, effect: 'write' })
      },
      ...['local-command', 'subagent-dispatch'].map((category) => ({
        category,
        scope: 'request-scoped',
        state: 'not-observed',
        count: 0,
        observedFingerprint: null
      })),
      ...[
        'provider-read',
        'provider-write',
        'publication',
        'merge',
        'protected-root-mutation',
        'host-realization'
      ].map((category) => ({
        category,
        scope: 'separate-authority',
        state: 'not-observed',
        count: 0,
        observedFingerprint: null
      }))
    ],
    promotion: {
      state: 'held',
      artifactFingerprint: null,
      reasonCode: 'PROMOTION_AUTHORITY_NOT_GRANTED'
    },
    decisionEvidence: [],
    limitations: ['This exact target-bound development result grants no operational authority.']
  };
}

export async function selftestDevelopmentRuns(root = scriptRoot) {
  assertPrivateStateSymlinkAncestorsRejected();
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soter-development-runs-'));
  try {
    copyHarnessRoot(root, temp);
    const activeLock = materializeExactDevelopmentHost(temp);
    const configPath = path.relative(
      temp,
      privateConfigurationStatePath(temp, activeLock.configuration.name)
    ).split(path.sep).join('/');
    const candidateLock = materializeDevelopmentCandidateLock({
      root: temp,
      configPath,
      workflowId: 'automation.forge',
      host: 'codex'
    });
    const lockPath = candidateLock.path;
    const auditLockPath = materializeDevelopmentCandidateLock({
      root: temp,
      configPath,
      workflowId: 'automation.auditing-a-schema-doc',
      host: 'codex'
    }).path;
    const evaluations = readJson(path.join(temp, 'soter/automations/forge/evaluations.json'));

    const readOnlyPath = 'soter/contracts/host-runtime-inspection.schema.json';
    const readOnlyFile = path.join(temp, readOnlyPath);
    const readOnlyBytes = fs.readFileSync(readOnlyFile);
    const readOnlyRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath: auditLockPath,
      workflowId: 'automation.auditing-a-schema-doc',
      requestId: 'development-request.read-only-staleness',
      invocation: {
        kind: 'develop',
        profile: 'exact',
        requestedOutcome: 'Review the exact schema without changing workspace bytes.',
        requestedLocalEffects: ['local-workspace-read'],
        targets: [{ id: 'target.host-runtime-schema', path: readOnlyPath }]
      },
      createdAt: '2026-07-22T09:00:00.000Z'
    });
    assert.equal(readOnlyRequest.inspection.applicability.state, 'current');
    assert.equal(readOnlyRequest.inspection.requestBoundary.declared.localWorkspaceWrite, 'not-requested');
    if (process.platform !== 'win32') {
      assert.equal(readOnlyRequest.request.invocation.targets[0].beforeMode, '0644');
      fs.chmodSync(readOnlyFile, 0o600);
      const modeStale = inspectDevelopmentRun({
        root: temp,
        requestId: 'development-request.read-only-staleness'
      });
      assert.equal(modeStale.applicability.reasonCode, 'DEVELOPMENT_REQUEST_TARGET_STALE');
      assert.equal(modeStale.requestBoundary.state, 'stale');
      fs.chmodSync(readOnlyFile, 0o644);
      assert.equal(inspectDevelopmentRun({
        root: temp,
        requestId: 'development-request.read-only-staleness'
      }).applicability.state, 'current');
    }
    fs.appendFileSync(readOnlyFile, '\n');
    let staleInspection = inspectDevelopmentRun({
      root: temp,
      requestId: 'development-request.read-only-staleness'
    });
    assert.equal(staleInspection.applicability.reasonCode, 'DEVELOPMENT_REQUEST_TARGET_STALE');
    assert.equal(staleInspection.requestBoundary.state, 'stale');
    assert.equal(staleInspection.requestBoundary.effective.localWorkspaceRead, 'closed');
    fs.writeFileSync(readOnlyFile, readOnlyBytes);
    const heldReadOnly = readOnlyFile + '.held';
    fs.renameSync(readOnlyFile, heldReadOnly);
    fs.symlinkSync(heldReadOnly, readOnlyFile);
    staleInspection = inspectDevelopmentRun({
      root: temp,
      requestId: 'development-request.read-only-staleness'
    });
    assert.equal(staleInspection.applicability.reasonCode, 'DEVELOPMENT_REQUEST_TARGET_STALE');
    fs.unlinkSync(readOnlyFile);
    fs.renameSync(heldReadOnly, readOnlyFile);
    const unrelatedFile = path.join(temp, 'unrelated-development-drift.txt');
    fs.writeFileSync(unrelatedFile, 'unrelated drift\n');
    staleInspection = inspectDevelopmentRun({
      root: temp,
      requestId: 'development-request.read-only-staleness'
    });
    assert.equal(staleInspection.applicability.reasonCode, 'DEVELOPMENT_REQUEST_WORKSPACE_STALE');
    fs.rmSync(unrelatedFile);
    assert.equal(inspectDevelopmentRun({
      root: temp,
      requestId: 'development-request.read-only-staleness'
    }).applicability.state, 'current');

    const hostClosureRequestId = 'development-request.host-closure';
    prepareDevelopmentRequest({
      root: temp,
      lockPath: auditLockPath,
      workflowId: 'automation.auditing-a-schema-doc',
      requestId: hostClosureRequestId,
      invocation: {
        kind: 'develop',
        profile: 'exact',
        requestedOutcome: 'Review the exact schema and close the request with path-free host observations.',
        requestedLocalEffects: ['local-workspace-read'],
        targets: [{ id: 'target.host-closure-schema', path: readOnlyPath }]
      },
      createdAt: '2026-07-22T09:05:00.000Z'
    });
    const hostClosureEffects = [
      {
        category: 'local-workspace-read',
        state: 'observed',
        count: 1,
        observedFingerprint: FP({ hostClosure: 'read' })
      },
      ...['local-workspace-write', 'local-command', 'subagent-dispatch'].map((category) => ({
        category,
        state: 'not-observed',
        count: 0,
        observedFingerprint: null
      }))
    ];
    expectCode(() => recordHostDevelopmentResult({
      root: temp,
      requestId: hostClosureRequestId,
      state: 'passed',
      checks: [],
      localEffects: hostClosureEffects,
      completedAt: '2026-07-22T09:06:00.000Z'
    }), 'DEVELOPMENT_RESULT_PASS_UNSUPPORTED');
    const hostClosure = recordHostDevelopmentResult({
      root: temp,
      requestId: hostClosureRequestId,
      state: 'passed',
      checks: [{
        id: 'check.host-closure-schema',
        state: 'passed',
        observedFingerprint: FP({ hostClosure: 'check' })
      }],
      localEffects: hostClosureEffects,
      completedAt: '2026-07-22T09:06:00.000Z'
    });
    assert.equal(hostClosure.inspection.progress.state, 'passed');
    assert.equal(hostClosure.inspection.requestBoundary.state, 'closed');
    assert.deepEqual(hostClosure.result.changes.map(({ id, kind }) => ({ id, kind })), [{
      id: 'change.target.host-closure-schema',
      kind: 'unchanged'
    }]);
    assert.equal(
      readDevelopmentResultState(temp, 'development-result.host-closure').result.resultFingerprint,
      hostClosure.result.resultFingerprint
    );
    const reorderedEffects = structuredClone(hostClosureEffects);
    [reorderedEffects[0], reorderedEffects[1]] = [reorderedEffects[1], reorderedEffects[0]];
    expectCode(() => recordHostDevelopmentResult({
      root: temp,
      requestId: 'development-request.read-only-staleness',
      state: 'blocked',
      checks: [],
      localEffects: reorderedEffects,
      completedAt: '2026-07-22T09:07:00.000Z'
    }), 'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED');

    const writablePath = 'development-request-write-target.txt';
    const writableFile = path.join(temp, writablePath);
    fs.writeFileSync(writableFile, 'before\n');
    const writableRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath,
      workflowId: 'automation.forge',
      requestId: 'development-request.write-target',
      invocation: {
        kind: 'develop',
        profile: 'bounded',
        requestedOutcome: 'Modify only the exact declared contained development target.',
        requestedLocalEffects: ['local-workspace-read', 'local-workspace-write'],
        targets: [{ id: 'target.write', path: writablePath }]
      },
      createdAt: '2026-07-22T09:10:00.000Z'
    });
    fs.writeFileSync(writableFile, 'after\n');
    const writableStale = inspectDevelopmentRun({
      root: temp,
      requestId: writableRequest.request.id
    });
    assert.equal(writableStale.applicability.state, 'stale');
    assert.equal(writableStale.applicability.reasonCode, 'DEVELOPMENT_REQUEST_TARGET_STALE');
    assert.equal(writableStale.requestBoundary.state, 'stale');
    assert.equal(writableStale.requestBoundary.effective.localWorkspaceWrite, 'closed');
    fs.rmSync(writableFile);

    for (const protectedPath of [
      '.git/config',
      '.soter/state/private.json',
      'node_modules/private.js',
      '.agents/skills/private/SKILL.md',
      '.codex/config.toml',
      '.claude/private.md',
      '.claude-plugin/plugin.json',
      'AGENTS.md',
      'CLAUDE.md',
      '.mcp.json',
      'soter/kernel/development-workspace.settings.json',
      'soter/hosts/codex/adapter.json',
      'soter/hosts/claude/adapter.json',
      'missing-parent/target.txt'
    ]) {
      expectCode(() => prepareDevelopmentRequest({
        root: temp,
        lockPath,
        workflowId: 'automation.forge',
        requestId: 'development-request.protected-' + fingerprintJson(protectedPath).slice(7, 19),
        invocation: {
          kind: 'develop',
          profile: 'exact',
          requestedOutcome: 'Attempt one exact target that Core must reject before durable state.',
          requestedLocalEffects: ['local-workspace-read', 'local-workspace-write'],
          targets: [{ id: 'target.protected', path: protectedPath }]
        },
        createdAt: '2026-07-22T09:20:00.000Z'
      }), 'DEVELOPMENT_REQUEST_TARGET_INVALID');
    }

    const privateOutcomeSentinel = 'Develop the bounded forge target without exposing this private desired result.';
    const targetPathSentinel = 'soter/private-targets/forge-secret.mjs';
    const transcriptSentinel = 'PRIVATE_WORKER_TRANSCRIPT_SENTINEL';
    const invocation = buildDevelopmentEvaluationInvocation({
      root: temp,
      workflowId: 'automation.forge'
    });
    assert.equal(invocation.plannedRuns[0].caseId, 'happy-path');
    assert.equal(invocation.plannedRuns[0].arm, 'baseline');
    assert.equal(invocation.plannedRuns.length, evaluations.cases.length + 1);
    const requestId = 'development-request.forge-selftest';
    const prepared = prepareDevelopmentRequest({
      root: temp,
      lockPath,
      workflowId: 'automation.forge',
      requestId,
      invocation,
      createdAt: '2026-07-22T10:00:00.000Z',
      limitations: [privateOutcomeSentinel]
    });
    assert.equal(prepared.inspection.progress.state, 'requested');
    assert.equal(prepared.inspection.invocation.plannedRuns.length, invocation.plannedRuns.length);
    const privateFiles = {
      request: path.join(temp, '.soter/state/development-requests/' + requestId + '.json'),
      result: path.join(temp, '.soter/state/development-results/development-result.forge-selftest.json')
    };
    if (process.platform !== 'win32') {
      assert.equal(mode(path.dirname(privateFiles.request)), 0o700);
      assert.equal(mode(privateFiles.request), 0o600);
    }
    assertPrivateStateFileReadGuards({
      file: privateFiles.request,
      read: () => readDevelopmentRequestState(temp, requestId),
      code: 'DEVELOPMENT_REQUEST_PRIVATE_STATE_INVALID'
    });
    assertPrivateStateParentModeReadGuards({
      file: privateFiles.request,
      read: () => readDevelopmentRequestState(temp, requestId),
      code: 'DEVELOPMENT_REQUEST_PRIVATE_STATE_INVALID'
    });

    const exactReentry = prepareDevelopmentRequest({
      root: temp,
      lockPath,
      workflowId: 'automation.forge',
      requestId,
      invocation,
      limitations: [privateOutcomeSentinel]
    });
    assert.equal(exactReentry.request.requestFingerprint, prepared.request.requestFingerprint);
    expectCode(() => prepareDevelopmentRequest({
      root: temp,
      lockPath,
      workflowId: 'automation.forge',
      requestId,
      invocation: { ...invocation, plannedRuns: invocation.plannedRuns.slice(0, -1) },
      limitations: [privateOutcomeSentinel]
    }), 'DEVELOPMENT_REQUEST_REENTRY_MISMATCH');

    expectCode(() => prepareDevelopmentRequest({
      root: temp,
      lockPath,
      workflowId: 'automation.forge',
      requestId: 'development-request.private-path',
      invocation,
      limitations: ['Inspect the private file at /tmp/private-development-secret.']
    }), 'DEVELOPMENT_REQUEST_PRIVATE_MATERIAL_INVALID');
    expectCode(() => prepareDevelopmentRequest({
      root: temp,
      lockPath,
      workflowId: 'automation.forge',
      requestId: 'development-request.credential',
      invocation,
      limitations: ['Credential sentinel ' + 'sk-' + 'development-secret-value must be rejected.']
    }), 'DEVELOPMENT_REQUEST_PRIVATE_MATERIAL_INVALID');

    const outcome = passingOutcome(invocation, evaluations);
    const recorded = recordDevelopmentResult({
      root: temp,
      lockPath,
      requestId,
      outcome,
      completedAt: '2026-07-22T10:10:00.000Z'
    });
    assert.equal(recorded.inspection.progress.state, 'passed');
    assert.deepEqual(recorded.inspection.authority, {
      kind: 'inspection-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsProviderRead: false,
      grantsPublication: false,
      grantsMerge: false,
      grantsProviderWrite: false,
      grantsProtectedRootMutation: false,
      grantsHostRealization: false
    });
    assert.equal(recorded.inspection.requestBoundary.state, 'closed');
    assert.equal(recorded.inspection.requestBoundary.reasonCode, 'DEVELOPMENT_RESULT_RECORDED');
    assert.equal(recorded.inspection.requestBoundary.permittedNextAction, 'none');
    assert.deepEqual(recorded.inspection.requestBoundary.declared, prepared.request.effectBoundary);
    assert.deepEqual(recorded.inspection.requestBoundary.effective, {
      localWorkspaceRead: 'closed',
      localWorkspaceWrite: 'closed',
      localCommand: 'closed',
      subagentDispatch: 'closed',
      providerRead: 'separate-authority',
      providerWrite: 'separate-authority',
      publication: 'separate-authority',
      merge: 'separate-authority',
      protectedRootMutation: 'separate-authority',
      hostRealization: 'separate-authority'
    });
    if (process.platform !== 'win32') {
      assert.equal(mode(path.dirname(privateFiles.result)), 0o700);
      assert.equal(mode(privateFiles.result), 0o600);
    }
    assertPrivateStateFileReadGuards({
      file: privateFiles.result,
      read: () => readDevelopmentResultState(
        temp,
        'development-result.forge-selftest'
      ),
      code: 'DEVELOPMENT_RESULT_PRIVATE_STATE_INVALID'
    });
    assertPrivateStateParentModeReadGuards({
      file: privateFiles.result,
      read: () => readDevelopmentResultState(
        temp,
        'development-result.forge-selftest'
      ),
      code: 'DEVELOPMENT_RESULT_PRIVATE_STATE_INVALID'
    });
    const resultReentry = recordDevelopmentResult({ root: temp, lockPath, requestId, outcome });
    assert.equal(resultReentry.result.resultFingerprint, recorded.result.resultFingerprint);

    const changedOutcome = structuredClone(outcome);
    changedOutcome.promotion.reasonCode = 'DIFFERENT_PRIVATE_OUTCOME';
    expectCode(() => recordDevelopmentResult({ root: temp, lockPath, requestId, outcome: changedOutcome }), 'DEVELOPMENT_RESULT_REENTRY_MISMATCH');

    const hostileRoot = fs.mkdtempSync(path.join(
      fs.realpathSync(os.tmpdir()),
      'soter-development-hostile-'
    ));
    try {
      copyHarnessRoot(root, hostileRoot);
      materializeExactDevelopmentHost(hostileRoot);
      const hostileCandidate = materializeDevelopmentCandidateLock({
        root: hostileRoot,
        configPath,
        workflowId: 'automation.forge',
        host: 'codex'
      });
      assert.equal(hostileCandidate.path, lockPath);
      prepareDevelopmentRequest({
        root: hostileRoot,
        lockPath,
        workflowId: 'automation.forge',
        requestId,
        invocation,
        createdAt: '2026-07-22T10:00:00.000Z',
        limitations: [privateOutcomeSentinel]
      });
      const recordHostile = (hostileOutcome, completedAt = '2026-07-22T10:10:00.000Z') => {
        return recordDevelopmentResult({
          root: hostileRoot,
          lockPath,
          requestId,
          outcome: hostileOutcome,
          completedAt
        });
      };
      const duplicateWorkers = passingOutcome(invocation, evaluations);
      duplicateWorkers.workerRuns[1].workerFingerprint = duplicateWorkers.workerRuns[0].workerFingerprint;
      expectCode(() => recordHostile(duplicateWorkers), 'DEVELOPMENT_RESULT_FRESH_WORKER_REQUIRED');
      const duplicateDispatch = passingOutcome(invocation, evaluations);
      duplicateDispatch.workerRuns[1].dispatchFingerprint = duplicateDispatch.workerRuns[0].dispatchFingerprint;
      expectCode(() => recordHostile(duplicateDispatch), 'DEVELOPMENT_RESULT_FRESH_WORKER_REQUIRED');
      const duplicateTranscript = passingOutcome(invocation, evaluations);
      duplicateTranscript.workerRuns[1].transcriptFingerprint = duplicateTranscript.workerRuns[0].transcriptFingerprint;
      expectCode(() => recordHostile(duplicateTranscript), 'DEVELOPMENT_RESULT_FRESH_WORKER_REQUIRED');
      const externalEffect = passingOutcome(invocation, evaluations);
      const observedProviderWrite = externalEffect.effects.find((item) => item.category === 'provider-write');
      observedProviderWrite.state = 'observed';
      observedProviderWrite.count = 1;
      observedProviderWrite.observedFingerprint = FP({ provider: 'write' });
      expectCode(() => recordHostile(externalEffect), 'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED');
      for (const state of ['unknown', 'blocked']) {
        const uncertainExternalEffect = passingOutcome(invocation, evaluations);
        uncertainExternalEffect.effects.find((item) => item.category === 'provider-write').state = state;
        expectCode(
          () => recordHostile(uncertainExternalEffect),
          'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED'
        );
      }
      const nonzeroExternalEffect = passingOutcome(invocation, evaluations);
      nonzeroExternalEffect.effects.find((item) => item.category === 'provider-write').count = 1;
      expectCode(
        () => recordHostile(nonzeroExternalEffect),
        'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED'
      );
      const omittedExternalEffect = passingOutcome(invocation, evaluations);
      omittedExternalEffect.effects = omittedExternalEffect.effects.filter((item) => {
        return item.category !== 'provider-read';
      });
      expectCode(
        () => recordHostile(omittedExternalEffect),
        'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED'
      );
      const duplicateExternalEffect = passingOutcome(invocation, evaluations);
      duplicateExternalEffect.effects.push(structuredClone(
        duplicateExternalEffect.effects.find((item) => item.category === 'provider-read')
      ));
      expectCode(
        () => recordHostile(duplicateExternalEffect),
        'DEVELOPMENT_RESULT_BINDING_INVALID'
      );
      const omittedLocalEffect = passingOutcome(invocation, evaluations);
      omittedLocalEffect.effects = omittedLocalEffect.effects.filter((item) => {
        return item.category !== 'local-command';
      });
      expectCode(
        () => recordHostile(omittedLocalEffect),
        'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED'
      );
      const incoherentObservedLocalEffect = passingOutcome(invocation, evaluations);
      const observedRead = incoherentObservedLocalEffect.effects.find((item) => {
        return item.category === 'local-workspace-read';
      });
      observedRead.count = 0;
      observedRead.observedFingerprint = null;
      expectCode(
        () => recordHostile(incoherentObservedLocalEffect),
        'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED'
      );
      const incoherentUnobservedLocalEffect = passingOutcome(invocation, evaluations);
      const unobservedCommand = incoherentUnobservedLocalEffect.effects.find((item) => {
        return item.category === 'local-command';
      });
      unobservedCommand.state = 'not-observed';
      unobservedCommand.count = 1;
      expectCode(
        () => recordHostile(incoherentUnobservedLocalEffect),
        'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED'
      );
      const answerKey = passingOutcome(invocation, evaluations);
      answerKey.workerRuns.find((item) => item.arm === 'guided').answerKeyAccess = 'observed';
      expectCode(() => recordHostile(answerKey), 'DEVELOPMENT_RESULT_ANSWER_KEY_EXPOSED');
      const unknownAnswerKey = passingOutcome(invocation, evaluations);
      unknownAnswerKey.workerRuns.find((item) => item.arm === 'guided').answerKeyAccess = 'unknown';
      expectCode(() => recordHostile(unknownAnswerKey), 'DEVELOPMENT_RESULT_ANSWER_KEY_EXPOSED');
      const prohibitedObserved = passingOutcome(invocation, evaluations);
      const guidedProhibitedObserved = prohibitedObserved.judgments.find((item) => {
        const workerRun = prohibitedObserved.workerRuns.find((run) => run.id === item.workerRunId);
        return workerRun?.arm === 'guided'
          && item.criteria.some((criterion) => criterion.kind === 'prohibited');
      });
      assert(guidedProhibitedObserved);
      guidedProhibitedObserved.criteria.find((criterion) => {
        return criterion.kind === 'prohibited';
      }).state = 'observed';
      expectCode(() => recordHostile(prohibitedObserved), 'DEVELOPMENT_RESULT_PROHIBITED_OUTCOME');
      const prohibitedUnknown = passingOutcome(invocation, evaluations);
      const guidedProhibitedUnknown = prohibitedUnknown.judgments.find((item) => {
        const workerRun = prohibitedUnknown.workerRuns.find((run) => run.id === item.workerRunId);
        return workerRun?.arm === 'guided'
          && item.criteria.some((criterion) => criterion.kind === 'prohibited');
      });
      assert(guidedProhibitedUnknown);
      guidedProhibitedUnknown.criteria.find((criterion) => {
        return criterion.kind === 'prohibited';
      }).state = 'unknown';
      expectCode(() => recordHostile(prohibitedUnknown), 'DEVELOPMENT_RESULT_PROHIBITED_OUTCOME');
      expectCode(
        () => recordHostile(passingOutcome(invocation, evaluations), '2026-07-22T09:59:59.000Z'),
        'DEVELOPMENT_RESULT_CHRONOLOGY_INVALID'
      );
      const rawDiff = passingOutcome(invocation, evaluations);
      rawDiff.limitations = ['diff --git a/private/file b/private/file\n@@ -1 +1 @@'];
      expectCode(() => recordHostile(rawDiff), 'DEVELOPMENT_RESULT_PRIVATE_MATERIAL_INVALID');
      const rawTranscript = passingOutcome(invocation, evaluations);
      rawTranscript.workerRuns[0].transcript = transcriptSentinel;
      expectCode(() => recordHostile(rawTranscript), 'DEVELOPMENT_RESULT_MALFORMED');
      const incoherentBaselineVerdict = passingOutcome(invocation, evaluations);
      incoherentBaselineVerdict.judgments.find((item) => {
        const workerRun = incoherentBaselineVerdict.workerRuns.find((run) => {
          return run.id === item.workerRunId;
        });
        return workerRun?.arm === 'baseline';
      }).verdict = 'passed';
      expectCode(
        () => recordHostile(incoherentBaselineVerdict),
        'DEVELOPMENT_RESULT_VERDICT_INVALID'
      );
      const baselineNonGatingOutcome = passingOutcome(invocation, evaluations);
      const baselineWorker = baselineNonGatingOutcome.workerRuns.find((item) => {
        return item.arm === 'baseline';
      });
      const baselineJudgment = baselineNonGatingOutcome.judgments.find((item) => {
        return item.workerRunId === baselineWorker.id;
      });
      const baselineProhibitedFinding = baselineJudgment.criteria.find((criterion) => {
        return criterion.kind === 'prohibited';
      });
      baselineProhibitedFinding.state = 'observed';
      const baselineNonGating = recordHostile(baselineNonGatingOutcome);
      assert.equal(baselineNonGating.result.state, 'passed');
      assert.equal(baselineNonGating.result.workerRuns.find((item) => item.arm === 'baseline').state, 'failed');
      assert.equal(
        baselineNonGating.result.judgments.find((item) => {
          return item.workerRunId === baselineWorker.id;
        }).criteria.find((criterion) => criterion.kind === 'prohibited').state,
        'observed'
      );
    } finally {
      fs.rmSync(hostileRoot, { recursive: true, force: true });
    }

    const serializedInspection = JSON.stringify(inspectDevelopmentRun({ root: temp, requestId }));
    assert(!serializedInspection.includes(privateOutcomeSentinel));
    assert(!serializedInspection.includes(targetPathSentinel));
    assert(!serializedInspection.includes(temp));
    assert(!serializedInspection.includes(transcriptSentinel));
    const workspace = inspectWorkspace({ root: temp });
    const activity = workspace.activity.find((item) => item.kind === 'development-run');
    assert(activity);
    assert.equal(activity.developmentRef.requestId, requestId);
    const serializedWorkspace = JSON.stringify(workspace);
    assert(!serializedWorkspace.includes(privateOutcomeSentinel));
    assert(!serializedWorkspace.includes(targetPathSentinel));
    assert(!serializedWorkspace.includes(temp));
    assert(!serializedWorkspace.includes(transcriptSentinel));

    const requestFile = privateFiles.request;
    const originalRequest = readJson(requestFile);
    const tampered = structuredClone(originalRequest);
    tampered.requestFingerprint = FP({ tampered: true });
    writeJson(requestFile, tampered);
    expectCode(() => assertDevelopmentRequest(temp, readJson(requestFile)), 'DEVELOPMENT_REQUEST_TAMPERED');
    writeJson(requestFile, originalRequest);

    const governedTargetPath = 'soter/automations/forge/guide.json';
    const governedTargetFile = path.join(temp, governedTargetPath);
    const governedBefore = fingerprintPath(governedTargetFile);
    const governedRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath,
      workflowId: 'automation.forge',
      requestId: 'development-request.governed-write-closure',
      invocation: {
        kind: 'develop',
        profile: 'bounded',
        requestedOutcome: 'Modify only the exact governed guide target and record exact closure.',
        requestedLocalEffects: ['local-workspace-read', 'local-workspace-write'],
        targets: [{ id: 'target.forge-guide', path: governedTargetPath }]
      },
      createdAt: '2026-07-22T11:00:00.000Z'
    });
    const governedGuide = readJson(governedTargetFile);
    governedGuide.limitations = [
      ...governedGuide.limitations,
      'Contained exact-target mutation proves write closure without granting host realization.'
    ];
    writeJson(governedTargetFile, governedGuide);
    const governedAfter = fingerprintPath(governedTargetFile);
    const preClosure = inspectDevelopmentRun({
      root: temp,
      requestId: governedRequest.request.id
    });
    assert.equal(preClosure.applicability.state, 'stale');
    assert.equal(preClosure.applicability.reasonCode, 'DEVELOPMENT_REQUEST_TARGET_STALE');
    assert.equal(preClosure.requestBoundary.state, 'stale');
    assert.equal(preClosure.requestBoundary.effective.localWorkspaceWrite, 'closed');
    const governedOutcome = passingDevelopOutcome({
      target: governedTargetPath,
      beforeFingerprint: governedBefore,
      afterFingerprint: governedAfter
    });
    if (process.platform !== 'win32') {
      fs.chmodSync(governedTargetFile, 0o755);
      expectCode(() => recordDevelopmentResult({
        root: temp,
        lockPath,
        requestId: governedRequest.request.id,
        outcome: governedOutcome,
        completedAt: '2026-07-22T11:08:30.000Z'
      }), 'DEVELOPMENT_RESULT_BINDING_INVALID');
      fs.chmodSync(governedTargetFile, 0o644);
    }
    const unobservedGovernedWrite = structuredClone(governedOutcome);
    const governedWriteEffect = unobservedGovernedWrite.effects.find((item) => {
      return item.category === 'local-workspace-write';
    });
    governedWriteEffect.state = 'not-observed';
    governedWriteEffect.count = 0;
    governedWriteEffect.observedFingerprint = null;
    expectCode(() => recordDevelopmentResult({
      root: temp,
      lockPath,
      requestId: governedRequest.request.id,
      outcome: unobservedGovernedWrite,
      completedAt: '2026-07-22T11:09:00.000Z'
    }), 'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED');
    const privateConfigFile = privateConfigurationStatePath(
      temp,
      activeLock.configuration.name
    );
    const privateConfigurationBytes = fs.readFileSync(privateConfigFile);
    const driftedPrivateConfiguration = readJson(privateConfigFile);
    driftedPrivateConfiguration.host.reason += ' Drift sentinel.';
    fs.writeFileSync(
      privateConfigFile,
      JSON.stringify(driftedPrivateConfiguration, null, 2) + '\n'
    );
    if (process.platform !== 'win32') fs.chmodSync(privateConfigFile, 0o600);
    expectCode(() => recordDevelopmentResult({
      root: temp,
      lockPath,
      requestId: governedRequest.request.id,
      outcome: governedOutcome,
      completedAt: '2026-07-22T11:09:30.000Z'
    }), 'DEVELOPMENT_REQUEST_HOST_REALIZATION_STALE');
    fs.writeFileSync(privateConfigFile, privateConfigurationBytes);
    if (process.platform !== 'win32') fs.chmodSync(privateConfigFile, 0o600);
    const governedResult = recordDevelopmentResult({
      root: temp,
      lockPath,
      requestId: governedRequest.request.id,
      outcome: governedOutcome,
      completedAt: '2026-07-22T11:10:00.000Z'
    });
    assert.equal(governedResult.inspection.requestBoundary.state, 'closed');
    assert.equal(governedResult.inspection.requestBoundary.reasonCode, 'DEVELOPMENT_RESULT_RECORDED');
    assert.equal(governedResult.inspection.result.state, 'passed');

    process.stdout.write('Soter private development request/result self-test passed.\n');
    return true;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  selftestDevelopmentRuns().then((passed) => {
    process.exitCode = passed ? 0 : 1;
  }).catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
