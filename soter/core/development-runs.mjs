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
  inspectHistoricalManagedHostProjectionBasis,
  inspectManagedHostProjectionOwnership
} from './host-realizations.mjs';
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
  listHostManagedManifestDocuments,
  readActiveConfigurationLockState,
  readDevelopmentRequestState,
  readDevelopmentResultState,
  readHostManagedManifestState
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
const LOCAL_EFFECT_FIELDS = Object.freeze({
  'local-workspace-read': 'localWorkspaceRead',
  'local-workspace-write': 'localWorkspaceWrite',
  'local-command': 'localCommand',
  'subagent-dispatch': 'subagentDispatch'
});
const LOCAL_EFFECTS = Object.freeze(Object.keys(LOCAL_EFFECT_FIELDS));
const PROTECTED_TOP_LEVEL = new Set([
  '.agents',
  '.claude',
  '.claude-plugin',
  '.codex',
  '.git',
  '.soter',
  'node_modules'
]);
const PROTECTED_ROOT_FILES = new Set(['AGENTS.md', 'CLAUDE.md', '.mcp.json']);
const HOST_ADAPTER_PATH = /^soter\/hosts\/[a-z0-9]+(?:-[a-z0-9]+)*\/adapter[.]json$/;
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

function managedHostOutputPaths(root, { requireCurrent = true } = {}) {
  let documents;
  try {
    documents = listHostManagedManifestDocuments(root);
  } catch (error) {
    throw codedError(
      'DEVELOPMENT_REQUEST_TARGET_INVALID',
      'Managed host output ownership is unavailable or malformed.',
      error
    );
  }
  const paths = new Set();
  for (const { manifest } of documents) {
    try {
      validate(
        root,
        manifest,
        'soter/contracts/host-managed-manifest.schema.json',
        'Managed host manifest',
        'DEVELOPMENT_REQUEST_TARGET_INVALID'
      );
      const unsigned = structuredClone(manifest);
      delete unsigned.manifestFingerprint;
      if (fingerprintJson(unsigned) !== manifest.manifestFingerprint) {
        throw new Error('Managed host manifest fingerprint is invalid.');
      }
      if (requireCurrent) {
        const ownership = inspectManagedHostProjectionOwnership({ root, host: manifest.host });
        if (ownership.state !== 'realized'
          || ownership.manifestFingerprint !== manifest.manifestFingerprint) {
          throw new Error('Managed host ownership is not current.');
        }
      }
      for (const output of manifest.outputs) paths.add(output.path);
    } catch (error) {
      if (error?.code === 'DEVELOPMENT_REQUEST_TARGET_INVALID') throw error;
      throw codedError(
        'DEVELOPMENT_REQUEST_TARGET_INVALID',
        'Managed host output ownership is unavailable or stale.',
        error
      );
    }
  }
  return paths;
}

export function assertDevelopmentTargetAllowed(
  root,
  targetPath,
  { requireCurrentManagedOwnership = true } = {}
) {
  assertRelativePath(
    targetPath,
    'Development target',
    'DEVELOPMENT_REQUEST_TARGET_INVALID'
  );
  const first = targetPath.split('/')[0];
  if (PROTECTED_TOP_LEVEL.has(first)
    || PROTECTED_ROOT_FILES.has(targetPath)
    || targetPath === POLICY_PATH
    || HOST_ADAPTER_PATH.test(targetPath)
    || managedHostOutputPaths(path.resolve(root), {
      requireCurrent: requireCurrentManagedOwnership
    }).has(targetPath)) {
    throw codedError(
      'DEVELOPMENT_REQUEST_TARGET_INVALID',
      'Development target is protected or owned by governed host realization.'
    );
  }
  return targetPath;
}

