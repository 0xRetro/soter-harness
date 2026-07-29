import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema, verifySoter } from '../kernel/verify.mjs';
import { buildDevelopmentWorkflowLifecycleFinalizationCandidate } from './development-workflow-lifecycle-finalization.mjs';
import {
  assertLegacyFinalizationCandidateBasis
} from './legacy-finalization.mjs';
import {
  legacyTransitionFinalizationContract,
  readLegacyFinalizationTransitionRequest
} from './legacy-transition-finalization.mjs';
import {
  fingerprintFile,
  fingerprintJson,
  fingerprintPath,
  readJson,
  sha256
} from './lib/canonical-json.mjs';

const REQUEST_CONTRACT = 'soter://private/repository-cutover-request/v1';
const CHECKPOINT_CONTRACT = 'soter://private/repository-cutover-checkpoint/v1';
const INSPECTION_CONTRACT = 'soter://contracts/repository-cutover-inspection/v1';
const REQUEST_ID = /^repository-cutover[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CHECKPOINT_ID = /^repository-cutover[.][a-f0-9]{64}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const STATE_DIRECTORY = '.soter/state/repository-cutovers';
const INSPECTION_SCHEMA = 'soter/contracts/repository-cutover-inspection.schema.json';
const EXCLUDED_PUBLIC_ROOTS = new Set(['.git', '.soter', 'node_modules']);
const EXPECTED_SOURCE_DELETIONS = 79;
const EXPECTED_BINDING_TRANSITIONS = 108;
const SAFE_PUBLIC_FILE_MODES = new Set(['0644', '0755']);
const SAFE_PUBLIC_DIRECTORY_MODE = '0755';
const EXPECTED_OPERATIONAL_DELETIONS = Object.freeze([
  '.claude-plugin/marketplace.json',
  '.codex/config.toml',
  'AGENTS.md',
  'CLAUDE.md',
  'soter/kernel/legacy-check.mjs'
]);
const PHASE_ORDER = Object.freeze({
  workflow: 0,
  legacy: 1,
  'checker-shim': 2,
  'legacy-source': 3,
  'operational-output': 4,
  fixture: 5
});
const FAILURE_SUMMARIES = new Set([
  'Repository cutover cannot safely continue or roll back without exact checkpoint-bound reconciliation.',
  'Repository cutover stopped and attempted exact rollback.'
]);
const INSPECTION_CLAIM_BOUNDARY = 'Exact local repository bytes and modes only; readiness, connected verification, provider behavior, host behavior, and health are not evaluated.';
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  throw error;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return fingerprintJson(Object.keys(value).sort(compareCodepoint))
    === fingerprintJson([...expected].sort(compareCodepoint));
}

function exactInstant(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function normalizeFailureCode(error, fallback) {
  return typeof error?.code === 'string'
      && /^REPOSITORY_CUTOVER_[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : fallback;
}

function assertMonotonicTime(checkpoint, at) {
  if (!exactInstant(at)
    || Date.parse(at) < Date.parse(checkpoint.request.createdAt)
    || Date.parse(at) < Date.parse(checkpoint.updatedAt)) {
    fail(
      'REPOSITORY_CUTOVER_TIME_INVALID',
      'Repository cutover time must be one canonical instant no earlier than its request and checkpoint.'
    );
  }
}

function requestFingerprint(request) {
  const unsigned = structuredClone(request);
  delete unsigned.requestFingerprint;
  return fingerprintJson(unsigned);
}

function sealCheckpoint(checkpoint) {
  checkpoint.checkpointFingerprint = null;
  const unsigned = structuredClone(checkpoint);
  delete unsigned.checkpointFingerprint;
  checkpoint.checkpointFingerprint = fingerprintJson(unsigned);
  return checkpoint;
}

function cutoverPlanFingerprint(plan, operations) {
  return fingerprintJson({
    ...plan,
    planFingerprint: null,
    operations: operations.map((operation) => ({
      id: operation.id,
      sequence: operation.sequence,
      phase: operation.phase,
      path: operation.path,
      action: operation.action,
      before: snapshotWithoutBytes(operation.before),
      after: snapshotWithoutBytes(operation.after)
    }))
  });
}

function resolvedRealRoot(root) {
  if (typeof root !== 'string' || !root.length) {
    fail('REPOSITORY_CUTOVER_ROOT_INVALID', 'Repository cutover requires one repository root.');
  }
  const resolved = path.resolve(root);
  let stat;
  let real;
  try {
    stat = fs.lstatSync(resolved);
    real = fs.realpathSync(resolved);
  } catch (error) {
    fail('REPOSITORY_CUTOVER_ROOT_INVALID', 'Repository cutover root is unavailable.', error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) {
    fail('REPOSITORY_CUTOVER_ROOT_INVALID', 'Repository cutover root must be one exact real directory.');
  }
  return resolved;
}

export function repositoryCutoverRootIdentity(root) {
  const resolved = resolvedRealRoot(root);
  const stat = fs.statSync(resolved);
  const basis = {
    realPath: resolved,
    device: Number(stat.dev),
    inode: Number(stat.ino)
  };
  return { ...basis, fingerprint: fingerprintJson(basis) };
}

function assertRootIdentity(root, expectedFingerprint) {
  const identity = repositoryCutoverRootIdentity(root);
  if (identity.fingerprint !== expectedFingerprint) {
    fail('REPOSITORY_CUTOVER_ROOT_DRIFT', 'Repository root identity does not match the exact private cutover request.');
  }
  return identity;
}

function normalizedRelative(relative, label = 'Repository cutover path') {
  if (typeof relative !== 'string' || !relative.length || relative.includes('\\')
    || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative
    || relative === '.' || relative === '..' || relative.startsWith('../')
    || relative.includes('/../') || relative.includes('//')) {
    fail('REPOSITORY_CUTOVER_PATH_INVALID', label + ' is not normalized and repository-relative.');
  }
  return relative;
}

function confinedPath(root, relative, { allowMissing = true } = {}) {
  const resolvedRoot = resolvedRealRoot(root);
  const normalized = normalizedRelative(relative);
  const target = path.resolve(resolvedRoot, normalized);
  if (!target.startsWith(resolvedRoot + path.sep)) {
    fail('REPOSITORY_CUTOVER_PATH_INVALID', 'Repository cutover path escapes the exact root.');
  }
  let cursor = resolvedRoot;
  const parts = normalized.split('/');
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) {
      if (allowMissing) break;
      fail('REPOSITORY_CUTOVER_PATH_INVALID', 'Repository cutover path is unavailable: ' + normalized);
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      fail('REPOSITORY_CUTOVER_SYMLINK_REJECTED', 'Repository cutover path crosses a symbolic link: ' + normalized);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      fail('REPOSITORY_CUTOVER_PATH_INVALID', 'Repository cutover path crosses a non-directory parent: ' + normalized);
    }
  }
  return target;
}

function assertPrivateExternalJson(root, requestedPath, label) {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)
    || requestedPath !== path.resolve(requestedPath)) {
    fail('REPOSITORY_CUTOVER_REQUEST_PATH_INVALID', label + ' must be one absolute private path outside the repository.');
  }
  const resolvedRoot = resolvedRealRoot(root);
  const resolved = path.resolve(requestedPath);
  let stat;
  let real;
  try {
    stat = fs.lstatSync(resolved);
    real = fs.realpathSync(resolved);
  } catch (error) {
    fail('REPOSITORY_CUTOVER_REQUEST_PATH_INVALID', label + ' is unavailable.', error);
  }
  if (real === resolvedRoot || real.startsWith(resolvedRoot + path.sep)
    || real !== resolved || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)) {
    fail('REPOSITORY_CUTOVER_REQUEST_PATH_INVALID', label + ' must be one exact non-linked external 0600 file.');
  }
  let descriptor = null;
  let bytes;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== stat.dev || before.ino !== stat.ino
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o600)) {
      fail('REPOSITORY_CUTOVER_REQUEST_PATH_INVALID', label + ' changed before its exact read.');
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || after.nlink !== 1
      || fs.realpathSync(resolved) !== real) {
      fail('REPOSITORY_CUTOVER_REQUEST_PATH_INVALID', label + ' changed during its exact read.');
    }
  } catch (error) {
    if (error?.code?.startsWith('REPOSITORY_CUTOVER_')) throw error;
    fail('REPOSITORY_CUTOVER_REQUEST_PATH_INVALID', label + ' could not be read exactly.', error);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail('REPOSITORY_CUTOVER_REQUEST_INVALID', label + ' is not valid JSON.', error);
  }
  if (!bytes.equals(canonicalBytes(value))) {
    fail('REPOSITORY_CUTOVER_REQUEST_INVALID', label + ' must use exact canonical persisted JSON bytes.');
  }
  return { value, fingerprint: sha256(bytes), path: resolved };
}

export function readRepositoryCutoverRequest({ root, requestPath, ...unknown } = {}) {
  if (Object.keys(unknown).length) {
    fail('REPOSITORY_CUTOVER_ARGUMENTS_INVALID', 'Repository cutover request reader received an unknown argument.');
  }
  const resolvedRoot = resolvedRealRoot(root);
  const input = assertPrivateExternalJson(resolvedRoot, requestPath, 'Repository cutover request');
  const request = input.value;
  if (!exactKeys(request, [
    '$contract',
    'contractVersion',
    'id',
    'createdAt',
    'rootIdentityFingerprint',
    'lifecycleRequest',
    'transitionRequest',
    'fixtureFinalizationRequest',
    'requestFingerprint'
  ])
    || request.$contract !== REQUEST_CONTRACT
    || request.contractVersion !== '1.0.0'
    || !REQUEST_ID.test(request.id || '')
    || !exactInstant(request.createdAt)
    || !HASH.test(request.rootIdentityFingerprint || '')
    || !HASH.test(request.requestFingerprint || '')
    || request.requestFingerprint !== requestFingerprint(request)) {
    fail('REPOSITORY_CUTOVER_REQUEST_INVALID', 'Repository cutover request identity, shape, time, or fingerprint is invalid.');
  }
  assertRootIdentity(resolvedRoot, request.rootIdentityFingerprint);
  const subrequests = [
    ['lifecycleRequest', 'Workflow lifecycle request'],
    ['transitionRequest', 'Legacy transition request'],
    ['fixtureFinalizationRequest', 'Fixture finalization request']
  ];
  const realPaths = new Set();
  const verifiedSubrequests = {};
  for (const [property, label] of subrequests) {
    const reference = request[property];
    if (!exactKeys(reference, ['path', 'fingerprint'])
      || !HASH.test(reference?.fingerprint || '')) {
      fail('REPOSITORY_CUTOVER_REQUEST_INVALID', label + ' reference must bind one exact private path and canonical file fingerprint.');
    }
    const nested = assertPrivateExternalJson(resolvedRoot, reference.path, label);
    if (nested.fingerprint !== reference.fingerprint) {
      fail('REPOSITORY_CUTOVER_SUBREQUEST_DRIFT', label + ' bytes changed after the exact cutover request was signed.');
    }
    if (realPaths.has(nested.path)) {
      fail('REPOSITORY_CUTOVER_REQUEST_INVALID', 'Repository cutover subrequests must be three distinct exact files.');
    }
    realPaths.add(nested.path);
    verifiedSubrequests[property] = {
      path: nested.path,
      fingerprint: nested.fingerprint,
      value: structuredClone(nested.value)
    };
  }
  if (verifiedSubrequests.transitionRequest.value?.$contract
      !== legacyTransitionFinalizationContract.request) {
    fail(
      'REPOSITORY_CUTOVER_TRANSITION_REQUEST_INVALID',
      'Repository cutover requires the full governed legacy transition request; the former checkerReceipt/transitions mini-envelope is unavailable.'
    );
  }
  return {
    request: structuredClone(request),
    requestFileFingerprint: input.fingerprint,
    verifiedSubrequests
  };
}

export function buildRepositoryCutoverRequest({
  root,
  id,
  createdAt,
  lifecycleRequestPath,
  transitionRequestPath,
  fixtureFinalizationRequestPath,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length
    || !REQUEST_ID.test(id || '')
    || !exactInstant(createdAt)) {
    fail('REPOSITORY_CUTOVER_ARGUMENTS_INVALID', 'Repository cutover request builder requires one exact id, time, root, and three private subrequests.');
  }
  const resolvedRoot = resolvedRealRoot(root);
  const inputs = [
    ['lifecycleRequest', lifecycleRequestPath, 'Workflow lifecycle request'],
    ['transitionRequest', transitionRequestPath, 'Legacy transition request'],
    ['fixtureFinalizationRequest', fixtureFinalizationRequestPath, 'Fixture finalization request']
  ].map(([property, requestedPath, label]) => {
    const input = assertPrivateExternalJson(resolvedRoot, requestedPath, label);
    return { property, input };
  });
  if (new Set(inputs.map((row) => row.input.path)).size !== inputs.length) {
    fail('REPOSITORY_CUTOVER_REQUEST_INVALID', 'Repository cutover subrequests must be three distinct exact files.');
  }
  const transitionInput = inputs.find((row) => row.property === 'transitionRequest');
  if (transitionInput?.input.value?.$contract !== legacyTransitionFinalizationContract.request) {
    fail(
      'REPOSITORY_CUTOVER_TRANSITION_REQUEST_INVALID',
      'Repository cutover requires the full governed legacy transition request; the former checkerReceipt/transitions mini-envelope is unavailable.'
    );
  }
  const request = {
    $contract: REQUEST_CONTRACT,
    contractVersion: '1.0.0',
    id,
    createdAt,
    rootIdentityFingerprint: repositoryCutoverRootIdentity(resolvedRoot).fingerprint,
    lifecycleRequest: null,
    transitionRequest: null,
    fixtureFinalizationRequest: null,
    requestFingerprint: null
  };
  for (const { property, input } of inputs) {
    request[property] = { path: input.path, fingerprint: input.fingerprint };
  }
  request.requestFingerprint = requestFingerprint(request);
  return request;
}

function modeString(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, '0');
}

function snapshotFingerprint(snapshot) {
  return fingerprintJson({
    state: snapshot.state,
    mode: snapshot.mode,
    contentFingerprint: snapshot.contentFingerprint
  });
}

function absentSnapshot() {
  const snapshot = {
    state: 'absent',
    mode: null,
    contentFingerprint: null,
    bytesBase64: null,
    fingerprint: null
  };
  snapshot.fingerprint = snapshotFingerprint(snapshot);
  return snapshot;
}

function snapshotFile(root, relative) {
  const target = confinedPath(root, relative);
  if (!fs.existsSync(target)) return absentSnapshot();
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || fs.realpathSync(target) !== target || (stat.mode & 0o7000) !== 0) {
    fail('REPOSITORY_CUTOVER_FILE_INVALID', 'Repository cutover file must be one regular non-linked file without special mode bits: ' + relative);
  }
  const bytes = fs.readFileSync(target);
  const snapshot = {
    state: 'present',
    mode: modeString(stat),
    contentFingerprint: sha256(bytes),
    bytesBase64: bytes.toString('base64'),
    fingerprint: null
  };
  if (!SAFE_PUBLIC_FILE_MODES.has(snapshot.mode)) {
    fail('REPOSITORY_CUTOVER_FILE_MODE_INVALID', 'Repository cutover file mode is outside the closed public mode set: ' + relative);
  }
  snapshot.fingerprint = snapshotFingerprint(snapshot);
  return snapshot;
}

function snapshotEquals(left, right) {
  return left.state === right.state && left.fingerprint === right.fingerprint;
}

function snapshotWithoutBytes(snapshot) {
  const { bytesBase64: _bytes, ...projected } = snapshot;
  return projected;
}

function publicTreeManifest(root, ignoredPaths = new Set()) {
  const resolvedRoot = resolvedRealRoot(root);
  const files = [];
  const directories = [];
  const visit = (directory, relativeDirectory = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareCodepoint(left.name, right.name));
    for (const entry of entries) {
      if (!relativeDirectory && EXCLUDED_PUBLIC_ROOTS.has(entry.name)) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        fail('REPOSITORY_CUTOVER_SYMLINK_REJECTED', 'Public repository tree contains a symbolic link: ' + relative);
      }
      if (entry.isDirectory()) {
        if (modeString(stat) !== SAFE_PUBLIC_DIRECTORY_MODE) {
          fail('REPOSITORY_CUTOVER_DIRECTORY_MODE_INVALID', 'Public repository directory mode is outside the closed 0755 policy: ' + relative);
        }
        const ownsPlannedDescendant = [...ignoredPaths].some((ignored) => {
          return ignored.startsWith(relative + '/');
        });
        if (!ownsPlannedDescendant) directories.push({ path: relative, mode: modeString(stat) });
        visit(target, relative);
        continue;
      }
      if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7000) !== 0) {
        fail('REPOSITORY_CUTOVER_FILE_INVALID', 'Public repository tree contains an unsafe file: ' + relative);
      }
      if (!SAFE_PUBLIC_FILE_MODES.has(modeString(stat))) {
        fail('REPOSITORY_CUTOVER_FILE_MODE_INVALID', 'Public repository file mode is outside the closed 0644/0755 policy: ' + relative);
      }
      if (ignoredPaths.has(relative)) continue;
      files.push({
        path: relative,
        mode: modeString(stat),
        contentFingerprint: fingerprintFile(target)
      });
    }
  };
  visit(resolvedRoot);
  return { directories, files, fingerprint: fingerprintJson({ directories, files }) };
}

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function unlinkDurably(file) {
  fs.unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}

function ensurePrivateDirectory(root, { create = true } = {}) {
  let current = root;
  for (const part of STATE_DIRECTORY.split('/')) {
    const parent = current;
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      if (!create) {
        fail('REPOSITORY_CUTOVER_PRIVATE_STATE_INVALID', 'Repository cutover private state directory is unavailable.');
      }
      try {
        fs.mkdirSync(current, { recursive: false, mode: 0o700 });
        if (process.platform !== 'win32') fs.chmodSync(current, 0o700);
        fsyncDirectory(current);
        fsyncDirectory(parent);
      } catch (error) {
        fail('REPOSITORY_CUTOVER_PRIVATE_STATE_INVALID', 'Repository cutover private state directory could not be created exactly.', error);
      }
    }
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      fail('REPOSITORY_CUTOVER_PRIVATE_STATE_INVALID', 'Repository cutover private state directory is unavailable.', error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || fs.realpathSync(current) !== current
      || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o700)) {
      fail('REPOSITORY_CUTOVER_PRIVATE_STATE_INVALID', 'Every repository cutover private state ancestor must be one exact non-linked 0700 directory.');
    }
  }
  return current;
}

