import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintWorkflowEvaluatedSubject,
  fingerprintWorkflowGuideContent,
  workflowEvaluationVerdict,
  workflowLegacySourceProjection
} from '../kernel/workflow-guides.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import { inspectManagedHostProjectionOwnership } from './host-realizations.mjs';
import {
  isDevelopmentCandidateLockPath,
  readDevelopmentCandidateLock
} from './development-candidate-locks.mjs';
import { renderWorkflowGuideEvaluatedInstructions } from './host-projections.mjs';
import {
  fingerprintJson,
  readJson,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import { fingerprintLock, lockMatchesResolution } from './resolve.mjs';
import { readValidatedDevelopmentHostFinalizationChain } from './development-host-runner.mjs';

const OBSERVATION_CONTRACT = 'soter://contracts/development-host-observation/v1';
const OBSERVATION_SCHEMA = 'soter/contracts/development-host-observation.schema.json';
const REQUEST_SCHEMA = 'soter/contracts/development-request.schema.json';
const RESULT_SCHEMA = 'soter/contracts/development-result.schema.json';
const DEFINITION_SCHEMA = 'soter/contracts/workflow-definition.schema.json';
const GUIDE_SCHEMA = 'soter/contracts/workflow-guide.schema.json';
const EVALUATION_SET_SCHEMA = 'soter/contracts/workflow-evaluation-set.schema.json';
const LOCK_SCHEMA = 'soter/contracts/lock.schema.json';
const EVIDENCE_SCHEMA = 'soter/contracts/evidence-v2.schema.json';
const MIGRATION_EVIDENCE_CONTRACT = 'soter://contracts/development-agent-migration-evidence/v1';
const MIGRATION_EVIDENCE_SCHEMA = 'soter/contracts/development-agent-migration-evidence.schema.json';
const DEVELOPMENT_REQUEST_ID = /^development-request[.]([a-z0-9]+(?:[.-][a-z0-9]+)*)$/;
const HISTORICAL_EVIDENCE_ID = /^development-agent-migration-evidence[.](?:codex|claude)[.][a-z0-9]+(?:-[a-z0-9]+)*$/;
const FINAL_EVIDENCE_ID = /^evidence[.]development-activation[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const FINAL_LOCK_PATH = /^soter\/fixtures\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*[.]lock[.]json$/;
const GOVERNED_EVIDENCE_DIRECTORY = 'soter/evidence/development';
const EXTERNAL_EFFECTS = [
  'provider-read',
  'provider-write',
  'publication',
  'merge',
  'protected-root-mutation',
  'host-realization'
];
const LIMITATIONS = [
  'DEVELOPMENT_HOST_OBSERVATION_EXACT_INPUTS_ONLY',
  'DEVELOPMENT_HOST_OBSERVATION_LOCAL_BINARY_IDENTITY_ONLY',
  'DEVELOPMENT_HOST_OBSERVATION_NO_EXECUTION_AUTHORITY'
];
const MIGRATION_EVIDENCE_LIMITATIONS = [
  'DEVELOPMENT_AGENT_MIGRATION_EVIDENCE_HISTORICAL_CANDIDATE_ONLY',
  'DEVELOPMENT_AGENT_MIGRATION_EVIDENCE_LOCAL_BINARY_IDENTITY_ONLY',
  'DEVELOPMENT_AGENT_MIGRATION_EVIDENCE_NO_AUTHORITY',
  'DEVELOPMENT_AGENT_MIGRATION_EVIDENCE_NO_CURRENT_RUNTIME_APPLICABILITY'
];
const ABSOLUTE_PATH_RE = /(?:^|[\s"'(=])(?:file:\/\/|[A-Za-z]:[\\/]|\/\/[^\s/]+[\\/]|\/(?=$|[),;.!?"'])|\/(?![\/\s])[^\/\s]+)/iu;
const RAW_DIFF_RE = /(?:^|\n)(?:diff --git\s|@@\s+-[0-9]|---\s+(?:a\/|\/)|\+\+\+\s+(?:b\/|\/))/u;

function codedError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function assertExactApiArguments(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || fingerprintJson(Object.keys(value).sort()) !== fingerprintJson([...keys].sort())) {
    throw codedError(
      'DEVELOPMENT_EVIDENCE_ARGUMENTS_INVALID',
      label + ' accepts only its exact declared arguments.'
    );
  }
}

function validate(root, value, schemaPath, label, code) {
  const failures = validateJsonSchema(value, readJson(resolveRepoPath(root, schemaPath)));
  if (failures.length) {
    throw codedError(
      code,
      label + ' does not satisfy its closed contract.',
      new Error(failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '))
    );
  }
}

function unsignedFingerprint(value, property) {
  const unsigned = structuredClone(value);
  delete unsigned[property];
  return fingerprintJson(unsigned);
}

function assertInstant(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw codedError('DEVELOPMENT_HOST_OBSERVATION_CHRONOLOGY_INVALID', label + ' must be one valid instant.');
  }
  return Date.parse(value);
}

function walkStrings(value, visit) {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const item of Object.values(value)) walkStrings(item, visit);
}

function assertSanitized(value, code) {
  if (containsCredentialMaterial(value)) {
    throw codedError(code, 'Development host observation data cannot contain credential material.');
  }
  walkStrings(value, (item) => {
    if (ABSOLUTE_PATH_RE.test(item)) {
      throw codedError(code, 'Development host observation data cannot contain absolute local paths.');
    }
    if (RAW_DIFF_RE.test(item)) {
      throw codedError(code, 'Development host observation data cannot contain raw diff content.');
    }
  });
}

function assertEqual(actual, expected, code, message) {
  if (fingerprintJson(actual) !== fingerprintJson(expected)) {
    throw codedError(code, message);
  }
}

function assertUnique(values, code, label) {
  if (new Set(values).size !== values.length) {
    throw codedError(code, label + ' must be globally unique within one host observation.');
  }
}

function requestWorkspaceBinding(request) {
  return {
    rootIdentityFingerprint: request.workspace.rootIdentityFingerprint,
    revisionFingerprint: request.workspace.revisionFingerprint,
    treeFingerprint: request.workspace.treeFingerprint,
    exactInputState: request.workspace.exactInputState,
    policyFingerprint: request.workspace.policyFingerprint,
    settingsFingerprint: request.workspace.settingsFingerprint
  };
}

function requestHostBinding(request, observer) {
  return {
    id: request.host.id,
    adapter: request.host.adapter,
    version: request.host.version,
    adapterFingerprint: request.host.adapterFingerprint,
    projectionDefinitionId: request.host.projectionDefinitionId,
    projectionDefinitionFingerprint: request.host.projectionDefinitionFingerprint,
    evaluatedInstructionFingerprint: request.host.evaluatedInstructionFingerprint,
    candidateProjectionFingerprint: request.host.candidateProjectionFingerprint,
    observer: structuredClone(observer)
  };
}

function assertRequestAndResult(root, request, result) {
  validate(root, request, REQUEST_SCHEMA, 'Development request', 'DEVELOPMENT_HOST_OBSERVATION_REQUEST_INVALID');
  validate(root, result, RESULT_SCHEMA, 'Development result', 'DEVELOPMENT_HOST_OBSERVATION_RESULT_INVALID');
  if (request.requestFingerprint !== unsignedFingerprint(request, 'requestFingerprint')) {
    throw codedError('DEVELOPMENT_HOST_OBSERVATION_REQUEST_INVALID', 'Development request fingerprint is invalid.');
  }
  if (result.resultFingerprint !== unsignedFingerprint(result, 'resultFingerprint')) {
    throw codedError('DEVELOPMENT_HOST_OBSERVATION_RESULT_INVALID', 'Development result fingerprint is invalid.');
  }
  if (request.invocation.kind !== 'evaluation-suite'
    || result.state !== 'passed'
    || result.request.id !== request.id
    || result.request.fingerprint !== request.requestFingerprint) {
    throw codedError(
      'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
      'Host observation requires one passed result bound to one exact evaluation-suite request.'
    );
  }
  const expectedResultBindings = {
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
    }
  };
  assertEqual(
    {
      workflow: result.workflow,
      host: result.host,
      configuration: result.configuration,
      workspace: result.workspace
    },
    expectedResultBindings,
    'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
    'Development result does not bind the exact request workflow, host, configuration, and pre-run workspace.'
  );
}

function assertChronology(observation, request, result) {
  const requestedAt = assertInstant(request.createdAt, 'Development request createdAt');
  const resultCreatedAt = assertInstant(result.createdAt, 'Development result createdAt');
  const completedAt = assertInstant(result.completedAt, 'Development result completedAt');
  const observedAt = assertInstant(observation.observedAt, 'Host observation observedAt');
  if (resultCreatedAt < requestedAt || completedAt < resultCreatedAt || observedAt < completedAt) {
    throw codedError(
      'DEVELOPMENT_HOST_OBSERVATION_CHRONOLOGY_INVALID',
      'Request, result, and host observation chronology is invalid.'
    );
  }
  for (const run of observation.runs) {
    const startedAt = assertInstant(run.startedAt, 'Worker run startedAt');
    const runCompletedAt = assertInstant(run.completedAt, 'Worker run completedAt');
    if (startedAt < requestedAt || runCompletedAt < startedAt || runCompletedAt > completedAt) {
      throw codedError(
        'DEVELOPMENT_HOST_OBSERVATION_CHRONOLOGY_INVALID',
        'One worker run falls outside the exact request and result chronology.'
      );
    }
  }
}

function assertRunCoverage(observation, request, result) {
  const planned = request.invocation.plannedRuns;
  if (observation.runs.length !== planned.length
    || result.workerRuns.length !== planned.length
    || result.judgments.length !== planned.length) {
    throw codedError(
      'DEVELOPMENT_HOST_OBSERVATION_COVERAGE_INCOMPLETE',
      'Host observation must cover every exact planned run, worker result, and judgment.'
    );
  }
  assertUnique(observation.runs.map((item) => item.id), 'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID', 'Planned run id');
  assertUnique(observation.runs.map((item) => item.worker.id), 'DEVELOPMENT_HOST_OBSERVATION_FRESH_WORKER_REQUIRED', 'Worker run id');
  assertUnique(observation.runs.map((item) => item.worker.workerFingerprint), 'DEVELOPMENT_HOST_OBSERVATION_FRESH_WORKER_REQUIRED', 'Worker identity fingerprint');
  assertUnique(observation.runs.map((item) => item.worker.dispatchFingerprint), 'DEVELOPMENT_HOST_OBSERVATION_DISPATCH_BINDING_INVALID', 'Dispatch fingerprint');
  assertUnique(observation.runs.map((item) => item.worker.transcriptFingerprint), 'DEVELOPMENT_HOST_OBSERVATION_TRANSCRIPT_BINDING_INVALID', 'Transcript fingerprint');
  assertUnique(observation.runs.map((item) => item.judgment.id), 'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID', 'Judgment id');

  const workers = new Map(result.workerRuns.map((item) => [item.requestRunId, item]));
  const judgments = new Map(result.judgments.map((item) => [item.workerRunId, item]));
  for (let index = 0; index < planned.length; index += 1) {
    const source = planned[index];
    const observed = observation.runs[index];
    const worker = workers.get(source.id);
    const judgment = worker ? judgments.get(worker.id) : null;
    if (observed.sequence !== index + 1
      || observed.id !== source.id
      || !worker
      || !judgment) {
      throw codedError(
        'DEVELOPMENT_HOST_OBSERVATION_COVERAGE_INCOMPLETE',
        'Host observation run order and exact result joins are incomplete.'
      );
    }
    assertEqual(
      {
        id: observed.id,
        sequence: observed.sequence,
        caseId: observed.caseId,
        caseFingerprint: observed.caseFingerprint,
        stimulusFingerprint: observed.stimulusFingerprint,
        arm: observed.arm,
        guideState: observed.guideState
      },
      source,
      'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
      'Host observation run does not bind its exact planned case, arm, and guide state.'
    );
    assertEqual(
      observed.worker,
      {
        id: worker.id,
        workerFingerprint: worker.workerFingerprint,
        dispatchFingerprint: worker.dispatchFingerprint,
        transcriptFingerprint: worker.transcriptFingerprint,
        expectationsIncluded: worker.expectationsIncluded,
        answerKeyAccess: worker.answerKeyAccess,
        state: worker.state
      },
      'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
      'Host observation worker facts do not match the exact private result.'
    );
    assertEqual(
      observed.judgment,
      {
        id: judgment.id,
        verdict: judgment.verdict,
        criteria: judgment.criteria
      },
      'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
      'Host observation judgment does not match the exact private result.'
    );
    assertUnique(
      observed.judgment.criteria.map((item) => item.id),
      'DEVELOPMENT_HOST_OBSERVATION_CRITERIA_INVALID',
      'Criterion id'
    );
    if (observed.judgment.verdict !== workflowEvaluationVerdict(observed.judgment.criteria)) {
      throw codedError(
        'DEVELOPMENT_HOST_OBSERVATION_CRITERIA_INVALID',
        'Host observation judgment verdict conflicts with its exact criterion observations.'
      );
    }
    if (observed.worker.answerKeyAccess !== 'not-observed'
      || observed.worker.expectationsIncluded !== false
      || (observed.arm === 'guided'
        && observed.judgment.criteria.some((item) => {
          return item.kind === 'prohibited' && item.state !== 'not-observed';
        }))) {
      throw codedError(
        'DEVELOPMENT_HOST_OBSERVATION_CRITERIA_INVALID',
        'Host observation cannot contain answer-key access, included expectations, or a guided prohibited outcome.'
      );
    }
    if (observed.arm === 'guided'
      && (observed.worker.state !== 'passed'
        || observed.judgment.verdict !== 'passed'
        || observed.judgment.criteria.some((item) => item.kind === 'expected' && item.state !== 'observed'))) {
      throw codedError(
        'DEVELOPMENT_HOST_OBSERVATION_CRITERIA_INVALID',
        'Every guided run and exact expected criterion must pass before migration evidence can be derived.'
      );
    }
  }
}

function assertNoExternalEffects(observation, result) {
  for (const category of EXTERNAL_EFFECTS) {
    const key = category.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const observed = observation.externalEffects[key];
    if (observed.state !== 'not-observed' || observed.count !== 0 || observed.observedFingerprint !== null) {
      throw codedError(
        'DEVELOPMENT_HOST_OBSERVATION_EXTERNAL_EFFECT_INVALID',
        'Host observation cannot include an external effect.'
      );
    }
  }
  const resultExternalEffects = result.effects.filter((effect) => {
    return EXTERNAL_EFFECTS.includes(effect.category);
  });
  if (resultExternalEffects.length !== EXTERNAL_EFFECTS.length
    || EXTERNAL_EFFECTS.some((category) => {
      return resultExternalEffects.filter((effect) => effect.category === category).length !== 1;
    })) {
    throw codedError(
      'DEVELOPMENT_HOST_OBSERVATION_EXTERNAL_EFFECT_INVALID',
      'Exact private result does not cover every governed external effect category.'
    );
  }
  for (const effect of resultExternalEffects) {
    if (effect.scope !== 'separate-authority'
      || effect.state !== 'not-observed'
      || effect.count !== 0
      || effect.observedFingerprint !== null) {
      throw codedError(
        'DEVELOPMENT_HOST_OBSERVATION_EXTERNAL_EFFECT_INVALID',
        'Exact private result disagrees with the no-external-effect host observation.'
      );
    }
  }
}

function exactCandidateLockArtifacts(lock, request) {
  const selected = lock.packs.filter((pack) => pack.id === request.workflow.id);
  if (selected.length !== 1 || selected[0].version !== request.workflow.version) return false;
  const expectedPaths = [
    request.workflow.definitionPath,
    request.workflow.guidePath,
    request.workflow.evaluationSetPath
  ];
  const isFingerprint = (value) => /^sha256:[a-f0-9]{64}$/.test(value || '');
  if (![request.workflow.definitionFingerprint,
    request.workflow.guideFingerprint,
    request.workflow.evaluationSetFingerprint].every(isFingerprint)) return false;
  return expectedPaths.every((artifactPath) => {
    const matches = selected[0].artifacts.filter((artifact) => artifact.path === artifactPath);
    return matches.length === 1 && isFingerprint(matches[0].fingerprint);
  });
}

/**
 * Revalidate the immutable private candidate-lock document which was observed
 * by one development request. `requireCurrent` is deliberately separate from
 * the exact-byte/request binding: activation makes the historical graph stale,
 * but it must never make a different historical lock acceptable.
 */
export function assertHistoricalDevelopmentCandidateLock({
  root,
  request,
  requireCurrent = false
}) {
  const resolvedRoot = path.resolve(root);
  if (!isDevelopmentCandidateLockPath(resolvedRoot, request?.configuration?.lockPath)) {
    throw codedError(
      'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_INVALID',
      'Historical host evidence requires one exact private development candidate lock.'
    );
  }
  let exact;
  try {
    exact = readDevelopmentCandidateLock({
      root: resolvedRoot,
      lockPath: request.configuration.lockPath,
      workflowId: request.workflow.id,
      requireCurrent
    });
  } catch (error) {
    throw codedError(
      requireCurrent
        ? 'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_STALE'
        : 'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_INVALID',
      requireCurrent
        ? 'Host observation requires one current exact private development candidate lock.'
        : 'Historical candidate lock bytes are unavailable, unsafe, or invalid.',
      error
    );
  }
  const lockFile = resolveRepoPath(resolvedRoot, request.configuration.lockPath);
  const exactBytes = Buffer.from(JSON.stringify(exact.lock, null, 2) + '\n', 'utf8');
  const observedBytes = fs.readFileSync(lockFile);
  if (!observedBytes.equals(exactBytes)
    || exact.lockFingerprint !== request.configuration.lockFingerprint
    || exact.graphFingerprint !== request.configuration.graphFingerprint
    || exact.lock.configuration?.name !== request.configuration.name
    || exact.lock.host?.id !== request.host.id
    || exact.lock.host?.adapter !== request.host.adapter
    || exact.lock.host?.manifestFingerprint !== request.host.adapterFingerprint
    || exact.lock.host?.projectionDefinition?.id !== request.host.projectionDefinitionId
    || exact.lock.host?.projectionDefinition?.fingerprint !== request.host.projectionDefinitionFingerprint
    || !exactCandidateLockArtifacts(exact.lock, request)) {
    throw codedError(
      'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_INVALID',
      'Historical candidate lock does not bind the exact canonical lock bytes, raw workflow artifact basis, semantic request fingerprint, and host basis.'
    );
  }
  return exact;
}

function assertCandidateLockForObservation(root, request, { requireCurrent, requirePrivate }) {
  if (!isDevelopmentCandidateLockPath(root, request.configuration.lockPath)) {
    if (requirePrivate) {
      throw codedError(
        'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_INVALID',
        'Historical finalization requires one private development candidate lock.'
      );
    }
    return null;
  }
  return assertHistoricalDevelopmentCandidateLock({ root, request, requireCurrent });
}

/**
 * Validate one receipt from an already trusted, authenticated local host boundary.
 * This module does not establish host trust: callers must supply the exact trusted
 * adapter binding and independently observed post-run workspace basis.
 */
function assertDevelopmentHostObservationInternal({
  root,
  observation,
  request,
  result,
  trustedAdapter,
  postWorkspace
}, {
  requireCurrentCandidateLock = true,
  requirePrivateCandidateLock = false
} = {}) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    observation,
    OBSERVATION_SCHEMA,
    'Development host observation',
    'DEVELOPMENT_HOST_OBSERVATION_MALFORMED'
  );
  if (observation.$contract !== OBSERVATION_CONTRACT
    || observation.observationFingerprint !== unsignedFingerprint(observation, 'observationFingerprint')) {
    throw codedError('DEVELOPMENT_HOST_OBSERVATION_TAMPERED', 'Development host observation fingerprint is invalid.');
  }
  assertSanitized(observation, 'DEVELOPMENT_HOST_OBSERVATION_PRIVATE_MATERIAL_INVALID');
  if (fingerprintJson([...observation.limitations].sort()) !== fingerprintJson(LIMITATIONS)) {
    throw codedError('DEVELOPMENT_HOST_OBSERVATION_MALFORMED', 'Development host observation limitations are not exact.');
  }
  assertRequestAndResult(resolvedRoot, request, result);
  assertCandidateLockForObservation(resolvedRoot, request, {
    requireCurrent: requireCurrentCandidateLock,
    requirePrivate: requirePrivateCandidateLock
  });

  const expectedHost = requestHostBinding(request, observation.host.observer);
  assertEqual(
    observation.host,
    expectedHost,
    'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
    'Host observation does not bind the exact request host and candidate projection.'
  );
  assertEqual(
    observation.host,
    trustedAdapter,
    'DEVELOPMENT_HOST_OBSERVATION_TRUST_INVALID',
    'Host observation does not match the trusted local adapter identity supplied by the caller.'
  );
  if (observation.host.adapter !== 'host.' + observation.host.id
    || observation.host.projectionDefinitionId !== 'host-projection.' + observation.host.id
    || observation.host.observer.id !== 'development-host-observer.' + observation.host.id) {
    throw codedError('DEVELOPMENT_HOST_OBSERVATION_TRUST_INVALID', 'Host and trusted observer identities disagree.');
  }

  assertEqual(
    observation.request,
    { id: request.id, fingerprint: request.requestFingerprint, createdAt: request.createdAt },
    'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
    'Host observation request binding is invalid.'
  );
  assertEqual(
    observation.result,
    {
      id: result.id,
      fingerprint: result.resultFingerprint,
      createdAt: result.createdAt,
      completedAt: result.completedAt,
      state: result.state
    },
    'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
    'Host observation result binding is invalid.'
  );
  assertEqual(
    observation.workflow,
    {
      id: request.workflow.id,
      version: request.workflow.version,
      definitionFingerprint: request.workflow.definitionFingerprint
    },
    'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
    'Host observation workflow binding is invalid.'
  );
  assertEqual(
    observation.evaluatedSubject,
    {
      kind: 'workflow-guide',
      id: request.workflow.guideId,
      version: request.workflow.version,
      fingerprint: request.workflow.evaluatedSubjectFingerprint,
      contentFingerprint: request.workflow.guideContentFingerprint,
      candidateProjectionFingerprint: request.host.candidateProjectionFingerprint
    },
    'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
    'Host observation evaluated-subject binding is invalid.'
  );
  assertEqual(
    observation.evaluationSet,
    {
      id: request.workflow.evaluationSetId,
      version: request.workflow.version,
      fingerprint: request.workflow.evaluationSetFingerprint
    },
    'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
    'Host observation evaluation-set binding is invalid.'
  );
  assertEqual(
    observation.configuration,
    {
      name: request.configuration.name,
      lockFingerprint: request.configuration.lockFingerprint,
      graphFingerprint: request.configuration.graphFingerprint
    },
    'DEVELOPMENT_HOST_OBSERVATION_BINDING_INVALID',
    'Host observation configuration and lock binding is invalid.'
  );
  assertEqual(
    observation.workspace.pre,
    requestWorkspaceBinding(request),
    'DEVELOPMENT_HOST_OBSERVATION_WORKSPACE_BINDING_INVALID',
    'Host observation pre-run workspace does not match the exact request basis.'
  );
  assertEqual(
    observation.workspace.post,
    postWorkspace,
    'DEVELOPMENT_HOST_OBSERVATION_WORKSPACE_BINDING_INVALID',
    'Host observation post-run workspace does not match the trusted caller observation.'
  );
  assertEqual(
    result.postWorkspace,
    postWorkspace,
    'DEVELOPMENT_HOST_OBSERVATION_WORKSPACE_BINDING_INVALID',
    'Host observation post-run workspace does not match the exact private result.'
  );
  if (observation.workspace.post.rootIdentityFingerprint !== observation.workspace.pre.rootIdentityFingerprint
    || observation.workspace.post.policyFingerprint !== observation.workspace.pre.policyFingerprint
    || observation.workspace.post.settingsFingerprint !== observation.workspace.pre.settingsFingerprint) {
    throw codedError(
      'DEVELOPMENT_HOST_OBSERVATION_WORKSPACE_BINDING_INVALID',
      'Pre-run and post-run workspace identity, policy, and settings must remain exact.'
    );
  }

  assertRunCoverage(observation, request, result);
  assertNoExternalEffects(observation, result);
  assertChronology(observation, request, result);
  return observation;
}

