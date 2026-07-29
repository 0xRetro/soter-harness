import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintWorkflowEvaluatedSubject,
  fingerprintWorkflowGuideContent,
  inspectWorkflowEvaluationRunSet,
  workflowLegacySourceProjection
} from '../kernel/workflow-guides.mjs';
import {
  fingerprintFile,
  fingerprintJson,
  readJson,
  resolveRepoPath,
  sha256
} from './lib/canonical-json.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';

const REQUEST_CONTRACT = 'soter://private/development-workflow-lifecycle-finalization/v1';
const REQUEST_ID = /^development-workflow-lifecycle-finalization[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const WORKFLOW_ID = /^automation[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const HISTORICAL_PATH = /^soter\/evidence\/development\/development-agent-migration-evidence[.][a-z0-9]+(?:[.-][a-z0-9]+)*[.]json$/;
const ACTIVE_WORKFLOWS = Object.freeze([
  'automation.auditing-a-schema-doc',
  'automation.authoring-a-policy-standard',
  'automation.forge',
  'automation.promoting-pieces',
  'automation.reviewing-forge-output',
  'automation.running-evals',
  'automation.validating-resources'
]);
const RETIRED_WORKFLOWS = Object.freeze([
  'automation.pushing-to-notion',
  'automation.updating-a-notion-page',
  'automation.writing-adrs'
]);
const SCHEMAS = Object.freeze({
  definition: 'soter/contracts/workflow-definition.schema.json',
  guide: 'soter/contracts/workflow-guide.schema.json',
  evaluations: 'soter/contracts/workflow-evaluation-set.schema.json',
  historicalEvidence: 'soter/contracts/development-agent-migration-evidence.schema.json'
});

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  throw error;
}

function same(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && same(Object.keys(value).sort(compareCodepoint), [...keys].sort(compareCodepoint));
}

function requestFingerprint(request) {
  const unsigned = structuredClone(request);
  delete unsigned.requestFingerprint;
  return fingerprintJson(unsigned);
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function isExactInstant(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertInstant(value) {
  if (!isExactInstant(value)) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_REQUEST_INVALID',
      'Workflow lifecycle finalization createdAt must be one valid instant.'
    );
  }
}

function rootIdentityFingerprint(root) {
  return fingerprintJson({ root: fs.realpathSync(path.resolve(root)) });
}

function confinedPath(root, relativePath, { mustExist = true, kind = 'file' } = {}) {
  if (typeof relativePath !== 'string'
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath === '.'
    || relativePath.startsWith('../')
    || relativePath.includes('/../')) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_PATH_INVALID',
      'Workflow lifecycle path is not one normalized repository-relative path.'
    );
  }
  const realRoot = fs.realpathSync(path.resolve(root));
  const target = resolveRepoPath(realRoot, relativePath);
  const parts = relativePath.split('/');
  let current = realRoot;
  const parentParts = kind === 'directory' ? parts : parts.slice(0, -1);
  for (const part of parentParts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (!mustExist && error?.code === 'ENOENT') return target;
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_PATH_INVALID',
        'Workflow lifecycle path parent is unavailable.',
        error
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_PATH_INVALID',
        'Workflow lifecycle path crosses a symlink or non-directory parent.'
      );
    }
  }
  if (mustExist) {
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      fail('DEVELOPMENT_WORKFLOW_FINALIZATION_PATH_INVALID', 'Workflow lifecycle path is unavailable.', error);
    }
    if (kind === 'file' && (!stat.isFile() || stat.isSymbolicLink()
      || fs.realpathSync(target) !== target)) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_PATH_INVALID',
        'Workflow lifecycle path is not one exact real regular file.'
      );
    }
  }
  return target;
}