function assertOwnedTemporary(file, label, primaryFile = null) {
  const stat = fs.lstatSync(file);
  let linkedToPrimary = false;
  if (primaryFile && fs.existsSync(primaryFile)) {
    const primaryStat = fs.lstatSync(primaryFile);
    linkedToPrimary = primaryStat.dev === stat.dev && primaryStat.ino === stat.ino;
  }
  if (stat.isSymbolicLink() || !stat.isFile()
    || ![1, 2].includes(stat.nlink)
    || (stat.nlink === 2 && !linkedToPrimary)
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)) {
    fail('REPOSITORY_CUTOVER_TEMP_COLLISION', label + ' is not one exact private checkpoint-owned file.');
  }
  return stat;
}

function checkpointAuthorityFingerprint(checkpoint) {
  return fingerprintJson({
    contract: checkpoint.$contract,
    contractVersion: checkpoint.contractVersion,
    id: checkpoint.id,
    rootIdentityFingerprint: checkpoint.rootIdentityFingerprint,
    request: checkpoint.request,
    plan: checkpoint.plan,
    operations: checkpoint.operations,
    createdDirectoryPaths: checkpoint.createdDirectories.map((row) => row.path)
  });
}

function readOwnedCheckpointTemporary(temporary, primary = null, primaryFile = null) {
  assertOwnedTemporary(
    temporary,
    'Repository cutover checkpoint temporary',
    primaryFile
  );
  let bytes;
  let checkpoint;
  try {
    bytes = fs.readFileSync(temporary);
    checkpoint = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail('REPOSITORY_CUTOVER_TEMP_COLLISION', 'Repository cutover checkpoint temporary is not exact owned JSON.', error);
  }
  const unsigned = structuredClone(checkpoint);
  delete unsigned.checkpointFingerprint;
  if (!bytes.equals(canonicalBytes(checkpoint))
    || checkpoint.checkpointFingerprint !== fingerprintJson(unsigned)) {
    fail('REPOSITORY_CUTOVER_TEMP_COLLISION', 'Repository cutover checkpoint temporary bytes are not an exact sealed checkpoint.');
  }
  assertCheckpointSemantics(checkpoint);
  if (primary && (checkpointAuthorityFingerprint(checkpoint)
      !== checkpointAuthorityFingerprint(primary)
    || Date.parse(checkpoint.updatedAt) < Date.parse(primary.updatedAt))) {
    fail('REPOSITORY_CUTOVER_TEMP_COLLISION', 'Repository cutover checkpoint temporary is outside the exact checkpoint authority.');
  }
  return { bytes, checkpoint };
}

function readStablePrimaryCheckpoint(file, {
  allowedLinks = [1],
  code = 'REPOSITORY_CUTOVER_CHECKPOINT_INVALID',
  label = 'Repository cutover checkpoint'
} = {}) {
  let descriptor = null;
  try {
    const pathBefore = fs.lstatSync(file);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()
      || !allowedLinks.includes(pathBefore.nlink)
      || (process.platform !== 'win32' && (pathBefore.mode & 0o7777) !== 0o600)) {
      fail(code, label + ' is not one exact private file.');
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || !allowedLinks.includes(before.nlink)
      || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o600)) {
      fail(code, label + ' changed before its exact descriptor read.');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const pathAfter = fs.lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.nlink !== after.nlink || !allowedLinks.includes(after.nlink)
      || (process.platform !== 'win32' && (after.mode & 0o7777) !== 0o600)
      || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino
      || pathAfter.size !== after.size || pathAfter.mtimeMs !== after.mtimeMs
      || pathAfter.nlink !== after.nlink
      || (process.platform !== 'win32' && (pathAfter.mode & 0o7777) !== 0o600)) {
      fail(code, label + ' changed during its exact descriptor read.');
    }
    const checkpoint = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(canonicalBytes(checkpoint))) {
      fail(code, label + ' is not exact canonical JSON.');
    }
    return { checkpoint, bytes, stat: after };
  } catch (error) {
    if (error?.code?.startsWith('REPOSITORY_CUTOVER_')) throw error;
    fail(code, label + ' is unavailable or malformed.', error);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function reconcileCheckpointTemporary(file, primary) {
  const temporary = file + '.pending';
  if (!fs.existsSync(temporary)) return;
  assertOwnedTemporary(temporary, 'Repository cutover checkpoint temporary', file);
  if (fs.existsSync(file)) {
    const primaryStat = fs.lstatSync(file);
    const temporaryStat = fs.lstatSync(temporary);
    if (primaryStat.ino === temporaryStat.ino && primaryStat.dev === temporaryStat.dev) {
      unlinkDurably(temporary);
      return;
    }
  }
  readOwnedCheckpointTemporary(temporary, primary, file);
  unlinkDurably(temporary);
}

function checkpointFile(root, checkpointId) {
  if (!CHECKPOINT_ID.test(checkpointId || '')) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover checkpoint id is invalid.');
  }
  return confinedPath(root, `${STATE_DIRECTORY}/${checkpointId}.json`);
}

function persistCheckpoint(root, checkpoint, { create = false } = {}) {
  assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
  assertCheckpointSemantics(checkpoint);
  const priorCheckpointFingerprint = checkpoint.checkpointFingerprint;
  sealCheckpoint(checkpoint);
  ensurePrivateDirectory(root);
  const file = checkpointFile(root, checkpoint.id);
  const bytes = canonicalBytes(checkpoint);
  const temporary = file + '.pending';
  if (create) {
    if (fs.existsSync(temporary)) {
      assertOwnedTemporary(temporary, 'Repository cutover checkpoint temporary', file);
      const temporaryBytes = fs.readFileSync(temporary);
      if (!temporaryBytes.equals(bytes)) {
        fail('REPOSITORY_CUTOVER_TEMP_COLLISION', 'Repository cutover create temporary is not the exact requested checkpoint.');
      }
      if (!fs.existsSync(file)) {
        assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
        fs.linkSync(temporary, file);
        fsyncDirectory(path.dirname(file));
        unlinkDurably(temporary);
      } else {
        const primaryStat = fs.lstatSync(file);
        const temporaryStat = fs.lstatSync(temporary);
        if (primaryStat.ino !== temporaryStat.ino || primaryStat.dev !== temporaryStat.dev) {
          fail('REPOSITORY_CUTOVER_TEMP_COLLISION', 'Repository cutover create temporary does not belong to the existing checkpoint.');
        }
        unlinkDurably(temporary);
      }
    }
    if (fs.existsSync(file)) {
      const error = new Error('Repository cutover checkpoint already exists.');
      error.code = 'EEXIST';
      throw error;
    }
    let descriptor = null;
    let createdTemporary = false;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      createdTemporary = true;
      fs.writeFileSync(descriptor, bytes);
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
      fs.linkSync(temporary, file);
      fsyncDirectory(path.dirname(file));
      unlinkDurably(temporary);
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      if (createdTemporary && fs.existsSync(temporary)) unlinkDurably(temporary);
    }
  } else {
    const loaded = readStablePrimaryCheckpoint(file, {
      code: 'REPOSITORY_CUTOVER_CHECKPOINT_DRIFT',
      label: 'Repository cutover checkpoint before update'
    });
    const current = loaded.checkpoint;
    const currentStat = loaded.stat;
    const currentUnsigned = structuredClone(current);
    delete currentUnsigned.checkpointFingerprint;
    if (current.checkpointFingerprint !== priorCheckpointFingerprint
      || current.checkpointFingerprint !== fingerprintJson(currentUnsigned)) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_DRIFT', 'Repository cutover checkpoint changed before its exact update.');
    }
    if (fs.existsSync(temporary)) {
      const temporaryStat = assertOwnedTemporary(
        temporary,
        'Repository cutover checkpoint temporary',
        file
      );
      if (temporaryStat.ino === currentStat.ino && temporaryStat.dev === currentStat.dev) {
        unlinkDurably(temporary);
      } else {
        readOwnedCheckpointTemporary(temporary, current, file);
        unlinkDurably(temporary);
      }
    }
    let descriptor = null;
    let createdTemporary = false;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      createdTemporary = true;
      fs.writeFileSync(descriptor, bytes);
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
      fs.renameSync(temporary, file);
      fsyncDirectory(path.dirname(file));
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      if (createdTemporary && fs.existsSync(temporary)) unlinkDurably(temporary);
    }
  }
  if (process.platform !== 'win32' && (fs.lstatSync(file).mode & 0o7777) !== 0o600) {
    fail('REPOSITORY_CUTOVER_PRIVATE_STATE_INVALID', 'Repository cutover checkpoint is not mode 0600.');
  }
  return checkpoint;
}

function readCheckpoint(root, checkpointId) {
  ensurePrivateDirectory(root, { create: false });
  const file = checkpointFile(root, checkpointId);
  const loaded = readStablePrimaryCheckpoint(file, { allowedLinks: [1, 2] });
  const checkpoint = loaded.checkpoint;
  const checkpointBytes = loaded.bytes;
  const unsigned = structuredClone(checkpoint);
  delete unsigned.checkpointFingerprint;
  if (checkpoint.$contract !== CHECKPOINT_CONTRACT
    || checkpoint.id !== checkpointId
    || !checkpointBytes.equals(canonicalBytes(checkpoint))
    || checkpoint.checkpointFingerprint !== fingerprintJson(unsigned)) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_TAMPERED', 'Repository cutover checkpoint fingerprint is invalid.');
  }
  assertCheckpointSemantics(checkpoint);
  assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
  if (fs.existsSync(file + '.pending')) reconcileCheckpointTemporary(file, checkpoint);
  const stat = fs.lstatSync(file);
  if (stat.nlink !== 1) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover checkpoint has an unresolved linked temporary.');
  }
  return checkpoint;
}

function assertSnapshotSemantics(snapshot, label) {
  if (!exactKeys(snapshot, [
    'state', 'mode', 'contentFingerprint', 'bytesBase64', 'fingerprint'
  ]) || !['present', 'absent'].includes(snapshot.state)) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', label + ' snapshot shape is invalid.');
  }
  if (snapshot.fingerprint !== snapshotFingerprint(snapshot)) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', label + ' snapshot fingerprint is invalid.');
  }
  if (snapshot.state === 'absent') {
    if (snapshot.mode !== null || snapshot.contentFingerprint !== null
      || snapshot.bytesBase64 !== null) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', label + ' absent snapshot contains file material.');
    }
    return;
  }
  if (!SAFE_PUBLIC_FILE_MODES.has(snapshot.mode)
    || !HASH.test(snapshot.contentFingerprint || '')
    || typeof snapshot.bytesBase64 !== 'string') {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', label + ' present snapshot mode or content identity is invalid.');
  }
  let bytes;
  try {
    bytes = Buffer.from(snapshot.bytesBase64, 'base64');
  } catch (error) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', label + ' snapshot bytes are malformed.', error);
  }
  if (bytes.toString('base64') !== snapshot.bytesBase64
    || sha256(bytes) !== snapshot.contentFingerprint) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', label + ' snapshot bytes do not match the exact content fingerprint.');
  }
}

function assertCheckpointSemantics(checkpoint) {
  if (!exactKeys(checkpoint, [
    '$contract', 'contractVersion', 'id', 'checkpointFingerprint',
    'rootIdentityFingerprint', 'request', 'plan', 'operations', 'progress',
    'createdDirectories', 'state', 'phase', 'currentOperationId', 'failure',
    'result', 'updatedAt'
  ])
    || checkpoint.$contract !== CHECKPOINT_CONTRACT
    || checkpoint.contractVersion !== '1.0.0'
    || !HASH.test(checkpoint.rootIdentityFingerprint || '')
    || !exactKeys(checkpoint.request, ['id', 'fingerprint', 'fileFingerprint', 'createdAt'])
    || !REQUEST_ID.test(checkpoint.request.id || '')
    || !HASH.test(checkpoint.request.fingerprint || '')
    || !HASH.test(checkpoint.request.fileFingerprint || '')
    || !exactInstant(checkpoint.request.createdAt)
    || !exactInstant(checkpoint.updatedAt)
    || Date.parse(checkpoint.updatedAt) < Date.parse(checkpoint.request.createdAt)
    || !Array.isArray(checkpoint.operations)
    || !checkpoint.operations.length
    || !Array.isArray(checkpoint.progress)
    || !Array.isArray(checkpoint.createdDirectories)) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover checkpoint shape or identity is invalid.');
  }
  if (checkpoint.id !== 'repository-cutover.'
    + checkpoint.request.fingerprint.slice('sha256:'.length)) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover checkpoint id does not bind its exact request.');
  }
  const paths = new Set();
  for (const [index, operation] of checkpoint.operations.entries()) {
    if (!exactKeys(operation, [
      'id', 'sequence', 'phase', 'path', 'action', 'before', 'after'
    ])
      || operation.id !== `repository-cutover-effect.${String(index).padStart(4, '0')}`
      || operation.sequence !== index
      || !Object.hasOwn(PHASE_ORDER, operation.phase)
      || !['create', 'replace', 'remove'].includes(operation.action)
      || paths.has(operation.path)) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover effect identity, sequence, or phase is invalid.');
    }
    normalizedRelative(operation.path);
    paths.add(operation.path);
    assertSnapshotSemantics(operation.before, 'Prior ' + operation.id);
    assertSnapshotSemantics(operation.after, 'Candidate ' + operation.id);
    const expectedAction = operation.after.state === 'absent' ? 'remove'
      : operation.before.state === 'absent' ? 'create' : 'replace';
    if (operation.action !== expectedAction || snapshotEquals(operation.before, operation.after)) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover effect action does not match its exact snapshots.');
    }
  }
  if (!exactKeys(checkpoint.plan, [
    'lifecycleFingerprint', 'legacyFingerprint', 'basisTreeFingerprint',
    'candidateTreeFingerprint', 'unmanagedTreeFingerprint', 'operationCount',
    'fixtureWriteCount', 'fixtureRemovalCount', 'fixtureState',
    'fixtureRequestFingerprint', 'pendingEvidenceViolationCount',
    'sourceDeletionCount', 'operationalDeletionCount',
    'planFingerprint'
  ])
    || !HASH.test(checkpoint.plan.lifecycleFingerprint || '')
    || !HASH.test(checkpoint.plan.legacyFingerprint || '')
    || !HASH.test(checkpoint.plan.basisTreeFingerprint || '')
    || !HASH.test(checkpoint.plan.candidateTreeFingerprint || '')
    || !HASH.test(checkpoint.plan.unmanagedTreeFingerprint || '')
    || checkpoint.plan.operationCount !== checkpoint.operations.length
    || checkpoint.plan.fixtureWriteCount !== 0
    || checkpoint.plan.fixtureRemovalCount !== 0
    || checkpoint.plan.fixtureState !== 'pending-evidence-finalization'
    || !HASH.test(checkpoint.plan.fixtureRequestFingerprint || '')
    || !Number.isInteger(checkpoint.plan.pendingEvidenceViolationCount)
    || checkpoint.plan.pendingEvidenceViolationCount < 0
    || checkpoint.plan.sourceDeletionCount !== EXPECTED_SOURCE_DELETIONS
    || checkpoint.plan.operationalDeletionCount !== EXPECTED_OPERATIONAL_DELETIONS.length
    || checkpoint.plan.planFingerprint !== cutoverPlanFingerprint(
      checkpoint.plan,
      checkpoint.operations
    )) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover private plan is invalid or stale.');
  }
  if (checkpoint.progress.length !== checkpoint.operations.length) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover progress length is stale.');
  }
  for (const [index, progress] of checkpoint.progress.entries()) {
    if (!exactKeys(progress, ['id', 'state', 'observedFingerprint'])
      || progress.id !== checkpoint.operations[index].id
      || !['pending', 'applying', 'applied', 'rolling-back', 'verified', 'rolled-back']
        .includes(progress.state)
      || !HASH.test(progress.observedFingerprint || '')) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover progress record is invalid.');
    }
    const operation = checkpoint.operations[index];
    const allowedFingerprints = progress.state === 'rolling-back'
      ? new Set([operation.before.fingerprint, operation.after.fingerprint])
      : new Set([
        ['pending', 'applying', 'rolled-back'].includes(progress.state)
          ? operation.before.fingerprint
          : operation.after.fingerprint
      ]);
    if (!allowedFingerprints.has(progress.observedFingerprint)) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover progress does not bind the exact state snapshot.');
    }
  }
  const directoryPaths = new Set();
  for (const directory of checkpoint.createdDirectories) {
    if (!exactKeys(directory, ['path', 'state'])
      || !['planned', 'creating', 'created', 'removed'].includes(directory.state)
      || directoryPaths.has(directory.path)) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover created-directory record is invalid.');
    }
    normalizedRelative(directory.path);
    if (!checkpoint.operations.some((operation) => {
      return operation.after.state === 'present'
        && operation.path.startsWith(directory.path + '/');
    })) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover directory is not a parent of an exact create or replace effect.');
    }
    directoryPaths.add(directory.path);
  }
  const currentIndex = checkpoint.currentOperationId === null ? -1
    : checkpoint.operations.findIndex((operation) => operation.id === checkpoint.currentOperationId);
  if (checkpoint.currentOperationId !== null && currentIndex < 0) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover current operation is not in the exact plan.');
  }
  const states = checkpoint.progress.map((row) => row.state);
  const allStates = (expected) => states.every((state) => state === expected);
  const directoryStates = checkpoint.createdDirectories.map((row) => row.state);
  const allDirectories = (expected) => directoryStates.every((state) => state === expected);
  const applyingPrefix = (() => {
    let pendingSeen = false;
    let applyingSeen = false;
    for (const state of states) {
      if (state === 'pending') pendingSeen = true;
      else if (state === 'applying') {
        if (pendingSeen || applyingSeen) return false;
        applyingSeen = true;
        pendingSeen = true;
      } else if (state !== 'applied' || pendingSeen) return false;
    }
    return true;
  })();
  const rolledBackSuffix = (() => {
    let rolledBackSeen = false;
    for (const state of states) {
      if (state === 'rolled-back') rolledBackSeen = true;
      else if (rolledBackSeen) return false;
    }
    return states.every((state) => [
      'pending', 'applying', 'applied', 'rolling-back', 'rolled-back'
    ].includes(state));
  })();
  const lifecycleValid = (
    checkpoint.state === 'prepared' && checkpoint.phase === 'prepared'
      && checkpoint.currentOperationId === null
      && checkpoint.failure === null && checkpoint.result === null
      && allStates('pending') && allDirectories('planned')
  ) || (
    checkpoint.state === 'applying' && checkpoint.phase === 'effects'
      && currentIndex >= 0
      && ['pending', 'applying', 'applied'].includes(states[currentIndex])
      && applyingPrefix && checkpoint.failure === null && checkpoint.result === null
      && directoryStates.every((state) => ['planned', 'creating', 'created'].includes(state))
  ) || (
    checkpoint.state === 'applying' && checkpoint.phase === 'verifying'
      && checkpoint.currentOperationId === null
      && allStates('applied') && checkpoint.failure === null && checkpoint.result === null
      && allDirectories('created')
  ) || (
    checkpoint.state === 'rolling-back' && checkpoint.phase === 'rollback'
      && currentIndex >= 0 && rolledBackSuffix && checkpoint.result === null
      && ['pending', 'applying', 'applied', 'rolling-back', 'rolled-back']
        .includes(states[currentIndex])
      && directoryStates.every((state) => ['planned', 'creating', 'created', 'removed'].includes(state))
  ) || (
    checkpoint.state === 'completed' && checkpoint.phase === 'terminal'
      && checkpoint.currentOperationId === null
      && checkpoint.failure === null && checkpoint.result?.state === 'completed'
      && allStates('verified') && allDirectories('created')
  ) || (
    checkpoint.state === 'rolled-back' && checkpoint.phase === 'terminal'
      && checkpoint.currentOperationId === null
      && checkpoint.failure === null && checkpoint.result?.state === 'rolled-back'
      && allStates('rolled-back') && allDirectories('removed')
  ) || (
    checkpoint.state === 'needs-attention' && checkpoint.phase === 'terminal'
      && checkpoint.currentOperationId === null
      && checkpoint.failure !== null && checkpoint.result === null
  );
  if (!lifecycleValid) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover checkpoint lifecycle facts are contradictory.');
  }
  if (checkpoint.failure !== null
    && (!exactKeys(checkpoint.failure, ['reasonCode', 'summary'])
      || !/^REPOSITORY_CUTOVER_[A-Z0-9_]+$/.test(checkpoint.failure.reasonCode || '')
      || !FAILURE_SUMMARIES.has(checkpoint.failure.summary))) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover checkpoint failure is malformed.');
  }
  if (checkpoint.result !== null) {
    const rolledBackResult = exactKeys(checkpoint.result, [
      'state', 'repositoryCandidateMaterialized', 'evidenceAndFixturesMaterialized'
    ])
      && checkpoint.result.state === 'rolled-back'
      && checkpoint.result.repositoryCandidateMaterialized === false
      && checkpoint.result.evidenceAndFixturesMaterialized === false;
    const completedResult = exactKeys(checkpoint.result, [
      'state', 'repositoryCandidateMaterialized', 'evidenceAndFixturesMaterialized',
      'pendingEvidenceFinalization', 'fixtureFinalizationRequestFingerprint',
      'candidateTreeFingerprint', 'claimBoundary'
    ])
      && checkpoint.result.state === 'completed'
      && checkpoint.result.repositoryCandidateMaterialized === true
      && checkpoint.result.evidenceAndFixturesMaterialized === false
      && checkpoint.result.pendingEvidenceFinalization === true
      && checkpoint.result.fixtureFinalizationRequestFingerprint
        === checkpoint.plan.fixtureRequestFingerprint
      && checkpoint.result.candidateTreeFingerprint === checkpoint.plan.candidateTreeFingerprint
      && checkpoint.result.claimBoundary === 'exact-local-repository-cutover-only';
    if (!rolledBackResult && !completedResult) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover terminal result is invalid.');
    }
  }
}