export function assertDevelopmentHostObservation(inputs) {
  return assertDevelopmentHostObservationInternal(inputs, {
    requireCurrentCandidateLock: true,
    requirePrivateCandidateLock: false
  });
}

function assertMigrationArtifact(artifact, label) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
    || Object.keys(artifact).sort().join(',') !== 'fingerprint,path'
    || typeof artifact.path !== 'string'
    || typeof artifact.fingerprint !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.fingerprint)) {
    throw codedError('DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID', label + ' is invalid.');
  }
  const normalized = path.posix.normalize(artifact.path);
  if (path.posix.isAbsolute(artifact.path)
    || normalized !== artifact.path
    || artifact.path === '.'
    || artifact.path === '..'
    || artifact.path.startsWith('../')
    || artifact.path.includes('/../')
    || artifact.path.startsWith('.soter/')
    || artifact.path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw codedError(
      'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID',
      label + ' must be one sanitized repository-relative non-runtime artifact.'
    );
  }
  assertSanitized(artifact, 'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID');
}

function exactWorkflowMigrationSources(root, request) {
  const slug = request.workflow.id.slice('automation.'.length);
  const expected = {
    definitionPath: `soter/automations/${slug}/definition.json`,
    guidePath: `soter/automations/${slug}/guide.json`,
    evaluationSetPath: `soter/automations/${slug}/evaluations.json`
  };
  if (request.workflow.definitionPath !== expected.definitionPath
    || request.workflow.guidePath !== expected.guidePath
    || request.workflow.evaluationSetPath !== expected.evaluationSetPath) {
    throw codedError(
      'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID',
      'Development request workflow paths do not identify one exact workflow source set.'
    );
  }
  const definition = readExactRegularJson(
    root,
    expected.definitionPath,
    'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID',
    'Workflow definition source binding'
  );
  const guide = readExactRegularJson(
    root,
    expected.guidePath,
    'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID',
    'Workflow guide source binding'
  );
  const evaluations = readExactRegularJson(
    root,
    expected.evaluationSetPath,
    'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID',
    'Workflow evaluation source binding'
  );
  if (definition.id !== request.workflow.id
    || guide.workflow?.id !== request.workflow.id
    || evaluations.workflow !== request.workflow.id) {
    throw codedError(
      'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID',
      'Workflow documents do not bind the exact development request identity.'
    );
  }
  let projected;
  try {
    projected = workflowLegacySourceProjection({ definition, guide, evaluations });
  } catch (error) {
    throw codedError(
      'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID',
      'Workflow documents do not declare one complete exact legacy source set.',
      error
    );
  }
  return projected.map(({ path: sourcePath, fingerprint }) => ({
    path: sourcePath,
    fingerprint
  }));
}

