import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fingerprintWorkflowEvaluatedSubject,
  fingerprintWorkflowEvaluationCase,
  fingerprintWorkflowGuideContent,
  workflowLegacySourceProjection
} from '../kernel/workflow-guides.mjs';
import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  buildDevelopmentWorkflowLifecycleFinalizationRequest,
  buildDevelopmentWorkflowLifecycleFinalizationCandidate,
  developmentWorkflowLifecycleFinalizationContract,
  planDevelopmentWorkflowLifecycleFinalization
} from './development-workflow-lifecycle-finalization.mjs';
import { fingerprintFile, fingerprintJson, readJson } from './lib/canonical-json.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REQUEST_ID = 'development-workflow-lifecycle-finalization.selftest';
const CREATED_AT = '2026-07-22T12:00:00.000Z';

function hash(label) {
  return fingerprintJson({ label });
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function writeCanonicalJson(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, canonicalBytes(value), { mode });
  if (process.platform !== 'win32') fs.chmodSync(file, mode);
}

function sign(value, field) {
  const unsigned = structuredClone(value);
  delete unsigned[field];
  value[field] = fingerprintJson(unsigned);
  return value;
}

function copyFile(root, temp, relativePath) {
  const target = path.join(temp, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, relativePath), target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o644);
}

function workflowFiles(root, workflowId) {
  const slug = workflowId.slice('automation.'.length);
  const paths = {
    definition: `soter/automations/${slug}/definition.json`,
    guide: `soter/automations/${slug}/guide.json`,
    evaluations: `soter/automations/${slug}/evaluations.json`
  };
  return {
    paths,
    definition: readJson(path.join(root, paths.definition)),
    guide: readJson(path.join(root, paths.guide)),
    evaluations: readJson(path.join(root, paths.evaluations))
  };
}

function workflowBasis(files) {
  return {
    definitionFingerprint: fingerprintJson(files.definition),
    guideFingerprint: fingerprintJson(files.guide),
    evaluationSetFingerprint: fingerprintJson(files.evaluations),
    evaluatedSubjectFingerprint: fingerprintWorkflowEvaluatedSubject(files)
  };
}

function copyCandidate(root) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-workflow-finalization-selftest-'));
  for (const relativePath of [
    'soter/contracts/workflow-definition.schema.json',
    'soter/contracts/workflow-guide.schema.json',
    'soter/contracts/workflow-evaluation-set.schema.json',
    'soter/contracts/development-agent-migration-evidence.schema.json'
  ]) copyFile(root, temp, relativePath);

  for (const workflowId of [
    ...developmentWorkflowLifecycleFinalizationContract.activeWorkflows,
    ...developmentWorkflowLifecycleFinalizationContract.retiredWorkflows
  ]) {
    const slug = workflowId.slice('automation.'.length);
    for (const name of ['definition.json', 'guide.json', 'evaluations.json']) {
      copyFile(root, temp, `soter/automations/${slug}/${name}`);
    }
    const files = workflowFiles(temp, workflowId);
    const sourcePaths = [...new Set([
      files.guide.source.legacyPath,
      ...files.evaluations.cases.map((item) => item.source.legacyPath)
    ])];
    for (const sourcePath of sourcePaths) {
      const file = path.join(temp, sourcePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `Synthetic exact legacy source for ${workflowId} at ${sourcePath}.\n`);
      if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
    }
    const guideSourceFingerprint = fingerprintFile(path.join(temp, files.guide.source.legacyPath));
    files.definition.source = {
      presence: 'present',
      legacyPath: files.guide.source.legacyPath,
      legacyFingerprint: guideSourceFingerprint
    };
    files.guide.source = {
      ...files.guide.source,
      presence: 'present',
      legacyFingerprint: guideSourceFingerprint
    };
    for (const testCase of files.evaluations.cases) {
      testCase.source.presence = 'present';
      testCase.source.legacyFingerprint = fingerprintFile(path.join(temp, testCase.source.legacyPath));
    }
    if (developmentWorkflowLifecycleFinalizationContract.activeWorkflows.includes(workflowId)) {
      files.definition.lifecycle.activation = {
        state: 'candidate',
        reasonCode: 'WORKFLOW_HOST_GUIDANCE_AWAITING_EVIDENCE',
        proceduralAuthority: 'legacy',
        delivery: 'preview-only',
        behaviorParity: 'not-evaluated',
        evidence: [],
        permittedNextAction: 'evaluate-host-projections'
      };
      files.guide.status = {
        state: 'candidate',
        reasonCode: 'WORKFLOW_GUIDE_PARITY_NOT_EVALUATED',
        proceduralAuthority: 'legacy',
        behaviorParity: 'not-evaluated',
        delivery: 'preview-only',
        evidence: [],
        permittedNextAction: 'evaluate-host-projections'
      };
      files.evaluations.lifecycle = {
        state: 'active-host-guided',
        activation: 'candidate',
        authority: 'request-bound-development-evidence',
        permittedNextAction: 'run-exact-evaluation-suite'
      };
    } else {
      files.definition.lifecycle.retirement = {
        state: 'candidate',
        reasonCode: 'WORKFLOW_RETIREMENT_AWAITING_MIGRATION',
        proceduralAuthority: 'legacy',
        fallback: 'retained',
        evidence: [],
        permittedNextAction: 'prove-retirement'
      };
      files.guide.status = {
        state: 'retirement-candidate',
        reasonCode: 'WORKFLOW_GUIDE_RETIREMENT_AWAITING_MIGRATION',
        proceduralAuthority: 'legacy',
        behaviorParity: 'not-evaluated',
        delivery: 'unavailable',
        evidence: [],
        permittedNextAction: 'prove-retirement'
      };
      files.evaluations.lifecycle = {
        state: 'retired',
        retirement: 'candidate',
        authority: 'none',
        permittedNextAction: 'prove-retirement'
      };
    }
    files.guide.workflow.definitionFingerprint = fingerprintJson(files.definition);
    files.guide.workflow.evaluationSetFingerprint = fingerprintJson(files.evaluations);
    files.guide.contentFingerprint = fingerprintWorkflowGuideContent(files.guide);
    writeCanonicalJson(path.join(temp, files.paths.definition), files.definition);
    writeCanonicalJson(path.join(temp, files.paths.guide), files.guide);
    writeCanonicalJson(path.join(temp, files.paths.evaluations), files.evaluations);
  }
  return temp;
}

