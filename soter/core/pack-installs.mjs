import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inspectBundle,
  satisfiesVersion,
  verifyPackRelease
} from '../kernel/distribution.mjs';
import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  canonicalJson,
  fingerprintJson,
  readJson,
  resolveRepoPath,
  sha256
} from './lib/canonical-json.mjs';
import {
  createPackInstallCheckpointState,
  createPackInstallConfirmationState,
  createPackInstallConsumptionState,
  createPackInstallPlanState,
  createPackInstallRequestState,
  hasPackInstallCheckpointState,
  hasPackInstallConfirmationState,
  hasPackInstallConsumptionState,
  hasPackInstallManagedManifestState,
  hasPackInstallPlanState,
  hasPackInstallRequestState,
  packInstallManagedManifestStatePath,
  readPackInstallCheckpointState,
  readPackInstallConfirmationState,
  readPackInstallConsumptionState,
  readPackInstallManagedManifestState,
  readPackInstallPlanState,
  readPackInstallRequestState,
  removePackInstallManagedManifestState,
  writePackInstallCheckpointState,
  writePackInstallConsumptionState,
  writePackInstallManagedManifestState
} from './runtime-state.mjs';

const moduleFile = fileURLToPath(import.meta.url);
const DEFAULT_SOURCE_ROOT = path.resolve(path.dirname(moduleFile), '..', '..');
const FILE_MODES = new Set(['0644', '0755']);
const DIRECTORY_MODE = 0o755;
const CONTRACTS = {
  plan: ['soter://contracts/pack-install-plan/v1', 'soter/contracts/pack-install-plan.schema.json'],
  request: ['soter://contracts/pack-install-request/v1', 'soter/contracts/pack-install-request.schema.json'],
  confirmation: ['soter://contracts/pack-install-confirmation/v1', 'soter/contracts/pack-install-confirmation.schema.json'],
  consumption: ['soter://contracts/pack-install-consumption/v1', 'soter/contracts/pack-install-consumption.schema.json'],
  checkpoint: ['soter://contracts/pack-install-checkpoint/v1', 'soter/contracts/pack-install-checkpoint.schema.json'],
  manifest: ['soter://contracts/pack-install-managed-manifest/v1', 'soter/contracts/pack-install-managed-manifest.schema.json'],
  inspection: ['soter://contracts/pack-install-inspection/v1', 'soter/contracts/pack-install-inspection.schema.json']
};
const RUNTIME_BASIS_PATHS = [
  'soter/core/pack-installs.mjs',
  'soter/core/runtime-state.mjs',
  'soter/kernel/distribution.mjs',
  ...Object.values(CONTRACTS).map(([, schemaPath]) => schemaPath)
];

export class PackInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackInstallError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PackInstallError(code, message);
}

function stableFailureCode(error, fallback) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^PACK_INSTALL_[A-Z0-9_]+$/.test(code) ? code : fallback;
}

function compareCodepoint(left, right) {
  const leftPoints = [...left].map((value) => value.codePointAt(0));
  const rightPoints = [...right].map((value) => value.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function clone(value) {
  return structuredClone(value);
}

function seal(value, property) {
  value[property] = null;
  const unsigned = { ...value };
  delete unsigned[property];
  value[property] = fingerprintJson(unsigned);
  return value;
}

function validate(sourceRoot, value, kind, label) {
  const [contract, schemaPath] = CONTRACTS[kind];
  if (value?.$contract !== contract) {
    fail(`PACK_INSTALL_${kind.toUpperCase()}_MALFORMED`, `${label} contract is invalid.`);
  }
  let schema;
  try {
    schema = readJson(resolveRepoPath(sourceRoot, schemaPath));
  } catch {
    fail('PACK_INSTALL_RUNTIME_STALE', 'Pack install runtime contracts are unavailable.');
  }
  if (validateJsonSchema(value, schema).length) {
    fail(`PACK_INSTALL_${kind.toUpperCase()}_MALFORMED`, `${label} does not satisfy its contract.`);
  }
  return value;
}

function assertFingerprint(sourceRoot, value, kind, property, label) {
  validate(sourceRoot, value, kind, label);
  const unsigned = { ...value };
  delete unsigned[property];
  if (value[property] !== fingerprintJson(unsigned)) {
    fail(`PACK_INSTALL_${kind.toUpperCase()}_TAMPERED`, `${label} fingerprint is invalid.`);
  }
  return value;
}

function parseInstant(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('PACK_INSTALL_TIME_INVALID', `${label} is not an ISO timestamp.`);
  return parsed;
}

function requireWindow(createdAt, expiresAt, label) {
  if (parseInstant(expiresAt, `${label} expiry`) <= parseInstant(createdAt, `${label} creation`)) {
    fail('PACK_INSTALL_TIME_INVALID', `${label} expiry must follow creation.`);
  }
}

function requireNotExpired(expiresAt, currentAt, code = 'PACK_INSTALL_REQUEST_EXPIRED') {
  if (parseInstant(currentAt, 'Current time') > parseInstant(expiresAt, 'Expiry')) {
    fail(code, 'Pack install authority has expired.');
  }
}

function runtimeFingerprint(sourceRoot) {
  try {
    return fingerprintJson(RUNTIME_BASIS_PATHS.map((relative) => ({
      path: relative,
      fingerprint: sha256(fs.readFileSync(resolveRepoPath(sourceRoot, relative)))
    })));
  } catch {
    fail('PACK_INSTALL_RUNTIME_STALE', 'Pack install runtime basis cannot be fingerprinted.');
  }
}

function assertRuntime(sourceRoot, expected) {
  if (runtimeFingerprint(sourceRoot) !== expected) {
    fail('PACK_INSTALL_RUNTIME_STALE', 'Pack install runtime changed after preview.');
  }
}

function targetIdentity(targetRoot) {
  const requestedPath = path.resolve(targetRoot);
  if (!fs.existsSync(requestedPath) || !fs.statSync(requestedPath).isDirectory()) {
    fail('PACK_INSTALL_TARGET_INVALID', 'Install target is unavailable or not a directory.');
  }
  if (fs.lstatSync(requestedPath).isSymbolicLink()) {
    fail('PACK_INSTALL_TARGET_SYMLINK_REJECTED', 'Install target cannot be a symbolic link.');
  }
  const realPath = fs.realpathSync(requestedPath);
  if (realPath !== requestedPath) {
    fail('PACK_INSTALL_TARGET_SYMLINK_REJECTED', 'Install target path contains symbolic-link traversal.');
  }
  const stat = fs.statSync(realPath);
  const identity = {
    requestedPath,
    realPath,
    device: Number(stat.dev),
    inode: Number(stat.ino)
  };
  return { ...identity, fingerprint: fingerprintJson(identity) };
}

function assertTarget(targetRoot, expected) {
  const observed = targetIdentity(targetRoot);
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    fail('PACK_INSTALL_TARGET_DRIFT', 'Install target identity changed after preview.');
  }
  return observed;
}

function normalizedRelative(value) {
  if (typeof value !== 'string' || !value.length || value.includes('\\')
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value === '.' || value === '..' || value.startsWith('../') || value.includes('/../')) {
    fail('PACK_INSTALL_PATH_INVALID', 'Managed install path is not normalized and relative.');
  }
  return value;
}

function outputPath(targetRoot, relative, { allowMissingParents = true } = {}) {
  const normalized = normalizedRelative(relative);
  const root = path.resolve(targetRoot);
  const target = path.resolve(root, normalized);
  if (!target.startsWith(root + path.sep)) {
    fail('PACK_INSTALL_PATH_ESCAPE', 'Managed install path escapes the target root.');
  }
  let cursor = root;
  const parts = normalized.split('/');
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) {
      if (index === parts.length - 1 || allowMissingParents) break;
      fail('PACK_INSTALL_PATH_DRIFT', 'Managed install parent is missing.');
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      fail('PACK_INSTALL_SYMLINK_REJECTED', 'Managed install path traverses a symbolic link.');
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      fail('PACK_INSTALL_PATH_INVALID', 'Managed install parent is not a directory.');
    }
  }
  return target;
}

function modeOf(stat) {
  const permissionWord = stat.mode & 0o7777;
  if ((permissionWord & 0o7000) !== 0) {
    fail('PACK_INSTALL_OUTPUT_MODE_INVALID', 'Managed install output has prohibited special permission bits.');
  }
  const mode = permissionWord.toString(8).padStart(4, '0');
  if (!FILE_MODES.has(mode)) {
    fail('PACK_INSTALL_OUTPUT_MODE_INVALID', 'Managed install output mode is outside the closed mode policy.');
  }
  return mode;
}

function fileFingerprint(contentFingerprint, mode) {
  return fingerprintJson({ contentFingerprint, mode });
}

function absentSnapshot() {
  return { state: 'absent', content: null, mode: null, contentFingerprint: null, fingerprint: null };
}

function snapshotFromBytes(bytes, mode) {
  const contentFingerprint = sha256(bytes);
  return {
    state: 'present',
    content: bytes.toString('base64'),
    mode,
    contentFingerprint,
    fingerprint: fileFingerprint(contentFingerprint, mode)
  };
}

function readOutputSnapshot(targetRoot, relative) {
  const file = outputPath(targetRoot, relative);
  if (!fs.existsSync(file)) return absentSnapshot();
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail('PACK_INSTALL_OUTPUT_INVALID', 'Managed install output is not one regular non-linked file.');
  }
  return snapshotFromBytes(fs.readFileSync(file), modeOf(stat));
}

function snapshotEquals(left, right) {
  return left.state === right.state && left.fingerprint === right.fingerprint;
}

function decodeInventory(entry) {
  const bytes = Buffer.from(entry.content, 'base64');
  if (bytes.toString('base64') !== entry.content
    || bytes.length !== entry.bytes
    || sha256(bytes) !== entry.contentFingerprint) {
    fail('PACK_INSTALL_RELEASE_TAMPERED', 'Verified release inventory changed before planning.');
  }
  return bytes;
}

function releaseLegal(capsule) {
  return {
    publisher: capsule.legal.publisher.state,
    license: capsule.legal.license.state,
    legalSufficiency: capsule.legal.legalSufficiency
  };
}