function assertExactMigrationSources(root, request, migration) {
  if (!migration || typeof migration !== 'object' || Array.isArray(migration)
    || Object.keys(migration).sort().join(',') !== 'sources,target'
    || !Array.isArray(migration.sources)
    || migration.sources.length < 2) {
    throw codedError('DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID', 'Migration artifact binding is invalid.');
  }
  migration.sources.forEach((source, index) => {
    assertMigrationArtifact(source, 'Migration source ' + String(index + 1));
  });
  if (new Set(migration.sources.map((source) => source.path)).size !== migration.sources.length) {
    throw codedError('DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID', 'Migration source paths must be unique.');
  }
  const expected = exactWorkflowMigrationSources(root, request);
  const actual = [...migration.sources].sort((left, right) => {
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  assertEqual(
    actual,
    expected,
    'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID',
    'Migration sources must seal the complete workflow skill and evaluation source set.'
  );
  return actual;
}

/**
 * Derive deterministic, sanitized historical-candidate migration evidence from
 * a validated receipt. The returned value is data only: it is not persisted,
 * does not claim current applicability, and grants no authority.
 */
function convertDevelopmentHostObservationToMigrationEvidenceInternal({
  root,
  observation,
  request,
  result,
  trustedAdapter,
  postWorkspace,
  migration
}, {
  requireCurrentCandidateLock,
  requirePrivateCandidateLock
}) {
  const resolvedRoot = path.resolve(root);
  assertDevelopmentHostObservationInternal({
    root: resolvedRoot,
    observation,
    request,
    result,
    trustedAdapter,
    postWorkspace
  }, {
    requireCurrentCandidateLock,
    requirePrivateCandidateLock
  });
  const migrationSources = assertExactMigrationSources(resolvedRoot, request, migration);
  assertMigrationArtifact(migration.target, 'Migration target');
  const workflowSlug = observation.workflow.id.slice('automation.'.length);
  if (migration.target.path !== 'soter/automations/' + workflowSlug + '/guide.json'
    || migration.target.fingerprint !== observation.evaluatedSubject.fingerprint) {
    throw codedError(
      'DEVELOPMENT_MIGRATION_EVIDENCE_ARTIFACT_INVALID',
      'Migration target does not bind the exact evaluated workflow guide.'
    );
  }

  const prohibitedOutcomesObserved = observation.runs.some((run) => {
    return run.judgment.criteria.some((criterion) => {
      return criterion.kind === 'prohibited' && criterion.state === 'observed';
    });
  });
  const evidence = {
    $contract: MIGRATION_EVIDENCE_CONTRACT,
    contractVersion: '1.0.0',
    id: `development-agent-migration-evidence.${observation.host.id}.${workflowSlug}`,
    evidenceFingerprint: fingerprintJson({ placeholder: 'development-agent-migration-evidence' }),
    createdAt: observation.observedAt,
    sourceObservation: {
      id: observation.id,
      fingerprint: observation.observationFingerprint,
      observedAt: observation.observedAt
    },
    applicability: {
      kind: 'historical-candidate-only',
      evaluatedSubjectFingerprint: observation.evaluatedSubject.fingerprint,
      candidate: {
        configurationName: observation.configuration.name,
        lockFingerprint: observation.configuration.lockFingerprint,
        graphFingerprint: observation.configuration.graphFingerprint,
        candidateProjectionFingerprint: observation.evaluatedSubject.candidateProjectionFingerprint
      },
      finalGraph: 'not-claimed',
      finalProjection: 'not-claimed',
      currentRuntime: 'not-claimed',
      activation: 'not-granted',
      fallbackRemoval: 'not-granted'
    },
    request: structuredClone(observation.request),
    result: structuredClone(observation.result),
    workflow: structuredClone(observation.workflow),
    evaluatedSubject: structuredClone(observation.evaluatedSubject),
    evaluationSet: structuredClone(observation.evaluationSet),
    host: structuredClone(observation.host),
    workspace: structuredClone(observation.workspace),
    environment: structuredClone(observation.environment),
    runs: structuredClone(observation.runs),
    artifacts: [...migrationSources.map((source, index) => ({
      id: 'artifact.migration-source.' + String(index + 1),
      role: 'migration-source',
      subjectId: observation.workflow.id,
      path: source.path,
      fingerprint: source.fingerprint
    })), {
      id: 'artifact.migration-target',
      role: 'migration-target',
      subjectId: observation.evaluatedSubject.id,
      path: migration.target.path,
      fingerprint: migration.target.fingerprint
    }, {
      id: 'artifact.development-request',
      role: 'development-request',
      subjectId: observation.request.id,
      fingerprint: observation.request.fingerprint
    }, {
      id: 'artifact.development-result',
      role: 'development-result',
      subjectId: observation.result.id,
      fingerprint: observation.result.fingerprint
    }, {
      id: 'artifact.host-observation',
      role: 'host-observation',
      subjectId: observation.id,
      fingerprint: observation.observationFingerprint
    }, {
      id: 'artifact.evaluation-set',
      role: 'evaluation-set',
      subjectId: observation.evaluationSet.id,
      fingerprint: observation.evaluationSet.fingerprint
    }, {
      id: 'artifact.candidate-projection',
      role: 'candidate-projection',
      subjectId: observation.evaluatedSubject.id,
      fingerprint: observation.evaluatedSubject.candidateProjectionFingerprint
    }],
    externalEffects: structuredClone(observation.externalEffects),
    conclusion: {
      state: 'passed',
      behaviorParity: 'passed',
      baselineRole: 'observed-non-gating',
      guidedRunsPassed: true,
      prohibitedOutcomesObserved,
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
    limitations: structuredClone(MIGRATION_EVIDENCE_LIMITATIONS)
  };
  evidence.evidenceFingerprint = unsignedFingerprint(evidence, 'evidenceFingerprint');
  validate(
    resolvedRoot,
    evidence,
    MIGRATION_EVIDENCE_SCHEMA,
    'Development migration evidence projection',
    'DEVELOPMENT_MIGRATION_EVIDENCE_INVALID'
  );
  if (evidence.evidenceFingerprint !== unsignedFingerprint(evidence, 'evidenceFingerprint')) {
    throw codedError('DEVELOPMENT_MIGRATION_EVIDENCE_TAMPERED', 'Development migration evidence fingerprint is invalid.');
  }
  assertSanitized(evidence, 'DEVELOPMENT_MIGRATION_EVIDENCE_PRIVATE_MATERIAL_INVALID');
  return evidence;
}

export function convertDevelopmentHostObservationToMigrationEvidence(inputs) {
  return convertDevelopmentHostObservationToMigrationEvidenceInternal(inputs, {
    requireCurrentCandidateLock: true,
    requirePrivateCandidateLock: false
  });
}

/**
 * Revalidate an evidence document against the exact private request/result and
 * trusted host observation from which it is permitted to be derived.
 */
export function assertDevelopmentAgentMigrationEvidence({ evidence, ...inputs }) {
  const expected = convertDevelopmentHostObservationToMigrationEvidence(inputs);
  validate(
    path.resolve(inputs.root),
    evidence,
    MIGRATION_EVIDENCE_SCHEMA,
    'Development migration evidence',
    'DEVELOPMENT_MIGRATION_EVIDENCE_INVALID'
  );
  if (evidence.evidenceFingerprint !== unsignedFingerprint(evidence, 'evidenceFingerprint')) {
    throw codedError('DEVELOPMENT_MIGRATION_EVIDENCE_TAMPERED', 'Development migration evidence fingerprint is invalid.');
  }
  assertSanitized(evidence, 'DEVELOPMENT_MIGRATION_EVIDENCE_PRIVATE_MATERIAL_INVALID');
  assertEqual(
    evidence,
    expected,
    'DEVELOPMENT_MIGRATION_EVIDENCE_BINDING_INVALID',
    'Development migration evidence does not bind the exact historical candidate observation.'
  );
  return evidence;
}

function assertHistoricalMigrationEvidenceForFinalization({ evidence, ...inputs }) {
  const expected = convertDevelopmentHostObservationToMigrationEvidenceInternal(inputs, {
    requireCurrentCandidateLock: false,
    requirePrivateCandidateLock: true
  });
  validate(
    path.resolve(inputs.root),
    evidence,
    MIGRATION_EVIDENCE_SCHEMA,
    'Historical development migration evidence',
    'DEVELOPMENT_MIGRATION_EVIDENCE_INVALID'
  );
  if (evidence.evidenceFingerprint !== unsignedFingerprint(evidence, 'evidenceFingerprint')) {
    throw codedError('DEVELOPMENT_MIGRATION_EVIDENCE_TAMPERED', 'Historical development migration evidence fingerprint is invalid.');
  }
  assertSanitized(evidence, 'DEVELOPMENT_MIGRATION_EVIDENCE_PRIVATE_MATERIAL_INVALID');
  assertEqual(
    evidence,
    expected,
    'DEVELOPMENT_MIGRATION_EVIDENCE_BINDING_INVALID',
    'Historical development migration evidence does not bind the exact immutable candidate lock and observation.'
  );
  return evidence;
}

function readExactRegularJson(root, relativePath, code, label) {
  if (typeof relativePath !== 'string'
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.startsWith('../')
    || relativePath.includes('/../')) {
    throw codedError(code, label + ' path is not one normalized repository-relative path.');
  }
  const file = resolveRepoPath(root, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw codedError(code, label + ' is unavailable.', error);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw codedError(code, label + ' must be one regular non-linked file.');
  }
  return readJson(file);
}

function finalWorkflowFiles(root, workflowId) {
  const slug = workflowId.slice('automation.'.length);
  const base = 'soter/automations/' + slug;
  const definitionPath = base + '/definition.json';
  const guidePath = base + '/guide.json';
  const evaluationSetPath = base + '/evaluations.json';
  return {
    slug,
    definitionPath,
    guidePath,
    evaluationSetPath,
    definition: readExactRegularJson(
      root,
      definitionPath,
      'DEVELOPMENT_ACTIVATION_EVIDENCE_FINAL_SUBJECT_INVALID',
      'Final workflow definition'
    ),
    guide: readExactRegularJson(
      root,
      guidePath,
      'DEVELOPMENT_ACTIVATION_EVIDENCE_FINAL_SUBJECT_INVALID',
      'Final workflow guide'
    ),
    evaluations: readExactRegularJson(
      root,
      evaluationSetPath,
      'DEVELOPMENT_ACTIVATION_EVIDENCE_FINAL_SUBJECT_INVALID',
      'Final workflow evaluation set'
    )
  };
}

function activationReference(doc, host, pathProperty) {
  const references = pathProperty(doc) || [];
  const matches = references.filter((reference) => reference.host === host);
  return matches.length === 1 ? matches[0] : null;
}

function lockEvidenceApplicability(lock) {
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

function assertFinalWorkflowBasis({
  root,
  historicalEvidence,
  historicalEvidencePath,
  lock,
  files
}) {
  validate(
    root,
    files.definition,
    DEFINITION_SCHEMA,
    'Final workflow definition',
    'DEVELOPMENT_ACTIVATION_EVIDENCE_FINAL_SUBJECT_INVALID'
  );
  validate(
    root,
    files.guide,
    GUIDE_SCHEMA,
    'Final workflow guide',
    'DEVELOPMENT_ACTIVATION_EVIDENCE_FINAL_SUBJECT_INVALID'
  );
  validate(
    root,
    files.evaluations,
    EVALUATION_SET_SCHEMA,
    'Final workflow evaluation set',
    'DEVELOPMENT_ACTIVATION_EVIDENCE_FINAL_SUBJECT_INVALID'
  );
  const workflowId = historicalEvidence.workflow.id;
  const version = historicalEvidence.workflow.version;
  if (files.definition.id !== workflowId
    || files.definition.version !== version
    || files.guide.workflow.id !== workflowId
    || files.guide.workflow.version !== version
    || files.evaluations.workflow !== workflowId
    || files.evaluations.version !== version
    || files.definition.lifecycle?.state !== 'active-host-guided'
    || files.definition.lifecycle?.activation?.state !== 'active'
    || files.guide.status?.state !== 'active'
    || files.evaluations.lifecycle?.state !== 'active-host-guided'
    || files.evaluations.lifecycle?.activation !== 'active'
    || files.definition.source?.presence !== 'removed'
    || files.guide.source?.presence !== 'removed'
    || files.evaluations.cases.some((testCase) => testCase.source?.presence !== 'removed')) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_FINAL_SUBJECT_INVALID',
      'Final workflow documents are not one exact active, fully tombstoned workflow subject.'
    );
  }
  const stableSubjectFingerprint = fingerprintWorkflowEvaluatedSubject({
    definition: files.definition,
    guide: files.guide,
    evaluations: files.evaluations
  });
  if (stableSubjectFingerprint !== historicalEvidence.evaluatedSubject.fingerprint
    || files.guide.contentFingerprint !== fingerprintWorkflowGuideContent(files.guide)
    || files.guide.workflow.definitionPath !== files.definitionPath
    || files.guide.workflow.definitionFingerprint !== fingerprintJson(files.definition)
    || files.guide.workflow.evaluationSetPath !== files.evaluationSetPath
    || files.guide.workflow.evaluationSetFingerprint !== fingerprintJson(files.evaluations)) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_SUBJECT_DRIFT',
      'Final workflow documents do not preserve the exact evaluated behavioral subject and relational bindings.'
    );
  }
  const expectedReferenceFingerprint = fingerprintJson(historicalEvidence);
  const definitionReference = activationReference(
    files.definition,
    historicalEvidence.host.id,
    (definition) => definition.lifecycle?.activation?.evidence
  );
  const guideReference = activationReference(
    files.guide,
    historicalEvidence.host.id,
    (guide) => guide.status?.evidence
  );
  if (!definitionReference
    || !guideReference
    || definitionReference.path !== historicalEvidencePath
    || guideReference.path !== historicalEvidencePath
    || definitionReference.fingerprint !== expectedReferenceFingerprint
    || guideReference.fingerprint !== expectedReferenceFingerprint
    || fingerprintJson(definitionReference) !== fingerprintJson(guideReference)) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_HISTORICAL_REFERENCE_INVALID',
      'Final workflow activation does not bind the exact historical no-authority host receipt.'
    );
  }
  let finalSources;
  try {
    finalSources = workflowLegacySourceProjection({
      definition: files.definition,
      guide: files.guide,
      evaluations: files.evaluations
    });
  } catch (error) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_SOURCE_TOMBSTONE_INVALID',
      'Final workflow documents do not preserve one complete legacy source tombstone set.',
      error
    );
  }
  const expectedSourceArtifacts = finalSources.map(({ path: sourcePath, fingerprint }) => ({
    path: sourcePath,
    fingerprint
  }));
  const sourceArtifacts = historicalEvidence.artifacts.filter((artifact) => {
    return artifact.role === 'migration-source';
  }).map(({ path: sourcePath, fingerprint }) => ({
    path: sourcePath,
    fingerprint
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const managedOutputPaths = new Set();
  for (const host of ['codex', 'claude']) {
    try {
      const ownership = inspectManagedHostProjectionOwnership({ root, host });
      if (ownership.state === 'realized') {
        for (const outputPath of ownership.outputPaths) managedOutputPaths.add(outputPath);
      }
    } catch {
      // Fail closed: malformed, stale, or drifted ownership cannot excuse an occupied tombstone path.
    }
  }
  if (finalSources.some((source) => source.presence !== 'removed')
    || fingerprintJson(sourceArtifacts) !== fingerprintJson(expectedSourceArtifacts)
    || finalSources.some((source) => {
      return fs.existsSync(resolveRepoPath(root, source.path))
        && !managedOutputPaths.has(source.path);
    })) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_SOURCE_TOMBSTONE_INVALID',
      'Final activation requires every exact legacy source to remain absent or be replaced by an exact current managed host projection.'
    );
  }
  const selectedPack = lock.packs.filter((pack) => pack.id === workflowId);
  if (selectedPack.length !== 1 || selectedPack[0].version !== version) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_LOCK_INVALID',
      'Final lock does not select the exact evaluated workflow version.'
    );
  }
  return { stableSubjectFingerprint, sourceArtifacts: expectedSourceArtifacts };
}

