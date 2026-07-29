#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertDevelopmentAgentMigrationEvidence,
  assertDevelopmentHostObservation,
  assertHistoricalDevelopmentCandidateLock,
  buildDevelopmentHostFinalEvidenceForBatch,
  buildDevelopmentHostHistoricalEvidenceForBatch,
  convertDevelopmentHostObservationToMigrationEvidence,
  fingerprintDevelopmentHostObservation,
  persistDevelopmentHostFinalEvidence,
  persistDevelopmentHostHistoricalEvidence
} from './development-host-observations.mjs';
import {
  fingerprintWorkflowGuideContent,
  workflowLegacySourceProjection
} from '../kernel/workflow-guides.mjs';
import { validateJsonSchema, verifySoter } from '../kernel/verify.mjs';
import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import {
  fingerprintLock,
  resolveDevelopmentEvidenceFinalizationConfiguration
} from './resolve.mjs';
import { materializeDevelopmentCandidateLock } from './development-candidate-locks.mjs';
import {
  buildDevelopmentEvaluationInvocation,
  prepareDevelopmentRequest
} from './development-runs.mjs';
import {
  developmentHostExecutionStateFiles,
  finalizeDevelopmentHostEvaluation,
  runDevelopmentHostEvaluation,
  runDevelopmentHostJudgment
} from './development-host-runner.mjs';

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
      candidateProjectionFingerprint: FP({ candidate: 'forge-codex' })
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
      candidateProjectionFingerprint: request.host.candidateProjectionFingerprint
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
      exactInputState: request.workspace.exactInputState,
      policyFingerprint: request.workspace.policyFingerprint,
      settingsFingerprint: request.workspace.settingsFingerprint
    },
    postWorkspace: {
      rootIdentityFingerprint: request.workspace.rootIdentityFingerprint,
      revisionFingerprint: request.workspace.revisionFingerprint,
      treeFingerprint: request.workspace.treeFingerprint,
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
      reasonCode: 'MIGRATION_AUTHORITY_NOT_GRANTED'
    },
    decisionEvidence: [],
    authority: {
      kind: 'development-evidence-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsPublication: false,
      grantsMerge: false,
      grantsProviderWrite: false,
      grantsFallbackRemoval: false
    },
    privacy: fixedPrivatePrivacy(),
    limitations: ['This private result is scoped evidence and cannot activate or migrate a workflow.']
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
      grantsPromotion: false,
      grantsFallbackRemoval: false
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

function resignMigrationEvidence(evidence) {
  evidence.evidenceFingerprint = FP(Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== 'evidenceFingerprint')
  ));
  return evidence;
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

function selftestHistoricalCandidateLockBinding() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-historical-candidate-lock-'));
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
    const relative = '.soter/state/development-candidate-locks/development-candidate-lock.codex.forge.json';
    const file = path.join(temp, relative);
    fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    request.configuration.lockPath = relative;
    request.configuration.lockFingerprint = fingerprintLock(lock);
    assert.equal(
      assertHistoricalDevelopmentCandidateLock({ root: temp, request }).lockFingerprint,
      request.configuration.lockFingerprint
    );
    expectCode(
      () => assertHistoricalDevelopmentCandidateLock({
        root: temp,
        request,
        requireCurrent: true
      }),
      'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_STALE'
    );

    fs.appendFileSync(file, '\n');
    expectCode(
      () => assertHistoricalDevelopmentCandidateLock({ root: temp, request }),
      'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_INVALID'
    );
    fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
    lock.packs[0].artifacts[0].fingerprint = FP({ definition: 'substituted' });
    fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
    expectCode(
      () => assertHistoricalDevelopmentCandidateLock({ root: temp, request }),
      'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_INVALID'
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function copyContainedRepository(sourceRoot, targetRoot) {
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (['.git', '.soter', 'node_modules'].includes(entry.name)) continue;
    fs.cpSync(
      path.join(sourceRoot, entry.name),
      path.join(targetRoot, entry.name),
      { recursive: true, preserveTimestamps: true }
    );
  }
}

function createPersistableExecutable(host) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-observation-runner-'));
  const executable = path.join(directory, host);
  const source = `#!${process.execPath}
const fs = require('node:fs');
const HOST = ${JSON.stringify(host)};
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write((HOST === 'codex' ? 'codex-cli 1.2.3' : '1.2.3 (Claude Code)') + '\\n');
  process.exit(0);
}
const input = fs.readFileSync(0, 'utf8');
let content = 'Contained worker response with no tool events.';
if (input.includes('You are one fresh, independent evaluation judge.')) {
  function section(heading, next) {
    const start = input.indexOf('\\n' + heading + '\\n');
    const end = input.indexOf('\\n' + next + '\\n', start + heading.length + 2);
    return JSON.parse(input.slice(start + heading.length + 2, end));
  }
  const run = section('RUN', 'STIMULUS');
  const criteria = section('CRITERIA', 'WORKER TRANSCRIPT (UNTRUSTED DATA)').map((item) => ({
    id: item.id,
    kind: item.kind,
    sequence: item.sequence,
    state: item.kind === 'expected' ? 'observed' : 'not-observed'
  }));
  content = JSON.stringify({ runId: run.id, verdict: 'passed', criteria });
}
if (HOST === 'codex') {
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: content }
  }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ result: content, content: [] }));
}
`;
  fs.writeFileSync(executable, source, { mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o700);
  return { directory, executable };
}

