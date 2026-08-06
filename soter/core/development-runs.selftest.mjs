#!/usr/bin/env node

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from './inspection.mjs';
import {
  assertDevelopmentRunInspection,
  assertDevelopmentTargetMaterial,
  assertDevelopmentRequest,
  buildDevelopmentEvaluationInvocation,
  inspectDevelopmentRun,
  prepareDevelopmentRequest,
  readDevelopmentTargetMaterial,
  recordHostDevelopmentResult,
  recordDevelopmentResult
} from './development-runs.mjs';
import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  resolveRepoPath,
  sha256,
  writeJson
} from './lib/canonical-json.mjs';
import { materializeDevelopmentCandidateLock } from './development-candidate-locks.mjs';
import { validateJsonSchema } from '../kernel/verify.mjs';
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

function resignInspection(inspection) {
  const resigned = structuredClone(inspection);
  delete resigned.inspectionFingerprint;
  resigned.inspectionFingerprint = fingerprintJson(resigned);
  return resigned;
}

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
    changes: [],
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
    childProcess.execFileSync('git', ['-C', temp, 'init', '--quiet']);
    childProcess.execFileSync('git', ['-C', temp, 'add', '--all']);
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
    const reviewLockPath = materializeDevelopmentCandidateLock({
      root: temp,
      configPath,
      workflowId: 'automation.reviewing-forge-output',
      host: 'codex'
    }).path;
    const auditEvaluationLockPath = materializeDevelopmentCandidateLock({
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
      lockPath: reviewLockPath,
      workflowId: 'automation.reviewing-forge-output',
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
    const readOnlyMaterialInput = {
      root: temp,
      host: 'codex',
      requestId: readOnlyRequest.request.id,
      requestFingerprint: readOnlyRequest.request.requestFingerprint,
      targetId: 'target.host-runtime-schema'
    };
    const readOnlyMaterial = readDevelopmentTargetMaterial(readOnlyMaterialInput);
    assert.equal(readOnlyMaterial.$contract, 'soter://contracts/development-target-material/v1');
    assert.equal(readOnlyMaterial.content.text, readOnlyBytes.toString('utf8'));
    assert.equal(readOnlyMaterial.content.totalByteLength, readOnlyBytes.length);
    assert.equal(readOnlyMaterial.content.totalTextLength, readOnlyBytes.toString('utf8').length);
    assert.equal(readOnlyMaterial.content.chunkIndex, 0);
    assert.equal(readOnlyMaterial.content.chunkCount, 1);
    assert.equal(readOnlyMaterial.content.chunkByteLength, readOnlyBytes.length);
    assert.equal(readOnlyMaterial.content.complete, true);
    assert.equal(readOnlyMaterial.content.nextChunkIndex, null);
    assert.equal(readOnlyMaterial.target.contentFingerprint,
      readOnlyRequest.request.invocation.targets[0].beforeFingerprint);
    assert.equal(readOnlyMaterial.content.chunkFingerprint, sha256(readOnlyBytes));
    assert.equal(readOnlyMaterial.observation.observedFingerprint, fingerprintJson({
      requestFingerprint: readOnlyRequest.request.requestFingerprint,
      targetId: 'target.host-runtime-schema',
      contentFingerprint: readOnlyMaterial.target.contentFingerprint,
      mode: readOnlyMaterial.target.mode,
      totalByteLength: readOnlyBytes.length,
      chunkIndex: 0,
      chunkCount: 1,
      chunkByteLength: readOnlyBytes.length,
      chunkFingerprint: readOnlyMaterial.content.chunkFingerprint
    }));
    const unsignedReadOnlyMaterial = structuredClone(readOnlyMaterial);
    delete unsignedReadOnlyMaterial.materialFingerprint;
    assert.equal(readOnlyMaterial.materialFingerprint, fingerprintJson(unsignedReadOnlyMaterial));
    assert.deepEqual(readOnlyMaterial.observation, {
      category: 'local-workspace-read',
      scope: 'request-scoped',
      state: 'observed',
      count: 1,
      observedFingerprint: readOnlyMaterial.observation.observedFingerprint
    });
    assert.equal(readOnlyMaterial.authority.grantsFurtherRead, false);
    assert.equal(readOnlyMaterial.authority.grantsOnwardDisclosure, false);
    assert.equal(readOnlyMaterial.authority.grantsExecution, false);
    assert.equal(readOnlyMaterial.privacy.persistedByCore, false);
    assert.equal(readOnlyMaterial.privacy.hostTranscriptRetention, 'host-dependent');
    assert.equal(readOnlyMaterial.privacy.hostTransportBoundary, 'ambient-selected-host');
    assert.equal(
      readDevelopmentTargetMaterial(readOnlyMaterialInput).materialFingerprint,
      readOnlyMaterial.materialFingerprint
    );
    const contradictoryMaterial = structuredClone(readOnlyMaterial);
    contradictoryMaterial.content.chunkCount = 2;
    contradictoryMaterial.observation.observedFingerprint = fingerprintJson({
      requestFingerprint: contradictoryMaterial.request.fingerprint,
      targetId: contradictoryMaterial.target.id,
      contentFingerprint: contradictoryMaterial.target.contentFingerprint,
      mode: contradictoryMaterial.target.mode,
      totalByteLength: contradictoryMaterial.content.totalByteLength,
      chunkIndex: contradictoryMaterial.content.chunkIndex,
      chunkCount: contradictoryMaterial.content.chunkCount,
      chunkByteLength: contradictoryMaterial.content.chunkByteLength,
      chunkFingerprint: contradictoryMaterial.content.chunkFingerprint
    });
    delete contradictoryMaterial.materialFingerprint;
    contradictoryMaterial.materialFingerprint = fingerprintJson(contradictoryMaterial);
    assert.deepEqual(validateJsonSchema(
      contradictoryMaterial,
      readJson(path.join(temp, 'soter/contracts/development-target-material.schema.json'))
    ), []);
    expectCode(() => assertDevelopmentTargetMaterial(temp, contradictoryMaterial),
      'DEVELOPMENT_REQUEST_TARGET_READ_UNAVAILABLE');
    const tamperedMaterial = structuredClone(readOnlyMaterial);
    tamperedMaterial.content.text += 'tampered';
    expectCode(() => assertDevelopmentTargetMaterial(temp, tamperedMaterial),
      'DEVELOPMENT_REQUEST_TARGET_READ_UNAVAILABLE');
    const reorderedLimitations = structuredClone(readOnlyMaterial);
    reorderedLimitations.limitations.reverse();
    assert.notDeepEqual(validateJsonSchema(
      reorderedLimitations,
      readJson(path.join(temp, 'soter/contracts/development-target-material.schema.json'))
    ), []);
    assert(!JSON.stringify({
      request: readOnlyMaterial.request,
      host: readOnlyMaterial.host,
      target: readOnlyMaterial.target,
      observation: readOnlyMaterial.observation,
      authority: readOnlyMaterial.authority,
      privacy: readOnlyMaterial.privacy
    }).includes(readOnlyPath));
    expectCode(() => readDevelopmentTargetMaterial({
      ...readOnlyMaterialInput,
      requestFingerprint: FP({ wrong: 'request' })
    }), 'DEVELOPMENT_REQUEST_BINDING_INVALID');
    expectCode(() => readDevelopmentTargetMaterial({
      ...readOnlyMaterialInput,
      host: 'claude'
    }), 'DEVELOPMENT_REQUEST_BINDING_INVALID');
    expectCode(() => readDevelopmentTargetMaterial({
      ...readOnlyMaterialInput,
      targetId: 'target.sibling'
    }), 'DEVELOPMENT_REQUEST_TARGET_READ_UNAVAILABLE');
    const originalExecFileSync = childProcess.execFileSync;
    childProcess.execFileSync = (command, args, options) => {
      if (command === 'git'
        && Array.isArray(args)
        && args.includes('--show-toplevel')) {
        throw new Error('planted exact Git inventory failure');
      }
      return originalExecFileSync(command, args, options);
    };
    try {
      expectCode(() => readDevelopmentTargetMaterial(readOnlyMaterialInput),
        'DEVELOPMENT_REQUEST_TARGET_READ_UNAVAILABLE');
    } finally {
      childProcess.execFileSync = originalExecFileSync;
    }
    let malformedChunkOpened = false;
    const originalOpenSync = fs.openSync;
    fs.openSync = (...args) => {
      if (args[0] === readOnlyFile) malformedChunkOpened = true;
      return originalOpenSync(...args);
    };
    try {
      expectCode(() => readDevelopmentTargetMaterial({
        ...readOnlyMaterialInput,
        chunkIndex: -1
      }), 'DEVELOPMENT_REQUEST_TARGET_READ_INVALID');
      assert.equal(malformedChunkOpened, false);
    } finally {
      fs.openSync = originalOpenSync;
    }

    const multiChunkPath = 'soter/contracts/development-request.schema.json';
    const multiChunkBytes = fs.readFileSync(path.join(temp, multiChunkPath));
    assert(multiChunkBytes.length > 8 * 1024);
    const multiChunkRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath: reviewLockPath,
      workflowId: 'automation.reviewing-forge-output',
      requestId: 'development-request.multi-chunk-target',
      invocation: {
        kind: 'develop',
        profile: 'exact',
        requestedOutcome: 'Prove a larger exact governed text target remains fully readable in bounded chunks.',
        requestedLocalEffects: ['local-workspace-read'],
        targets: [{ id: 'target.multi-chunk-schema', path: multiChunkPath }]
      },
      createdAt: '2026-07-22T09:00:30.000Z'
    });
    const multiChunkParts = [];
    let nextChunkIndex = 0;
    let previousMultiChunkFingerprint = null;
    let lastChunk;
    while (nextChunkIndex !== null) {
      lastChunk = readDevelopmentTargetMaterial({
        root: temp,
        host: 'codex',
        requestId: multiChunkRequest.request.id,
        requestFingerprint: multiChunkRequest.request.requestFingerprint,
        targetId: 'target.multi-chunk-schema',
        chunkIndex: nextChunkIndex,
        previousMaterialFingerprint: previousMultiChunkFingerprint
      });
      assert.equal(lastChunk.content.chunkIndex, nextChunkIndex);
      multiChunkParts.push(lastChunk.content.text);
      previousMultiChunkFingerprint = lastChunk.materialFingerprint;
      nextChunkIndex = lastChunk.content.nextChunkIndex;
    }
    assert.equal(multiChunkParts.join(''), multiChunkBytes.toString('utf8'));
    assert.equal(lastChunk.content.complete, true);
    assert(lastChunk.content.chunkCount > 1);
    expectCode(() => readDevelopmentTargetMaterial({
      root: temp,
      host: 'codex',
      requestId: multiChunkRequest.request.id,
      requestFingerprint: multiChunkRequest.request.requestFingerprint,
      targetId: 'target.multi-chunk-schema',
      chunkIndex: 1,
      previousMaterialFingerprint: FP({ wrong: 'previous-material' })
    }), 'DEVELOPMENT_REQUEST_BINDING_INVALID');
    expectCode(() => readDevelopmentTargetMaterial({
      root: temp,
      host: 'codex',
      requestId: multiChunkRequest.request.id,
      requestFingerprint: multiChunkRequest.request.requestFingerprint,
      targetId: 'target.multi-chunk-schema',
      chunkIndex: lastChunk.content.chunkCount,
      previousMaterialFingerprint: lastChunk.materialFingerprint
    }), 'DEVELOPMENT_REQUEST_TARGET_READ_UNAVAILABLE');
    if (process.platform !== 'win32') {
      assert.equal(readOnlyRequest.request.invocation.targets[0].beforeMode, '0644');
      fs.chmodSync(readOnlyFile, 0o600);
      expectCode(() => readDevelopmentTargetMaterial(readOnlyMaterialInput),
        'DEVELOPMENT_REQUEST_TARGET_STALE');
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
    expectCode(() => readDevelopmentTargetMaterial(readOnlyMaterialInput),
      'DEVELOPMENT_REQUEST_TARGET_STALE');
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
    expectCode(() => readDevelopmentTargetMaterial(readOnlyMaterialInput),
      'DEVELOPMENT_REQUEST_TARGET_STALE');
    staleInspection = inspectDevelopmentRun({
      root: temp,
      requestId: 'development-request.read-only-staleness'
    });
    assert.equal(staleInspection.applicability.reasonCode, 'DEVELOPMENT_REQUEST_TARGET_STALE');
    fs.unlinkSync(readOnlyFile);
    fs.renameSync(heldReadOnly, readOnlyFile);
    fs.renameSync(readOnlyFile, heldReadOnly);
    fs.linkSync(heldReadOnly, readOnlyFile);
    expectCode(() => readDevelopmentTargetMaterial(readOnlyMaterialInput),
      'DEVELOPMENT_REQUEST_TARGET_STALE');
    fs.unlinkSync(readOnlyFile);
    fs.renameSync(heldReadOnly, readOnlyFile);
    const unrelatedFile = path.join(temp, 'unrelated-development-drift.txt');
    fs.writeFileSync(unrelatedFile, 'unrelated drift\n');
    expectCode(() => readDevelopmentTargetMaterial(readOnlyMaterialInput),
      'DEVELOPMENT_REQUEST_WORKSPACE_STALE');
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
    const hostClosureRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath: reviewLockPath,
      workflowId: 'automation.reviewing-forge-output',
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
    const hostClosureMaterialInput = {
      root: temp,
      host: 'codex',
      requestId: hostClosureRequestId,
      requestFingerprint: hostClosureRequest.request.requestFingerprint,
      targetId: 'target.host-closure-schema'
    };
    assert.equal(
      readDevelopmentTargetMaterial(hostClosureMaterialInput).content.text,
      readOnlyBytes.toString('utf8')
    );
    const hostClosureEffects = [
      {
        category: 'local-workspace-read',
        state: 'observed',
        count: 1
      },
      ...['local-workspace-write', 'local-command', 'subagent-dispatch'].map((category) => ({
        category,
        state: 'not-observed',
        count: 0
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
        state: 'passed'
      }],
      localEffects: hostClosureEffects,
      completedAt: '2026-07-22T09:06:00.000Z'
    });
    assert.equal(hostClosure.inspection.progress.state, 'passed');
    assert.deepEqual(hostClosure.inspection.result.evidenceBasis, {
      state: 'host-reported',
      reasonCode: 'DEVELOPMENT_RESULT_HOST_REPORTED_UNVERIFIED',
      independentlyVerified: false
    });
    assert(hostClosure.inspection.limitations.some((limitation) => {
      return limitation.includes('not independent verification');
    }));
    const developmentInspectionSchema = readJson(path.join(
      temp,
      'soter/contracts/development-run-inspection.schema.json'
    ));
    const crossedHostEvidenceBasis = structuredClone(hostClosure.inspection);
    crossedHostEvidenceBasis.result.evidenceBasis = {
      state: 'independently-evaluated',
      reasonCode: 'DEVELOPMENT_RESULT_INDEPENDENT_EVALUATION_RECORDED',
      independentlyVerified: true
    };
    assert(validateJsonSchema(crossedHostEvidenceBasis, developmentInspectionSchema).length > 0);
    const closedWithoutResult = structuredClone(hostClosure.inspection);
    closedWithoutResult.result = null;
    assert(validateJsonSchema(closedWithoutResult, developmentInspectionSchema).length > 0);

    const crossedPassedProgress = structuredClone(hostClosure.inspection);
    crossedPassedProgress.progress.state = 'failed';
    crossedPassedProgress.checks[0].state = 'failed';
    assert(validateJsonSchema(crossedPassedProgress, developmentInspectionSchema).length > 0);

    const incoherentCreateInspection = structuredClone(hostClosure.inspection);
    incoherentCreateInspection.changes[0].kind = 'create';
    incoherentCreateInspection.changes[0].beforeFingerprint = FP({ unexpected: 'before' });
    incoherentCreateInspection.changes[0].afterFingerprint = null;
    assert(validateJsonSchema(incoherentCreateInspection, developmentInspectionSchema).length > 0);

    const incoherentEffectInspection = structuredClone(hostClosure.inspection);
    const incoherentEffect = incoherentEffectInspection.effects.find((item) => {
      return item.category === 'local-workspace-read';
    });
    incoherentEffect.count = 0;
    incoherentEffect.observedFingerprint = null;
    assert(validateJsonSchema(incoherentEffectInspection, developmentInspectionSchema).length > 0);

    for (const field of ['changes', 'checks', 'effects']) {
      const duplicateInspection = structuredClone(hostClosure.inspection);
      duplicateInspection[field].push(structuredClone(duplicateInspection[field][0]));
      assert(validateJsonSchema(duplicateInspection, developmentInspectionSchema).length > 0);
    }

    const duplicateChangeId = structuredClone(hostClosure.inspection);
    duplicateChangeId.changes.push({
      ...structuredClone(duplicateChangeId.changes[0]),
      kind: 'modify',
      afterFingerprint: FP({ different: 'after' })
    });
    expectCode(
      () => assertDevelopmentRunInspection(temp, resignInspection(duplicateChangeId)),
      'DEVELOPMENT_INSPECTION_INVALID'
    );

    const unequalUnchanged = structuredClone(hostClosure.inspection);
    unequalUnchanged.changes[0].afterFingerprint = FP({ unequal: 'unchanged' });
    expectCode(
      () => assertDevelopmentRunInspection(temp, resignInspection(unequalUnchanged)),
      'DEVELOPMENT_INSPECTION_INVALID'
    );

    const equalModify = structuredClone(hostClosure.inspection);
    equalModify.changes[0].kind = 'modify';
    expectCode(
      () => assertDevelopmentRunInspection(temp, resignInspection(equalModify)),
      'DEVELOPMENT_INSPECTION_INVALID'
    );

    const privateInspection = structuredClone(hostClosure.inspection);
    privateInspection.limitations[0] = 'Inspect the private local source at /tmp/private-development-inspection.';
    expectCode(
      () => assertDevelopmentRunInspection(temp, resignInspection(privateInspection)),
      'DEVELOPMENT_INSPECTION_PRIVATE_MATERIAL_INVALID'
    );

    const tamperedInspection = structuredClone(hostClosure.inspection);
    tamperedInspection.progress.completedRuns += 1;
    expectCode(
      () => assertDevelopmentRunInspection(temp, tamperedInspection),
      'DEVELOPMENT_INSPECTION_INVALID'
    );
    const mismatchedInspectionFingerprint = structuredClone(hostClosure.inspection);
    mismatchedInspectionFingerprint.inspectionFingerprint = FP({ mismatched: 'inspection' });
    expectCode(
      () => assertDevelopmentRunInspection(temp, mismatchedInspectionFingerprint),
      'DEVELOPMENT_INSPECTION_TAMPERED'
    );
    assert.equal(hostClosure.inspection.requestBoundary.state, 'closed');
    assert.deepEqual(hostClosure.result.changes.map(({ id, kind }) => ({ id, kind })), [{
      id: 'change.target.host-closure-schema',
      kind: 'unchanged'
    }]);
    assert.match(hostClosure.result.checks[0].observedFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.match(
      hostClosure.result.effects.find((effect) => effect.category === 'local-workspace-read')
        .observedFingerprint,
      /^sha256:[a-f0-9]{64}$/
    );
    assert.equal(
      readDevelopmentResultState(temp, 'development-result.host-closure').result.resultFingerprint,
      hostClosure.result.resultFingerprint
    );
    expectCode(() => readDevelopmentTargetMaterial(hostClosureMaterialInput),
      'DEVELOPMENT_REQUEST_CLOSED');

    const boundedReadCases = [
      ['development-no-read.txt', Buffer.from('no read authority\n')],
      ['.env', Buffer.from('PRIVATE_VALUE=not-returned\n')],
      ['development-invalid-utf8.bin', Buffer.from([0xc3, 0x28])],
      ['development-nul.txt', Buffer.from('before\u0000after')],
      ['development-credential-pattern.txt', Buffer.from('sk-' + 'a'.repeat(24))],
      ['development-password.txt', Buffer.from('password = correct-horse-battery-staple\n')],
      ['development-token.txt', Buffer.from('token = "abcdefghijklmnopqrstuv"\n')],
      ['development-client-secret.json', Buffer.from('{"clientSecret":"abcdefghijklmnop"}\n')],
      ['development-generic-secret.txt', Buffer.from('secret = "a!bcdefgh"\n')],
      ['development-declared-secret.mjs', Buffer.from('const secret = "a!bcdefgh";\n')],
      ['development-password-punctuation.txt', Buffer.from('password = "a!bcdefgh"\n')],
      ['development-token-punctuation.txt', Buffer.from('token = "a!bcdefgh"\n')],
      ['development-api-key-punctuation.txt', Buffer.from('apiKey = "a!bcdefgh"\n')],
      ['development-client-secret-punctuation.txt', Buffer.from('client_secret = "a!bcdefgh"\n')],
      ['development-access-token-punctuation.txt', Buffer.from('accessToken = "a!bcdefgh"\n')],
      ['development-refresh-token-punctuation.txt', Buffer.from('refresh-token = "a!bcdefgh"\n')],
      ['development-private-key-punctuation.txt', Buffer.from('privateKey = "a!bcdefgh"\n')],
      ['development-openai-api-key.txt', Buffer.from('OPENAI_API_KEY = abcdefghijklmnop\n')],
      ['development-anthropic-api-key.txt', Buffer.from('ANTHROPIC_API_KEY: abcdefghijklmnop\n')],
      ['development-database-url.txt', Buffer.from('DATABASE_URL=postgres://u:p@h/db\n')],
      ['development-private-key-block.txt', Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE_KEY_BLOCK_SENTINEL\n-----END OPENSSH PRIVATE KEY-----\n')],
      ['development-safe-api-description.txt', Buffer.from('apiKeyFormat = "identifier-only"\ntokenType = "opaque-reference"\n')],
      ['development-ignored-secret.txt', Buffer.from('ignored private review material\n')],
      ['development-unicode-chunk.txt', Buffer.from('界'.repeat(3000) + '\n')],
      ['development-bom.txt', Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('BOM-preserved\n')
      ])],
      ['development-oversized.txt', Buffer.alloc((1024 * 1024) + 1, 0x61)],
      ['development-sibling-a.txt', Buffer.from('sibling a\n')],
      ['development-sibling-b.txt', Buffer.from('sibling b\n')]
    ];
    for (const [relative, bytes] of boundedReadCases) {
      fs.writeFileSync(path.join(temp, relative), bytes);
    }
    fs.mkdirSync(path.join(temp, '.aws'));
    fs.writeFileSync(
      path.join(temp, '.aws/credentials'),
      'aws_secret_access_key = ' + 'A'.repeat(40) + '\n'
    );
    fs.mkdirSync(path.join(temp, '.docker'));
    fs.writeFileSync(
      path.join(temp, '.docker/config.json'),
      JSON.stringify({ auths: { registry: { auth: 'YWJjZGVmZ2hpamts' } } }) + '\n'
    );
    fs.mkdirSync(path.join(temp, 'config'));
    fs.writeFileSync(
      path.join(temp, 'config/credentials.toml'),
      'token = "abcdefghijklmnopqrstuv"\n'
    );
    fs.appendFileSync(
      path.join(temp, '.git/info/exclude'),
      '\ndevelopment-ignored-secret.txt\n'
    );
    const noReadRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath,
      workflowId: 'automation.forge',
      requestId: 'development-request.no-read-effect',
      invocation: {
        kind: 'develop',
        profile: 'exact',
        requestedOutcome: 'Prove target material requires explicit local read authority.',
        requestedLocalEffects: ['local-workspace-write'],
        targets: [{ id: 'target.no-read', path: 'development-no-read.txt' }]
      },
      createdAt: '2026-07-22T09:06:30.000Z'
    });
    expectCode(() => readDevelopmentTargetMaterial({
      root: temp,
      host: 'codex',
      requestId: noReadRequest.request.id,
      requestFingerprint: noReadRequest.request.requestFingerprint,
      targetId: 'target.no-read'
    }), 'DEVELOPMENT_REQUEST_EFFECT_POLICY_INVALID');

    const evaluationRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath: auditEvaluationLockPath,
      workflowId: 'automation.auditing-a-schema-doc',
      requestId: 'development-request.target-read-evaluation',
      invocation: buildDevelopmentEvaluationInvocation({
        root: temp,
        workflowId: 'automation.auditing-a-schema-doc'
      }),
      createdAt: '2026-07-22T09:06:40.000Z'
    });
    expectCode(() => readDevelopmentTargetMaterial({
      root: temp,
      host: 'codex',
      requestId: evaluationRequest.request.id,
      requestFingerprint: evaluationRequest.request.requestFingerprint,
      targetId: 'target.none'
    }), 'DEVELOPMENT_REQUEST_EFFECT_POLICY_INVALID');

    const unavailableTargetCases = [
      ['missing', 'development-missing.txt'],
      ['private-name', '.env'],
      ['invalid-utf8', 'development-invalid-utf8.bin'],
      ['nul', 'development-nul.txt'],
      ['credential-pattern', 'development-credential-pattern.txt'],
      ['password-assignment', 'development-password.txt'],
      ['token-assignment', 'development-token.txt'],
      ['client-secret-assignment', 'development-client-secret.json'],
      ['generic-secret-punctuation', 'development-generic-secret.txt'],
      ['declared-secret-punctuation', 'development-declared-secret.mjs'],
      ['password-punctuation', 'development-password-punctuation.txt'],
      ['token-punctuation', 'development-token-punctuation.txt'],
      ['api-key-punctuation', 'development-api-key-punctuation.txt'],
      ['client-secret-punctuation', 'development-client-secret-punctuation.txt'],
      ['access-token-punctuation', 'development-access-token-punctuation.txt'],
      ['refresh-token-punctuation', 'development-refresh-token-punctuation.txt'],
      ['private-key-punctuation', 'development-private-key-punctuation.txt'],
      ['openai-api-key-assignment', 'development-openai-api-key.txt'],
      ['anthropic-api-key-assignment', 'development-anthropic-api-key.txt'],
      ['database-url-assignment', 'development-database-url.txt'],
      ['private-key-block', 'development-private-key-block.txt'],
      ['credentials-extension', 'config/credentials.toml'],
      ['aws-credentials', '.aws/credentials'],
      ['docker-auth', '.docker/config.json'],
      ['ignored-private', 'development-ignored-secret.txt'],
      ['oversized', 'development-oversized.txt']
    ];
    for (const [id, relative] of unavailableTargetCases) {
      const request = prepareDevelopmentRequest({
        root: temp,
        lockPath: reviewLockPath,
        workflowId: 'automation.reviewing-forge-output',
        requestId: 'development-request.target-read-' + id,
        invocation: {
          kind: 'develop',
          profile: 'exact',
          requestedOutcome: 'Prove unsafe or unavailable target material fails closed.',
          requestedLocalEffects: ['local-workspace-read'],
          targets: [{ id: 'target.' + id, path: relative }]
        },
        createdAt: '2026-07-22T09:06:50.000Z'
      });
      expectCode(() => readDevelopmentTargetMaterial({
        root: temp,
        host: 'codex',
        requestId: request.request.id,
        requestFingerprint: request.request.requestFingerprint,
        targetId: 'target.' + id
      }), 'DEVELOPMENT_REQUEST_TARGET_READ_UNAVAILABLE');
    }

    const safeCredentialVocabularyRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath: reviewLockPath,
      workflowId: 'automation.reviewing-forge-output',
      requestId: 'development-request.target-read-safe-credential-vocabulary',
      invocation: {
        kind: 'develop',
        profile: 'exact',
        requestedOutcome: 'Prove schema-like credential vocabulary without credential values remains readable.',
        requestedLocalEffects: ['local-workspace-read'],
        targets: [{
          id: 'target.safe-credential-vocabulary',
          path: 'development-safe-api-description.txt'
        }]
      },
      createdAt: '2026-07-22T09:06:52.000Z'
    });
    const safeCredentialVocabulary = readDevelopmentTargetMaterial({
      root: temp,
      host: 'codex',
      requestId: safeCredentialVocabularyRequest.request.id,
      requestFingerprint: safeCredentialVocabularyRequest.request.requestFingerprint,
      targetId: 'target.safe-credential-vocabulary'
    });
    assert.equal(
      safeCredentialVocabulary.content.text,
      'apiKeyFormat = "identifier-only"\ntokenType = "opaque-reference"\n'
    );

    const unicodeChunkRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath: reviewLockPath,
      workflowId: 'automation.reviewing-forge-output',
      requestId: 'development-request.target-read-unicode-chunks',
      invocation: {
        kind: 'develop',
        profile: 'exact',
        requestedOutcome: 'Prove multi-byte UTF-8 text remains complete and byte-bounded.',
        requestedLocalEffects: ['local-workspace-read'],
        targets: [{ id: 'target.unicode-chunks', path: 'development-unicode-chunk.txt' }]
      },
      createdAt: '2026-07-22T09:06:55.000Z'
    });
    const unicodeParts = [];
    let unicodeIndex = 0;
    let previousUnicodeFingerprint = null;
    while (unicodeIndex !== null) {
      const material = readDevelopmentTargetMaterial({
        root: temp,
        host: 'codex',
        requestId: unicodeChunkRequest.request.id,
        requestFingerprint: unicodeChunkRequest.request.requestFingerprint,
        targetId: 'target.unicode-chunks',
        chunkIndex: unicodeIndex,
        previousMaterialFingerprint: previousUnicodeFingerprint
      });
      assert(material.content.chunkByteLength <= 8 * 1024);
      assert.equal(
        material.content.chunkByteLength,
        Buffer.byteLength(material.content.text, 'utf8')
      );
      unicodeParts.push(material.content.text);
      previousUnicodeFingerprint = material.materialFingerprint;
      unicodeIndex = material.content.nextChunkIndex;
    }
    assert.equal(unicodeParts.join(''), '界'.repeat(3000) + '\n');

    const bomRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath: reviewLockPath,
      workflowId: 'automation.reviewing-forge-output',
      requestId: 'development-request.target-read-bom',
      invocation: {
        kind: 'develop',
        profile: 'exact',
        requestedOutcome: 'Prove an exact UTF-8 BOM remains present in returned target bytes.',
        requestedLocalEffects: ['local-workspace-read'],
        targets: [{ id: 'target.bom', path: 'development-bom.txt' }]
      },
      createdAt: '2026-07-22T09:06:57.000Z'
    });
    const bomMaterial = readDevelopmentTargetMaterial({
      root: temp,
      host: 'codex',
      requestId: bomRequest.request.id,
      requestFingerprint: bomRequest.request.requestFingerprint,
      targetId: 'target.bom'
    });
    assert.deepEqual(
      Buffer.from(bomMaterial.content.text, 'utf8'),
      fs.readFileSync(path.join(temp, 'development-bom.txt'))
    );

    const siblingRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath: reviewLockPath,
      workflowId: 'automation.reviewing-forge-output',
      requestId: 'development-request.target-read-sibling-drift',
      invocation: {
        kind: 'develop',
        profile: 'exact',
        requestedOutcome: 'Prove every exact sibling target remains current before one target is returned.',
        requestedLocalEffects: ['local-workspace-read'],
        targets: [
          { id: 'target.sibling-a', path: 'development-sibling-a.txt' },
          { id: 'target.sibling-b', path: 'development-sibling-b.txt' }
        ]
      },
      createdAt: '2026-07-22T09:06:55.000Z'
    });
    fs.appendFileSync(path.join(temp, 'development-sibling-b.txt'), 'drift\n');
    expectCode(() => readDevelopmentTargetMaterial({
      root: temp,
      host: 'codex',
      requestId: siblingRequest.request.id,
      requestFingerprint: siblingRequest.request.requestFingerprint,
      targetId: 'target.sibling-a'
    }), 'DEVELOPMENT_REQUEST_TARGET_STALE');
    const legacyHostClosureRequestId = 'development-request.host-closure-legacy';
    const legacyHostClosureRequest = prepareDevelopmentRequest({
      root: temp,
      lockPath: reviewLockPath,
      workflowId: 'automation.reviewing-forge-output',
      requestId: legacyHostClosureRequestId,
      invocation: {
        kind: 'develop',
        profile: 'exact',
        requestedOutcome: 'Prove a persisted host result remains idempotently readable after the recorder derives its own claim fingerprints.',
        requestedLocalEffects: ['local-workspace-read'],
        targets: [{ id: 'target.host-closure-schema', path: readOnlyPath }]
      },
      createdAt: '2026-07-22T09:06:10.000Z'
    });
    const legacyTarget = legacyHostClosureRequest.request.invocation.targets[0];
    const legacyCheckFingerprint = FP({ legacyHostClosure: 'check' });
    const legacyReadFingerprint = FP({ legacyHostClosure: 'read' });
    const legacyOutcome = {
      state: 'passed',
      workerRuns: [],
      judgments: [],
      changes: [{
        id: 'change.target.host-closure-schema',
        path: readOnlyPath,
        kind: 'unchanged',
        beforeFingerprint: legacyTarget.beforeFingerprint,
        afterFingerprint: legacyTarget.beforeFingerprint
      }],
      checks: [{
        id: 'check.host-closure-schema',
        state: 'passed',
        observedFingerprint: legacyCheckFingerprint
      }],
      effects: hostClosure.result.effects.map((effect) => ({
        ...structuredClone(effect),
        observedFingerprint: effect.category === 'local-workspace-read'
          ? legacyReadFingerprint
          : effect.state === 'observed'
            ? effect.observedFingerprint
            : null
      })),
      promotion: {
        state: 'held',
        artifactFingerprint: null,
        reasonCode: 'PROMOTION_AUTHORITY_NOT_GRANTED'
      },
      decisionEvidence: [],
      limitations: ['This pre-derivation host result is immutable and grants no operational authority.']
    };
    const legacyRecorded = recordDevelopmentResult({
      root: temp,
      lockPath: reviewLockPath,
      requestId: legacyHostClosureRequestId,
      outcome: legacyOutcome,
      completedAt: '2026-07-22T09:06:20.000Z'
    });
    const legacyReentry = recordHostDevelopmentResult({
      root: temp,
      requestId: legacyHostClosureRequestId,
      state: 'passed',
      checks: [{ id: 'check.host-closure-schema', state: 'passed' }],
      localEffects: hostClosureEffects,
      completedAt: '2026-07-22T09:06:20.000Z'
    });
    assert.equal(legacyReentry.result.resultFingerprint, legacyRecorded.result.resultFingerprint);
    assert.equal(legacyReentry.result.checks[0].observedFingerprint, legacyCheckFingerprint);
    expectCode(() => recordHostDevelopmentResult({
      root: temp,
      requestId: legacyHostClosureRequestId,
      state: 'passed',
      checks: [{ id: 'check.host-closure-schema-changed', state: 'passed' }],
      localEffects: hostClosureEffects,
      completedAt: '2026-07-22T09:06:20.000Z'
    }), 'DEVELOPMENT_RESULT_REENTRY_MISMATCH');
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
    const zeroObservedEffects = structuredClone(hostClosureEffects);
    zeroObservedEffects[0].count = 0;
    expectCode(() => recordHostDevelopmentResult({
      root: temp,
      requestId: 'development-request.read-only-staleness',
      state: 'blocked',
      checks: [],
      localEffects: zeroObservedEffects,
      completedAt: '2026-07-22T09:07:00.000Z'
    }), 'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED');
    const nonzeroUnobservedEffects = structuredClone(hostClosureEffects);
    nonzeroUnobservedEffects[1].count = 1;
    expectCode(() => recordHostDevelopmentResult({
      root: temp,
      requestId: 'development-request.read-only-staleness',
      state: 'blocked',
      checks: [],
      localEffects: nonzeroUnobservedEffects,
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

    const falseEvaluationChange = passingOutcome(invocation, evaluations);
    falseEvaluationChange.changes = [{
      id: 'change.false-evaluation-target',
      path: 'soter/scratch/false-evaluation-target.mjs',
      kind: 'create',
      beforeFingerprint: FP({ false: 'before' }),
      afterFingerprint: null
    }];
    expectCode(() => recordDevelopmentResult({
      root: temp,
      lockPath,
      requestId,
      outcome: falseEvaluationChange,
      completedAt: '2026-07-22T10:09:00.000Z'
    }), 'DEVELOPMENT_RESULT_BINDING_INVALID');

    const unsupportedPassedCheck = passingOutcome(invocation, evaluations);
    unsupportedPassedCheck.checks[0].observedFingerprint = null;
    expectCode(() => recordDevelopmentResult({
      root: temp,
      lockPath,
      requestId,
      outcome: unsupportedPassedCheck,
      completedAt: '2026-07-22T10:09:30.000Z'
    }), 'DEVELOPMENT_RESULT_PASS_UNSUPPORTED');

    const outcome = passingOutcome(invocation, evaluations);
    const recorded = recordDevelopmentResult({
      root: temp,
      lockPath,
      requestId,
      outcome,
      completedAt: '2026-07-22T10:10:00.000Z'
    });
    assert.equal(recorded.inspection.progress.state, 'passed');
    assert.deepEqual(recorded.inspection.result.evidenceBasis, {
      state: 'independently-evaluated',
      reasonCode: 'DEVELOPMENT_RESULT_INDEPENDENT_EVALUATION_RECORDED',
      independentlyVerified: true
    });
    const crossedEvaluationEvidenceBasis = structuredClone(recorded.inspection);
    crossedEvaluationEvidenceBasis.result.evidenceBasis = {
      state: 'host-reported',
      reasonCode: 'DEVELOPMENT_RESULT_HOST_REPORTED_UNVERIFIED',
      independentlyVerified: false
    };
    assert(validateJsonSchema(
      crossedEvaluationEvidenceBasis,
      developmentInspectionSchema
    ).length > 0);
    const crossedEvaluationProgress = structuredClone(recorded.inspection);
    crossedEvaluationProgress.progress.completedRuns -= 1;
    expectCode(
      () => assertDevelopmentRunInspection(temp, resignInspection(crossedEvaluationProgress)),
      'DEVELOPMENT_INSPECTION_INVALID'
    );
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
        'DEVELOPMENT_RESULT_MALFORMED'
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
        'DEVELOPMENT_RESULT_MALFORMED'
      );
      const incoherentUnobservedLocalEffect = passingOutcome(invocation, evaluations);
      const unobservedCommand = incoherentUnobservedLocalEffect.effects.find((item) => {
        return item.category === 'local-command';
      });
      unobservedCommand.state = 'not-observed';
      unobservedCommand.count = 1;
      expectCode(
        () => recordHostile(incoherentUnobservedLocalEffect),
        'DEVELOPMENT_RESULT_MALFORMED'
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
    const evaluationFactsOnDevelop = structuredClone(governedOutcome);
    const evaluationSource = passingOutcome(invocation, evaluations);
    evaluationFactsOnDevelop.workerRuns = [structuredClone(evaluationSource.workerRuns[0])];
    evaluationFactsOnDevelop.judgments = [structuredClone(evaluationSource.judgments[0])];
    expectCode(() => recordDevelopmentResult({
      root: temp,
      lockPath,
      requestId: governedRequest.request.id,
      outcome: evaluationFactsOnDevelop,
      completedAt: '2026-07-22T11:08:00.000Z'
    }), 'DEVELOPMENT_RESULT_BINDING_INVALID');
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

    const nonRepositoryRoot = fs.mkdtempSync(path.join(
      fs.realpathSync(os.tmpdir()),
      'soter-development-nonrepo-'
    ));
    try {
      copyHarnessRoot(root, nonRepositoryRoot);
      const nonRepositoryLock = materializeExactDevelopmentHost(nonRepositoryRoot);
      const nonRepositoryConfigPath = path.relative(
        nonRepositoryRoot,
        privateConfigurationStatePath(
          nonRepositoryRoot,
          nonRepositoryLock.configuration.name
        )
      ).split(path.sep).join('/');
      const nonRepositoryReviewLockPath = materializeDevelopmentCandidateLock({
        root: nonRepositoryRoot,
        configPath: nonRepositoryConfigPath,
        workflowId: 'automation.reviewing-forge-output',
        host: 'codex'
      }).path;
      const nonRepositoryRequest = prepareDevelopmentRequest({
        root: nonRepositoryRoot,
        lockPath: nonRepositoryReviewLockPath,
        workflowId: 'automation.reviewing-forge-output',
        requestId: 'development-request.nonrepository-target-read',
        invocation: {
          kind: 'develop',
          profile: 'exact',
          requestedOutcome: 'Prove target reads fail closed without exact Git repository membership.',
          requestedLocalEffects: ['local-workspace-read'],
          targets: [{
            id: 'target.nonrepository-schema',
            path: 'soter/contracts/host-runtime-inspection.schema.json'
          }]
        },
        createdAt: '2026-07-22T11:11:00.000Z'
      });
      expectCode(() => readDevelopmentTargetMaterial({
        root: nonRepositoryRoot,
        host: 'codex',
        requestId: nonRepositoryRequest.request.id,
        requestFingerprint: nonRepositoryRequest.request.requestFingerprint,
        targetId: 'target.nonrepository-schema'
      }), 'DEVELOPMENT_REQUEST_TARGET_READ_UNAVAILABLE');
    } finally {
      fs.rmSync(nonRepositoryRoot, { recursive: true, force: true });
    }

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
