import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintWorkflowEvaluatedSubject,
  fingerprintWorkflowGuideContent,
  workflowEvaluationVerdict
} from '../kernel/workflow-guides.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
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

const OBSERVATION_CONTRACT = 'soter://contracts/development-host-observation/v1';
const OBSERVATION_SCHEMA = 'soter/contracts/development-host-observation.schema.json';
const REQUEST_SCHEMA = 'soter/contracts/development-request.schema.json';
const RESULT_SCHEMA = 'soter/contracts/development-result.schema.json';
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
const ABSOLUTE_PATH_RE = /(?:^|[\s"'(=])(?:file:\/\/|[A-Za-z]:[\\/]|\/\/[^\s/]+[\\/]|\/(?=$|[),;.!?"'])|\/(?![\/\s])[^\/\s]+)/iu;
const RAW_DIFF_RE = /(?:^|\n)(?:diff --git\s|@@\s+-[0-9]|---\s+(?:a\/|\/)|\+\+\+\s+(?:b\/|\/))/u;

function codedError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
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
    untargetedTreeFingerprint: request.workspace.untargetedTreeFingerprint,
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
    managedManifestFingerprint: request.host.managedManifestFingerprint,
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
        'Every guided run and exact expected criterion must pass for this observation to be valid.'
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
 * Revalidate the exact private candidate-lock document observed by one
 * development request. Callers may require the lock to match the current graph.
 */
export function assertDevelopmentCandidateLock({
  root,
  request,
  requireCurrent = false
}) {
  const resolvedRoot = path.resolve(root);
  if (!isDevelopmentCandidateLockPath(resolvedRoot, request?.configuration?.lockPath)) {
    throw codedError(
      'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_INVALID',
      'Host observation requires one exact private development candidate lock.'
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
        : 'Candidate lock bytes are unavailable, unsafe, or invalid.',
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
      'Candidate lock does not bind the exact canonical lock bytes, workflow artifact basis, semantic request fingerprint, and host basis.'
    );
  }
  return exact;
}

function assertCandidateLockForObservation(root, request, { requireCurrent, requirePrivate }) {
  if (!isDevelopmentCandidateLockPath(root, request.configuration.lockPath)) {
    if (requirePrivate) {
      throw codedError(
        'DEVELOPMENT_HOST_OBSERVATION_CANDIDATE_LOCK_INVALID',
        'Host observation requires one private development candidate lock.'
      );
    }
    return null;
  }
  return assertDevelopmentCandidateLock({ root, request, requireCurrent });
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

export function fingerprintDevelopmentHostObservation(observation) {
  return unsignedFingerprint(observation, 'observationFingerprint');
}