function assertPrivateExternalFile(root, requestedPath) {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_REQUEST_PATH_INVALID',
      'Workflow lifecycle finalization request must be one absolute private path outside the repository.'
    );
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  let stat;
  let real;
  try {
    stat = fs.lstatSync(requestedPath);
    real = fs.realpathSync(requestedPath);
  } catch (error) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_REQUEST_PATH_INVALID',
      'Workflow lifecycle finalization request is unavailable.',
      error
    );
  }
  if (real === resolvedRoot || real.startsWith(resolvedRoot + path.sep)
    || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_REQUEST_PATH_INVALID',
      'Workflow lifecycle finalization request must be one non-linked external private file with mode 0600.'
    );
  }
  const bytes = fs.readFileSync(requestedPath);
  let request;
  try {
    request = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_REQUEST_INVALID',
      'Workflow lifecycle finalization request is not valid JSON.',
      error
    );
  }
  if (!bytes.equals(canonicalBytes(request))) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_REQUEST_INVALID',
      'Workflow lifecycle finalization request must contain exact canonical JSON bytes.'
    );
  }
  return request;
}

function assertEvidenceChronology(evidence, requestCreatedAt) {
  const instants = [
    evidence.createdAt,
    evidence.sourceObservation?.observedAt,
    evidence.request?.createdAt,
    evidence.result?.createdAt,
    evidence.result?.completedAt,
    ...((evidence.runs || []).flatMap((run) => [run.startedAt, run.completedAt]))
  ];
  if (instants.some((instant) => !isExactInstant(instant))) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID',
      'Historical host receipt contains a non-canonical or invalid instant.'
    );
  }
  const requestAt = Date.parse(evidence.request.createdAt);
  const resultCreatedAt = Date.parse(evidence.result.createdAt);
  const resultCompletedAt = Date.parse(evidence.result.completedAt);
  const observedAt = Date.parse(evidence.sourceObservation.observedAt);
  const evidenceAt = Date.parse(evidence.createdAt);
  if (resultCreatedAt < requestAt
    || resultCompletedAt < resultCreatedAt
    || observedAt < resultCompletedAt
    || evidenceAt !== observedAt
    || evidenceAt > Date.parse(requestCreatedAt)
    || evidence.runs.some((run) => {
      const startedAt = Date.parse(run.startedAt);
      const completedAt = Date.parse(run.completedAt);
      return startedAt < requestAt || completedAt < startedAt || completedAt > resultCompletedAt;
    })) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID',
      'Historical host receipt chronology is impossible or exceeds the lifecycle request.'
    );
  }
}