function copyPublicTree(root) {
  const stage = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), 'soter-repository-cutover-stage-')
  ));
  fs.chmodSync(stage, 0o700);
  const copy = (source, destination, relativeDirectory = '') => {
    const entries = fs.readdirSync(source, { withFileTypes: true })
      .sort((left, right) => compareCodepoint(left.name, right.name));
    for (const entry of entries) {
      if (!relativeDirectory && EXCLUDED_PUBLIC_ROOTS.has(entry.name)) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        fail('REPOSITORY_CUTOVER_SYMLINK_REJECTED', 'Public repository tree contains a symbolic link: ' + relative);
      }
      if (entry.isDirectory()) {
        if ((stat.mode & 0o7777) !== 0o755) {
          fail('REPOSITORY_CUTOVER_DIRECTORY_MODE_INVALID', 'Public repository directory mode is outside the closed 0755 policy: ' + relative);
        }
        fs.mkdirSync(destinationPath, { mode: stat.mode & 0o777 });
        fs.chmodSync(destinationPath, stat.mode & 0o777);
        copy(sourcePath, destinationPath, relative);
        continue;
      }
      if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7000) !== 0) {
        fail('REPOSITORY_CUTOVER_FILE_INVALID', 'Public repository tree contains an unsafe file: ' + relative);
      }
      fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destinationPath, stat.mode & 0o777);
    }
  };
  copy(resolvedRealRoot(root), stage);
  return stage;
}

function writeStageBytes(stage, relative, bytes, mode = 0o644) {
  const target = confinedPath(stage, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      fail('REPOSITORY_CUTOVER_FILE_INVALID', 'Staged target is not one regular non-linked file: ' + relative);
    }
  }
  fs.writeFileSync(target, bytes);
  fs.chmodSync(target, mode);
}

function removeStageFile(stage, relative, expectedFingerprint = null) {
  const target = confinedPath(stage, relative, { allowMissing: false });
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail('REPOSITORY_CUTOVER_FILE_INVALID', 'Staged deletion target is not one regular non-linked file: ' + relative);
  }
  if (expectedFingerprint && fingerprintFile(target) !== expectedFingerprint) {
    fail('REPOSITORY_CUTOVER_BASIS_DRIFT', 'Staged deletion target bytes drifted: ' + relative);
  }
  fs.unlinkSync(target);
}

function copyCheckerReceipt(root, stage, checkerReceipt) {
  const relative = `.soter/state/legacy-checker-runs/${checkerReceipt.id}.json`;
  const source = confinedPath(root, relative, { allowMissing: false });
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)) {
    fail('REPOSITORY_CUTOVER_CHECKER_RECEIPT_INVALID', 'Legacy checker receipt is not one exact private 0600 file.');
  }
  const target = path.join(stage, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
}

function registerPhase(phases, relative, phase) {
  normalizedRelative(relative);
  const prior = phases.get(relative);
  if (!prior || PHASE_ORDER[phase] > PHASE_ORDER[prior]) phases.set(relative, phase);
}

function restoreCrmVocabulary(stage, checkerRun) {
  const relative = 'soter/contexts/crm/vocabulary.json';
  const target = confinedPath(stage, relative, { allowMissing: false });
  const current = readJson(target);
  if (fingerprintFile(target) !== checkerRun.temporaryCrmVocabularyFingerprint) {
    fail('REPOSITORY_CUTOVER_CHECKER_SHIM_INVALID', 'Temporary CRM vocabulary bytes do not match the exact checker receipt.');
  }
  const channelEntries = current.entries?.filter((entry) => entry.id === 'channel') || [];
  if (channelEntries.length !== 1) {
    fail('REPOSITORY_CUTOVER_CHECKER_SHIM_INVALID', 'Temporary CRM vocabulary has no single exact Channel shim.');
  }
  const restored = structuredClone(current);
  restored.entries = restored.entries.filter((entry) => entry.id !== 'channel');
  if (fingerprintJson(restored) !== checkerRun.temporaryCrmVocabularyBaseFingerprint) {
    fail('REPOSITORY_CUTOVER_CHECKER_SHIM_INVALID', 'CRM vocabulary contains changes beyond the exact temporary Channel shim.');
  }
  writeStageBytes(stage, relative, canonicalBytes(restored));
  return relative;
}

async function withVerifiedSubrequestFiles(inputs, callback) {
  for (const input of inputs) {
    if (!input || !HASH.test(input.fingerprint || '')
      || sha256(canonicalBytes(input.value)) !== input.fingerprint) {
      fail('REPOSITORY_CUTOVER_SUBREQUEST_DRIFT', 'A cutover subrequest no longer matches its initially verified bytes.');
    }
  }
  const directory = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), 'soter-repository-cutover-subrequest-')
  ));
  fs.chmodSync(directory, 0o700);
  try {
    const files = {};
    for (const input of inputs) {
      const file = path.join(directory, input.name + '.json');
      writeCanonicalPrivate(file, input.value);
      files[input.name] = file;
    }
    const result = await callback(files);
    for (const input of inputs) {
      if (fingerprintFile(files[input.name]) !== input.fingerprint) {
        fail('REPOSITORY_CUTOVER_SUBREQUEST_DRIFT', 'A cutover subrequest changed during downstream validation.');
      }
    }
    return result;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function operationFromTrees(root, stage, relative, phase, sequence) {
  const before = snapshotFile(root, relative);
  const after = snapshotFile(stage, relative);
  if (snapshotEquals(before, after)) return null;
  return {
    id: `repository-cutover-effect.${String(sequence).padStart(4, '0')}`,
    sequence,
    phase,
    path: relative,
    action: after.state === 'absent' ? 'remove' : before.state === 'absent' ? 'create' : 'replace',
    before,
    after
  };
}

async function buildCutoverCandidate(root, requestInput, at) {
  const { request, verifiedSubrequests } = requestInput;
  const publicBefore = publicTreeManifest(root);
  const coordinated = await withVerifiedSubrequestFiles([{
    name: 'lifecycle',
    ...verifiedSubrequests.lifecycleRequest
  }, {
    name: 'transition',
    ...verifiedSubrequests.transitionRequest
  }], async (files) => {
    const lifecycle = buildDevelopmentWorkflowLifecycleFinalizationCandidate({
      root,
      requestPath: files.lifecycle
    });
    const transition = await readLegacyFinalizationTransitionRequest({
      root,
      requestPath: files.transition,
      lifecycleRequestPath: files.lifecycle,
      at
    });
    return { lifecycle, transition };
  });
  const { lifecycle, transition } = coordinated;
  if (lifecycle.plan.authority?.repositoryWrites !== false
    || lifecycle.plan.authority?.sourceDeletion !== false
    || lifecycle.plan.authority?.fallbackRemoval !== false
    || lifecycle.files.length !== 30) {
    fail('REPOSITORY_CUTOVER_LIFECYCLE_PLAN_INVALID', 'Workflow lifecycle candidate is not the exact thirty-file no-authority plan.');
  }
  const fixtureRequest = structuredClone(transition.fixtureRequest);
  const legacy = structuredClone(transition.legacyPlan);
  if (!sameJson(fixtureRequest, verifiedSubrequests.fixtureFinalizationRequest.value)) {
    fail(
      'REPOSITORY_CUTOVER_SUBREQUEST_DRIFT',
      'Standalone fixture finalization request is not the exact request derived and sealed by the full transition request.'
    );
  }
  if (legacy.summary.transitionCount !== EXPECTED_BINDING_TRANSITIONS
    || legacy.summary.sourceDeletionCount !== EXPECTED_SOURCE_DELETIONS
    || legacy.summary.operationalDeletionCount !== EXPECTED_OPERATIONAL_DELETIONS.length
    || !sameJson(legacy.requiredOperationalDeletions.map((entry) => entry.path), EXPECTED_OPERATIONAL_DELETIONS)
    || legacy.candidate.inventoryFingerprint !== fixtureRequest.expectedInventoryFingerprint
    || !sameJson(legacy.finalEvidencePaths, fixtureRequest.evidencePaths)
    || !sameJson(transition.request.checkerReceipt, fixtureRequest.checkerReceipt)
    || !sameJson(transition.authorizationEvidenceOverlay, transition.request.authorizationEvidenceOverlay)
    || !sameJson(transition.obsoleteFixturePlan, transition.request.obsoleteFixturePlan)) {
    fail('REPOSITORY_CUTOVER_FINALIZATION_SCOPE_INVALID', 'Legacy transition and fixture requests do not bind the exact 108-binding, 79-source finalization set.');
  }
  for (const retired of lifecycle.request.retired) {
    if (!legacy.finalEvidencePaths.includes(retired.evidence.path)) {
      fail('REPOSITORY_CUTOVER_LIFECYCLE_EVIDENCE_INVALID', 'Retired workflow evidence is not part of the exact final evidence set.');
    }
  }

  const stage = copyPublicTree(root);
  const phases = new Map();
  try {
    copyCheckerReceipt(root, stage, transition.request.checkerReceipt);
    for (const output of lifecycle.files) {
      const current = snapshotFile(stage, output.path);
      if (current.contentFingerprint !== output.beforeFileFingerprint || current.mode !== output.mode) {
        fail('REPOSITORY_CUTOVER_LIFECYCLE_PLAN_INVALID', 'Workflow lifecycle source changed before staging: ' + output.path);
      }
      const bytes = canonicalBytes(output.after);
      if (sha256(bytes) !== output.afterFileFingerprint) {
        fail('REPOSITORY_CUTOVER_LIFECYCLE_PLAN_INVALID', 'Workflow lifecycle candidate bytes do not match their exact fingerprint.');
      }
      writeStageBytes(stage, output.path, bytes, 0o644);
      registerPhase(phases, output.path, 'workflow');
    }

    const currentInventory = snapshotFile(stage, legacy.inventoryUpdate.path);
    if (currentInventory.contentFingerprint !== legacy.inventoryUpdate.currentFileFingerprint
      || legacy.candidate.inventoryFingerprint !== legacy.inventoryUpdate.candidateFingerprint) {
      fail('REPOSITORY_CUTOVER_BASIS_DRIFT', 'Legacy inventory candidate changed before staging.');
    }
    writeStageBytes(stage, legacy.inventoryUpdate.path, canonicalBytes(legacy.candidate));
    registerPhase(phases, legacy.inventoryUpdate.path, 'legacy');
    for (const update of legacy.migrationUpdates) {
      const current = snapshotFile(stage, update.path);
      if (current.contentFingerprint !== update.currentFileFingerprint) {
        fail('REPOSITORY_CUTOVER_BASIS_DRIFT', 'Ordinary migration document changed before staging: ' + update.path);
      }
      if (fingerprintJson(update.document) !== update.candidateDocumentFingerprint) {
        fail('REPOSITORY_CUTOVER_FINALIZATION_SCOPE_INVALID', 'Ordinary migration candidate fingerprint is invalid: ' + update.path);
      }
      writeStageBytes(stage, update.path, canonicalBytes(update.document));
      registerPhase(phases, update.path, 'legacy');
    }
    for (const output of legacy.requiredGovernedOutputs) {
      const unsigned = structuredClone(output.document);
      unsigned.projectionFingerprint = null;
      if (output.document.projectionFingerprint !== output.fingerprint
        || fingerprintJson(unsigned) !== output.fingerprint) {
        fail('REPOSITORY_CUTOVER_CHECKER_PROJECTION_INVALID', 'Governed checker projection fingerprint is invalid.');
      }
      writeStageBytes(stage, output.path, canonicalBytes(output.document));
      registerPhase(phases, output.path, 'legacy');
    }
    const shimPath = restoreCrmVocabulary(stage, legacy.basis.legacyCheckerRun);
    registerPhase(phases, shimPath, 'checker-shim');

    for (const deletion of legacy.sourceDeletions) {
      removeStageFile(stage, deletion.path, deletion.fingerprint);
      registerPhase(phases, deletion.path, 'legacy-source');
    }
    for (const deletion of legacy.requiredOperationalDeletions) {
      removeStageFile(stage, deletion.path);
      registerPhase(phases, deletion.path, 'operational-output');
    }

    const finalizationBasis = assertLegacyFinalizationCandidateBasis({
      root: stage,
      expectedInventoryFingerprint: fixtureRequest.expectedInventoryFingerprint,
      checkerReceipt: fixtureRequest.checkerReceipt,
      evidencePaths: fixtureRequest.evidencePaths,
      verification: verifySoter(stage, { includeRuntimeArtifacts: false })
    });

    const publicAfter = publicTreeManifest(stage);
    const liveAfterPreflight = publicTreeManifest(root);
    if (liveAfterPreflight.fingerprint !== publicBefore.fingerprint) {
      fail('REPOSITORY_CUTOVER_BASIS_DRIFT', 'Public repository tree changed during cutover preflight.');
    }
    const beforeMap = new Map(publicBefore.files.map((entry) => [entry.path, entry]));
    const afterMap = new Map(publicAfter.files.map((entry) => [entry.path, entry]));
    const changed = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].filter((relative) => {
      return fingerprintJson(beforeMap.get(relative) || null) !== fingerprintJson(afterMap.get(relative) || null);
    });
    for (const relative of changed) {
      if (!phases.has(relative)) {
        fail('REPOSITORY_CUTOVER_UNDECLARED_CHANGE', 'Staged final tree contains an undeclared changed path: ' + relative);
      }
    }
    const ordered = changed.sort((left, right) => {
      const phase = PHASE_ORDER[phases.get(left)] - PHASE_ORDER[phases.get(right)];
      return phase || compareCodepoint(left, right);
    });
    const operations = ordered.map((relative, sequence) => {
      return operationFromTrees(root, stage, relative, phases.get(relative), sequence);
    }).filter(Boolean);
    const plannedPaths = new Set(operations.map((operation) => operation.path));
    const unmanagedTreeFingerprint = publicTreeManifest(root, plannedPaths).fingerprint;
    return {
      lifecycle,
      legacy,
      fixture: {
        writeCount: 0,
        removalCount: 0,
        state: 'pending-evidence-finalization',
        requestFingerprint: request.fixtureFinalizationRequest.fingerprint,
        pendingEvidenceViolationCount: finalizationBasis.pendingEvidenceViolations
      },
      operations,
      basisTreeFingerprint: publicBefore.fingerprint,
      candidateTreeFingerprint: publicAfter.fingerprint,
      unmanagedTreeFingerprint
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function plannedParentDirectories(root, operations) {
  const planned = new Set();
  for (const operation of operations) {
    if (operation.after.state !== 'present') continue;
    const parts = operation.path.split('/').slice(0, -1);
    let relative = '';
    for (const part of parts) {
      relative = relative ? `${relative}/${part}` : part;
      const target = confinedPath(root, relative);
      if (!fs.existsSync(target)) {
        planned.add(relative);
        continue;
      }
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()
        || modeString(stat) !== SAFE_PUBLIC_DIRECTORY_MODE) {
        fail('REPOSITORY_CUTOVER_PATH_INVALID', 'Repository cutover output parent is unsafe: ' + relative);
      }
    }
  }
  return [...planned]
    .sort((left, right) => {
      const depth = left.split('/').length - right.split('/').length;
      return depth || compareCodepoint(left, right);
    })
    .map((relative) => ({ path: relative, state: 'planned' }));
}

function checkpointFromCandidate(root, requestInput, candidate, at) {
  const request = requestInput.request;
  const id = 'repository-cutover.' + request.requestFingerprint.slice('sha256:'.length);
  const operations = candidate.operations.map((operation) => structuredClone(operation));
  const checkpoint = {
    $contract: CHECKPOINT_CONTRACT,
    contractVersion: '1.0.0',
    id,
    checkpointFingerprint: null,
    rootIdentityFingerprint: request.rootIdentityFingerprint,
    request: {
      id: request.id,
      fingerprint: request.requestFingerprint,
      fileFingerprint: requestInput.requestFileFingerprint,
      createdAt: request.createdAt
    },
    plan: {
      lifecycleFingerprint: candidate.lifecycle.plan.planFingerprint,
      legacyFingerprint: candidate.legacy.planFingerprint,
      basisTreeFingerprint: candidate.basisTreeFingerprint,
      candidateTreeFingerprint: candidate.candidateTreeFingerprint,
      unmanagedTreeFingerprint: candidate.unmanagedTreeFingerprint,
      operationCount: operations.length,
      fixtureWriteCount: candidate.fixture.writeCount,
      fixtureRemovalCount: candidate.fixture.removalCount,
      fixtureState: candidate.fixture.state || 'pending-evidence-finalization',
      fixtureRequestFingerprint: candidate.fixture.requestFingerprint || null,
      pendingEvidenceViolationCount: candidate.fixture.pendingEvidenceViolationCount ?? 0,
      sourceDeletionCount: candidate.legacy.summary.sourceDeletionCount,
      operationalDeletionCount: candidate.legacy.summary.operationalDeletionCount,
      planFingerprint: null
    },
    operations,
    progress: operations.map((operation) => ({
      id: operation.id,
      state: 'pending',
      observedFingerprint: operation.before.fingerprint
    })),
    createdDirectories: plannedParentDirectories(root, operations),
    state: 'prepared',
    phase: 'prepared',
    currentOperationId: null,
    failure: null,
    result: null,
    updatedAt: at
  };
  checkpoint.plan.planFingerprint = cutoverPlanFingerprint(checkpoint.plan, operations);
  return checkpoint;
}

export async function prepareRepositoryCutover({ root, requestPath, at, ...unknown } = {}) {
  if (Object.keys(unknown).length || !exactInstant(at)) {
    fail('REPOSITORY_CUTOVER_ARGUMENTS_INVALID', 'Repository cutover preparation requires one exact request and caller-supplied time.');
  }
  const resolvedRoot = resolvedRealRoot(root);
  const requestInput = readRepositoryCutoverRequest({ root: resolvedRoot, requestPath });
  if (Date.parse(at) < Date.parse(requestInput.request.createdAt)) {
    fail('REPOSITORY_CUTOVER_TIME_INVALID', 'Repository cutover preparation cannot predate its exact request.');
  }
  const candidate = await buildCutoverCandidate(resolvedRoot, requestInput, at);
  const checkpoint = checkpointFromCandidate(resolvedRoot, requestInput, candidate, at);
  persistCheckpoint(resolvedRoot, checkpoint, { create: true });
  return inspectRepositoryCutover({ root: resolvedRoot, checkpointId: checkpoint.id });
}

function assertUnmanagedTree(root, checkpoint) {
  const ignored = new Set(checkpoint.operations.map((operation) => operation.path));
  if (publicTreeManifest(root, ignored).fingerprint !== checkpoint.plan.unmanagedTreeFingerprint) {
    fail('REPOSITORY_CUTOVER_UNMANAGED_DRIFT', 'A public repository path outside the exact cutover plan changed.');
  }
}

function operationStates(root, checkpoint) {
  return checkpoint.operations.map((operation) => {
    const observed = snapshotFile(root, operation.path);
    const state = snapshotEquals(observed, operation.before) ? 'before'
      : snapshotEquals(observed, operation.after) ? 'after'
        : 'unknown';
    return { observed, state };
  });
}

function ensureParentDirectories(root, operation, checkpoint, faultAfter = null) {
  if (operation.after.state !== 'present') return;
  const parts = operation.path.split('/').slice(0, -1);
  let relative = '';
  for (const part of parts) {
    relative = relative ? `${relative}/${part}` : part;
    assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
    const target = confinedPath(root, relative);
    const record = checkpoint.createdDirectories.find((row) => row.path === relative) || null;
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()
        || modeString(stat) !== SAFE_PUBLIC_DIRECTORY_MODE) {
        fail('REPOSITORY_CUTOVER_PATH_INVALID', 'Repository cutover output parent is unsafe: ' + relative);
      }
      if (!record) continue;
      if (record.state === 'planned') {
        fail('REPOSITORY_CUTOVER_DIRECTORY_DRIFT', 'A planned output directory appeared before its checkpoint-owned create step.');
      }
      if (record.state === 'removed') {
        fail('REPOSITORY_CUTOVER_DIRECTORY_DRIFT', 'A rolled-back output directory reappeared.');
      }
      if (record.state === 'creating') {
        if (fs.readdirSync(target).length) {
          fail('REPOSITORY_CUTOVER_DIRECTORY_DRIFT', 'A partially created output directory contains unowned entries.');
        }
        record.state = 'created';
        persistCheckpoint(root, checkpoint);
      }
      continue;
    }
    if (!record || !['planned', 'creating'].includes(record.state)) {
      fail('REPOSITORY_CUTOVER_DIRECTORY_DRIFT', 'An exact output parent is missing outside its checkpoint-owned create step.');
    }
    if (record.state === 'planned') {
      record.state = 'creating';
      persistCheckpoint(root, checkpoint);
    }
    maybeFault(faultAfter, 'crash-before-directory:' + relative);
    assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
    fs.mkdirSync(target, { recursive: false, mode: 0o755 });
    fs.chmodSync(target, 0o755);
    fsyncDirectory(path.dirname(target));
    maybeFault(faultAfter, 'crash-after-directory:' + relative);
    record.state = 'created';
    persistCheckpoint(root, checkpoint);
  }
}