function installedReleaseFromCapsule(capsule, capsuleDigest) {
  return {
    pack: capsule.pack.id,
    version: capsule.pack.version,
    layer: capsule.pack.layer,
    capsuleDigest,
    manifestFingerprint: capsule.pack.manifestFingerprint,
    sourceInputFingerprint: capsule.sourceInputFingerprint,
    inventoryFingerprint: capsule.inventoryFingerprint,
    dependencies: clone(capsule.pack.dependencies),
    compatibility: clone(capsule.pack.compatibility),
    legal: releaseLegal(capsule),
    trust: clone(capsule.trust)
  };
}

function loadVerifiedRelease({ sourceRoot, targetRoot, capsulePath }) {
  if (!path.isAbsolute(capsulePath)) {
    fail('PACK_INSTALL_RELEASE_PATH_INVALID', 'Pack release path must be absolute.');
  }
  let realPath;
  try {
    realPath = fs.realpathSync(path.resolve(capsulePath));
  } catch {
    fail('PACK_INSTALL_RELEASE_MISSING', 'Pack release capsule is unavailable.');
  }
  const realTarget = fs.realpathSync(path.resolve(targetRoot));
  if (realPath === realTarget || realPath.startsWith(realTarget + path.sep)) {
    fail('PACK_INSTALL_RELEASE_PATH_INVALID', 'Pack release capsule must remain outside the install target.');
  }
  let inspection;
  try {
    inspection = verifyPackRelease({ capsulePath: realPath, contractRoot: sourceRoot });
  } catch (error) {
    fail(error?.code || 'PACK_INSTALL_RELEASE_INVALID', 'Pack release capsule failed independent verification.');
  }
  const bytes = fs.readFileSync(realPath);
  if (sha256(bytes) !== inspection.release.capsuleDigest) {
    fail('PACK_INSTALL_RELEASE_DRIFT', 'Pack release capsule changed during verification.');
  }
  let capsule;
  try {
    capsule = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('PACK_INSTALL_RELEASE_INVALID', 'Pack release capsule is malformed.');
  }
  const outputs = capsule.inventory.map((entry) => {
    const content = decodeInventory(entry);
    const fingerprint = fileFingerprint(entry.contentFingerprint, entry.mode);
    return {
      managed: {
        pack: capsule.pack.id,
        path: entry.path,
        role: entry.role,
        mode: entry.mode,
        contentFingerprint: entry.contentFingerprint,
        fingerprint
      },
      snapshot: snapshotFromBytes(content, entry.mode)
    };
  });
  const installed = installedReleaseFromCapsule(capsule, inspection.release.capsuleDigest);
  return {
    planRelease: {
      ...installed,
      capsulePath: realPath,
      releaseStage: capsule.pack.releaseStage,
      evidenceMaturity: capsule.pack.evidenceMaturity
    },
    installed,
    outputs,
    capsule
  };
}