function assertHistoricalReference(root, workflowId, reference, {
  basis,
  files,
  sources,
  evaluatedSubjectFingerprint,
  requestCreatedAt
}) {
  if (!exactKeys(reference, ['path', 'fingerprint', 'host'])
    || !HISTORICAL_PATH.test(reference.path || '')
    || !HASH.test(reference.fingerprint || '')
    || !['codex', 'claude'].includes(reference.host)) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID',
      'Active workflow evidence reference is not one exact historical host receipt.'
    );
  }
  const file = confinedPath(root, reference.path);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID',
      'Historical host receipt is unavailable: ' + reference.path,
      error
    );
  }
  let evidence;
  try {
    evidence = readJson(file);
  } catch (error) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID',
      'Historical host receipt is not valid canonical JSON.',
      error
    );
  }
  const schemaFailures = validateJsonSchema(
    evidence,
    readJson(confinedPath(root, SCHEMAS.historicalEvidence))
  );
  if (schemaFailures.length) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID',
      'Historical host receipt violates its closed governed schema.'
    );
  }
  const unsignedEvidence = structuredClone(evidence);
  delete unsignedEvidence.evidenceFingerprint;
  const migrationSources = (evidence.artifacts || []).filter((artifact) => {
    return artifact.role === 'migration-source';
  }).map(({ path: sourcePath, fingerprint }) => ({
    path: sourcePath,
    fingerprint
  })).sort((left, right) => compareCodepoint(left.path, right.path));
  const exactSources = sources.map(({ path: sourcePath, fingerprint }) => ({
    path: sourcePath,
    fingerprint
  })).sort((left, right) => compareCodepoint(left.path, right.path));
  const exactArtifacts = [
    ...exactSources.map((source, index) => ({
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
      fingerprint: evaluatedSubjectFingerprint
    },
    {
      id: 'artifact.development-request',
      role: 'development-request',
      subjectId: evidence.request?.id,
      fingerprint: evidence.request?.fingerprint
    },
    {
      id: 'artifact.development-result',
      role: 'development-result',
      subjectId: evidence.result?.id,
      fingerprint: evidence.result?.fingerprint
    },
    {
      id: 'artifact.host-observation',
      role: 'host-observation',
      subjectId: evidence.sourceObservation?.id,
      fingerprint: evidence.sourceObservation?.fingerprint
    },
    {
      id: 'artifact.evaluation-set',
      role: 'evaluation-set',
      subjectId: files.evaluations.id,
      fingerprint: basis.evaluationSetFingerprint
    },
    {
      id: 'artifact.candidate-projection',
      role: 'candidate-projection',
      subjectId: files.guide.id,
      fingerprint: evidence.evaluatedSubject?.candidateProjectionFingerprint
    }
  ];
  const evidenceCreatedAt = Date.parse(evidence.createdAt);
  const requestAt = Date.parse(requestCreatedAt);
  const runInspection = inspectWorkflowEvaluationRunSet({
    definition: files.definition,
    evaluations: files.evaluations,
    runs: evidence.runs
  });
  assertEvidenceChronology(evidence, requestCreatedAt);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o644)
    || fingerprintJson(evidence) !== reference.fingerprint
    || evidence.evidenceFingerprint !== fingerprintJson(unsignedEvidence)
    || containsCredentialMaterial(JSON.stringify(evidence))
    || evidence.$contract !== 'soter://contracts/development-agent-migration-evidence/v1'
    || evidence.workflow?.id !== workflowId
    || evidence.workflow?.version !== files.definition.version
    || evidence.workflow?.definitionFingerprint !== basis.definitionFingerprint
    || evidence.evaluationSet?.id !== files.evaluations.id
    || evidence.evaluationSet?.version !== files.evaluations.version
    || evidence.evaluationSet?.fingerprint !== basis.evaluationSetFingerprint
    || evidence.evaluatedSubject?.id !== files.guide.id
    || evidence.evaluatedSubject?.version !== files.definition.version
    || evidence.evaluatedSubject?.fingerprint !== evaluatedSubjectFingerprint
    || evidence.evaluatedSubject?.contentFingerprint !== files.guide.contentFingerprint
    || evidence.applicability?.evaluatedSubjectFingerprint !== evaluatedSubjectFingerprint
    || evidence.applicability?.candidate?.candidateProjectionFingerprint
      !== evidence.evaluatedSubject?.candidateProjectionFingerprint
    || evidence.host?.id !== reference.host
    || evidence.host?.adapter !== `host.${reference.host}`
    || evidence.host?.projectionDefinitionId !== `host-projection.${reference.host}`
    || evidence.host?.observer?.id !== `development-host-observer.${reference.host}`
    || evidence.host?.candidateProjectionFingerprint
      !== evidence.evaluatedSubject?.candidateProjectionFingerprint
    || evidence.applicability?.kind !== 'historical-candidate-only'
    || evidence.applicability?.activation !== 'not-granted'
    || evidence.applicability?.fallbackRemoval !== 'not-granted'
    || evidence.conclusion?.state !== 'passed'
    || evidence.conclusion?.guidedRunsPassed !== true
    || evidence.conclusion?.prohibitedOutcomesObserved
      !== runInspection.prohibitedOutcomesObserved
    || evidence.conclusion?.externalEffectsObserved !== false
    || runInspection.coverageComplete !== true
    || runInspection.verdictsConsistent !== true
    || runInspection.guidedPassed !== true
    || runInspection.inputBoundaryPreserved !== true
    || !same(evidence.artifacts, exactArtifacts)
    || new Set((evidence.artifacts || []).map((artifact) => artifact.id)).size
      !== (evidence.artifacts || []).length
    || !same(migrationSources, exactSources)
    || !isExactInstant(evidence.createdAt)
    || !Number.isFinite(evidenceCreatedAt)
    || evidenceCreatedAt > requestAt) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID',
      'Historical host receipt is unsafe, drifted, or does not bind the exact workflow and host.'
    );
  }
  return evidence;
}