function operationTemporaryPath(root, operation, checkpoint, rollback = false) {
  const target = confinedPath(root, operation.path);
  return target + '.' + checkpoint.id
    + (rollback ? '.rollback' : '') + '.pending';
}

function progressForOperation(checkpoint, operation) {
  const progress = checkpoint.progress[operation.sequence];
  if (!progress || progress.id !== operation.id) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover operation progress is unavailable.');
  }
  return progress;
}

function reconcileOperationTemporary(root, operation, checkpoint, rollback = false) {
  const temporary = operationTemporaryPath(root, operation, checkpoint, rollback);
  if (!fs.existsSync(temporary)) return;
  const progress = progressForOperation(checkpoint, operation);
  const owned = rollback
    ? progress.state === 'rolling-back'
    : progress.state === 'applying';
  if (!owned) {
    fail('REPOSITORY_CUTOVER_TEMP_COLLISION', 'Repository cutover output temporary appeared before its exact checkpoint-owned effect step.');
  }
  const stat = fs.lstatSync(temporary);
  const expected = rollback ? operation.before : operation.after;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || (stat.mode & 0o7000) !== 0
    || expected.state !== 'present'
    || modeString(stat) !== expected.mode
    || fingerprintFile(temporary) !== expected.contentFingerprint) {
    fail('REPOSITORY_CUTOVER_TEMP_COLLISION', 'Repository cutover output temporary is not the exact checkpoint-owned candidate.');
  }
  assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
  unlinkDurably(temporary);
}

function atomicWriteSnapshot(root, operation, expected, desired, checkpoint, rollback = false) {
  const target = confinedPath(root, operation.path);
  const requiredProgress = rollback ? 'rolling-back' : 'applying';
  if (progressForOperation(checkpoint, operation).state !== requiredProgress) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover atomic effect lacks its durable per-operation ownership marker.');
  }
  reconcileOperationTemporary(root, operation, checkpoint, rollback);
  const observed = snapshotFile(root, operation.path);
  if (!snapshotEquals(observed, expected)) {
    fail('REPOSITORY_CUTOVER_EFFECT_DRIFT', 'Repository file changed immediately before its exact atomic effect.');
  }
  const temporary = operationTemporaryPath(root, operation, checkpoint, rollback);
  let descriptor = null;
  let createdTemporary = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    createdTemporary = true;
    fs.writeFileSync(descriptor, Buffer.from(desired.bytesBase64, 'base64'));
    fs.fchmodSync(descriptor, Number.parseInt(desired.mode, 8));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    const rechecked = snapshotFile(root, operation.path);
    if (!snapshotEquals(rechecked, expected)) {
      fail('REPOSITORY_CUTOVER_EFFECT_DRIFT', 'Repository file changed before atomic replacement.');
    }
    assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
    fs.renameSync(temporary, target);
    fsyncDirectory(path.dirname(target));
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (createdTemporary && fs.existsSync(temporary)) unlinkDurably(temporary);
  }
  const after = snapshotFile(root, operation.path);
  if (!snapshotEquals(after, desired)) {
    fail('REPOSITORY_CUTOVER_EFFECT_VERIFY_FAILED', 'Atomic repository write did not produce exact candidate bytes and mode.');
  }
  return after;
}

function applyOperation(root, operation, checkpoint, faultAfter = null) {
  if (progressForOperation(checkpoint, operation).state !== 'applying') {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover effect lacks its durable begun marker.');
  }
  assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
  ensureParentDirectories(root, operation, checkpoint, faultAfter);
  if (operation.after.state === 'absent') {
    const observed = snapshotFile(root, operation.path);
    if (!snapshotEquals(observed, operation.before)) {
      fail('REPOSITORY_CUTOVER_EFFECT_DRIFT', 'Repository deletion target changed immediately before removal.');
    }
    assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
    unlinkDurably(confinedPath(root, operation.path, { allowMissing: false }));
    const after = snapshotFile(root, operation.path);
    if (!snapshotEquals(after, operation.after)) {
      fail('REPOSITORY_CUTOVER_EFFECT_VERIFY_FAILED', 'Repository deletion did not verify absent.');
    }
    return after;
  }
  return atomicWriteSnapshot(root, operation, operation.before, operation.after, checkpoint);
}

function restoreOperation(root, operation, checkpoint) {
  if (progressForOperation(checkpoint, operation).state !== 'rolling-back') {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover rollback effect lacks its durable begun marker.');
  }
  assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
  reconcileOperationTemporary(root, operation, checkpoint, true);
  const observed = snapshotFile(root, operation.path);
  if (snapshotEquals(observed, operation.before)) return observed;
  if (!snapshotEquals(observed, operation.after)) {
    fail('REPOSITORY_CUTOVER_ROLLBACK_DRIFT', 'Repository file is neither exact prior nor exact candidate state during rollback.');
  }
  if (operation.before.state === 'absent') {
    assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
    unlinkDurably(confinedPath(root, operation.path, { allowMissing: false }));
    return snapshotFile(root, operation.path);
  }
  ensureParentDirectories(root, operation, checkpoint);
  return atomicWriteSnapshot(
    root,
    operation,
    operation.after,
    operation.before,
    checkpoint,
    true
  );
}

function markNeedsAttention(root, checkpoint, reasonCode) {
  checkpoint.state = 'needs-attention';
  checkpoint.phase = 'terminal';
  checkpoint.currentOperationId = null;
  checkpoint.failure = {
    reasonCode: /^REPOSITORY_CUTOVER_[A-Z0-9_]+$/.test(reasonCode || '')
      ? reasonCode
      : 'REPOSITORY_CUTOVER_RECOVERY_FAILED',
    summary: 'Repository cutover cannot safely continue or roll back without exact checkpoint-bound reconciliation.'
  };
  checkpoint.result = null;
  return persistCheckpoint(root, checkpoint);
}

function assertRollbackRecoveryBasis(root, checkpoint) {
  for (const operation of checkpoint.operations) {
    const progress = progressForOperation(checkpoint, operation);
    reconcileOperationTemporary(root, operation, checkpoint);
    reconcileOperationTemporary(root, operation, checkpoint, true);
    const observed = snapshotFile(root, operation.path);
    if (['pending', 'rolled-back'].includes(progress.state)
      && !snapshotEquals(observed, operation.before)) {
      fail('REPOSITORY_CUTOVER_ROLLBACK_DRIFT', 'An unbegun or rolled-back repository effect is not in its exact prior state.');
    }
    if (progress.state === 'applied' && !snapshotEquals(observed, operation.after)) {
      fail('REPOSITORY_CUTOVER_ROLLBACK_DRIFT', 'An applied repository effect changed before its rollback began.');
    }
    if (['applying', 'rolling-back'].includes(progress.state)
      && !snapshotEquals(observed, operation.before)
      && !snapshotEquals(observed, operation.after)) {
      fail('REPOSITORY_CUTOVER_ROLLBACK_DRIFT', 'A begun repository effect is outside its exact prior or candidate state.');
    }
    if (!['pending', 'applying', 'applied', 'rolling-back', 'rolled-back']
      .includes(progress.state)) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover rollback encountered an impossible effect state.');
    }
  }
}

export function rollbackRepositoryCutover({ root, checkpointId, at, ...unknown } = {}) {
  if (Object.keys(unknown).length || !exactInstant(at)) {
    fail('REPOSITORY_CUTOVER_ARGUMENTS_INVALID', 'Repository cutover rollback requires only an exact checkpoint and time.');
  }
  const resolvedRoot = resolvedRealRoot(root);
  const checkpoint = readCheckpoint(resolvedRoot, checkpointId);
  assertMonotonicTime(checkpoint, at);
  if (checkpoint.state === 'rolled-back') return inspectRepositoryCutover({ root: resolvedRoot, checkpointId });
  if (checkpoint.state === 'completed') {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_TERMINAL', 'Completed repository cutover cannot be rolled back through a reusable request.');
  }
  try {
    const firstPendingRollback = (() => {
      for (let index = checkpoint.operations.length - 1; index >= 0; index -= 1) {
        if (checkpoint.progress[index].state !== 'rolled-back') return index;
      }
      return checkpoint.operations.length - 1;
    })();
    checkpoint.state = 'rolling-back';
    checkpoint.phase = 'rollback';
    checkpoint.currentOperationId = checkpoint.operations[firstPendingRollback].id;
    checkpoint.updatedAt = at;
    persistCheckpoint(resolvedRoot, checkpoint);
    assertRollbackRecoveryBasis(resolvedRoot, checkpoint);
    assertUnmanagedTree(resolvedRoot, checkpoint);
    for (let index = checkpoint.operations.length - 1; index >= 0; index -= 1) {
      const operation = checkpoint.operations[index];
      const progress = checkpoint.progress[index];
      if (progress.state === 'rolled-back') {
        const observed = snapshotFile(resolvedRoot, operation.path);
        if (!snapshotEquals(observed, operation.before)) {
          fail('REPOSITORY_CUTOVER_ROLLBACK_DRIFT', 'A rolled-back repository effect no longer matches its exact prior state.');
        }
        continue;
      }
      checkpoint.currentOperationId = operation.id;
      if (progress.state === 'pending') {
        reconcileOperationTemporary(resolvedRoot, operation, checkpoint);
        reconcileOperationTemporary(resolvedRoot, operation, checkpoint, true);
        const observed = snapshotFile(resolvedRoot, operation.path);
        if (!snapshotEquals(observed, operation.before)) {
          fail('REPOSITORY_CUTOVER_ROLLBACK_DRIFT', 'An unbegun repository effect changed before rollback and is not transaction-owned.');
        }
        progress.state = 'rolled-back';
        progress.observedFingerprint = observed.fingerprint;
        persistCheckpoint(resolvedRoot, checkpoint);
        continue;
      }
      let observed;
      if (progress.state === 'applying') {
        reconcileOperationTemporary(resolvedRoot, operation, checkpoint);
        reconcileOperationTemporary(resolvedRoot, operation, checkpoint, true);
        observed = snapshotFile(resolvedRoot, operation.path);
        if (!snapshotEquals(observed, operation.before)
          && !snapshotEquals(observed, operation.after)) {
          fail('REPOSITORY_CUTOVER_ROLLBACK_DRIFT', 'A begun repository effect is outside its exact prior or candidate state.');
        }
      } else if (progress.state === 'applied') {
        reconcileOperationTemporary(resolvedRoot, operation, checkpoint);
        reconcileOperationTemporary(resolvedRoot, operation, checkpoint, true);
        observed = snapshotFile(resolvedRoot, operation.path);
        if (!snapshotEquals(observed, operation.after)) {
          fail('REPOSITORY_CUTOVER_ROLLBACK_DRIFT', 'An applied repository effect changed before its rollback began.');
        }
      } else if (progress.state === 'rolling-back') {
        reconcileOperationTemporary(resolvedRoot, operation, checkpoint);
        reconcileOperationTemporary(resolvedRoot, operation, checkpoint, true);
        observed = snapshotFile(resolvedRoot, operation.path);
        if (!snapshotEquals(observed, operation.before)
          && !snapshotEquals(observed, operation.after)) {
          fail('REPOSITORY_CUTOVER_ROLLBACK_DRIFT', 'A begun repository rollback is outside its exact prior or candidate state.');
        }
      } else {
        fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover rollback encountered an impossible effect state.');
      }
      if (progress.state !== 'rolling-back') {
        progress.state = 'rolling-back';
        progress.observedFingerprint = observed.fingerprint;
        persistCheckpoint(resolvedRoot, checkpoint);
      }
      persistCheckpoint(resolvedRoot, checkpoint);
      const restored = restoreOperation(resolvedRoot, operation, checkpoint);
      progress.state = 'rolled-back';
      progress.observedFingerprint = restored.fingerprint;
      persistCheckpoint(resolvedRoot, checkpoint);
    }
    for (const directory of [...checkpoint.createdDirectories].reverse()) {
      if (directory.state === 'removed') continue;
      const target = confinedPath(resolvedRoot, directory.path);
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target);
        if (directory.state === 'planned'
          || stat.isSymbolicLink() || !stat.isDirectory()
          || modeString(stat) !== SAFE_PUBLIC_DIRECTORY_MODE
          || fs.readdirSync(target).length) {
          fail('REPOSITORY_CUTOVER_ROLLBACK_DIRECTORY_DRIFT', 'Checkpoint-created directory is not empty during rollback.');
        }
        assertRootIdentity(resolvedRoot, checkpoint.rootIdentityFingerprint);
        fs.rmdirSync(target);
        fsyncDirectory(path.dirname(target));
      }
      directory.state = 'removed';
      persistCheckpoint(resolvedRoot, checkpoint);
    }
    assertRootIdentity(resolvedRoot, checkpoint.rootIdentityFingerprint);
    if (publicTreeManifest(resolvedRoot).fingerprint !== checkpoint.plan.basisTreeFingerprint) {
      fail('REPOSITORY_CUTOVER_ROLLBACK_VERIFY_FAILED', 'Repository rollback did not restore the exact basis tree.');
    }
    checkpoint.state = 'rolled-back';
    checkpoint.phase = 'terminal';
    checkpoint.currentOperationId = null;
    checkpoint.updatedAt = at;
    checkpoint.failure = null;
    checkpoint.result = {
      state: 'rolled-back',
      repositoryCandidateMaterialized: false,
      evidenceAndFixturesMaterialized: false
    };
    persistCheckpoint(resolvedRoot, checkpoint);
  } catch (error) {
    markNeedsAttention(
      resolvedRoot,
      checkpoint,
      normalizeFailureCode(error, 'REPOSITORY_CUTOVER_ROLLBACK_FAILED')
    );
  }
  return inspectRepositoryCutover({ root: resolvedRoot, checkpointId });
}

