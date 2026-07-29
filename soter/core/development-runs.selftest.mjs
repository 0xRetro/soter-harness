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
  recordDevelopmentResult
} from './development-runs.mjs';
import { fingerprintJson, readJson, writeJson } from './lib/canonical-json.mjs';
import { materializeDevelopmentCandidateLock } from './development-candidate-locks.mjs';

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

function copyHarnessRoot(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.soter' || entry.name === 'node_modules') continue;
    fs.cpSync(path.join(source, entry.name), path.join(target, entry.name), { recursive: true });
  }
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
    effects: [{
      category: 'local-workspace-write',
      scope: 'request-scoped',
      state: 'observed',
      count: 1,
      observedFingerprint: FP({ changed: 1 })
    }, ...[
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
    }))],
    promotion: {
      state: 'held',
      artifactFingerprint: null,
      reasonCode: 'MIGRATION_AUTHORITY_NOT_GRANTED'
    },
    decisionEvidence: [],
    limitations: ['This contained result is scoped evidence and cannot remove a legacy fallback.']
  };
  const baselineRun = outcome.workerRuns.find((run) => run.arm === 'baseline');
  const baselineJudgment = outcome.judgments.find((item) => item.workerRunId === baselineRun.id);
  baselineRun.state = 'failed';
  baselineJudgment.verdict = 'failed';
  baselineJudgment.criteria.find((criterion) => criterion.kind === 'expected').state = 'not-observed';
  return outcome;
}

export async function selftestDevelopmentRuns(root = scriptRoot) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-development-runs-'));
  try {
    copyHarnessRoot(root, temp);
    const configPath = 'soter/configurations/harness-development-catalog.config.json';
    const candidateLock = materializeDevelopmentCandidateLock({
      root: temp,
      configPath,
      workflowId: 'automation.forge',
      host: 'codex'
    });
    const lockPath = candidateLock.path;
    const evaluations = readJson(path.join(temp, 'soter/automations/forge/evaluations.json'));
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
    assert.equal(recorded.inspection.authority.grantsFallbackRemoval, false);
    if (process.platform !== 'win32') {
      assert.equal(mode(path.dirname(privateFiles.result)), 0o700);
      assert.equal(mode(privateFiles.result), 0o600);
    }
    const resultReentry = recordDevelopmentResult({ root: temp, lockPath, requestId, outcome });
    assert.equal(resultReentry.result.resultFingerprint, recorded.result.resultFingerprint);

    const changedOutcome = structuredClone(outcome);
    changedOutcome.promotion.reasonCode = 'DIFFERENT_PRIVATE_OUTCOME';
    expectCode(() => recordDevelopmentResult({ root: temp, lockPath, requestId, outcome: changedOutcome }), 'DEVELOPMENT_RESULT_REENTRY_MISMATCH');

    const hostileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-development-hostile-'));
    try {
      copyHarnessRoot(root, hostileRoot);
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