function assertRequest(root, request) {
  if (!exactKeys(request, [
    '$contract',
    'contractVersion',
    'id',
    'requestFingerprint',
    'rootIdentityFingerprint',
    'createdAt',
    'active',
    'retired'
  ])
    || request.$contract !== REQUEST_CONTRACT
    || request.contractVersion !== '1.0.0'
    || !REQUEST_ID.test(request.id || '')
    || !HASH.test(request.requestFingerprint || '')
    || request.rootIdentityFingerprint !== rootIdentityFingerprint(root)
    || request.requestFingerprint !== requestFingerprint(request)) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_REQUEST_INVALID',
      'Workflow lifecycle finalization request identity, shape, or fingerprint is invalid.'
    );
  }
  assertInstant(request.createdAt);
  if (!Array.isArray(request.active) || request.active.length !== ACTIVE_WORKFLOWS.length
    || !Array.isArray(request.retired) || request.retired.length !== RETIRED_WORKFLOWS.length) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_WORKFLOW_SET_INVALID',
      'Workflow lifecycle finalization requires the exact seven active and three retired workflows.'
    );
  }
  const activeIds = [];
  for (const row of request.active) {
    if (!exactKeys(row, ['id', 'basis', 'evidence'])
      || !WORKFLOW_ID.test(row.id || '')
      || !exactKeys(row.basis, [
        'definitionFingerprint',
        'guideFingerprint',
        'evaluationSetFingerprint',
        'evaluatedSubjectFingerprint'
      ])
      || Object.values(row.basis).some((value) => !HASH.test(value || ''))
      || !Array.isArray(row.evidence)
      || row.evidence.length !== 2) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_WORKFLOW_SET_INVALID',
        'Each active workflow must bind exactly two historical host receipts.'
      );
    }
    const references = row.evidence;
    if (!same(references.map((reference) => reference.host), ['claude', 'codex'])) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID',
        'Active workflow evidence must contain one exact Codex and one exact Claude receipt.'
      );
    }
    const files = readWorkflowFiles(root, row.id);
    files.root = root;
    const sources = assertCandidateWorkflow(files, 'active');
    const evaluatedSubjectFingerprint = fingerprintWorkflowEvaluatedSubject(files);
    if (row.basis.definitionFingerprint !== fingerprintJson(files.definition)
      || row.basis.guideFingerprint !== fingerprintJson(files.guide)
      || row.basis.evaluationSetFingerprint !== fingerprintJson(files.evaluations)
      || row.basis.evaluatedSubjectFingerprint !== evaluatedSubjectFingerprint) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_BASIS_INVALID',
        'Active workflow request basis does not match the exact current candidate documents.'
      );
    }
    for (const reference of references) assertHistoricalReference(root, row.id, reference, {
      basis: row.basis,
      files,
      sources,
      evaluatedSubjectFingerprint,
      requestCreatedAt: request.createdAt
    });
    activeIds.push(row.id);
  }
  const retiredIds = [];
  const retirementPaths = new Set();
  for (const row of request.retired) {
    const slug = row.id?.slice('automation.'.length);
    const exactRetirementPath =
      `soter/fixtures/harness-development-catalog/${slug}.intentional-retirement.evidence.json`;
    if (!exactKeys(row, ['id', 'basis', 'evidence'])
      || !WORKFLOW_ID.test(row.id || '')
      || !exactKeys(row.basis, [
        'definitionFingerprint',
        'guideFingerprint',
        'evaluationSetFingerprint',
        'evaluatedSubjectFingerprint'
      ])
      || Object.values(row.basis).some((value) => !HASH.test(value || ''))
      || !exactKeys(row.evidence, ['path'])
      || row.evidence.path !== exactRetirementPath) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_WORKFLOW_SET_INVALID',
        'Each retired workflow must bind one normalized governed retirement evidence path.'
      );
    }
    if (retirementPaths.has(row.evidence.path.toLowerCase())) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID',
        'Retirement evidence paths must be distinct without case collisions.'
      );
    }
    retirementPaths.add(row.evidence.path.toLowerCase());
    const files = readWorkflowFiles(root, row.id);
    files.root = root;
    assertCandidateWorkflow(files, 'retired');
    if (row.basis.definitionFingerprint !== fingerprintJson(files.definition)
      || row.basis.guideFingerprint !== fingerprintJson(files.guide)
      || row.basis.evaluationSetFingerprint !== fingerprintJson(files.evaluations)
      || row.basis.evaluatedSubjectFingerprint !== fingerprintWorkflowEvaluatedSubject(files)) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_BASIS_INVALID',
        'Retired workflow request basis does not match the exact current candidate documents.'
      );
    }
    retiredIds.push(row.id);
  }
  if (!same(activeIds, ACTIVE_WORKFLOWS)
    || !same(retiredIds, RETIRED_WORKFLOWS)
    || new Set(activeIds).size !== activeIds.length
    || new Set(retiredIds).size !== retiredIds.length) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_WORKFLOW_SET_INVALID',
      'Workflow lifecycle finalization workflow identities are missing, duplicated, or substituted.'
    );
  }
  return request;
}