function maybeFault(faultAfter, point) {
  if (faultAfter !== point) return;
  const error = new Error('Planted repository cutover self-test fault at ' + point);
  error.code = point.startsWith('crash-')
    ? 'REPOSITORY_CUTOVER_TEST_CRASH'
    : 'REPOSITORY_CUTOVER_TEST_FAILURE';
  throw error;
}

function finishCompleted(root, checkpoint, at) {
  assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
  assertUnmanagedTree(root, checkpoint);
  const states = operationStates(root, checkpoint);
  if (states.some((row) => row.state !== 'after')) {
    fail('REPOSITORY_CUTOVER_FINAL_VERIFY_FAILED', 'Repository cutover final tree does not match every exact candidate effect.');
  }
  if (publicTreeManifest(root).fingerprint !== checkpoint.plan.candidateTreeFingerprint) {
    fail('REPOSITORY_CUTOVER_FINAL_VERIFY_FAILED', 'Repository cutover complete public tree fingerprint is not the exact staged candidate.');
  }
  if (checkpoint.createdDirectories.some((directory) => directory.state !== 'created')) {
    fail('REPOSITORY_CUTOVER_FINAL_VERIFY_FAILED', 'Repository cutover has an incomplete checkpoint-owned directory create step.');
  }
  for (const [index, row] of states.entries()) {
    checkpoint.progress[index].state = 'verified';
    checkpoint.progress[index].observedFingerprint = row.observed.fingerprint;
  }
  checkpoint.state = 'completed';
  checkpoint.phase = 'terminal';
  checkpoint.currentOperationId = null;
  checkpoint.failure = null;
  checkpoint.result = {
    state: 'completed',
    repositoryCandidateMaterialized: true,
    evidenceAndFixturesMaterialized: false,
    pendingEvidenceFinalization: true,
    fixtureFinalizationRequestFingerprint: checkpoint.plan.fixtureRequestFingerprint,
    candidateTreeFingerprint: checkpoint.plan.candidateTreeFingerprint,
    claimBoundary: 'exact-local-repository-cutover-only'
  };
  checkpoint.updatedAt = at;
  persistCheckpoint(root, checkpoint);
  return checkpoint;
}

function assertForwardRecoveryBasis(root, checkpoint) {
  for (const operation of checkpoint.operations) {
    const progress = progressForOperation(checkpoint, operation);
    reconcileOperationTemporary(root, operation, checkpoint);
    reconcileOperationTemporary(root, operation, checkpoint, true);
    const observed = snapshotFile(root, operation.path);
    if (progress.state === 'pending' && !snapshotEquals(observed, operation.before)) {
      fail('REPOSITORY_CUTOVER_RECOVERY_STATE_UNKNOWN', 'An unbegun repository effect changed before its durable ownership marker.');
    }
    if (progress.state === 'applying'
      && !snapshotEquals(observed, operation.before)
      && !snapshotEquals(observed, operation.after)) {
      fail('REPOSITORY_CUTOVER_RECOVERY_STATE_UNKNOWN', 'A begun repository effect is outside its exact prior or candidate state.');
    }
    if (progress.state === 'applied' && !snapshotEquals(observed, operation.after)) {
      fail('REPOSITORY_CUTOVER_RECOVERY_STATE_UNKNOWN', 'An applied repository effect no longer matches its exact candidate state.');
    }
    if (!['pending', 'applying', 'applied'].includes(progress.state)) {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover forward execution encountered an impossible effect state.');
    }
  }
}

function executeCheckpoint(root, checkpoint, at, faultAfter) {
  assertRootIdentity(root, checkpoint.rootIdentityFingerprint);
  assertForwardRecoveryBasis(root, checkpoint);
  assertUnmanagedTree(root, checkpoint);
  const nextIndex = checkpoint.progress.findIndex((row) => row.state !== 'applied');
  checkpoint.state = 'applying';
  checkpoint.updatedAt = at;
  if (nextIndex < 0) {
    checkpoint.phase = 'verifying';
    checkpoint.currentOperationId = null;
    persistCheckpoint(root, checkpoint);
  } else {
    checkpoint.phase = 'effects';
    checkpoint.currentOperationId = checkpoint.operations[nextIndex].id;
    persistCheckpoint(root, checkpoint);
  }
  for (let index = Math.max(0, nextIndex); nextIndex >= 0 && index < checkpoint.operations.length; index += 1) {
    const operation = checkpoint.operations[index];
    const progress = checkpoint.progress[index];
    reconcileOperationTemporary(root, operation, checkpoint);
    reconcileOperationTemporary(root, operation, checkpoint, true);
    let observed = snapshotFile(root, operation.path);
    if (progress.state === 'applied') {
      if (!snapshotEquals(observed, operation.after)) {
        fail('REPOSITORY_CUTOVER_RECOVERY_STATE_UNKNOWN', 'An applied repository effect no longer matches its exact candidate state.');
      }
    } else if (progress.state === 'applying') {
      if (!snapshotEquals(observed, operation.before)
        && !snapshotEquals(observed, operation.after)) {
        fail('REPOSITORY_CUTOVER_RECOVERY_STATE_UNKNOWN', 'A begun repository effect is outside its exact prior or candidate state.');
      }
      if (snapshotEquals(observed, operation.after)) {
        progress.state = 'applied';
        progress.observedFingerprint = observed.fingerprint;
        persistCheckpoint(root, checkpoint);
      }
    } else if (progress.state === 'pending') {
      if (!snapshotEquals(observed, operation.before)) {
        fail('REPOSITORY_CUTOVER_RECOVERY_STATE_UNKNOWN', 'An unbegun repository effect changed before its durable ownership marker.');
      }
      progress.state = 'applying';
      progress.observedFingerprint = observed.fingerprint;
      checkpoint.currentOperationId = operation.id;
      persistCheckpoint(root, checkpoint);
      maybeFault(faultAfter, 'crash-after-begun-before-effect:' + operation.id);
    } else {
      fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover forward execution encountered an impossible effect state.');
    }
    if (progress.state === 'applying') {
      assertUnmanagedTree(root, checkpoint);
      checkpoint.currentOperationId = operation.id;
      persistCheckpoint(root, checkpoint);
      maybeFault(faultAfter, 'crash-before-effect:' + operation.id);
      const after = applyOperation(root, operation, checkpoint, faultAfter);
      maybeFault(faultAfter, 'crash-after-effect-before-progress:' + operation.id);
      maybeFault(faultAfter, 'fail-after-effect:' + operation.id);
      progress.state = 'applied';
      progress.observedFingerprint = after.fingerprint;
      persistCheckpoint(root, checkpoint);
    }
    const following = index + 1;
    if (following < checkpoint.operations.length) {
      checkpoint.currentOperationId = checkpoint.operations[following].id;
      persistCheckpoint(root, checkpoint);
    } else {
      checkpoint.phase = 'verifying';
      checkpoint.currentOperationId = null;
      persistCheckpoint(root, checkpoint);
    }
    maybeFault(faultAfter, 'crash-after-effect:' + operation.id);
  }
  maybeFault(faultAfter, 'crash-before-terminal');
  return finishCompleted(root, checkpoint, at);
}

export function executeRepositoryCutover({ root, checkpointId, at, faultAfter = null, ...unknown } = {}) {
  if (Object.keys(unknown).length || !exactInstant(at)) {
    fail('REPOSITORY_CUTOVER_ARGUMENTS_INVALID', 'Repository cutover execution requires one exact checkpoint and time.');
  }
  const resolvedRoot = resolvedRealRoot(root);
  const checkpoint = readCheckpoint(resolvedRoot, checkpointId);
  assertMonotonicTime(checkpoint, at);
  if (['completed', 'rolled-back', 'needs-attention'].includes(checkpoint.state)) {
    return inspectRepositoryCutover({ root: resolvedRoot, checkpointId });
  }
  if (checkpoint.state === 'rolling-back') {
    return rollbackRepositoryCutover({ root: resolvedRoot, checkpointId, at });
  }
  try {
    executeCheckpoint(resolvedRoot, checkpoint, at, faultAfter);
  } catch (error) {
    if (error?.code === 'REPOSITORY_CUTOVER_TEST_CRASH') throw error;
    const rollbackIndex = (() => {
      for (let index = checkpoint.operations.length - 1; index >= 0; index -= 1) {
        if (checkpoint.progress[index].state !== 'rolled-back') return index;
      }
      return checkpoint.operations.length - 1;
    })();
    checkpoint.state = 'rolling-back';
    checkpoint.phase = 'rollback';
    checkpoint.currentOperationId = checkpoint.operations[rollbackIndex].id;
    checkpoint.updatedAt = at;
    checkpoint.failure = {
      reasonCode: normalizeFailureCode(error, 'REPOSITORY_CUTOVER_EXECUTION_FAILED'),
      summary: 'Repository cutover stopped and attempted exact rollback.'
    };
    persistCheckpoint(resolvedRoot, checkpoint);
    return rollbackRepositoryCutover({ root: resolvedRoot, checkpointId, at });
  }
  return inspectRepositoryCutover({ root: resolvedRoot, checkpointId });
}

export function recoverRepositoryCutover({ root, checkpointId, at, faultAfter = null, ...unknown } = {}) {
  if (Object.keys(unknown).length || !exactInstant(at)) {
    fail('REPOSITORY_CUTOVER_ARGUMENTS_INVALID', 'Repository cutover recovery requires one exact checkpoint and time.');
  }
  const resolvedRoot = resolvedRealRoot(root);
  const checkpoint = readCheckpoint(resolvedRoot, checkpointId);
  assertMonotonicTime(checkpoint, at);
  if (['completed', 'rolled-back', 'needs-attention'].includes(checkpoint.state)) {
    return inspectRepositoryCutover({ root: resolvedRoot, checkpointId });
  }
  if (checkpoint.state === 'rolling-back') {
    return rollbackRepositoryCutover({ root: resolvedRoot, checkpointId, at });
  }
  try {
    executeCheckpoint(resolvedRoot, checkpoint, at, faultAfter);
  } catch (error) {
    if (error?.code === 'REPOSITORY_CUTOVER_TEST_CRASH') throw error;
    markNeedsAttention(
      resolvedRoot,
      checkpoint,
      normalizeFailureCode(error, 'REPOSITORY_CUTOVER_RECOVERY_FAILED')
    );
  }
  return inspectRepositoryCutover({ root: resolvedRoot, checkpointId });
}

export function inspectRepositoryCutover({ root, checkpointId, ...unknown } = {}) {
  if (Object.keys(unknown).length) {
    fail('REPOSITORY_CUTOVER_ARGUMENTS_INVALID', 'Repository cutover inspection received an unknown argument.');
  }
  const checkpoint = readCheckpoint(resolvedRealRoot(root), checkpointId);
  const completed = checkpoint.progress.filter((row) => ['applied', 'verified'].includes(row.state)).length;
  const rolledBack = checkpoint.progress.filter((row) => row.state === 'rolled-back').length;
  const pending = checkpoint.progress.filter((row) => [
    'pending', 'applying', 'rolling-back'
  ].includes(row.state)).length;
  if (checkpoint.progress.length !== checkpoint.plan.operationCount
    || completed + rolledBack + pending !== checkpoint.plan.operationCount) {
    fail('REPOSITORY_CUTOVER_CHECKPOINT_INVALID', 'Repository cutover progress is not an exact partition of the planned effects.');
  }
  const inspection = {
    $contract: INSPECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: checkpoint.id,
    checkpointFingerprint: checkpoint.checkpointFingerprint,
    request: {
      id: checkpoint.request.id,
      fingerprint: checkpoint.request.fingerprint,
      createdAt: checkpoint.request.createdAt
    },
    state: checkpoint.state,
    phase: checkpoint.phase,
    plan: {
      fingerprint: checkpoint.plan.planFingerprint,
      basisTreeFingerprint: checkpoint.plan.basisTreeFingerprint,
      candidateTreeFingerprint: checkpoint.plan.candidateTreeFingerprint,
      operationCount: checkpoint.plan.operationCount,
      fixtureWriteCount: checkpoint.plan.fixtureWriteCount,
      fixtureRemovalCount: checkpoint.plan.fixtureRemovalCount,
      fixtureState: checkpoint.plan.fixtureState,
      fixtureRequestFingerprint: checkpoint.plan.fixtureRequestFingerprint,
      pendingEvidenceViolationCount: checkpoint.plan.pendingEvidenceViolationCount,
      sourceDeletionCount: checkpoint.plan.sourceDeletionCount,
      operationalDeletionCount: checkpoint.plan.operationalDeletionCount
    },
    progress: {
      completed,
      rolledBack,
      pending,
      currentSequence: checkpoint.currentOperationId === null ? null
        : checkpoint.operations.find((operation) => operation.id === checkpoint.currentOperationId)?.sequence ?? null
    },
    failure: checkpoint.failure ? { ...checkpoint.failure } : null,
    result: checkpoint.result ? structuredClone(checkpoint.result) : null,
    authority: {
      reusableRequest: false,
      providerEffects: false,
      networkEffects: false,
      hostEffects: false,
      configurationMutation: false,
      repositoryMutation: checkpoint.state === 'prepared' ? 'checkpoint-bound' : 'not-granted-by-inspection',
      requestExpiry: 'not-used-exact-root-and-create-only-checkpoint',
      separateConfirmation: 'not-required-user-authorized-internal-migration'
    },
    privacy: {
      rootPathIncluded: false,
      requestPathsIncluded: false,
      filePathsIncluded: false,
      fileBytesIncluded: false,
      privateStateIncluded: false,
      providerDataIncluded: false
    },
    claimBoundary: INSPECTION_CLAIM_BOUNDARY,
    inspectionFingerprint: null
  };
  const unsigned = structuredClone(inspection);
  delete unsigned.inspectionFingerprint;
  inspection.inspectionFingerprint = fingerprintJson(unsigned);
  const failures = validateJsonSchema(
    inspection,
    readJson(confinedPath(root, INSPECTION_SCHEMA, { allowMissing: false }))
  );
  if (failures.length) {
    fail(
      'REPOSITORY_CUTOVER_INSPECTION_INVALID',
      'Sanitized repository cutover inspection violates its closed contract: '
        + failures.slice(0, 3).map((row) => `${row.path} ${row.message}`).join('; ')
    );
  }
  return inspection;
}

function writeCanonicalPrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, canonicalBytes(value), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function syntheticCheckpoint(root, operations, idSeed = 'synthetic') {
  const identity = repositoryCutoverRootIdentity(root);
  const plannedPaths = new Set(operations.map((operation) => operation.path));
  const request = {
    $contract: REQUEST_CONTRACT,
    contractVersion: '1.0.0',
    id: 'repository-cutover.' + idSeed,
    createdAt: '2026-07-22T12:00:00.000Z',
    rootIdentityFingerprint: identity.fingerprint,
    lifecycleRequest: {
      path: '/private/synthetic-lifecycle.json',
      fingerprint: sha256('synthetic-lifecycle-request')
    },
    transitionRequest: {
      path: '/private/synthetic-transition.json',
      fingerprint: sha256('synthetic-transition-request')
    },
    fixtureFinalizationRequest: {
      path: '/private/synthetic-fixture.json',
      fingerprint: sha256('synthetic-fixture-request')
    },
    requestFingerprint: null
  };
  request.requestFingerprint = requestFingerprint(request);
  const afterRoot = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), 'soter-repository-cutover-after-')
  ));
  fs.chmodSync(afterRoot, 0o700);
  try {
    const copy = (source, destination) => {
      fs.cpSync(source, destination, {
        recursive: true,
        filter: (sourcePath) => path.basename(sourcePath) !== '.soter'
      });
    };
    copy(root + path.sep, afterRoot);
    for (const operation of operations) {
      const target = path.join(afterRoot, operation.path);
      if (operation.after.state === 'absent') fs.unlinkSync(target);
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(operation.after.bytesBase64, 'base64'));
        fs.chmodSync(target, Number.parseInt(operation.after.mode, 8));
      }
    }
    const candidate = {
      lifecycle: { plan: { planFingerprint: sha256('lifecycle') } },
      legacy: {
        planFingerprint: sha256('legacy'),
        summary: {
          sourceDeletionCount: EXPECTED_SOURCE_DELETIONS,
          operationalDeletionCount: EXPECTED_OPERATIONAL_DELETIONS.length
        }
      },
      fixture: {
        writeCount: 0,
        removalCount: 0,
        state: 'pending-evidence-finalization',
        requestFingerprint: sha256('synthetic-fixture-request'),
        pendingEvidenceViolationCount: 1
      },
      operations,
      basisTreeFingerprint: publicTreeManifest(root).fingerprint,
      candidateTreeFingerprint: publicTreeManifest(afterRoot).fingerprint,
      unmanagedTreeFingerprint: publicTreeManifest(root, plannedPaths).fingerprint
    };
    const checkpoint = checkpointFromCandidate(
      root,
      { request, requestFileFingerprint: sha256('synthetic-request') },
      candidate,
      request.createdAt
    );
    persistCheckpoint(root, checkpoint, { create: true });
    return checkpoint;
  } finally {
    fs.rmSync(afterRoot, { recursive: true, force: true });
  }
}

