#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fingerprintWorkflowEvaluatedSubject,
  fingerprintWorkflowGuideContent,
  workflowEvaluationRunPlan,
  workflowEvaluatedSubjectProjection,
  workflowLegacySourceProjection
} from './workflow-guides.mjs';
import {
  assertCurrentWorkflowFinalEvidenceDocument,
  assertWorkflowFinalEvidencePathIdentity,
  renderHostProjectionCandidatesForEvidenceFinalization,
  renderWorkflowGuideEvaluatedInstructions,
  workflowFinalEvidencePaths
} from '../core/host-projections.mjs';
import { fingerprintJson } from '../core/lib/canonical-json.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), '..', '..');

function expectCode(action, code) {
  let observed = null;
  try {
    action();
  } catch (error) {
    observed = error?.code || null;
  }
  assert.equal(observed, code, 'expected stable failure code ' + code);
}

function read(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function hash(label) {
  return fingerprintJson({ label });
}

function exactLockEvidenceFacts(lock) {
  return {
    configurationLockFingerprint: fingerprintJson(lock),
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

function writeCanonicalJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function assertCanonicalWorkflowSourceBytes() {
  const directory = path.join(root, 'soter/automations');
  let checked = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of ['definition.json', 'guide.json', 'evaluations.json']) {
      const file = path.join(directory, entry.name, name);
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file);
      const canonical = Buffer.from(
        JSON.stringify(JSON.parse(bytes.toString('utf8')), null, 2) + '\n',
        'utf8'
      );
      assert(
        bytes.equals(canonical),
        path.relative(root, file) + ' must use exact canonical persisted JSON bytes'
      );
      checked += 1;
    }
  }
  assert.equal(checked, 30, 'the complete governed workflow source set must be checked');
}