function readWorkflowFiles(root, workflowId) {
  const slug = workflowId.slice('automation.'.length);
  const directory = `soter/automations/${slug}`;
  const paths = {
    definition: `${directory}/definition.json`,
    guide: `${directory}/guide.json`,
    evaluations: `${directory}/evaluations.json`
  };
  const documents = Object.fromEntries(Object.entries(paths).map(([kind, relativePath]) => {
    const file = confinedPath(root, relativePath);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o644)) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_SOURCE_INVALID',
        'Workflow lifecycle source is not one safe canonical 0644 regular file: ' + relativePath
      );
    }
    const document = readJson(file);
    if (!fs.readFileSync(file).equals(canonicalBytes(document))) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_SOURCE_INVALID',
        'Workflow lifecycle source does not use exact canonical persisted bytes: ' + relativePath
      );
    }
    return [kind, document];
  }));
  if (documents.definition.id !== workflowId
    || documents.guide.workflow?.id !== workflowId
    || documents.evaluations.workflow !== workflowId) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_SOURCE_INVALID',
      'Workflow lifecycle documents do not share one exact workflow identity.'
    );
  }
  for (const kind of ['definition', 'guide', 'evaluations']) {
    validateDocument(root, kind, documents[kind], paths[kind]);
  }
  if (documents.definition.guide?.id !== documents.guide.id
    || documents.definition.guide?.path !== paths.guide
    || documents.definition.evaluationSet?.id !== documents.evaluations.id
    || documents.definition.evaluationSet?.path !== paths.evaluations
    || documents.guide.workflow?.version !== documents.definition.version
    || documents.guide.workflow?.definitionPath !== paths.definition
    || documents.guide.workflow?.definitionFingerprint !== fingerprintJson(documents.definition)
    || documents.guide.workflow?.evaluationSetPath !== paths.evaluations
    || documents.guide.workflow?.evaluationSetFingerprint !== fingerprintJson(documents.evaluations)
    || documents.guide.contentFingerprint !== fingerprintWorkflowGuideContent(documents.guide)) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_SOURCE_INVALID',
      'Workflow lifecycle candidate documents have stale or substituted cross-document bindings.'
    );
  }
  return { paths, ...documents };
}

function workflowRequestBasis(files) {
  return {
    definitionFingerprint: fingerprintJson(files.definition),
    guideFingerprint: fingerprintJson(files.guide),
    evaluationSetFingerprint: fingerprintJson(files.evaluations),
    evaluatedSubjectFingerprint: fingerprintWorkflowEvaluatedSubject(files)
  };
}