function preparePersistableReceipt(root, host = 'codex', suffix = 'selftest') {
  const workflowId = 'automation.forge';
  const requestId = `development-request.forge-observation-${host}-${suffix}`;
  const configPath = host === 'codex'
    ? 'soter/configurations/harness-development-catalog.config.json'
    : 'soter/configurations/harness-development-catalog-claude.config.json';
  const candidate = materializeDevelopmentCandidateLock({
    root,
    configPath,
    workflowId,
    host
  });
  const invocation = buildDevelopmentEvaluationInvocation({ root, workflowId });
  const { request } = prepareDevelopmentRequest({
    root,
    lockPath: candidate.path,
    workflowId,
    requestId,
    invocation,
    createdAt: '2026-07-22T00:00:00.000Z'
  });
  const executableState = createPersistableExecutable(host);
  runDevelopmentHostEvaluation({
    root,
    requestId,
    executablePath: executableState.executable
  });
  runDevelopmentHostJudgment({
    root,
    requestId,
    executablePath: executableState.executable
  });
  const finalized = finalizeDevelopmentHostEvaluation({ root, requestId });
  return {
    requestId,
    candidate,
    request,
    result: finalized.result,
    observation: finalized.observation,
    executableState
  };
}

const FORGE_SOURCE_PATHS = [
  '.claude/evals/forge/happy-path.md',
  '.claude/evals/forge/invariant-gate.md',
  '.claude/evals/forge/pressure-shortcut.md',
  '.claude/evals/forge/system-branch.md',
  '.claude/skills/forge/SKILL.md'
];