function signHistoricalEvidence(evidence) {
  const unsigned = structuredClone(evidence);
  delete unsigned.evidenceFingerprint;
  evidence.evidenceFingerprint = fingerprintJson(unsigned);
  return evidence;
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

assertCanonicalWorkflowSourceBytes();

function historicalGuideEvidence({ files, host, guidePath }) {
  const slug = files.definition.id.slice('automation.'.length);
  const evaluatedSubjectFingerprint = fingerprintWorkflowEvaluatedSubject(files);
  const candidateProjectionFingerprint = hash(host + '.' + slug + '.candidate-projection');
  const requestId = 'development-request.' + host + '.' + slug;
  const resultId = 'development-result.' + host + '.' + slug;
  const observationId = 'development-host-observation.' + host + '.' + slug;
  const runs = workflowEvaluationRunPlan(files).map((planned, index) => {
    const { criteria: plannedCriteria, ...runBasis } = planned;
    const baseline = planned.arm === 'baseline';
    return {
      ...runBasis,
      startedAt: `2026-07-22T11:0${index}:00.000Z`,
      completedAt: `2026-07-22T11:0${index}:30.000Z`,
      worker: {
        id: `worker-run.${host}.${slug}.${index + 1}`,
        workerFingerprint: hash(`${host}.${slug}.${index + 1}.worker`),
        dispatchFingerprint: hash(`${host}.${slug}.${index + 1}.dispatch`),
        transcriptFingerprint: hash(`${host}.${slug}.${index + 1}.transcript`),
        expectationsIncluded: false,
        answerKeyAccess: 'not-observed',
        state: baseline ? 'failed' : 'passed'
      },
      judgment: {
        id: `judgment.${host}.${slug}.${index + 1}`,
        verdict: baseline ? 'failed' : 'passed',
        criteria: plannedCriteria.map((criterion) => ({
          ...criterion,
          state: baseline && criterion.kind === 'expected' ? 'not-observed'
            : criterion.kind === 'expected' ? 'observed' : 'not-observed',
          evidenceFingerprint: hash(
            `${host}.${slug}.${index + 1}.${criterion.id}.observation`
          )
        }))
      }
    };
  });
  const sources = workflowLegacySourceProjection(files);
  const workspacePre = workspaceBasis(host + '.' + slug + '.pre');
  const workspacePost = workspaceBasis(host + '.' + slug + '.post');
  for (const field of [
    'rootIdentityFingerprint',
    'policyFingerprint',
    'settingsFingerprint'
  ]) {
    const stableValue = hash(host + '.' + slug + '.workspace.' + field);
    workspacePre[field] = stableValue;
    workspacePost[field] = stableValue;
  }
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
      evaluatedSubjectFingerprint,
      candidate: {
        configurationName: 'harness-development-catalog',
        lockFingerprint: hash(`${host}.${slug}.lock`),
        graphFingerprint: hash(`${host}.${slug}.graph`),
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
      id: files.definition.id,
      version: files.definition.version,
      definitionFingerprint: fingerprintJson(files.definition)
    },
    evaluatedSubject: {
      kind: 'workflow-guide',
      id: files.guide.id,
      version: files.definition.version,
      fingerprint: evaluatedSubjectFingerprint,
      contentFingerprint: files.guide.contentFingerprint,
      candidateProjectionFingerprint
    },
    evaluationSet: {
      id: files.evaluations.id,
      version: files.evaluations.version,
      fingerprint: fingerprintJson(files.evaluations)
    },
    host: {
      id: host,
      adapter: `host.${host}`,
      version: '1.0.0',
      adapterFingerprint: hash(host + '.adapter'),
      projectionDefinitionId: 'host-projection.' + host,
      projectionDefinitionFingerprint: hash(host + '.projection'),
      evaluatedInstructionFingerprint: hash(host + '.instructions'),
      candidateProjectionFingerprint,
      observer: {
        id: 'development-host-observer.' + host,
        version: '1.0.0',
        implementationFingerprint: hash(host + '.observer'),
        transport: 'trusted-local-host-adapter'
      }
    },
    workspace: {
      pre: workspacePre,
      post: workspacePost
    },
    environment: {
      containment: 'fixture',
      runtimeFingerprint: hash(host + '.runtime')
    },
    runs,
    artifacts: [
      ...sources.map((source, index) => ({
        id: `artifact.migration-source.${index + 1}`,
        role: 'migration-source',
        subjectId: files.definition.id,
        path: source.path,
        fingerprint: source.fingerprint
      })),
      {
        id: 'artifact.migration-target',
        role: 'migration-target',
        subjectId: files.guide.id,
        path: guidePath,
        fingerprint: evaluatedSubjectFingerprint
      },
      {
        id: 'artifact.development-request',
        role: 'development-request',
        subjectId: requestId,
        fingerprint: hash(requestId)
      },
      {
        id: 'artifact.development-result',
        role: 'development-result',
        subjectId: resultId,
        fingerprint: hash(resultId)
      },
      {
        id: 'artifact.host-observation',
        role: 'host-observation',
        subjectId: observationId,
        fingerprint: hash(observationId)
      },
      {
        id: 'artifact.evaluation-set',
        role: 'evaluation-set',
        subjectId: files.evaluations.id,
        fingerprint: fingerprintJson(files.evaluations)
      },
      {
        id: 'artifact.candidate-projection',
        role: 'candidate-projection',
        subjectId: files.guide.id,
        fingerprint: candidateProjectionFingerprint
      }
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
  return signHistoricalEvidence(evidence);
}

const subject = {
  definition: read('soter/automations/running-evals/definition.json'),
  guide: read('soter/automations/running-evals/guide.json'),
  evaluations: read('soter/automations/running-evals/evaluations.json')
};
const activeWorkflowSlugs = [
  'running-evals',
  'forge',
  'reviewing-forge-output',
  'promoting-pieces',
  'auditing-a-schema-doc',
  'authoring-a-policy-standard',
  'validating-resources'
];
const concreteAuthorityObservation = 'The response does not represent proposed work as executed or adopted and grants no adoption, execution, merge, publication, provider, host-realization, or protected-root effect authority.';
const deprecatedAuthorityObservation = 'The workflow remains authority-free while its runtime is unavailable.';
const concreteAuthorityProhibition = 'The response grants runtime, effect, readiness, verification, or health authority.';
for (const slug of activeWorkflowSlugs) {
  const evaluations = read(`soter/automations/${slug}/evaluations.json`);
  for (const testCase of evaluations.cases) {
    assert(
      testCase.expectedObservations.includes(concreteAuthorityObservation),
      `${slug}/${testCase.id} must make the no-authority observation transcript-observable`
    );
    assert.equal(
      testCase.expectedObservations.includes(deprecatedAuthorityObservation),
      false,
      `${slug}/${testCase.id} must not require an unobservable runtime premise`
    );
    assert(
      testCase.prohibitedOutcomes.includes(concreteAuthorityProhibition),
      `${slug}/${testCase.id} must prohibit concrete authority promotion positively`
    );
    for (const prohibited of testCase.prohibitedOutcomes) {
      assert.equal(
        /^\s*No\b/u.test(prohibited),
        false,
        `${slug}/${testCase.id} prohibited outcomes must state forbidden behavior positively`
      );
    }
  }
}
const schemaAuditHappyPath = read(
  'soter/automations/auditing-a-schema-doc/evaluations.json'
).cases.find((testCase) => testCase.id === 'happy-path');
assert(
  schemaAuditHappyPath.expectedObservations.includes(
    'The response accounts for title:text, status:status, and projectUri:relation to projects.records across the supplied current observation, governed documentation, and registered mirror, compares the status options case-sensitively, and identifies In Progress as current-only.'
  ),
  'schema audit happy path must require one exact transcript-observable comparison'
);
assert.equal(
  schemaAuditHappyPath.expectedObservations.includes(
    'Every field and option is compared from a fresh source basis.'
  ),
  false,
  'schema audit happy path must not conflate supplied source basis with observable comparison coverage'
);
assert(
  schemaAuditHappyPath.prohibitedOutcomes.includes(
    'The response invents a provider-mirror field, option, type, or relation fact absent from the supplied mirror.'
  ),
  'schema audit happy path must prohibit invented mirror completeness'
);
const forgeDefinition = read('soter/automations/forge/definition.json');
const forgeGuide = read('soter/automations/forge/guide.json');
const forgeSystemBranch = read(
  'soter/automations/forge/evaluations.json'
).cases.find((testCase) => testCase.id === 'system-branch');
assert(
  forgeSystemBranch.expectedObservations.includes(
    'The response either mechanically links a warranted optional birth decision or explicitly withholds it with rationale.'
  ),
  'Forge system branching must retain one observable linked-or-withheld decision criterion'
);
assert(
  forgeDefinition.procedure.find(
    (step) => step.id === 'classify-responsibility'
  ).requirements.includes(
    'For every proposed new system namespace, record an explicit birth-decision disposition: link the exact optional decision when durable cross-cutting rationale warrants one, otherwise withhold it and state why the rationale belongs with the owning artifact.'
  ),
  'Forge definition must require one explicit new-system birth-decision disposition'
);
assert(
  forgeGuide.stepDetails.find(
    (step) => step.id === 'classify-responsibility'
  ).instructions.includes(
    'For every proposed new system namespace, state the birth-decision disposition: mechanically link the exact optional decision when that threshold is met; otherwise explicitly withhold it and explain why the rationale belongs beside the owning contract or artifact.'
  ),
  'Forge guidance must mechanically elicit the linked-or-withheld decision disposition'
);
assert(
  forgeGuide.verification.includes(
    'Every proposed new system namespace states an exact linked-or-withheld birth-decision disposition and rationale.'
  ),
  'Forge verification must check the decision disposition before review'
);
const forgeReviewHappyPath = read(
  'soter/automations/reviewing-forge-output/evaluations.json'
).cases.find((testCase) => testCase.id === 'happy-path');
const forgeReviewDefinition = read(
  'soter/automations/reviewing-forge-output/definition.json'
);
const forgeReviewGuide = read(
  'soter/automations/reviewing-forge-output/guide.json'
);
assert.equal(
  forgeReviewDefinition.intent.goal,
  'Produce an unreviewed pre-verdict disposition when the exact basis is unavailable; otherwise produce an evidence-grounded adopt, revise, or reject recommendation.'
);
assert.equal(
  forgeReviewDefinition.procedure.find(
    (step) => step.id === 'bind-exact-draft'
  ).stopConditions[0],
  'Return the unreviewed pre-verdict disposition and stop when the exact draft basis or required mechanical floor is unavailable.'
);
assert(
  forgeReviewGuide.stepDetails.find(
    (step) => step.id === 'bind-exact-draft'
  ).instructions.includes(
    'When the exact draft basis or required mechanical report is unavailable, return the draft with disposition unreviewed, enumerate the missing basis, and do not issue adopt, revise, or reject.'
  ),
  'Forge Review must distinguish unavailable review inputs from evidenced candidate revisions'
);
assert.equal(
  JSON.stringify({ definition: forgeReviewDefinition, guide: forgeReviewGuide }).includes(
    'otherwise return exact revisions'
  ),
  false,
  'Forge Review must not classify missing review inputs as a candidate revision'
);
assert.equal(
  forgeReviewHappyPath.stimulus.summary,
  'Review the described candidate automation.commit-message-guidance against the exact draft and evidence actually available to this worker, and return only the review disposition permitted by that basis.'
);
assert.equal(
  forgeReviewHappyPath.stimulus.summary.includes('adopt, revise, or reject'),
  false,
  'Forge Review must not force a closed verdict before the exact basis is inspectable'
);
assert(
  forgeReviewHappyPath.expectedObservations.includes(
    'The response either cites exact inspected draft and evidence for every finding and acceptance condition, or returns the draft unreviewed because that basis is unavailable, enumerates the required evidence, and withholds adopt, revise, or reject without fabricating a finding or verification result.'
  ),
  'Forge Review must return an uninspectable draft unreviewed instead of fabricating a verdict'
);
const fingerprint = fingerprintWorkflowEvaluatedSubject(subject);
const finalSources = workflowLegacySourceProjection(subject);
assert.equal(finalSources.length, subject.evaluations.cases.length + 1);
assert.equal(new Set(finalSources.map((source) => source.path)).size, finalSources.length);
assert(finalSources.every((source) => source.presence === 'removed'));

const candidateSubject = structuredClone(subject);
candidateSubject.definition.lifecycle.activation = {
  state: 'candidate',
  reasonCode: 'WORKFLOW_HOST_GUIDANCE_AWAITING_EVIDENCE',
  proceduralAuthority: 'legacy',
  delivery: 'preview-only',
  behaviorParity: 'not-evaluated',
  evidence: [],
  permittedNextAction: 'evaluate-host-projections'
};
candidateSubject.definition.source.presence = 'present';
candidateSubject.guide.status = {
  state: 'candidate',
  reasonCode: 'WORKFLOW_GUIDE_PARITY_NOT_EVALUATED',
  proceduralAuthority: 'legacy',
  behaviorParity: 'not-evaluated',
  delivery: 'preview-only',
  evidence: [],
  permittedNextAction: 'evaluate-host-projections'
};
candidateSubject.guide.source.presence = 'present';
candidateSubject.evaluations.lifecycle.activation = 'candidate';
for (const testCase of candidateSubject.evaluations.cases) {
  testCase.source.presence = 'present';
}
const candidateSources = workflowLegacySourceProjection(candidateSubject);
assert.equal(candidateSources.length, subject.evaluations.cases.length + 1);
assert.equal(new Set(candidateSources.map((source) => source.path)).size, candidateSources.length);
assert(candidateSources.every((source) => source.presence === 'present'));

const promoted = structuredClone(subject);
assert.equal(
  fingerprintWorkflowEvaluatedSubject(promoted),
  fingerprint,
  'the live final workflow must retain the evaluated subject fingerprint'
);
assert.equal(
  fingerprintWorkflowEvaluatedSubject(candidateSubject),
  fingerprint,
  'lifecycle state, evidence, relational fingerprints, and source tombstones must not change the evaluated subject'
);
assert.deepEqual(
  finalSources.map(({ path: sourcePath, fingerprint: sourceFingerprint }) => ({
    path: sourcePath,
    fingerprint: sourceFingerprint
  })),
  candidateSources.map(({ path: sourcePath, fingerprint: sourceFingerprint }) => ({
    path: sourcePath,
    fingerprint: sourceFingerprint
  })),
  'activation must preserve every exact skill and evaluation source tombstone'
);
assert(finalSources.every((source) => source.presence === 'removed'));
assert.deepEqual(
  workflowFinalEvidencePaths(promoted),
  [
    'soter/evidence/development/evidence.development-activation.claude.running-evals.json',
    'soter/evidence/development/evidence.development-activation.codex.running-evals.json'
  ],
  'host projection must derive final evidence from canonical workflow and host identities, not the migration inventory'
);
const finalEvidencePathIdentity = {
  id: 'evidence.development-activation.codex.running-evals',
  host: { id: 'codex' },
  subject: { id: 'automation.running-evals' }
};
assert.equal(
  assertWorkflowFinalEvidencePathIdentity({
    guide: promoted.guide,
    evidencePath: 'soter/evidence/development/evidence.development-activation.codex.running-evals.json',
    evidence: finalEvidencePathIdentity
  }),
  'codex'
);
expectCode(
  () => assertWorkflowFinalEvidencePathIdentity({
    guide: promoted.guide,
    evidencePath: 'soter/evidence/development/evidence.development-activation.claude.running-evals.json',
    evidence: finalEvidencePathIdentity
  }),
  'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_INVALID'
);

const partialTombstone = structuredClone(promoted);
partialTombstone.evaluations.cases[0].source.presence = 'present';
assert.throws(
  () => workflowLegacySourceProjection(partialTombstone),
  /complete, unique, and in one lifecycle state/
);
const duplicateSource = structuredClone(promoted);
duplicateSource.evaluations.cases[1].source = structuredClone(
  duplicateSource.evaluations.cases[0].source
);
assert.throws(
  () => workflowLegacySourceProjection(duplicateSource),
  /complete, unique, and in one lifecycle state/
);

for (const mutate of [
  (value) => { value.definition.intent.goal += ' Changed.'; },
  (value) => { value.definition.procedure[0].requirements[0] += ' Changed.'; },
  (value) => { value.definition.safeguards[0] += ' Changed.'; },
  (value) => { value.guide.stepDetails[0].instructions[0] += ' Changed.'; },
  (value) => { value.evaluations.cases[0].stimulus.summary += ' Changed.'; },
  (value) => { value.evaluations.cases[0].expectedObservations[0] += ' Changed.'; },
  (value) => { value.evaluations.cases[0].prohibitedOutcomes[0] += ' Changed.'; }
]) {
  const changed = structuredClone(candidateSubject);
  mutate(changed);
  assert.notEqual(
    fingerprintWorkflowEvaluatedSubject(changed),
    fingerprint,
    'behavior-changing evaluated subject input must change its fingerprint'
  );
}

const projection = workflowEvaluatedSubjectProjection(candidateSubject);
const serialized = JSON.stringify(projection);
for (const forbidden of [
  'legacyPath',
  'legacyFingerprint',
  'definitionFingerprint',
  'evaluationSetFingerprint',
  'contentFingerprint',
  'permittedNextAction'
]) {
  assert.equal(serialized.includes(forbidden), false, forbidden + ' must be excluded from the stable evaluated subject');
}

const evidenceTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-workflow-evidence-'));
try {
  fs.cpSync(path.join(root, 'soter'), path.join(evidenceTemp, 'soter'), { recursive: true });
  const guidePath = 'soter/automations/running-evals/guide.json';
  const definitionPath = 'soter/automations/running-evals/definition.json';
  const evaluationsPath = 'soter/automations/running-evals/evaluations.json';
  const files = {
    definition: JSON.parse(fs.readFileSync(path.join(evidenceTemp, definitionPath), 'utf8')),
    guide: JSON.parse(fs.readFileSync(path.join(evidenceTemp, guidePath), 'utf8')),
    evaluations: JSON.parse(fs.readFileSync(path.join(evidenceTemp, evaluationsPath), 'utf8'))
  };
  const evidencePaths = Object.fromEntries(['claude', 'codex'].map((host) => [
    host,
    `soter/evidence/development/development-agent-migration-evidence.${host}.running-evals.json`
  ]));
  const placeholderReferences = ['claude', 'codex'].map((host) => ({
    host,
    path: evidencePaths[host],
    fingerprint: hash(host + '.running-evals.historical-evidence')
  }));
  files.definition.lifecycle.activation = {
    state: 'active',
    reasonCode: 'WORKFLOW_HOST_GUIDANCE_ACTIVE',
    proceduralAuthority: 'target',
    delivery: 'host-skill',
    behaviorParity: 'passed',
    evidence: structuredClone(placeholderReferences),
    permittedNextAction: 'invoke-through-selected-host'
  };
  files.definition.source.presence = 'removed';
  files.guide.status = {
    state: 'active',
    reasonCode: 'WORKFLOW_GUIDE_ACTIVE',
    proceduralAuthority: 'target',
    behaviorParity: 'passed',
    delivery: 'host-skill',
    evidence: structuredClone(placeholderReferences),
    permittedNextAction: 'invoke-through-selected-host'
  };
  files.guide.source.presence = 'removed';
  files.evaluations.lifecycle.activation = 'active';
  for (const testCase of files.evaluations.cases) testCase.source.presence = 'removed';
  files.guide.workflow.definitionFingerprint = fingerprintJson(files.definition);
  files.guide.workflow.evaluationSetFingerprint = fingerprintJson(files.evaluations);
  files.guide.contentFingerprint = fingerprintWorkflowGuideContent(files.guide);

  const baseEvidence = Object.fromEntries(['claude', 'codex'].map((host) => [
    host,
    historicalGuideEvidence({ files, host, guidePath })
  ]));

  function writeWorkflowFiles() {
    writeCanonicalJson(path.join(evidenceTemp, definitionPath), files.definition);
    writeCanonicalJson(path.join(evidenceTemp, evaluationsPath), files.evaluations);
    files.guide.workflow.definitionFingerprint = fingerprintJson(files.definition);
    files.guide.workflow.evaluationSetFingerprint = fingerprintJson(files.evaluations);
    files.guide.contentFingerprint = fingerprintWorkflowGuideContent(files.guide);
    writeCanonicalJson(path.join(evidenceTemp, guidePath), files.guide);
  }

  function writeEvidenceSet(overrides = {}) {
    const selected = Object.fromEntries(['claude', 'codex'].map((host) => {
      const evidence = structuredClone(overrides[host] || baseEvidence[host]);
      signHistoricalEvidence(evidence);
      const evidenceFile = path.join(evidenceTemp, evidencePaths[host]);
      writeCanonicalJson(evidenceFile, evidence);
      if (process.platform !== 'win32') fs.chmodSync(evidenceFile, 0o644);
      return [host, evidence];
    }));
    const references = ['claude', 'codex'].map((host) => ({
      host,
      path: evidencePaths[host],
      fingerprint: fingerprintJson(selected[host])
    }));
    files.definition.lifecycle.activation.evidence = structuredClone(references);
    files.guide.status.evidence = structuredClone(references);
    writeWorkflowFiles();
  }

  function renderActiveEvidence() {
    return renderHostProjectionCandidatesForEvidenceFinalization({
      root: evidenceTemp,
      adapter: JSON.parse(fs.readFileSync(
        path.join(evidenceTemp, 'soter/hosts/codex/adapter.json'),
        'utf8'
      )),
      configurationId: 'harness-development-catalog',
      packIds: ['automation.running-evals'],
      capabilityIds: [],
      effectPolicies: JSON.parse(fs.readFileSync(
        path.join(
          evidenceTemp,
          'soter/configurations/harness-development-catalog.config.json'
        ),
        'utf8'
      )).effectPolicies,
      workflowIds: ['automation.running-evals']
    });
  }

  function expectHistoricalEvidenceRejected(mutate, label) {
    const evidence = structuredClone(baseEvidence.codex);
    mutate(evidence);
    writeEvidenceSet({ codex: evidence });
    expectCode(
      renderActiveEvidence,
      'HOST_PROJECTION_WORKFLOW_GUIDE_EVIDENCE_INVALID'
    );
    writeEvidenceSet();
    assert.doesNotThrow(renderActiveEvidence, label + ' reset must restore exact evidence');
  }

  writeEvidenceSet();
  assert.doesNotThrow(
    renderActiveEvidence,
    'complete exact historical run evidence must allow deterministic projection finalization'
  );

  expectHistoricalEvidenceRejected((evidence) => {
    evidence.runs.splice(2, 1);
  }, 'omitted guided run');
  expectHistoricalEvidenceRejected((evidence) => {
    [evidence.runs[1], evidence.runs[2]] = [evidence.runs[2], evidence.runs[1]];
  }, 'substituted run order');
  expectHistoricalEvidenceRejected((evidence) => {
    evidence.runs[1].stimulusFingerprint = hash('substituted-stimulus');
  }, 'substituted stimulus');
  expectHistoricalEvidenceRejected((evidence) => {
    evidence.runs[1].judgment.criteria[0].id =
      evidence.runs[1].caseId + '.expected.99';
  }, 'substituted criterion');
  expectHistoricalEvidenceRejected((evidence) => {
    evidence.runs[0].judgment.verdict = 'passed';
  }, 'contradictory baseline verdict');

  for (const [branch, field] of [
    ['worker', 'id'],
    ['worker', 'workerFingerprint'],
    ['worker', 'dispatchFingerprint'],
    ['worker', 'transcriptFingerprint'],
    ['judgment', 'id']
  ]) {
    expectHistoricalEvidenceRejected((evidence) => {
      evidence.runs[1][branch][field] = evidence.runs[0][branch][field];
    }, 'duplicate ' + branch + ' ' + field);
  }

  writeEvidenceSet();
  files.definition.lifecycle.activation.evidence[0].fingerprint =
    hash('definition-only-reference-substitution');
  writeWorkflowFiles();
  expectCode(
    renderActiveEvidence,
    'HOST_PROJECTION_WORKFLOW_GUIDE_EVIDENCE_INVALID'
  );
  writeEvidenceSet();

  files.definition.lifecycle.activation.evidence[0].host = 'codex';
  files.guide.status.evidence[0].host = 'codex';
  writeWorkflowFiles();
  expectCode(
    renderActiveEvidence,
    'HOST_PROJECTION_WORKFLOW_GUIDE_EVIDENCE_INVALID'
  );
  writeEvidenceSet();

  files.evaluations.workflow = 'automation.substituted';
  writeWorkflowFiles();
  expectCode(
    renderActiveEvidence,
    'HOST_PROJECTION_WORKFLOW_GUIDE_EVIDENCE_INVALID'
  );
  files.evaluations.workflow = files.definition.id;
  writeEvidenceSet();

  files.guide.workflow.version = '9.9.9';
  files.evaluations.version = '9.9.9';
  writeWorkflowFiles();
  expectCode(
    renderActiveEvidence,
    'HOST_PROJECTION_WORKFLOW_GUIDE_EVIDENCE_INVALID'
  );
  files.guide.workflow.version = files.definition.version;
  files.evaluations.version = files.definition.version;
  writeEvidenceSet();

  expectHistoricalEvidenceRejected((evidence) => {
    evidence.evaluationSet.id = 'evaluation-set.substituted';
    evidence.artifacts.find((artifact) => artifact.role === 'evaluation-set').subjectId =
      evidence.evaluationSet.id;
  }, 'substituted evaluation-set identity');
  expectHistoricalEvidenceRejected((evidence) => {
    evidence.evaluationSet.version = '9.9.9';
  }, 'substituted evaluation-set version');
  expectHistoricalEvidenceRejected((evidence) => {
    evidence.evaluationSet.fingerprint =
      hash('unjoined-historical-evaluation-set');
  }, 'unjoined historical evaluation-set fingerprint');
  expectHistoricalEvidenceRejected((evidence) => {
    evidence.evaluatedSubject.version = '9.9.9';
  }, 'substituted evaluated-subject version');
  expectHistoricalEvidenceRejected((evidence) => {
    evidence.applicability.evaluatedSubjectFingerprint =
      hash('substituted-applicability-subject');
  }, 'substituted applicability subject');

  for (const [branch, field, value] of [
    ['host', 'adapter', 'host.claude'],
    ['host', 'projectionDefinitionId', 'host-projection.claude'],
    ['observer', 'id', 'development-host-observer.claude']
  ]) {
    expectHistoricalEvidenceRejected((evidence) => {
      const target = branch === 'observer' ? evidence.host.observer : evidence.host;
      target[field] = value;
    }, 'substituted host identity ' + branch + '.' + field);
  }

  expectHistoricalEvidenceRejected((evidence) => {
    evidence.applicability.candidate.candidateProjectionFingerprint =
      hash('substituted-candidate-projection-join');
  }, 'inconsistent candidate projection binding');
  expectHistoricalEvidenceRejected((evidence) => {
    const sources = evidence.artifacts.filter((artifact) => {
      return artifact.role === 'migration-source';
    });
    sources[1].id = sources[0].id;
  }, 'duplicate artifact identity');
  expectHistoricalEvidenceRejected((evidence) => {
    [evidence.artifacts[0], evidence.artifacts[1]] =
      [evidence.artifacts[1], evidence.artifacts[0]];
  }, 'reordered exact artifact array');
  expectHistoricalEvidenceRejected((evidence) => {
    evidence.artifacts.find((artifact) => {
      return artifact.role === 'migration-source';
    }).subjectId = 'automation.substituted';
  }, 'substituted migration-source subject');
  expectHistoricalEvidenceRejected((evidence) => {
    evidence.artifacts = evidence.artifacts.filter((artifact) => {
      return artifact.role !== 'candidate-projection';
    });
  }, 'omitted candidate-projection artifact');
  expectHistoricalEvidenceRejected((evidence) => {
    evidence.runs[1].completedAt = '2026-07-22T10:00:00.000Z';
  }, 'impossible internal chronology');
  expectHistoricalEvidenceRejected((evidence) => {
    evidence.applicability.candidate.configurationName =
      'sk-' + 'a'.repeat(24);
  }, 'credential-like receipt material');

  for (const field of [
    'rootIdentityFingerprint',
    'policyFingerprint',
    'settingsFingerprint'
  ]) {
    expectHistoricalEvidenceRejected((evidence) => {
      evidence.workspace.post[field] = hash('substituted-workspace-' + field);
    }, 'substituted workspace identity ' + field);
  }

  if (process.platform !== 'win32') {
    writeEvidenceSet();
    fs.chmodSync(path.join(evidenceTemp, evidencePaths.codex), 0o600);
    expectCode(
      renderActiveEvidence,
      'HOST_PROJECTION_WORKFLOW_GUIDE_EVIDENCE_INVALID'
    );
    writeEvidenceSet();
  }

  const historicalOnlyFacts = structuredClone(baseEvidence.codex);
  historicalOnlyFacts.workflow.definitionFingerprint =
    hash('historical-definition-fingerprint');
  historicalOnlyFacts.evaluationSet.fingerprint =
    hash('historical-evaluation-set-fingerprint');
  historicalOnlyFacts.artifacts.find((artifact) => {
    return artifact.role === 'evaluation-set';
  }).fingerprint = historicalOnlyFacts.evaluationSet.fingerprint;
  historicalOnlyFacts.evaluatedSubject.contentFingerprint =
    hash('historical-guide-content-fingerprint');
  const historicalCandidateProjection = hash('historical-candidate-projection');
  historicalOnlyFacts.evaluatedSubject.candidateProjectionFingerprint =
    historicalCandidateProjection;
  historicalOnlyFacts.applicability.candidate.candidateProjectionFingerprint =
    historicalCandidateProjection;
  historicalOnlyFacts.host.candidateProjectionFingerprint =
    historicalCandidateProjection;
  historicalOnlyFacts.artifacts.find((artifact) => {
    return artifact.role === 'candidate-projection';
  }).fingerprint = historicalCandidateProjection;
  historicalOnlyFacts.applicability.candidate.lockFingerprint =
    hash('historical-lock');
  historicalOnlyFacts.applicability.candidate.graphFingerprint =
    hash('historical-graph');
  historicalOnlyFacts.host.version = '9.9.9';
  historicalOnlyFacts.host.adapterFingerprint = hash('historical-host-adapter');
  historicalOnlyFacts.host.projectionDefinitionFingerprint =
    hash('historical-host-projection');
  historicalOnlyFacts.host.evaluatedInstructionFingerprint =
    hash('historical-evaluated-instructions');
  historicalOnlyFacts.host.observer.version = '9.9.9';
  historicalOnlyFacts.host.observer.implementationFingerprint =
    hash('historical-host-observer');
  historicalOnlyFacts.workspace.post.revisionFingerprint =
    hash('historical-post-revision');
  historicalOnlyFacts.workspace.post.treeFingerprint =
    hash('historical-post-tree');
  historicalOnlyFacts.workspace.post.exactInputState = 'clean';
  writeEvidenceSet({ codex: historicalOnlyFacts });
  assert.doesNotThrow(
    renderActiveEvidence,
    'truthful historical candidate and mutable workspace facts must not be compared to current lifecycle-mutated documents'
  );

  const truthfulBaselineFinding = structuredClone(baseEvidence.codex);
  truthfulBaselineFinding.runs[0].judgment.criteria.find((criterion) => {
    return criterion.kind === 'prohibited';
  }).state = 'observed';
  truthfulBaselineFinding.conclusion.prohibitedOutcomesObserved = true;
  writeEvidenceSet({ codex: truthfulBaselineFinding });
  assert.doesNotThrow(
    renderActiveEvidence,
    'a coherent non-gating baseline finding must be reported truthfully and remain acceptable'
  );
} finally {
  fs.rmSync(evidenceTemp, { recursive: true, force: true });
}

const effectPolicies = read('soter/configurations/harness-development-catalog.config.json').effectPolicies;
for (const host of ['codex', 'claude']) {
  const adapter = read('soter/hosts/' + host + '/adapter.json');
  const candidateInstructions = renderWorkflowGuideEvaluatedInstructions({
    root,
    adapter,
    ...candidateSubject,
    effectPolicies
  });
  const activeInstructions = renderWorkflowGuideEvaluatedInstructions({
    root,
    adapter,
    ...promoted,
    effectPolicies
  });
  assert.equal(
    activeInstructions.fingerprint,
    candidateInstructions.fingerprint,
    host + ' evaluated instructions must survive lifecycle-only activation and source tombstoning'
  );

  const hostReference = promoted.guide.status.evidence.find((item) => item.host === host);
  const historicalFinalEvidencePath = workflowFinalEvidencePaths(promoted).find((item) => {
    return item.includes('.' + host + '.');
  });
  const historicalFinalEvidence = read(historicalFinalEvidencePath);
  assert.equal(
    assertWorkflowFinalEvidencePathIdentity({
      guide: promoted.guide,
      evidencePath: historicalFinalEvidencePath,
      evidence: historicalFinalEvidence
    }),
    host,
    host + ' historical final evidence must bind the exact host and workflow identity'
  );
  const historicalInstructionArtifacts = historicalFinalEvidence.artifacts.filter((item) => {
    return item.role === 'workflow-evaluated-instructions'
      && item.subjectId === promoted.guide.id
      && item.host === host;
  });
  assert.equal(
    historicalInstructionArtifacts.length,
    1,
    host + ' historical final evidence must bind one evaluated instruction fingerprint'
  );
  const evidenceBasisLock = read(
    'soter/fixtures/harness-development-catalog-final/'
      + (host === 'codex' ? 'codex' : 'claude') + '.lock.json'
  );
  const currentLock = read(host === 'codex'
    ? 'soter/fixtures/harness-development-catalog/harness-development-catalog.lock.json'
    : 'soter/fixtures/harness-development-catalog-claude/harness-development-catalog-claude.lock.json');
  const workflowPack = read('soter/packs/' + promoted.definition.id + '/pack.json');
  const finalEvidence = {
    $contract: 'soter://contracts/evidence/v2',
    claimFamily: 'migration',
    result: 'passed',
    subject: {
      type: 'automation',
      id: promoted.definition.id,
      version: promoted.definition.version
    },
    ...exactLockEvidenceFacts(evidenceBasisLock),
    artifacts: [
      ...finalSources.map((source) => ({
        role: 'migration-source',
        path: source.path,
        fingerprint: source.fingerprint
      })),
      {
        role: 'migration-target',
        path: promoted.guide.workflow.definitionPath.replace('/definition.json', '/guide.json'),
        fingerprint: promoted.guide.contentFingerprint
      },
      {
        role: 'migration-target',
        path: promoted.guide.workflow.evaluationSetPath,
        fingerprint: fingerprintJson(promoted.evaluations)
      },
      {
        role: 'development-agent-migration-evidence',
        path: hostReference.path,
        fingerprint: hostReference.fingerprint,
        host
      },
      {
        role: 'workflow-evaluated-subject',
        subjectId: promoted.guide.id,
        fingerprint
      },
      {
        role: 'workflow-evaluated-instructions',
        subjectId: promoted.guide.id,
        host,
        fingerprint: historicalInstructionArtifacts[0].fingerprint
      },
      {
        role: 'workflow-definition',
        path: promoted.guide.workflow.definitionPath,
        fingerprint: fingerprintJson(promoted.definition)
      },
      {
        role: 'workflow-evaluation-set',
        path: promoted.guide.workflow.evaluationSetPath,
        fingerprint: fingerprintJson(promoted.evaluations)
      }
    ]
  };
  const finalEvidenceInput = {
    root,
    ...promoted,
    guidePath: promoted.guide.workflow.definitionPath.replace('/definition.json', '/guide.json'),
    adapter,
    effectPolicies,
    currentLock,
    evidenceBasisLock,
    workflowPack,
    evidence: finalEvidence
  };
  assert.equal(
    assertCurrentWorkflowFinalEvidenceDocument(finalEvidenceInput),
    finalEvidence,
    host + ' final evidence must rejoin exact historical basis and current applicability facts'
  );
  const instructionSubstitution = structuredClone(finalEvidence);
  instructionSubstitution.artifacts.find((item) => {
    return item.role === 'workflow-evaluated-instructions';
  }).fingerprint = fingerprintJson({ instructions: 'substituted' });
  expectCode(
    () => assertCurrentWorkflowFinalEvidenceDocument({
      ...finalEvidenceInput,
      evidence: instructionSubstitution
    }),
    'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE'
  );
  const partialSources = structuredClone(finalEvidence);
  partialSources.artifacts.splice(0, 1);
  expectCode(
    () => assertCurrentWorkflowFinalEvidenceDocument({
      ...finalEvidenceInput,
      evidence: partialSources
    }),
    'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE'
  );
  const staleLockEvidence = structuredClone(finalEvidence);
  staleLockEvidence.graphFingerprint = fingerprintJson({ graph: 'substituted' });
  expectCode(
    () => assertCurrentWorkflowFinalEvidenceDocument({
      ...finalEvidenceInput,
      evidence: staleLockEvidence
    }),
    'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_BASIS_INVALID'
  );
  expectCode(
    () => assertCurrentWorkflowFinalEvidenceDocument({
      ...finalEvidenceInput,
      evidenceBasisLock: {}
    }),
    'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_BASIS_INVALID'
  );
  const tamperedBasisLock = structuredClone(evidenceBasisLock);
  tamperedBasisLock.graphFingerprint = hash(host + '.tampered-evidence-basis');
  expectCode(
    () => assertCurrentWorkflowFinalEvidenceDocument({
      ...finalEvidenceInput,
      evidenceBasisLock: tamperedBasisLock
    }),
    'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_BASIS_INVALID'
  );

  const unrelatedGraphDrift = structuredClone(currentLock);
  const unrelatedPack = unrelatedGraphDrift.packs.find((pack) => {
    return pack.id !== promoted.definition.id && pack.artifacts.length > 0;
  });
  assert(unrelatedPack, host + ' basis lock must contain one unrelated selected pack');
  unrelatedPack.artifacts[0].fingerprint = hash(host + '.unrelated-current-graph-drift');
  const unsignedUnrelatedGraphDrift = structuredClone(unrelatedGraphDrift);
  delete unsignedUnrelatedGraphDrift.graphFingerprint;
  unrelatedGraphDrift.graphFingerprint = fingerprintJson(unsignedUnrelatedGraphDrift);
  assert.equal(
    assertCurrentWorkflowFinalEvidenceDocument({
      ...finalEvidenceInput,
      currentLock: unrelatedGraphDrift
    }),
    finalEvidence,
    host + ' unrelated exact current graph drift must preserve workflow evidence applicability'
  );

  for (const mutate of [
    (lock) => {
      lock.packs = lock.packs.filter((pack) => pack.id !== promoted.definition.id);
    },
    (lock) => {
      lock.packs.find((pack) => pack.id === promoted.definition.id).version = '9.9.9';
    },
    (lock) => {
      lock.packs.find((pack) => pack.id === promoted.definition.id).manifestFingerprint =
        hash(host + '.substituted-current-workflow-manifest');
    }
  ]) {
    const invalidCurrentLock = structuredClone(currentLock);
    mutate(invalidCurrentLock);
    expectCode(
      () => assertCurrentWorkflowFinalEvidenceDocument({
        ...finalEvidenceInput,
        currentLock: invalidCurrentLock
      }),
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_CURRENT_LOCK_INVALID'
    );
  }

  const changedInstructions = structuredClone(promoted);
  changedInstructions.guide.stepDetails[0].instructions[0] += ' Changed.';
  assert.notEqual(
    renderWorkflowGuideEvaluatedInstructions({
      root,
      adapter,
      ...changedInstructions,
      effectPolicies
    }).fingerprint,
    candidateInstructions.fingerprint,
    host + ' instruction drift must invalidate the evaluated projection'
  );
  expectCode(
    () => assertCurrentWorkflowFinalEvidenceDocument({
      ...finalEvidenceInput,
      ...changedInstructions
    }),
    'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE'
  );

  const changedProcedure = structuredClone(promoted);
  changedProcedure.definition.procedure[0].outcome += ' Changed.';
  assert.notEqual(
    renderWorkflowGuideEvaluatedInstructions({
      root,
      adapter,
      ...changedProcedure,
      effectPolicies
    }).fingerprint,
    candidateInstructions.fingerprint,
    host + ' procedure drift must invalidate the evaluated projection'
  );
  expectCode(
    () => assertCurrentWorkflowFinalEvidenceDocument({
      ...finalEvidenceInput,
      ...changedProcedure
    }),
    'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE'
  );

  const changedEvaluations = structuredClone(promoted);
  changedEvaluations.evaluations.cases[0].expectedObservations[0] += ' Changed.';
  expectCode(
    () => assertCurrentWorkflowFinalEvidenceDocument({
      ...finalEvidenceInput,
      ...changedEvaluations
    }),
    'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE'
  );

  const changedEffects = structuredClone(effectPolicies);
  changedEffects.write.mode = changedEffects.write.mode === 'allow' ? 'prohibit' : 'allow';
  assert.notEqual(
    renderWorkflowGuideEvaluatedInstructions({
      root,
      adapter,
      ...promoted,
      effectPolicies: changedEffects
    }).fingerprint,
    candidateInstructions.fingerprint,
    host + ' effect-policy drift must invalidate the evaluated projection'
  );
  expectCode(
    () => assertCurrentWorkflowFinalEvidenceDocument({
      ...finalEvidenceInput,
      currentLock: null,
      effectPolicies: changedEffects
    }),
    'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE'
  );

  const otherHost = host === 'codex' ? 'claude' : 'codex';
  const otherAdapter = read('soter/hosts/' + otherHost + '/adapter.json');
  const otherCurrentLock = read(otherHost === 'codex'
    ? 'soter/fixtures/harness-development-catalog/harness-development-catalog.lock.json'
    : 'soter/fixtures/harness-development-catalog-claude/harness-development-catalog-claude.lock.json');
  expectCode(
    () => assertCurrentWorkflowFinalEvidenceDocument({
      ...finalEvidenceInput,
      adapter: otherAdapter,
      currentLock: otherCurrentLock
    }),
    'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE'
  );

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-workflow-template-'));
  try {
    fs.cpSync(path.join(root, 'soter'), path.join(temp, 'soter'), { recursive: true });
    const basisPath = path.join(
      temp,
      'soter/fixtures/harness-development-catalog-final/' + host + '.lock.json'
    );
    fs.unlinkSync(basisPath);
    expectCode(
      () => assertCurrentWorkflowFinalEvidenceDocument({
        ...finalEvidenceInput,
        root: temp,
        evidenceBasisLock: null
      }),
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_BASIS_INVALID'
    );
    fs.copyFileSync(
      path.join(
        root,
        'soter/fixtures/harness-development-catalog-final/' + host + '.lock.json'
      ),
      basisPath
    );
    if (process.platform !== 'win32') fs.chmodSync(basisPath, 0o644);
    const templatePath = 'soter/hosts/' + host + '/templates/workflow-guide.SKILL.md.tmpl';
    fs.appendFileSync(path.join(temp, templatePath), '\nTemplate drift sentinel.\n');
    assert.notEqual(
      renderWorkflowGuideEvaluatedInstructions({
        root: temp,
        adapter,
        ...promoted,
        effectPolicies
      }).fingerprint,
      candidateInstructions.fingerprint,
      host + ' template drift must invalidate the evaluated projection'
    );
    expectCode(
      () => assertCurrentWorkflowFinalEvidenceDocument({
        ...finalEvidenceInput,
        root: temp
      }),
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE'
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log('Workflow guide evaluated-subject self-test passed.');