function parseVersion(version) {
  return version.split('.').map((part) => BigInt(part));
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function assertUniqueLoadedReleases(loaded) {
  const ids = new Set();
  for (const release of loaded) {
    if (ids.has(release.installed.pack)) {
      fail('PACK_INSTALL_RELEASE_DUPLICATE', 'The exact release set contains a duplicate pack identity.');
    }
    ids.add(release.installed.pack);
  }
}

function manifestFingerprint(manifest) {
  const unsigned = { ...manifest };
  delete unsigned.manifestFingerprint;
  return fingerprintJson(unsigned);
}

function assertManagedManifest(sourceRoot, targetRoot, target, manifest, { verifyOutputs = true } = {}) {
  validate(sourceRoot, manifest, 'manifest', 'Managed pack install manifest');
  if (manifest.manifestFingerprint !== manifestFingerprint(manifest)) {
    fail('PACK_INSTALL_MANIFEST_TAMPERED', 'Managed pack install manifest fingerprint is invalid.');
  }
  if (manifest.targetFingerprint !== target.fingerprint) {
    fail('PACK_INSTALL_MANIFEST_TARGET_DRIFT', 'Managed pack install manifest belongs to another target.');
  }
  const releaseIds = new Set();
  const outputPaths = new Set();
  for (const release of manifest.releases) {
    if (releaseIds.has(release.pack)) {
      fail('PACK_INSTALL_MANIFEST_INVALID', 'Managed pack install manifest contains duplicate releases.');
    }
    releaseIds.add(release.pack);
  }
  for (const output of manifest.outputs) {
    normalizedRelative(output.path);
    if (!releaseIds.has(output.pack) || outputPaths.has(output.path)
      || output.fingerprint !== fileFingerprint(output.contentFingerprint, output.mode)) {
      fail('PACK_INSTALL_MANIFEST_INVALID', 'Managed pack install ownership is inconsistent.');
    }
    outputPaths.add(output.path);
    if (verifyOutputs) {
      const observed = readOutputSnapshot(targetRoot, output.path);
      if (observed.state !== 'present' || observed.fingerprint !== output.fingerprint) {
        fail('PACK_INSTALL_MANAGED_DRIFT', 'A managed pack install output drifted after installation.');
      }
    }
  }
  return manifest;
}

function priorManifestState(sourceRoot, targetRoot, target) {
  if (!hasPackInstallManagedManifestState(targetRoot)) {
    return { manifest: null, snapshot: absentSnapshot(), document: { state: 'absent', content: null, fingerprint: null } };
  }
  let manifest;
  try {
    manifest = readPackInstallManagedManifestState(targetRoot).manifest;
  } catch {
    fail('PACK_INSTALL_MANIFEST_MALFORMED', 'Managed pack install manifest cannot be read.');
  }
  assertManagedManifest(sourceRoot, targetRoot, target, manifest);
  const bytes = fs.readFileSync(packInstallManagedManifestStatePath(targetRoot));
  return {
    manifest,
    snapshot: snapshotFromBytes(bytes, '0600'),
    document: { state: 'present', content: bytes.toString('base64'), fingerprint: sha256(bytes) }
  };
}

function assertBundleSelection({ sourceRoot, bundlePath, loaded }) {
  if (!bundlePath) {
    return { state: 'absent', path: null, id: null, version: null, digest: null, resolutionFingerprint: null };
  }
  if (!path.isAbsolute(bundlePath)) {
    fail('PACK_INSTALL_BUNDLE_PATH_INVALID', 'Bundle path must be absolute.');
  }
  let inspection;
  try {
    inspection = inspectBundle({
      bundlePath,
      releasePaths: loaded.map((item) => item.planRelease.capsulePath),
      contractRoot: sourceRoot
    });
  } catch (error) {
    fail(error?.code || 'PACK_INSTALL_BUNDLE_INVALID', 'Bundle failed independent verification.');
  }
  if (inspection.resolution.state !== 'resolved') {
    fail('PACK_INSTALL_BUNDLE_BLOCKED', 'Bundle does not resolve against the exact local release set.');
  }
  const selected = inspection.references.map((reference) => ({
    pack: reference.selectedRelease.pack,
    version: reference.selectedRelease.version,
    capsuleDigest: reference.selectedRelease.capsuleDigest
  })).sort((a, b) => compareCodepoint(a.pack, b.pack));
  const supplied = loaded.map((item) => ({
    pack: item.installed.pack,
    version: item.installed.version,
    capsuleDigest: item.installed.capsuleDigest
  })).sort((a, b) => compareCodepoint(a.pack, b.pack));
  if (canonicalJson(selected) !== canonicalJson(supplied)) {
    fail('PACK_INSTALL_BUNDLE_RELEASE_SET_MISMATCH', 'Bundle selection and supplied release set differ.');
  }
  return {
    state: 'present',
    path: fs.realpathSync(path.resolve(bundlePath)),
    id: inspection.bundle.id,
    version: inspection.bundle.version,
    digest: inspection.bundle.digest,
    resolutionFingerprint: inspection.resolution.resolutionFingerprint
  };
}

function buildCandidate({ priorManifest, loaded, baseContract }) {
  const selectedIds = new Set(loaded.map((item) => item.installed.pack));
  const releases = new Map((priorManifest?.releases || []).map((release) => [release.pack, clone(release)]));
  for (const item of loaded) {
    const prior = releases.get(item.installed.pack);
    if (prior) {
      const ordering = compareVersions(item.installed.version, prior.version);
      if (ordering < 0) {
        fail('PACK_INSTALL_DOWNGRADE_UNSUPPORTED', 'Pack install version 1 does not permit downgrades.');
      }
      if (ordering === 0 && item.installed.capsuleDigest !== prior.capsuleDigest) {
        fail('PACK_INSTALL_RELEASE_IDENTITY_CONFLICT', 'The same installed pack version has different release bytes.');
      }
    }
    releases.set(item.installed.pack, clone(item.installed));
  }

  const outputs = new Map();
  for (const output of priorManifest?.outputs || []) {
    if (!selectedIds.has(output.pack)) outputs.set(output.path, clone(output));
  }
  for (const item of loaded) {
    for (const { managed } of item.outputs) {
      const existing = outputs.get(managed.path);
      if (existing && existing.pack !== managed.pack) {
        fail('PACK_INSTALL_CROSS_PACK_COLLISION', 'Two installed packs cannot own the same output path.');
      }
      outputs.set(managed.path, clone(managed));
    }
  }

  const candidate = {
    releases: [...releases.values()].sort((a, b) => compareCodepoint(a.pack, b.pack)),
    outputs: [...outputs.values()].sort((a, b) => compareCodepoint(a.path, b.path)),
    fingerprint: null
  };
  candidate.fingerprint = fingerprintJson({
    baseContract,
    releases: candidate.releases,
    outputs: candidate.outputs
  });
  return candidate;
}

function dependencyCheck(candidate, baseContract) {
  const releases = new Map(candidate.releases.map((release) => [release.pack, release]));
  const rows = [];
  for (const release of candidate.releases) {
    if (!satisfiesVersion(baseContract, release.compatibility.baseContract)) {
      fail('PACK_INSTALL_BASE_INCOMPATIBLE', 'An installed release does not support the selected base contract.');
    }
    for (const dependency of release.dependencies) {
      const selected = releases.get(dependency.pack);
      if (!selected) {
        if (!dependency.optional) {
          fail('PACK_INSTALL_DEPENDENCY_MISSING', 'A required pack dependency is absent from the candidate registry.');
        }
        rows.push({
          consumer: release.pack,
          dependency: dependency.pack,
          requiredRange: dependency.version,
          optional: true,
          selectedVersion: null,
          state: 'degraded',
          reasonCode: 'PACK_INSTALL_OPTIONAL_DEPENDENCY_ABSENT'
        });
        continue;
      }
      if (!satisfiesVersion(selected.version, dependency.version)) {
        fail('PACK_INSTALL_DEPENDENCY_VERSION_MISMATCH', 'An installed pack dependency version is incompatible.');
      }
      rows.push({
        consumer: release.pack,
        dependency: dependency.pack,
        requiredRange: dependency.version,
        optional: dependency.optional,
        selectedVersion: selected.version,
        state: 'satisfied',
        reasonCode: 'PACK_INSTALL_DEPENDENCY_SATISFIED'
      });
    }
  }
  rows.sort((a, b) => compareCodepoint(a.consumer, b.consumer)
    || compareCodepoint(a.dependency, b.dependency));
  const result = {
    state: 'passed',
    reasonCode: 'PACK_INSTALL_DEPENDENCIES_RESOLVED',
    rows,
    fingerprint: null
  };
  result.fingerprint = fingerprintJson({ baseContract, rows });
  return result;
}

function loadedOutputMap(loaded) {
  const map = new Map();
  for (const item of loaded) {
    for (const output of item.outputs) map.set(output.managed.path, output);
  }
  return map;
}

function planFileEffects({ targetRoot, priorManifest, loaded }) {
  const selectedIds = new Set(loaded.map((item) => item.installed.pack));
  const priorOutputs = new Map((priorManifest?.outputs || [])
    .filter((output) => selectedIds.has(output.pack))
    .map((output) => [output.path, output]));
  const nextOutputs = loadedOutputMap(loaded);
  const paths = [...new Set([...priorOutputs.keys(), ...nextOutputs.keys()])].sort(compareCodepoint);
  const effects = [];
  for (const relative of paths) {
    const priorOutput = priorOutputs.get(relative) || null;
    const nextOutput = nextOutputs.get(relative) || null;
    if (priorOutput && nextOutput && priorOutput.pack !== nextOutput.managed.pack) {
      fail('PACK_INSTALL_CROSS_PACK_COLLISION', 'Pack ownership cannot transfer during install or upgrade.');
    }
    let prior;
    if (priorOutput) {
      prior = readOutputSnapshot(targetRoot, relative);
      if (prior.state !== 'present' || prior.fingerprint !== priorOutput.fingerprint) {
        fail('PACK_INSTALL_MANAGED_DRIFT', 'A managed output changed while planning an upgrade.');
      }
    } else {
      const file = outputPath(targetRoot, relative);
      if (fs.existsSync(file)) {
        fail('PACK_INSTALL_UNMANAGED_COLLISION', 'An unmanaged target file collides with the release inventory.');
      }
      prior = absentSnapshot();
    }
    const candidate = nextOutput ? clone(nextOutput.snapshot) : absentSnapshot();
    if (snapshotEquals(prior, candidate)) continue;
    const action = prior.state === 'absent' ? 'create' : candidate.state === 'absent' ? 'remove' : 'replace';
    const output = nextOutput?.managed || priorOutput;
    const effect = {
      id: `pack-install-effect.${effects.length}`,
      sequence: effects.length,
      action,
      pack: output.pack,
      path: relative,
      role: output.role,
      prior,
      candidate,
      reasonCode: `PACK_INSTALL_FILE_${action.toUpperCase()}`,
      effectFingerprint: null
    };
    seal(effect, 'effectFingerprint');
    effects.push(effect);
  }
  if (!effects.length) {
    fail('PACK_INSTALL_NO_CHANGES', 'The selected releases are already installed exactly.');
  }
  return effects;
}

function planDirectoryEffects(targetRoot, fileEffects) {
  const missing = new Set();
  for (const effect of fileEffects) {
    if (effect.candidate.state !== 'present') continue;
    const parts = effect.path.split('/').slice(0, -1);
    let relative = '';
    for (const part of parts) {
      relative = relative ? `${relative}/${part}` : part;
      const directory = outputPath(targetRoot, relative);
      if (fs.existsSync(directory)) {
        const stat = fs.lstatSync(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          fail('PACK_INSTALL_DIRECTORY_INVALID', 'A candidate parent is not a regular directory.');
        }
      } else {
        missing.add(relative);
      }
    }
  }
  return [...missing]
    .sort((a, b) => a.split('/').length - b.split('/').length || compareCodepoint(a, b))
    .map((relative, sequence) => ({
      sequence,
      path: relative,
      fingerprint: fingerprintJson({ sequence, path: relative })
    }));
}

function releaseScope(release) {
  return {
    pack: release.pack,
    version: release.version,
    capsuleDigest: release.capsuleDigest,
    manifestFingerprint: release.manifestFingerprint
  };
}

function effectScope(effect) {
  return {
    id: effect.id,
    sequence: effect.sequence,
    action: effect.action,
    pack: effect.pack,
    path: effect.path,
    role: effect.role,
    beforeFingerprint: effect.prior.fingerprint,
    afterFingerprint: effect.candidate.fingerprint,
    effectFingerprint: effect.effectFingerprint
  };
}

export function preparePackInstall({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetRoot,
  capsulePaths,
  bundlePath = null,
  baseContract,
  planId,
  createdAt,
  validUntil
} = {}) {
  const source = fs.realpathSync(path.resolve(sourceRoot));
  const target = targetIdentity(targetRoot);
  requireWindow(createdAt, validUntil, 'Pack install plan');
  const runtime = runtimeFingerprint(source);
  if (!Array.isArray(capsulePaths) || !capsulePaths.length) {
    fail('PACK_INSTALL_RELEASE_SET_EMPTY', 'At least one exact local pack release is required.');
  }
  const loaded = capsulePaths.map((capsulePath) => loadVerifiedRelease({
    sourceRoot: source,
    targetRoot,
    capsulePath
  }));
  assertUniqueLoadedReleases(loaded);
  loaded.sort((a, b) => compareCodepoint(a.installed.pack, b.installed.pack));
  const prior = priorManifestState(source, targetRoot, target);
  if (prior.manifest && prior.manifest.baseContract !== baseContract) {
    fail('PACK_INSTALL_BASE_DRIFT', 'Installed registry base contract differs from the requested base.');
  }
  const bundle = assertBundleSelection({ sourceRoot: source, bundlePath, loaded });
  const candidate = buildCandidate({ priorManifest: prior.manifest, loaded, baseContract });
  const dependencies = dependencyCheck(candidate, baseContract);
  const fileEffects = planFileEffects({ targetRoot, priorManifest: prior.manifest, loaded });
  const directoryEffects = planDirectoryEffects(targetRoot, fileEffects);
  const releases = loaded.map((item) => item.planRelease);
  const scopeFingerprint = fingerprintJson({
    targetFingerprint: target.fingerprint,
    baseContract,
    runtimeFingerprint: runtime,
    releases: releases.map(releaseScope),
    bundle: {
      state: bundle.state,
      digest: bundle.digest,
      resolutionFingerprint: bundle.resolutionFingerprint
    },
    priorManifestFingerprint: prior.manifest?.manifestFingerprint || null,
    candidateFingerprint: candidate.fingerprint,
    dependencyFingerprint: dependencies.fingerprint,
    directoryEffects,
    fileEffects: fileEffects.map(effectScope)
  });
  const plan = {
    $contract: CONTRACTS.plan[0],
    contractVersion: '1.0.0',
    id: planId,
    createdAt,
    validUntil,
    target,
    baseContract,
    runtimeFingerprint: runtime,
    releases,
    bundle,
    priorManifest: prior.document,
    candidate,
    dependencyCheck: dependencies,
    directoryEffects,
    fileEffects,
    scopeFingerprint,
    limitations: [
      'Installation uses only exact already-local verified capsules and performs no network fetch.',
      'Local materialization does not configure packs, realize a host, run a package manager, or execute installation scripts.',
      'Unsigned and untrusted release, publisher, license, readiness, verification, and health boundaries remain unchanged.'
    ],
    planFingerprint: null
  };
  seal(plan, 'planFingerprint');
  assertFingerprint(source, plan, 'plan', 'planFingerprint', 'Pack install plan');
  if (hasPackInstallPlanState(targetRoot, plan.id)) {
    const existing = assertFingerprint(
      source,
      readPackInstallPlanState(targetRoot, plan.id).plan,
      'plan',
      'planFingerprint',
      'Pack install plan'
    );
    if (existing.planFingerprint !== plan.planFingerprint) {
      fail('PACK_INSTALL_PLAN_CONFLICT', 'Pack install plan identity already binds different exact work.');
    }
  } else {
    createPackInstallPlanState(targetRoot, plan);
  }
  return inspectPackInstall({ sourceRoot: source, targetRoot, planId: plan.id, at: createdAt });
}

function loadPlan(sourceRoot, targetRoot, planId) {
  if (!hasPackInstallPlanState(targetRoot, planId)) {
    fail('PACK_INSTALL_PLAN_MISSING', 'Pack install plan is unavailable.');
  }
  const plan = assertFingerprint(
    sourceRoot,
    readPackInstallPlanState(targetRoot, planId).plan,
    'plan',
    'planFingerprint',
    'Pack install plan'
  );
  assertTarget(targetRoot, plan.target);
  assertRuntime(sourceRoot, plan.runtimeFingerprint);
  return plan;
}

function assertPlanCapsules(sourceRoot, targetRoot, plan) {
  const loaded = plan.releases.map((release) => loadVerifiedRelease({
    sourceRoot,
    targetRoot,
    capsulePath: release.capsulePath
  })).sort((a, b) => compareCodepoint(a.installed.pack, b.installed.pack));
  const observedReleases = loaded.map((item) => item.planRelease);
  if (canonicalJson(observedReleases) !== canonicalJson(plan.releases)) {
    fail('PACK_INSTALL_RELEASE_DRIFT', 'The exact local release set changed after preview.');
  }
  const selectedIds = new Set(plan.releases.map((release) => release.pack));
  const expectedOutputs = plan.candidate.outputs.filter((output) => selectedIds.has(output.pack));
  const observedOutputs = loaded.flatMap((item) => item.outputs.map(({ managed }) => managed))
    .sort((a, b) => compareCodepoint(a.path, b.path));
  if (canonicalJson(observedOutputs) !== canonicalJson(expectedOutputs)) {
    fail('PACK_INSTALL_RELEASE_DRIFT', 'Release inventory no longer matches the candidate ownership plan.');
  }
  const snapshots = loadedOutputMap(loaded);
  for (const effect of plan.fileEffects) {
    if (effect.candidate.state === 'absent') continue;
    const observed = snapshots.get(effect.path)?.snapshot;
    if (!observed || canonicalJson(observed) !== canonicalJson(effect.candidate)) {
      fail('PACK_INSTALL_RELEASE_DRIFT', 'Release bytes no longer match an exact planned file effect.');
    }
  }
  return loaded;
}

function observedManifestDocument(targetRoot) {
  const file = packInstallManagedManifestStatePath(targetRoot);
  if (!fs.existsSync(file)) return { state: 'absent', bytes: null, fingerprint: null, document: null };
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) {
    fail('PACK_INSTALL_MANIFEST_INVALID', 'Managed pack install manifest is not one private regular file.');
  }
  const bytes = fs.readFileSync(file);
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('PACK_INSTALL_MANIFEST_MALFORMED', 'Managed pack install manifest cannot be parsed.');
  }
  return { state: 'present', bytes, fingerprint: sha256(bytes), document };
}

