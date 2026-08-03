import fs from 'node:fs';
import path from 'node:path';

import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import { fingerprintLock, lockMatchesResolution, resolveConfiguration } from './resolve.mjs';

const DIRECTORY = '.soter/state/development-candidate-locks';
const SAFE_WORKFLOW = /^automation[.][a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_HOST = /^(?:codex|claude)$/;
const SAFE_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

function fail(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  throw error;
}

function exactId(workflowId, host, lockFingerprint) {
  if (!SAFE_WORKFLOW.test(workflowId || '')
    || !SAFE_HOST.test(host || '')
    || !SAFE_FINGERPRINT.test(lockFingerprint || '')) {
    fail('DEVELOPMENT_CANDIDATE_LOCK_INPUT_INVALID', 'Candidate lock workflow, host, or content fingerprint is invalid.');
  }
  return `development-candidate-lock.${host}.${workflowId.slice('automation.'.length)}.${lockFingerprint.slice('sha256:'.length)}`;
}

function assertPrivateDirectory(directory, rootRealPath) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o700)) {
    fail('DEVELOPMENT_CANDIDATE_LOCK_PATH_UNSAFE', 'Candidate lock parent must be one 0700 non-symlink directory.');
  }
  const real = fs.realpathSync(directory);
  if (real !== rootRealPath && !real.startsWith(rootRealPath + path.sep)) {
    fail('DEVELOPMENT_CANDIDATE_LOCK_PATH_UNSAFE', 'Candidate lock parent escapes the exact repository root.');
  }
}

function ensureCandidateDirectory(root, create) {
  const resolvedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('DEVELOPMENT_CANDIDATE_LOCK_PATH_UNSAFE', 'Candidate lock root must be one real directory.');
  }
  const rootRealPath = fs.realpathSync(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of ['.soter', 'state', 'development-candidate-locks']) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      assertPrivateDirectory(current, rootRealPath);
      continue;
    }
    if (!create) continue;
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      fail('DEVELOPMENT_CANDIDATE_LOCK_PATH_UNSAFE', 'Candidate lock private directory could not be created safely.', error);
    }
    assertPrivateDirectory(current, rootRealPath);
  }
  return current;
}

export function developmentCandidateLockStatePath(root, workflowId, host, lockFingerprint) {
  const directory = ensureCandidateDirectory(root, false);
  return resolveRepoPath(
    root,
    `${repoRelativePath(root, directory)}/${exactId(workflowId, host, lockFingerprint)}.json`
  );
}

export function isDevelopmentCandidateLockPath(root, lockPath) {
  if (typeof lockPath !== 'string') return false;
  try {
    const relative = repoRelativePath(path.resolve(root), resolveRepoPath(root, lockPath));
    return relative.startsWith(DIRECTORY + '/') && relative.endsWith('.json');
  } catch {
    return false;
  }
}

function exactWorkflowSelection(lock, workflowId) {
  const selected = lock.packs.filter((item) => item.id === workflowId);
  if (selected.length !== 1) {
    fail('DEVELOPMENT_CANDIDATE_LOCK_BINDING_INVALID', 'Resolved lock does not select the exact development workflow once.');
  }
  const slug = workflowId.slice('automation.'.length);
  const required = new Set([
    `soter/automations/${slug}/definition.json`,
    `soter/automations/${slug}/guide.json`,
    `soter/automations/${slug}/evaluations.json`
  ]);
  for (const artifact of selected[0].artifacts) required.delete(artifact.path);
  if (required.size !== 0) {
    fail('DEVELOPMENT_CANDIDATE_LOCK_BINDING_INVALID', 'Resolved lock lacks the exact workflow definition, guide, or evaluations.');
  }
}

function resolveExact({ root, configPath, workflowId, host }) {
  let lock;
  try {
    lock = resolveConfiguration({ root, configPath, host });
  } catch (error) {
    fail(
      'DEVELOPMENT_CANDIDATE_LOCK_GRAPH_INVALID',
      'Development candidate lock requires an ordinary valid static graph.',
      error
    );
  }
  exactWorkflowSelection(lock, workflowId);
  return lock;
}

function assertPrivateFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    fail('DEVELOPMENT_CANDIDATE_LOCK_UNAVAILABLE', 'Private development candidate lock is unavailable.', error);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)) {
    fail('DEVELOPMENT_CANDIDATE_LOCK_UNSAFE', 'Private development candidate lock must be one 0600 regular non-linked file.');
  }
  const directory = fs.lstatSync(path.dirname(file));
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || (process.platform !== 'win32' && (directory.mode & 0o7777) !== 0o700)) {
    fail('DEVELOPMENT_CANDIDATE_LOCK_UNSAFE', 'Private development candidate lock directory must be 0700.');
  }
}