export function inspectDevelopmentTarget(root, target, options = {}) {
  const resolvedRoot = path.resolve(root);
  assertDevelopmentTargetAllowed(resolvedRoot, target.path, options);
  const absolute = resolveRepoPath(resolvedRoot, target.path);
  const relative = path.relative(resolvedRoot, absolute).split(path.sep).join('/');
  if (relative !== target.path) {
    throw codedError(
      'DEVELOPMENT_REQUEST_TARGET_INVALID',
      'Development target path is not normalized.'
    );
  }
  const parts = target.path.split('/');
  let current = resolvedRoot;
  let missing = false;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (index !== parts.length - 1) {
        throw codedError(
          'DEVELOPMENT_REQUEST_TARGET_INVALID',
          'Development target parent directories must already exist and be ordinary.'
        );
      }
      missing = true;
      continue;
    }
    if (missing || stat.isSymbolicLink()) {
      throw codedError(
        'DEVELOPMENT_REQUEST_TARGET_INVALID',
        'Development target ancestry is unavailable or unsafe.'
      );
    }
    const leaf = index === parts.length - 1;
    if ((!leaf && !stat.isDirectory())
      || (leaf && (!stat.isFile()
        || stat.nlink !== 1
        || (stat.mode & 0o7000) !== 0))) {
      throw codedError(
        'DEVELOPMENT_REQUEST_TARGET_INVALID',
        'Development target must be one exact ordinary non-linked file or a safe missing path.'
      );
    }
  }
  return {
    id: target.id,
    path: target.path,
    beforeFingerprint: missing ? null : fingerprintFile(absolute),
    beforeMode: missing
      ? null
      : (fs.lstatSync(absolute).mode & 0o7777).toString(8).padStart(4, '0')
  };
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

export function inspectDevelopmentWorkspaceBasis(root, { excludedPaths = [] } = {}) {
  const resolvedRoot = path.resolve(root);
  const excluded = new Set(excludedPaths);
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
    untargetedTreeFingerprint: fingerprintJson(files.filter((item) => !excluded.has(item.path))),
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
  if (definition.$contract !== 'soter://contracts/workflow-definition/v2'
    || definition.id !== workflowId
    || definition.lifecycle.state !== 'active-host-guided'
    || definition.lifecycle.development.requestContract.id !== 'soter://contracts/development-request/v1'
    || definition.lifecycle.development.requestContract.path !== 'soter/contracts/development-request.schema.json'
    || definition.lifecycle.development.resultContract.id !== 'soter://contracts/development-result/v1'
    || definition.lifecycle.development.resultContract.path !== 'soter/contracts/development-result.schema.json'
    || guide.$contract !== 'soter://contracts/workflow-guide/v2'
    || guide.status.state !== 'active'
    || evaluations.$contract !== 'soter://contracts/workflow-evaluation-set/v2'
    || evaluations.lifecycle.state !== 'active-host-guided'
    || guide.workflow.id !== workflowId
    || guide.workflow.version !== definition.version
    || guide.workflow.definitionPath !== files.definitionPath
    || guide.workflow.evaluationSetPath !== files.evaluationSetPath
    || evaluations.workflow !== workflowId
    || evaluations.version !== definition.version
    || definition.guide.id !== guide.id
    || definition.guide.path !== files.guidePath
    || definition.evaluationSet.id !== evaluations.id
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
    throw codedError('DEVELOPMENT_REQUEST_BINDING_INVALID', 'Development workflow has no exact current host projection.');
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
    projectedGuideOutputs: preview.outputs.map((output) => ({
      id: output.id,
      path: output.path,
      role: output.role,
      mode: output.mode,
      contentFingerprint: output.contentFingerprint,
      fingerprint: output.fingerprint
    })).sort((left, right) => compareText(left.path, right.path)),
    definition,
    guide,
    evaluations
  };
}