function assertPriorManifestCurrent(sourceRoot, targetRoot, plan, { verifyOutputs = true } = {}) {
  const observed = observedManifestDocument(targetRoot);
  if (plan.priorManifest.state === 'absent') {
    if (observed.state !== 'absent') {
      fail('PACK_INSTALL_MANIFEST_DRIFT', 'Managed pack install manifest appeared after preview.');
    }
    return null;
  }
  if (observed.state !== 'present' || observed.fingerprint !== plan.priorManifest.fingerprint) {
    fail('PACK_INSTALL_MANIFEST_DRIFT', 'Managed pack install manifest changed after preview.');
  }
  const manifest = assertManagedManifest(
    sourceRoot,
    targetRoot,
    plan.target,
    observed.document,
    { verifyOutputs }
  );
  return manifest;
}

function assertPlanOutputsAtPrior(targetRoot, plan) {
  for (const effect of plan.fileEffects) {
    const observed = readOutputSnapshot(targetRoot, effect.path);
    if (!snapshotEquals(observed, effect.prior)) {
      fail('PACK_INSTALL_OUTPUT_DRIFT', 'A planned output changed after preview.');
    }
  }
  for (const directory of plan.directoryEffects) {
    const absolute = outputPath(targetRoot, directory.path);
    if (fs.existsSync(absolute)) {
      fail('PACK_INSTALL_DIRECTORY_DRIFT', 'A planned checkpoint-owned directory appeared after preview.');
    }
  }
}

function assertPlanCurrent(sourceRoot, targetRoot, plan, at, { requirePriorOutputs = true } = {}) {
  assertTarget(targetRoot, plan.target);
  assertRuntime(sourceRoot, plan.runtimeFingerprint);
  requireNotExpired(plan.validUntil, at, 'PACK_INSTALL_PLAN_EXPIRED');
  assertPlanCapsules(sourceRoot, targetRoot, plan);
  assertPriorManifestCurrent(sourceRoot, targetRoot, plan, { verifyOutputs: requirePriorOutputs });
  if (requirePriorOutputs) assertPlanOutputsAtPrior(targetRoot, plan);
}

export function beginPackInstallRequest({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetRoot,
  planId,
  requestId,
  reason,
  createdAt,
  expiresAt
} = {}) {
  const source = fs.realpathSync(path.resolve(sourceRoot));
  const plan = loadPlan(source, targetRoot, planId);
  requireWindow(createdAt, expiresAt, 'Pack install request');
  if (parseInstant(expiresAt, 'Request expiry') > parseInstant(plan.validUntil, 'Plan expiry')) {
    fail('PACK_INSTALL_REQUEST_WINDOW_INVALID', 'Request expiry cannot outlive the exact install plan.');
  }
  assertPlanCurrent(source, targetRoot, plan, createdAt);
  const request = {
    $contract: CONTRACTS.request[0],
    contractVersion: '1.0.0',
    id: requestId,
    createdAt,
    expiresAt,
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    scopeFingerprint: plan.scopeFingerprint,
    reason,
    requestFingerprint: null
  };
  seal(request, 'requestFingerprint');
  assertFingerprint(source, request, 'request', 'requestFingerprint', 'Pack install request');
  if (hasPackInstallRequestState(targetRoot, request.id)) {
    const existing = assertFingerprint(
      source,
      readPackInstallRequestState(targetRoot, request.id).request,
      'request',
      'requestFingerprint',
      'Pack install request'
    );
    if (existing.requestFingerprint !== request.requestFingerprint) {
      fail('PACK_INSTALL_REQUEST_CONFLICT', 'Pack install request identity already binds another scope.');
    }
  } else {
    createPackInstallRequestState(targetRoot, request);
  }
  return inspectPackInstall({ sourceRoot: source, targetRoot, planId, requestId, at: createdAt });
}

function loadRequest(sourceRoot, targetRoot, requestId) {
  if (!hasPackInstallRequestState(targetRoot, requestId)) {
    fail('PACK_INSTALL_REQUEST_MISSING', 'Pack install request is unavailable.');
  }
  return assertFingerprint(
    sourceRoot,
    readPackInstallRequestState(targetRoot, requestId).request,
    'request',
    'requestFingerprint',
    'Pack install request'
  );
}

export function confirmPackInstallRequest({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetRoot,
  requestId,
  confirmationId,
  actor,
  reason,
  confirmedAt
} = {}) {
  const source = fs.realpathSync(path.resolve(sourceRoot));
  const request = loadRequest(source, targetRoot, requestId);
  const plan = loadPlan(source, targetRoot, request.plan.id);
  if (request.plan.fingerprint !== plan.planFingerprint
    || request.scopeFingerprint !== plan.scopeFingerprint) {
    fail('PACK_INSTALL_REQUEST_BINDING_INVALID', 'Pack install request no longer binds its exact plan.');
  }
  requireNotExpired(request.expiresAt, confirmedAt);
  assertPlanCurrent(source, targetRoot, plan, confirmedAt);
  const confirmation = {
    $contract: CONTRACTS.confirmation[0],
    contractVersion: '1.0.0',
    id: confirmationId,
    confirmedAt,
    request: { id: request.id, fingerprint: request.requestFingerprint },
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    scopeFingerprint: plan.scopeFingerprint,
    actor: { type: 'local-operator', id: actor },
    reason,
    confirmationFingerprint: null
  };
  seal(confirmation, 'confirmationFingerprint');
  assertFingerprint(source, confirmation, 'confirmation', 'confirmationFingerprint', 'Pack install confirmation');
  if (hasPackInstallConfirmationState(targetRoot, confirmation.id)) {
    const existing = assertFingerprint(
      source,
      readPackInstallConfirmationState(targetRoot, confirmation.id).confirmation,
      'confirmation',
      'confirmationFingerprint',
      'Pack install confirmation'
    );
    if (existing.confirmationFingerprint !== confirmation.confirmationFingerprint) {
      fail('PACK_INSTALL_CONFIRMATION_CONFLICT', 'Pack install confirmation identity already binds another decision.');
    }
  } else {
    createPackInstallConfirmationState(targetRoot, confirmation);
  }
  return inspectPackInstall({
    sourceRoot: source,
    targetRoot,
    planId: plan.id,
    requestId: request.id,
    confirmationId: confirmation.id,
    at: confirmedAt
  });
}

function loadConfirmation(sourceRoot, targetRoot, confirmationId) {
  if (!hasPackInstallConfirmationState(targetRoot, confirmationId)) {
    fail('PACK_INSTALL_CONFIRMATION_MISSING', 'Pack install confirmation is unavailable.');
  }
  return assertFingerprint(
    sourceRoot,
    readPackInstallConfirmationState(targetRoot, confirmationId).confirmation,
    'confirmation',
    'confirmationFingerprint',
    'Pack install confirmation'
  );
}

export function packInstallConsumptionId(confirmationId) {
  if (!confirmationId.startsWith('pack-install-confirmation.')) {
    fail('PACK_INSTALL_CONFIRMATION_MALFORMED', 'Pack install confirmation identity is invalid.');
  }
  return `pack-install-consumption.${confirmationId.slice('pack-install-confirmation.'.length)}`;
}

function sanitizeRelease(release) {
  return {
    pack: release.pack,
    version: release.version,
    layer: release.layer,
    capsuleDigest: release.capsuleDigest,
    manifestFingerprint: release.manifestFingerprint,
    releaseStage: release.releaseStage,
    evidenceMaturity: release.evidenceMaturity,
    legal: clone(release.legal),
    trust: clone(release.trust)
  };
}

function sanitizeBundle(bundle) {
  return {
    state: bundle.state,
    id: bundle.id,
    version: bundle.version,
    digest: bundle.digest,
    resolutionFingerprint: bundle.resolutionFingerprint
  };
}

function sanitizeEffect(effect) {
  return {
    id: effect.id,
    sequence: effect.sequence,
    action: effect.action,
    pack: effect.pack,
    role: effect.role,
    beforeFingerprint: effect.prior.fingerprint,
    afterFingerprint: effect.candidate.fingerprint,
    reasonCode: effect.reasonCode,
    effectFingerprint: effect.effectFingerprint
  };
}