export function resolveDevelopmentCandidateLock({ root, configPath, workflowId, host }) {
  const resolvedRoot = path.resolve(root);
  const lock = resolveExact({ root: resolvedRoot, configPath, workflowId, host });
  const lockFingerprint = fingerprintLock(lock);
  return {
    lock,
    lockFingerprint,
    graphFingerprint: lock.graphFingerprint,
    workflow: { id: workflowId, version: lock.packs.find((item) => item.id === workflowId).version },
    host: { id: lock.host.id, adapter: lock.host.adapter, manifestFingerprint: lock.host.manifestFingerprint },
    authority: {
      kind: 'private-development-lock-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsPublication: false,
      grantsMerge: false,
      grantsProviderRead: false,
      grantsProviderWrite: false,
      grantsHostRealization: false
    },
    path: repoRelativePath(
      resolvedRoot,
      developmentCandidateLockStatePath(
        resolvedRoot,
        workflowId,
        lock.host.id,
        lockFingerprint
      )
    )
  };
}

export function materializeDevelopmentCandidateLock({ root, configPath, workflowId, host }) {
  const resolvedRoot = path.resolve(root);
  const exact = resolveDevelopmentCandidateLock({ root: resolvedRoot, configPath, workflowId, host });
  const directory = ensureCandidateDirectory(resolvedRoot, true);
  const file = path.join(
    directory,
    exactId(workflowId, exact.host.id, exact.lockFingerprint) + '.json'
  );
  if (fs.existsSync(file)) {
    assertPrivateFile(file);
    const existing = readJson(file);
    if (fingerprintJson(existing) !== fingerprintJson(exact.lock)) {
      fail('DEVELOPMENT_CANDIDATE_LOCK_REENTRY_MISMATCH', 'Candidate lock re-entry cannot replace different exact bytes.');
    }
    return { ...exact, lock: existing, path: repoRelativePath(resolvedRoot, file) };
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(exact.lock, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  assertPrivateFile(file);
  return { ...exact, path: repoRelativePath(resolvedRoot, file) };
}

export function readDevelopmentCandidateLock({
  root,
  lockPath,
  workflowId,
  requireCurrent = true,
  expectedLockFingerprint = null
}) {
  const resolvedRoot = path.resolve(root);
  const file = resolveRepoPath(resolvedRoot, lockPath);
  const name = path.basename(file);
  const match = name.match(/^development-candidate-lock[.](codex|claude)[.]([a-z0-9]+(?:-[a-z0-9]+)*)[.]([a-f0-9]{64})[.]json$/);
  const pathFingerprint = match ? 'sha256:' + match[3] : null;
  if (!match || workflowId !== `automation.${match[2]}`
    || file !== developmentCandidateLockStatePath(
      resolvedRoot,
      workflowId,
      match[1],
      pathFingerprint
    )) {
    fail('DEVELOPMENT_CANDIDATE_LOCK_PATH_INVALID', 'Candidate lock path does not bind the exact workflow and host.');
  }
  assertPrivateFile(file);
  const lock = readJson(file);
  const observedFingerprint = fingerprintLock(lock);
  if (observedFingerprint !== pathFingerprint
    || (expectedLockFingerprint !== null
      && expectedLockFingerprint !== observedFingerprint)) {
    fail('DEVELOPMENT_CANDIDATE_LOCK_TAMPERED', 'Candidate lock bytes do not match the content-addressed private path or expected request binding.');
  }
  exactWorkflowSelection(lock, workflowId);
  if (requireCurrent) {
    let comparison;
    try {
      comparison = lockMatchesResolution({
        root: resolvedRoot,
        configPath: lock.configuration.path,
        host: lock.host.id,
        lock
      });
    } catch (error) {
      fail('DEVELOPMENT_CANDIDATE_LOCK_STALE', 'Candidate lock static graph is no longer valid.', error);
    }
    if (!comparison.matches) {
      fail('DEVELOPMENT_CANDIDATE_LOCK_STALE', 'Candidate lock no longer matches ordinary exact resolution.');
    }
  }
  return {
    lock,
    lockFingerprint: observedFingerprint,
    graphFingerprint: lock.graphFingerprint,
    path: repoRelativePath(resolvedRoot, file)
  };
}