function exactManagedHostBasis(root, lock, exact) {
  let ownership;
  let manifest;
  let activeLock;
  try {
    ownership = inspectManagedHostProjectionOwnership({ root, host: lock.host.id });
    if (ownership.state !== 'realized') {
      throw new Error('The selected host has no exact current managed projection.');
    }
    manifest = readHostManagedManifestState(root, lock.host.id).manifest;
    validate(
      root,
      manifest,
      'soter/contracts/host-managed-manifest.schema.json',
      'Managed host manifest',
      'DEVELOPMENT_REQUEST_HOST_REALIZATION_STALE'
    );
    activeLock = readActiveConfigurationLockState(root, manifest.configuration.name).lock;
  } catch (error) {
    if (error?.code === 'DEVELOPMENT_REQUEST_HOST_REALIZATION_STALE') throw error;
    throw codedError(
      'DEVELOPMENT_REQUEST_HOST_REALIZATION_STALE',
      'Development request requires one current exact realized host projection.',
      error
    );
  }
  if (ownership.manifestFingerprint !== manifest.manifestFingerprint
    || manifest.host !== lock.host.id
    || manifest.configuration.name !== lock.configuration.name
    || manifest.configuration.lockFingerprint !== fingerprintLock(lock)
    || manifest.configuration.graphFingerprint !== lock.graphFingerprint
    || fingerprintLock(activeLock) !== fingerprintLock(lock)
    || activeLock.graphFingerprint !== lock.graphFingerprint
    || activeLock.configuration.name !== lock.configuration.name) {
    throw codedError(
      'DEVELOPMENT_REQUEST_HOST_REALIZATION_STALE',
      'Development request candidate lock does not match the exact active realized host projection.'
    );
  }
  const prefix = `output.${lock.host.id}.workflow-guide.${exact.guide.skill.name}.`;
  const realizedGuideOutputs = manifest.outputs
    .filter((output) => output.id.startsWith(prefix))
    .map((output) => ({
      id: output.id,
      path: output.path,
      role: output.role,
      mode: output.mode,
      contentFingerprint: output.contentFingerprint,
      fingerprint: output.fingerprint
    }))
    .sort((left, right) => compareText(left.path, right.path));
  if (fingerprintJson(realizedGuideOutputs) !== fingerprintJson(exact.projectedGuideOutputs)) {
    throw codedError(
      'DEVELOPMENT_REQUEST_HOST_REALIZATION_STALE',
      'The active workflow guide is not exactly realized by the managed host projection.'
    );
  }
  return manifest.manifestFingerprint;
}

function requestTargetPaths(request) {
  return request.invocation.kind === 'develop'
    ? request.invocation.targets.map((target) => target.path)
    : [];
}

function requestAllowsWorkspaceWrite(request) {
  return request.invocation.requestedLocalEffects.includes('local-workspace-write');
}

function requestUsesTargetWriteClosure(request) {
  return request.invocation.kind === 'develop' && requestAllowsWorkspaceWrite(request);
}

function exactCurrentRequestBasis(root, request, lockPath = null) {
  const exactLockPath = lockPath || request.configuration.lockPath;
  if (lockPath && lockPath !== request.configuration.lockPath) {
    throw codedError(
      'DEVELOPMENT_REQUEST_BINDING_STALE',
      'Development request lock path does not match its immutable binding.'
    );
  }
  const targetPaths = requestTargetPaths(request);
  if (request.invocation.kind === 'develop') {
    for (const target of request.invocation.targets) {
      let current;
      try {
        current = inspectDevelopmentTarget(root, target);
      } catch (error) {
        throw codedError(
          'DEVELOPMENT_REQUEST_TARGET_STALE',
          'A development target is now unavailable, unsafe, protected, or managed.',
          error
        );
      }
      if (current.beforeFingerprint !== target.beforeFingerprint
        || current.beforeMode !== target.beforeMode) {
        throw codedError(
          'DEVELOPMENT_REQUEST_TARGET_STALE',
          'A development target has drifted from its exact pre-effect request bytes or mode.'
        );
      }
    }
  }
  const { lock } = exactLock(root, exactLockPath, request.workflow.id);
  const exact = exactWorkflowBasis(root, lock, request.workflow.id);
  exact.configuration.lockPath = exactLockPath;
  exact.host.managedManifestFingerprint = exactManagedHostBasis(root, lock, exact);
  if (fingerprintLock(lock) !== request.configuration.lockFingerprint
    || lock.graphFingerprint !== request.configuration.graphFingerprint
    || lock.configuration.name !== request.configuration.name
    || fingerprintJson(exact.workflow) !== fingerprintJson(request.workflow)
    || fingerprintJson(exact.host) !== fingerprintJson(request.host)
    || fingerprintJson(exact.configuration) !== fingerprintJson(request.configuration)) {
    throw codedError(
      'DEVELOPMENT_REQUEST_BINDING_STALE',
      'Development request workflow, lock, configuration, or host binding has drifted.'
    );
  }
  if (request.invocation.kind === 'evaluation-suite') {
    exactEvaluationInvocation(request.invocation, exact.evaluations);
  }

  const workspace = exactWorkspaceBasis(root, lock, targetPaths);
  const commonWorkspaceCurrent = workspace.rootIdentityFingerprint === request.workspace.rootIdentityFingerprint
    && workspace.policyId === request.workspace.policyId
    && workspace.policyPath === request.workspace.policyPath
    && workspace.policyFingerprint === request.workspace.policyFingerprint
    && workspace.settingsFingerprint === request.workspace.settingsFingerprint;
  const treeCurrent = requestAllowsWorkspaceWrite(request)
    ? workspace.untargetedTreeFingerprint === request.workspace.untargetedTreeFingerprint
    : workspace.treeFingerprint === request.workspace.treeFingerprint
      && workspace.untargetedTreeFingerprint === request.workspace.untargetedTreeFingerprint
      && workspace.revisionFingerprint === request.workspace.revisionFingerprint
      && workspace.exactInputState === request.workspace.exactInputState;
  if (!commonWorkspaceCurrent || !treeCurrent) {
    throw codedError(
      'DEVELOPMENT_REQUEST_WORKSPACE_STALE',
      'Development request workspace or policy basis has drifted outside its authorized targets.'
    );
  }
  return { lock, exact, workspace };
}

