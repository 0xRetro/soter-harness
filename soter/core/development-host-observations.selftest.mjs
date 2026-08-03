#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertDevelopmentCandidateLock,
  assertDevelopmentHostObservation,
  fingerprintDevelopmentHostObservation
} from './development-host-observations.mjs';
import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintJson,
  readJson,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import { fingerprintLock } from './resolve.mjs';

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

function fixedRequestAuthority() {
  return {
    kind: 'request-scoped-development',
    providerTransactionAuthority: 'none',
    approvalAuthority: 'none',
    publicationAuthority: 'none',
    mergeAuthority: 'none',
    hostRealizationAuthority: 'none'
  };
}

function fixedPrivatePrivacy() {
  return {
    scope: 'private-runtime',
    workspaceInspectionIncluded: false,
    absolutePathsIncluded: false,
    rawDiffsIncluded: false,
    rawTranscriptsIncluded: false,
    providerResponsesIncluded: false,
    credentialsIncluded: false
  };
}

function fixedEffectBoundary() {
  return {
    localWorkspaceRead: 'request-scoped',
    localWorkspaceWrite: 'request-scoped',
    localCommand: 'request-scoped',
    subagentDispatch: 'request-scoped',
    providerRead: 'separate-authority',
    providerWrite: 'separate-authority',
    publication: 'separate-authority',
    merge: 'separate-authority',
    protectedRootMutation: 'separate-authority',
    hostRealization: 'separate-authority'
  };
}

function requestFixture() {
  const runs = [{
    id: 'evaluation-run.forge.baseline',
    sequence: 1,
    caseId: 'happy-path',
    caseFingerprint: FP({ case: 'happy-path' }),
    stimulusFingerprint: FP({ stimulus: 'happy-path' }),
    arm: 'baseline',
    guideState: 'withheld'
  }, {
    id: 'evaluation-run.forge.guided.happy',
    sequence: 2,
    caseId: 'happy-path',
    caseFingerprint: FP({ case: 'happy-path' }),
    stimulusFingerprint: FP({ stimulus: 'happy-path' }),
    arm: 'guided',
    guideState: 'candidate'
  }, {
    id: 'evaluation-run.forge.guided.pressure',
    sequence: 3,
    caseId: 'pressure-path',
    caseFingerprint: FP({ case: 'pressure-path' }),
    stimulusFingerprint: FP({ stimulus: 'pressure-path' }),
    arm: 'guided',
    guideState: 'candidate'
  }];
  const request = {
    $contract: 'soter://contracts/development-request/v1',
    contractVersion: '1.0.0',
    id: 'development-request.codex.forge-v2-baseline-r12',
    requestFingerprint: FP({ placeholder: 'request' }),
    createdAt: '2026-07-22T10:00:00.000Z',
    workflow: {
      id: 'automation.forge',
      version: '0.2.0',
      evaluatedSubjectFingerprint: FP({ evaluatedSubject: 'forge' }),
      definitionPath: 'soter/automations/forge/definition.json',
      definitionFingerprint: FP({ workflow: 'forge' }),
      guideId: 'workflow-guide.forge',
      guidePath: 'soter/automations/forge/guide.json',
      guideContentFingerprint: FP({ guide: 'forge-content' }),
      guideFingerprint: FP({ guide: 'forge-document' }),
      evaluationSetId: 'evaluation-set.forge',
      evaluationSetPath: 'soter/automations/forge/evaluations.json',
      evaluationSetFingerprint: FP({ evaluations: 'forge' })
    },
    host: {
      id: 'codex',
      adapter: 'host.codex',
      version: '0.3.0',
      adapterFingerprint: FP({ adapter: 'codex' }),
      projectionDefinitionId: 'host-projection.codex',
      projectionDefinitionFingerprint: FP({ projection: 'codex' }),
      evaluatedInstructionFingerprint: FP({ instructions: 'codex-forge' }),
      candidateProjectionFingerprint: FP({ candidate: 'forge-codex' }),
      managedManifestFingerprint: FP({ managedManifest: 'codex' })
    },
    configuration: {
      name: 'harness-development-catalog',
      lockPath: 'soter/fixtures/harness-development-catalog/harness-development-catalog.lock.json',
      lockFingerprint: FP({ lock: 'development' }),
      graphFingerprint: FP({ graph: 'development' })
    },
    workspace: {
      rootIdentityFingerprint: FP({ root: 'contained-worktree' }),
      revisionFingerprint: FP({ revision: 'before' }),
      treeFingerprint: FP({ tree: 'before' }),
      untargetedTreeFingerprint: FP({ tree: 'untargeted-before' }),
      exactInputState: 'clean',
      policyId: 'settings.kernel.soter.development-workspace',
      policyPath: 'soter/kernel/development-workspace.settings.json',
      policyFingerprint: FP({ policy: 'development-workspace' }),
      settingsFingerprint: FP({ settings: 'development-workspace' })
    },
    invocation: {
      kind: 'evaluation-suite',
      profile: 'exact',
      freshWorkerPerRun: true,
      expectationsWithheld: true,
      requestedLocalEffects: [
        'local-workspace-read',
        'local-workspace-write',
        'local-command',
        'subagent-dispatch'
      ],
      plannedRuns: runs
    },
    effectBoundary: fixedEffectBoundary(),
    authority: fixedRequestAuthority(),
    privacy: fixedPrivatePrivacy(),
    limitations: ['This contained request is private and grants no operational authority.']
  };
  request.requestFingerprint = FP(Object.fromEntries(
    Object.entries(request).filter(([key]) => key !== 'requestFingerprint')
  ));
  return request;
}