function syntheticOperation(root, relative, desired, sequence, phase = 'legacy') {
  const before = snapshotFile(root, relative);
  const after = desired === null ? absentSnapshot() : (() => {
    const bytes = Buffer.from(desired, 'utf8');
    const snapshot = {
      state: 'present',
      mode: '0644',
      contentFingerprint: sha256(bytes),
      bytesBase64: bytes.toString('base64'),
      fingerprint: null
    };
    snapshot.fingerprint = snapshotFingerprint(snapshot);
    return snapshot;
  })();
  return {
    id: `repository-cutover-effect.${String(sequence).padStart(4, '0')}`,
    sequence,
    phase,
    path: relative,
    action: after.state === 'absent' ? 'remove' : before.state === 'absent' ? 'create' : 'replace',
    before,
    after
  };
}

/** Transaction-only adversarial harness. It never invokes the real cutover planner. */
export function selftestRepositoryCutoverTransaction() {
  const makeRoot = (name) => {
    const root = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), `soter-repository-cutover-${name}-`)
    ));
    fs.chmodSync(root, 0o700);
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'legacy'), { recursive: true });
    fs.mkdirSync(path.join(root, 'soter/contracts'), { recursive: true });
    fs.copyFileSync(
      path.join(defaultRoot, INSPECTION_SCHEMA),
      path.join(root, INSPECTION_SCHEMA)
    );
    fs.writeFileSync(path.join(root, 'docs/current.json'), '{"state":"before"}\n');
    fs.writeFileSync(path.join(root, 'legacy/remove.md'), 'legacy\n');
    fs.chmodSync(path.join(root, 'docs/current.json'), 0o644);
    fs.chmodSync(path.join(root, 'legacy/remove.md'), 0o644);
    return root;
  };
  const roots = [];
  const schemaRejects = (inspection, message) => {
    const failures = validateJsonSchema(
      inspection,
      readJson(path.join(defaultRoot, INSPECTION_SCHEMA))
    );
    if (!failures.length) throw new Error(message);
  };
  const exactFileState = (file) => {
    const stat = fs.lstatSync(file);
    return {
      device: Number(stat.dev),
      inode: Number(stat.ino),
      mode: stat.mode & 0o7777,
      linkCount: stat.nlink,
      contentFingerprint: fingerprintFile(file)
    };
  };
  try {
    const crashRoot = makeRoot('crash');
    roots.push(crashRoot);
    const crashOperations = [
      syntheticOperation(crashRoot, 'docs/current.json', '{"state":"after"}\n', 0),
      syntheticOperation(crashRoot, 'generated/new.json', '{"state":"new"}\n', 1, 'fixture'),
      syntheticOperation(crashRoot, 'legacy/remove.md', null, 2, 'legacy-source')
    ];
    const crashCheckpoint = syntheticCheckpoint(crashRoot, crashOperations, 'crash');
    let checkpointReuseRejected = false;
    try {
      persistCheckpoint(crashRoot, structuredClone(crashCheckpoint), { create: true });
    } catch (error) {
      checkpointReuseRejected = error?.code === 'EEXIST';
    }
    if (!checkpointReuseRejected) {
      throw new Error('Repository cutover create-only checkpoint accepted request reuse.');
    }
    const checkpointStat = fs.lstatSync(checkpointFile(crashRoot, crashCheckpoint.id));
    const checkpointDirectoryStat = fs.lstatSync(path.dirname(checkpointFile(crashRoot, crashCheckpoint.id)));
    if (process.platform !== 'win32'
      && ((checkpointStat.mode & 0o7777) !== 0o600
        || (checkpointDirectoryStat.mode & 0o7777) !== 0o700)) {
      throw new Error('Repository cutover private checkpoint modes are not exact.');
    }
    let crashed = false;
    try {
      executeRepositoryCutover({
        root: crashRoot,
        checkpointId: crashCheckpoint.id,
        at: '2026-07-22T12:01:00.000Z',
        faultAfter: 'crash-after-effect:repository-cutover-effect.0000'
      });
    } catch (error) {
      crashed = error?.code === 'REPOSITORY_CUTOVER_TEST_CRASH';
    }
    if (!crashed) throw new Error('Repository cutover partial-crash fault was not observed.');
    const recovered = recoverRepositoryCutover({
      root: crashRoot,
      checkpointId: crashCheckpoint.id,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (recovered.state !== 'completed'
      || fs.readFileSync(path.join(crashRoot, 'docs/current.json'), 'utf8') !== '{"state":"after"}\n'
      || !fs.existsSync(path.join(crashRoot, 'generated/new.json'))
      || fs.existsSync(path.join(crashRoot, 'legacy/remove.md'))) {
      throw new Error('Repository cutover did not recover the exact partial candidate: '
        + JSON.stringify(recovered));
    }
    const serializedInspection = JSON.stringify(recovered);
    if (serializedInspection.includes(crashRoot)
      || serializedInspection.includes('docs/current.json')
      || serializedInspection.includes('eyJzdGF0ZSI')) {
      throw new Error('Repository cutover sanitized inspection exposed paths or bytes.');
    }
    const hostileLifecycle = structuredClone(recovered);
    hostileLifecycle.phase = 'prepared';
    hostileLifecycle.inspectionFingerprint = sha256('hostile-lifecycle');
    schemaRejects(
      hostileLifecycle,
      'Repository cutover inspection schema accepted an impossible completed/prepared lifecycle combination.'
    );
    const hostileDate = structuredClone(recovered);
    hostileDate.request.createdAt = 'not-a-canonical-time';
    schemaRejects(hostileDate, 'Repository cutover inspection schema accepted a malformed request time.');
    const hostileProgress = structuredClone(recovered);
    hostileProgress.progress.pending = 1;
    hostileProgress.progress.completed -= 1;
    schemaRejects(hostileProgress, 'Repository cutover inspection schema accepted impossible completed progress.');
    const hostileAuthority = structuredClone(recovered);
    hostileAuthority.authority.repositoryMutation = 'checkpoint-bound';
    schemaRejects(hostileAuthority, 'Repository cutover inspection schema granted checkpoint authority after completion.');
    const hostileClaim = structuredClone(recovered);
    hostileClaim.claimBoundary = 'Broad repository readiness proven.';
    schemaRejects(hostileClaim, 'Repository cutover inspection schema accepted a broadened claim boundary.');
    const hostileFailureSummary = structuredClone(recovered);
    hostileFailureSummary.state = 'needs-attention';
    hostileFailureSummary.phase = 'terminal';
    hostileFailureSummary.failure = {
      reasonCode: 'REPOSITORY_CUTOVER_RECOVERY_FAILED',
      summary: 'Inspect /private/user/secrets.json with credential '
        + 'sk-' + 'hostile-private-sentinel.'
    };
    hostileFailureSummary.result = null;
    schemaRejects(
      hostileFailureSummary,
      'Repository cutover inspection schema accepted private path or credential prose in failure summary.'
    );

    for (const boundary of ['before', 'after']) {
      const directoryRoot = makeRoot('directory-' + boundary);
      roots.push(directoryRoot);
      const directoryOperations = [syntheticOperation(
        directoryRoot,
        'generated/nested/new.json',
        '{"state":"new"}\n',
        0,
        'fixture'
      )];
      const directoryCheckpoint = syntheticCheckpoint(
        directoryRoot,
        directoryOperations,
        'directory-' + boundary
      );
      let directoryCrash = false;
      try {
        executeRepositoryCutover({
          root: directoryRoot,
          checkpointId: directoryCheckpoint.id,
          at: '2026-07-22T12:01:00.000Z',
          faultAfter: `crash-${boundary}-directory:generated`
        });
      } catch (error) {
        directoryCrash = error?.code === 'REPOSITORY_CUTOVER_TEST_CRASH';
      }
      if (!directoryCrash) {
        throw new Error('Repository cutover did not plant the ' + boundary + '-mkdir crash boundary.');
      }
      const directoryRecovered = recoverRepositoryCutover({
        root: directoryRoot,
        checkpointId: directoryCheckpoint.id,
        at: '2026-07-22T12:02:00.000Z'
      });
      if (directoryRecovered.state !== 'completed'
        || !fs.existsSync(path.join(directoryRoot, 'generated/nested/new.json'))
        || readCheckpoint(directoryRoot, directoryCheckpoint.id).createdDirectories
          .some((row) => row.state !== 'created')) {
        throw new Error('Repository cutover did not recover one exact ' + boundary + '-mkdir crash.');
      }
    }

    const directoryRollbackRoot = makeRoot('directory-rollback');
    roots.push(directoryRollbackRoot);
    const directoryRollbackBasis = publicTreeManifest(directoryRollbackRoot).fingerprint;
    const directoryRollbackOperations = [syntheticOperation(
      directoryRollbackRoot,
      'generated/new.json',
      '{"state":"new"}\n',
      0,
      'fixture'
    )];
    const directoryRollbackCheckpoint = syntheticCheckpoint(
      directoryRollbackRoot,
      directoryRollbackOperations,
      'directory-rollback'
    );
    const directoryRolledBack = executeRepositoryCutover({
      root: directoryRollbackRoot,
      checkpointId: directoryRollbackCheckpoint.id,
      at: '2026-07-22T12:01:00.000Z',
      faultAfter: 'fail-after-effect:repository-cutover-effect.0000'
    });
    if (directoryRolledBack.state !== 'rolled-back'
      || fs.existsSync(path.join(directoryRollbackRoot, 'generated'))
      || publicTreeManifest(directoryRollbackRoot).fingerprint !== directoryRollbackBasis) {
      throw new Error('Repository cutover rollback did not restore the exact pre-directory basis tree.');
    }

    const rollbackRoot = makeRoot('rollback');
    roots.push(rollbackRoot);
    const rollbackOperations = [
      syntheticOperation(rollbackRoot, 'docs/current.json', '{"state":"after"}\n', 0),
      syntheticOperation(rollbackRoot, 'legacy/remove.md', null, 1, 'legacy-source')
    ];
    const rollbackCheckpoint = syntheticCheckpoint(rollbackRoot, rollbackOperations, 'rollback');
    const rolledBack = executeRepositoryCutover({
      root: rollbackRoot,
      checkpointId: rollbackCheckpoint.id,
      at: '2026-07-22T12:01:00.000Z',
      faultAfter: 'fail-after-effect:repository-cutover-effect.0000'
    });
    if (rolledBack.state !== 'rolled-back'
      || fs.readFileSync(path.join(rollbackRoot, 'docs/current.json'), 'utf8') !== '{"state":"before"}\n'
      || !fs.existsSync(path.join(rollbackRoot, 'legacy/remove.md'))) {
      throw new Error('Repository cutover did not roll back exact prior bytes after a failed effect.');
    }

    const driftRoot = makeRoot('drift');
    roots.push(driftRoot);
    const driftOperations = [
      syntheticOperation(driftRoot, 'docs/current.json', '{"state":"after"}\n', 0),
      syntheticOperation(driftRoot, 'legacy/remove.md', null, 1, 'legacy-source')
    ];
    const driftCheckpoint = syntheticCheckpoint(driftRoot, driftOperations, 'drift');
    fs.writeFileSync(path.join(driftRoot, 'legacy/remove.md'), 'mutated deletion target\n');
    const drifted = executeRepositoryCutover({
      root: driftRoot,
      checkpointId: driftCheckpoint.id,
      at: '2026-07-22T12:01:00.000Z'
    });
    if (drifted.state !== 'needs-attention'
      || fs.readFileSync(path.join(driftRoot, 'docs/current.json'), 'utf8') !== '{"state":"before"}\n') {
      throw new Error('Repository cutover adopted drifted deletion bytes or mutated before full preflight.');
    }

    const symlinkRoot = makeRoot('symlink');
    roots.push(symlinkRoot);
    const external = path.join(os.tmpdir(), 'soter-repository-cutover-external-' + process.pid + '.txt');
    fs.writeFileSync(external, 'external\n', { mode: 0o600 });
    roots.push(external);
    fs.unlinkSync(path.join(symlinkRoot, 'legacy/remove.md'));
    fs.symlinkSync(external, path.join(symlinkRoot, 'legacy/remove.md'));
    let symlinkRejected = false;
    try {
      syntheticOperation(symlinkRoot, 'legacy/remove.md', null, 0);
    } catch (error) {
      symlinkRejected = error?.code === 'REPOSITORY_CUTOVER_SYMLINK_REJECTED';
    }
    if (!symlinkRejected || fs.readFileSync(external, 'utf8') !== 'external\n') {
      throw new Error('Repository cutover did not reject a symlink without external mutation.');
    }

    const hardlinkRoot = makeRoot('hardlink');
    roots.push(hardlinkRoot);
    const hardlinkExternal = path.join(os.tmpdir(), 'soter-repository-cutover-hardlink-' + process.pid + '.txt');
    fs.writeFileSync(hardlinkExternal, 'hardlink\n', { mode: 0o600 });
    roots.push(hardlinkExternal);
    fs.unlinkSync(path.join(hardlinkRoot, 'legacy/remove.md'));
    fs.linkSync(hardlinkExternal, path.join(hardlinkRoot, 'legacy/remove.md'));
    let hardlinkRejected = false;
    try {
      syntheticOperation(hardlinkRoot, 'legacy/remove.md', null, 0);
    } catch (error) {
      hardlinkRejected = error?.code === 'REPOSITORY_CUTOVER_FILE_INVALID';
    }
    if (!hardlinkRejected || (fs.lstatSync(hardlinkExternal).mode & 0o7777) !== 0o600) {
      throw new Error('Repository cutover did not reject a hardlink without mode mutation.');
    }

    const modeRoot = makeRoot('mode');
    roots.push(modeRoot);
    fs.chmodSync(path.join(modeRoot, 'legacy/remove.md'), 0o1644);
    let modeRejected = false;
    try {
      syntheticOperation(modeRoot, 'legacy/remove.md', null, 0);
    } catch (error) {
      modeRejected = ['REPOSITORY_CUTOVER_FILE_INVALID', 'REPOSITORY_CUTOVER_FILE_MODE_INVALID']
        .includes(error?.code);
    }
    if (!modeRejected) throw new Error('Repository cutover accepted special mode bits.');

    if (normalizeFailureCode({ code: 'EACCES' }, 'REPOSITORY_CUTOVER_EXECUTION_FAILED')
      !== 'REPOSITORY_CUTOVER_EXECUTION_FAILED'
      || normalizeFailureCode(
        { code: 'REPOSITORY_CUTOVER_EFFECT_DRIFT' },
        'REPOSITORY_CUTOVER_EXECUTION_FAILED'
      ) !== 'REPOSITORY_CUTOVER_EFFECT_DRIFT') {
      throw new Error('Repository cutover failure-code normalization is not closed to its stable namespace.');
    }

    const timeRoot = makeRoot('monotonic-time');
    roots.push(timeRoot);
    const timeCheckpoint = syntheticCheckpoint(timeRoot, [syntheticOperation(
      timeRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )], 'monotonic-time');
    let retrogradeTimeRejected = false;
    try {
      executeRepositoryCutover({
        root: timeRoot,
        checkpointId: timeCheckpoint.id,
        at: '2026-07-22T11:59:59.999Z'
      });
    } catch (error) {
      retrogradeTimeRejected = error?.code === 'REPOSITORY_CUTOVER_TIME_INVALID';
    }
    if (!retrogradeTimeRejected
      || fs.readFileSync(path.join(timeRoot, 'docs/current.json'), 'utf8') !== '{"state":"before"}\n') {
      throw new Error('Repository cutover accepted a retrograde execution time or mutated before rejecting it.');
    }
    for (const hostileCheckpoint of [
      (() => {
        const value = structuredClone(timeCheckpoint);
        value.progress[0].observedFingerprint = value.operations[0].after.fingerprint;
        return value;
      })(),
      (() => {
        const value = structuredClone(timeCheckpoint);
        value.currentOperationId = 'repository-cutover-effect.9999';
        return value;
      })(),
      (() => {
        const value = structuredClone(timeCheckpoint);
        value.state = 'completed';
        value.phase = 'terminal';
        value.progress[0].state = 'verified';
        value.progress[0].observedFingerprint = value.operations[0].after.fingerprint;
        value.result = {
          state: 'completed',
          repositoryCandidateMaterialized: true,
          evidenceAndFixturesMaterialized: false,
          pendingEvidenceFinalization: true,
          fixtureFinalizationRequestFingerprint: value.plan.fixtureRequestFingerprint,
          candidateTreeFingerprint: value.plan.candidateTreeFingerprint,
          claimBoundary: 'not-the-closed-claim'
        };
        return value;
      })()
    ]) {
      let hostileCheckpointRejected = false;
      try {
        persistCheckpoint(timeRoot, hostileCheckpoint);
      } catch (error) {
        hostileCheckpointRejected = error?.code === 'REPOSITORY_CUTOVER_CHECKPOINT_INVALID';
      }
      if (!hostileCheckpointRejected) {
        throw new Error('Repository cutover accepted contradictory private checkpoint semantics.');
      }
    }

    const externalAfterRoot = makeRoot('external-after-before-begun');
    roots.push(externalAfterRoot);
    const externalAfterOperations = [syntheticOperation(
      externalAfterRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )];
    const externalAfterCheckpoint = syntheticCheckpoint(
      externalAfterRoot,
      externalAfterOperations,
      'external-after-before-begun'
    );
    fs.writeFileSync(
      path.join(externalAfterRoot, 'docs/current.json'),
      Buffer.from(externalAfterOperations[0].after.bytesBase64, 'base64')
    );
    fs.chmodSync(path.join(externalAfterRoot, 'docs/current.json'), 0o644);
    const externalAfterResult = executeRepositoryCutover({
      root: externalAfterRoot,
      checkpointId: externalAfterCheckpoint.id,
      at: '2026-07-22T12:01:00.000Z'
    });
    if (externalAfterResult.state !== 'needs-attention'
      || fs.readFileSync(path.join(externalAfterRoot, 'docs/current.json'), 'utf8')
        !== '{"state":"after"}\n'
      || readCheckpoint(externalAfterRoot, externalAfterCheckpoint.id).progress[0].state
        !== 'pending') {
      throw new Error('Repository cutover adopted or rolled back exact candidate bytes written before a durable begun marker.');
    }

    const begunCrashRoot = makeRoot('begun-before-effect');
    roots.push(begunCrashRoot);
    const begunCrashOperations = [syntheticOperation(
      begunCrashRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )];
    const begunCrashCheckpoint = syntheticCheckpoint(
      begunCrashRoot,
      begunCrashOperations,
      'begun-before-effect'
    );
    let begunCrashObserved = false;
    try {
      executeRepositoryCutover({
        root: begunCrashRoot,
        checkpointId: begunCrashCheckpoint.id,
        at: '2026-07-22T12:01:00.000Z',
        faultAfter: 'crash-after-begun-before-effect:repository-cutover-effect.0000'
      });
    } catch (error) {
      begunCrashObserved = error?.code === 'REPOSITORY_CUTOVER_TEST_CRASH';
    }
    if (!begunCrashObserved
      || readCheckpoint(begunCrashRoot, begunCrashCheckpoint.id).progress[0].state !== 'applying'
      || fs.readFileSync(path.join(begunCrashRoot, 'docs/current.json'), 'utf8')
        !== '{"state":"before"}\n') {
      throw new Error('Repository cutover did not persist begun ownership before its first effect.');
    }
    const begunCrashRecovered = recoverRepositoryCutover({
      root: begunCrashRoot,
      checkpointId: begunCrashCheckpoint.id,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (begunCrashRecovered.state !== 'completed') {
      throw new Error('Repository cutover did not recover a begun effect that had not yet mutated its target.');
    }

    const effectBeforeProgressRoot = makeRoot('effect-before-progress');
    roots.push(effectBeforeProgressRoot);
    const effectBeforeProgressOperations = [syntheticOperation(
      effectBeforeProgressRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )];
    const effectBeforeProgressCheckpoint = syntheticCheckpoint(
      effectBeforeProgressRoot,
      effectBeforeProgressOperations,
      'effect-before-progress'
    );
    let effectBeforeProgressCrash = false;
    try {
      executeRepositoryCutover({
        root: effectBeforeProgressRoot,
        checkpointId: effectBeforeProgressCheckpoint.id,
        at: '2026-07-22T12:01:00.000Z',
        faultAfter: 'crash-after-effect-before-progress:repository-cutover-effect.0000'
      });
    } catch (error) {
      effectBeforeProgressCrash = error?.code === 'REPOSITORY_CUTOVER_TEST_CRASH';
    }
    if (!effectBeforeProgressCrash
      || readCheckpoint(effectBeforeProgressRoot, effectBeforeProgressCheckpoint.id)
        .progress[0].state !== 'applying'
      || fs.readFileSync(path.join(effectBeforeProgressRoot, 'docs/current.json'), 'utf8')
        !== '{"state":"after"}\n') {
      throw new Error('Repository cutover did not preserve the owned crash-after-effect boundary.');
    }
    const effectBeforeProgressRecovered = recoverRepositoryCutover({
      root: effectBeforeProgressRoot,
      checkpointId: effectBeforeProgressCheckpoint.id,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (effectBeforeProgressRecovered.state !== 'completed') {
      throw new Error('Repository cutover did not reconcile exact candidate bytes after an owned effect crash.');
    }

    const temporaryRoot = makeRoot('owned-temporary');
    roots.push(temporaryRoot);
    const temporaryOperations = [syntheticOperation(
      temporaryRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )];
    const temporaryCheckpoint = syntheticCheckpoint(
      temporaryRoot,
      temporaryOperations,
      'owned-temporary'
    );
    let begunTemporaryCrash = false;
    try {
      executeRepositoryCutover({
        root: temporaryRoot,
        checkpointId: temporaryCheckpoint.id,
        at: '2026-07-22T12:00:30.000Z',
        faultAfter: 'crash-after-begun-before-effect:repository-cutover-effect.0000'
      });
    } catch (error) {
      begunTemporaryCrash = error?.code === 'REPOSITORY_CUTOVER_TEST_CRASH';
    }
    if (!begunTemporaryCrash
      || readCheckpoint(temporaryRoot, temporaryCheckpoint.id).progress[0].state !== 'applying') {
      throw new Error('Repository cutover did not durably seal a per-effect begun marker.');
    }
    const ownedTemporary = operationTemporaryPath(
      temporaryRoot,
      temporaryOperations[0],
      temporaryCheckpoint
    );
    fs.writeFileSync(
      ownedTemporary,
      Buffer.from(temporaryOperations[0].after.bytesBase64, 'base64'),
      { mode: 0o644 }
    );
    fs.chmodSync(ownedTemporary, 0o644);
    const temporaryRecovered = recoverRepositoryCutover({
      root: temporaryRoot,
      checkpointId: temporaryCheckpoint.id,
      at: '2026-07-22T12:01:00.000Z'
    });
    if (temporaryRecovered.state !== 'completed'
      || fs.existsSync(ownedTemporary)
      || fs.readFileSync(path.join(temporaryRoot, 'docs/current.json'), 'utf8')
        !== '{"state":"after"}\n') {
      throw new Error('Repository cutover did not reconcile one deterministic checkpoint-owned output temporary: '
        + JSON.stringify(temporaryRecovered));
    }

    const exactUnownedTemporaryRoot = makeRoot('exact-unowned-temporary');
    roots.push(exactUnownedTemporaryRoot);
    const exactUnownedTemporaryOperations = [syntheticOperation(
      exactUnownedTemporaryRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )];
    const exactUnownedTemporaryCheckpoint = syntheticCheckpoint(
      exactUnownedTemporaryRoot,
      exactUnownedTemporaryOperations,
      'exact-unowned-temporary'
    );
    const exactUnownedTemporary = operationTemporaryPath(
      exactUnownedTemporaryRoot,
      exactUnownedTemporaryOperations[0],
      exactUnownedTemporaryCheckpoint
    );
    fs.writeFileSync(
      exactUnownedTemporary,
      Buffer.from(exactUnownedTemporaryOperations[0].after.bytesBase64, 'base64'),
      { mode: 0o644 }
    );
    fs.chmodSync(exactUnownedTemporary, 0o644);
    const exactUnownedTemporaryResult = recoverRepositoryCutover({
      root: exactUnownedTemporaryRoot,
      checkpointId: exactUnownedTemporaryCheckpoint.id,
      at: '2026-07-22T12:01:00.000Z'
    });
    if (exactUnownedTemporaryResult.state !== 'needs-attention'
      || exactUnownedTemporaryResult.failure?.reasonCode !== 'REPOSITORY_CUTOVER_TEMP_COLLISION'
      || !fs.existsSync(exactUnownedTemporary)
      || fs.readFileSync(path.join(exactUnownedTemporaryRoot, 'docs/current.json'), 'utf8')
        !== '{"state":"before"}\n') {
      throw new Error('Repository cutover adopted an exact candidate temporary before its durable begun marker.');
    }

    const unownedTemporaryRoot = makeRoot('unowned-temporary');
    roots.push(unownedTemporaryRoot);
    const unownedTemporaryOperations = [syntheticOperation(
      unownedTemporaryRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )];
    const unownedTemporaryCheckpoint = syntheticCheckpoint(
      unownedTemporaryRoot,
      unownedTemporaryOperations,
      'unowned-temporary'
    );
    const unownedTemporary = operationTemporaryPath(
      unownedTemporaryRoot,
      unownedTemporaryOperations[0],
      unownedTemporaryCheckpoint
    );
    const unownedSentinel = 'UNOWNED_FORWARD_TEMPORARY_SENTINEL\n';
    fs.writeFileSync(unownedTemporary, unownedSentinel, { mode: 0o644 });
    fs.chmodSync(unownedTemporary, 0o644);
    const unownedTemporaryResult = recoverRepositoryCutover({
      root: unownedTemporaryRoot,
      checkpointId: unownedTemporaryCheckpoint.id,
      at: '2026-07-22T12:01:00.000Z'
    });
    if (unownedTemporaryResult.state !== 'needs-attention'
      || unownedTemporaryResult.failure?.reasonCode !== 'REPOSITORY_CUTOVER_TEMP_COLLISION'
      || fs.readFileSync(unownedTemporary, 'utf8') !== unownedSentinel
      || fs.readFileSync(path.join(unownedTemporaryRoot, 'docs/current.json'), 'utf8')
        !== '{"state":"before"}\n') {
      throw new Error('Repository cutover deleted or adopted an unowned forward temporary.');
    }

    const unownedRollbackRoot = makeRoot('unowned-rollback-temporary');
    roots.push(unownedRollbackRoot);
    const unownedRollbackOperations = [syntheticOperation(
      unownedRollbackRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )];
    const unownedRollbackCheckpoint = syntheticCheckpoint(
      unownedRollbackRoot,
      unownedRollbackOperations,
      'unowned-rollback-temporary'
    );
    try {
      executeRepositoryCutover({
        root: unownedRollbackRoot,
        checkpointId: unownedRollbackCheckpoint.id,
        at: '2026-07-22T12:01:00.000Z',
        faultAfter: 'crash-after-effect:repository-cutover-effect.0000'
      });
    } catch {
      // The exact after-state is now checkpoint-owned, but rollback has not begun.
    }
    const unownedRollbackTemporary = operationTemporaryPath(
      unownedRollbackRoot,
      unownedRollbackOperations[0],
      unownedRollbackCheckpoint,
      true
    );
    const unownedRollbackSentinel = 'UNOWNED_ROLLBACK_TEMPORARY_SENTINEL\n';
    fs.writeFileSync(unownedRollbackTemporary, unownedRollbackSentinel, { mode: 0o644 });
    fs.chmodSync(unownedRollbackTemporary, 0o644);
    const unownedRollbackResult = rollbackRepositoryCutover({
      root: unownedRollbackRoot,
      checkpointId: unownedRollbackCheckpoint.id,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (unownedRollbackResult.state !== 'needs-attention'
      || unownedRollbackResult.failure?.reasonCode !== 'REPOSITORY_CUTOVER_TEMP_COLLISION'
      || fs.readFileSync(unownedRollbackTemporary, 'utf8') !== unownedRollbackSentinel
      || fs.readFileSync(path.join(unownedRollbackRoot, 'docs/current.json'), 'utf8')
        !== '{"state":"after"}\n') {
      throw new Error('Repository cutover deleted or adopted an unowned rollback temporary.');
    }

    const checkpointTemporary = checkpointFile(temporaryRoot, temporaryCheckpoint.id) + '.pending';
    fs.linkSync(checkpointFile(temporaryRoot, temporaryCheckpoint.id), checkpointTemporary);
    const checkpointWithLinkedTemporary = inspectRepositoryCutover({
      root: temporaryRoot,
      checkpointId: temporaryCheckpoint.id
    });
    if (checkpointWithLinkedTemporary.state !== 'completed'
      || fs.existsSync(checkpointTemporary)
      || fs.lstatSync(checkpointFile(temporaryRoot, temporaryCheckpoint.id)).nlink !== 1) {
      throw new Error('Repository cutover did not reconcile one durable checkpoint-link boundary.');
    }

    const checkpointUpdateRoot = makeRoot('checkpoint-update-collision');
    roots.push(checkpointUpdateRoot);
    const checkpointUpdate = syntheticCheckpoint(checkpointUpdateRoot, [syntheticOperation(
      checkpointUpdateRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )], 'checkpoint-update-collision');
    const checkpointUpdateTemporary = checkpointFile(
      checkpointUpdateRoot,
      checkpointUpdate.id
    ) + '.pending';
    const checkpointSentinel = '{"private":"UNOWNED_CHECKPOINT_TEMPORARY_SENTINEL"}\n';
    fs.writeFileSync(checkpointUpdateTemporary, checkpointSentinel, { mode: 0o600 });
    fs.chmodSync(checkpointUpdateTemporary, 0o600);
    let checkpointUpdateCollision = false;
    try {
      persistCheckpoint(checkpointUpdateRoot, structuredClone(checkpointUpdate));
    } catch (error) {
      checkpointUpdateCollision = ['REPOSITORY_CUTOVER_TEMP_COLLISION', 'REPOSITORY_CUTOVER_CHECKPOINT_INVALID']
        .includes(error?.code);
    }
    if (!checkpointUpdateCollision
      || fs.readFileSync(checkpointUpdateTemporary, 'utf8') !== checkpointSentinel) {
      throw new Error('Repository cutover update deleted or adopted an unowned checkpoint temporary.');
    }
    let checkpointReadCollision = false;
    try {
      inspectRepositoryCutover({
        root: checkpointUpdateRoot,
        checkpointId: checkpointUpdate.id
      });
    } catch (error) {
      checkpointReadCollision = ['REPOSITORY_CUTOVER_TEMP_COLLISION', 'REPOSITORY_CUTOVER_CHECKPOINT_INVALID']
        .includes(error?.code);
    }
    if (!checkpointReadCollision
      || fs.readFileSync(checkpointUpdateTemporary, 'utf8') !== checkpointSentinel) {
      throw new Error('Repository cutover read deleted or adopted an unowned checkpoint temporary.');
    }

    const checkpointCreateRoot = makeRoot('checkpoint-create-collision');
    roots.push(checkpointCreateRoot);
    const checkpointCreate = syntheticCheckpoint(checkpointCreateRoot, [syntheticOperation(
      checkpointCreateRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )], 'checkpoint-create-collision');
    const checkpointCreateFile = checkpointFile(checkpointCreateRoot, checkpointCreate.id);
    unlinkDurably(checkpointCreateFile);
    const checkpointCreateTemporary = checkpointCreateFile + '.pending';
    fs.writeFileSync(checkpointCreateTemporary, checkpointSentinel, { mode: 0o600 });
    fs.chmodSync(checkpointCreateTemporary, 0o600);
    let checkpointCreateCollision = false;
    try {
      persistCheckpoint(checkpointCreateRoot, checkpointCreate, { create: true });
    } catch (error) {
      checkpointCreateCollision = error?.code === 'REPOSITORY_CUTOVER_TEMP_COLLISION';
    }
    if (!checkpointCreateCollision
      || fs.readFileSync(checkpointCreateTemporary, 'utf8') !== checkpointSentinel
      || fs.existsSync(checkpointCreateFile)) {
      throw new Error('Repository cutover create deleted or adopted an unowned checkpoint temporary.');
    }

    const checkpointCreateHardlinkRoot = makeRoot('checkpoint-create-hardlink');
    roots.push(checkpointCreateHardlinkRoot);
    const checkpointCreateHardlink = syntheticCheckpoint(
      checkpointCreateHardlinkRoot,
      [syntheticOperation(
        checkpointCreateHardlinkRoot,
        'docs/current.json',
        '{"state":"after"}\n',
        0
      )],
      'checkpoint-create-hardlink'
    );
    const checkpointCreateHardlinkFile = checkpointFile(
      checkpointCreateHardlinkRoot,
      checkpointCreateHardlink.id
    );
    const checkpointCreateHardlinkBytes = fs.readFileSync(checkpointCreateHardlinkFile);
    unlinkDurably(checkpointCreateHardlinkFile);
    const checkpointCreateExternal = path.join(
      os.tmpdir(),
      'soter-repository-cutover-checkpoint-create-external-' + process.pid + '.json'
    );
    fs.writeFileSync(checkpointCreateExternal, checkpointCreateHardlinkBytes, { mode: 0o600 });
    fs.chmodSync(checkpointCreateExternal, 0o600);
    roots.push(checkpointCreateExternal);
    const checkpointCreateHardlinkTemporary = checkpointCreateHardlinkFile + '.pending';
    fs.linkSync(checkpointCreateExternal, checkpointCreateHardlinkTemporary);
    const checkpointCreateExternalBefore = exactFileState(checkpointCreateExternal);
    let checkpointCreateHardlinkRejected = false;
    try {
      persistCheckpoint(
        checkpointCreateHardlinkRoot,
        checkpointCreateHardlink,
        { create: true }
      );
    } catch (error) {
      checkpointCreateHardlinkRejected = error?.code === 'REPOSITORY_CUTOVER_TEMP_COLLISION';
    }
    if (!checkpointCreateHardlinkRejected
      || !sameJson(exactFileState(checkpointCreateExternal), checkpointCreateExternalBefore)
      || !sameJson(
        exactFileState(checkpointCreateHardlinkTemporary),
        checkpointCreateExternalBefore
      )
      || fs.existsSync(checkpointCreateHardlinkFile)) {
      throw new Error('Repository cutover create mutated or adopted an external checkpoint hardlink.');
    }

    const checkpointReadHardlinkRoot = makeRoot('checkpoint-read-hardlink');
    roots.push(checkpointReadHardlinkRoot);
    const checkpointReadHardlink = syntheticCheckpoint(
      checkpointReadHardlinkRoot,
      [syntheticOperation(
        checkpointReadHardlinkRoot,
        'docs/current.json',
        '{"state":"after"}\n',
        0
      )],
      'checkpoint-read-hardlink'
    );
    const checkpointReadHardlinkFile = checkpointFile(
      checkpointReadHardlinkRoot,
      checkpointReadHardlink.id
    );
    const checkpointReadExternal = path.join(
      os.tmpdir(),
      'soter-repository-cutover-checkpoint-read-external-' + process.pid + '.json'
    );
    fs.copyFileSync(checkpointReadHardlinkFile, checkpointReadExternal, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(checkpointReadExternal, 0o600);
    roots.push(checkpointReadExternal);
    const checkpointReadHardlinkTemporary = checkpointReadHardlinkFile + '.pending';
    fs.linkSync(checkpointReadExternal, checkpointReadHardlinkTemporary);
    const checkpointReadExternalBefore = exactFileState(checkpointReadExternal);
    let checkpointUpdateHardlinkRejected = false;
    try {
      persistCheckpoint(checkpointReadHardlinkRoot, structuredClone(checkpointReadHardlink));
    } catch (error) {
      checkpointUpdateHardlinkRejected = error?.code === 'REPOSITORY_CUTOVER_TEMP_COLLISION';
    }
    let checkpointReadHardlinkRejected = false;
    try {
      inspectRepositoryCutover({
        root: checkpointReadHardlinkRoot,
        checkpointId: checkpointReadHardlink.id
      });
    } catch (error) {
      checkpointReadHardlinkRejected = error?.code === 'REPOSITORY_CUTOVER_TEMP_COLLISION';
    }
    if (!checkpointUpdateHardlinkRejected || !checkpointReadHardlinkRejected
      || !sameJson(exactFileState(checkpointReadExternal), checkpointReadExternalBefore)
      || !sameJson(
        exactFileState(checkpointReadHardlinkTemporary),
        checkpointReadExternalBefore
      )
      || fs.lstatSync(checkpointReadHardlinkFile).nlink !== 1) {
      throw new Error('Repository cutover read/update mutated or adopted an external checkpoint hardlink.');
    }

    const primaryModeRoot = makeRoot('checkpoint-primary-mode');
    roots.push(primaryModeRoot);
    const primaryModeCheckpoint = syntheticCheckpoint(primaryModeRoot, [syntheticOperation(
      primaryModeRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )], 'checkpoint-primary-mode');
    const primaryModeFile = checkpointFile(primaryModeRoot, primaryModeCheckpoint.id);
    fs.chmodSync(primaryModeFile, 0o644);
    let primaryModeRejected = false;
    try {
      inspectRepositoryCutover({ root: primaryModeRoot, checkpointId: primaryModeCheckpoint.id });
    } catch (error) {
      primaryModeRejected = error?.code === 'REPOSITORY_CUTOVER_CHECKPOINT_INVALID';
    }
    if (!primaryModeRejected || (fs.lstatSync(primaryModeFile).mode & 0o7777) !== 0o644) {
      throw new Error('Repository cutover accepted or mutated a primary checkpoint with unsafe mode.');
    }

    const primarySymlinkRoot = makeRoot('checkpoint-primary-symlink');
    roots.push(primarySymlinkRoot);
    const primarySymlinkCheckpoint = syntheticCheckpoint(
      primarySymlinkRoot,
      [syntheticOperation(
        primarySymlinkRoot,
        'docs/current.json',
        '{"state":"after"}\n',
        0
      )],
      'checkpoint-primary-symlink'
    );
    const primarySymlinkFile = checkpointFile(
      primarySymlinkRoot,
      primarySymlinkCheckpoint.id
    );
    const primarySymlinkExternal = path.join(
      os.tmpdir(),
      'soter-repository-cutover-primary-symlink-' + process.pid + '.json'
    );
    fs.copyFileSync(primarySymlinkFile, primarySymlinkExternal, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(primarySymlinkExternal, 0o600);
    roots.push(primarySymlinkExternal);
    const primarySymlinkExternalBefore = exactFileState(primarySymlinkExternal);
    unlinkDurably(primarySymlinkFile);
    fs.symlinkSync(primarySymlinkExternal, primarySymlinkFile);
    let primarySymlinkRejected = false;
    try {
      inspectRepositoryCutover({
        root: primarySymlinkRoot,
        checkpointId: primarySymlinkCheckpoint.id
      });
    } catch (error) {
      primarySymlinkRejected = [
        'REPOSITORY_CUTOVER_CHECKPOINT_INVALID',
        'REPOSITORY_CUTOVER_SYMLINK_REJECTED'
      ].includes(error?.code);
    }
    if (!primarySymlinkRejected
      || !sameJson(exactFileState(primarySymlinkExternal), primarySymlinkExternalBefore)) {
      throw new Error('Repository cutover accepted or mutated a symlinked primary checkpoint.');
    }

    const privateModeRoot = makeRoot('private-parent-mode');
    roots.push(privateModeRoot);
    fs.mkdirSync(path.join(privateModeRoot, '.soter'), { mode: 0o755 });
    fs.chmodSync(path.join(privateModeRoot, '.soter'), 0o755);
    let privateModeRejected = false;
    try {
      syntheticCheckpoint(privateModeRoot, [syntheticOperation(
        privateModeRoot,
        'docs/current.json',
        '{"state":"after"}\n',
        0
      )], 'private-parent-mode');
    } catch (error) {
      privateModeRejected = error?.code === 'REPOSITORY_CUTOVER_PRIVATE_STATE_INVALID';
    }
    if (!privateModeRejected || (fs.lstatSync(path.join(privateModeRoot, '.soter')).mode & 0o7777) !== 0o755) {
      throw new Error('Repository cutover adopted or silently chmodded a pre-existing unsafe private ancestor.');
    }

    const privateSymlinkRoot = makeRoot('private-parent-symlink');
    roots.push(privateSymlinkRoot);
    const privateSymlinkExternal = fs.mkdtempSync(
      path.join(os.tmpdir(), 'soter-repository-cutover-private-parent-')
    );
    fs.chmodSync(privateSymlinkExternal, 0o700);
    roots.push(privateSymlinkExternal);
    fs.symlinkSync(privateSymlinkExternal, path.join(privateSymlinkRoot, '.soter'), 'dir');
    let privateSymlinkRejected = false;
    try {
      syntheticCheckpoint(privateSymlinkRoot, [syntheticOperation(
        privateSymlinkRoot,
        'docs/current.json',
        '{"state":"after"}\n',
        0
      )], 'private-parent-symlink');
    } catch (error) {
      privateSymlinkRejected = error?.code === 'REPOSITORY_CUTOVER_PRIVATE_STATE_INVALID';
    }
    if (!privateSymlinkRejected || fs.readdirSync(privateSymlinkExternal).length !== 0) {
      throw new Error('Repository cutover accepted or mutated a symlinked private ancestor.');
    }

    const privateFileRoot = makeRoot('private-parent-file');
    roots.push(privateFileRoot);
    fs.writeFileSync(path.join(privateFileRoot, '.soter'), 'not-a-directory\n', { mode: 0o600 });
    let privateFileRejected = false;
    try {
      syntheticCheckpoint(privateFileRoot, [syntheticOperation(
        privateFileRoot,
        'docs/current.json',
        '{"state":"after"}\n',
        0
      )], 'private-parent-file');
    } catch (error) {
      privateFileRejected = error?.code === 'REPOSITORY_CUTOVER_PRIVATE_STATE_INVALID';
    }
    if (!privateFileRejected
      || fs.readFileSync(path.join(privateFileRoot, '.soter'), 'utf8') !== 'not-a-directory\n') {
      throw new Error('Repository cutover accepted or mutated a non-directory private ancestor.');
    }

    const privateDriftRoot = makeRoot('private-parent-drift');
    roots.push(privateDriftRoot);
    const privateDriftCheckpoint = syntheticCheckpoint(privateDriftRoot, [syntheticOperation(
      privateDriftRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )], 'private-parent-drift');
    fs.chmodSync(path.join(privateDriftRoot, '.soter', 'state'), 0o755);
    let privateDriftRejected = false;
    try {
      inspectRepositoryCutover({
        root: privateDriftRoot,
        checkpointId: privateDriftCheckpoint.id
      });
    } catch (error) {
      privateDriftRejected = error?.code === 'REPOSITORY_CUTOVER_PRIVATE_STATE_INVALID';
    }
    fs.chmodSync(path.join(privateDriftRoot, '.soter', 'state'), 0o700);
    const statePath = path.join(privateDriftRoot, '.soter', 'state');
    const movedStatePath = path.join(privateDriftRoot, '.soter', 'state-owned');
    fs.renameSync(statePath, movedStatePath);
    fs.symlinkSync(movedStatePath, statePath, 'dir');
    let privateLinkDriftRejected = false;
    try {
      inspectRepositoryCutover({
        root: privateDriftRoot,
        checkpointId: privateDriftCheckpoint.id
      });
    } catch (error) {
      privateLinkDriftRejected = error?.code === 'REPOSITORY_CUTOVER_PRIVATE_STATE_INVALID';
    }
    if (!privateDriftRejected || !privateLinkDriftRejected) {
      throw new Error('Repository cutover did not reject post-create private ancestor mode or symlink drift.');
    }

    const wrongRoot = makeRoot('wrong-root');
    roots.push(wrongRoot);
    let wrongRootRejected = false;
    try {
      inspectRepositoryCutover({ root: wrongRoot, checkpointId: crashCheckpoint.id });
    } catch (error) {
      wrongRootRejected = [
        'REPOSITORY_CUTOVER_CHECKPOINT_INVALID',
        'REPOSITORY_CUTOVER_PRIVATE_STATE_INVALID',
        'REPOSITORY_CUTOVER_ROOT_DRIFT'
      ].includes(error?.code);
    }
    if (!wrongRootRejected) throw new Error('Repository cutover accepted a wrong repository root.');

    const requestDirectory = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), 'soter-repository-cutover-wrong-request-')
    ));
    roots.push(requestDirectory);
    fs.chmodSync(requestDirectory, 0o700);
    const lifecycleRequestPath = path.join(requestDirectory, 'lifecycle.json');
    const transitionRequestPath = path.join(requestDirectory, 'transition.json');
    const fixtureFinalizationRequestPath = path.join(requestDirectory, 'fixture.json');
    for (const file of [lifecycleRequestPath, transitionRequestPath, fixtureFinalizationRequestPath]) {
      writeCanonicalPrivate(file, {});
    }
    writeCanonicalPrivate(transitionRequestPath, {
      $contract: legacyTransitionFinalizationContract.request
    });
    const builderRootBefore = fingerprintPath(crashRoot);
    const wrongRequest = buildRepositoryCutoverRequest({
      root: crashRoot,
      id: 'repository-cutover.wrong-request',
      createdAt: '2026-07-22T12:00:00.000Z',
      lifecycleRequestPath,
      transitionRequestPath,
      fixtureFinalizationRequestPath
    });
    const exactBuiltRequest = {
      $contract: REQUEST_CONTRACT,
      contractVersion: '1.0.0',
      id: 'repository-cutover.wrong-request',
      createdAt: '2026-07-22T12:00:00.000Z',
      rootIdentityFingerprint: repositoryCutoverRootIdentity(crashRoot).fingerprint,
      lifecycleRequest: { path: lifecycleRequestPath, fingerprint: fingerprintFile(lifecycleRequestPath) },
      transitionRequest: { path: transitionRequestPath, fingerprint: fingerprintFile(transitionRequestPath) },
      fixtureFinalizationRequest: {
        path: fixtureFinalizationRequestPath,
        fingerprint: fingerprintFile(fixtureFinalizationRequestPath)
      },
      requestFingerprint: null
    };
    exactBuiltRequest.requestFingerprint = requestFingerprint(exactBuiltRequest);
    if (!sameJson(wrongRequest, exactBuiltRequest)
      || fingerprintPath(crashRoot) !== builderRootBefore) {
      throw new Error('Repository cutover request builder did not return the exact no-write root-bound request.');
    }
    writeCanonicalPrivate(transitionRequestPath, {
      checkerReceipt: { id: 'legacy-checker-run.synthetic' },
      transitions: []
    });
    let miniTransitionRejected = false;
    try {
      buildRepositoryCutoverRequest({
        root: crashRoot,
        id: 'repository-cutover.mini-transition',
        createdAt: '2026-07-22T12:00:00.000Z',
        lifecycleRequestPath,
        transitionRequestPath,
        fixtureFinalizationRequestPath
      });
    } catch (error) {
      miniTransitionRejected = error?.code === 'REPOSITORY_CUTOVER_TRANSITION_REQUEST_INVALID';
    }
    if (!miniTransitionRejected) {
      throw new Error('Repository cutover accepted the retired checkerReceipt/transitions mini-envelope.');
    }
    writeCanonicalPrivate(transitionRequestPath, {
      $contract: legacyTransitionFinalizationContract.request
    });
    const refreshedWrongRequest = buildRepositoryCutoverRequest({
      root: crashRoot,
      id: 'repository-cutover.wrong-request',
      createdAt: '2026-07-22T12:00:00.000Z',
      lifecycleRequestPath,
      transitionRequestPath,
      fixtureFinalizationRequestPath
    });
    const wrongRequestPath = path.join(requestDirectory, 'request.json');
    writeCanonicalPrivate(wrongRequestPath, refreshedWrongRequest);
    let lexicalAliasRejected = false;
    try {
      readRepositoryCutoverRequest({
        root: crashRoot,
        requestPath: requestDirectory + '/unused/../request.json'
      });
    } catch (error) {
      lexicalAliasRejected = error?.code === 'REPOSITORY_CUTOVER_REQUEST_PATH_INVALID';
    }
    const requestDirectoryAlias = requestDirectory + '-alias';
    fs.symlinkSync(requestDirectory, requestDirectoryAlias, 'dir');
    roots.push(requestDirectoryAlias);
    let symlinkParentAliasRejected = false;
    try {
      readRepositoryCutoverRequest({
        root: crashRoot,
        requestPath: path.join(requestDirectoryAlias, 'request.json')
      });
    } catch (error) {
      symlinkParentAliasRejected = error?.code === 'REPOSITORY_CUTOVER_REQUEST_PATH_INVALID';
    }
    if (!lexicalAliasRejected || !symlinkParentAliasRejected) {
      throw new Error('Repository cutover accepted an aliased external request path.');
    }
    let wrongRequestRejected = false;
    try {
      readRepositoryCutoverRequest({ root: wrongRoot, requestPath: wrongRequestPath });
    } catch (error) {
      wrongRequestRejected = error?.code === 'REPOSITORY_CUTOVER_ROOT_DRIFT';
    }
    if (!wrongRequestRejected) {
      throw new Error('Repository cutover accepted a request bound to a different root identity.');
    }
    writeCanonicalPrivate(lifecycleRequestPath, { substituted: true });
    let substitutedRequestRejected = false;
    try {
      readRepositoryCutoverRequest({ root: crashRoot, requestPath: wrongRequestPath });
    } catch (error) {
      substitutedRequestRejected = error?.code === 'REPOSITORY_CUTOVER_SUBREQUEST_DRIFT';
    }
    if (!substitutedRequestRejected) {
      throw new Error('Repository cutover accepted same-path replacement of a signed private subrequest.');
    }

    const rollbackRecoveryRoot = makeRoot('rollback-recovery');
    roots.push(rollbackRecoveryRoot);
    const rollbackRecoveryOperations = [syntheticOperation(
      rollbackRecoveryRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )];
    const rollbackRecoveryCheckpoint = syntheticCheckpoint(
      rollbackRecoveryRoot,
      rollbackRecoveryOperations,
      'rollback-recovery'
    );
    try {
      executeRepositoryCutover({
        root: rollbackRecoveryRoot,
        checkpointId: rollbackRecoveryCheckpoint.id,
        at: '2026-07-22T12:01:00.000Z',
        faultAfter: 'crash-after-effect:repository-cutover-effect.0000'
      });
    } catch {
      // Deliberate crash leaves exact candidate bytes checkpoint-owned.
    }
    const rollingCheckpoint = readCheckpoint(
      rollbackRecoveryRoot,
      rollbackRecoveryCheckpoint.id
    );
    rollingCheckpoint.state = 'rolling-back';
    rollingCheckpoint.phase = 'rollback';
    rollingCheckpoint.currentOperationId = rollingCheckpoint.operations[0].id;
    rollingCheckpoint.failure = {
      reasonCode: 'REPOSITORY_CUTOVER_EXECUTION_FAILED',
      summary: 'Repository cutover stopped and attempted exact rollback.'
    };
    persistCheckpoint(rollbackRecoveryRoot, rollingCheckpoint);
    const rollbackRecovered = recoverRepositoryCutover({
      root: rollbackRecoveryRoot,
      checkpointId: rollbackRecoveryCheckpoint.id,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (rollbackRecovered.state !== 'rolled-back'
      || fs.readFileSync(path.join(rollbackRecoveryRoot, 'docs/current.json'), 'utf8')
        !== '{"state":"before"}\n') {
      throw new Error('Repository cutover recovery resumed forward after rollback had begun.');
    }

    const rollbackSubstitutionRoot = makeRoot('rollback-external-before');
    roots.push(rollbackSubstitutionRoot);
    const rollbackSubstitutionOperations = [syntheticOperation(
      rollbackSubstitutionRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )];
    const rollbackSubstitutionCheckpoint = syntheticCheckpoint(
      rollbackSubstitutionRoot,
      rollbackSubstitutionOperations,
      'rollback-external-before'
    );
    try {
      executeRepositoryCutover({
        root: rollbackSubstitutionRoot,
        checkpointId: rollbackSubstitutionCheckpoint.id,
        at: '2026-07-22T12:01:00.000Z',
        faultAfter: 'crash-after-effect:repository-cutover-effect.0000'
      });
    } catch {
      // The exact candidate is applied and durably recorded, but rollback has not begun.
    }
    fs.writeFileSync(
      path.join(rollbackSubstitutionRoot, 'docs/current.json'),
      '{"state":"before"}\n'
    );
    fs.chmodSync(path.join(rollbackSubstitutionRoot, 'docs/current.json'), 0o644);
    const rollbackSubstitution = rollbackRepositoryCutover({
      root: rollbackSubstitutionRoot,
      checkpointId: rollbackSubstitutionCheckpoint.id,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (rollbackSubstitution.state !== 'needs-attention'
      || rollbackSubstitution.failure?.reasonCode !== 'REPOSITORY_CUTOVER_ROLLBACK_DRIFT'
      || fs.readFileSync(path.join(rollbackSubstitutionRoot, 'docs/current.json'), 'utf8')
        !== '{"state":"before"}\n') {
      throw new Error('Repository cutover adopted exact prior bytes that appeared before rollback ownership began.');
    }

    const rollbackDriftRoot = makeRoot('rollback-drift');
    roots.push(rollbackDriftRoot);
    const rollbackDriftOperations = [syntheticOperation(
      rollbackDriftRoot,
      'docs/current.json',
      '{"state":"after"}\n',
      0
    )];
    const rollbackDriftCheckpoint = syntheticCheckpoint(
      rollbackDriftRoot,
      rollbackDriftOperations,
      'rollback-drift'
    );
    try {
      executeRepositoryCutover({
        root: rollbackDriftRoot,
        checkpointId: rollbackDriftCheckpoint.id,
        at: '2026-07-22T12:01:00.000Z',
        faultAfter: 'crash-after-effect:repository-cutover-effect.0000'
      });
    } catch {
      // Deliberate crash leaves exact candidate bytes checkpoint-owned.
    }
    fs.writeFileSync(path.join(rollbackDriftRoot, 'docs/current.json'), 'unknown\n');
    const rollbackAttention = rollbackRepositoryCutover({
      root: rollbackDriftRoot,
      checkpointId: rollbackDriftCheckpoint.id,
      at: '2026-07-22T12:02:00.000Z'
    });
    if (rollbackAttention.state !== 'needs-attention'
      || rollbackAttention.failure?.reasonCode !== 'REPOSITORY_CUTOVER_ROLLBACK_DRIFT') {
      throw new Error('Repository cutover did not surface rollback drift as needs-attention.');
    }
    return true;
  } finally {
    for (const target of roots.reverse()) fs.rmSync(target, { recursive: true, force: true });
  }
}

export const repositoryCutoverContract = Object.freeze({
  request: REQUEST_CONTRACT,
  checkpoint: CHECKPOINT_CONTRACT,
  inspection: INSPECTION_CONTRACT,
  expectedSourceDeletions: EXPECTED_SOURCE_DELETIONS,
  expectedBindingTransitions: EXPECTED_BINDING_TRANSITIONS,
  expectedOperationalDeletions: EXPECTED_OPERATIONAL_DELETIONS
});