function exactWriteClosureBasis(root, request, lockPath = null) {
  if (!requestAllowsWorkspaceWrite(request)) {
    throw codedError(
      'DEVELOPMENT_REQUEST_BINDING_STALE',
      'Write closure requires one exact request that declared local workspace write.'
    );
  }
  const exactLockPath = lockPath || request.configuration.lockPath;
  if (exactLockPath !== request.configuration.lockPath) {
    throw codedError(
      'DEVELOPMENT_REQUEST_BINDING_STALE',
      'Write closure lock path does not match its immutable request.'
    );
  }
  let lock;
  try {
    lock = readDevelopmentCandidateLock({
      root,
      lockPath: exactLockPath,
      workflowId: request.workflow.id,
      requireCurrent: false,
      expectedLockFingerprint: request.configuration.lockFingerprint
    }).lock;
  } catch (error) {
    throw codedError(
      'DEVELOPMENT_REQUEST_BINDING_STALE',
      'Write closure requires the immutable content-addressed request lock.',
      error
    );
  }
  if (fingerprintLock(lock) !== request.configuration.lockFingerprint
    || lock.graphFingerprint !== request.configuration.graphFingerprint
    || lock.configuration.name !== request.configuration.name
    || lock.host.id !== request.host.id
    || lock.host.manifestFingerprint !== request.host.adapterFingerprint
    || lock.host.projectionDefinition.fingerprint !== request.host.projectionDefinitionFingerprint
    || fingerprintJson(lock.settings?.['kernel.soter']) !== request.workspace.settingsFingerprint) {
    throw codedError(
      'DEVELOPMENT_REQUEST_BINDING_STALE',
      'Immutable write-closure lock does not match the exact request bindings.'
    );
  }
  let activeLock;
  try {
    activeLock = readActiveConfigurationLockState(root, request.configuration.name).lock;
    inspectHistoricalManagedHostProjectionBasis({
      root,
      host: request.host.id,
      manifestFingerprint: request.host.managedManifestFingerprint,
      configurationFingerprint: lock.configuration.fingerprint
    });
  } catch (error) {
    throw codedError(
      'DEVELOPMENT_REQUEST_HOST_REALIZATION_STALE',
      'Write closure requires the exact original active lock, private configuration, and managed host projection.',
      error
    );
  }
  if (fingerprintLock(activeLock) !== request.configuration.lockFingerprint
    || activeLock.graphFingerprint !== request.configuration.graphFingerprint
    || activeLock.configuration.name !== request.configuration.name
    || activeLock.configuration.fingerprint !== lock.configuration.fingerprint) {
    throw codedError(
      'DEVELOPMENT_REQUEST_HOST_REALIZATION_STALE',
      'Original active lock or private configuration drifted from the write request.'
    );
  }
  for (const target of request.invocation.targets) {
    try {
      inspectDevelopmentTarget(root, target, { requireCurrentManagedOwnership: false });
    } catch (error) {
      throw codedError(
        'DEVELOPMENT_REQUEST_TARGET_STALE',
        'Write closure target is unavailable, unsafe, protected, or managed.',
        error
      );
    }
  }
  const workspace = exactWorkspaceBasis(root, lock, requestTargetPaths(request));
  if (workspace.rootIdentityFingerprint !== request.workspace.rootIdentityFingerprint
    || workspace.policyId !== request.workspace.policyId
    || workspace.policyPath !== request.workspace.policyPath
    || workspace.policyFingerprint !== request.workspace.policyFingerprint
    || workspace.settingsFingerprint !== request.workspace.settingsFingerprint
    || workspace.untargetedTreeFingerprint !== request.workspace.untargetedTreeFingerprint) {
    throw codedError(
      'DEVELOPMENT_REQUEST_WORKSPACE_STALE',
      'Workspace drift outside the exact authorized targets blocks write closure.'
    );
  }
  return { lock, workspace };
}