function criteria(caseId, expectedState = 'observed') {
  return [{
    id: caseId + '.expected.1',
    kind: 'expected',
    sequence: 1,
    state: expectedState,
    evidenceFingerprint: FP({ caseId, criterion: 'expected' })
  }, {
    id: caseId + '.prohibited.1',
    kind: 'prohibited',
    sequence: 1,
    state: 'not-observed',
    evidenceFingerprint: FP({ caseId, criterion: 'prohibited' })
  }];
}

function resultFixture(request) {
  const workerRuns = request.invocation.plannedRuns.map((run, index) => ({
    id: 'worker-run.forge.observation.' + String(index + 1),
    sequence: index + 1,
    requestRunId: run.id,
    caseId: run.caseId,
    arm: run.arm,
    guideState: run.guideState,
    workerFingerprint: FP({ worker: index + 1 }),
    dispatchFingerprint: FP({ dispatch: index + 1 }),
    expectationsIncluded: false,
    answerKeyAccess: 'not-observed',
    transcriptFingerprint: FP({ transcript: index + 1 }),
    state: run.arm === 'baseline' ? 'failed' : 'passed'
  }));
  const result = {
    $contract: 'soter://contracts/development-result/v1',
    contractVersion: '1.0.0',
    id: 'development-result.' + request.id.slice('development-request.'.length),
    resultFingerprint: FP({ placeholder: 'result' }),
    createdAt: '2026-07-22T10:00:01.000Z',
    completedAt: '2026-07-22T10:06:00.000Z',
    request: { id: request.id, fingerprint: request.requestFingerprint },
    workflow: {
      id: request.workflow.id,
      version: request.workflow.version,
      evaluatedSubjectFingerprint: request.workflow.evaluatedSubjectFingerprint,
      definitionFingerprint: request.workflow.definitionFingerprint,
      guideContentFingerprint: request.workflow.guideContentFingerprint,
      evaluationSetFingerprint: request.workflow.evaluationSetFingerprint
    },
    host: {
      id: request.host.id,
      adapterFingerprint: request.host.adapterFingerprint,
      projectionDefinitionFingerprint: request.host.projectionDefinitionFingerprint,
      evaluatedInstructionFingerprint: request.host.evaluatedInstructionFingerprint,
      candidateProjectionFingerprint: request.host.candidateProjectionFingerprint,
      managedManifestFingerprint: request.host.managedManifestFingerprint
    },
    configuration: {
      name: request.configuration.name,
      lockFingerprint: request.configuration.lockFingerprint,
      graphFingerprint: request.configuration.graphFingerprint
    },
    workspace: {
      rootIdentityFingerprint: request.workspace.rootIdentityFingerprint,
      revisionFingerprint: request.workspace.revisionFingerprint,
      treeFingerprint: request.workspace.treeFingerprint,
      untargetedTreeFingerprint: request.workspace.untargetedTreeFingerprint,
      exactInputState: request.workspace.exactInputState,
      policyFingerprint: request.workspace.policyFingerprint,
      settingsFingerprint: request.workspace.settingsFingerprint
    },
    postWorkspace: {
      rootIdentityFingerprint: request.workspace.rootIdentityFingerprint,
      revisionFingerprint: request.workspace.revisionFingerprint,
      treeFingerprint: request.workspace.treeFingerprint,
      untargetedTreeFingerprint: request.workspace.untargetedTreeFingerprint,
      exactInputState: request.workspace.exactInputState,
      policyFingerprint: request.workspace.policyFingerprint,
      settingsFingerprint: request.workspace.settingsFingerprint
    },
    state: 'passed',
    workerRuns,
    judgments: workerRuns.map((worker, index) => ({
      id: 'judgment.forge.observation.' + String(index + 1),
      workerRunId: worker.id,
      caseId: worker.caseId,
      verdict: worker.arm === 'baseline' ? 'failed' : 'passed',
      criteria: criteria(worker.caseId, worker.arm === 'baseline' ? 'not-observed' : 'observed')
    })),
    changes: [],
    checks: [{
      id: 'check.forge.guided-cases',
      state: 'passed',
      observedFingerprint: FP({ guided: 'passed' })
    }],
    effects: [
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
    })),
    promotion: {
      state: 'held',
      artifactFingerprint: null,
      reasonCode: 'PROMOTION_AUTHORITY_NOT_GRANTED'
    },
    decisionEvidence: [],
    authority: {
      kind: 'development-evidence-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsPublication: false,
      grantsMerge: false,
      grantsProviderWrite: false
    },
    privacy: fixedPrivatePrivacy(),
    limitations: ['This private result is scoped evidence and grants no execution, publication, merge, or promotion authority.']
  };
  result.resultFingerprint = FP(Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== 'resultFingerprint')
  ));
  return result;
}

