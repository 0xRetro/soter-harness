import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintWorkflowEvaluatedSubject,
  fingerprintWorkflowEvaluationCase,
  fingerprintWorkflowGuideContent,
  workflowEvaluationVerdict
} from '../kernel/workflow-guides.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import {
  isDevelopmentCandidateLockPath,
  readDevelopmentCandidateLock
} from './development-candidate-locks.mjs';
import {
  renderWorkflowGuideEvaluatedInstructions,
  renderWorkflowGuidePreviewCandidates
} from './host-projections.mjs';
import {
  fingerprintFile,
  fingerprintJson,
  readJson,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import { fingerprintLock, lockMatchesResolution } from './resolve.mjs';
import {
  createDevelopmentRequestState,
  createDevelopmentResultState,
  developmentRequestStatePath,
  developmentResultStatePath,
  hasDevelopmentRequestState,
  hasDevelopmentResultState,
  readDevelopmentRequestState,
  readDevelopmentResultState
} from './runtime-state.mjs';

const REQUEST_CONTRACT = 'soter://contracts/development-request/v1';
const RESULT_CONTRACT = 'soter://contracts/development-result/v1';
const INSPECTION_CONTRACT = 'soter://contracts/development-run-inspection/v1';
const VERSION = '1.0.0';
const REQUEST_SCHEMA = 'soter/contracts/development-request.schema.json';
const RESULT_SCHEMA = 'soter/contracts/development-result.schema.json';
const INSPECTION_SCHEMA = 'soter/contracts/development-run-inspection.schema.json';
const POLICY_PATH = 'soter/kernel/development-workspace.settings.json';
const EXTERNAL_EFFECTS = new Set([
  'provider-read',
  'provider-write',
  'publication',
  'merge',
  'protected-root-mutation',
  'host-realization'
]);
const DEVELOPMENT_EFFECT_POLICY = Object.freeze({
  read: 'allow',
  disclosure: 'prohibit',
  write: 'allow',
  dispatch: 'allow',
  destructive: 'prohibit'
});
const ABSOLUTE_PATH_RE = /(?:^|[\s"'(=])(?:file:\/\/|[A-Za-z]:[\\/]|\/\/[^\s/]+[\\/]|\/(?=$|[),;.!?"'])|\/(?![\/\s])[^\/\s]+)/iu;
const RAW_DIFF_RE = /(?:^|\n)(?:diff --git\s|@@\s+-[0-9])/;

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function codedError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function validate(root, value, relativeSchema, label, code) {
  const failures = validateJsonSchema(value, readJson(path.join(root, relativeSchema)));
  if (failures.length) {
    throw codedError(
      code,
      label + ' does not satisfy its private runtime contract.',
      new Error(failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '))
    );
  }
}

function unsignedFingerprint(value, property) {
  const unsigned = structuredClone(value);
  delete unsigned[property];
  return fingerprintJson(unsigned);
}

function assertDate(value, label, code) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw codedError(code, label + ' must be one valid instant.');
  }
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
  for (const child of Object.values(value)) walkStrings(child, visit);
}

function assertPrivateRecordSafety(value, code) {
  if (containsCredentialMaterial(value)) {
    throw codedError(code, 'Development state cannot contain credential material.');
  }
  walkStrings(value, (item) => {
    if (ABSOLUTE_PATH_RE.test(item)) {
      throw codedError(code, 'Development state cannot contain absolute local paths.');
    }
    if (RAW_DIFF_RE.test(item)) {
      throw codedError(code, 'Development state cannot contain raw diff hunks.');
    }
  });
}

function assertRelativePath(value, label, code) {
  const normalized = path.posix.normalize(value);
  if (path.posix.isAbsolute(value)
    || normalized !== value
    || value === '.'
    || value === '..'
    || value.startsWith('../')
    || value.includes('/../')
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw codedError(code, label + ' must be one normalized repository-relative path.');
  }
}

function assertUnique(items, select, label, code) {
  const values = items.map(select);
  if (new Set(values).size !== values.length) {
    throw codedError(code, label + ' identities must be unique.');
  }
}

function assertContiguous(items, label, code) {
  if (items.some((item, index) => item.sequence !== index + 1)) {
    throw codedError(code, label + ' sequence must be contiguous in document order.');
  }
}

function repositoryFiles(root) {
  try {
    const output = childProcess.execFileSync(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return output.split('\0').filter(Boolean).sort(compareText);
  } catch {
    const files = [];
    const walk = (directory, prefix = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === '.soter' || entry.name === 'node_modules') continue;
        const relative = prefix ? prefix + '/' + entry.name : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute, relative);
        else if (entry.isFile()) files.push(relative);
      }
    };
    walk(root);
    return files.sort(compareText);
  }
}