function historicalEvidenceReference(root, workflowId, host) {
  const slug = workflowId.slice('automation.'.length);
  const relativePath =
    `soter/evidence/development/development-agent-migration-evidence.${host}.${slug}.json`;
  let evidence;
  try {
    evidence = readJson(confinedPath(root, relativePath));
  } catch (error) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_EVIDENCE_INVALID',
      'Historical host receipt required to build the lifecycle request is unavailable or malformed: '
        + relativePath,
      error
    );
  }
  return {
    path: relativePath,
    fingerprint: fingerprintJson(evidence),
    host
  };
}

function parityForGuide(guide) {
  if (guide.source?.normalization === 'behavior-preserving-with-explicit-authority-boundary') {
    return 'passed';
  }
  if (guide.source?.normalization === 'intentional-change-with-explicit-authority-boundary') {
    return 'intentional-change';
  }
  fail(
    'DEVELOPMENT_WORKFLOW_FINALIZATION_SOURCE_INVALID',
    'Workflow guide has no closed normalization decision.'
  );
}

function assertCandidateWorkflow(files, disposition) {
  const sources = workflowLegacySourceProjection(files);
  const expectedStatus = disposition === 'active' ? 'candidate' : 'retirement-candidate';
  const expectedLifecycle = disposition === 'active' ? 'active-host-guided' : 'retired';
  const candidateState = disposition === 'active'
    ? files.definition.lifecycle?.activation?.state
    : files.definition.lifecycle?.retirement?.state;
  const evaluationState = disposition === 'active'
    ? files.evaluations.lifecycle?.activation
    : files.evaluations.lifecycle?.retirement;
  if (files.definition.lifecycle?.state !== expectedLifecycle
    || candidateState !== 'candidate'
    || evaluationState !== 'candidate'
    || files.guide.status?.state !== expectedStatus
    || sources.some((source) => source.presence !== 'present')) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_SOURCE_INVALID',
      'Workflow lifecycle finalization requires one complete exact candidate source set.'
    );
  }
  for (const source of sources) {
    const file = confinedPath(files.root, source.path);
    const stat = fs.lstatSync(file);
    if (!fs.existsSync(file) || fingerprintFile(file) !== source.fingerprint) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_SOURCE_INVALID',
        'Workflow legacy source is missing or drifted before lifecycle finalization: ' + source.path
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o644)) {
      fail(
        'DEVELOPMENT_WORKFLOW_FINALIZATION_SOURCE_INVALID',
        'Workflow legacy source is not one safe regular file: ' + source.path
      );
    }
  }
  return sources;
}

function finalizeSources(files) {
  files.definition.source.presence = 'removed';
  files.guide.source.presence = 'removed';
  for (const testCase of files.evaluations.cases) testCase.source.presence = 'removed';
}

function finalizeActive(files, row) {
  const parity = parityForGuide(files.guide);
  files.definition.lifecycle.activation = {
    state: 'active',
    reasonCode: 'WORKFLOW_HOST_GUIDANCE_ACTIVE',
    proceduralAuthority: 'target',
    delivery: 'host-skill',
    behaviorParity: parity,
    evidence: structuredClone(row.evidence),
    permittedNextAction: 'invoke-through-selected-host'
  };
  files.guide.status = {
    state: 'active',
    reasonCode: 'WORKFLOW_GUIDE_ACTIVE',
    proceduralAuthority: 'target',
    behaviorParity: parity,
    delivery: 'host-skill',
    evidence: structuredClone(row.evidence),
    permittedNextAction: 'invoke-through-selected-host'
  };
  files.evaluations.lifecycle = {
    state: 'active-host-guided',
    activation: 'active',
    authority: 'request-bound-development-evidence',
    permittedNextAction: 'run-exact-evaluation-suite'
  };
}

function finalizeRetired(files, row) {
  files.definition.lifecycle.retirement = {
    state: 'complete',
    reasonCode: 'WORKFLOW_RETIRED',
    proceduralAuthority: 'none',
    fallback: 'removed',
    evidence: [structuredClone(row.evidence)],
    permittedNextAction: 'inspect-replacement'
  };
  files.guide.status = {
    state: 'retired',
    reasonCode: 'WORKFLOW_GUIDE_RETIRED',
    proceduralAuthority: 'none',
    behaviorParity: 'intentional-change',
    delivery: 'unavailable',
    evidence: [structuredClone(row.evidence)],
    permittedNextAction: 'inspect-replacement'
  };
  files.evaluations.lifecycle = {
    state: 'retired',
    retirement: 'complete',
    authority: 'none',
    permittedNextAction: 'inspect-replacement'
  };
}