function postWorkspaceFixture(request) {
  return {
    rootIdentityFingerprint: request.workspace.rootIdentityFingerprint,
    revisionFingerprint: request.workspace.revisionFingerprint,
    treeFingerprint: request.workspace.treeFingerprint,
    untargetedTreeFingerprint: request.workspace.untargetedTreeFingerprint,
    exactInputState: request.workspace.exactInputState,
    policyFingerprint: request.workspace.policyFingerprint,
    settingsFingerprint: request.workspace.settingsFingerprint
  };
}

function observationFixture(request, result, postWorkspace) {
  const judgments = new Map(result.judgments.map((item) => [item.workerRunId, item]));
  const observation = {
    $contract: 'soter://contracts/development-host-observation/v1',
    contractVersion: '1.0.0',
    id: 'development-host-observation.' + request.id.slice('development-request.'.length),
    observationFingerprint: FP({ placeholder: 'observation' }),
    observedAt: '2026-07-22T10:06:01.000Z',
    request: {
      id: request.id,
      fingerprint: request.requestFingerprint,
      createdAt: request.createdAt
    },
    result: {
      id: result.id,
      fingerprint: result.resultFingerprint,
      createdAt: result.createdAt,
      completedAt: result.completedAt,
      state: result.state
    },
    workflow: {
      id: request.workflow.id,
      version: request.workflow.version,
      definitionFingerprint: request.workflow.definitionFingerprint
    },
    evaluatedSubject: {
      kind: 'workflow-guide',
      id: request.workflow.guideId,
      version: request.workflow.version,
      fingerprint: request.workflow.evaluatedSubjectFingerprint,
      contentFingerprint: request.workflow.guideContentFingerprint,
      candidateProjectionFingerprint: request.host.candidateProjectionFingerprint
    },
    evaluationSet: {
      id: request.workflow.evaluationSetId,
      version: request.workflow.version,
      fingerprint: request.workflow.evaluationSetFingerprint
    },
    configuration: {
      name: request.configuration.name,
      lockFingerprint: request.configuration.lockFingerprint,
      graphFingerprint: request.configuration.graphFingerprint
    },
    workspace: {
      pre: {
        rootIdentityFingerprint: request.workspace.rootIdentityFingerprint,
        revisionFingerprint: request.workspace.revisionFingerprint,
        treeFingerprint: request.workspace.treeFingerprint,
        untargetedTreeFingerprint: request.workspace.untargetedTreeFingerprint,
        exactInputState: request.workspace.exactInputState,
        policyFingerprint: request.workspace.policyFingerprint,
        settingsFingerprint: request.workspace.settingsFingerprint
      },
      post: structuredClone(postWorkspace)
    },
    host: {
      id: request.host.id,
      adapter: request.host.adapter,
      version: request.host.version,
      adapterFingerprint: request.host.adapterFingerprint,
      projectionDefinitionId: request.host.projectionDefinitionId,
      projectionDefinitionFingerprint: request.host.projectionDefinitionFingerprint,
      evaluatedInstructionFingerprint: request.host.evaluatedInstructionFingerprint,
      candidateProjectionFingerprint: request.host.candidateProjectionFingerprint,
      managedManifestFingerprint: request.host.managedManifestFingerprint,
      observer: {
        id: 'development-host-observer.' + request.host.id,
        version: '1.0.0',
        implementationFingerprint: FP({ observer: 'codex-v1' }),
        transport: 'trusted-local-host-adapter'
      }
    },
    environment: {
      containment: 'offline',
      runtimeFingerprint: FP({ runtime: 'codex-contained' })
    },
    runs: result.workerRuns.map((worker, index) => {
      const planned = request.invocation.plannedRuns[index];
      const judgment = judgments.get(worker.id);
      return {
        ...structuredClone(planned),
        startedAt: '2026-07-22T10:0' + String(index + 1) + ':00.000Z',
        completedAt: '2026-07-22T10:0' + String(index + 2) + ':00.000Z',
        worker: {
          id: worker.id,
          workerFingerprint: worker.workerFingerprint,
          dispatchFingerprint: worker.dispatchFingerprint,
          transcriptFingerprint: worker.transcriptFingerprint,
          expectationsIncluded: worker.expectationsIncluded,
          answerKeyAccess: worker.answerKeyAccess,
          state: worker.state
        },
        judgment: {
          id: judgment.id,
          verdict: judgment.verdict,
          criteria: structuredClone(judgment.criteria)
        }
      };
    }),
    externalEffects: Object.fromEntries([
      'providerRead',
      'providerWrite',
      'publication',
      'merge',
      'protectedRootMutation',
      'hostRealization'
    ].map((key) => [key, { state: 'not-observed', count: 0, observedFingerprint: null }])),
    authority: {
      kind: 'host-observation-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsPublication: false,
      grantsMerge: false,
      grantsProviderRead: false,
      grantsProviderWrite: false,
      grantsHostRealization: false,
      grantsPromotion: false
    },
    privacy: {
      absolutePathsIncluded: false,
      targetPathsIncluded: false,
      requestedOutcomeIncluded: false,
      rawDiffsIncluded: false,
      rawContentIncluded: false,
      rawTranscriptsIncluded: false,
      providerResponsesIncluded: false,
      credentialsIncluded: false
    },
    limitations: [
      'DEVELOPMENT_HOST_OBSERVATION_EXACT_INPUTS_ONLY',
      'DEVELOPMENT_HOST_OBSERVATION_LOCAL_BINARY_IDENTITY_ONLY',
      'DEVELOPMENT_HOST_OBSERVATION_NO_EXECUTION_AUTHORITY'
    ]
  };
  observation.observationFingerprint = fingerprintDevelopmentHostObservation(observation);
  return observation;
}