function noEffectObservation() {
  return { state: 'not-observed', count: 0, observedFingerprint: null };
}

function workspaceBasis(label) {
  return {
    rootIdentityFingerprint: hash(label + '.root'),
    revisionFingerprint: null,
    treeFingerprint: hash(label + '.tree'),
    exactInputState: 'dirty',
    policyFingerprint: hash(label + '.policy'),
    settingsFingerprint: hash(label + '.settings')
  };
}

function historicalEvidence(root, workflowId, host) {
  const files = workflowFiles(root, workflowId);
  const basis = workflowBasis(files);
  const slug = workflowId.slice('automation.'.length);
  const candidateProjectionFingerprint = hash(`${workflowId}.${host}.candidate-projection`);
  const requestId = `development-request.${host}.${slug}`;
  const resultId = `development-result.${host}.${slug}`;
  const observationId = `development-host-observation.${host}.${slug}`;
  const sources = workflowLegacySourceProjection(files);
  const baseline = files.evaluations.cases.find((testCase) => testCase.id === 'happy-path');
  const plannedRuns = [baseline, ...files.evaluations.cases].map((testCase, index) => ({
    testCase,
    arm: index === 0 ? 'baseline' : 'guided'
  }));
  const runs = plannedRuns.map(({ testCase, arm }, index) => ({
    id: arm === 'baseline'
      ? `evaluation-run.${slug}.baseline`
      : `evaluation-run.${slug}.guided.${testCase.id}`,
    sequence: index + 1,
    caseId: testCase.id,
    caseFingerprint: fingerprintWorkflowEvaluationCase(testCase),
    stimulusFingerprint: fingerprintJson(testCase.stimulus),
    arm,
    guideState: arm === 'baseline' ? 'withheld' : 'candidate',
    startedAt: `2026-07-22T11:0${index}:00.000Z`,
    completedAt: `2026-07-22T11:0${index}:30.000Z`,
    worker: {
      id: `worker-run.${host}.${slug}.${index + 1}`,
      workerFingerprint: hash(`${workflowId}.${host}.${index + 1}.worker`),
      dispatchFingerprint: hash(`${workflowId}.${host}.${index + 1}.dispatch`),
      transcriptFingerprint: hash(`${workflowId}.${host}.${index + 1}.transcript`),
      expectationsIncluded: false,
      answerKeyAccess: 'not-observed',
      state: 'passed'
    },
    judgment: {
      id: `judgment.${host}.${slug}.${index + 1}`,
      verdict: 'passed',
      criteria: [
        ...testCase.expectedObservations.map((_item, criterionIndex) => ({
          id: `${testCase.id}.expected.${criterionIndex + 1}`,
          kind: 'expected',
          sequence: criterionIndex + 1,
          state: 'observed',
          evidenceFingerprint: hash(`${workflowId}.${host}.${arm}.expected.${criterionIndex + 1}`)
        })),
        ...testCase.prohibitedOutcomes.map((_item, criterionIndex) => ({
          id: `${testCase.id}.prohibited.${criterionIndex + 1}`,
          kind: 'prohibited',
          sequence: criterionIndex + 1,
          state: 'not-observed',
          evidenceFingerprint: hash(`${workflowId}.${host}.${arm}.prohibited.${criterionIndex + 1}`)
        }))
      ]
    }
  }));
  const evidence = {
    $contract: 'soter://contracts/development-agent-migration-evidence/v1',
    contractVersion: '1.0.0',
    id: `development-agent-migration-evidence.${host}.${slug}`,
    evidenceFingerprint: null,
    createdAt: '2026-07-22T11:30:00.000Z',
    sourceObservation: {
      id: observationId,
      fingerprint: hash(observationId),
      observedAt: '2026-07-22T11:30:00.000Z'
    },
    applicability: {
      kind: 'historical-candidate-only',
      evaluatedSubjectFingerprint: basis.evaluatedSubjectFingerprint,
      candidate: {
        configurationName: 'harness-development-catalog',
        lockFingerprint: hash(`${workflowId}.${host}.lock`),
        graphFingerprint: hash(`${workflowId}.${host}.graph`),
        candidateProjectionFingerprint
      },
      finalGraph: 'not-claimed',
      finalProjection: 'not-claimed',
      currentRuntime: 'not-claimed',
      activation: 'not-granted',
      fallbackRemoval: 'not-granted'
    },
    request: {
      id: requestId,
      fingerprint: hash(requestId),
      createdAt: '2026-07-22T10:59:00.000Z'
    },
    result: {
      id: resultId,
      fingerprint: hash(resultId),
      createdAt: '2026-07-22T11:00:00.000Z',
      completedAt: '2026-07-22T11:20:00.000Z',
      state: 'passed'
    },
    workflow: {
      id: workflowId,
      version: files.definition.version,
      definitionFingerprint: basis.definitionFingerprint
    },
    evaluatedSubject: {
      kind: 'workflow-guide',
      id: files.guide.id,
      version: files.definition.version,
      fingerprint: basis.evaluatedSubjectFingerprint,
      contentFingerprint: files.guide.contentFingerprint,
      candidateProjectionFingerprint
    },
    evaluationSet: {
      id: files.evaluations.id,
      version: files.evaluations.version,
      fingerprint: basis.evaluationSetFingerprint
    },
    host: {
      id: host,
      adapter: `host.${host}`,
      version: '1.0.0',
      adapterFingerprint: hash(`${host}.adapter`),
      projectionDefinitionId: `host-projection.${host}`,
      projectionDefinitionFingerprint: hash(`${host}.projection`),
      evaluatedInstructionFingerprint: hash(`${host}.instructions`),
      candidateProjectionFingerprint,
      observer: {
        id: `development-host-observer.${host}`,
        version: '1.0.0',
        implementationFingerprint: hash(`${host}.observer`),
        transport: 'trusted-local-host-adapter'
      }
    },
    workspace: {
      pre: workspaceBasis(`${workflowId}.${host}.pre`),
      post: workspaceBasis(`${workflowId}.${host}.post`)
    },
    environment: {
      containment: 'isolated-host-process',
      runtimeFingerprint: hash(`${host}.runtime`)
    },
    runs,
    artifacts: [
      ...sources.map((source, index) => ({
        id: `artifact.migration-source.${index + 1}`,
        role: 'migration-source',
        subjectId: workflowId,
        path: source.path,
        fingerprint: source.fingerprint
      })),
      {
        id: 'artifact.migration-target',
        role: 'migration-target',
        subjectId: files.guide.id,
        path: files.paths.guide,
        fingerprint: basis.evaluatedSubjectFingerprint
      },
      { id: 'artifact.development-request', role: 'development-request', subjectId: requestId, fingerprint: hash(requestId) },
      { id: 'artifact.development-result', role: 'development-result', subjectId: resultId, fingerprint: hash(resultId) },
      { id: 'artifact.host-observation', role: 'host-observation', subjectId: observationId, fingerprint: hash(observationId) },
      { id: 'artifact.evaluation-set', role: 'evaluation-set', subjectId: files.evaluations.id, fingerprint: basis.evaluationSetFingerprint },
      { id: 'artifact.candidate-projection', role: 'candidate-projection', subjectId: files.guide.id, fingerprint: candidateProjectionFingerprint }
    ],
    externalEffects: {
      providerRead: noEffectObservation(),
      providerWrite: noEffectObservation(),
      publication: noEffectObservation(),
      merge: noEffectObservation(),
      protectedRootMutation: noEffectObservation(),
      hostRealization: noEffectObservation()
    },
    conclusion: {
      state: 'passed',
      behaviorParity: 'passed',
      baselineRole: 'observed-non-gating',
      guidedRunsPassed: true,
      prohibitedOutcomesObserved: false,
      externalEffectsObserved: false
    },
    authority: {
      kind: 'migration-evidence-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsActivation: false,
      grantsMigration: false,
      grantsPublication: false,
      grantsMerge: false,
      grantsProviderRead: false,
      grantsProviderWrite: false,
      grantsHostRealization: false,
      grantsPromotion: false,
      grantsFallbackRemoval: false
    },
    privacy: {
      scope: 'shareable-sanitized',
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
      'DEVELOPMENT_AGENT_MIGRATION_EVIDENCE_HISTORICAL_CANDIDATE_ONLY',
      'DEVELOPMENT_AGENT_MIGRATION_EVIDENCE_LOCAL_BINARY_IDENTITY_ONLY',
      'DEVELOPMENT_AGENT_MIGRATION_EVIDENCE_NO_AUTHORITY',
      'DEVELOPMENT_AGENT_MIGRATION_EVIDENCE_NO_CURRENT_RUNTIME_APPLICABILITY'
    ]
  };
  return sign(evidence, 'evidenceFingerprint');
}