/**
 * Convert one already validated historical host receipt into current evidence/v2
 * only after the exact final active documents and exact current host lock exist.
 * The output remains evidence data: it grants no execution, provider, merge, or
 * fallback-removal authority and is intentionally not referenced by the active
 * documents, avoiding a guide -> evidence -> lock -> guide fingerprint cycle.
 */
function convertDevelopmentAgentMigrationEvidenceToFinalEvidenceInternal({
  root,
  evidence: historicalEvidence,
  historicalEvidencePath,
  observation,
  request,
  result,
  trustedAdapter,
  postWorkspace,
  migration,
  finalLockPath,
  finalLockDocument = null,
  createdAt
}, {
  requireCurrentFinalLock
}) {
  const resolvedRoot = path.resolve(root);
  assertHistoricalMigrationEvidenceForFinalization({
    root: resolvedRoot,
    evidence: historicalEvidence,
    observation,
    request,
    result,
    trustedAdapter,
    postWorkspace,
    migration
  });
  const expectedHistoricalEvidencePath =
    `${GOVERNED_EVIDENCE_DIRECTORY}/${historicalEvidence.id}.json`;
  if (historicalEvidencePath !== expectedHistoricalEvidencePath) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_HISTORICAL_REFERENCE_INVALID',
      'Historical migration evidence path does not match its exact stable host and workflow identity.'
    );
  }
  const storedHistoricalEvidence = readExactRegularJson(
    resolvedRoot,
    historicalEvidencePath,
    'DEVELOPMENT_ACTIVATION_EVIDENCE_HISTORICAL_REFERENCE_INVALID',
    'Historical migration evidence'
  );
  assertEqual(
    storedHistoricalEvidence,
    historicalEvidence,
    'DEVELOPMENT_ACTIVATION_EVIDENCE_HISTORICAL_REFERENCE_INVALID',
    'Stored historical migration evidence does not match the exact validated receipt.'
  );
  const finalLock = finalLockDocument === null
    ? readExactRegularJson(
      resolvedRoot,
      finalLockPath,
      'DEVELOPMENT_ACTIVATION_EVIDENCE_LOCK_INVALID',
      'Final configuration lock'
    )
    : structuredClone(finalLockDocument);
  validate(
    resolvedRoot,
    finalLock,
    LOCK_SCHEMA,
    'Final configuration lock',
    'DEVELOPMENT_ACTIVATION_EVIDENCE_LOCK_INVALID'
  );
  if (requireCurrentFinalLock) {
    let reproduction;
    try {
      reproduction = lockMatchesResolution({
        root: resolvedRoot,
        lock: finalLock,
        configPath: finalLock.configuration.path,
        host: historicalEvidence.host.id
      });
    } catch (error) {
      throw codedError(
        'DEVELOPMENT_ACTIVATION_EVIDENCE_LOCK_STALE',
        'Final configuration lock cannot be reproduced from the current graph.',
        error
      );
    }
    if (!reproduction.matches) {
      throw codedError(
        'DEVELOPMENT_ACTIVATION_EVIDENCE_LOCK_STALE',
        'Final configuration lock is stale.'
      );
    }
  }
  if (finalLock.host.id !== historicalEvidence.host.id
    || finalLock.configuration.name !== historicalEvidence.applicability.candidate.configurationName) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_LOCK_STALE',
      'Final configuration lock belongs to a different host or configuration.'
    );
  }
  const files = finalWorkflowFiles(resolvedRoot, historicalEvidence.workflow.id);
  const basis = assertFinalWorkflowBasis({
    root: resolvedRoot,
    historicalEvidence,
    historicalEvidencePath,
    lock: finalLock,
    files
  });
  const adapter = readExactRegularJson(
    resolvedRoot,
    'soter/hosts/' + historicalEvidence.host.id + '/adapter.json',
    'DEVELOPMENT_ACTIVATION_EVIDENCE_INSTRUCTION_DRIFT',
    'Final host adapter'
  );
  if (adapter.id !== finalLock.host.adapter
    || adapter.host !== finalLock.host.id
    || adapter.version !== finalLock.host.version
    || fingerprintJson(adapter) !== finalLock.host.manifestFingerprint
    || finalLock.host.id !== historicalEvidence.host.id) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_HOST_DRIFT',
      'Final current host adapter does not match the exact separately validated final lock.'
    );
  }
  const evaluatedInstructions = renderWorkflowGuideEvaluatedInstructions({
    root: resolvedRoot,
    adapter,
    definition: files.definition,
    guide: files.guide,
    evaluations: files.evaluations,
    effectPolicies: finalLock.effectPolicies
  });
  if (evaluatedInstructions.fingerprint !== historicalEvidence.host.evaluatedInstructionFingerprint) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_INSTRUCTION_DRIFT',
      'Final host instructions, templates, or effect policies differ from the exact observed host projection.'
    );
  }
  const historicalCreatedAt = assertInstant(historicalEvidence.createdAt, 'Historical migration evidence createdAt');
  const finalCreatedAt = assertInstant(createdAt, 'Final activation evidence createdAt');
  if (finalCreatedAt < historicalCreatedAt) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_CHRONOLOGY_INVALID',
      'Final activation evidence cannot predate its exact historical host receipt.'
    );
  }
  const applicability = lockEvidenceApplicability(finalLock);
  const suffix = historicalEvidence.workflow.id.slice('automation.'.length);
  const finalEvidence = {
    $contract: 'soter://contracts/evidence/v2',
    contractVersion: '2.0.0',
    id: 'evidence.development-activation.' + historicalEvidence.host.id + '.' + suffix,
    createdAt,
    claimFamily: 'migration',
    claim: 'The exact final host projection preserves the previously observed stable workflow behavior under this exact current lock.',
    subject: {
      type: 'automation',
      id: historicalEvidence.workflow.id,
      version: historicalEvidence.workflow.version
    },
    ...applicability,
    evaluator: {
      id: 'core.development-activation-evidence',
      version: '1.0.0',
      level: 'agent'
    },
    environment: {
      containment: historicalEvidence.environment.containment === 'isolated-host-process'
        ? 'connected'
        : historicalEvidence.environment.containment,
      runtime: 'node'
    },
    acceptanceCriteria: [
      'The exact historical no-authority host receipt passed every guided case with fresh workers and withheld expectations.',
      'The final workflow documents preserve the exact stable evaluated behavioral subject.',
      'The final host templates, instructions, and effect policy preserve the exact evaluated instruction fingerprint.',
      'The final host-specific configuration lock exactly reproduces the current graph, integrations, and authorities.',
      'The legacy procedural source and evaluation sources remain removed as exact tombstones.'
    ],
    result: 'passed',
    outcomes: [
      { id: 'historical-host-observation-passed', state: 'passed' },
      { id: 'stable-evaluated-subject-current', state: 'passed' },
      { id: 'stable-host-instructions-current', state: 'passed' },
      { id: 'exact-final-lock-current', state: 'passed' },
      { id: 'legacy-source-tombstoned', state: 'passed' }
    ],
    artifacts: [
      ...basis.sourceArtifacts.map((source) => ({
        role: 'migration-source',
        path: source.path,
        fingerprint: source.fingerprint
      })),
      {
        role: 'migration-target',
        path: files.guidePath,
        fingerprint: files.guide.contentFingerprint
      },
      {
        role: 'migration-target',
        path: files.evaluationSetPath,
        fingerprint: fingerprintJson(files.evaluations)
      },
      {
        role: 'development-agent-migration-evidence',
        path: historicalEvidencePath,
        fingerprint: fingerprintJson(historicalEvidence),
        evidenceFingerprint: historicalEvidence.evidenceFingerprint,
        host: historicalEvidence.host.id
      },
      {
        role: 'workflow-evaluated-subject',
        subjectId: files.guide.id,
        fingerprint: basis.stableSubjectFingerprint
      },
      {
        role: 'workflow-evaluated-instructions',
        subjectId: files.guide.id,
        host: historicalEvidence.host.id,
        fingerprint: evaluatedInstructions.fingerprint
      },
      {
        role: 'workflow-definition',
        path: files.definitionPath,
        fingerprint: fingerprintJson(files.definition)
      },
      {
        role: 'workflow-evaluation-set',
        path: files.evaluationSetPath,
        fingerprint: fingerprintJson(files.evaluations)
      }
    ],
    effects: [],
    failures: [],
    warnings: [],
    skipped: [
      'Provider behavior, provider readiness, global readiness, verification, and health were not evaluated.',
      'This evidence does not execute a workflow, realize a host, mutate configuration, publish, merge, or remove a fallback.'
    ],
    limitations: [
      'Applicable only to the exact historical host receipt, stable workflow subject, host instruction projection, and final lock.',
      'The record supports Kernel migration review but independently grants no execution, approval, provider, merge, or fallback-removal authority.',
      'Activation remains invalid until Kernel observes distinct current Codex and Claude evidence and the exact completed legacy tombstones.'
    ],
    freshness: {
      policy: 'Valid only while every configuration-lock fingerprint remains unchanged.',
      validUntil: null
    },
    supersedes: null,
    privacy: {
      scope: 'shareable',
      redactions: [
        'Raw prompts, responses, transcripts, diffs, local paths, provider data, and credential material are excluded.'
      ]
    }
  };
  validate(
    resolvedRoot,
    finalEvidence,
    EVIDENCE_SCHEMA,
    'Final development activation evidence',
    'DEVELOPMENT_ACTIVATION_EVIDENCE_INVALID'
  );
  assertSanitized(finalEvidence, 'DEVELOPMENT_ACTIVATION_EVIDENCE_PRIVATE_MATERIAL_INVALID');
  return finalEvidence;
}