function loadInspectionState(sourceRoot, targetRoot, {
  planId,
  requestId,
  confirmationId,
  consumptionId,
  checkpointId
}) {
  let plan = null;
  let request = null;
  let confirmation = null;
  let consumption = null;
  let checkpoint = null;

  if (checkpointId) {
    ({ plan, request, confirmation, consumption, checkpoint } = loadExecutionState(
      sourceRoot,
      targetRoot,
      checkpointId
    ));
  } else if (consumptionId) {
    consumption = loadConsumption(sourceRoot, targetRoot, consumptionId);
    confirmation = loadConfirmation(sourceRoot, targetRoot, consumption.confirmation.id);
    request = loadRequest(sourceRoot, targetRoot, consumption.request.id);
    plan = loadPlan(sourceRoot, targetRoot, consumption.plan.id);
  } else if (confirmationId) {
    confirmation = loadConfirmation(sourceRoot, targetRoot, confirmationId);
    request = loadRequest(sourceRoot, targetRoot, confirmation.request.id);
    plan = loadPlan(sourceRoot, targetRoot, confirmation.plan.id);
  } else if (requestId) {
    request = loadRequest(sourceRoot, targetRoot, requestId);
    plan = loadPlan(sourceRoot, targetRoot, request.plan.id);
  } else if (planId) {
    plan = loadPlan(sourceRoot, targetRoot, planId);
  }

  const expected = { planId, requestId, confirmationId, consumptionId, checkpointId };
  const observed = {
    planId: plan?.id || null,
    requestId: request?.id || null,
    confirmationId: confirmation?.id || null,
    consumptionId: consumption?.id || null,
    checkpointId: checkpoint?.id || null
  };
  for (const [key, value] of Object.entries(expected)) {
    if (value && value !== observed[key]) {
      fail('PACK_INSTALL_INSPECTION_BINDING_INVALID', 'Pack install inspection identifiers do not bind one transaction.');
    }
  }
  if (request && (request.plan.id !== plan.id || request.plan.fingerprint !== plan.planFingerprint)) {
    fail('PACK_INSTALL_REQUEST_BINDING_INVALID', 'Pack install request no longer binds its exact plan.');
  }
  if (confirmation && (confirmation.request.id !== request.id
    || confirmation.request.fingerprint !== request.requestFingerprint
    || confirmation.plan.id !== plan.id
    || confirmation.plan.fingerprint !== plan.planFingerprint
    || confirmation.scopeFingerprint !== plan.scopeFingerprint)) {
    fail('PACK_INSTALL_CONFIRMATION_BINDING_INVALID', 'Pack install confirmation no longer binds its exact request and plan.');
  }
  if (consumption && (consumption.confirmation.id !== confirmation.id
    || consumption.confirmation.fingerprint !== confirmation.confirmationFingerprint
    || consumption.request.id !== request.id
    || consumption.request.fingerprint !== request.requestFingerprint
    || consumption.plan.id !== plan.id
    || consumption.plan.fingerprint !== plan.planFingerprint)) {
    fail('PACK_INSTALL_CONSUMPTION_BINDING_INVALID', 'Pack install consumption no longer binds its exact authority chain.');
  }
  return { plan, request, confirmation, consumption, checkpoint };
}

function checkpointSteps(plan, checkpoint) {
  const directoryIds = plan.directoryEffects.map((effect) => `pack-install-directory.${effect.sequence}`);
  const fileIds = plan.fileEffects.map((effect) => effect.id);
  const all = [...directoryIds, ...fileIds, 'pack-install-manifest'];
  const completed = [
    ...checkpoint.directorySteps.map((step) => ['created', 'retained'].includes(step.state)),
    ...checkpoint.fileSteps.map((step) => step.state === 'verified'),
    checkpoint.manifest.state === 'verified'
  ];
  const completedPrefix = [];
  for (const [index, id] of all.entries()) {
    if (!completed[index]) break;
    completedPrefix.push(id);
  }
  const currentStep = Number.isInteger(checkpoint.currentStep) ? all[checkpoint.currentStep] || null : null;
  const pendingSteps = all.filter((id, index) => !completed[index] && id !== currentStep);
  return { currentStep, completedPrefix, pendingSteps };
}

function resumeDecision({ plan, request, confirmation, consumption, checkpoint }, at) {
  if (!plan) {
    return {
      classification: 'unavailable',
      reasonCode: 'PACK_INSTALL_STATE_UNAVAILABLE',
      reason: 'No exact local pack install plan is selected for inspection.',
      permittedNextAction: 'inspect-install'
    };
  }
  const planExpired = parseInstant(at, 'Inspection time') > parseInstant(plan.validUntil, 'Plan expiry');
  if (!request) {
    return planExpired ? {
      classification: 'unavailable',
      reasonCode: 'PACK_INSTALL_PLAN_EXPIRED',
      reason: 'The exact local pack install plan expired before a request was issued.',
      permittedNextAction: 'inspect-install'
    } : {
      classification: 'safe',
      reasonCode: 'PACK_INSTALL_REQUEST_AVAILABLE',
      reason: 'The current exact plan may be submitted for an expiring operator confirmation.',
      permittedNextAction: 'create-request'
    };
  }
  const requestExpired = parseInstant(at, 'Inspection time') > parseInstant(request.expiresAt, 'Request expiry');
  if (!confirmation) {
    return requestExpired || planExpired ? {
      classification: 'requires-review',
      reasonCode: 'PACK_INSTALL_REQUEST_EXPIRED',
      reason: 'The confirmation window expired and a new exact request must be reviewed.',
      permittedNextAction: 'renew-request'
    } : {
      classification: 'safe',
      reasonCode: 'PACK_INSTALL_CONFIRMATION_AVAILABLE',
      reason: 'The current request may be confirmed for this exact local install plan.',
      permittedNextAction: 'confirm-request'
    };
  }
  if (!consumption) {
    return requestExpired || planExpired ? {
      classification: 'requires-review',
      reasonCode: 'PACK_INSTALL_CONFIRMATION_EXPIRED',
      reason: 'The exact confirmation can no longer start work because its request or plan expired.',
      permittedNextAction: 'renew-request'
    } : {
      classification: 'safe',
      reasonCode: 'PACK_INSTALL_START_AVAILABLE',
      reason: 'The exact confirmation may be consumed once to create one durable install checkpoint.',
      permittedNextAction: 'start-install'
    };
  }
  if (!checkpoint) {
    return {
      classification: 'requires-review',
      reasonCode: 'PACK_INSTALL_CONSUMPTION_INCOMPLETE',
      reason: 'Single-use start authority was reserved without a durable checkpoint.',
      permittedNextAction: 'inspect-install'
    };
  }
  if (checkpoint.state === 'prepared') {
    return {
      classification: 'safe',
      reasonCode: 'PACK_INSTALL_CHECKPOINT_EXECUTABLE',
      reason: 'The durable checkpoint holds the consumed exact start and may execute once.',
      permittedNextAction: 'execute-checkpoint'
    };
  }
  if (['applying', 'committing', 'rolling-back', 'needs-attention'].includes(checkpoint.state)) {
    return {
      classification: 'requires-review',
      reasonCode: checkpoint.blocker.reasonCode || 'PACK_INSTALL_RECOVERY_REQUIRED',
      reason: 'The durable checkpoint must be inspected and recovered from its exact observed state.',
      permittedNextAction: 'recover-checkpoint'
    };
  }
  return {
    classification: 'unavailable',
    reasonCode: checkpoint.reasonCode,
    reason: 'This local pack install checkpoint is terminal and grants no further execution authority.',
    permittedNextAction: 'none'
  };
}

export function inspectPackInstall({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetRoot,
  planId = null,
  requestId = null,
  confirmationId = null,
  consumptionId = null,
  checkpointId = null,
  at = new Date().toISOString()
} = {}) {
  const source = fs.realpathSync(path.resolve(sourceRoot));
  const state = loadInspectionState(source, targetRoot, {
    planId,
    requestId,
    confirmationId,
    consumptionId,
    checkpointId
  });
  const plan = state.plan ? {
    id: state.plan.id,
    fingerprint: state.plan.planFingerprint,
    createdAt: state.plan.createdAt,
    validUntil: state.plan.validUntil,
    targetFingerprint: state.plan.target.fingerprint,
    baseContract: state.plan.baseContract,
    runtimeFingerprint: state.plan.runtimeFingerprint,
    releases: state.plan.releases.map(sanitizeRelease),
    bundle: sanitizeBundle(state.plan.bundle),
    dependencyCheck: clone(state.plan.dependencyCheck),
    effects: state.plan.fileEffects.map(sanitizeEffect),
    scopeFingerprint: state.plan.scopeFingerprint
  } : null;
  const request = state.request ? {
    id: state.request.id,
    fingerprint: state.request.requestFingerprint,
    createdAt: state.request.createdAt,
    expiresAt: state.request.expiresAt,
    reason: 'Review and confirm this exact local pack install plan.',
    state: parseInstant(at, 'Inspection time') > parseInstant(state.request.expiresAt, 'Request expiry')
      ? 'expired'
      : 'current'
  } : null;
  const confirmation = state.confirmation ? {
    id: state.confirmation.id,
    fingerprint: state.confirmation.confirmationFingerprint,
    confirmedAt: state.confirmation.confirmedAt,
    actor: state.confirmation.actor.id
  } : null;
  const consumption = state.consumption ? {
    id: state.consumption.id,
    fingerprint: state.consumption.consumptionFingerprint,
    state: state.consumption.state,
    checkpointId: state.consumption.checkpointId
  } : null;
  const checkpoint = state.checkpoint ? {
    id: state.checkpoint.id,
    fingerprint: state.checkpoint.checkpointFingerprint,
    state: state.checkpoint.state,
    reasonCode: state.checkpoint.reasonCode,
    ...checkpointSteps(state.plan, state.checkpoint),
    manifestState: state.checkpoint.manifest.state,
    blocker: state.checkpoint.blocker.reasonCode
  } : null;
  const inspection = {
    $contract: CONTRACTS.inspection[0],
    contractVersion: '1.0.0',
    kind: 'pack-install',
    plan,
    request,
    confirmation,
    consumption,
    checkpoint,
    resume: resumeDecision(state, at),
    claims: {
      localReleaseBytes: 'passed',
      dependencyConstraints: 'passed',
      localMaterialization: state.checkpoint?.claims.localMaterialization || 'unknown',
      installedRegistry: state.checkpoint?.claims.installedRegistry || 'unknown',
      configured: 'unknown',
      hostRealization: 'unknown',
      npmDependencies: 'not-evaluated',
      ready: 'unknown',
      verified: 'unknown',
      healthy: 'unknown',
      networkAvailability: 'unknown',
      publisherIdentity: 'not-evaluated',
      legalSufficiency: 'not-evaluated',
      trust: 'not-evaluated'
    },
    authority: {
      fetch: false,
      install: false,
      upgrade: false,
      uninstall: false,
      configure: false,
      realizeHost: false,
      runPackageManager: false,
      network: false,
      publish: false,
      trust: false
    },
    privacy: {
      targetRootIncluded: false,
      capsulePathsIncluded: false,
      capsuleBytesIncluded: false,
      priorBytesIncluded: false,
      candidateBytesIncluded: false,
      rawManagedManifestIncluded: false,
      privateStateIncluded: false,
      credentialValuesIncluded: false,
      rawProviderResponsesIncluded: false
    },
    limitations: [
      'This inspection reports deterministic local materialization only and carries no executable authority.',
      'Installation does not configure packs, realize a host, run package managers or installation scripts, or use a network.',
      'Publisher identity, legal sufficiency, trust, readiness, verification, health, and connected behavior remain unevaluated.'
    ],
    inspectionFingerprint: null
  };
  seal(inspection, 'inspectionFingerprint');
  return assertFingerprint(source, inspection, 'inspection', 'inspectionFingerprint', 'Pack install inspection');
}