function writeRequest(requestFile, request) {
  sign(request, 'requestFingerprint');
  writeCanonicalJson(requestFile, request, 0o600);
}

function makeRequest(root, requestFile) {
  const active = developmentWorkflowLifecycleFinalizationContract.activeWorkflows.map((id) => {
    const files = workflowFiles(root, id);
    return {
      id,
      basis: workflowBasis(files),
      evidence: ['claude', 'codex'].map((host) => {
        const value = historicalEvidence(root, id, host);
        const relativePath = `soter/evidence/development/${value.id}.json`;
        writeCanonicalJson(path.join(root, relativePath), value);
        return { path: relativePath, fingerprint: fingerprintJson(value), host };
      })
    };
  });
  const retired = developmentWorkflowLifecycleFinalizationContract.retiredWorkflows.map((id) => {
    const slug = id.slice('automation.'.length);
    return {
      id,
      basis: workflowBasis(workflowFiles(root, id)),
      evidence: {
        path: `soter/fixtures/harness-development-catalog/${slug}.intentional-retirement.evidence.json`
      }
    };
  });
  const request = {
    $contract: developmentWorkflowLifecycleFinalizationContract.request,
    contractVersion: '1.0.0',
    id: REQUEST_ID,
    requestFingerprint: null,
    rootIdentityFingerprint: fingerprintJson({ root: fs.realpathSync(root) }),
    createdAt: CREATED_AT,
    active,
    retired
  };
  writeRequest(requestFile, request);
  return request;
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

export function selftestDevelopmentWorkflowLifecycleFinalization(root = defaultRoot) {
  const candidate = copyCandidate(root);
  const requestDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'soter-workflow-finalization-request-'))
  );
  const requestFile = path.join(requestDirectory, 'request.json');
  try {
    const request = makeRequest(candidate, requestFile);
    const paths = [
      ...developmentWorkflowLifecycleFinalizationContract.activeWorkflows,
      ...developmentWorkflowLifecycleFinalizationContract.retiredWorkflows
    ].flatMap((id) => Object.values(workflowFiles(candidate, id).paths));
    const before = new Map(paths.map((relativePath) => [relativePath, fingerprintFile(path.join(candidate, relativePath))]));

    const builtRequest = buildDevelopmentWorkflowLifecycleFinalizationRequest({
      root: candidate,
      id: REQUEST_ID,
      createdAt: CREATED_AT
    });
    assert.deepEqual(builtRequest, request);
    assert.deepEqual(builtRequest.active.map((row) => row.evidence.map((item) => item.host)),
      builtRequest.active.map(() => ['claude', 'codex']));
    const rebuiltRequest = buildDevelopmentWorkflowLifecycleFinalizationRequest({
      root: candidate,
      id: REQUEST_ID,
      createdAt: CREATED_AT
    });
    assert.notEqual(rebuiltRequest, builtRequest);
    assert.deepEqual(rebuiltRequest, builtRequest);

    const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const cliRequestFile = path.join(requestDirectory, 'cli-request.json');
    const createdByCli = spawnSync(process.execPath, [
      cliPath,
      'development-workflow-lifecycle-request-create',
      '--root', candidate,
      '--json',
      '--id', REQUEST_ID,
      '--created-at', CREATED_AT,
      '--output', cliRequestFile
    ], { encoding: 'utf8' });
    assert.equal(
      createdByCli.status,
      0,
      'CLI request creation failed: ' + createdByCli.stderr
    );
    const plannedByCli = spawnSync(process.execPath, [
      cliPath,
      'development-workflow-lifecycle-plan',
      '--root', candidate,
      '--json',
      '--request', cliRequestFile
    ], { encoding: 'utf8' });
    assert.equal(
      plannedByCli.status,
      0,
      'CLI-created request was rejected by its next lifecycle command: ' + plannedByCli.stderr
    );
    const cliPlan = JSON.parse(plannedByCli.stdout);
    assert.equal(cliPlan.state, 'planned');
    assert.equal(
      cliPlan.workflows.find((row) => row.id === 'automation.auditing-a-schema-doc').parity,
      'passed'
    );
    assert.equal(
      cliPlan.workflows.find((row) => row.id === 'automation.validating-resources').parity,
      'intentional-change'
    );
    assert.equal(
      cliPlan.workflows.find((row) => row.id === 'automation.writing-adrs').parity,
      'intentional-change'
    );

    builtRequest.active[0].basis.definitionFingerprint = hash('caller-mutation');
    assert.deepEqual(buildDevelopmentWorkflowLifecycleFinalizationRequest({
      root: candidate,
      id: REQUEST_ID,
      createdAt: CREATED_AT
    }), rebuiltRequest);
    for (const [relativePath, fingerprint] of before) {
      assert.equal(fingerprintFile(path.join(candidate, relativePath)), fingerprint);
    }
    assert.equal(fs.existsSync(path.join(candidate, '.soter')), false);

    assertCode(() => buildDevelopmentWorkflowLifecycleFinalizationRequest({
      root: candidate,
      id: REQUEST_ID,
      createdAt: CREATED_AT,
      unexpected: true
    }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_ARGUMENTS_INVALID');

    const builderEvidencePath = request.active[0].evidence[0].path;
    const builderEvidenceFile = path.join(candidate, builderEvidencePath);
    const validBuilderEvidence = readJson(builderEvidenceFile);
    fs.unlinkSync(builderEvidenceFile);
    assertCode(() => buildDevelopmentWorkflowLifecycleFinalizationRequest({
      root: candidate,
      id: REQUEST_ID,
      createdAt: CREATED_AT
    }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID');
    writeCanonicalJson(builderEvidenceFile, validBuilderEvidence);

    const tamperedBuilderEvidence = structuredClone(validBuilderEvidence);
    tamperedBuilderEvidence.evidenceFingerprint = hash('tampered-builder-evidence');
    writeCanonicalJson(builderEvidenceFile, tamperedBuilderEvidence);
    assertCode(() => buildDevelopmentWorkflowLifecycleFinalizationRequest({
      root: candidate,
      id: REQUEST_ID,
      createdAt: CREATED_AT
    }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID');
    writeCanonicalJson(builderEvidenceFile, validBuilderEvidence);

    const crossedBuilderEvidence = structuredClone(validBuilderEvidence);
    const crossedHost = validBuilderEvidence.host.id === 'claude' ? 'codex' : 'claude';
    crossedBuilderEvidence.host.id = crossedHost;
    crossedBuilderEvidence.host.adapter = `host.${crossedHost}`;
    crossedBuilderEvidence.host.projectionDefinitionId = `host-projection.${crossedHost}`;
    crossedBuilderEvidence.host.observer.id = `development-host-observer.${crossedHost}`;
    sign(crossedBuilderEvidence, 'evidenceFingerprint');
    writeCanonicalJson(builderEvidenceFile, crossedBuilderEvidence);
    assertCode(() => buildDevelopmentWorkflowLifecycleFinalizationRequest({
      root: candidate,
      id: REQUEST_ID,
      createdAt: CREATED_AT
    }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID');
    writeCanonicalJson(builderEvidenceFile, validBuilderEvidence);

    const plan = planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile });
    assert.equal(plan.state, 'planned');
    assert.equal(plan.workflows.length, 10);
    assert.equal(plan.files.length, 30);
    assert.equal(plan.authority.kind, 'workflow-lifecycle-candidate-only');
    assert.equal(plan.authority.repositoryWrites, false);
    assert.equal(plan.authority.sourceDeletion, false);
    assert.equal(plan.authority.fallbackRemoval, false);
    assert.equal(Object.hasOwn(plan.files[0], 'before'), false);
    assert.equal(Object.hasOwn(plan.files[0], 'after'), false);

    const built = buildDevelopmentWorkflowLifecycleFinalizationCandidate({ root: candidate, requestPath: requestFile });
    assert.equal(built.plan.planFingerprint, plan.planFingerprint);
    const returnedUnsignedRequest = structuredClone(built.request);
    delete returnedUnsignedRequest.requestFingerprint;
    assert.equal(fingerprintJson(returnedUnsignedRequest), built.request.requestFingerprint);
    assert.equal(built.files.length, 30);
    assert(built.files.every((entry) => entry.mode === '0644'));
    assert(built.files.every((entry) => entry.beforeFileFingerprint === fingerprintFile(path.join(candidate, entry.path))));
    for (const [relativePath, fingerprint] of before) assert.equal(fingerprintFile(path.join(candidate, relativePath)), fingerprint);
    assert.equal(fs.existsSync(path.join(candidate, '.soter')), false);

    const invalidInstant = structuredClone(request);
    invalidInstant.createdAt = '0';
    writeRequest(requestFile, invalidInstant);
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_REQUEST_INVALID');

    const wrongRetirement = structuredClone(request);
    wrongRetirement.retired[0].evidence.path = 'soter/fixtures/harness-development-catalog/substituted.intentional-retirement.evidence.json';
    writeRequest(requestFile, wrongRetirement);
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_WORKFLOW_SET_INVALID');

    const wrongBasis = structuredClone(request);
    wrongBasis.active[0].basis.definitionFingerprint = hash('substituted-definition');
    writeRequest(requestFile, wrongBasis);
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_BASIS_INVALID');

    const invalidCurrentPath = path.join(candidate, 'soter/automations/running-evals/guide.json');
    const validCurrentGuide = readJson(invalidCurrentPath);
    const invalidCurrentGuide = structuredClone(validCurrentGuide);
    invalidCurrentGuide.workflow.definitionFingerprint = hash('stale-definition-binding');
    invalidCurrentGuide.contentFingerprint = fingerprintWorkflowGuideContent(invalidCurrentGuide);
    writeCanonicalJson(invalidCurrentPath, invalidCurrentGuide);
    writeRequest(requestFile, request);
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_SOURCE_INVALID');
    writeCanonicalJson(invalidCurrentPath, validCurrentGuide);

    const firstReference = request.active[0].evidence[0];
    const evidenceFile = path.join(candidate, firstReference.path);
    const validEvidence = readJson(evidenceFile);
    const evidenceSchema = readJson(path.join(
      candidate,
      'soter/contracts/development-agent-migration-evidence.schema.json'
    ));
    assert.deepEqual(
      validateJsonSchema(validEvidence, evidenceSchema),
      [],
      'the governed development evidence must remain schema-valid'
    );
    const writeEvidenceCase = (evidence) => {
      sign(evidence, 'evidenceFingerprint');
      writeCanonicalJson(evidenceFile, evidence);
      const evidenceRequest = structuredClone(request);
      evidenceRequest.active[0].evidence[0].fingerprint = fingerprintJson(evidence);
      writeRequest(requestFile, evidenceRequest);
    };
    const invalidEvidence = structuredClone(validEvidence);
    delete invalidEvidence.authority;
    sign(invalidEvidence, 'evidenceFingerprint');
    writeCanonicalJson(evidenceFile, invalidEvidence);
    const invalidEvidenceRequest = structuredClone(request);
    invalidEvidenceRequest.active[0].evidence[0].fingerprint = fingerprintJson(invalidEvidence);
    writeRequest(requestFile, invalidEvidenceRequest);
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID');
    writeCanonicalJson(evidenceFile, validEvidence);

    const baselineFindingEvidence = structuredClone(validEvidence);
    const baselineRun = baselineFindingEvidence.runs.find((run) => run.arm === 'baseline');
    assert(baselineRun);
    baselineRun.worker.state = 'failed';
    baselineRun.judgment.verdict = 'blocked';
    baselineRun.judgment.criteria.find((criterion) => {
      return criterion.kind === 'expected';
    }).state = 'unknown';
    baselineRun.judgment.criteria.find((criterion) => {
      return criterion.kind === 'prohibited';
    }).state = 'observed';
    baselineFindingEvidence.conclusion.prohibitedOutcomesObserved = true;
    writeEvidenceCase(baselineFindingEvidence);
    assert.deepEqual(
      validateJsonSchema(readJson(evidenceFile), evidenceSchema),
      [],
      'baseline worker, judgment, expected, and prohibited findings must remain schema-valid'
    );
    assert.equal(
      planDevelopmentWorkflowLifecycleFinalization({
        root: candidate,
        requestPath: requestFile
      }).state,
      'planned',
      'observed baseline findings must remain represented but non-gating'
    );
    assert.equal(
      readJson(evidenceFile).conclusion.prohibitedOutcomesObserved,
      true,
      'the accepted baseline finding must remain truthful in the evidence conclusion'
    );
    writeCanonicalJson(evidenceFile, validEvidence);
    writeRequest(requestFile, request);

    for (const { label, mutate } of [
      {
        label: 'worker failed',
        mutate: (run) => { run.worker.state = 'failed'; }
      },
      {
        label: 'judgment failed',
        mutate: (run) => { run.judgment.verdict = 'failed'; }
      },
      {
        label: 'expected outcome not observed',
        mutate: (run) => {
          run.judgment.criteria.find((criterion) => {
            return criterion.kind === 'expected';
          }).state = 'not-observed';
        }
      },
      {
        label: 'prohibited outcome observed',
        mutate: (run) => {
          run.judgment.criteria.find((criterion) => {
            return criterion.kind === 'prohibited';
          }).state = 'observed';
        }
      }
    ]) {
      const guidedFindingEvidence = structuredClone(validEvidence);
      const guidedRun = guidedFindingEvidence.runs.find((run) => run.arm === 'guided');
      assert(guidedRun);
      mutate(guidedRun);
      guidedFindingEvidence.conclusion.prohibitedOutcomesObserved
        = guidedFindingEvidence.runs.some((run) => {
          return run.judgment.criteria.some((criterion) => {
            return criterion.kind === 'prohibited' && criterion.state === 'observed';
          });
        });
      writeEvidenceCase(guidedFindingEvidence);
      assert.notEqual(
        validateJsonSchema(readJson(evidenceFile), evidenceSchema).length,
        0,
        `guided ${label} must be schema-invalid`
      );
      assertCode(
        () => planDevelopmentWorkflowLifecycleFinalization({
          root: candidate,
          requestPath: requestFile
        }),
        'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID'
      );
    }
    writeCanonicalJson(evidenceFile, validEvidence);
    writeRequest(requestFile, request);

    const substitutedStimulusEvidence = structuredClone(validEvidence);
    substitutedStimulusEvidence.runs.find((run) => {
      return run.arm === 'guided';
    }).stimulusFingerprint = hash('substituted-stimulus');
    writeEvidenceCase(substitutedStimulusEvidence);
    assertCode(
      () => planDevelopmentWorkflowLifecycleFinalization({
        root: candidate,
        requestPath: requestFile
      }),
      'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID'
    );

    const substitutedCriterionEvidence = structuredClone(validEvidence);
    substitutedCriterionEvidence.runs.find((run) => {
      return run.arm === 'guided';
    }).judgment.criteria[0].id = 'substituted.expected.1';
    writeEvidenceCase(substitutedCriterionEvidence);
    assertCode(
      () => planDevelopmentWorkflowLifecycleFinalization({
        root: candidate,
        requestPath: requestFile
      }),
      'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID'
    );
    writeCanonicalJson(evidenceFile, validEvidence);
    writeRequest(requestFile, request);

    const substitutedArtifactEvidence = structuredClone(validEvidence);
    substitutedArtifactEvidence.artifacts.find((artifact) => {
      return artifact.role === 'development-request';
    }).fingerprint = hash('substituted-development-request');
    sign(substitutedArtifactEvidence, 'evidenceFingerprint');
    writeCanonicalJson(evidenceFile, substitutedArtifactEvidence);
    const substitutedArtifactRequest = structuredClone(request);
    substitutedArtifactRequest.active[0].evidence[0].fingerprint = fingerprintJson(substitutedArtifactEvidence);
    writeRequest(requestFile, substitutedArtifactRequest);
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID');
    writeCanonicalJson(evidenceFile, validEvidence);

    const wrongContainerEvidence = structuredClone(validEvidence);
    wrongContainerEvidence.runs = {};
    sign(wrongContainerEvidence, 'evidenceFingerprint');
    writeCanonicalJson(evidenceFile, wrongContainerEvidence);
    const wrongContainerRequest = structuredClone(request);
    wrongContainerRequest.active[0].evidence[0].fingerprint = fingerprintJson(wrongContainerEvidence);
    writeRequest(requestFile, wrongContainerRequest);
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID');
    writeCanonicalJson(evidenceFile, validEvidence);

    const incompleteRunsEvidence = structuredClone(validEvidence);
    incompleteRunsEvidence.runs.pop();
    sign(incompleteRunsEvidence, 'evidenceFingerprint');
    writeCanonicalJson(evidenceFile, incompleteRunsEvidence);
    const incompleteRunsRequest = structuredClone(request);
    incompleteRunsRequest.active[0].evidence[0].fingerprint = fingerprintJson(incompleteRunsEvidence);
    writeRequest(requestFile, incompleteRunsRequest);
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID');
    writeCanonicalJson(evidenceFile, validEvidence);

    const crossedHostEvidence = structuredClone(validEvidence);
    const otherHost = firstReference.host === 'claude' ? 'codex' : 'claude';
    crossedHostEvidence.host.adapter = `host.${otherHost}`;
    crossedHostEvidence.host.projectionDefinitionId = `host-projection.${otherHost}`;
    crossedHostEvidence.host.observer.id = `development-host-observer.${otherHost}`;
    crossedHostEvidence.host.candidateProjectionFingerprint = hash('crossed-host-projection');
    sign(crossedHostEvidence, 'evidenceFingerprint');
    writeCanonicalJson(evidenceFile, crossedHostEvidence);
    const crossedHostRequest = structuredClone(request);
    crossedHostRequest.active[0].evidence[0].fingerprint = fingerprintJson(crossedHostEvidence);
    writeRequest(requestFile, crossedHostRequest);
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID');
    writeCanonicalJson(evidenceFile, validEvidence);

    const credentialEvidence = structuredClone(validEvidence);
    credentialEvidence.limitations[0] = 'sk-private-sentinel';
    sign(credentialEvidence, 'evidenceFingerprint');
    writeCanonicalJson(evidenceFile, credentialEvidence);
    const credentialRequest = structuredClone(request);
    credentialRequest.active[0].evidence[0].fingerprint = fingerprintJson(credentialEvidence);
    writeRequest(requestFile, credentialRequest);
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID');
    writeCanonicalJson(evidenceFile, validEvidence);
    writeRequest(requestFile, request);

    const definitionPath = path.join(candidate, 'soter/automations/running-evals/definition.json');
    if (process.platform !== 'win32') {
      fs.chmodSync(definitionPath, 0o600);
      assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_SOURCE_INVALID');
      fs.chmodSync(definitionPath, 0o644);
    }

    const runningDirectory = path.dirname(definitionPath);
    const heldDirectory = runningDirectory + '-held';
    fs.renameSync(runningDirectory, heldDirectory);
    fs.symlinkSync(heldDirectory, runningDirectory, 'dir');
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_PATH_INVALID');
    fs.unlinkSync(runningDirectory);
    fs.renameSync(heldDirectory, runningDirectory);

    if (process.platform !== 'win32') {
      fs.chmodSync(requestFile, 0o644);
      assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_REQUEST_PATH_INVALID');
      fs.chmodSync(requestFile, 0o600);
    }
    assertCode(() => planDevelopmentWorkflowLifecycleFinalization({ root: candidate, requestPath: requestFile, unexpected: true }), 'DEVELOPMENT_WORKFLOW_FINALIZATION_ARGUMENTS_INVALID');

    process.stdout.write('Development workflow lifecycle finalization selftest passed.\n');
    return true;
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
    fs.rmSync(requestDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    selftestDevelopmentWorkflowLifecycleFinalization();
  } catch (error) {
    process.stderr.write((error.stack || String(error)) + '\n');
    process.exitCode = 1;
  }
}