export function convertDevelopmentAgentMigrationEvidenceToFinalEvidence(inputs) {
  return convertDevelopmentAgentMigrationEvidenceToFinalEvidenceInternal(inputs, {
    requireCurrentFinalLock: true
  });
}

function canonicalRoot(root) {
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(root));
  } catch (error) {
    throw codedError(
      'DEVELOPMENT_EVIDENCE_ROOT_INVALID',
      'Development evidence requires one existing canonical repository root.',
      error
    );
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw codedError(
      'DEVELOPMENT_EVIDENCE_ROOT_INVALID',
      'Development evidence requires one real repository directory.'
    );
  }
  return resolved;
}

function assertDirectoryPath(directory, code, label, expectedMode = null) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    throw codedError(code, label + ' is unavailable.', error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(directory) !== directory
    || (process.platform !== 'win32' && (stat.mode & 0o7000) !== 0)
    || (expectedMode !== null
      && process.platform !== 'win32'
      && (stat.mode & 0o7777) !== expectedMode)) {
    throw codedError(code, label + ' must be one exact non-symlink directory.');
  }
  return stat;
}

function assertPrivateParents(root, file, code) {
  const privateRoot = resolveRepoPath(root, '.soter');
  const relative = path.relative(privateRoot, path.dirname(file));
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw codedError(code, 'Private development evidence source escapes .soter state.');
  }
  let current = privateRoot;
  assertDirectoryPath(current, code, 'Private .soter directory', 0o700);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    assertDirectoryPath(current, code, 'Private development state directory', 0o700);
  }
}