function sealCheckpoint(sourceRoot, checkpoint) {
  seal(checkpoint, 'checkpointFingerprint');
  assertFingerprint(sourceRoot, checkpoint, 'checkpoint', 'checkpointFingerprint', 'Pack install checkpoint');
  return checkpoint;
}

function writeCheckpoint(sourceRoot, targetRoot, checkpoint, at) {
  checkpoint.updatedAt = at;
  sealCheckpoint(sourceRoot, checkpoint);
  writePackInstallCheckpointState(targetRoot, checkpoint);
  return checkpoint;
}

export function preparePackInstallExecution({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetRoot,
  confirmationId,
  checkpointId,
  at
} = {}) {
  const source = fs.realpathSync(path.resolve(sourceRoot));
  const confirmation = loadConfirmation(source, targetRoot, confirmationId);
  const request = loadRequest(source, targetRoot, confirmation.request.id);
  const plan = loadPlan(source, targetRoot, confirmation.plan.id);
  if (confirmation.request.fingerprint !== request.requestFingerprint
    || confirmation.plan.fingerprint !== plan.planFingerprint
    || confirmation.scopeFingerprint !== plan.scopeFingerprint
    || request.plan.fingerprint !== plan.planFingerprint
    || request.scopeFingerprint !== plan.scopeFingerprint) {
    fail('PACK_INSTALL_CONFIRMATION_BINDING_INVALID', 'Pack install confirmation no longer binds its exact request and plan.');
  }
  const consumptionId = packInstallConsumptionId(confirmation.id);
  const reservationFingerprint = fingerprintJson({
    confirmation: confirmation.confirmationFingerprint,
    request: request.requestFingerprint,
    plan: plan.planFingerprint,
    checkpointId,
    scopeFingerprint: plan.scopeFingerprint
  });
  let consumption;
  if (hasPackInstallConsumptionState(targetRoot, consumptionId)) {
    consumption = assertFingerprint(
      source,
      readPackInstallConsumptionState(targetRoot, consumptionId).consumption,
      'consumption',
      'consumptionFingerprint',
      'Pack install consumption'
    );
    if (consumption.reservationFingerprint !== reservationFingerprint
      || consumption.checkpointId !== checkpointId) {
      fail('PACK_INSTALL_CONFIRMATION_CONSUMED', 'Pack install confirmation was consumed for another checkpoint.');
    }
    if (hasPackInstallCheckpointState(targetRoot, checkpointId)) {
      const checkpoint = loadCheckpoint(source, targetRoot, checkpointId);
      if (checkpoint.consumption.id !== consumption.id
        || checkpoint.plan.id !== plan.id
        || checkpoint.scopeFingerprint !== plan.scopeFingerprint) {
        fail('PACK_INSTALL_CHECKPOINT_BINDING_INVALID', 'Pack install checkpoint does not bind the reserved exact start.');
      }
      if (consumption.state === 'reserved') {
        consumption.state = 'started';
        consumption.updatedAt = at;
        consumption.checkpointFingerprint = checkpoint.checkpointFingerprint;
        seal(consumption, 'consumptionFingerprint');
        assertFingerprint(source, consumption, 'consumption', 'consumptionFingerprint', 'Pack install consumption');
        writePackInstallConsumptionState(targetRoot, consumption);
      }
      return inspectPackInstall({
        sourceRoot: source,
        targetRoot,
        planId: plan.id,
        requestId: request.id,
        confirmationId: confirmation.id,
        consumptionId,
        checkpointId,
        at
      });
    }
    requireNotExpired(request.expiresAt, at);
    assertPlanCurrent(source, targetRoot, plan, at);
  }
  if (!consumption) {
    requireNotExpired(request.expiresAt, at);
    assertPlanCurrent(source, targetRoot, plan, at);
    consumption = {
      $contract: CONTRACTS.consumption[0],
      contractVersion: '1.0.0',
      id: consumptionId,
      createdAt: at,
      updatedAt: at,
      state: 'reserved',
      confirmation: { id: confirmation.id, fingerprint: confirmation.confirmationFingerprint },
      request: { id: request.id, fingerprint: request.requestFingerprint },
      plan: { id: plan.id, fingerprint: plan.planFingerprint },
      checkpointId,
      reservationFingerprint,
      checkpointFingerprint: null,
      consumptionFingerprint: null
    };
    seal(consumption, 'consumptionFingerprint');
    assertFingerprint(source, consumption, 'consumption', 'consumptionFingerprint', 'Pack install consumption');
    createPackInstallConsumptionState(targetRoot, consumption);
  }

  const checkpoint = sealCheckpoint(source, {
    $contract: CONTRACTS.checkpoint[0],
    contractVersion: '1.0.0',
    id: checkpointId,
    createdAt: at,
    updatedAt: at,
    state: 'prepared',
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    request: { id: request.id, fingerprint: request.requestFingerprint },
    confirmation: { id: confirmation.id, fingerprint: confirmation.confirmationFingerprint },
    consumption: { id: consumption.id, fingerprint: consumption.consumptionFingerprint },
    targetFingerprint: plan.target.fingerprint,
    scopeFingerprint: plan.scopeFingerprint,
    directorySteps: plan.directoryEffects.map((effect) => ({
      sequence: effect.sequence,
      path: effect.path,
      state: 'pending',
      fingerprint: effect.fingerprint
    })),
    fileSteps: plan.fileEffects.map((effect) => ({
      sequence: effect.sequence,
      effect: { id: effect.id, fingerprint: effect.effectFingerprint },
      state: 'pending',
      observedFingerprint: effect.prior.fingerprint
    })),
    currentStep: null,
    manifest: {
      state: 'pending',
      priorFingerprint: plan.priorManifest.fingerprint,
      candidateFingerprint: plan.candidate.fingerprint,
      observedFingerprint: plan.priorManifest.fingerprint
    },
    reasonCode: 'PACK_INSTALL_CHECKPOINT_PREPARED',
    blocker: { state: 'none', reasonCode: null },
    claims: {
      localMaterialization: 'unknown',
      installedRegistry: 'unknown',
      dependencyConstraints: 'passed'
    },
    checkpointFingerprint: null
  });
  createPackInstallCheckpointState(targetRoot, checkpoint);
  consumption.state = 'started';
  consumption.updatedAt = at;
  consumption.checkpointFingerprint = checkpoint.checkpointFingerprint;
  seal(consumption, 'consumptionFingerprint');
  assertFingerprint(source, consumption, 'consumption', 'consumptionFingerprint', 'Pack install consumption');
  writePackInstallConsumptionState(targetRoot, consumption);
  return inspectPackInstall({
    sourceRoot: source,
    targetRoot,
    planId: plan.id,
    requestId: request.id,
    confirmationId: confirmation.id,
    consumptionId,
    checkpointId,
    at
  });
}

function loadConsumption(sourceRoot, targetRoot, consumptionId) {
  if (!hasPackInstallConsumptionState(targetRoot, consumptionId)) {
    fail('PACK_INSTALL_CONSUMPTION_MISSING', 'Pack install consumption is unavailable.');
  }
  return assertFingerprint(
    sourceRoot,
    readPackInstallConsumptionState(targetRoot, consumptionId).consumption,
    'consumption',
    'consumptionFingerprint',
    'Pack install consumption'
  );
}

function loadCheckpoint(sourceRoot, targetRoot, checkpointId) {
  if (!hasPackInstallCheckpointState(targetRoot, checkpointId)) {
    fail('PACK_INSTALL_CHECKPOINT_MISSING', 'Pack install checkpoint is unavailable.');
  }
  return assertFingerprint(
    sourceRoot,
    readPackInstallCheckpointState(targetRoot, checkpointId).checkpoint,
    'checkpoint',
    'checkpointFingerprint',
    'Pack install checkpoint'
  );
}

function loadExecutionState(sourceRoot, targetRoot, checkpointId) {
  const checkpoint = loadCheckpoint(sourceRoot, targetRoot, checkpointId);
  const plan = loadPlan(sourceRoot, targetRoot, checkpoint.plan.id);
  const request = loadRequest(sourceRoot, targetRoot, checkpoint.request.id);
  const confirmation = loadConfirmation(sourceRoot, targetRoot, checkpoint.confirmation.id);
  const consumption = loadConsumption(sourceRoot, targetRoot, checkpoint.consumption.id);
  if (checkpoint.plan.fingerprint !== plan.planFingerprint
    || checkpoint.request.fingerprint !== request.requestFingerprint
    || checkpoint.confirmation.fingerprint !== confirmation.confirmationFingerprint
    || request.plan.id !== plan.id
    || request.plan.fingerprint !== plan.planFingerprint
    || confirmation.plan.id !== plan.id
    || confirmation.plan.fingerprint !== plan.planFingerprint
    || confirmation.request.id !== request.id
    || confirmation.request.fingerprint !== request.requestFingerprint
    || consumption.plan.id !== plan.id
    || consumption.plan.fingerprint !== plan.planFingerprint
    || consumption.request.id !== request.id
    || consumption.request.fingerprint !== request.requestFingerprint
    || consumption.confirmation.id !== confirmation.id
    || consumption.confirmation.fingerprint !== confirmation.confirmationFingerprint
    || consumption.checkpointId !== checkpoint.id
    || consumption.state !== 'started'
    || checkpoint.scopeFingerprint !== plan.scopeFingerprint
    || checkpoint.targetFingerprint !== plan.target.fingerprint) {
    fail('PACK_INSTALL_CHECKPOINT_BINDING_INVALID', 'Pack install checkpoint authority bindings are invalid.');
  }
  return { checkpoint, plan, request, confirmation, consumption };
}

function maybeFault(faultAfter, marker) {
  if (faultAfter === marker) {
    const error = new PackInstallError('PACK_INSTALL_FAULT_INJECTED', `Contained fault injected after ${marker}.`);
    error.injected = true;
    throw error;
  }
}

function fsyncDirectory(directory) {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // Filesystems without directory fsync still retain atomic same-directory rename behavior.
  }
}