export function inspectDevelopmentWorkspaceBasis(root) {
  const resolvedRoot = path.resolve(root);
  const files = repositoryFiles(resolvedRoot).map((relative) => {
    assertRelativePath(relative, 'Governed workspace input', 'DEVELOPMENT_WORKSPACE_INVALID');
    const absolute = resolveRepoPath(resolvedRoot, relative);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw codedError(
        'DEVELOPMENT_WORKSPACE_INVALID',
        'Governed development inputs must be regular non-symlink files.'
      );
    }
    return {
      path: relative,
      mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'),
      fingerprint: fingerprintFile(absolute)
    };
  });
  let revisionFingerprint = null;
  let exactInputState = 'unknown';
  try {
    const revision = childProcess.execFileSync(
      'git',
      ['-C', resolvedRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    revisionFingerprint = fingerprintJson({ revision });
    const status = childProcess.execFileSync(
      'git',
      ['-C', resolvedRoot, 'status', '--porcelain=v1', '--untracked-files=all'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    exactInputState = status.length ? 'dirty' : 'clean';
  } catch {
    // A detached contained copy has an exact byte basis even when Git provenance is unavailable.
  }
  return {
    rootIdentityFingerprint: fingerprintJson({ root: fs.realpathSync(resolvedRoot) }),
    revisionFingerprint,
    treeFingerprint: fingerprintJson(files),
    exactInputState
  };
}

function exactLock(root, lockPath, workflowId) {
  if (isDevelopmentCandidateLockPath(root, lockPath)) {
    try {
      return readDevelopmentCandidateLock({
        root,
        lockPath,
        workflowId,
        requireCurrent: true
      });
    } catch (error) {
      throw codedError(
        'DEVELOPMENT_REQUEST_BINDING_STALE',
        'Private development candidate lock is unavailable, unsafe, or stale.',
        error
      );
    }
  }
  const file = resolveRepoPath(root, lockPath);
  const lock = readJson(file);
  const current = lockMatchesResolution({ root, configPath: lock.configuration.path, lock });
  if (!current.matches) {
    throw codedError('DEVELOPMENT_REQUEST_BINDING_STALE', 'Development request requires one current exact configuration lock.');
  }
  return { file, lock };
}

function workflowFiles(root, workflowId) {
  const slug = workflowId.slice('automation.'.length);
  if (!workflowId.startsWith('automation.') || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw codedError('DEVELOPMENT_REQUEST_BINDING_INVALID', 'Development request workflow identity is invalid.');
  }
  const definitionPath = 'soter/automations/' + slug + '/definition.json';
  const guidePath = 'soter/automations/' + slug + '/guide.json';
  const evaluationSetPath = 'soter/automations/' + slug + '/evaluations.json';
  return {
    definitionPath,
    guidePath,
    evaluationSetPath,
    definition: readJson(resolveRepoPath(root, definitionPath)),
    guide: readJson(resolveRepoPath(root, guidePath)),
    evaluations: readJson(resolveRepoPath(root, evaluationSetPath))
  };
}

function exactWorkflowBasis(root, lock, workflowId) {
  const files = workflowFiles(root, workflowId);
  const { definition, guide, evaluations } = files;
  validate(root, definition, 'soter/contracts/workflow-definition.schema.json', 'Workflow definition', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
  validate(root, guide, 'soter/contracts/workflow-guide.schema.json', 'Workflow guide', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
  validate(root, evaluations, 'soter/contracts/workflow-evaluation-set.schema.json', 'Workflow evaluation set', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
  const activation = definition.lifecycle?.activation?.state;
  if (definition.$contract !== 'soter://contracts/workflow-definition/v2'
    || definition.lifecycle.state !== 'active-host-guided'
    || !['candidate', 'active'].includes(activation)
    || guide.$contract !== 'soter://contracts/workflow-guide/v2'
    || guide.status.state !== activation
    || evaluations.$contract !== 'soter://contracts/workflow-evaluation-set/v2'
    || evaluations.lifecycle.state !== 'active-host-guided'
    || evaluations.lifecycle.activation !== activation
    || guide.workflow.id !== workflowId
    || evaluations.workflow !== workflowId
    || definition.guide.path !== files.guidePath
    || definition.evaluationSet.path !== files.evaluationSetPath
    || guide.workflow.definitionFingerprint !== fingerprintJson(definition)
    || guide.workflow.evaluationSetFingerprint !== fingerprintJson(evaluations)
    || guide.contentFingerprint !== fingerprintWorkflowGuideContent(guide)) {
    throw codedError('DEVELOPMENT_REQUEST_BINDING_INVALID', 'Development workflow definition, guide, or evaluation binding is invalid.');
  }
  const selected = lock.packs.filter((item) => item.id === workflowId);
  if (selected.length !== 1 || selected[0].version !== definition.version) {
    throw codedError('DEVELOPMENT_REQUEST_BINDING_INVALID', 'Development workflow is not selected by the exact lock.');
  }
  if (Object.entries(DEVELOPMENT_EFFECT_POLICY).some(([effect, mode]) => {
    return lock.effectPolicies?.[effect]?.mode !== mode;
  })) {
    throw codedError(
      'DEVELOPMENT_REQUEST_EFFECT_POLICY_INVALID',
      'Development request requires the exact request-scoped local effect policy.'
    );
  }
  const adapter = readJson(path.join(root, 'soter', 'hosts', lock.host.id, 'adapter.json'));
  const preview = renderWorkflowGuidePreviewCandidates({
    root,
    adapter,
    configurationId: lock.configuration.name,
    packIds: [workflowId],
    capabilityIds: [],
    effectPolicies: lock.effectPolicies
  });
  if (preview.workflowGuides.length !== 1 || preview.workflowGuides[0].id !== guide.id) {
    throw codedError('DEVELOPMENT_REQUEST_BINDING_INVALID', 'Development workflow has no exact candidate host projection.');
  }
  const evaluatedInstructions = renderWorkflowGuideEvaluatedInstructions({
    root,
    adapter,
    guide,
    definition,
    evaluations,
    effectPolicies: lock.effectPolicies
  });
  return {
    workflow: {
      id: workflowId,
      version: definition.version,
      evaluatedSubjectFingerprint: fingerprintWorkflowEvaluatedSubject({ definition, guide, evaluations }),
      definitionPath: files.definitionPath,
      definitionFingerprint: fingerprintJson(definition),
      guideId: guide.id,
      guidePath: files.guidePath,
      guideContentFingerprint: guide.contentFingerprint,
      guideFingerprint: fingerprintJson(guide),
      evaluationSetId: evaluations.id,
      evaluationSetPath: files.evaluationSetPath,
      evaluationSetFingerprint: fingerprintJson(evaluations)
    },
    host: {
      id: lock.host.id,
      adapter: lock.host.adapter,
      version: lock.host.version,
      adapterFingerprint: lock.host.manifestFingerprint,
      projectionDefinitionId: lock.host.projectionDefinition.id,
      projectionDefinitionFingerprint: lock.host.projectionDefinition.fingerprint,
      evaluatedInstructionFingerprint: evaluatedInstructions.fingerprint,
      candidateProjectionFingerprint: fingerprintJson({
        definition: preview.definition,
        workflowGuides: preview.workflowGuides,
        outputs: preview.outputs
      })
    },
    configuration: {
      name: lock.configuration.name,
      lockFingerprint: fingerprintLock(lock),
      graphFingerprint: lock.graphFingerprint
    },
    definition,
    guide,
    evaluations
  };
}

function assertPersistedRequestBasis(root, request, lockPath = null) {
  const files = workflowFiles(root, request.workflow.id);
  validate(root, files.definition, 'soter/contracts/workflow-definition.schema.json', 'Workflow definition', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
  validate(root, files.guide, 'soter/contracts/workflow-guide.schema.json', 'Workflow guide', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
  validate(root, files.evaluations, 'soter/contracts/workflow-evaluation-set.schema.json', 'Workflow evaluation set', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
  if (fingerprintJson(files.definition) !== request.workflow.definitionFingerprint
    || fingerprintJson(files.guide) !== request.workflow.guideFingerprint
    || fingerprintWorkflowGuideContent(files.guide) !== request.workflow.guideContentFingerprint
    || fingerprintWorkflowEvaluatedSubject({
      definition: files.definition,
      guide: files.guide,
      evaluations: files.evaluations
    }) !== request.workflow.evaluatedSubjectFingerprint
    || fingerprintJson(files.evaluations) !== request.workflow.evaluationSetFingerprint
    || files.definition.guide.path !== request.workflow.guidePath
    || files.definition.evaluationSet.path !== request.workflow.evaluationSetPath
    || files.guide.workflow.id !== request.workflow.id
    || files.evaluations.workflow !== request.workflow.id) {
    throw codedError('DEVELOPMENT_REQUEST_BINDING_STALE', 'Development request workflow source bindings have drifted from the exact private request.');
  }
  const policy = readJson(path.join(root, request.workspace.policyPath));
  if (fingerprintJson(policy) !== request.workspace.policyFingerprint
    || fingerprintJson({ root: fs.realpathSync(root) }) !== request.workspace.rootIdentityFingerprint) {
    throw codedError('DEVELOPMENT_REQUEST_BINDING_STALE', 'Development request workspace identity or policy binding has drifted.');
  }
  const exactLockPath = lockPath || request.configuration.lockPath;
  if (lockPath && lockPath !== request.configuration.lockPath) {
    throw codedError('DEVELOPMENT_REQUEST_BINDING_STALE', 'Development request lock path does not match the exact private request.');
  }
  if (exactLockPath) {
    const { lock } = exactLock(root, exactLockPath, request.workflow.id);
    const exact = exactWorkflowBasis(root, lock, request.workflow.id);
    exact.configuration.lockPath = exactLockPath;
    if (fingerprintLock(lock) !== request.configuration.lockFingerprint
      || lock.graphFingerprint !== request.configuration.graphFingerprint
      || lock.configuration.name !== request.configuration.name
      || fingerprintJson(lock.settings?.['kernel.soter']) !== request.workspace.settingsFingerprint
      || fingerprintJson(exact.workflow) !== fingerprintJson(request.workflow)
      || fingerprintJson(exact.host) !== fingerprintJson(request.host)
      || fingerprintJson(exact.configuration) !== fingerprintJson(request.configuration)) {
      throw codedError('DEVELOPMENT_REQUEST_BINDING_STALE', 'Development request no longer binds the supplied immutable configuration lock.');
    }
  }
  if (request.invocation.kind === 'evaluation-suite') {
    exactEvaluationInvocation(request.invocation, files.evaluations);
  }
  return files;
}

function exactWorkspaceBasis(root, lock) {
  const policy = readJson(path.join(root, POLICY_PATH));
  const configured = lock.settings?.['kernel.soter'];
  if (!configured) {
    throw codedError('DEVELOPMENT_REQUEST_BINDING_INVALID', 'Development request requires selected workspace policy settings.');
  }
  return {
    ...inspectDevelopmentWorkspaceBasis(root),
    policyId: policy.id,
    policyPath: POLICY_PATH,
    policyFingerprint: fingerprintJson(policy),
    settingsFingerprint: fingerprintJson(configured)
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

function exactEvaluationInvocation(invocation, evaluations) {
  const byId = new Map(evaluations.cases.map((item) => [item.id, item]));
  const runs = invocation.plannedRuns;
  assertUnique(runs, (item) => item.id, 'Planned evaluation run', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
  assertContiguous(runs, 'Planned evaluation run', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
  for (const run of runs) {
    const testCase = byId.get(run.caseId);
    if (!testCase
      || run.caseFingerprint !== fingerprintWorkflowEvaluationCase(testCase)
      || run.stimulusFingerprint !== fingerprintJson(testCase.stimulus)
      || (run.arm === 'baseline' && run.guideState !== 'withheld')
      || (run.arm === 'guided' && run.guideState !== 'candidate')) {
      throw codedError('DEVELOPMENT_REQUEST_BINDING_INVALID', 'Evaluation run does not bind one exact case and guide arm.');
    }
  }
  const baseline = runs.filter((item) => item.arm === 'baseline');
  const guided = runs.filter((item) => item.arm === 'guided');
  if (baseline.length !== 1
    || evaluations.evaluationPolicy?.baselineCaseId !== 'happy-path'
    || evaluations.evaluationPolicy?.baselineOutcome !== 'observed-not-gating'
    || baseline[0].caseId !== evaluations.evaluationPolicy.baselineCaseId
    || guided.length !== evaluations.cases.length
    || new Set(guided.map((item) => item.caseId)).size !== evaluations.cases.length) {
    throw codedError('DEVELOPMENT_REQUEST_COVERAGE_INCOMPLETE', 'Evaluation request requires exactly one withheld happy-path baseline and every exact guided case.');
  }
}

export function buildDevelopmentEvaluationInvocation({ root, workflowId, ...unknown } = {}) {
  if (Object.keys(unknown).length > 0) {
    throw codedError(
      'DEVELOPMENT_REQUEST_BINDING_INVALID',
      'Evaluation invocation planning accepts only one repository root and workflow identity.'
    );
  }
  const resolvedRoot = path.resolve(root || '.');
  const files = workflowFiles(resolvedRoot, workflowId);
  validate(
    resolvedRoot,
    files.evaluations,
    'soter/contracts/workflow-evaluation-set.schema.json',
    'Workflow evaluation set',
    'DEVELOPMENT_REQUEST_BINDING_INVALID'
  );
  const baselineCaseId = files.evaluations.evaluationPolicy?.baselineCaseId;
  const baselineCase = files.evaluations.cases.find((item) => item.id === baselineCaseId);
  if (!baselineCase || baselineCaseId !== 'happy-path') {
    throw codedError(
      'DEVELOPMENT_REQUEST_COVERAGE_INCOMPLETE',
      'Evaluation invocation planning requires one exact happy-path baseline case.'
    );
  }
  const slug = workflowId.slice('automation.'.length);
  const row = (testCase, sequence, arm) => ({
    id: arm === 'baseline'
      ? `evaluation-run.${slug}.baseline`
      : `evaluation-run.${slug}.guided.${testCase.id}`,
    sequence,
    caseId: testCase.id,
    caseFingerprint: fingerprintWorkflowEvaluationCase(testCase),
    stimulusFingerprint: fingerprintJson(testCase.stimulus),
    arm,
    guideState: arm === 'baseline' ? 'withheld' : 'candidate'
  });
  const invocation = {
    kind: 'evaluation-suite',
    profile: 'exact',
    freshWorkerPerRun: true,
    expectationsWithheld: true,
    plannedRuns: [
      row(baselineCase, 1, 'baseline'),
      ...files.evaluations.cases.map((testCase, index) => {
        return row(testCase, index + 2, 'guided');
      })
    ]
  };
  exactEvaluationInvocation(invocation, files.evaluations);
  return invocation;
}

function assertRequestSemantics(root, request, lockPath, requireCurrent) {
  if (request.requestFingerprint !== unsignedFingerprint(request, 'requestFingerprint')) {
    throw codedError('DEVELOPMENT_REQUEST_TAMPERED', 'Development request fingerprint does not match its immutable contents.');
  }
  assertDate(request.createdAt, 'Development request createdAt', 'DEVELOPMENT_REQUEST_MALFORMED');
  assertPrivateRecordSafety(request, 'DEVELOPMENT_REQUEST_PRIVATE_MATERIAL_INVALID');
  const targets = request.invocation.kind === 'develop' ? request.invocation.targets : [];
  assertUnique(targets, (item) => item.id, 'Development target', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
  assertUnique(targets, (item) => item.path, 'Development target path', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
  for (const target of targets) assertRelativePath(target.path, 'Development target', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
  if (!requireCurrent) {
    assertPersistedRequestBasis(root, request, lockPath);
    return request;
  }
  const { lock } = exactLock(root, lockPath, request.workflow.id);
  const exact = exactWorkflowBasis(root, lock, request.workflow.id);
  exact.configuration.lockPath = lockPath;
  const workspace = exactWorkspaceBasis(root, lock);
  if (fingerprintJson(request.workflow) !== fingerprintJson(exact.workflow)
    || fingerprintJson(request.host) !== fingerprintJson(exact.host)
    || fingerprintJson(request.configuration) !== fingerprintJson(exact.configuration)
    || fingerprintJson(request.workspace) !== fingerprintJson(workspace)
    || fingerprintJson(request.effectBoundary) !== fingerprintJson(fixedEffectBoundary())
    || fingerprintJson(request.authority) !== fingerprintJson(fixedRequestAuthority())) {
    throw codedError('DEVELOPMENT_REQUEST_BINDING_STALE', 'Development request does not bind the exact current workflow, host projection, lock, workspace, and policy.');
  }
  if (request.invocation.kind === 'evaluation-suite') {
    exactEvaluationInvocation(request.invocation, exact.evaluations);
  }
  return request;
}

export function assertDevelopmentRequest(root, request, { lockPath = null, requireCurrent = false } = {}) {
  const resolvedRoot = path.resolve(root);
  try {
    validate(resolvedRoot, request, REQUEST_SCHEMA, 'Development request', 'DEVELOPMENT_REQUEST_MALFORMED');
    if (requireCurrent && !lockPath) {
      throw codedError('DEVELOPMENT_REQUEST_BINDING_INVALID', 'Current development request validation requires a lock path.');
    }
    return assertRequestSemantics(resolvedRoot, request, lockPath, requireCurrent);
  } catch (error) {
    if (error?.code?.startsWith('DEVELOPMENT_REQUEST_')) throw error;
    throw codedError('DEVELOPMENT_REQUEST_MALFORMED', 'Development request is invalid.', error);
  }
}

function requestIdSuffix(requestId) {
  return requestId.slice('development-request.'.length);
}

export function prepareDevelopmentRequest({
  root,
  lockPath,
  workflowId,
  requestId,
  invocation,
  createdAt = null,
  limitations = ['This private request grants no provider, publication, merge, fallback-removal, or host-realization authority.']
}) {
  const resolvedRoot = path.resolve(root);
  if (hasDevelopmentRequestState(resolvedRoot, requestId)) {
    const existing = readDevelopmentRequestState(resolvedRoot, requestId).request;
    assertDevelopmentRequest(resolvedRoot, existing, { lockPath });
    const suppliedLock = exactLock(resolvedRoot, lockPath, workflowId).lock;
    const sameInputs = existing.workflow.id === workflowId
      && existing.configuration.lockPath === lockPath
      && existing.configuration.lockFingerprint === fingerprintLock(suppliedLock)
      && fingerprintJson(existing.invocation) === fingerprintJson(invocation)
      && fingerprintJson(existing.limitations) === fingerprintJson(limitations)
      && (createdAt === null || existing.createdAt === createdAt);
    if (!sameInputs) {
      throw codedError('DEVELOPMENT_REQUEST_REENTRY_MISMATCH', 'Exact development request re-entry cannot replace different private state.');
    }
    return { request: existing, inspection: inspectDevelopmentRun({ root: resolvedRoot, requestId }) };
  }
  const exactCreatedAt = createdAt || new Date().toISOString();
  const { lock } = exactLock(resolvedRoot, lockPath, workflowId);
  const exact = exactWorkflowBasis(resolvedRoot, lock, workflowId);
  exact.configuration.lockPath = lockPath;
  const workspace = exactWorkspaceBasis(resolvedRoot, lock);
  const request = {
    $contract: REQUEST_CONTRACT,
    contractVersion: VERSION,
    id: requestId,
    requestFingerprint: 'sha256:' + '0'.repeat(64),
    createdAt: exactCreatedAt,
    workflow: exact.workflow,
    host: exact.host,
    configuration: exact.configuration,
    workspace,
    invocation: structuredClone(invocation),
    effectBoundary: fixedEffectBoundary(),
    authority: fixedRequestAuthority(),
    privacy: fixedPrivatePrivacy(),
    limitations: [...limitations]
  };
  request.requestFingerprint = unsignedFingerprint(request, 'requestFingerprint');
  assertDevelopmentRequest(resolvedRoot, request, { lockPath, requireCurrent: true });
  try {
    createDevelopmentRequestState(resolvedRoot, request);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readDevelopmentRequestState(resolvedRoot, requestId).request;
    if (fingerprintJson(existing) !== fingerprintJson(request)) {
      throw codedError('DEVELOPMENT_REQUEST_REENTRY_MISMATCH', 'Exact development request re-entry cannot replace different private state.', error);
    }
  }
  return { request, inspection: inspectDevelopmentRun({ root: resolvedRoot, requestId }) };
}

function resultIdForRequest(requestId) {
  return 'development-result.' + requestIdSuffix(requestId);
}

function resultWorkspaceBinding(workspace) {
  return {
    rootIdentityFingerprint: workspace.rootIdentityFingerprint,
    revisionFingerprint: workspace.revisionFingerprint,
    treeFingerprint: workspace.treeFingerprint,
    exactInputState: workspace.exactInputState,
    policyFingerprint: workspace.policyFingerprint,
    settingsFingerprint: workspace.settingsFingerprint
  };
}

function resultBindings(request) {
  return {
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
    workspace: resultWorkspaceBinding(request.workspace)
  };
}

function expectedCriteria(testCase) {
  return [
    ...testCase.expectedObservations.map((_, index) => ({
      id: testCase.id + '.expected.' + String(index + 1),
      kind: 'expected',
      sequence: index + 1
    })),
    ...testCase.prohibitedOutcomes.map((_, index) => ({
      id: testCase.id + '.prohibited.' + String(index + 1),
      kind: 'prohibited',
      sequence: index + 1
    }))
  ];
}

function assertResultSemantics(root, result, request, lockPath, requireCurrent) {
  if (result.resultFingerprint !== unsignedFingerprint(result, 'resultFingerprint')) {
    throw codedError('DEVELOPMENT_RESULT_TAMPERED', 'Development result fingerprint does not match its immutable contents.');
  }
  assertDate(result.createdAt, 'Development result createdAt', 'DEVELOPMENT_RESULT_MALFORMED');
  assertDate(result.completedAt, 'Development result completedAt', 'DEVELOPMENT_RESULT_MALFORMED');
  if (Date.parse(result.completedAt) < Date.parse(result.createdAt)) {
    throw codedError('DEVELOPMENT_RESULT_MALFORMED', 'Development result cannot complete before it is created.');
  }
  if (Date.parse(result.createdAt) < Date.parse(request.createdAt)) {
    throw codedError('DEVELOPMENT_RESULT_CHRONOLOGY_INVALID', 'Development result cannot predate its exact request.');
  }
  assertPrivateRecordSafety(result, 'DEVELOPMENT_RESULT_PRIVATE_MATERIAL_INVALID');
  const bindings = resultBindings(request);
  if (result.id !== resultIdForRequest(request.id)
    || result.request.id !== request.id
    || result.request.fingerprint !== request.requestFingerprint
    || fingerprintJson(result.workflow) !== fingerprintJson(bindings.workflow)
    || fingerprintJson(result.host) !== fingerprintJson(bindings.host)
    || fingerprintJson(result.configuration) !== fingerprintJson(bindings.configuration)
    || fingerprintJson(result.workspace) !== fingerprintJson(bindings.workspace)
    || result.postWorkspace.rootIdentityFingerprint !== request.workspace.rootIdentityFingerprint
    || result.postWorkspace.policyFingerprint !== request.workspace.policyFingerprint
    || result.postWorkspace.settingsFingerprint !== request.workspace.settingsFingerprint) {
    throw codedError('DEVELOPMENT_RESULT_BINDING_INVALID', 'Development result does not bind its exact immutable request basis.');
  }
  assertUnique(result.workerRuns, (item) => item.id, 'Worker run', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  assertUnique(result.workerRuns, (item) => item.requestRunId, 'Request run', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  assertUnique(result.workerRuns, (item) => item.workerFingerprint, 'Fresh worker', 'DEVELOPMENT_RESULT_FRESH_WORKER_REQUIRED');
  assertUnique(result.workerRuns, (item) => item.dispatchFingerprint, 'Worker dispatch', 'DEVELOPMENT_RESULT_FRESH_WORKER_REQUIRED');
  assertUnique(result.workerRuns, (item) => item.transcriptFingerprint, 'Worker transcript', 'DEVELOPMENT_RESULT_FRESH_WORKER_REQUIRED');
  assertContiguous(result.workerRuns, 'Worker run', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  assertUnique(result.judgments, (item) => item.id, 'Judgment', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  assertUnique(result.judgments, (item) => item.workerRunId, 'Judged worker run', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  assertUnique(result.changes, (item) => item.id, 'Development change', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  assertUnique(result.changes, (item) => item.path, 'Development change path', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  assertUnique(result.checks, (item) => item.id, 'Development check', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  assertUnique(result.effects, (item) => item.category, 'Development effect category', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  assertUnique(result.decisionEvidence, (item) => item.id, 'Decision evidence', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  assertUnique(result.decisionEvidence, (item) => item.reference, 'Decision evidence reference', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  for (const change of result.changes) assertRelativePath(change.path, 'Development change', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  for (const evidence of result.decisionEvidence) assertRelativePath(evidence.reference, 'Decision evidence reference', 'DEVELOPMENT_RESULT_BINDING_INVALID');
  if (result.workerRuns.some((run) => run.answerKeyAccess !== 'not-observed')) {
    throw codedError('DEVELOPMENT_RESULT_ANSWER_KEY_EXPOSED', 'Development result cannot qualify when answer-key access was observed or unknown.');
  }
  const workerRunById = new Map(result.workerRuns.map((run) => [run.id, run]));
  if (result.judgments.some((judgment) => {
    const workerRun = workerRunById.get(judgment.workerRunId);
    return workerRun?.arm !== 'baseline' && judgment.criteria.some((criterion) => {
      return criterion.kind === 'prohibited' && criterion.state !== 'not-observed';
    });
  })) {
    throw codedError('DEVELOPMENT_RESULT_PROHIBITED_OUTCOME', 'Development result cannot qualify when a prohibited outcome was observed or unknown.');
  }
  if (result.judgments.some((judgment) => {
    return judgment.verdict !== workflowEvaluationVerdict(judgment.criteria);
  })) {
    throw codedError(
      'DEVELOPMENT_RESULT_VERDICT_INVALID',
      'Every development judgment verdict must agree with its exact criterion observations.'
    );
  }
  for (const effect of result.effects) {
    const expectedScope = EXTERNAL_EFFECTS.has(effect.category) ? 'separate-authority' : 'request-scoped';
    if (effect.scope !== expectedScope
      || (EXTERNAL_EFFECTS.has(effect.category) && effect.state === 'observed')) {
      throw codedError('DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED', 'Development result cannot claim an external effect through request-only authority.');
    }
  }
  if (request.invocation.kind === 'evaluation-suite') {
    if (result.state === 'passed') {
      const externalEffects = result.effects.filter((effect) => EXTERNAL_EFFECTS.has(effect.category));
      if (externalEffects.length !== EXTERNAL_EFFECTS.size
        || externalEffects.some((effect) => {
          return effect.scope !== 'separate-authority'
            || effect.state !== 'not-observed'
            || effect.count !== 0
            || effect.observedFingerprint !== null;
        })
        || [...EXTERNAL_EFFECTS].some((category) => {
          return !externalEffects.some((effect) => effect.category === category);
        })) {
        throw codedError(
          'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED',
          'A passed evaluation result requires an explicit exact no-effect observation for every governed external effect category.'
        );
      }
    }
    if (fingerprintJson(result.postWorkspace) !== fingerprintJson(bindings.workspace)) {
      throw codedError(
        'DEVELOPMENT_RESULT_WORKSPACE_DRIFT',
        'Evaluation result requires identical exact pre-run and post-run controller workspace bindings.'
      );
    }
    const planned = new Map(request.invocation.plannedRuns.map((item) => [item.id, item]));
    const files = workflowFiles(root, request.workflow.id);
    const cases = new Map(files.evaluations.cases.map((item) => [item.id, item]));
    if (result.workerRuns.length !== planned.size || result.judgments.length !== planned.size) {
      throw codedError('DEVELOPMENT_RESULT_COVERAGE_INCOMPLETE', 'Development result must cover every exact requested worker run and judgment.');
    }
    for (const run of result.workerRuns) {
      const source = planned.get(run.requestRunId);
      if (!source
        || run.caseId !== source.caseId
        || run.arm !== source.arm
        || run.guideState !== source.guideState
        || run.expectationsIncluded !== false) {
        throw codedError('DEVELOPMENT_RESULT_BINDING_INVALID', 'Worker result does not match its exact requested case and arm.');
      }
      const judgment = result.judgments.find((item) => item.workerRunId === run.id);
      const testCase = cases.get(run.caseId);
      const expected = expectedCriteria(testCase);
      const actual = judgment?.criteria.map(({ id, kind, sequence }) => ({ id, kind, sequence }));
      if (!judgment
        || judgment.caseId !== run.caseId
        || fingerprintJson(actual) !== fingerprintJson(expected)
        || judgment.criteria.some((item) => item.evidenceFingerprint === null)) {
        throw codedError('DEVELOPMENT_RESULT_COVERAGE_INCOMPLETE', 'Judgment does not cover every exact expected and prohibited criterion.');
      }
    }
    if (result.state === 'passed') {
      const guidedIds = new Set(result.workerRuns.filter((item) => item.arm === 'guided').map((item) => item.id));
      const guidedPassed = result.workerRuns.filter((item) => item.arm === 'guided')
        .every((item) => item.state === 'passed');
      const guidedJudgmentsPassed = result.judgments
        .filter((item) => guidedIds.has(item.workerRunId))
        .every((item) => item.verdict === 'passed'
          && item.criteria.every((criterion) => criterion.kind === 'expected'
            ? criterion.state === 'observed'
            : criterion.state === 'not-observed'));
      if (!guidedPassed || !guidedJudgmentsPassed || result.checks.some((item) => item.state !== 'passed')) {
        throw codedError('DEVELOPMENT_RESULT_PASS_UNSUPPORTED', 'A passed result requires every guided case, criterion, and check to pass.');
      }
    }
  }
  if (requireCurrent) {
    assertDevelopmentRequest(root, request, { lockPath, requireCurrent: true });
    const { lock } = exactLock(root, lockPath, request.workflow.id);
    const currentWorkspace = exactWorkspaceBasis(root, lock);
    if (fingerprintJson(result.postWorkspace) !== fingerprintJson(resultWorkspaceBinding(currentWorkspace))) {
      throw codedError('DEVELOPMENT_RESULT_BINDING_STALE', 'Development result post-run workspace or lock basis is stale.');
    }
  }
  return result;
}

export function assertDevelopmentResult(root, result, request, { lockPath = null, requireCurrent = false } = {}) {
  const resolvedRoot = path.resolve(root);
  try {
    validate(resolvedRoot, result, RESULT_SCHEMA, 'Development result', 'DEVELOPMENT_RESULT_MALFORMED');
    return assertResultSemantics(resolvedRoot, result, request, lockPath, requireCurrent);
  } catch (error) {
    if (error?.code?.startsWith('DEVELOPMENT_RESULT_') || error?.code?.startsWith('DEVELOPMENT_REQUEST_')) throw error;
    throw codedError('DEVELOPMENT_RESULT_MALFORMED', 'Development result is invalid.', error);
  }
}

function fixedResultAuthority() {
  return {
    kind: 'development-evidence-only',
    grantsExecution: false,
    grantsApproval: false,
    grantsPublication: false,
    grantsMerge: false,
    grantsProviderWrite: false,
    grantsFallbackRemoval: false
  };
}

export function recordDevelopmentResult({
  root,
  lockPath,
  requestId,
  outcome,
  completedAt = null
}) {
  const resolvedRoot = path.resolve(root);
  const request = readDevelopmentRequestState(resolvedRoot, requestId).request;
  assertDevelopmentRequest(resolvedRoot, request, { lockPath, requireCurrent: true });
  const resultId = resultIdForRequest(requestId);
  const existingResult = hasDevelopmentResultState(resolvedRoot, resultId)
    ? readDevelopmentResultState(resolvedRoot, resultId).result
    : null;
  const exactCompletedAt = completedAt || existingResult?.completedAt || new Date().toISOString();
  const bindings = resultBindings(request);
  const { lock } = exactLock(resolvedRoot, lockPath, request.workflow.id);
  const observedPostWorkspace = exactWorkspaceBasis(resolvedRoot, lock);
  const postWorkspace = resultWorkspaceBinding(observedPostWorkspace);
  const result = {
    $contract: RESULT_CONTRACT,
    contractVersion: VERSION,
    id: resultId,
    resultFingerprint: 'sha256:' + '0'.repeat(64),
    createdAt: exactCompletedAt,
    completedAt: exactCompletedAt,
    request: { id: request.id, fingerprint: request.requestFingerprint },
    ...bindings,
    postWorkspace,
    state: outcome.state,
    workerRuns: structuredClone(outcome.workerRuns || []),
    judgments: structuredClone(outcome.judgments || []),
    changes: structuredClone(outcome.changes || []),
    checks: structuredClone(outcome.checks || []),
    effects: structuredClone(outcome.effects || []),
    promotion: structuredClone(outcome.promotion),
    decisionEvidence: structuredClone(outcome.decisionEvidence || []),
    authority: fixedResultAuthority(),
    privacy: fixedPrivatePrivacy(),
    limitations: [...(outcome.limitations || ['This result is scoped development evidence and grants no operational or migration authority.'])]
  };
  result.resultFingerprint = unsignedFingerprint(result, 'resultFingerprint');
  assertDevelopmentResult(resolvedRoot, result, request, { lockPath, requireCurrent: true });
  if (existingResult) {
    const existing = existingResult;
    assertDevelopmentResult(resolvedRoot, existing, request);
    if (fingerprintJson(existing) !== fingerprintJson(result)) {
      throw codedError('DEVELOPMENT_RESULT_REENTRY_MISMATCH', 'Exact development result re-entry cannot replace different private state.');
    }
    return { result: existing, inspection: inspectDevelopmentRun({ root: resolvedRoot, requestId }) };
  }
  try {
    createDevelopmentResultState(resolvedRoot, result);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readDevelopmentResultState(resolvedRoot, resultId).result;
    if (fingerprintJson(existing) !== fingerprintJson(result)) {
      throw codedError('DEVELOPMENT_RESULT_REENTRY_MISMATCH', 'Concurrent development result re-entry cannot replace different private state.', error);
    }
  }
  return { result, inspection: inspectDevelopmentRun({ root: resolvedRoot, requestId }) };
}

function inspectionFingerprint(inspection) {
  return unsignedFingerprint(inspection, 'inspectionFingerprint');
}

export function inspectDevelopmentRun({ root, requestId }) {
  const resolvedRoot = path.resolve(root);
  const request = readDevelopmentRequestState(resolvedRoot, requestId).request;
  assertDevelopmentRequest(resolvedRoot, request);
  const resultId = resultIdForRequest(requestId);
  let result = null;
  if (hasDevelopmentResultState(resolvedRoot, resultId)) {
    result = readDevelopmentResultState(resolvedRoot, resultId).result;
    assertDevelopmentResult(resolvedRoot, result, request);
  }
  const targetIds = request.invocation.kind === 'develop'
    ? request.invocation.targets.map((item) => item.id)
    : [];
  const plannedRuns = request.invocation.kind === 'evaluation-suite'
    ? request.invocation.plannedRuns.map(({ id, sequence, caseId, arm, guideState }) => ({
        id,
        sequence,
        caseId,
        arm,
        guideState
      }))
    : [];
  const inspection = {
    $contract: INSPECTION_CONTRACT,
    contractVersion: VERSION,
    request: { id: request.id, fingerprint: request.requestFingerprint, createdAt: request.createdAt },
    result: result ? { id: result.id, fingerprint: result.resultFingerprint, state: result.state, completedAt: result.completedAt } : null,
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
    invocation: { kind: request.invocation.kind, profile: request.invocation.profile, targetIds, plannedRuns },
    progress: {
      state: result?.state || 'requested',
      completedRuns: result?.workerRuns.length || 0,
      totalRuns: plannedRuns.length,
      judgments: result?.judgments.length || 0
    },
    changes: (result?.changes || []).map(({ id, kind, beforeFingerprint, afterFingerprint }) => ({ id, kind, beforeFingerprint, afterFingerprint })),
    checks: structuredClone(result?.checks || []),
    effects: structuredClone(result?.effects || []),
    promotion: result
      ? { ...structuredClone(result.promotion), decisionEvidenceIds: result.decisionEvidence.map((item) => item.id) }
      : { state: 'not-requested', artifactFingerprint: null, reasonCode: 'DEVELOPMENT_RESULT_NOT_RECORDED', decisionEvidenceIds: [] },
    authority: {
      kind: 'inspection-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsPublication: false,
      grantsMerge: false,
      grantsProviderWrite: false,
      grantsFallbackRemoval: false
    },
    privacy: {
      absolutePathsIncluded: false,
      targetPathsIncluded: false,
      requestedOutcomeIncluded: false,
      rawDiffsIncluded: false,
      rawTranscriptsIncluded: false,
      providerResponsesIncluded: false,
      credentialsIncluded: false
    },
    limitations: [
      'Private requested outcomes, target paths, worker transcripts, raw diffs, and result prose are excluded from this inspection.',
      'Inspection does not grant execution, approval, publication, merge, provider-write, host-realization, promotion, or fallback-removal authority.'
    ].sort(compareText),
    inspectionFingerprint: 'sha256:' + '0'.repeat(64)
  };
  inspection.inspectionFingerprint = inspectionFingerprint(inspection);
  validate(resolvedRoot, inspection, INSPECTION_SCHEMA, 'Development run inspection', 'DEVELOPMENT_INSPECTION_INVALID');
  return inspection;
}

export function listDevelopmentRunInspections({ root }) {
  const resolvedRoot = path.resolve(root);
  const directory = path.dirname(developmentRequestStatePath(resolvedRoot, 'development-request.placeholder'));
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort(compareText)
    .map((requestId) => inspectDevelopmentRun({ root: resolvedRoot, requestId }));
}

export function developmentPrivateStateFiles(root, requestId) {
  return {
    request: developmentRequestStatePath(root, requestId),
    result: developmentResultStatePath(root, resultIdForRequest(requestId))
  };
}