function validateDocument(root, kind, document, relativePath) {
  const failures = validateJsonSchema(document, readJson(resolveRepoPath(root, SCHEMAS[kind])));
  if (failures.length) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_CANDIDATE_INVALID',
      `Final ${kind} is invalid at ${relativePath}: `
        + failures.slice(0, 3).map((item) => `${item.path} ${item.message}`).join('; ')
    );
  }
}

function finalizedWorkflow(root, row, disposition) {
  const current = readWorkflowFiles(root, row.id);
  current.root = root;
  const evaluatedSubject = fingerprintWorkflowEvaluatedSubject(current);
  if (row.basis.definitionFingerprint !== fingerprintJson(current.definition)
    || row.basis.guideFingerprint !== fingerprintJson(current.guide)
    || row.basis.evaluationSetFingerprint !== fingerprintJson(current.evaluations)
    || row.basis.evaluatedSubjectFingerprint !== evaluatedSubject) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_BASIS_INVALID',
      'Workflow candidate changed after request validation and before plan construction.'
    );
  }
  const sources = assertCandidateWorkflow(current, disposition);
  const next = structuredClone(current);
  next.root = root;
  finalizeSources(next);
  if (disposition === 'active') finalizeActive(next, row);
  else finalizeRetired(next, row);
  next.guide.workflow.definitionFingerprint = fingerprintJson(next.definition);
  next.guide.workflow.evaluationSetFingerprint = fingerprintJson(next.evaluations);
  next.guide.contentFingerprint = fingerprintWorkflowGuideContent(next.guide);
  if (fingerprintWorkflowEvaluatedSubject(next) !== evaluatedSubject) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_SUBJECT_DRIFT',
      'Lifecycle finalization changed the exact evaluated workflow subject: ' + row.id
    );
  }
  for (const kind of ['definition', 'guide', 'evaluations']) {
    validateDocument(root, kind, next[kind], next.paths[kind]);
  }
  return {
    id: row.id,
    disposition,
    parity: disposition === 'active' ? parityForGuide(next.guide) : 'intentional-change',
    evaluatedSubjectFingerprint: evaluatedSubject,
    sources,
    files: ['definition', 'evaluations', 'guide'].map((kind) => ({
      kind,
      path: current.paths[kind],
      before: current[kind],
      beforeFingerprint: fingerprintJson(current[kind]),
      beforeFileFingerprint: sha256(canonicalBytes(current[kind])),
      after: next[kind],
      afterFingerprint: fingerprintJson(next[kind]),
      afterFileFingerprint: sha256(canonicalBytes(next[kind])),
      mode: '0644'
    }))
  };
}

function buildPlan(root, request) {
  const workflows = [
    ...request.active.map((row) => finalizedWorkflow(root, row, 'active')),
    ...request.retired.map((row) => finalizedWorkflow(root, row, 'retired'))
  ].sort((left, right) => compareCodepoint(left.id, right.id));
  const files = workflows.flatMap((workflow) => workflow.files)
    .sort((left, right) => compareCodepoint(left.path, right.path));
  if (files.length !== 30 || new Set(files.map((file) => file.path)).size !== files.length) {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_CANDIDATE_INVALID',
      'Workflow lifecycle finalization did not produce exactly thirty distinct document updates.'
    );
  }
  const plan = {
    contract: 'development-workflow-lifecycle-finalization-plan/v1',
    id: request.id,
    requestFingerprint: request.requestFingerprint,
    createdAt: request.createdAt,
    state: 'planned',
    workflows: workflows.map(({ files: _files, sources: _sources, ...workflow }) => ({
      ...workflow,
      sourceCount: _sources.length,
      fileCount: _files.length
    })),
    files: files.map(({ before: _before, after: _after, ...file }) => file),
    authority: {
      kind: 'workflow-lifecycle-candidate-only',
      repositoryWrites: false,
      sourceDeletion: false,
      migrationEvidenceCreated: false,
      externalEffects: false,
      providerEffects: false,
      hostRealization: false,
      fallbackRemoval: false
    },
    planFingerprint: null
  };
  plan.planFingerprint = fingerprintJson({ ...plan, planFingerprint: null });
  return { plan, files };
}