function readExactJsonDescriptor(file, {
  root,
  code,
  label,
  mode,
  privateParents = false,
  linkCount = 1
}) {
  if (privateParents) assertPrivateParents(root, file, code);
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== linkCount
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== mode)) {
      throw codedError(code, label + ' must be one exact regular non-linked file.');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || after.nlink !== linkCount) {
      throw codedError(code, label + ' changed while it was being read.');
    }
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw codedError(code, label + ' is not valid JSON.', error);
    }
    const exactBytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
    if (!bytes.equals(exactBytes)) {
      throw codedError(code, label + ' does not contain exact canonical persisted bytes.');
    }
    return { value, bytes, stat: after };
  } catch (error) {
    if (error?.code === code) throw error;
    throw codedError(code, label + ' is unavailable or unsafe.', error);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function requestSuffixForPersistence(requestId) {
  const match = typeof requestId === 'string' ? requestId.match(DEVELOPMENT_REQUEST_ID) : null;
  if (!match) {
    throw codedError(
      'DEVELOPMENT_MIGRATION_EVIDENCE_SOURCE_INVALID',
      'Historical evidence requires one exact development request identity.'
    );
  }
  return match[1];
}

function privateReceiptPaths(root, requestId) {
  const suffix = requestSuffixForPersistence(requestId);
  return {
    request: resolveRepoPath(root, `.soter/state/development-requests/${requestId}.json`),
    result: resolveRepoPath(root, `.soter/state/development-results/development-result.${suffix}.json`),
    observation: resolveRepoPath(
      root,
      `.soter/state/development-host-observations/development-host-observation.${suffix}.json`
    )
  };
}

function exactMigrationBinding(root, request, observation) {
  return {
    sources: exactWorkflowMigrationSources(root, request),
    target: {
      path: request.workflow.guidePath,
      fingerprint: observation.evaluatedSubject.fingerprint
    }
  };
}

function readFinalizedPrivateReceipt(root, requestId, { requireCurrentCandidateLock }) {
  const resolvedRoot = canonicalRoot(root);
  const paths = privateReceiptPaths(resolvedRoot, requestId);
  const sourceCode = 'DEVELOPMENT_MIGRATION_EVIDENCE_SOURCE_UNAVAILABLE';
  const request = readExactJsonDescriptor(paths.request, {
    root: resolvedRoot,
    code: sourceCode,
    label: 'Private development request',
    mode: 0o600,
    privateParents: true
  }).value;
  const result = readExactJsonDescriptor(paths.result, {
    root: resolvedRoot,
    code: sourceCode,
    label: 'Private development result',
    mode: 0o600,
    privateParents: true
  }).value;
  const observation = readExactJsonDescriptor(paths.observation, {
    root: resolvedRoot,
    code: sourceCode,
    label: 'Private development host observation',
    mode: 0o600,
    privateParents: true
  }).value;
  const suffix = requestSuffixForPersistence(requestId);
  if (request.id !== requestId
    || result.id !== `development-result.${suffix}`
    || observation.id !== `development-host-observation.${suffix}`) {
    throw codedError(
      'DEVELOPMENT_MIGRATION_EVIDENCE_SOURCE_INVALID',
      'Private development request, result, and observation identities do not form one exact finalized receipt.'
    );
  }
  let runnerChain;
  try {
    runnerChain = readValidatedDevelopmentHostFinalizationChain({
      root: resolvedRoot,
      request,
      result,
      observation
    });
  } catch (error) {
    if (error?.code?.startsWith('DEVELOPMENT_HOST_')) throw error;
    throw codedError(
      'DEVELOPMENT_HOST_FINALIZATION_RECEIPT_INVALID',
      'Private development runner receipts cannot be independently revalidated.',
      error
    );
  }
  const trustedAdapter = runnerChain.trustedAdapter;
  const postWorkspace = runnerChain.postWorkspace;
  const migration = exactMigrationBinding(resolvedRoot, request, observation);
  const evidence = convertDevelopmentHostObservationToMigrationEvidenceInternal({
    root: resolvedRoot,
    observation,
    request,
    result,
    trustedAdapter,
    postWorkspace,
    migration
  }, {
    requireCurrentCandidateLock,
    requirePrivateCandidateLock: true
  });
  return {
    root: resolvedRoot,
    request,
    result,
    observation,
    trustedAdapter,
    postWorkspace,
    runnerChain,
    migration,
    evidence
  };
}

function evidenceRelativePath(evidence) {
  const pattern = evidence.$contract === MIGRATION_EVIDENCE_CONTRACT
    ? HISTORICAL_EVIDENCE_ID
    : FINAL_EVIDENCE_ID;
  if (!pattern.test(evidence.id || '')) {
    throw codedError(
      'DEVELOPMENT_EVIDENCE_OUTPUT_PATH_INVALID',
      'Development evidence identity cannot determine one governed output path.'
    );
  }
  return `${GOVERNED_EVIDENCE_DIRECTORY}/${evidence.id}.json`;
}

function assertExistingGovernedEvidenceDirectory(root, file, code) {
  const expected = resolveRepoPath(root, GOVERNED_EVIDENCE_DIRECTORY);
  if (path.dirname(file) !== expected) {
    throw codedError(code, 'Governed development evidence path escapes its exact directory.');
  }
  let current = root;
  for (const part of GOVERNED_EVIDENCE_DIRECTORY.split('/')) {
    current = path.join(current, part);
    assertDirectoryPath(current, code, 'Governed development evidence directory', 0o755);
  }
  return expected;
}

function readExistingGovernedEvidence(root, file, expectedBytes, mismatchCode, linkCount = 1) {
  assertExistingGovernedEvidenceDirectory(root, file, mismatchCode);
  const existing = readExactJsonDescriptor(file, {
    root,
    code: mismatchCode,
    label: 'Governed development evidence',
    mode: 0o644,
    linkCount
  });
  if (!existing.bytes.equals(expectedBytes)) {
    throw codedError(
      mismatchCode,
      'Create-only development evidence re-entry cannot adopt or replace different bytes.'
    );
  }
  return existing.value;
}

/**
 * Persist one sanitized historical candidate receipt. The exact finalized
 * private request/result/observation and current private candidate lock are
 * revalidated before any governed output is created.
 */
export function persistDevelopmentHostHistoricalEvidence(options) {
  assertExactApiArguments(
    options,
    ['root', 'requestId'],
    'Historical development evidence persistence'
  );
  throw codedError(
    'DEVELOPMENT_MIGRATION_EVIDENCE_BATCH_REQUIRED',
    'Standalone historical evidence publication is unavailable; use the exact fourteen-chain dual-host batch.'
  );
}

/**
 * Build one historical evidence document for the closed dual-host publication
 * batch without creating governed output. Initial publication requires the
 * private candidate lock to match the current graph. Checkpoint-bound recovery
 * may instead revalidate the exact immutable historical lock after an earlier
 * output in the same batch has intentionally changed the public graph.
 */
export function buildDevelopmentHostHistoricalEvidenceForBatch(options) {
  assertExactApiArguments(
    options,
    ['root', 'requestId', 'requireCurrentCandidateLock'],
    'Historical development evidence batch item'
  );
  const { root, requestId, requireCurrentCandidateLock } = options;
  if (typeof requireCurrentCandidateLock !== 'boolean') {
    throw codedError(
      'DEVELOPMENT_MIGRATION_EVIDENCE_SOURCE_INVALID',
      'Historical evidence batch candidate-lock applicability must be explicit.'
    );
  }
  const receipt = readFinalizedPrivateReceipt(root, requestId, {
    requireCurrentCandidateLock
  });
  return {
    evidence: structuredClone(receipt.evidence),
    binding: {
      requestId: receipt.request.id,
      requestFingerprint: receipt.request.requestFingerprint,
      resultFingerprint: receipt.result.resultFingerprint,
      observationFingerprint: receipt.observation.observationFingerprint,
      finalizationFingerprint: receipt.runnerChain.receipt.finalizationFingerprint,
      finalizedAt: receipt.runnerChain.receipt.finalizedAt,
      workflow: {
        id: receipt.request.workflow.id,
        version: receipt.request.workflow.version
      },
      host: receipt.request.host.id,
      configuration: {
        name: receipt.request.configuration.name,
        lockPath: receipt.request.configuration.lockPath,
        lockFingerprint: receipt.request.configuration.lockFingerprint,
        graphFingerprint: receipt.request.configuration.graphFingerprint
      },
      workspace: {
        rootIdentityFingerprint: receipt.request.workspace.rootIdentityFingerprint,
        revisionFingerprint: receipt.request.workspace.revisionFingerprint,
        treeFingerprint: receipt.request.workspace.treeFingerprint,
        exactInputState: receipt.request.workspace.exactInputState,
        postTreeFingerprint: receipt.postWorkspace.treeFingerprint,
        postExactInputState: receipt.postWorkspace.exactInputState,
        policyFingerprint: receipt.request.workspace.policyFingerprint,
        settingsFingerprint: receipt.request.workspace.settingsFingerprint
      }
    }
  };
}

/**
 * Build one exact final evidence document for the closed all-workflow
 * publication transaction. This performs the complete private receipt,
 * historical evidence, tombstone, host instruction, and lock binding checks,
 * but deliberately does not write or treat the not-yet-published batch lock as
 * ordinary runtime authority.
 */
export function buildDevelopmentHostFinalEvidenceForBatch(options) {
  assertExactApiArguments(
    options,
    ['root', 'requestId', 'finalLock', 'finalLockPath', 'createdAt'],
    'Final development evidence batch item'
  );
  const { root, requestId, finalLock, finalLockPath, createdAt } = options;
  if (typeof finalLockPath !== 'string'
    || path.posix.normalize(finalLockPath) !== finalLockPath
    || !FINAL_LOCK_PATH.test(finalLockPath)) {
    throw codedError(
      'DEVELOPMENT_ACTIVATION_EVIDENCE_LOCK_INVALID',
      'Final evidence requires one normalized governed fixture lock path.'
    );
  }
  assertInstant(createdAt, 'Final activation evidence createdAt');
  const receipt = readFinalizedPrivateReceipt(root, requestId, {
    requireCurrentCandidateLock: false
  });
  const historicalPath = evidenceRelativePath(receipt.evidence);
  const historicalFile = resolveRepoPath(receipt.root, historicalPath);
  const historicalBytes = Buffer.from(JSON.stringify(receipt.evidence, null, 2) + '\n', 'utf8');
  const historicalEvidence = readExistingGovernedEvidence(
    receipt.root,
    historicalFile,
    historicalBytes,
    'DEVELOPMENT_ACTIVATION_EVIDENCE_HISTORICAL_REFERENCE_INVALID'
  );
  return convertDevelopmentAgentMigrationEvidenceToFinalEvidenceInternal({
    root: receipt.root,
    evidence: historicalEvidence,
    historicalEvidencePath: historicalPath,
    observation: receipt.observation,
    request: receipt.request,
    result: receipt.result,
    trustedAdapter: receipt.trustedAdapter,
    postWorkspace: receipt.postWorkspace,
    migration: receipt.migration,
    finalLockPath,
    finalLockDocument: finalLock,
    createdAt
  }, {
    requireCurrentFinalLock: false
  });
}

/**
 * Retained only as a stable fail-closed API boundary for callers of the former
 * one-workflow publisher. Active host projection requires the complete dual-host
 * evidence set, so publication is now exclusively one closed all-workflow batch.
 */
export function persistDevelopmentHostFinalEvidence(options) {
  assertExactApiArguments(
    options,
    ['root', 'requestId', 'finalLockPath', 'createdAt'],
    'Final development evidence persistence'
  );
  throw codedError(
    'DEVELOPMENT_ACTIVATION_EVIDENCE_BATCH_REQUIRED',
    'Standalone final evidence publication is unavailable; use the exact all-workflow dual-host finalization batch.'
  );
}

export function fingerprintDevelopmentHostObservation(observation) {
  return unsignedFingerprint(observation, 'observationFingerprint');
}