function atomicWriteOutput(targetRoot, effect, expected) {
  const file = outputPath(targetRoot, effect.path, { allowMissingParents: false });
  const observed = readOutputSnapshot(targetRoot, effect.path);
  if (snapshotEquals(observed, effect.candidate)) return observed;
  if (!snapshotEquals(observed, expected)) {
    fail('PACK_INSTALL_OUTPUT_DRIFT', 'Managed output changed immediately before its file effect.');
  }
  if (effect.candidate.state === 'absent') {
    if (observed.state !== 'present') {
      fail('PACK_INSTALL_OUTPUT_DRIFT', 'Managed removal no longer has its exact prior file.');
    }
    fs.unlinkSync(file);
    fsyncDirectory(path.dirname(file));
    return readOutputSnapshot(targetRoot, effect.path);
  }
  const bytes = Buffer.from(effect.candidate.content, 'base64');
  if (bytes.toString('base64') !== effect.candidate.content
    || sha256(bytes) !== effect.candidate.contentFingerprint
    || fileFingerprint(effect.candidate.contentFingerprint, effect.candidate.mode) !== effect.candidate.fingerprint) {
    fail('PACK_INSTALL_PLAN_TAMPERED', 'Candidate bytes do not match the exact plan fingerprint.');
  }
  const temporary = `${file}.soter-pack-install-${process.pid}-${Date.now()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', Number.parseInt(effect.candidate.mode, 8));
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.chmodSync(temporary, Number.parseInt(effect.candidate.mode, 8));
    const immediatelyBefore = readOutputSnapshot(targetRoot, effect.path);
    if (!snapshotEquals(immediatelyBefore, expected)) {
      fail('PACK_INSTALL_OUTPUT_DRIFT', 'Managed output changed during atomic file preparation.');
    }
    fs.renameSync(temporary, file);
    fsyncDirectory(path.dirname(file));
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return readOutputSnapshot(targetRoot, effect.path);
}

function atomicWritePrivateBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.soter-pack-install-${process.pid}-${Date.now()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fsyncDirectory(path.dirname(file));
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function buildManagedManifest(sourceRoot, plan, checkpoint, at) {
  let priorCreatedAt = checkpoint.createdAt;
  if (plan.priorManifest.state === 'present') {
    try {
      priorCreatedAt = JSON.parse(Buffer.from(plan.priorManifest.content, 'base64').toString('utf8')).createdAt;
    } catch {
      fail('PACK_INSTALL_PLAN_TAMPERED', 'Private prior manifest bytes are malformed.');
    }
  }
  const manifest = {
    $contract: CONTRACTS.manifest[0],
    contractVersion: '1.0.0',
    targetFingerprint: plan.target.fingerprint,
    baseContract: plan.baseContract,
    createdAt: priorCreatedAt,
    updatedAt: at,
    releases: clone(plan.candidate.releases),
    outputs: clone(plan.candidate.outputs),
    lastSuccessfulCheckpoint: {
      id: checkpoint.id,
      scopeFingerprint: checkpoint.scopeFingerprint
    },
    manifestFingerprint: null
  };
  seal(manifest, 'manifestFingerprint');
  assertFingerprint(sourceRoot, manifest, 'manifest', 'manifestFingerprint', 'Managed pack install manifest');
  return manifest;
}

function candidateManifestMatches(sourceRoot, plan, checkpoint, manifest) {
  try {
    assertFingerprint(sourceRoot, manifest, 'manifest', 'manifestFingerprint', 'Managed pack install manifest');
  } catch {
    return false;
  }
  return manifest.targetFingerprint === plan.target.fingerprint
    && manifest.baseContract === plan.baseContract
    && canonicalJson(manifest.releases) === canonicalJson(plan.candidate.releases)
    && canonicalJson(manifest.outputs) === canonicalJson(plan.candidate.outputs)
    && manifest.lastSuccessfulCheckpoint.id === checkpoint.id
    && manifest.lastSuccessfulCheckpoint.scopeFingerprint === checkpoint.scopeFingerprint;
}

function classifyManifest(sourceRoot, targetRoot, plan, checkpoint) {
  const observed = observedManifestDocument(targetRoot);
  if (observed.state === 'absent') {
    return plan.priorManifest.state === 'absent' ? { state: 'prior', observed } : { state: 'unknown', observed };
  }
  if (plan.priorManifest.state === 'present' && observed.fingerprint === plan.priorManifest.fingerprint) {
    return { state: 'prior', observed };
  }
  if (candidateManifestMatches(sourceRoot, plan, checkpoint, observed.document)) {
    return { state: 'candidate', observed };
  }
  return { state: 'unknown', observed };
}

function prepareDirectoryStep(sourceRoot, targetRoot, checkpoint, step, globalIndex, at, faultAfter) {
  checkpoint.state = 'applying';
  checkpoint.currentStep = globalIndex;
  checkpoint.reasonCode = 'PACK_INSTALL_DIRECTORY_APPLYING';
  writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
  maybeFault(faultAfter, `directory:${step.sequence}:before-write`);
  const absolute = outputPath(targetRoot, step.path);
  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o7777) !== DIRECTORY_MODE) {
      fail('PACK_INSTALL_DIRECTORY_DRIFT', 'Checkpoint-owned directory has unexpected state.');
    }
  } else {
    fs.mkdirSync(absolute, { mode: DIRECTORY_MODE });
    fs.chmodSync(absolute, DIRECTORY_MODE);
    fsyncDirectory(path.dirname(absolute));
  }
  maybeFault(faultAfter, `directory:${step.sequence}:write`);
  step.state = 'created';
  checkpoint.reasonCode = 'PACK_INSTALL_DIRECTORY_CREATED';
  writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
}

function applyFileStep(sourceRoot, targetRoot, plan, checkpoint, step, effect, globalIndex, at, faultAfter) {
  assertPlanCurrent(sourceRoot, targetRoot, plan, at, { requirePriorOutputs: false });
  checkpoint.state = 'applying';
  checkpoint.currentStep = globalIndex;
  checkpoint.reasonCode = 'PACK_INSTALL_FILE_APPLYING';
  writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
  const observedBefore = readOutputSnapshot(targetRoot, effect.path);
  if (snapshotEquals(observedBefore, effect.candidate)) {
    step.state = 'verified';
    step.observedFingerprint = effect.candidate.fingerprint;
    checkpoint.reasonCode = 'PACK_INSTALL_FILE_VERIFIED';
    writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
    return;
  }
  if (!snapshotEquals(observedBefore, effect.prior)) {
    fail('PACK_INSTALL_OUTPUT_DRIFT', 'File effect does not observe either its exact prior or candidate state.');
  }
  maybeFault(faultAfter, `file:${step.sequence}:before-write`);
  const observedAfter = atomicWriteOutput(targetRoot, effect, effect.prior);
  maybeFault(faultAfter, `file:${step.sequence}:write`);
  step.state = 'applied';
  step.observedFingerprint = observedAfter.fingerprint;
  checkpoint.reasonCode = 'PACK_INSTALL_FILE_APPLIED';
  writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
  maybeFault(faultAfter, `file:${step.sequence}:checkpoint`);
  if (!snapshotEquals(observedAfter, effect.candidate)) {
    fail('PACK_INSTALL_FILE_VERIFY_FAILED', 'Applied file does not match the exact candidate bytes and mode.');
  }
  step.state = 'verified';
  checkpoint.reasonCode = 'PACK_INSTALL_FILE_VERIFIED';
  writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
}

function commitManifest(sourceRoot, targetRoot, plan, checkpoint, globalIndex, at, faultAfter) {
  assertPlanCurrent(sourceRoot, targetRoot, plan, at, { requirePriorOutputs: false });
  for (const [index, effect] of plan.fileEffects.entries()) {
    const observed = readOutputSnapshot(targetRoot, effect.path);
    if (!snapshotEquals(observed, effect.candidate) || checkpoint.fileSteps[index].state !== 'verified') {
      fail('PACK_INSTALL_FILE_VERIFY_FAILED', 'Manifest commit requires every exact file candidate to be verified.');
    }
  }
  checkpoint.state = 'committing';
  checkpoint.currentStep = globalIndex;
  checkpoint.reasonCode = 'PACK_INSTALL_MANIFEST_WRITING';
  writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
  const manifest = buildManagedManifest(sourceRoot, plan, checkpoint, at);
  maybeFault(faultAfter, 'manifest:before-write');
  writePackInstallManagedManifestState(targetRoot, manifest);
  maybeFault(faultAfter, 'manifest:write');
  const observed = observedManifestDocument(targetRoot);
  if (observed.state !== 'present'
    || !candidateManifestMatches(sourceRoot, plan, checkpoint, observed.document)) {
    fail('PACK_INSTALL_MANIFEST_VERIFY_FAILED', 'Managed install manifest did not verify after commit.');
  }
  checkpoint.manifest.state = 'verified';
  checkpoint.manifest.observedFingerprint = manifest.manifestFingerprint;
  checkpoint.state = 'completed';
  checkpoint.currentStep = null;
  checkpoint.reasonCode = 'PACK_INSTALL_COMPLETED';
  checkpoint.blocker = { state: 'none', reasonCode: null };
  checkpoint.claims.localMaterialization = 'passed';
  checkpoint.claims.installedRegistry = 'passed';
  writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
}

function hasCandidateFileState(targetRoot, plan) {
  return plan.fileEffects.some((effect) => {
    try {
      return snapshotEquals(readOutputSnapshot(targetRoot, effect.path), effect.candidate);
    } catch {
      return true;
    }
  });
}

function restorePriorManifest(sourceRoot, targetRoot, plan, checkpoint) {
  const classified = classifyManifest(sourceRoot, targetRoot, plan, checkpoint);
  if (classified.state === 'prior') return;
  if (classified.state !== 'candidate') {
    fail('PACK_INSTALL_MANIFEST_ROLLBACK_BLOCKED', 'Managed manifest is neither the exact prior nor candidate document.');
  }
  if (plan.priorManifest.state === 'absent') {
    removePackInstallManagedManifestState(targetRoot);
    return;
  }
  const bytes = Buffer.from(plan.priorManifest.content, 'base64');
  if (sha256(bytes) !== plan.priorManifest.fingerprint) {
    fail('PACK_INSTALL_PLAN_TAMPERED', 'Private prior manifest bytes changed before rollback.');
  }
  atomicWritePrivateBytes(packInstallManagedManifestStatePath(targetRoot), bytes);
}

function rollbackCheckpoint(sourceRoot, targetRoot, plan, checkpoint, at) {
  checkpoint.state = 'rolling-back';
  checkpoint.reasonCode = 'PACK_INSTALL_ROLLBACK_STARTED';
  checkpoint.currentStep = null;
  writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
  for (let index = plan.fileEffects.length - 1; index >= 0; index -= 1) {
    const effect = plan.fileEffects[index];
    const step = checkpoint.fileSteps[index];
    const observed = readOutputSnapshot(targetRoot, effect.path);
    if (snapshotEquals(observed, effect.prior)) {
      step.state = 'rolled-back';
      step.observedFingerprint = effect.prior.fingerprint;
      writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
      continue;
    }
    if (!snapshotEquals(observed, effect.candidate)) {
      fail('PACK_INSTALL_ROLLBACK_OUTPUT_DRIFT', 'Rollback found an output outside the exact prior and candidate states.');
    }
    const restored = atomicWriteOutput(targetRoot, { ...effect, candidate: effect.prior }, effect.candidate);
    if (!snapshotEquals(restored, effect.prior)) {
      fail('PACK_INSTALL_ROLLBACK_VERIFY_FAILED', 'Rollback did not restore the exact prior file state.');
    }
    step.state = 'rolled-back';
    step.observedFingerprint = effect.prior.fingerprint;
    writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
  }
  for (let index = checkpoint.directorySteps.length - 1; index >= 0; index -= 1) {
    const step = checkpoint.directorySteps[index];
    const absolute = outputPath(targetRoot, step.path);
    if (!fs.existsSync(absolute)) {
      step.state = 'removed';
      writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
      continue;
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('PACK_INSTALL_DIRECTORY_ROLLBACK_BLOCKED', 'Checkpoint-owned directory changed type during rollback.');
    }
    if (fs.readdirSync(absolute).length) {
      step.state = 'retained';
      writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
      fail('PACK_INSTALL_DIRECTORY_ROLLBACK_BLOCKED', 'Checkpoint-owned directory contains unowned content.');
    }
    fs.rmdirSync(absolute);
    fsyncDirectory(path.dirname(absolute));
    step.state = 'removed';
    writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
  }
  restorePriorManifest(sourceRoot, targetRoot, plan, checkpoint);
  const manifest = classifyManifest(sourceRoot, targetRoot, plan, checkpoint);
  if (manifest.state !== 'prior') {
    fail('PACK_INSTALL_MANIFEST_ROLLBACK_BLOCKED', 'Rollback did not restore the exact prior manifest state.');
  }
  checkpoint.manifest.state = 'rolled-back';
  checkpoint.manifest.observedFingerprint = plan.priorManifest.fingerprint;
  checkpoint.state = 'rolled-back';
  checkpoint.currentStep = null;
  checkpoint.reasonCode = 'PACK_INSTALL_ROLLED_BACK';
  checkpoint.claims.localMaterialization = 'failed';
  checkpoint.claims.installedRegistry = plan.priorManifest.state === 'present' ? 'passed' : 'unknown';
  writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
}

function markNeedsAttention(sourceRoot, targetRoot, checkpoint, code, at) {
  checkpoint.state = 'needs-attention';
  checkpoint.currentStep = null;
  checkpoint.reasonCode = code;
  checkpoint.blocker = { state: 'present', reasonCode: code };
  checkpoint.claims.localMaterialization = 'failed';
  checkpoint.claims.installedRegistry = 'failed';
  writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
}

function markFailed(sourceRoot, targetRoot, checkpoint, code, at) {
  checkpoint.state = 'failed';
  checkpoint.currentStep = null;
  checkpoint.reasonCode = code;
  checkpoint.blocker = { state: 'present', reasonCode: code };
  checkpoint.claims.localMaterialization = 'failed';
  checkpoint.claims.installedRegistry = 'unknown';
  writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
}

function executeCheckpoint(sourceRoot, targetRoot, plan, checkpoint, at, faultAfter) {
  const manifest = classifyManifest(sourceRoot, targetRoot, plan, checkpoint);
  if (manifest.state === 'candidate') {
    for (const effect of plan.fileEffects) {
      if (!snapshotEquals(readOutputSnapshot(targetRoot, effect.path), effect.candidate)) {
        fail('PACK_INSTALL_MANAGED_DRIFT', 'Candidate manifest exists but a managed output does not match it.');
      }
    }
    checkpoint.fileSteps.forEach((step, index) => {
      step.state = 'verified';
      step.observedFingerprint = plan.fileEffects[index].candidate.fingerprint;
    });
    checkpoint.manifest.state = 'verified';
    checkpoint.manifest.observedFingerprint = manifest.observed.document.manifestFingerprint;
    checkpoint.state = 'completed';
    checkpoint.currentStep = null;
    checkpoint.reasonCode = 'PACK_INSTALL_COMPLETED';
    checkpoint.blocker = { state: 'none', reasonCode: null };
    checkpoint.claims.localMaterialization = 'passed';
    checkpoint.claims.installedRegistry = 'passed';
    writeCheckpoint(sourceRoot, targetRoot, checkpoint, at);
    return;
  }
  if (manifest.state !== 'prior') {
    fail('PACK_INSTALL_MANIFEST_DRIFT', 'Managed install manifest is outside the exact prior and candidate states.');
  }
  for (const step of checkpoint.directorySteps) {
    if (step.state === 'removed') {
      fail('PACK_INSTALL_CHECKPOINT_STATE_INVALID', 'A rolled-back directory cannot resume forward execution.');
    }
    if (step.state !== 'created') {
      prepareDirectoryStep(sourceRoot, targetRoot, checkpoint, step, step.sequence, at, faultAfter);
    }
  }
  const offset = checkpoint.directorySteps.length;
  for (const [index, effect] of plan.fileEffects.entries()) {
    const step = checkpoint.fileSteps[index];
    if (step.state === 'rolled-back') {
      fail('PACK_INSTALL_CHECKPOINT_STATE_INVALID', 'A rolled-back file cannot resume forward execution.');
    }
    if (step.state !== 'verified') {
      applyFileStep(sourceRoot, targetRoot, plan, checkpoint, step, effect, offset + index, at, faultAfter);
    }
  }
  commitManifest(sourceRoot, targetRoot, plan, checkpoint, offset + plan.fileEffects.length, at, faultAfter);
}

export function executePackInstall({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetRoot,
  checkpointId,
  at,
  faultAfter = null
} = {}) {
  const source = fs.realpathSync(path.resolve(sourceRoot));
  const state = loadExecutionState(source, targetRoot, checkpointId);
  if (['completed', 'rolled-back', 'failed'].includes(state.checkpoint.state)) {
    return inspectPackInstall({
      sourceRoot: source,
      targetRoot,
      planId: state.plan.id,
      requestId: state.request.id,
      confirmationId: state.confirmation.id,
      consumptionId: state.consumption.id,
      checkpointId,
      at
    });
  }
  try {
    executeCheckpoint(source, targetRoot, state.plan, state.checkpoint, at, faultAfter);
  } catch (error) {
    if (error?.injected) throw error;
    const code = stableFailureCode(error, 'PACK_INSTALL_EXECUTION_FAILED');
    try {
      if (hasCandidateFileState(targetRoot, state.plan)
        || classifyManifest(source, targetRoot, state.plan, state.checkpoint).state === 'candidate') {
        rollbackCheckpoint(source, targetRoot, state.plan, state.checkpoint, at);
      } else {
        markFailed(source, targetRoot, state.checkpoint, code, at);
      }
    } catch (rollbackError) {
      const rollbackCode = stableFailureCode(rollbackError, 'PACK_INSTALL_ROLLBACK_FAILED');
      markNeedsAttention(source, targetRoot, state.checkpoint, rollbackCode, at);
    }
    throw new PackInstallError(code, 'Pack install execution stopped at a stable checkpoint.');
  }
  return inspectPackInstall({
    sourceRoot: source,
    targetRoot,
    planId: state.plan.id,
    requestId: state.request.id,
    confirmationId: state.confirmation.id,
    consumptionId: state.consumption.id,
    checkpointId,
    at
  });
}

export function recoverPackInstall({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetRoot,
  checkpointId,
  at,
  faultAfter = null
} = {}) {
  const source = fs.realpathSync(path.resolve(sourceRoot));
  const state = loadExecutionState(source, targetRoot, checkpointId);
  if (['completed', 'rolled-back', 'failed'].includes(state.checkpoint.state)) {
    return inspectPackInstall({
      sourceRoot: source,
      targetRoot,
      planId: state.plan.id,
      requestId: state.request.id,
      confirmationId: state.confirmation.id,
      consumptionId: state.consumption.id,
      checkpointId,
      at
    });
  }
  try {
    assertTarget(targetRoot, state.plan.target);
    assertRuntime(source, state.plan.runtimeFingerprint);
    const manifest = classifyManifest(source, targetRoot, state.plan, state.checkpoint);
    if (state.checkpoint.state === 'rolling-back' || state.checkpoint.state === 'needs-attention') {
      rollbackCheckpoint(source, targetRoot, state.plan, state.checkpoint, at);
    } else if (manifest.state === 'candidate') {
      executeCheckpoint(source, targetRoot, state.plan, state.checkpoint, at, faultAfter);
    } else if (manifest.state === 'prior') {
      try {
        requireNotExpired(state.plan.validUntil, at, 'PACK_INSTALL_PLAN_EXPIRED');
        assertPlanCapsules(source, targetRoot, state.plan);
        executeCheckpoint(source, targetRoot, state.plan, state.checkpoint, at, faultAfter);
      } catch (error) {
        if (error?.injected) throw error;
        rollbackCheckpoint(source, targetRoot, state.plan, state.checkpoint, at);
      }
    } else {
      fail('PACK_INSTALL_MANIFEST_DRIFT', 'Recovery found an unknown managed manifest state.');
    }
  } catch (error) {
    if (error?.injected) throw error;
    const code = stableFailureCode(error, 'PACK_INSTALL_RECOVERY_FAILED');
    markNeedsAttention(source, targetRoot, state.checkpoint, code, at);
    throw new PackInstallError(code, 'Pack install recovery requires operator attention.');
  }
  return inspectPackInstall({
    sourceRoot: source,
    targetRoot,
    planId: state.plan.id,
    requestId: state.request.id,
    confirmationId: state.confirmation.id,
    consumptionId: state.consumption.id,
    checkpointId,
    at
  });
}