function developmentRequestApplicability(root, request) {
  try {
    exactCurrentRequestBasis(root, request);
    return { state: 'current', reasonCode: 'DEVELOPMENT_REQUEST_CURRENT' };
  } catch (error) {
    const reasonCode = [
      'DEVELOPMENT_REQUEST_BINDING_STALE',
      'DEVELOPMENT_REQUEST_HOST_REALIZATION_STALE',
      'DEVELOPMENT_REQUEST_TARGET_STALE',
      'DEVELOPMENT_REQUEST_WORKSPACE_STALE'
    ].includes(error?.code)
      ? error.code
      : 'DEVELOPMENT_REQUEST_BINDING_STALE';
    return { state: 'stale', reasonCode };
  }
}

function exactWorkspaceBasis(root, lock, targetPaths = []) {
  const policy = readJson(path.join(root, POLICY_PATH));
  const configured = lock.settings?.['kernel.soter'];
  if (!configured) {
    throw codedError('DEVELOPMENT_REQUEST_BINDING_INVALID', 'Development request requires selected workspace policy settings.');
  }
  return {
    ...inspectDevelopmentWorkspaceBasis(root, { excludedPaths: targetPaths }),
    policyId: policy.id,
    policyPath: POLICY_PATH,
    policyFingerprint: fingerprintJson(policy),
    settingsFingerprint: fingerprintJson(configured)
  };
}

function canonicalRequestedLocalEffects(value, code = 'DEVELOPMENT_REQUEST_BINDING_INVALID') {
  const requested = Array.isArray(value) ? value : [];
  const canonical = LOCAL_EFFECTS.filter((effect) => requested.includes(effect));
  if (requested.length === 0
    || requested.length !== canonical.length
    || fingerprintJson(requested) !== fingerprintJson(canonical)) {
    throw codedError(code, 'Requested local effects must be one non-empty canonical unique subset.');
  }
  return canonical;
}

function fixedEffectBoundary(requestedEffects) {
  const requested = new Set(canonicalRequestedLocalEffects(requestedEffects));
  return {
    localWorkspaceRead: requested.has('local-workspace-read') ? 'request-scoped' : 'not-requested',
    localWorkspaceWrite: requested.has('local-workspace-write') ? 'request-scoped' : 'not-requested',
    localCommand: requested.has('local-command') ? 'request-scoped' : 'not-requested',
    subagentDispatch: requested.has('subagent-dispatch') ? 'request-scoped' : 'not-requested',
    providerRead: 'separate-authority',
    providerWrite: 'separate-authority',
    publication: 'separate-authority',
    merge: 'separate-authority',
    protectedRootMutation: 'separate-authority',
    hostRealization: 'separate-authority'
  };
}