export function readDevelopmentWorkflowLifecycleFinalizationRequest({ root, requestPath, ...unknown } = {}) {
  if (Object.keys(unknown).length) {
    fail('DEVELOPMENT_WORKFLOW_FINALIZATION_ARGUMENTS_INVALID', 'Workflow lifecycle request reader received an unknown argument.');
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  return assertRequest(resolvedRoot, assertPrivateExternalFile(resolvedRoot, requestPath));
}

/**
 * Derive one exact private lifecycle request value from the frozen candidate
 * repository. This is intentionally read-only: callers may inspect or
 * separately persist the returned closed value, but this function grants no
 * repository-write, source-deletion, activation, or fallback-removal authority.
 */
export function buildDevelopmentWorkflowLifecycleFinalizationRequest({
  root,
  id,
  createdAt,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length || typeof root !== 'string') {
    fail(
      'DEVELOPMENT_WORKFLOW_FINALIZATION_ARGUMENTS_INVALID',
      'Workflow lifecycle request builder received an unknown or invalid argument.'
    );
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  assertInstant(createdAt);
  const request = {
    $contract: REQUEST_CONTRACT,
    contractVersion: '1.0.0',
    id,
    requestFingerprint: null,
    rootIdentityFingerprint: rootIdentityFingerprint(resolvedRoot),
    createdAt,
    active: ACTIVE_WORKFLOWS.map((workflowId) => {
      const files = readWorkflowFiles(resolvedRoot, workflowId);
      return {
        id: workflowId,
        basis: workflowRequestBasis(files),
        evidence: ['claude', 'codex'].map((host) => {
          return historicalEvidenceReference(resolvedRoot, workflowId, host);
        })
      };
    }),
    retired: RETIRED_WORKFLOWS.map((workflowId) => {
      const slug = workflowId.slice('automation.'.length);
      const files = readWorkflowFiles(resolvedRoot, workflowId);
      return {
        id: workflowId,
        basis: workflowRequestBasis(files),
        evidence: {
          path: `soter/fixtures/harness-development-catalog/${slug}.intentional-retirement.evidence.json`
        }
      };
    })
  };
  request.requestFingerprint = requestFingerprint(request);
  return structuredClone(assertRequest(resolvedRoot, request));
}

export function planDevelopmentWorkflowLifecycleFinalization({ root, requestPath, ...unknown } = {}) {
  if (Object.keys(unknown).length) {
    fail('DEVELOPMENT_WORKFLOW_FINALIZATION_ARGUMENTS_INVALID', 'Workflow lifecycle planner received an unknown argument.');
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const request = readDevelopmentWorkflowLifecycleFinalizationRequest({ root: resolvedRoot, requestPath });
  return buildPlan(resolvedRoot, request).plan;
}

export function buildDevelopmentWorkflowLifecycleFinalizationCandidate({ root, requestPath, ...unknown } = {}) {
  if (Object.keys(unknown).length) {
    fail('DEVELOPMENT_WORKFLOW_FINALIZATION_ARGUMENTS_INVALID', 'Workflow lifecycle candidate builder received an unknown argument.');
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const request = readDevelopmentWorkflowLifecycleFinalizationRequest({ root: resolvedRoot, requestPath });
  const candidate = buildPlan(resolvedRoot, request);
  return {
    request: structuredClone(request),
    plan: candidate.plan,
    files: candidate.files
  };
}

export const developmentWorkflowLifecycleFinalizationContract = Object.freeze({
  request: REQUEST_CONTRACT,
  activeWorkflows: ACTIVE_WORKFLOWS,
  retiredWorkflows: RETIRED_WORKFLOWS
});