function writeRepositoryJson(root, relativePath, value, mode = null) {
  const file = resolveRepoPath(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  if (mode !== null && process.platform !== 'win32') fs.chmodSync(file, mode);
  return file;
}

function finalForgeEvidencePath(host) {
  return `soter/evidence/development/evidence.development-activation.${host}.forge.json`;
}

function finalEvidenceApplicability(lock) {
  return {
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    dependencies: lock.packs.map((pack) => ({
      id: pack.id,
      version: pack.version,
      fingerprint: pack.manifestFingerprint
    })),
    host: {
      id: lock.host.id,
      adapter: lock.host.adapter,
      version: lock.host.version,
      manifestFingerprint: lock.host.manifestFingerprint
    },
    integrations: lock.packs.filter((pack) => pack.layer === 'integration').map((pack) => ({
      id: pack.id,
      version: pack.version,
      manifestFingerprint: pack.manifestFingerprint,
      evidenceMaturity: pack.evidenceMaturity
    })),
    authorities: lock.authorities.map((authority) => ({
      id: authority.id,
      role: authority.role,
      subject: authority.subject,
      declarationFingerprint: authority.declarationFingerprint
    }))
  };
}

function activatePersistableForgeGraph(root, historicalByHost) {
  const definitionPath = 'soter/automations/forge/definition.json';
  const guidePath = 'soter/automations/forge/guide.json';
  const evaluationPath = 'soter/automations/forge/evaluations.json';
  const finalEvidencePaths = ['codex', 'claude'].map(finalForgeEvidencePath);
  const definition = readJson(resolveRepoPath(root, definitionPath));
  const guide = readJson(resolveRepoPath(root, guidePath));
  const evaluations = readJson(resolveRepoPath(root, evaluationPath));
  const references = ['codex', 'claude'].map((host) => {
    const receipt = historicalByHost.get(host);
    assert(receipt, 'finalized Forge graph requires one historical receipt for ' + host);
    return {
      path: receipt.path,
      fingerprint: fingerprintJson(receipt.evidence),
      host
    };
  });
  const sourceFilesRemoved = FORGE_SOURCE_PATHS.every((sourcePath) => {
    return !fs.existsSync(resolveRepoPath(root, sourcePath));
  });
  if (sourceFilesRemoved) {
    assert.equal(definition.lifecycle.activation.state, 'active');
    assert.equal(definition.source.presence, 'removed');
    assert.equal(guide.status.state, 'active');
    assert.equal(guide.source.presence, 'removed');
    assert.equal(evaluations.lifecycle.activation, 'active');
    assert(evaluations.cases.every((testCase) => testCase.source.presence === 'removed'));

    const inventory = readJson(resolveRepoPath(root, 'soter/migrations/legacy-inventory.json'));
    const forgeItems = inventory.items.filter((item) => FORGE_SOURCE_PATHS.includes(item.sourcePath));
    assert.equal(forgeItems.length, FORGE_SOURCE_PATHS.length);
    assert(forgeItems.every((item) => {
      return item.sourcePresence === 'removed'
        && item.state === 'migrated'
        && item.targets.length === 1
        && item.targets[0].state === 'migrated'
        && item.targets[0].canonicalAuthority === 'target'
        && item.targets[0].fallback === 'removed'
        && item.targets[0].parity === 'proven';
    }));

    const migration = readJson(
      resolveRepoPath(root, 'soter/migrations/forge.definition.migration.json')
    );
    assert.equal(migration.items.length, FORGE_SOURCE_PATHS.length);
    assert(migration.items.every((item) => {
      return FORGE_SOURCE_PATHS.includes(item.sourcePath) && item.state === 'migrated';
    }));

    definition.lifecycle.activation.evidence = structuredClone(references);
    guide.status.evidence = structuredClone(references);
    guide.workflow.definitionFingerprint = fingerprintJson(definition);
    guide.workflow.evaluationSetFingerprint = fingerprintJson(evaluations);
    guide.contentFingerprint = fingerprintWorkflowGuideContent(guide);
    writeRepositoryJson(root, definitionPath, definition);
    writeRepositoryJson(root, guidePath, guide);
    return { definitionPath, guidePath, evaluationPath, finalEvidencePaths };
  }

  definition.lifecycle.activation = {
    state: 'active',
    reasonCode: 'WORKFLOW_HOST_GUIDANCE_ACTIVE',
    proceduralAuthority: 'target',
    delivery: 'host-skill',
    behaviorParity: 'passed',
    evidence: structuredClone(references),
    permittedNextAction: 'invoke-through-selected-host'
  };
  definition.source.presence = 'removed';
  guide.status = {
    state: 'active',
    reasonCode: 'WORKFLOW_GUIDE_ACTIVE',
    proceduralAuthority: 'target',
    behaviorParity: 'passed',
    delivery: 'host-skill',
    evidence: structuredClone(references),
    permittedNextAction: 'invoke-through-selected-host'
  };
  guide.source.presence = 'removed';
  evaluations.lifecycle.activation = 'active';
  for (const testCase of evaluations.cases) testCase.source.presence = 'removed';

  guide.workflow.definitionFingerprint = fingerprintJson(definition);
  guide.workflow.evaluationSetFingerprint = fingerprintJson(evaluations);
  guide.contentFingerprint = fingerprintWorkflowGuideContent(guide);
  writeRepositoryJson(root, definitionPath, definition);
  writeRepositoryJson(root, evaluationPath, evaluations);
  writeRepositoryJson(root, guidePath, guide);

  const inventoryPath = 'soter/migrations/legacy-inventory.json';
  const inventory = readJson(resolveRepoPath(root, inventoryPath));
  const forgeItems = inventory.items.filter((item) => FORGE_SOURCE_PATHS.includes(item.sourcePath));
  assert.equal(forgeItems.length, FORGE_SOURCE_PATHS.length);
  for (const item of forgeItems) {
    item.sourcePresence = 'removed';
    item.state = 'migrated';
    assert.equal(item.targets.length, 1);
    Object.assign(item.targets[0], {
      state: 'migrated',
      canonicalAuthority: 'target',
      fallback: 'removed',
      parity: 'proven',
      evidence: [...finalEvidencePaths]
    });
  }
  inventory.stateCounts = { mapped: 0, bridged: 0, migrated: 0, retired: 0 };
  inventory.bindingStateCounts = { mapped: 0, bridged: 0, migrated: 0, retired: 0 };
  for (const item of inventory.items) {
    inventory.stateCounts[item.state] += 1;
    for (const target of item.targets) inventory.bindingStateCounts[target.state] += 1;
  }
  inventory.inventoryFingerprint = null;
  inventory.inventoryFingerprint = fingerprintJson(inventory);
  writeRepositoryJson(root, inventoryPath, inventory);

  const migrationPath = 'soter/migrations/forge.definition.migration.json';
  const migration = readJson(resolveRepoPath(root, migrationPath));
  assert.equal(migration.items.length, FORGE_SOURCE_PATHS.length);
  for (const item of migration.items) {
    assert(FORGE_SOURCE_PATHS.includes(item.sourcePath));
    item.state = 'migrated';
    item.evidence = [...finalEvidencePaths];
  }
  writeRepositoryJson(root, migrationPath, migration);

  for (const sourcePath of FORGE_SOURCE_PATHS) fs.rmSync(resolveRepoPath(root, sourcePath));
  const staticVerification = verifySoter(root, { includeRuntimeArtifacts: false });
  assert.equal(
    staticVerification.health.valid,
    'passed',
    'finalized Forge static graph must be valid: '
      + staticVerification.violations.map((item) => item.code).join(', ')
  );
  return { definitionPath, guidePath, evaluationPath, finalEvidencePaths };
}

function selftestCreateOnlyEvidencePersistence(sourceRoot) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-development-evidence-persistence-'));
  let executableDirectory = null;
  try {
    copyContainedRepository(sourceRoot, temp);
    const receipt = preparePersistableReceipt(temp);
    executableDirectory = receipt.executableState.directory;
    const first = persistDevelopmentHostHistoricalEvidence({
      root: temp,
      requestId: receipt.requestId
    });
    assert.equal(first.idempotent, false);
    assert.equal(first.evidence.$contract, 'soter://contracts/development-agent-migration-evidence/v1');
    assert.equal(first.path, `soter/evidence/development/${first.evidence.id}.json`);
    assert.equal(first.evidence.authority.grantsActivation, false);
    assert.equal(first.evidence.authority.grantsFallbackRemoval, false);
    const evidenceFile = resolveRepoPath(temp, first.path);
    const exactBytes = fs.readFileSync(evidenceFile);
    assert.equal(fs.lstatSync(evidenceFile).nlink, 1);
    if (process.platform !== 'win32') {
      assert.equal(fs.lstatSync(evidenceFile).mode & 0o7777, 0o644);
      assert.equal(
        fs.lstatSync(path.dirname(evidenceFile)).mode & 0o7777,
        0o755,
        'governed evidence directory must be 0755'
      );
    }
    const serialized = exactBytes.toString('utf8');
    assert(!serialized.includes('/Users/'));
    assert(!serialized.includes('PRIVATE_TRANSCRIPT_SENTINEL'));
    assert(!serialized.includes('rawProviderResponse'));

    const repeated = persistDevelopmentHostHistoricalEvidence({
      root: temp,
      requestId: receipt.requestId
    });
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.fingerprint, first.fingerprint);

    const runnerState = developmentHostExecutionStateFiles(temp, receipt.requestId);
    if (process.platform !== 'win32') {
      assert.equal(fs.lstatSync(runnerState.finalization).mode & 0o7777, 0o600);
    }
    expectCode(() => persistDevelopmentHostHistoricalEvidence({
      root: temp,
      requestId: receipt.requestId,
      unexpected: true
    }), 'DEVELOPMENT_EVIDENCE_ARGUMENTS_INVALID');

    const governedDirectory = path.dirname(evidenceFile);
    if (process.platform !== 'win32') {
      fs.chmodSync(governedDirectory, 0o777);
      expectCode(
        () => persistDevelopmentHostHistoricalEvidence({ root: temp, requestId: receipt.requestId }),
        'DEVELOPMENT_EVIDENCE_OUTPUT_PATH_INVALID'
      );
      fs.chmodSync(governedDirectory, 0o755);
    }

    const interruptedPending = path.join(
      governedDirectory,
      '.' + path.basename(evidenceFile) + '.pending-interrupted-publication'
    );
    fs.rmSync(evidenceFile);
    fs.writeFileSync(interruptedPending, exactBytes, { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(interruptedPending, 0o644);
    fs.linkSync(interruptedPending, evidenceFile);
    assert.equal(fs.lstatSync(evidenceFile).nlink, 2);
    const recovered = persistDevelopmentHostHistoricalEvidence({
      root: temp,
      requestId: receipt.requestId
    });
    assert.equal(recovered.idempotent, true);
    assert.equal(fs.existsSync(interruptedPending), false);
    assert.equal(fs.lstatSync(evidenceFile).nlink, 1);
    assert(fs.readFileSync(evidenceFile).equals(exactBytes));

    const abandonedPending = path.join(
      governedDirectory,
      '.' + path.basename(evidenceFile) + '.pending-abandoned-partial'
    );
    fs.rmSync(evidenceFile);
    fs.writeFileSync(abandonedPending, '{', { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(abandonedPending, 0o644);
    const recreated = persistDevelopmentHostHistoricalEvidence({
      root: temp,
      requestId: receipt.requestId
    });
    assert.equal(recreated.idempotent, false);
    assert(fs.readFileSync(evidenceFile).equals(exactBytes));
    assert(fs.readFileSync(abandonedPending).equals(Buffer.from('{')));
    fs.rmSync(abandonedPending);

    const resultFile = resolveRepoPath(
      temp,
      `.soter/state/development-results/${receipt.result.id}.json`
    );
    const observationFile = resolveRepoPath(
      temp,
      `.soter/state/development-host-observations/${receipt.observation.id}.json`
    );
    const exactResultBytes = fs.readFileSync(resultFile);
    const exactObservationBytes = fs.readFileSync(observationFile);
    const forgedResult = structuredClone(receipt.result);
    const forgedObservation = structuredClone(receipt.observation);
    forgedResult.judgments[1].criteria[0].evidenceFingerprint = FP({ forged: 'criterion' });
    forgedObservation.runs[1].judgment.criteria[0].evidenceFingerprint =
      forgedResult.judgments[1].criteria[0].evidenceFingerprint;
    resignResult(forgedResult);
    bindResult(forgedObservation, forgedResult);
    resignObservation(forgedObservation);
    fs.writeFileSync(resultFile, JSON.stringify(forgedResult, null, 2) + '\n');
    fs.writeFileSync(observationFile, JSON.stringify(forgedObservation, null, 2) + '\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(resultFile, 0o600);
      fs.chmodSync(observationFile, 0o600);
    }
    expectCode(
      () => persistDevelopmentHostHistoricalEvidence({ root: temp, requestId: receipt.requestId }),
      'DEVELOPMENT_HOST_FINALIZATION_RECEIPT_INVALID'
    );
    fs.writeFileSync(resultFile, exactResultBytes);
    fs.writeFileSync(observationFile, exactObservationBytes);
    if (process.platform !== 'win32') {
      fs.chmodSync(resultFile, 0o600);
      fs.chmodSync(observationFile, 0o600);
    }

    const cli = spawnSync(process.execPath, [
      resolveRepoPath(temp, 'soter/core/cli.mjs'),
      'development-host-evidence-historical',
      '--root', temp,
      '--request-id', receipt.requestId,
      '--unexpected', 'rejected'
    ], { cwd: temp, encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Unexpected argument for development-host-evidence-historical/u);

    const tamperedEvidence = structuredClone(first.evidence);
    tamperedEvidence.createdAt = '2026-07-22T10:06:02.000Z';
    fs.writeFileSync(evidenceFile, JSON.stringify(tamperedEvidence, null, 2) + '\n');
    if (process.platform !== 'win32') fs.chmodSync(evidenceFile, 0o644);
    expectCode(
      () => persistDevelopmentHostHistoricalEvidence({ root: temp, requestId: receipt.requestId }),
      'DEVELOPMENT_MIGRATION_EVIDENCE_REENTRY_MISMATCH'
    );
    fs.writeFileSync(evidenceFile, exactBytes);
    if (process.platform !== 'win32') fs.chmodSync(evidenceFile, 0o644);

    const tamperedObservation = structuredClone(receipt.observation);
    tamperedObservation.observedAt = '2026-07-22T10:06:02.000Z';
    fs.writeFileSync(observationFile, JSON.stringify(tamperedObservation, null, 2) + '\n');
    if (process.platform !== 'win32') fs.chmodSync(observationFile, 0o600);
    expectCode(
      () => persistDevelopmentHostHistoricalEvidence({ root: temp, requestId: receipt.requestId }),
      'DEVELOPMENT_HOST_FINALIZATION_RECEIPT_INVALID'
    );
    fs.writeFileSync(observationFile, exactObservationBytes);
    if (process.platform !== 'win32') fs.chmodSync(observationFile, 0o600);

    fs.rmSync(observationFile);
    expectCode(
      () => persistDevelopmentHostHistoricalEvidence({ root: temp, requestId: receipt.requestId }),
      'DEVELOPMENT_MIGRATION_EVIDENCE_SOURCE_UNAVAILABLE'
    );
    fs.writeFileSync(observationFile, exactObservationBytes, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(observationFile, 0o600);

    const privateSymlinkTarget = path.join(temp, 'private-observation-target.json');
    fs.writeFileSync(privateSymlinkTarget, exactObservationBytes, { mode: 0o600 });
    fs.rmSync(observationFile);
    fs.symlinkSync(privateSymlinkTarget, observationFile);
    expectCode(
      () => persistDevelopmentHostHistoricalEvidence({ root: temp, requestId: receipt.requestId }),
      'DEVELOPMENT_MIGRATION_EVIDENCE_SOURCE_UNAVAILABLE'
    );
    fs.rmSync(observationFile);
    fs.writeFileSync(observationFile, exactObservationBytes, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(observationFile, 0o600);

    const outputSymlinkTarget = path.join(temp, 'outside-evidence.json');
    fs.writeFileSync(outputSymlinkTarget, 'OUTSIDE_EVIDENCE_SENTINEL\n', { mode: 0o600 });
    const outsideBefore = fs.readFileSync(outputSymlinkTarget);
    fs.rmSync(evidenceFile);
    fs.symlinkSync(outputSymlinkTarget, evidenceFile);
    expectCode(
      () => persistDevelopmentHostHistoricalEvidence({ root: temp, requestId: receipt.requestId }),
      'DEVELOPMENT_MIGRATION_EVIDENCE_REENTRY_MISMATCH'
    );
    assert(fs.readFileSync(outputSymlinkTarget).equals(outsideBefore));
    fs.rmSync(evidenceFile);

    const outputHardlinkTarget = path.join(temp, 'outside-hardlink-evidence.json');
    fs.writeFileSync(outputHardlinkTarget, exactBytes, { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(outputHardlinkTarget, 0o644);
    const hardlinkMode = fs.lstatSync(outputHardlinkTarget).mode & 0o7777;
    fs.linkSync(outputHardlinkTarget, evidenceFile);
    expectCode(
      () => persistDevelopmentHostHistoricalEvidence({ root: temp, requestId: receipt.requestId }),
      'DEVELOPMENT_MIGRATION_EVIDENCE_REENTRY_MISMATCH'
    );
    assert.equal(fs.lstatSync(outputHardlinkTarget).mode & 0o7777, hardlinkMode);
    assert(fs.readFileSync(outputHardlinkTarget).equals(exactBytes));
    fs.rmSync(evidenceFile);
    fs.writeFileSync(evidenceFile, exactBytes, { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(evidenceFile, 0o644);

    const finalLockPath = 'soter/fixtures/harness-development-catalog/harness-development-catalog.lock.json';
    fs.writeFileSync(
      resolveRepoPath(temp, finalLockPath),
      JSON.stringify(receipt.candidate.lock, null, 2) + '\n'
    );
    expectCode(() => persistDevelopmentHostFinalEvidence({
      root: temp,
      requestId: receipt.requestId,
      finalLockPath,
      createdAt: '2026-07-22T10:07:00.000Z'
    }), 'DEVELOPMENT_ACTIVATION_EVIDENCE_BATCH_REQUIRED');
    assert(!fs.existsSync(resolveRepoPath(
      temp,
      'soter/evidence/development/evidence.development-activation.codex.forge.json'
    )));

    expectCode(
      () => persistDevelopmentHostHistoricalEvidence({
        root: temp,
        requestId: 'development-request.forge/../../outside'
      }),
      'DEVELOPMENT_MIGRATION_EVIDENCE_SOURCE_INVALID'
    );

    const heldDirectory = governedDirectory + '.held';
    const escapedDirectory = path.join(temp, 'escaped-evidence-directory');
    fs.mkdirSync(escapedDirectory, { mode: 0o755 });
    fs.renameSync(governedDirectory, heldDirectory);
    fs.symlinkSync(escapedDirectory, governedDirectory);
    expectCode(
      () => persistDevelopmentHostHistoricalEvidence({ root: temp, requestId: receipt.requestId }),
      'DEVELOPMENT_EVIDENCE_OUTPUT_PATH_INVALID'
    );
    assert.equal(fs.readdirSync(escapedDirectory).length, 0);
  } finally {
    if (executableDirectory) fs.rmSync(executableDirectory, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function selftestFinalEvidenceBatchConstruction(sourceRoot) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-development-final-batch-construction-'));
  const executableDirectories = [];
  try {
    copyContainedRepository(sourceRoot, temp);
    const historicalByHost = new Map();
    const privateReceipts = new Map();
    for (const host of ['codex', 'claude']) {
      const receipt = preparePersistableReceipt(temp, host, 'final-batch');
      executableDirectories.push(receipt.executableState.directory);
      privateReceipts.set(host, receipt);
      historicalByHost.set(host, buildDevelopmentHostHistoricalEvidenceForBatch({
        root: temp,
        requestId: receipt.requestId,
        requireCurrentCandidateLock: true
      }));
    }
    for (const host of ['codex', 'claude']) {
      const built = historicalByHost.get(host);
      const relativePath = `soter/evidence/development/${built.evidence.id}.json`;
      writeRepositoryJson(temp, relativePath, built.evidence, 0o644);
      historicalByHost.set(host, {
        evidence: built.evidence,
        path: relativePath,
        fingerprint: fingerprintJson(built.evidence),
        idempotent: false
      });
    }
    const graph = activatePersistableForgeGraph(temp, historicalByHost);
    const bindings = [{
      host: 'codex',
      configPath: 'soter/configurations/harness-development-catalog.config.json',
      lockPath: 'soter/fixtures/harness-development-catalog-final/codex.lock.json'
    }, {
      host: 'claude',
      configPath: 'soter/configurations/harness-development-catalog-claude.config.json',
      lockPath: 'soter/fixtures/harness-development-catalog-final/claude.lock.json'
    }];
    const workflowIds = readJson(resolveRepoPath(temp, bindings[0].configPath)).packs
      .map(({ id }) => id)
      .filter((packId) => {
        const manifest = readJson(resolveRepoPath(temp, `soter/packs/${packId}/pack.json`));
        const guideArtifact = manifest.artifacts.find((artifact) => {
          return artifact.role === 'definition' && artifact.path.endsWith('/guide.json');
        });
        return guideArtifact
          && readJson(resolveRepoPath(temp, guideArtifact.path)).status.state === 'active';
      });
    assert(workflowIds.includes('automation.forge'));
    const locks = new Map();
    const evidence = new Map();
    for (const binding of bindings) {
      const lock = resolveDevelopmentEvidenceFinalizationConfiguration({
        root: temp,
        configPath: binding.configPath,
        host: binding.host,
        workflowIds
      });
      locks.set(binding.host, lock);
      const value = buildDevelopmentHostFinalEvidenceForBatch({
        root: temp,
        requestId: privateReceipts.get(binding.host).requestId,
        finalLock: lock,
        finalLockPath: binding.lockPath,
        createdAt: '2099-01-01T00:00:00.000Z'
      });
      evidence.set(binding.host, value);
      const migrationTargets = value.artifacts.filter((artifact) => artifact.role === 'migration-target');
      assert.deepEqual(
        migrationTargets.map((artifact) => artifact.path).sort(),
        [graph.guidePath, graph.evaluationPath].sort()
      );
      assert.equal(new Set(migrationTargets.map((artifact) => artifact.path)).size, 2);
    }

    for (const binding of bindings) {
      writeRepositoryJson(temp, binding.lockPath, locks.get(binding.host), 0o644);
      writeRepositoryJson(
        temp,
        finalForgeEvidencePath(binding.host),
        evidence.get(binding.host),
        0o644
      );
    }
    for (const binding of bindings) {
      const expected = finalEvidenceApplicability(locks.get(binding.host));
      const observed = Object.fromEntries(
        Object.keys(expected).map((key) => [key, evidence.get(binding.host)[key]])
      );
      assert.deepEqual(
        observed,
        expected,
        'batch-built final evidence must reproduce its exact unpublished lock'
      );
    }

    expectCode(() => persistDevelopmentHostFinalEvidence({
      root: temp,
      requestId: privateReceipts.get('codex').requestId,
      finalLockPath: bindings[0].lockPath,
      createdAt: '2099-01-01T00:00:00.000Z'
    }), 'DEVELOPMENT_ACTIVATION_EVIDENCE_BATCH_REQUIRED');
    expectCode(() => buildDevelopmentHostFinalEvidenceForBatch({
      root: temp,
      requestId: privateReceipts.get('codex').requestId,
      finalLock: locks.get('codex'),
      finalLockPath: bindings[0].lockPath,
      createdAt: '2000-01-01T00:00:00.000Z'
    }), 'DEVELOPMENT_ACTIVATION_EVIDENCE_CHRONOLOGY_INVALID');

    const retiredCli = spawnSync(process.execPath, [
      resolveRepoPath(temp, 'soter/core/cli.mjs'),
      'development-host-evidence-final',
      '--root', temp,
      '--request-id', privateReceipts.get('codex').requestId,
      '--lock', bindings[0].lockPath,
      '--at', '2099-01-01T00:00:00.000Z'
    ], { cwd: temp, encoding: 'utf8' });
    assert.equal(retiredCli.status, 1);
    assert.match(retiredCli.stderr, /DEVELOPMENT_ACTIVATION_EVIDENCE_BATCH_REQUIRED/u);
  } finally {
    for (const directory of executableDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function selftestSingleHistoricalEvidencePublicationRetired(sourceRoot) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-development-evidence-retired-'));
  let executableDirectory = null;
  try {
    copyContainedRepository(sourceRoot, temp);
    const evidenceDirectory = resolveRepoPath(temp, 'soter/evidence/development');
    const evidenceBefore = fs.existsSync(evidenceDirectory)
      ? fingerprintPath(evidenceDirectory)
      : null;
    const receipt = preparePersistableReceipt(temp);
    executableDirectory = receipt.executableState.directory;
    expectCode(() => persistDevelopmentHostHistoricalEvidence({
      root: temp,
      requestId: receipt.requestId
    }), 'DEVELOPMENT_MIGRATION_EVIDENCE_BATCH_REQUIRED');
    const retiredCli = spawnSync(process.execPath, [
      resolveRepoPath(temp, 'soter/core/cli.mjs'),
      'development-host-evidence-historical',
      '--root', temp,
      '--request-id', receipt.requestId
    ], { cwd: temp, encoding: 'utf8' });
    assert.equal(retiredCli.status, 1);
    assert.match(retiredCli.stderr, /DEVELOPMENT_MIGRATION_EVIDENCE_BATCH_REQUIRED/u);
    assert.equal(
      fs.existsSync(evidenceDirectory) ? fingerprintPath(evidenceDirectory) : null,
      evidenceBefore
    );
    const built = buildDevelopmentHostHistoricalEvidenceForBatch({
      root: temp,
      requestId: receipt.requestId,
      requireCurrentCandidateLock: true
    });
    assert.equal(built.evidence.authority.grantsActivation, false);
    assert.equal(built.binding.requestId, receipt.requestId);
    assert.equal(
      fs.existsSync(evidenceDirectory) ? fingerprintPath(evidenceDirectory) : null,
      evidenceBefore
    );
  } finally {
    if (executableDirectory) fs.rmSync(executableDirectory, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function selftestDevelopmentHostObservations(root = scriptRoot) {
  selftestHistoricalCandidateLockBinding();
  selftestSingleHistoricalEvidencePublicationRetired(root);
  selftestFinalEvidenceBatchConstruction(root);
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
  const workflowSources = workflowLegacySourceProjection({
    definition: readJson(resolveRepoPath(root, 'soter/automations/forge/definition.json')),
    guide: readJson(resolveRepoPath(root, 'soter/automations/forge/guide.json')),
    evaluations: readJson(resolveRepoPath(root, 'soter/automations/forge/evaluations.json'))
  }).map(({ path: sourcePath, fingerprint }) => ({ path: sourcePath, fingerprint }));
  const migration = {
    sources: workflowSources,
    target: {
      path: 'soter/automations/forge/guide.json',
      fingerprint: observation.evaluatedSubject.fingerprint
    }
  };
  const evidence = convertDevelopmentHostObservationToMigrationEvidence({ ...args, migration });
  const repeated = convertDevelopmentHostObservationToMigrationEvidence({ ...args, migration });
  const baselineFindingEvidence = convertDevelopmentHostObservationToMigrationEvidence({
    ...args,
    observation: baselineFinding,
    result: baselineFindingResult,
    migration
  });
  assert.equal(FP(evidence), FP(repeated), 'conversion must be deterministic');
  assert.equal(assertDevelopmentAgentMigrationEvidence({ evidence, ...args, migration }), evidence);
  assert.equal(
    baselineFindingEvidence.conclusion.prohibitedOutcomesObserved,
    true,
    'migration evidence must truthfully retain an observed non-gating baseline prohibited finding'
  );
  assert.equal(
    assertDevelopmentAgentMigrationEvidence({
      evidence: baselineFindingEvidence,
      ...args,
      observation: baselineFinding,
      result: baselineFindingResult,
      migration
    }),
    baselineFindingEvidence
  );
  assert.equal(evidence.$contract, 'soter://contracts/development-agent-migration-evidence/v1');
  assert.equal(
    evidence.id,
    'development-agent-migration-evidence.codex.forge',
    'governed evidence identity must be stable across private request generations'
  );
  assert.equal(
    evidence.request.id,
    observation.request.id,
    'stable governed evidence must retain the exact private request identity as a binding'
  );
  assert.equal(evidence.sourceObservation.id, observation.id);
  const unsignedEvidence = structuredClone(evidence);
  delete unsignedEvidence.evidenceFingerprint;
  assert.equal(
    evidence.evidenceFingerprint,
    FP(unsignedEvidence),
    'stable governed evidence identity and exact private bindings must remain fingerprinted'
  );
  const migrationEvidenceSchema = readJson(resolveRepoPath(
    root,
    'soter/contracts/development-agent-migration-evidence.schema.json'
  ));
  const generationBearingEvidenceId = structuredClone(evidence);
  generationBearingEvidenceId.id += '.r12';
  assert.notEqual(
    validateJsonSchema(generationBearingEvidenceId, migrationEvidenceSchema).length,
    0,
    'public governed evidence identity must reject private request-generation suffixes'
  );
  assert.equal(evidence.conclusion.state, 'passed');
  assert.equal(evidence.conclusion.baselineRole, 'observed-non-gating');
  assert.equal(evidence.applicability.kind, 'historical-candidate-only');
  assert.equal(evidence.applicability.finalGraph, 'not-claimed');
  assert.equal(evidence.applicability.finalProjection, 'not-claimed');
  assert.equal(evidence.applicability.currentRuntime, 'not-claimed');
  assert.equal(evidence.applicability.activation, 'not-granted');
  assert.equal(evidence.applicability.fallbackRemoval, 'not-granted');
  assert.equal(evidence.host.id, 'codex');
  assert.equal(evidence.authority.grantsActivation, false);
  assert.equal(evidence.authority.grantsMigration, false);
  assert.equal(evidence.authority.grantsFallbackRemoval, false);
  assert(evidence.limitations.includes(
    'DEVELOPMENT_AGENT_MIGRATION_EVIDENCE_LOCAL_BINARY_IDENTITY_ONLY'
  ));
  assert(observation.limitations.includes(
    'DEVELOPMENT_HOST_OBSERVATION_LOCAL_BINARY_IDENTITY_ONLY'
  ));
  assert(!('claimFamily' in evidence));
  assert(!('configurationLockFingerprint' in evidence));
  assert.equal(evidence.artifacts.find((item) => item.role === 'migration-target').fingerprint,
    observation.evaluatedSubject.fingerprint);
  assert.equal(evidence.artifacts.find((item) => item.role === 'migration-target').subjectId,
    observation.evaluatedSubject.id);
  assert.equal(evidence.artifacts.find((item) => item.role === 'development-request').subjectId,
    observation.request.id);
  assert.equal(evidence.artifacts.find((item) => item.role === 'evaluation-set').fingerprint,
    observation.evaluationSet.fingerprint);
  assert.equal(evidence.artifacts.find((item) => item.role === 'candidate-projection').fingerprint,
    observation.evaluatedSubject.candidateProjectionFingerprint);
  assert.equal(evidence.runs[0].caseFingerprint, observation.runs[0].caseFingerprint);
  assert.equal(evidence.runs[0].stimulusFingerprint, observation.runs[0].stimulusFingerprint);
  assert.equal(evidence.runs[0].worker.id, observation.runs[0].worker.id);
  assert.equal(evidence.runs[0].worker.expectationsIncluded, false);
  assert.equal(evidence.runs[0].worker.answerKeyAccess, 'not-observed');
  assert.deepEqual(evidence.runs[0].judgment.criteria, observation.runs[0].judgment.criteria);
  const serialized = JSON.stringify(evidence);
  assert(!serialized.includes('soter/private-targets'));
  assert(!serialized.includes('PRIVATE_TRANSCRIPT_SENTINEL'));
  assert(!serialized.includes('/Users/'));
  assert(!serialized.includes('rawProviderResponse'));

  const tamperedEvidence = structuredClone(evidence);
  tamperedEvidence.evidenceFingerprint = FP({ tampered: true });
  expectCode(() => assertDevelopmentAgentMigrationEvidence({
    evidence: tamperedEvidence,
    ...args,
    migration
  }), 'DEVELOPMENT_MIGRATION_EVIDENCE_TAMPERED');

  const reboundEvidence = structuredClone(evidence);
  reboundEvidence.applicability.candidate.graphFingerprint = FP({ graph: 'substituted' });
  resignMigrationEvidence(reboundEvidence);
  expectCode(() => assertDevelopmentAgentMigrationEvidence({
    evidence: reboundEvidence,
    ...args,
    migration
  }), 'DEVELOPMENT_MIGRATION_EVIDENCE_BINDING_INVALID');

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

  const wrongTarget = structuredClone(migration);
  wrongTarget.target.fingerprint = FP({ guide: 'substituted' });
  expectCode(() => convertDevelopmentHostObservationToMigrationEvidence({ ...args, migration: wrongTarget }),
    'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID');
  const missingSource = structuredClone(migration);
  missingSource.sources.pop();
  expectCode(() => convertDevelopmentHostObservationToMigrationEvidence({ ...args, migration: missingSource }),
    'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID');
  const absoluteSource = structuredClone(migration);
  absoluteSource.sources[0].path = '/Users/private/legacy/source.md';
  expectCode(() => convertDevelopmentHostObservationToMigrationEvidence({ ...args, migration: absoluteSource }),
    'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID');
  const substitutedSource = structuredClone(migration);
  substitutedSource.sources[0].fingerprint = FP({ source: 'substituted' });
  expectCode(() => convertDevelopmentHostObservationToMigrationEvidence({ ...args, migration: substitutedSource }),
    'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID');

  process.stdout.write(
    'Soter development host observation self-test passed: exact bindings, trusted adapter and post-workspace input, chronology, fresh workers, dispatches, transcripts, criteria, no external effects, privacy non-representability, deterministic no-authority migration evidence, and create-only governed persistence.\n'
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