function closedEffectBoundary() {
  return {
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
    requestedLocalEffects: [...LOCAL_EFFECTS],
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
  for (const target of targets) {
    assertRelativePath(target.path, 'Development target', 'DEVELOPMENT_REQUEST_BINDING_INVALID');
    if ((target.beforeFingerprint === null) !== (target.beforeMode === null)) {
      throw codedError(
        'DEVELOPMENT_REQUEST_BINDING_INVALID',
        'Development target bytes and mode must describe the same exact presence state.'
      );
    }
  }
  const requestedLocalEffects = canonicalRequestedLocalEffects(request.invocation.requestedLocalEffects);
  if (fingerprintJson(request.effectBoundary) !== fingerprintJson(fixedEffectBoundary(requestedLocalEffects))
    || fingerprintJson(request.authority) !== fingerprintJson(fixedRequestAuthority())) {
    throw codedError(
      'DEVELOPMENT_REQUEST_BINDING_INVALID',
      'Development request effect and authority boundaries do not match the exact requested subset.'
    );
  }
  if (!requireCurrent) {
    return request;
  }
  exactCurrentRequestBasis(root, request, lockPath);
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
  limitations = ['This private request grants no provider, publication, merge, promotion, or host-realization authority.']
}) {
  const resolvedRoot = path.resolve(root);
  const requestedLocalEffects = canonicalRequestedLocalEffects(invocation?.requestedLocalEffects);
  const exactInvocation = structuredClone(invocation);
  exactInvocation.requestedLocalEffects = requestedLocalEffects;
  if (exactInvocation.kind === 'develop') {
    exactInvocation.targets = exactInvocation.targets.map((target) => {
      return inspectDevelopmentTarget(resolvedRoot, target);
    });
  }
  if (hasDevelopmentRequestState(resolvedRoot, requestId)) {
    const existing = readDevelopmentRequestState(resolvedRoot, requestId).request;
    assertDevelopmentRequest(resolvedRoot, existing, { lockPath, requireCurrent: true });
    const suppliedLock = exactLock(resolvedRoot, lockPath, workflowId).lock;
    const sameInputs = existing.workflow.id === workflowId
      && existing.configuration.lockPath === lockPath
      && existing.configuration.lockFingerprint === fingerprintLock(suppliedLock)
      && fingerprintJson(existing.invocation) === fingerprintJson(exactInvocation)
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
  exact.host.managedManifestFingerprint = exactManagedHostBasis(resolvedRoot, lock, exact);
  const targetPaths = exactInvocation.kind === 'develop'
    ? exactInvocation.targets.map((target) => target.path)
    : [];
  const workspace = exactWorkspaceBasis(resolvedRoot, lock, targetPaths);
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
    invocation: exactInvocation,
    effectBoundary: fixedEffectBoundary(requestedLocalEffects),
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
    untargetedTreeFingerprint: workspace.untargetedTreeFingerprint,
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
      candidateProjectionFingerprint: request.host.candidateProjectionFingerprint,
      managedManifestFingerprint: request.host.managedManifestFingerprint
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
  if (request.invocation.kind === 'develop') {
    const targets = new Map(request.invocation.targets.map((target) => [target.path, target]));
    if (result.changes.length !== targets.size) {
      throw codedError(
        'DEVELOPMENT_RESULT_BINDING_INVALID',
        'Development result must account for every exact request target once.'
      );
    }
    for (const change of result.changes) {
      const target = targets.get(change.path);
      let current;
      try {
        current = target ? inspectDevelopmentTarget(root, target, {
          requireCurrentManagedOwnership: !requestUsesTargetWriteClosure(request)
        }) : null;
      } catch (error) {
        throw codedError(
          'DEVELOPMENT_RESULT_BINDING_INVALID',
          'Development result target is unavailable, unsafe, protected, or managed.',
          error
        );
      }
      const coherent = target
        && change.beforeFingerprint === target.beforeFingerprint
        && change.afterFingerprint === current.beforeFingerprint
        && (change.kind === 'create'
          ? change.beforeFingerprint === null
            && change.afterFingerprint !== null
            && target.beforeMode === null
            && current.beforeMode === '0644'
          : change.kind === 'remove'
            ? change.beforeFingerprint !== null
              && change.afterFingerprint === null
              && target.beforeMode !== null
              && current.beforeMode === null
            : change.kind === 'modify'
              ? change.beforeFingerprint !== null
                && change.afterFingerprint !== null
                && change.beforeFingerprint !== change.afterFingerprint
                && current.beforeMode === target.beforeMode
              : change.beforeFingerprint === change.afterFingerprint
                && current.beforeMode === target.beforeMode);
      if (!coherent) {
        throw codedError(
          'DEVELOPMENT_RESULT_BINDING_INVALID',
          'Development result change does not bind the exact target before and observed after bytes.'
        );
      }
    }
  }
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
    const observationCoherent = effect.state === 'observed'
      ? effect.count >= 1 && effect.observedFingerprint !== null
      : effect.count === 0 && effect.observedFingerprint === null;
    if (effect.scope !== expectedScope || !observationCoherent
      || (EXTERNAL_EFFECTS.has(effect.category) && effect.state === 'observed')) {
      throw codedError('DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED', 'Development result cannot claim an external effect through request-only authority.');
    }
    if (!EXTERNAL_EFFECTS.has(effect.category)
      && !request.invocation.requestedLocalEffects.includes(effect.category)
      && (effect.state !== 'not-observed'
        || effect.count !== 0
        || effect.observedFingerprint !== null)) {
      throw codedError(
        'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED',
        'Development result cannot claim an unrequested local effect.'
      );
    }
  }
  const localEffects = result.effects.filter((effect) => LOCAL_EFFECT_FIELDS[effect.category]);
  if (localEffects.length !== LOCAL_EFFECTS.length
    || LOCAL_EFFECTS.some((category) => {
      return !localEffects.some((effect) => effect.category === category);
    })) {
    throw codedError(
      'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED',
      'Development result closure requires one exact observation row for every local effect category.'
    );
  }
  const externalEffects = result.effects.filter((effect) => EXTERNAL_EFFECTS.has(effect.category));
  if (externalEffects.length !== EXTERNAL_EFFECTS.size
    || [...EXTERNAL_EFFECTS].some((category) => {
      const effect = externalEffects.find((item) => item.category === category);
      return !effect
        || effect.scope !== 'separate-authority'
        || effect.state !== 'not-observed'
        || effect.count !== 0
        || effect.observedFingerprint !== null;
    })) {
    throw codedError(
      'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED',
      'Development result closure requires exact zero-effect observation for every external category.'
    );
  }
  const changedWorkspace = result.changes.some((change) => change.kind !== 'unchanged');
  const writeEffect = localEffects.find((effect) => effect.category === 'local-workspace-write');
  if (changedWorkspace && (!requestAllowsWorkspaceWrite(request)
    || writeEffect?.state !== 'observed'
    || writeEffect.count < 1
    || writeEffect.observedFingerprint === null)) {
    throw codedError(
      'DEVELOPMENT_RESULT_EFFECT_BOUNDARY_VIOLATED',
      'A workspace change requires requested and exactly observed local workspace write authority.'
    );
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
    const currentBasis = requestUsesTargetWriteClosure(request)
      ? exactWriteClosureBasis(root, request, lockPath)
      : exactCurrentRequestBasis(root, request, lockPath);
    const currentWorkspace = currentBasis.workspace;
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
    grantsProviderWrite: false
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
  assertDevelopmentRequest(resolvedRoot, request);
  const currentBasis = requestUsesTargetWriteClosure(request)
    ? exactWriteClosureBasis(resolvedRoot, request, lockPath)
    : exactCurrentRequestBasis(resolvedRoot, request, lockPath);
  const resultId = resultIdForRequest(requestId);
  const existingResult = hasDevelopmentResultState(resolvedRoot, resultId)
    ? readDevelopmentResultState(resolvedRoot, resultId).result
    : null;
  const exactCompletedAt = completedAt || existingResult?.completedAt || new Date().toISOString();
  const bindings = resultBindings(request);
  const observedPostWorkspace = currentBasis.workspace;
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
    limitations: [...(outcome.limitations || ['This result is scoped development evidence and grants no operational authority.'])]
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
  const applicability = developmentRequestApplicability(resolvedRoot, request);
  const requestBoundary = result
    ? {
        state: 'closed',
        reasonCode: 'DEVELOPMENT_RESULT_RECORDED',
        permittedNextAction: 'none',
        declared: structuredClone(request.effectBoundary),
        effective: closedEffectBoundary()
      }
    : applicability.state === 'current'
      ? {
          state: 'current',
          reasonCode: applicability.reasonCode,
          permittedNextAction: 'perform-request-scoped-development',
          declared: structuredClone(request.effectBoundary),
          effective: structuredClone(request.effectBoundary)
        }
      : {
          state: 'stale',
          reasonCode: applicability.reasonCode,
          permittedNextAction: 'create-new-development-request',
          declared: structuredClone(request.effectBoundary),
          effective: closedEffectBoundary()
        };
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
    invocation: {
      kind: request.invocation.kind,
      profile: request.invocation.profile,
      requestedLocalEffects: [...request.invocation.requestedLocalEffects],
      targetIds,
      plannedRuns
    },
    applicability,
    requestBoundary,
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
      grantsProviderRead: false,
      grantsPublication: false,
      grantsMerge: false,
      grantsProviderWrite: false,
      grantsProtectedRootMutation: false,
      grantsHostRealization: false
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
      'Inspection does not grant execution, approval, publication, merge, provider-write, host-realization, or promotion authority.'
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