function resignResult(result) {
  result.resultFingerprint = FP(Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== 'resultFingerprint')
  ));
  return result;
}

function resignObservation(observation) {
  observation.observationFingerprint = fingerprintDevelopmentHostObservation(observation);
  return observation;
}

function bindResult(observation, result) {
  observation.result = {
    id: result.id,
    fingerprint: result.resultFingerprint,
    createdAt: result.createdAt,
    completedAt: result.completedAt,
    state: result.state
  };
  return observation;
}

function selftestCandidateLockBinding() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-candidate-lock-'));
  try {
    const directory = path.join(temp, '.soter', 'state', 'development-candidate-locks');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const privateDirectory of [
      path.join(temp, '.soter'),
      path.join(temp, '.soter', 'state'),
      directory
    ]) fs.chmodSync(privateDirectory, 0o700);
    const request = requestFixture();
    const lock = {
      configuration: {
        name: request.configuration.name,
        path: 'soter/configurations/harness-development-catalog.config.json'
      },
      host: {
        id: request.host.id,
        adapter: request.host.adapter,
        manifestFingerprint: request.host.adapterFingerprint,
        projectionDefinition: {
          id: request.host.projectionDefinitionId,
          fingerprint: request.host.projectionDefinitionFingerprint
        }
      },
      graphFingerprint: request.configuration.graphFingerprint,
      packs: [{
        id: request.workflow.id,
        version: request.workflow.version,
        artifacts: [{
          path: request.workflow.definitionPath,
          fingerprint: FP({ bytes: 'workflow-definition' })
        }, {
          path: request.workflow.guidePath,
          fingerprint: FP({ bytes: 'workflow-guide' })
        }, {
          path: request.workflow.evaluationSetPath,
          fingerprint: FP({ bytes: 'workflow-evaluation-set' })
        }]
      }]
    };
    const lockFingerprint = fingerprintLock(lock);
    const relative = [
      '.soter/state/development-candidate-locks/development-candidate-lock.codex.forge.',
      lockFingerprint.slice('sha256:'.length),
      '.json'
    ].join('');
    const file = path.join(temp, relative);
    fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    request.configuration.lockPath = relative;
    request.configuration.lockFingerprint = lockFingerprint;
    assert.equal(
      assertDevelopmentCandidateLock({ root: temp, request }).lockFingerprint,
      request.configuration.lockFingerprint
    );
    expectCode(
      () => assertDevelopmentCandidateLock({
        root: temp,
        request,
        requireCurrent: true
      }),
      'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_STALE'
    );

    fs.appendFileSync(file, '\n');
    expectCode(
      () => assertDevelopmentCandidateLock({ root: temp, request }),
      'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_INVALID'
    );
    fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
    lock.packs[0].artifacts[0].fingerprint = FP({ definition: 'substituted' });
    fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
    expectCode(
      () => assertDevelopmentCandidateLock({ root: temp, request }),
      'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_INVALID'
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function selftestDevelopmentHostObservations(root = scriptRoot) {
  selftestCandidateLockBinding();
  const request = requestFixture();
  const result = resultFixture(request);
  const postWorkspace = postWorkspaceFixture(request);
  const observation = observationFixture(request, result, postWorkspace);
  const trustedAdapter = structuredClone(observation.host);
  const args = { root, observation, request, result, trustedAdapter, postWorkspace };

  assert.equal(assertDevelopmentHostObservation(args), observation);
  assert.equal(observation.runs[0].arm, 'baseline');
  assert.equal(observation.runs[0].worker.state, 'failed');
  assert.equal(observation.runs[0].judgment.verdict, 'failed');
  assert.equal(
    observation.runs[0].judgment.criteria.find((item) => item.kind === 'expected').state,
    'not-observed',
    'baseline findings must remain visible even though they do not gate the guided result'
  );
  const baselineFindingResult = structuredClone(result);
  baselineFindingResult.judgments[0].criteria[1].state = 'observed';
  resignResult(baselineFindingResult);
  const baselineFinding = structuredClone(observation);
  baselineFinding.runs[0].judgment.criteria[1].state = 'observed';
  bindResult(baselineFinding, baselineFindingResult);
  resignObservation(baselineFinding);
  assert.equal(assertDevelopmentHostObservation({
    ...args,
    observation: baselineFinding,
    result: baselineFindingResult
  }), baselineFinding, 'an observed baseline prohibited finding must remain non-gating');
  const observationSchema = readJson(resolveRepoPath(
    root,
    'soter/contracts/development-host-observation.schema.json'
  ));
  const baselineBlocked = structuredClone(observation);
  const baselineBlockedRun = baselineBlocked.runs.find((run) => run.arm === 'baseline');
  baselineBlockedRun.judgment.verdict = 'blocked';
  baselineBlockedRun.judgment.criteria.find((criterion) => {
    return criterion.kind === 'expected';
  }).state = 'unknown';
  baselineBlockedRun.judgment.criteria.find((criterion) => {
    return criterion.kind === 'prohibited';
  }).state = 'observed';
  assert.deepEqual(
    validateJsonSchema(baselineBlocked, observationSchema),
    [],
    'the observation schema must retain non-gating baseline unknown and prohibited findings'
  );
  const guidedExpectedUnknown = structuredClone(observation);
  guidedExpectedUnknown.runs.find((run) => run.arm === 'guided').judgment.criteria.find((criterion) => {
    return criterion.kind === 'expected';
  }).state = 'unknown';
  assert.notEqual(
    validateJsonSchema(guidedExpectedUnknown, observationSchema).length,
    0,
    'the observation schema must reject a passed guided run with an unknown expected criterion'
  );
  const guidedProhibitedObserved = structuredClone(observation);
  guidedProhibitedObserved.runs.find((run) => run.arm === 'guided').judgment.criteria.find((criterion) => {
    return criterion.kind === 'prohibited';
  }).state = 'observed';
  assert.notEqual(
    validateJsonSchema(guidedProhibitedObserved, observationSchema).length,
    0,
    'the observation schema must reject a passed guided run with an observed prohibited criterion'
  );
  const tampered = structuredClone(observation);
  tampered.observationFingerprint = FP({ tampered: true });
  expectCode(() => assertDevelopmentHostObservation({ ...args, observation: tampered }),
    'DEVELOPMENT_HOST_OBSERVATION_TAMPERED');

  const wrongTrust = structuredClone(observation);
  wrongTrust.host.observer.implementationFingerprint = FP({ observer: 'untrusted' });
  resignObservation(wrongTrust);
  expectCode(() => assertDevelopmentHostObservation({ ...args, observation: wrongTrust }),
    'DEVELOPMENT_HOST_OBSERVATION_TRUST_INVALID');

  const wrongPost = structuredClone(observation);
  wrongPost.workspace.post.treeFingerprint = FP({ tree: 'substituted' });
  resignObservation(wrongPost);
  expectCode(() => assertDevelopmentHostObservation({ ...args, observation: wrongPost }),
    'DEVELOPMENT_HOST_OBSERVATION_WORKSPACE_BINDING_INVALID');

  const duplicateWorkerResult = structuredClone(result);
  duplicateWorkerResult.workerRuns[1].workerFingerprint = duplicateWorkerResult.workerRuns[0].workerFingerprint;
  resignResult(duplicateWorkerResult);
  const duplicateWorker = structuredClone(observation);
  duplicateWorker.runs[1].worker.workerFingerprint = duplicateWorker.runs[0].worker.workerFingerprint;
  bindResult(duplicateWorker, duplicateWorkerResult);
  resignObservation(duplicateWorker);
  expectCode(() => assertDevelopmentHostObservation({
    ...args,
    observation: duplicateWorker,
    result: duplicateWorkerResult
  }), 'DEVELOPMENT_HOST_OBSERVATION_FRESH_WORKER_REQUIRED');

  const duplicateDispatchResult = structuredClone(result);
  duplicateDispatchResult.workerRuns[1].dispatchFingerprint = duplicateDispatchResult.workerRuns[0].dispatchFingerprint;
  resignResult(duplicateDispatchResult);
  const duplicateDispatch = structuredClone(observation);
  duplicateDispatch.runs[1].worker.dispatchFingerprint = duplicateDispatch.runs[0].worker.dispatchFingerprint;
  bindResult(duplicateDispatch, duplicateDispatchResult);
  resignObservation(duplicateDispatch);
  expectCode(() => assertDevelopmentHostObservation({
    ...args,
    observation: duplicateDispatch,
    result: duplicateDispatchResult
  }), 'DEVELOPMENT_HOST_OBSERVATION_DISPATCH_BINDING_INVALID');

  const duplicateTranscriptResult = structuredClone(result);
  duplicateTranscriptResult.workerRuns[1].transcriptFingerprint = duplicateTranscriptResult.workerRuns[0].transcriptFingerprint;
  resignResult(duplicateTranscriptResult);
  const duplicateTranscript = structuredClone(observation);
  duplicateTranscript.runs[1].worker.transcriptFingerprint = duplicateTranscript.runs[0].worker.transcriptFingerprint;
  bindResult(duplicateTranscript, duplicateTranscriptResult);
  resignObservation(duplicateTranscript);
  expectCode(() => assertDevelopmentHostObservation({
    ...args,
    observation: duplicateTranscript,
    result: duplicateTranscriptResult
  }), 'DEVELOPMENT_HOST_OBSERVATION_TRANSCRIPT_BINDING_INVALID');

  const missingRun = structuredClone(observation);
  missingRun.runs.pop();
  resignObservation(missingRun);
  expectCode(() => assertDevelopmentHostObservation({ ...args, observation: missingRun }),
    'DEVELOPMENT_HOST_OBSERVATION_COVERAGE_INCOMPLETE');

  const missingExpectedResult = structuredClone(result);
  missingExpectedResult.judgments[1].criteria[0].state = 'not-observed';
  resignResult(missingExpectedResult);
  const missingExpected = structuredClone(observation);
  missingExpected.runs[1].judgment.criteria[0].state = 'not-observed';
  bindResult(missingExpected, missingExpectedResult);
  resignObservation(missingExpected);
  expectCode(() => assertDevelopmentHostObservation({
    ...args,
    observation: missingExpected,
    result: missingExpectedResult
  }), 'DEVELOPMENT_HOST_OBSERVATION_MALFORMED');

  const guidedProhibitedResult = structuredClone(result);
  guidedProhibitedResult.judgments[1].criteria[1].state = 'observed';
  resignResult(guidedProhibitedResult);
  const guidedProhibited = structuredClone(observation);
  guidedProhibited.runs[1].judgment.criteria[1].state = 'observed';
  bindResult(guidedProhibited, guidedProhibitedResult);
  resignObservation(guidedProhibited);
  expectCode(() => assertDevelopmentHostObservation({
    ...args,
    observation: guidedProhibited,
    result: guidedProhibitedResult
  }), 'DEVELOPMENT_HOST_OBSERVATION_MALFORMED');

  const incoherentBaselineResult = structuredClone(result);
  incoherentBaselineResult.judgments[0].verdict = 'passed';
  resignResult(incoherentBaselineResult);
  const incoherentBaseline = structuredClone(observation);
  incoherentBaseline.runs[0].judgment.verdict = 'passed';
  bindResult(incoherentBaseline, incoherentBaselineResult);
  resignObservation(incoherentBaseline);
  expectCode(() => assertDevelopmentHostObservation({
    ...args,
    observation: incoherentBaseline,
    result: incoherentBaselineResult
  }), 'DEVELOPMENT_HOST_OBSERVATION_CRITERIA_INVALID');

  const externalResult = structuredClone(result);
  const externalProviderWrite = externalResult.effects.find((item) => {
    return item.category === 'provider-write';
  });
  externalProviderWrite.state = 'observed';
  externalProviderWrite.count = 1;
  externalProviderWrite.observedFingerprint = FP({ providerWrite: 1 });
  resignResult(externalResult);
  const externalObservation = structuredClone(observation);
  bindResult(externalObservation, externalResult);
  resignObservation(externalObservation);
  expectCode(() => assertDevelopmentHostObservation({
    ...args,
    observation: externalObservation,
    result: externalResult
  }), 'DEVELOPMENT_HOST_OBSERVATION_EXTERNAL_EFFECT_INVALID');

  for (const state of ['unknown', 'blocked']) {
    const uncertainResult = structuredClone(result);
    uncertainResult.effects.find((item) => item.category === 'provider-write').state = state;
    resignResult(uncertainResult);
    const uncertainObservation = structuredClone(observation);
    bindResult(uncertainObservation, uncertainResult);
    resignObservation(uncertainObservation);
    expectCode(() => assertDevelopmentHostObservation({
      ...args,
      observation: uncertainObservation,
      result: uncertainResult
    }), 'DEVELOPMENT_HOST_OBSERVATION_EXTERNAL_EFFECT_INVALID');
  }
  const nonzeroExternalResult = structuredClone(result);
  nonzeroExternalResult.effects.find((item) => item.category === 'provider-write').count = 1;
  resignResult(nonzeroExternalResult);
  const nonzeroExternalObservation = structuredClone(observation);
  bindResult(nonzeroExternalObservation, nonzeroExternalResult);
  resignObservation(nonzeroExternalObservation);
  expectCode(() => assertDevelopmentHostObservation({
    ...args,
    observation: nonzeroExternalObservation,
    result: nonzeroExternalResult
  }), 'DEVELOPMENT_HOST_OBSERVATION_EXTERNAL_EFFECT_INVALID');

  const omittedExternalResult = structuredClone(result);
  omittedExternalResult.effects = omittedExternalResult.effects.filter((item) => {
    return item.category !== 'provider-read';
  });
  resignResult(omittedExternalResult);
  const omittedExternalObservation = structuredClone(observation);
  bindResult(omittedExternalObservation, omittedExternalResult);
  resignObservation(omittedExternalObservation);
  expectCode(() => assertDevelopmentHostObservation({
    ...args,
    observation: omittedExternalObservation,
    result: omittedExternalResult
  }), 'DEVELOPMENT_HOST_OBSERVATION_EXTERNAL_EFFECT_INVALID');

  const duplicateExternalResult = structuredClone(result);
  duplicateExternalResult.effects.push(structuredClone(
    duplicateExternalResult.effects.find((item) => item.category === 'provider-read')
  ));
  resignResult(duplicateExternalResult);
  const duplicateExternalObservation = structuredClone(observation);
  bindResult(duplicateExternalObservation, duplicateExternalResult);
  resignObservation(duplicateExternalObservation);
  expectCode(() => assertDevelopmentHostObservation({
    ...args,
    observation: duplicateExternalObservation,
    result: duplicateExternalResult
  }), 'DEVELOPMENT_HOST_OBSERVATION_EXTERNAL_EFFECT_INVALID');

  const earlyRun = structuredClone(observation);
  earlyRun.runs[0].startedAt = '2026-07-22T09:59:59.000Z';
  resignObservation(earlyRun);
  expectCode(() => assertDevelopmentHostObservation({ ...args, observation: earlyRun }),
    'DEVELOPMENT_HOST_OBSERVATION_CHRONOLOGY_INVALID');

  const earlyResult = structuredClone(result);
  earlyResult.createdAt = '2026-07-22T09:59:00.000Z';
  earlyResult.completedAt = '2026-07-22T09:59:01.000Z';
  resignResult(earlyResult);
  const earlyResultObservation = structuredClone(observation);
  bindResult(earlyResultObservation, earlyResult);
  resignObservation(earlyResultObservation);
  expectCode(() => assertDevelopmentHostObservation({
    ...args,
    observation: earlyResultObservation,
    result: earlyResult
  }), 'DEVELOPMENT_HOST_OBSERVATION_CHRONOLOGY_INVALID');

  const answerKey = structuredClone(observation);
  answerKey.runs[1].worker.answerKeyAccess = 'observed';
  resignObservation(answerKey);
  expectCode(() => assertDevelopmentHostObservation({ ...args, observation: answerKey }),
    'DEVELOPMENT_HOST_OBSERVATION_MALFORMED');

  const rawProvider = structuredClone(observation);
  rawProvider.rawProviderResponse = { hostile: true };
  resignObservation(rawProvider);
  expectCode(() => assertDevelopmentHostObservation({ ...args, observation: rawProvider }),
    'DEVELOPMENT_HOST_OBSERVATION_MALFORMED');

  const rawPath = structuredClone(observation);
  rawPath.limitations = [
    'DEVELOPMENT_HOST_OBSERVATION_NO_EXECUTION_AUTHORITY',
    '/Users/private/development-target'
  ];
  resignObservation(rawPath);
  expectCode(() => assertDevelopmentHostObservation({ ...args, observation: rawPath }),
    'DEVELOPMENT_HOST_OBSERVATION_MALFORMED');

  const rawDiff = structuredClone(observation);
  rawDiff.limitations = [
    'DEVELOPMENT_HOST_OBSERVATION_NO_EXECUTION_AUTHORITY',
    'diff --git a/private/source b/private/source\n@@ -1 +1 @@'
  ];
  resignObservation(rawDiff);
  expectCode(() => assertDevelopmentHostObservation({ ...args, observation: rawDiff }),
    'DEVELOPMENT_HOST_OBSERVATION_MALFORMED');

  const rawContent = structuredClone(observation);
  rawContent.rawContent = 'PRIVATE_WORKER_TRANSCRIPT_SENTINEL';
  resignObservation(rawContent);
  expectCode(() => assertDevelopmentHostObservation({ ...args, observation: rawContent }),
    'DEVELOPMENT_HOST_OBSERVATION_MALFORMED');

  process.stdout.write(
    'Soter development host observation self-test passed: exact bindings, trusted adapter and post-workspace input, chronology, fresh workers, dispatches, transcripts, criteria, no external effects, and privacy non-representability.\n'
  );
  return true;
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    selftestDevelopmentHostObservations();
  } catch (error) {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  }
}
