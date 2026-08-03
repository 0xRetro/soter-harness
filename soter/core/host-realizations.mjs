import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath,
  sha256
} from './lib/canonical-json.mjs';
import { renderHostProjectionCandidates } from './host-projections.mjs';
import {
  fingerprintLock,
  lockMatchesResolution,
  resolveConfiguration
} from './resolve.mjs';
import {
  privateConfigurationStatePath,
  readPrivateConfigurationState
} from './private-configurations.mjs';
import {
  activeConfigurationLockStatePath,
  createHostRealizationCheckpointState,
  createHostRealizationConfirmationState,
  createHostRealizationConsumptionState,
  createHostRealizationPlanState,
  createHostRealizationRequestState,
  hasActiveConfigurationLockState,
  hasHostManagedManifestState,
  hasHostRealizationCheckpointState,
  hasHostRealizationConfirmationState,
  hasHostRealizationConsumptionState,
  hasHostRealizationPlanState,
  hasHostRealizationRequestState,
  hostManagedManifestStatePath,
  listHostManagedManifestDocuments,
  readActiveConfigurationLockState,
  readHostManagedManifestState,
  readHostRealizationCheckpointState,
  readHostRealizationConfirmationState,
  readHostRealizationConsumptionState,
  readHostRealizationPlanState,
  readHostRealizationRequestState,
  removeHostManagedManifestState,
  writeHostManagedManifestState,
  writeHostRealizationCheckpointState,
  writeHostRealizationConsumptionState
} from './runtime-state.mjs';

const CONTRACTS = {
  plan: ['soter://contracts/host-realization-plan/v1', 'soter/contracts/host-realization-plan.schema.json'],
  request: ['soter://contracts/host-realization-request/v1', 'soter/contracts/host-realization-request.schema.json'],
  confirmation: ['soter://contracts/host-realization-confirmation/v1', 'soter/contracts/host-realization-confirmation.schema.json'],
  consumption: ['soter://contracts/host-realization-consumption/v1', 'soter/contracts/host-realization-consumption.schema.json'],
  checkpoint: ['soter://contracts/host-realization-checkpoint/v1', 'soter/contracts/host-realization-checkpoint.schema.json'],
  manifest: ['soter://contracts/host-managed-manifest/v1', 'soter/contracts/host-managed-manifest.schema.json'],
  inspection: ['soter://contracts/host-realization-inspection/v1', 'soter/contracts/host-realization-inspection.schema.json']
};

const FILE_MODE = '0644';
const DIRECTORY_MODE = 0o755;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function stableFailureCode(error, fallback) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^HOST_REALIZATION_[A-Z0-9_]+$/.test(code) ? code : fallback;
}

function compareText(left, right) {
  return left.localeCompare(right, 'en');
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

function validate(root, value, kind, label) {
  const [contract, schemaPath] = CONTRACTS[kind];
  if (value?.$contract !== contract) {
    fail('HOST_REALIZATION_' + kind.toUpperCase() + '_MALFORMED', label + ' contract is invalid.');
  }
  const schema = readJson(resolveRepoPath(root, schemaPath));
  if (validateJsonSchema(value, schema).length) {
    fail('HOST_REALIZATION_' + kind.toUpperCase() + '_MALFORMED', label + ' does not satisfy its contract.');
  }
  return value;
}

function assertFingerprint(root, value, kind, property, label) {
  validate(root, value, kind, label);
  const unsigned = { ...value };
  delete unsigned[property];
  if (value[property] !== fingerprintJson(unsigned)) {
    fail('HOST_REALIZATION_' + kind.toUpperCase() + '_TAMPERED', label + ' fingerprint is invalid.');
  }
  return value;
}

function at(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('HOST_REALIZATION_TIME_INVALID', label + ' is not an ISO timestamp.');
  return parsed;
}

function requireWindow(createdAt, expiresAt, label) {
  if (at(expiresAt, label + ' expiry') <= at(createdAt, label + ' creation')) {
    fail('HOST_REALIZATION_TIME_INVALID', label + ' expiry must follow creation.');
  }
}

function requireNotExpired(expiresAt, currentAt, code = 'HOST_REALIZATION_REQUEST_EXPIRED') {
  if (at(currentAt, 'Current time') > at(expiresAt, 'Expiry')) {
    fail(code, 'Host realization authority has expired.');
  }
}

function modeString(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, '0');
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function fileFingerprint(contentFingerprint, mode) {
  return fingerprintJson({ contentFingerprint, mode });
}

function targetIdentity(root) {
  const requestedPath = path.resolve(root);
  if (!fs.existsSync(requestedPath) || !fs.statSync(requestedPath).isDirectory()) {
    fail('HOST_REALIZATION_TARGET_INVALID', 'Consumer root is unavailable or not a directory.');
  }
  if (fs.lstatSync(requestedPath).isSymbolicLink()) {
    fail('HOST_REALIZATION_TARGET_SYMLINK_REJECTED', 'Consumer root cannot be a symbolic link.');
  }
  const realPath = fs.realpathSync(requestedPath);
  if (realPath !== requestedPath) {
    fail('HOST_REALIZATION_TARGET_SYMLINK_REJECTED', 'Consumer root path contains a symbolic-link traversal.');
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

function assertTarget(root, expected) {
  const observed = targetIdentity(root);
  if (observed.fingerprint !== expected.fingerprint
    || observed.realPath !== expected.realPath
    || observed.device !== expected.device
    || observed.inode !== expected.inode) {
    fail('HOST_REALIZATION_TARGET_DRIFT', 'Consumer root identity changed after preview.');
  }
  return observed;
}

function normalizedRelative(value) {
  if (typeof value !== 'string' || !value.length || value.includes('\\')
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value === '.' || value === '..' || value.startsWith('../') || value.includes('/../')) {
    fail('HOST_REALIZATION_PATH_INVALID', 'Managed output path is not normalized and relative.');
  }
  return value;
}

function outputPath(root, relative, { allowMissingParents = true } = {}) {
  const normalized = normalizedRelative(relative);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, normalized);
  if (!target.startsWith(resolvedRoot + path.sep)) {
    fail('HOST_REALIZATION_PATH_ESCAPE', 'Managed output path escapes the consumer root.');
  }
  const parts = normalized.split('/');
  let cursor = resolvedRoot;
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    const stat = lstatIfPresent(cursor);
    if (!stat) {
      if (index === parts.length - 1) break;
      if (allowMissingParents) break;
      fail('HOST_REALIZATION_PATH_DRIFT', 'Managed output parent is missing.');
    }
    if (stat.isSymbolicLink()) {
      fail('HOST_REALIZATION_SYMLINK_REJECTED', 'Managed output path traverses a symbolic link.');
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      fail('HOST_REALIZATION_PATH_DRIFT', 'Managed output parent is not an ordinary directory.');
    }
  }
  return target;
}

function absentSnapshot() {
  return {
    state: 'absent',
    content: null,
    mode: null,
    contentFingerprint: null,
    fingerprint: null
  };
}

function presentSnapshot(root, relative) {
  const file = outputPath(root, relative);
  const stat = lstatIfPresent(file);
  if (!stat) return absentSnapshot();
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail('HOST_REALIZATION_OUTPUT_INVALID', 'Managed output is not a regular non-symlink file.');
  }
  const mode = modeString(stat);
  if (mode !== FILE_MODE) {
    fail('HOST_REALIZATION_OUTPUT_MODE_DRIFT', 'Managed output mode does not match the deterministic file mode.');
  }
  const content = fs.readFileSync(file, 'utf8');
  const contentFingerprint = sha256(Buffer.from(content, 'utf8'));
  return {
    state: 'present',
    content,
    mode,
    contentFingerprint,
    fingerprint: fileFingerprint(contentFingerprint, mode)
  };
}

function candidateSnapshot(output) {
  return {
    state: 'present',
    content: output.content,
    mode: output.mode,
    contentFingerprint: output.contentFingerprint,
    fingerprint: output.fingerprint
  };
}

function snapshotEquals(left, right) {
  return left.state === right.state && left.fingerprint === right.fingerprint;
}

function adapterForLock(root, lock) {
  const file = resolveRepoPath(root, 'soter/hosts/' + lock.host.id + '/adapter.json');
  if (!fs.existsSync(file)) fail('HOST_REALIZATION_HOST_INVALID', 'Selected host adapter is unavailable.');
  const adapter = readJson(file);
  if (adapter.id !== lock.host.adapter || adapter.host !== lock.host.id
    || fingerprintJson(adapter) !== lock.host.manifestFingerprint) {
    fail('HOST_REALIZATION_HOST_DRIFT', 'Selected host adapter no longer matches the active lock.');
  }
  return adapter;
}

function activeLock(root, configurationName) {
  if (!hasActiveConfigurationLockState(root, configurationName)) {
    fail('HOST_REALIZATION_ACTIVE_LOCK_MISSING', 'Exact active configuration lock is required before host realization.');
  }
  const lock = readActiveConfigurationLockState(root, configurationName).lock;
  const expectedConfigurationPath = repoRelativePath(
    root,
    privateConfigurationStatePath(root, configurationName)
  );
  if (lock.configuration.path !== expectedConfigurationPath) {
    fail(
      'HOST_REALIZATION_ACTIVE_LOCK_STALE',
      'Host realization requires an exact active private desired configuration; tracked templates are not active state.'
    );
  }
  const applicability = lockMatchesResolution({
    root,
    lock,
    configPath: lock.configuration.path,
    host: lock.host.id
  });
  if (!applicability.matches || lock.configuration.name !== configurationName) {
    fail('HOST_REALIZATION_ACTIVE_LOCK_STALE', 'Active configuration lock is stale or names another configuration.');
  }
  return lock;
}

function renderedForLock(root, lock) {
  const adapter = adapterForLock(root, lock);
  const rendered = renderHostProjectionCandidates({
    root,
    adapter,
    configurationId: lock.configuration.name,
    packIds: lock.packs.map((pack) => pack.id),
    capabilityIds: lock.capabilities.map((capability) => capability.id),
    effectPolicies: lock.effectPolicies,
    currentLock: lock
  });
  const projected = rendered.outputs.map((output) => ({
    id: output.id,
    path: output.path,
    role: output.role,
    mode: output.mode,
    templatePath: output.templatePath,
    templateFingerprint: output.templateFingerprint,
    contentFingerprint: output.contentFingerprint,
    fingerprint: output.fingerprint
  }));
  if (fingerprintJson(projected) !== fingerprintJson(lock.projections)
    || rendered.definition.id !== lock.host.projectionDefinition.id
    || rendered.definition.version !== lock.host.projectionDefinition.version
    || rendered.definition.fingerprint !== lock.host.projectionDefinition.fingerprint
    || rendered.generator.id !== lock.host.projectionGenerator.id
    || rendered.generator.version !== lock.host.projectionGenerator.version) {
    fail('HOST_REALIZATION_CANDIDATE_DRIFT', 'Deterministic host candidates no longer match the active lock.');
  }
  return rendered;
}

function manifestFingerprint(manifest) {
  const unsigned = { ...manifest };
  delete unsigned.manifestFingerprint;
  return fingerprintJson(unsigned);
}

function assertManifest(root, manifest) {
  validate(root, manifest, 'manifest', 'Managed host manifest');
  if (manifest.manifestFingerprint !== manifestFingerprint(manifest)) {
    fail('HOST_REALIZATION_MANIFEST_TAMPERED', 'Managed host manifest fingerprint is invalid.');
  }
  const ids = new Set();
  const paths = new Set();
  for (const output of manifest.outputs) {
    normalizedRelative(output.path);
    if (ids.has(output.id) || paths.has(output.path)) {
      fail('HOST_REALIZATION_MANIFEST_INVALID', 'Managed host manifest contains duplicate output ownership.');
    }
    if (fileFingerprint(output.contentFingerprint, output.mode) !== output.fingerprint) {
      fail('HOST_REALIZATION_MANIFEST_TAMPERED', 'Managed host manifest output fingerprint is invalid.');
    }
    ids.add(output.id);
    paths.add(output.path);
  }
  return manifest;
}

function manifests(root, target) {
  let documents;
  try {
    documents = listHostManagedManifestDocuments(root);
  } catch {
    fail('HOST_REALIZATION_MANIFEST_MALFORMED', 'A managed host manifest cannot be read.');
  }
  const rows = documents.map(({ file, manifest }) => ({ file, manifest: assertManifest(root, manifest) }));
  const globalPaths = new Map();
  for (const row of rows) {
    if (row.manifest.targetFingerprint !== target.fingerprint) {
      fail('HOST_REALIZATION_MANIFEST_TARGET_DRIFT', 'Managed host manifest belongs to another consumer root identity.');
    }
    for (const output of row.manifest.outputs) {
      if (globalPaths.has(output.path)) {
        fail('HOST_REALIZATION_CROSS_HOST_COLLISION', 'Two host manifests claim the same managed output path.');
      }
      globalPaths.set(output.path, row.manifest.host);
    }
  }
  return rows;
}

function manifestSnapshot(root, hostId) {
  const file = hostManagedManifestStatePath(root, hostId);
  const relative = repoRelativePath(root, file);
  if (!fs.existsSync(file)) return { path: relative, state: 'absent', fingerprint: null, document: null };
  const manifest = assertManifest(root, readJson(file));
  return {
    path: relative,
    state: 'present',
    fingerprint: manifest.manifestFingerprint,
    document: manifest
  };
}

function manifestMetadata({ target, lock, rendered }) {
  return {
    host: lock.host.id,
    targetFingerprint: target.fingerprint,
    configuration: {
      name: lock.configuration.name,
      lockFingerprint: fingerprintLock(lock),
      graphFingerprint: lock.graphFingerprint
    },
    definition: {
      id: rendered.definition.id,
      version: rendered.definition.version,
      fingerprint: rendered.definition.fingerprint
    },
    generator: {
      id: rendered.generator.id,
      version: rendered.generator.version,
      fingerprint: fingerprintJson(rendered.generator)
    },
    outputs: rendered.outputs.map((output) => ({
      id: output.id,
      path: output.path,
      role: output.role,
      mode: output.mode,
      contentFingerprint: output.contentFingerprint,
      fingerprint: output.fingerprint
    })).sort((left, right) => compareText(left.path, right.path))
  };
}

function priorManifestMetadata(manifest) {
  if (!manifest) return null;
  return {
    host: manifest.host,
    targetFingerprint: manifest.targetFingerprint,
    configuration: manifest.configuration,
    definition: manifest.definition,
    generator: manifest.generator,
    outputs: manifest.outputs
  };
}

function projectionCollectionFiles(root, relativePrefix, code) {
  const directory = outputPath(root, relativePrefix);
  const rootStat = lstatIfPresent(directory);
  if (!rootStat) return [];
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(code, 'Host projection collection path is unsafe.');
  }
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current).sort(compareText)) {
      const child = path.join(current, entry);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()
        || (!stat.isFile() && !stat.isDirectory())) {
        fail(code, 'Host projection collection contains an unsafe entry.');
      }
      if (stat.isDirectory()) visit(child);
      else files.push(repoRelativePath(root, child));
    }
  };
  visit(directory);
  return files.sort(compareText);
}

function unmanagedProjectionFootprintPresent(root, adapter) {
  let present = false;
  for (const projection of adapter.projections) {
    const file = outputPath(root, projection.path);
    if (lstatIfPresent(file)) present = true;
  }
  for (const collection of adapter.projectionCollections) {
    const prefix = collection.pathPrefix.replace(/\/+$/, '');
    if (projectionCollectionFiles(
      root,
      prefix,
      'HOST_REALIZATION_UNMANAGED_COLLISION'
    ).length) present = true;
  }
  return present;
}

function assertManagedProjectionCollectionInventory(root, adapter, manifest) {
  for (const collection of adapter.projectionCollections) {
    const prefix = collection.pathPrefix.replace(/\/+$/, '');
    const expected = manifest.outputs
      .map((output) => output.path)
      .filter((outputPathValue) => outputPathValue.startsWith(prefix + '/'))
      .sort(compareText);
    const observed = projectionCollectionFiles(
      root,
      prefix,
      'HOST_REALIZATION_MANAGED_DRIFT'
    );
    if (fingerprintJson(observed) !== fingerprintJson(expected)) {
      fail(
        'HOST_REALIZATION_MANAGED_DRIFT',
        'Managed host projection collection inventory does not match its exact manifest.'
      );
    }
  }
}

function assertManagedProjectionCandidateCurrent({
  resolvedRoot,
  host,
  configurationPath,
  manifest,
  target
}) {
  const lock = resolveConfiguration({
    root: resolvedRoot,
    configPath: configurationPath,
    host
  });
  if (fingerprintLock(lock) !== manifest.configuration.lockFingerprint
    || lock.graphFingerprint !== manifest.configuration.graphFingerprint) {
    fail(
      'HOST_REALIZATION_ACTIVE_LOCK_STALE',
      'Managed host manifest no longer matches its exact private configuration lock.'
    );
  }
  const rendered = renderedForLock(resolvedRoot, lock);
  if (fingerprintJson(manifestMetadata({ target, lock, rendered }))
    !== fingerprintJson(priorManifestMetadata(manifest))) {
    fail(
      'HOST_REALIZATION_CANDIDATE_DRIFT',
      'Managed host manifest no longer matches deterministic projection candidates.'
    );
  }
  return lock;
}

function inspectCurrentManagedHostProjection({ root, host, verifyCandidate = true }) {
  const resolvedRoot = path.resolve(root);
  const adapterFile = resolveRepoPath(
    resolvedRoot,
    'soter/hosts/' + host + '/adapter.json'
  );
  const adapter = readJson(adapterFile);
  if (adapter.$contract !== 'soter://contracts/host-adapter/v2'
    || adapter.host !== host) {
    fail('HOST_REALIZATION_HOST_INVALID', 'Host adapter does not match the runtime host.');
  }

  const manifestFile = hostManagedManifestStatePath(resolvedRoot, host);
  if (!lstatIfPresent(manifestFile)) {
    if (unmanagedProjectionFootprintPresent(resolvedRoot, adapter)) {
      fail(
        'HOST_REALIZATION_UNMANAGED_COLLISION',
        'Host projection outputs exist without an exact managed manifest.'
      );
    }
    return Object.freeze({ state: 'not-realized' });
  }

  const manifest = assertManifest(
    resolvedRoot,
    readHostManagedManifestState(resolvedRoot, host).manifest
  );
  const target = targetIdentity(resolvedRoot);
  if (manifest.host !== host || manifest.targetFingerprint !== target.fingerprint) {
    fail(
      'HOST_REALIZATION_MANIFEST_TARGET_DRIFT',
      'Managed host manifest does not match the exact runtime host and consumer root.'
    );
  }

  const configurationPath = privateConfigurationStatePath(
    resolvedRoot,
    manifest.configuration.name
  );
  const configurationFingerprint = fingerprintJson(
    readPrivateConfigurationState(
      resolvedRoot,
      manifest.configuration.name
    ).configuration
  );

  let invalidOutput = false;
  const outputs = [];
  for (const output of manifest.outputs) {
    try {
      const observed = presentSnapshot(resolvedRoot, output.path);
      if (observed.state !== 'present'
        || observed.mode !== FILE_MODE
        || observed.contentFingerprint !== output.contentFingerprint
        || observed.fingerprint !== output.fingerprint) {
        invalidOutput = true;
        continue;
      }
      outputs.push({
        id: output.id,
        role: output.role,
        mode: observed.mode,
        contentFingerprint: observed.contentFingerprint,
        fingerprint: observed.fingerprint
      });
    } catch {
      invalidOutput = true;
    }
  }
  if (invalidOutput || outputs.length !== manifest.outputs.length) {
    fail(
      'HOST_REALIZATION_MANAGED_DRIFT',
      'One or more exact managed host outputs are missing, unsafe, or drifted.'
    );
  }
  assertManagedProjectionCollectionInventory(resolvedRoot, adapter, manifest);
  outputs.sort((left, right) => compareText(left.id, right.id));

  const lock = verifyCandidate
    ? assertManagedProjectionCandidateCurrent({
      resolvedRoot,
      host,
      configurationPath,
      manifest,
      target
    })
    : null;

  return Object.freeze({
    state: 'realized',
    manifest,
    configurationFingerprint,
    configurationPath,
    target,
    lock,
    outputs
  });
}

/**
 * Return exact private output ownership only after the current private
 * configuration, lock, deterministic render, manifest, and output bytes/modes
 * all agree. This is a Kernel/Core enforcement seam, not an inspection
 * projection and not execution authority.
 */
export function inspectManagedHostProjectionOwnership({ root, host }) {
  const exact = inspectCurrentManagedHostProjection({ root, host });
  if (exact.state === 'not-realized') {
    return Object.freeze({ state: 'not-realized', outputPaths: Object.freeze([]) });
  }
  return Object.freeze({
    state: 'realized',
    manifestFingerprint: exact.manifest.manifestFingerprint,
    outputPaths: Object.freeze(exact.manifest.outputs
      .map((output) => output.path)
      .sort(compareText))
  });
}

/**
 * Revalidate the immutable managed-host basis used by an already-issued
 * request after an exact governed source target may have changed. This keeps
 * root identity, private configuration bytes, manifest integrity, output
 * bytes/modes/inventory, and global ownership collision checks exact while
 * deliberately skipping only the current graph re-render.
 */
export function inspectHistoricalManagedHostProjectionBasis({
  root,
  host,
  manifestFingerprint: expectedManifestFingerprint,
  configurationFingerprint: expectedConfigurationFingerprint
}) {
  const resolvedRoot = path.resolve(root);
  const exact = inspectCurrentManagedHostProjection({
    root: resolvedRoot,
    host,
    verifyCandidate: false
  });
  if (exact.state !== 'realized'
    || exact.manifest.manifestFingerprint !== expectedManifestFingerprint
    || exact.configurationFingerprint !== expectedConfigurationFingerprint) {
    fail(
      'HOST_REALIZATION_HISTORICAL_BASIS_STALE',
      'Historical managed host projection basis no longer matches its exact request.'
    );
  }
  const rows = manifests(resolvedRoot, exact.target);
  const selected = rows.filter((row) => row.manifest.host === host);
  if (selected.length !== 1
    || selected[0].manifest.manifestFingerprint !== expectedManifestFingerprint) {
    fail(
      'HOST_REALIZATION_HISTORICAL_BASIS_STALE',
      'Historical managed host ownership is missing, duplicated, or colliding.'
    );
  }
  return Object.freeze({
    state: 'realized',
    manifestFingerprint: exact.manifest.manifestFingerprint,
    configurationFingerprint: exact.configurationFingerprint,
    targetFingerprint: exact.target.fingerprint,
    outputsFingerprint: fingerprintJson(exact.outputs),
    ownedPathsFingerprint: fingerprintJson(
      exact.manifest.outputs.map((output) => output.path).sort(compareText)
    )
  });
}

/**
 * Inspect the private, exact host-realization boundary for runtime startup.
 *
 * The returned facts are internal fingerprint material only. They are never
 * projected to workspace inspection: the managed manifest, consumer-root
 * identity, private configuration, and output paths remain private.
 */
export function inspectManagedHostRuntimeProjection({
  root,
  host,
  governedSourceFingerprint,
  expected = null
}) {
  if (typeof governedSourceFingerprint !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(governedSourceFingerprint)) {
    fail(
      'HOST_REALIZATION_RUNTIME_BASIS_INVALID',
      'Exact governed runtime source fingerprint is required.'
    );
  }
  const exact = inspectCurrentManagedHostProjection({
    root,
    host,
    verifyCandidate: false
  });
  if (exact.state === 'not-realized') {
    return Object.freeze({ state: 'not-realized', fingerprint: null });
  }
  const { manifest, configurationFingerprint, outputs } = exact;

  // Reusing the startup fingerprint is safe only after the complete exact
  // projection basis above has been independently revalidated.
  if (expected
    && expected.governedSourceFingerprint === governedSourceFingerprint
    && expected.manifestFingerprint === manifest.manifestFingerprint
    && expected.configurationFingerprint === configurationFingerprint
    && typeof expected.fingerprint === 'string') {
    return Object.freeze({
      state: 'realized',
      fingerprint: expected.fingerprint,
      basis: expected
    });
  }

  const currentLock = assertManagedProjectionCandidateCurrent({
    resolvedRoot: path.resolve(root),
    host,
    configurationPath: exact.configurationPath,
    manifest,
    target: exact.target
  });

  const projectionFingerprint = fingerprintJson({
    contract: 'soter-managed-host-runtime-projection/v1',
    host,
    manifestFingerprint: manifest.manifestFingerprint,
    lockFingerprint: fingerprintLock(currentLock),
    graphFingerprint: currentLock.graphFingerprint,
    outputs
  });
  const basis = Object.freeze({
    governedSourceFingerprint,
    manifestFingerprint: manifest.manifestFingerprint,
    configurationFingerprint,
    fingerprint: projectionFingerprint
  });
  return Object.freeze({
    state: 'realized',
    fingerprint: projectionFingerprint,
    basis
  });
}

function scopeRows(operations) {
  return operations.map((operation) => ({
    id: operation.id,
    sequence: operation.sequence,
    action: operation.action,
    path: operation.path,
    role: operation.role,
    mode: operation.after.mode,
    beforeFingerprint: operation.before.fingerprint,
    afterFingerprint: operation.after.fingerprint
  }));
}

function operationsForPlan(root, currentManifest, rendered, allManifests) {
  const otherOwners = new Map();
  for (const row of allManifests) {
    if (row.manifest.host === rendered.host) continue;
    for (const output of row.manifest.outputs) otherOwners.set(output.path, row.manifest.host);
  }
  for (const output of rendered.outputs) {
    if (otherOwners.has(output.path)) {
      fail('HOST_REALIZATION_CROSS_HOST_COLLISION', 'Another host manifest owns a candidate output path.');
    }
  }

  if (!currentManifest) {
    for (const output of rendered.outputs) {
      if (fs.existsSync(outputPath(root, output.path))) {
        fail('HOST_REALIZATION_UNMANAGED_COLLISION', 'Existing output has no exact managed manifest and cannot be adopted.');
      }
    }
  } else {
    for (const output of currentManifest.outputs) {
      const observed = presentSnapshot(root, output.path);
      if (observed.state !== 'present' || observed.fingerprint !== output.fingerprint) {
        fail('HOST_REALIZATION_MANAGED_DRIFT', 'A currently managed output drifted from its manifest.');
      }
    }
  }

  const operations = [];
  const currentByPath = new Map((currentManifest?.outputs || []).map((output) => [output.path, output]));
  const candidatePaths = new Set(rendered.outputs.map((output) => output.path));

  for (const output of rendered.outputs) {
    const current = currentByPath.get(output.path);
    if (!current) {
      if (fs.existsSync(outputPath(root, output.path))) {
        fail('HOST_REALIZATION_UNMANAGED_COLLISION', 'Candidate output path is occupied without exact ownership.');
      }
      operations.push({
        id: output.id,
        action: 'create',
        path: output.path,
        role: output.role,
        before: absentSnapshot(),
        after: candidateSnapshot(output),
        template: { path: output.templatePath, fingerprint: output.templateFingerprint }
      });
    } else if (current.fingerprint !== output.fingerprint
      || current.id !== output.id || current.role !== output.role || current.mode !== output.mode) {
      operations.push({
        id: output.id,
        action: 'replace',
        path: output.path,
        role: output.role,
        before: presentSnapshot(root, output.path),
        after: candidateSnapshot(output),
        template: { path: output.templatePath, fingerprint: output.templateFingerprint }
      });
    }
  }

  for (const output of currentManifest?.outputs || []) {
    if (!candidatePaths.has(output.path)) {
      operations.push({
        id: output.id,
        action: 'remove',
        path: output.path,
        role: output.role,
        before: presentSnapshot(root, output.path),
        after: absentSnapshot(),
        template: null
      });
    }
  }

  operations.sort((left, right) => compareText(left.path, right.path));
  const ids = new Set();
  for (const [sequence, operation] of operations.entries()) {
    if (ids.has(operation.id)) {
      fail('HOST_REALIZATION_PLAN_INVALID', 'Host realization operations contain duplicate output identities.');
    }
    ids.add(operation.id);
    operation.sequence = sequence;
  }
  return operations;
}

function assertPlanSemantics(root, plan) {
  assertFingerprint(root, plan, 'plan', 'planFingerprint', 'Host realization plan');
  requireWindow(plan.createdAt, plan.validUntil, 'Host realization plan');
  const targetFields = {
    requestedPath: plan.target.requestedPath,
    realPath: plan.target.realPath,
    device: plan.target.device,
    inode: plan.target.inode
  };
  if (plan.target.fingerprint !== fingerprintJson(targetFields)
    || plan.configuration.activeLockPath !== repoRelativePath(
      root,
      activeConfigurationLockStatePath(root, plan.configuration.name)
    )) {
    fail('HOST_REALIZATION_PLAN_TAMPERED', 'Host realization target or active-lock binding is invalid.');
  }
  if (fingerprintJson(scopeRows(plan.operations)) !== plan.scopeFingerprint) {
    fail('HOST_REALIZATION_PLAN_TAMPERED', 'Host realization plan scope fingerprint is invalid.');
  }
  const paths = new Set();
  const ids = new Set();
  for (const [sequence, operation] of plan.operations.entries()) {
    normalizedRelative(operation.path);
    if (operation.sequence !== sequence || paths.has(operation.path) || ids.has(operation.id)) {
      fail('HOST_REALIZATION_PLAN_INVALID', 'Host realization operation order, id, or path is ambiguous.');
    }
    paths.add(operation.path);
    ids.add(operation.id);
    if ((operation.action === 'create'
        && (operation.before.state !== 'absent' || operation.after.state !== 'present'))
      || (operation.action === 'replace'
        && (operation.before.state !== 'present' || operation.after.state !== 'present'))
      || (operation.action === 'remove'
        && (operation.before.state !== 'present' || operation.after.state !== 'absent'))
      || (operation.action === 'remove') !== (operation.template === null)) {
      fail('HOST_REALIZATION_PLAN_INVALID', 'Host realization operation snapshots do not match the declared action.');
    }
    for (const snapshot of [operation.before, operation.after]) {
      if (snapshot.state === 'present') {
        const contentFingerprint = sha256(Buffer.from(snapshot.content, 'utf8'));
        if (contentFingerprint !== snapshot.contentFingerprint
          || fileFingerprint(contentFingerprint, snapshot.mode) !== snapshot.fingerprint) {
          fail('HOST_REALIZATION_PLAN_TAMPERED', 'Host realization file content or mode fingerprint is invalid.');
        }
      }
    }
  }
  const expectedManifestPath = repoRelativePath(
    root,
    hostManagedManifestStatePath(root, plan.host.id)
  );
  if (plan.manifest.path !== expectedManifestPath) {
    fail('HOST_REALIZATION_PLAN_TAMPERED', 'Host realization prior manifest path is invalid.');
  }
  let priorManifest = null;
  if (plan.manifest.state === 'present') {
    priorManifest = assertManifest(root, plan.manifest.document);
    if (plan.manifest.fingerprint !== priorManifest.manifestFingerprint
      || priorManifest.host !== plan.host.id
      || priorManifest.targetFingerprint !== plan.target.fingerprint) {
      fail('HOST_REALIZATION_PLAN_TAMPERED', 'Host realization prior manifest binding is invalid.');
    }
  }
  if (plan.candidateManifest.host !== plan.host.id
    || plan.candidateManifest.targetFingerprint !== plan.target.fingerprint
    || plan.candidateManifest.configuration.name !== plan.configuration.name
    || plan.candidateManifest.configuration.lockFingerprint !== plan.configuration.lockFingerprint
    || plan.candidateManifest.configuration.graphFingerprint !== plan.configuration.graphFingerprint
    || fingerprintJson(plan.candidateManifest.definition) !== fingerprintJson(plan.host.definition)
    || fingerprintJson(plan.candidateManifest.generator) !== fingerprintJson(plan.host.generator)) {
    fail('HOST_REALIZATION_PLAN_TAMPERED', 'Candidate manifest metadata does not bind the exact plan.');
  }
  const candidateByPath = new Map();
  for (const output of plan.candidateManifest.outputs) {
    normalizedRelative(output.path);
    if (candidateByPath.has(output.path)
      || fileFingerprint(output.contentFingerprint, output.mode) !== output.fingerprint) {
      fail('HOST_REALIZATION_PLAN_TAMPERED', 'Candidate manifest output identity or fingerprint is invalid.');
    }
    candidateByPath.set(output.path, output);
  }
  const priorByPath = new Map((priorManifest?.outputs || []).map((output) => [output.path, output]));
  const expected = [];
  for (const output of plan.candidateManifest.outputs) {
    const prior = priorByPath.get(output.path);
    if (!prior) {
      expected.push({ action: 'create', output, prior: null });
    } else if (fingerprintJson(prior) !== fingerprintJson(output)) {
      expected.push({ action: 'replace', output, prior });
    }
  }
  for (const prior of priorManifest?.outputs || []) {
    if (!candidateByPath.has(prior.path)) expected.push({ action: 'remove', output: null, prior });
  }
  expected.sort((left, right) => compareText(
    left.output?.path || left.prior.path,
    right.output?.path || right.prior.path
  ));
  if (expected.length !== plan.operations.length) {
    fail('HOST_REALIZATION_PLAN_TAMPERED', 'Host realization operation coverage is incomplete or excessive.');
  }
  for (const [index, operation] of plan.operations.entries()) {
    const row = expected[index];
    const identity = row.output || row.prior;
    if (operation.action !== row.action
      || operation.path !== identity.path
      || operation.id !== identity.id
      || operation.role !== identity.role
      || (row.prior && operation.before.fingerprint !== row.prior.fingerprint)
      || (row.output && (operation.after.fingerprint !== row.output.fingerprint
        || operation.after.contentFingerprint !== row.output.contentFingerprint
        || operation.after.mode !== row.output.mode))) {
      fail('HOST_REALIZATION_PLAN_TAMPERED', 'Host realization operation does not match prior and candidate ownership.');
    }
  }
  return plan;
}

function readPlan(root, planId) {
  if (!hasHostRealizationPlanState(root, planId)) {
    fail('HOST_REALIZATION_PLAN_MISSING', 'Host realization plan is unavailable.');
  }
  return assertPlanSemantics(root, readHostRealizationPlanState(root, planId).plan);
}

function planCurrentness(root, plan, currentAt, { allowApplied = false } = {}) {
  assertTarget(root, plan.target);
  requireNotExpired(plan.validUntil, currentAt, 'HOST_REALIZATION_PLAN_EXPIRED');
  const lock = activeLock(root, plan.configuration.name);
  if (fingerprintLock(lock) !== plan.configuration.lockFingerprint
    || lock.graphFingerprint !== plan.configuration.graphFingerprint
    || lock.host.id !== plan.host.id) {
    fail('HOST_REALIZATION_ACTIVE_LOCK_STALE', 'Active configuration lock changed after host realization preview.');
  }
  const rendered = renderedForLock(root, lock);
  const expectedMetadata = manifestMetadata({ target: plan.target, lock, rendered });
  if (fingerprintJson(expectedMetadata) !== fingerprintJson(plan.candidateManifest)) {
    fail('HOST_REALIZATION_CANDIDATE_DRIFT', 'Candidate manifest metadata changed after preview.');
  }
  const documents = manifests(root, plan.target);
  const currentRow = documents.find((row) => row.manifest.host === plan.host.id) || null;
  const currentSnapshot = manifestSnapshot(root, plan.host.id);
  const priorMatches = currentSnapshot.state === plan.manifest.state
    && currentSnapshot.fingerprint === plan.manifest.fingerprint;
  const appliedMatches = currentRow
    && fingerprintJson(priorManifestMetadata(currentRow.manifest)) === fingerprintJson(expectedMetadata);
  if (!priorMatches && !(allowApplied && appliedMatches)) {
    fail('HOST_REALIZATION_MANIFEST_DRIFT', 'Managed host manifest changed after preview.');
  }
  if (!allowApplied || !appliedMatches) {
    for (const operation of plan.operations) {
      const observed = presentSnapshot(root, operation.path);
      if (!snapshotEquals(observed, operation.before)) {
        fail('HOST_REALIZATION_OUTPUT_DRIFT', 'Managed host output changed after preview.');
      }
    }
  }
  return { lock, rendered, expectedMetadata, documents, appliedMatches: Boolean(appliedMatches) };
}

export function prepareHostRealization({
  root,
  configurationName,
  id,
  createdAt,
  validUntil
}) {
  const resolvedRoot = path.resolve(root);
  requireWindow(createdAt, validUntil, 'Host realization plan');
  const target = targetIdentity(resolvedRoot);
  const lock = activeLock(resolvedRoot, configurationName);
  const rendered = renderedForLock(resolvedRoot, lock);
  const documents = manifests(resolvedRoot, target);
  const currentRow = documents.find((row) => row.manifest.host === lock.host.id) || null;
  const operations = operationsForPlan(
    resolvedRoot,
    currentRow?.manifest || null,
    rendered,
    documents
  );
  const expectedMetadata = manifestMetadata({ target, lock, rendered });
  if (!operations.length && currentRow
    && fingerprintJson(priorManifestMetadata(currentRow.manifest)) === fingerprintJson(expectedMetadata)) {
    fail('HOST_REALIZATION_ALREADY_CURRENT', 'Managed host projection already matches the exact active lock.');
  }
  const scopeFingerprint = fingerprintJson(scopeRows(operations));
  const plan = seal({
    $contract: CONTRACTS.plan[0],
    contractVersion: '1.0.0',
    id,
    createdAt,
    validUntil,
    target,
    host: {
      id: lock.host.id,
      adapter: lock.host.adapter,
      definition: {
        id: rendered.definition.id,
        version: rendered.definition.version,
        fingerprint: rendered.definition.fingerprint
      },
      generator: {
        id: rendered.generator.id,
        version: rendered.generator.version,
        fingerprint: fingerprintJson(rendered.generator)
      }
    },
    configuration: {
      name: configurationName,
      activeLockPath: repoRelativePath(
        resolvedRoot,
        activeConfigurationLockStatePath(resolvedRoot, configurationName)
      ),
      lockFingerprint: fingerprintLock(lock),
      graphFingerprint: lock.graphFingerprint
    },
    manifest: manifestSnapshot(resolvedRoot, lock.host.id),
    candidateManifest: expectedMetadata,
    operations,
    scopeFingerprint,
    planFingerprint: null
  }, 'planFingerprint');
  assertPlanSemantics(resolvedRoot, plan);
  if (hasHostRealizationPlanState(resolvedRoot, id)) {
    const existing = readPlan(resolvedRoot, id);
    if (existing.planFingerprint !== plan.planFingerprint) {
      fail('HOST_REALIZATION_PLAN_CONFLICT', 'Host realization plan id already binds another exact scope.');
    }
    return { plan: existing };
  }
  createHostRealizationPlanState(resolvedRoot, plan);
  return { plan };
}

function readRequest(root, requestId) {
  if (!hasHostRealizationRequestState(root, requestId)) {
    fail('HOST_REALIZATION_REQUEST_MISSING', 'Host realization request is unavailable.');
  }
  const request = assertFingerprint(
    root,
    readHostRealizationRequestState(root, requestId).request,
    'request',
    'requestFingerprint',
    'Host realization request'
  );
  const plan = readPlan(root, request.plan.id);
  if (request.plan.fingerprint !== plan.planFingerprint
    || request.scopeFingerprint !== plan.scopeFingerprint) {
    fail('HOST_REALIZATION_REQUEST_BINDING_INVALID', 'Host realization request does not bind its exact plan.');
  }
  return { request, plan };
}

export function beginHostRealizationRequest({
  root,
  planId,
  id,
  reason,
  createdAt,
  expiresAt
}) {
  const resolvedRoot = path.resolve(root);
  requireWindow(createdAt, expiresAt, 'Host realization request');
  const plan = readPlan(resolvedRoot, planId);
  planCurrentness(resolvedRoot, plan, createdAt);
  if (at(expiresAt, 'Request expiry') > at(plan.validUntil, 'Plan expiry')) {
    fail('HOST_REALIZATION_REQUEST_WINDOW_INVALID', 'Confirmation request cannot outlive its exact plan.');
  }
  const request = seal({
    $contract: CONTRACTS.request[0],
    contractVersion: '1.0.0',
    id,
    createdAt,
    expiresAt,
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    scopeFingerprint: plan.scopeFingerprint,
    reason,
    requestFingerprint: null
  }, 'requestFingerprint');
  assertFingerprint(resolvedRoot, request, 'request', 'requestFingerprint', 'Host realization request');
  if (hasHostRealizationRequestState(resolvedRoot, id)) {
    const existing = readRequest(resolvedRoot, id).request;
    if (existing.requestFingerprint !== request.requestFingerprint) {
      fail('HOST_REALIZATION_REQUEST_CONFLICT', 'Host realization request id already binds another plan.');
    }
    return { request: existing };
  }
  createHostRealizationRequestState(resolvedRoot, request);
  return { request };
}

function readConfirmation(root, confirmationId) {
  if (!hasHostRealizationConfirmationState(root, confirmationId)) {
    fail('HOST_REALIZATION_CONFIRMATION_MISSING', 'Host realization confirmation is unavailable.');
  }
  const confirmation = assertFingerprint(
    root,
    readHostRealizationConfirmationState(root, confirmationId).confirmation,
    'confirmation',
    'confirmationFingerprint',
    'Host realization confirmation'
  );
  const { request, plan } = readRequest(root, confirmation.request.id);
  if (confirmation.request.fingerprint !== request.requestFingerprint
    || confirmation.plan.id !== plan.id
    || confirmation.plan.fingerprint !== plan.planFingerprint
    || confirmation.scopeFingerprint !== plan.scopeFingerprint) {
    fail('HOST_REALIZATION_CONFIRMATION_BINDING_INVALID', 'Host realization confirmation does not bind the exact request and plan.');
  }
  requireNotExpired(request.expiresAt, confirmation.confirmedAt);
  return { confirmation, request, plan };
}

export function confirmHostRealizationRequest({
  root,
  requestId,
  id,
  actor,
  reason,
  confirmedAt
}) {
  const resolvedRoot = path.resolve(root);
  const { request, plan } = readRequest(resolvedRoot, requestId);
  requireNotExpired(request.expiresAt, confirmedAt);
  planCurrentness(resolvedRoot, plan, confirmedAt);
  const confirmation = seal({
    $contract: CONTRACTS.confirmation[0],
    contractVersion: '1.0.0',
    id,
    confirmedAt,
    request: { id: request.id, fingerprint: request.requestFingerprint },
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    scopeFingerprint: plan.scopeFingerprint,
    actor: clone(actor),
    reason,
    confirmationFingerprint: null
  }, 'confirmationFingerprint');
  assertFingerprint(
    resolvedRoot,
    confirmation,
    'confirmation',
    'confirmationFingerprint',
    'Host realization confirmation'
  );
  if (hasHostRealizationConfirmationState(resolvedRoot, id)) {
    const existing = readConfirmation(resolvedRoot, id).confirmation;
    if (existing.confirmationFingerprint !== confirmation.confirmationFingerprint) {
      fail('HOST_REALIZATION_CONFIRMATION_CONFLICT', 'Host realization confirmation id already binds another request.');
    }
    return { confirmation: existing };
  }
  createHostRealizationConfirmationState(resolvedRoot, confirmation);
  return { confirmation };
}

export function hostRealizationConsumptionId(confirmationId) {
  const prefix = 'host-realization-confirmation.';
  if (typeof confirmationId !== 'string' || !confirmationId.startsWith(prefix)) {
    fail('HOST_REALIZATION_CONFIRMATION_ID_INVALID', 'Host realization confirmation id is invalid.');
  }
  return 'host-realization-consumption.' + confirmationId.slice(prefix.length);
}

function assertConsumption(root, consumption) {
  assertFingerprint(
    root,
    consumption,
    'consumption',
    'consumptionFingerprint',
    'Host realization consumption'
  );
  const { confirmation, request, plan } = readConfirmation(root, consumption.confirmation.id);
  const reservationFingerprint = fingerprintJson({
    id: consumption.id,
    confirmation: consumption.confirmation,
    request: consumption.request,
    plan: consumption.plan,
    checkpointId: consumption.checkpointId
  });
  if (consumption.confirmation.fingerprint !== confirmation.confirmationFingerprint
    || consumption.request.id !== request.id
    || consumption.request.fingerprint !== request.requestFingerprint
    || consumption.plan.id !== plan.id
    || consumption.plan.fingerprint !== plan.planFingerprint
    || consumption.reservationFingerprint !== reservationFingerprint
    || (consumption.state === 'reserved') !== (consumption.checkpointFingerprint === null)) {
    fail('HOST_REALIZATION_CONSUMPTION_BINDING_INVALID', 'Host realization consumption does not bind its authority chain.');
  }
  return { consumption, confirmation, request, plan };
}

function readConsumption(root, consumptionId) {
  if (!hasHostRealizationConsumptionState(root, consumptionId)) {
    fail('HOST_REALIZATION_CONSUMPTION_MISSING', 'Host realization consumption is unavailable.');
  }
  return assertConsumption(root, readHostRealizationConsumptionState(root, consumptionId).consumption);
}

function persistCheckpoint(root, checkpoint) {
  seal(checkpoint, 'checkpointFingerprint');
  assertCheckpointShape(root, checkpoint);
  writeHostRealizationCheckpointState(root, checkpoint);
  return checkpoint;
}

function assertCheckpointShape(root, checkpoint) {
  assertFingerprint(
    root,
    checkpoint,
    'checkpoint',
    'checkpointFingerprint',
    'Host realization checkpoint'
  );
  if (checkpoint.authorityFingerprint !== fingerprintJson({
    plan: checkpoint.plan,
    request: checkpoint.request,
    confirmation: checkpoint.confirmation,
    consumption: checkpoint.consumption,
    targetFingerprint: checkpoint.targetFingerprint,
    configuration: checkpoint.configuration,
    outputs: checkpoint.outputs.map(({ id, sequence, path: output, action }) => ({
      id, sequence, path: output, action
    }))
  })) {
    fail('HOST_REALIZATION_CHECKPOINT_TAMPERED', 'Host realization checkpoint authority fingerprint is invalid.');
  }
  return checkpoint;
}

function readCheckpoint(root, checkpointId) {
  if (!hasHostRealizationCheckpointState(root, checkpointId)) {
    fail('HOST_REALIZATION_CHECKPOINT_MISSING', 'Host realization checkpoint is unavailable.');
  }
  const checkpoint = assertCheckpointShape(
    root,
    readHostRealizationCheckpointState(root, checkpointId).checkpoint
  );
  const plan = readPlan(root, checkpoint.plan.id);
  const { request } = readRequest(root, checkpoint.request.id);
  const { confirmation } = readConfirmation(root, checkpoint.confirmation.id);
  const { consumption } = readConsumption(root, checkpoint.consumption.id);
  const expectedOutputs = plan.operations.map(({ id, sequence, path: output, action }) => ({
    id, sequence, path: output, action
  }));
  const checkpointOutputs = checkpoint.outputs.map(({ id, sequence, path: output, action }) => ({
    id, sequence, path: output, action
  }));
  const permittedDirectories = new Set(plan.operations.flatMap((operation) => {
    const segments = operation.path.split('/').slice(0, -1);
    return segments.map((_segment, index) => segments.slice(0, index + 1).join('/'));
  }));
  if (checkpoint.plan.fingerprint !== plan.planFingerprint
    || checkpoint.request.fingerprint !== request.requestFingerprint
    || checkpoint.confirmation.fingerprint !== confirmation.confirmationFingerprint
    || checkpoint.consumption.fingerprint !== consumption.reservationFingerprint
    || consumption.state !== 'started'
    || consumption.checkpointId !== checkpoint.id
    || consumption.checkpointFingerprint !== checkpoint.authorityFingerprint
    || checkpoint.targetFingerprint !== plan.target.fingerprint
    || fingerprintJson(checkpointOutputs) !== fingerprintJson(expectedOutputs)
    || (checkpoint.currentOutputId !== null
      && !checkpoint.outputs.some((output) => output.id === checkpoint.currentOutputId))
    || checkpoint.createdDirectories.some((directory) => {
      try {
        normalizedRelative(directory.path);
        return !permittedDirectories.has(directory.path);
      } catch {
        return true;
      }
    })
    || fingerprintJson(checkpoint.configuration) !== fingerprintJson({
      name: plan.configuration.name,
      lockFingerprint: plan.configuration.lockFingerprint,
      graphFingerprint: plan.configuration.graphFingerprint
    })) {
    fail('HOST_REALIZATION_CHECKPOINT_BINDING_INVALID', 'Host realization checkpoint does not bind the exact one-time authority chain.');
  }
  return { checkpoint, plan, request, confirmation, consumption };
}

function preparedCheckpoint({ plan, request, confirmation, consumption, checkpointId, at: createdAt }) {
  const outputs = plan.operations.map((operation) => ({
    id: operation.id,
    sequence: operation.sequence,
    path: operation.path,
    action: operation.action,
    state: 'pending',
    observedFingerprint: operation.before.fingerprint
  }));
  const authority = {
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    request: { id: request.id, fingerprint: request.requestFingerprint },
    confirmation: { id: confirmation.id, fingerprint: confirmation.confirmationFingerprint },
    consumption: { id: consumption.id, fingerprint: consumption.reservationFingerprint },
    targetFingerprint: plan.target.fingerprint,
    configuration: {
      name: plan.configuration.name,
      lockFingerprint: plan.configuration.lockFingerprint,
      graphFingerprint: plan.configuration.graphFingerprint
    },
    outputs: outputs.map(({ id, sequence, path: output, action }) => ({
      id, sequence, path: output, action
    }))
  };
  return seal({
    $contract: CONTRACTS.checkpoint[0],
    contractVersion: '1.0.0',
    id: checkpointId,
    createdAt,
    updatedAt: createdAt,
    state: 'prepared',
    phase: 'prepared',
    plan: authority.plan,
    request: authority.request,
    confirmation: authority.confirmation,
    consumption: authority.consumption,
    targetFingerprint: authority.targetFingerprint,
    configuration: authority.configuration,
    currentOutputId: null,
    outputs,
    createdDirectories: [],
    observation: { manifestFingerprint: plan.manifest.fingerprint, outputFingerprint: null },
    failure: null,
    authorityFingerprint: fingerprintJson(authority),
    checkpointFingerprint: null
  }, 'checkpointFingerprint');
}

export function prepareHostRealizationExecution({
  root,
  confirmationId,
  checkpointId,
  at: startedAt
}) {
  const resolvedRoot = path.resolve(root);
  const { confirmation, request, plan } = readConfirmation(resolvedRoot, confirmationId);
  requireNotExpired(request.expiresAt, startedAt);
  planCurrentness(resolvedRoot, plan, startedAt);
  const consumptionId = hostRealizationConsumptionId(confirmation.id);
  const authority = {
    id: consumptionId,
    confirmation: { id: confirmation.id, fingerprint: confirmation.confirmationFingerprint },
    request: { id: request.id, fingerprint: request.requestFingerprint },
    plan: { id: plan.id, fingerprint: plan.planFingerprint },
    checkpointId
  };
  const reservationFingerprint = fingerprintJson(authority);
  let consumption;
  if (hasHostRealizationConsumptionState(resolvedRoot, consumptionId)) {
    consumption = readConsumption(resolvedRoot, consumptionId).consumption;
    if (consumption.checkpointId !== checkpointId
      || consumption.reservationFingerprint !== reservationFingerprint) {
      fail(
        'HOST_REALIZATION_CONFIRMATION_ALREADY_CONSUMED',
        'Host realization confirmation was consumed by another checkpoint.'
      );
    }
    if (consumption.state === 'started') {
      return {
        consumption,
        checkpoint: readCheckpoint(resolvedRoot, checkpointId).checkpoint
      };
    }
  } else {
    consumption = seal({
      $contract: CONTRACTS.consumption[0],
      contractVersion: '1.0.0',
      ...authority,
      createdAt: startedAt,
      updatedAt: startedAt,
      state: 'reserved',
      reservationFingerprint,
      checkpointFingerprint: null,
      consumptionFingerprint: null
    }, 'consumptionFingerprint');
    assertConsumption(resolvedRoot, consumption);
    createHostRealizationConsumptionState(resolvedRoot, consumption);
  }
  let checkpoint;
  if (hasHostRealizationCheckpointState(resolvedRoot, checkpointId)) {
    checkpoint = assertCheckpointShape(
      resolvedRoot,
      readHostRealizationCheckpointState(resolvedRoot, checkpointId).checkpoint
    );
    if (checkpoint.consumption.id !== consumption.id
      || checkpoint.consumption.fingerprint !== consumption.reservationFingerprint
      || checkpoint.plan.fingerprint !== plan.planFingerprint) {
      fail(
        'HOST_REALIZATION_CHECKPOINT_BINDING_INVALID',
        'Prepared host realization checkpoint does not bind the reserved consumption.'
      );
    }
  } else {
    checkpoint = preparedCheckpoint({
      plan,
      request,
      confirmation,
      consumption,
      checkpointId,
      at: startedAt
    });
    assertCheckpointShape(resolvedRoot, checkpoint);
    createHostRealizationCheckpointState(resolvedRoot, checkpoint);
  }
  consumption = seal({
    ...consumption,
    updatedAt: startedAt,
    state: 'started',
    checkpointFingerprint: checkpoint.authorityFingerprint,
    consumptionFingerprint: null
  }, 'consumptionFingerprint');
  assertConsumption(resolvedRoot, consumption);
  writeHostRealizationConsumptionState(resolvedRoot, consumption);
  return { consumption, checkpoint };
}

function checkpointOutputFingerprint(root, plan) {
  return fingerprintJson(plan.operations.map((operation) => ({
    id: operation.id,
    fingerprint: presentSnapshot(root, operation.path).fingerprint
  })));
}

function candidateManifest(plan, checkpoint) {
  const manifest = {
    $contract: CONTRACTS.manifest[0],
    contractVersion: '1.0.0',
    id: 'host-managed-manifest.' + plan.host.id,
    ...clone(plan.candidateManifest),
    checkpoint: { id: checkpoint.id, fingerprint: checkpoint.authorityFingerprint },
    manifestFingerprint: null
  };
  seal(manifest, 'manifestFingerprint');
  return assertManifest(path.resolve(plan.target.requestedPath), manifest);
}

function expectedManifestState(plan, expected) {
  const observed = manifestSnapshot(plan.target.requestedPath, plan.host.id);
  if (observed.state !== expected.state || observed.fingerprint !== expected.fingerprint) {
    fail('HOST_REALIZATION_MANIFEST_DRIFT', 'Managed host manifest changed during realization.');
  }
  return observed;
}

function effectCurrentness(root, plan, checkpoint, currentAt, { manifest = 'prior' } = {}) {
  assertTarget(root, plan.target);
  requireNotExpired(plan.validUntil, currentAt, 'HOST_REALIZATION_PLAN_EXPIRED');
  const lock = activeLock(root, plan.configuration.name);
  if (fingerprintLock(lock) !== plan.configuration.lockFingerprint
    || lock.graphFingerprint !== plan.configuration.graphFingerprint
    || lock.host.id !== plan.host.id) {
    fail('HOST_REALIZATION_ACTIVE_LOCK_STALE', 'Active lock changed during host realization.');
  }
  const rendered = renderedForLock(root, lock);
  if (fingerprintJson(manifestMetadata({ target: plan.target, lock, rendered }))
    !== fingerprintJson(plan.candidateManifest)) {
    fail('HOST_REALIZATION_CANDIDATE_DRIFT', 'Candidate manifest metadata changed during realization.');
  }
  const rows = manifests(root, plan.target);
  for (const row of rows) {
    if (row.manifest.host === plan.host.id) continue;
    const owned = new Set(row.manifest.outputs.map((output) => output.path));
    if (rendered.outputs.some((output) => owned.has(output.path))) {
      fail('HOST_REALIZATION_CROSS_HOST_COLLISION', 'Another host claimed a candidate output during realization.');
    }
  }
  const candidate = candidateManifest(plan, checkpoint);
  expectedManifestState(
    plan,
    manifest === 'candidate'
      ? { state: 'present', fingerprint: candidate.manifestFingerprint }
      : plan.manifest
  );
  for (const [index, operation] of plan.operations.entries()) {
    const row = checkpoint.outputs[index];
    const expected = row.state === 'pending' ? operation.before : operation.after;
    const observed = presentSnapshot(root, operation.path);
    if (!snapshotEquals(observed, expected)) {
      fail('HOST_REALIZATION_OUTPUT_DRIFT', 'Managed output changed during host realization.');
    }
  }
  return { lock, rendered, candidate };
}

function maybeCrash(faultAfter, point) {
  if (faultAfter === point) {
    fail('HOST_REALIZATION_TEST_CRASH', 'Contained host realization crash at ' + point + '.');
  }
}

function parentDirectories(root, relative) {
  const normalized = normalizedRelative(relative);
  const segments = normalized.split('/').slice(0, -1);
  const directories = [];
  let current = '';
  for (const segment of segments) {
    current = current ? current + '/' + segment : segment;
    const target = outputPath(root, current);
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fail('HOST_REALIZATION_PATH_DRIFT', 'Output parent is not a regular directory.');
      }
    } else {
      directories.push(current);
    }
  }
  return directories;
}

function createOutputDirectories(root, plan, checkpoint, currentAt, faultAfter) {
  const required = [...new Set(plan.operations
    .filter((operation) => operation.after.state === 'present')
    .flatMap((operation) => parentDirectories(root, operation.path)))]
    .sort((left, right) => left.split('/').length - right.split('/').length || compareText(left, right));
  for (const relative of required) {
    if (checkpoint.createdDirectories.some((entry) => entry.path === relative && entry.state === 'created')) {
      continue;
    }
    effectCurrentness(root, plan, checkpoint, currentAt);
    const directory = outputPath(root, relative);
    if (fs.existsSync(directory)) continue;
    const existing = checkpoint.createdDirectories.find((entry) => entry.path === relative);
    if (existing) {
      existing.state = 'planned';
    } else {
      checkpoint.createdDirectories.push({ path: relative, state: 'planned' });
    }
    checkpoint.state = 'applying';
    checkpoint.phase = 'directories';
    checkpoint.updatedAt = currentAt;
    persistCheckpoint(root, checkpoint);
    fs.mkdirSync(directory, { recursive: false, mode: DIRECTORY_MODE });
    try {
      fs.chmodSync(directory, DIRECTORY_MODE);
    } catch {
      // Some filesystems do not expose POSIX modes; exact file modes remain verified.
    }
    checkpoint.createdDirectories.find((entry) => entry.path === relative).state = 'created';
    persistCheckpoint(root, checkpoint);
    maybeCrash(faultAfter, 'after-directory:' + relative);
  }
}

function atomicWriteOutput(root, relative, expected, desired, checkpointId) {
  const file = outputPath(root, relative, { allowMissingParents: false });
  const observed = presentSnapshot(root, relative);
  if (!snapshotEquals(observed, expected)) {
    fail('HOST_REALIZATION_OUTPUT_DRIFT', 'Output changed immediately before its atomic write.');
  }
  const temporary = file + '.' + checkpointId.replace(/[^a-z0-9.-]/g, '-') + '.tmp';
  if (fs.existsSync(temporary) || fs.lstatSync(path.dirname(file)).isSymbolicLink()) {
    fail('HOST_REALIZATION_TEMP_COLLISION', 'Atomic host projection temporary path is occupied or unsafe.');
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, desired.content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.chmodSync(temporary, 0o644);
    const rechecked = presentSnapshot(root, relative);
    if (!snapshotEquals(rechecked, expected)) {
      fail('HOST_REALIZATION_OUTPUT_DRIFT', 'Output changed before atomic replacement.');
    }
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  const after = presentSnapshot(root, relative);
  if (!snapshotEquals(after, desired)) {
    fail('HOST_REALIZATION_WRITE_VERIFY_FAILED', 'Atomic host projection write did not produce the exact candidate bytes and mode.');
  }
  return after;
}

function removeOutput(root, operation) {
  const file = outputPath(root, operation.path, { allowMissingParents: false });
  const observed = presentSnapshot(root, operation.path);
  if (!snapshotEquals(observed, operation.before)) {
    fail('HOST_REALIZATION_OUTPUT_DRIFT', 'Output changed immediately before managed removal.');
  }
  fs.unlinkSync(file);
  const after = presentSnapshot(root, operation.path);
  if (after.state !== 'absent') {
    fail('HOST_REALIZATION_REMOVE_VERIFY_FAILED', 'Managed output removal did not verify.');
  }
  return after;
}

function applyOperation(root, operation, checkpoint) {
  if (operation.action === 'remove') return removeOutput(root, operation);
  return atomicWriteOutput(
    root,
    operation.path,
    operation.before,
    operation.after,
    checkpoint.id
  );
}

function restoreOperation(root, operation, checkpoint) {
  const observed = presentSnapshot(root, operation.path);
  if (snapshotEquals(observed, operation.before)) return observed;
  if (!snapshotEquals(observed, operation.after)) {
    fail('HOST_REALIZATION_ROLLBACK_DRIFT', 'Managed output has unknown bytes and cannot be rolled back automatically.');
  }
  if (operation.before.state === 'absent') {
    fs.unlinkSync(outputPath(root, operation.path, { allowMissingParents: false }));
    return presentSnapshot(root, operation.path);
  }
  return atomicWriteOutput(root, operation.path, operation.after, operation.before, checkpoint.id + '.rollback');
}

function restoreManifest(root, plan, candidate) {
  const observed = manifestSnapshot(root, plan.host.id);
  if (observed.state === plan.manifest.state && observed.fingerprint === plan.manifest.fingerprint) return;
  if (observed.state !== 'present' || observed.fingerprint !== candidate.manifestFingerprint) {
    fail('HOST_REALIZATION_ROLLBACK_DRIFT', 'Managed manifest has unknown state and cannot be rolled back automatically.');
  }
  if (plan.manifest.state === 'absent') {
    removeHostManagedManifestState(root, plan.host.id);
  } else {
    writeHostManagedManifestState(root, plan.manifest.document);
  }
}

function rollbackHostRealization(root, chain, currentAt, reasonCode, summary) {
  const { checkpoint, plan } = chain;
  checkpoint.state = 'rolling-back';
  checkpoint.phase = 'rollback';
  checkpoint.failure = { reasonCode, summary };
  checkpoint.updatedAt = currentAt;
  persistCheckpoint(root, checkpoint);
  try {
    assertTarget(root, plan.target);
    const candidate = candidateManifest(plan, checkpoint);
    restoreManifest(root, plan, candidate);
    for (let index = plan.operations.length - 1; index >= 0; index -= 1) {
      const operation = plan.operations[index];
      const restored = restoreOperation(root, operation, checkpoint);
      checkpoint.outputs[index].state = 'rolled-back';
      checkpoint.outputs[index].observedFingerprint = restored.fingerprint;
      checkpoint.currentOutputId = operation.id;
      checkpoint.observation = {
        manifestFingerprint: plan.manifest.fingerprint,
        outputFingerprint: checkpointOutputFingerprint(root, plan)
      };
      persistCheckpoint(root, checkpoint);
    }
    for (const directory of [...checkpoint.createdDirectories].reverse()) {
      if (directory.state !== 'created') continue;
      const target = outputPath(root, directory.path, { allowMissingParents: false });
      if (fs.existsSync(target)) {
        if (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length) {
          fail('HOST_REALIZATION_ROLLBACK_DIRECTORY_NOT_EMPTY', 'Checkpoint-created directory is not empty during rollback.');
        }
        fs.rmdirSync(target);
      }
      directory.state = 'removed';
      persistCheckpoint(root, checkpoint);
    }
    checkpoint.state = 'rolled-back';
    checkpoint.phase = 'terminal';
    checkpoint.currentOutputId = null;
    checkpoint.updatedAt = currentAt;
    checkpoint.observation = {
      manifestFingerprint: plan.manifest.fingerprint,
      outputFingerprint: checkpointOutputFingerprint(root, plan)
    };
    return persistCheckpoint(root, checkpoint);
  } catch (error) {
    checkpoint.state = 'needs-attention';
    checkpoint.phase = 'terminal';
    checkpoint.updatedAt = currentAt;
    checkpoint.failure = {
      reasonCode: stableFailureCode(error, 'HOST_REALIZATION_ROLLBACK_FAILED'),
      summary: 'Automatic host realization rollback could not establish exact prior state.'
    };
    return persistCheckpoint(root, checkpoint);
  }
}

function finishVerified(root, chain, currentAt, candidate) {
  const { checkpoint, plan } = chain;
  effectCurrentness(root, plan, checkpoint, currentAt, { manifest: 'candidate' });
  for (const [index, operation] of plan.operations.entries()) {
    const observed = presentSnapshot(root, operation.path);
    if (!snapshotEquals(observed, operation.after)) {
      fail('HOST_REALIZATION_VERIFY_FAILED', 'Managed output does not match the exact candidate during verification.');
    }
    checkpoint.outputs[index].state = 'verified';
    checkpoint.outputs[index].observedFingerprint = observed.fingerprint;
  }
  const manifest = assertManifest(root, readHostManagedManifestState(root, plan.host.id).manifest);
  if (manifest.manifestFingerprint !== candidate.manifestFingerprint) {
    fail('HOST_REALIZATION_VERIFY_FAILED', 'Managed manifest does not match the exact candidate.');
  }
  checkpoint.state = 'completed';
  checkpoint.phase = 'terminal';
  checkpoint.currentOutputId = null;
  checkpoint.updatedAt = currentAt;
  checkpoint.failure = null;
  checkpoint.observation = {
    manifestFingerprint: manifest.manifestFingerprint,
    outputFingerprint: checkpointOutputFingerprint(root, plan)
  };
  return persistCheckpoint(root, checkpoint);
}

export function executeHostRealization({ root, checkpointId, at: currentAt, faultAfter = null }) {
  const resolvedRoot = path.resolve(root);
  const chain = readCheckpoint(resolvedRoot, checkpointId);
  const { checkpoint, plan } = chain;
  if (['completed', 'rolled-back', 'needs-attention'].includes(checkpoint.state)) return checkpoint;
  try {
    assertTarget(resolvedRoot, plan.target);
    requireNotExpired(plan.validUntil, currentAt, 'HOST_REALIZATION_PLAN_EXPIRED');
    const candidate = candidateManifest(plan, checkpoint);
    const manifest = manifestSnapshot(resolvedRoot, plan.host.id);
    if (manifest.state === 'present' && manifest.fingerprint === candidate.manifestFingerprint) {
      for (const [index, operation] of plan.operations.entries()) {
        const observed = presentSnapshot(resolvedRoot, operation.path);
        if (!snapshotEquals(observed, operation.after)) {
          fail('HOST_REALIZATION_RECOVERY_STATE_UNKNOWN', 'Manifest is current but an output is not the exact candidate.');
        }
        checkpoint.outputs[index].state = 'applied';
        checkpoint.outputs[index].observedFingerprint = observed.fingerprint;
      }
      checkpoint.state = 'verifying';
      checkpoint.phase = 'verifying';
      checkpoint.updatedAt = currentAt;
      persistCheckpoint(resolvedRoot, checkpoint);
      return finishVerified(resolvedRoot, chain, currentAt, candidate);
    }

    effectCurrentness(resolvedRoot, plan, checkpoint, currentAt);
    checkpoint.state = 'applying';
    checkpoint.phase = 'directories';
    checkpoint.updatedAt = currentAt;
    persistCheckpoint(resolvedRoot, checkpoint);
    createOutputDirectories(resolvedRoot, plan, checkpoint, currentAt, faultAfter);

    checkpoint.phase = 'outputs';
    persistCheckpoint(resolvedRoot, checkpoint);
    for (const [index, operation] of plan.operations.entries()) {
      const row = checkpoint.outputs[index];
      if (row.state !== 'pending') continue;
      effectCurrentness(resolvedRoot, plan, checkpoint, currentAt);
      checkpoint.currentOutputId = operation.id;
      checkpoint.updatedAt = currentAt;
      persistCheckpoint(resolvedRoot, checkpoint);
      maybeCrash(faultAfter, 'before-output:' + operation.id);
      const observed = applyOperation(resolvedRoot, operation, checkpoint);
      row.state = 'applied';
      row.observedFingerprint = observed.fingerprint;
      checkpoint.observation = {
        manifestFingerprint: plan.manifest.fingerprint,
        outputFingerprint: checkpointOutputFingerprint(resolvedRoot, plan)
      };
      persistCheckpoint(resolvedRoot, checkpoint);
      maybeCrash(faultAfter, 'after-output:' + operation.id);
    }

    effectCurrentness(resolvedRoot, plan, checkpoint, currentAt);
    checkpoint.phase = 'manifest';
    checkpoint.currentOutputId = null;
    checkpoint.updatedAt = currentAt;
    persistCheckpoint(resolvedRoot, checkpoint);
    maybeCrash(faultAfter, 'before-manifest');
    writeHostManagedManifestState(resolvedRoot, candidate);
    checkpoint.observation.manifestFingerprint = candidate.manifestFingerprint;
    persistCheckpoint(resolvedRoot, checkpoint);
    maybeCrash(faultAfter, 'after-manifest');

    checkpoint.state = 'verifying';
    checkpoint.phase = 'verifying';
    persistCheckpoint(resolvedRoot, checkpoint);
    return finishVerified(resolvedRoot, chain, currentAt, candidate);
  } catch (error) {
    if (error?.code === 'HOST_REALIZATION_TEST_CRASH') throw error;
    return rollbackHostRealization(
      resolvedRoot,
      chain,
      currentAt,
      stableFailureCode(error, 'HOST_REALIZATION_EXECUTION_FAILED'),
      'Host realization stopped and attempted exact rollback.'
    );
  }
}

function markNeedsAttention(root, checkpoint, currentAt, reasonCode, summary) {
  checkpoint.state = 'needs-attention';
  checkpoint.phase = 'terminal';
  checkpoint.updatedAt = currentAt;
  checkpoint.failure = { reasonCode, summary };
  return persistCheckpoint(root, checkpoint);
}

export function recoverHostRealization({ root, checkpointId, at: currentAt, faultAfter = null }) {
  const resolvedRoot = path.resolve(root);
  const chain = readCheckpoint(resolvedRoot, checkpointId);
  const { checkpoint, plan } = chain;
  if (['completed', 'rolled-back', 'needs-attention'].includes(checkpoint.state)) return checkpoint;
  try {
    assertTarget(resolvedRoot, plan.target);
    const candidate = candidateManifest(plan, checkpoint);
    const manifest = manifestSnapshot(resolvedRoot, plan.host.id);
    const manifestIsPrior = manifest.state === plan.manifest.state
      && manifest.fingerprint === plan.manifest.fingerprint;
    const manifestIsCandidate = manifest.state === 'present'
      && manifest.fingerprint === candidate.manifestFingerprint;
    if (!manifestIsPrior && !manifestIsCandidate) {
      return markNeedsAttention(
        resolvedRoot,
        checkpoint,
        currentAt,
        'HOST_REALIZATION_RECOVERY_STATE_UNKNOWN',
        'Managed manifest is neither the exact prior state nor the exact checkpoint candidate.'
      );
    }
    for (const [index, operation] of plan.operations.entries()) {
      const observed = presentSnapshot(resolvedRoot, operation.path);
      if (snapshotEquals(observed, operation.before)) {
        checkpoint.outputs[index].state = 'pending';
      } else if (snapshotEquals(observed, operation.after)) {
        checkpoint.outputs[index].state = 'applied';
      } else {
        return markNeedsAttention(
          resolvedRoot,
          checkpoint,
          currentAt,
          'HOST_REALIZATION_RECOVERY_STATE_UNKNOWN',
          'Managed output is neither its exact prior state nor exact candidate.'
        );
      }
      checkpoint.outputs[index].observedFingerprint = observed.fingerprint;
    }
    checkpoint.observation = {
      manifestFingerprint: manifest.fingerprint,
      outputFingerprint: checkpointOutputFingerprint(resolvedRoot, plan)
    };
    checkpoint.updatedAt = currentAt;
    persistCheckpoint(resolvedRoot, checkpoint);
    if (at(currentAt, 'Recovery time') > at(plan.validUntil, 'Plan expiry')) {
      return rollbackHostRealization(
        resolvedRoot,
        chain,
        currentAt,
        'HOST_REALIZATION_PLAN_EXPIRED',
        'Expired host realization checkpoint was rolled back instead of resumed.'
      );
    }
    return executeHostRealization({
      root: resolvedRoot,
      checkpointId,
      at: currentAt,
      faultAfter
    });
  } catch (error) {
    return markNeedsAttention(
      resolvedRoot,
      checkpoint,
      currentAt,
      stableFailureCode(error, 'HOST_REALIZATION_RECOVERY_FAILED'),
      'Host realization recovery could not establish one exact checkpoint state.'
    );
  }
}

function lifecycleRecord(value, property, state, recordAt = null) {
  return value ? {
    id: value.id,
    fingerprint: value[property],
    state,
    at: recordAt
  } : null;
}

function confirmationRecord(value) {
  return value ? {
    id: value.id,
    fingerprint: value.confirmationFingerprint,
    state: 'confirmed',
    at: value.confirmedAt,
    actor: value.actor.id
  } : null;
}

function applicability(root, plan, currentAt, checkpoint) {
  if (checkpoint?.state === 'completed') return 'applied';
  if (at(currentAt, 'Inspection time') > at(plan.validUntil, 'Plan expiry')) return 'expired';
  try {
    planCurrentness(root, plan, currentAt);
    return 'current';
  } catch {
    return 'stale';
  }
}

function resumeProjection({ planState, request, confirmation, consumption, checkpoint, currentAt }) {
  if (checkpoint?.state === 'completed') {
    return {
      classification: 'unavailable',
      reasonCode: 'HOST_REALIZATION_COMPLETED',
      reason: 'The exact deterministic local projection is complete.',
      permittedNextAction: 'none'
    };
  }
  if (checkpoint?.state === 'needs-attention') {
    return {
      classification: 'requires-review',
      reasonCode: checkpoint.failure?.reasonCode || 'HOST_REALIZATION_NEEDS_ATTENTION',
      reason: 'Checkpoint state requires exact local inspection before any further action.',
      permittedNextAction: 'inspect-checkpoint'
    };
  }
  if (checkpoint?.state === 'prepared') {
    return {
      classification: planState === 'current' ? 'safe' : 'requires-review',
      reasonCode: planState === 'current'
        ? 'HOST_REALIZATION_CHECKPOINT_READY'
        : 'HOST_REALIZATION_CHECKPOINT_REVIEW_REQUIRED',
      reason: planState === 'current'
        ? 'The one-time start is bound to an exact prepared checkpoint.'
        : 'The prepared checkpoint must be inspected because its plan is no longer current.',
      permittedNextAction: planState === 'current' ? 'execute-checkpoint' : 'inspect-checkpoint'
    };
  }
  if (checkpoint && checkpoint.state !== 'rolled-back') {
    return {
      classification: planState === 'current' ? 'safe' : 'requires-review',
      reasonCode: planState === 'current'
        ? 'HOST_REALIZATION_CHECKPOINT_RECOVERABLE'
        : 'HOST_REALIZATION_CHECKPOINT_REVIEW_REQUIRED',
      reason: planState === 'current'
        ? 'The exact checkpoint may continue through Core recovery.'
        : 'The exact checkpoint must be inspected because its plan is no longer current.',
      permittedNextAction: planState === 'current' ? 'recover-checkpoint' : 'inspect-checkpoint'
    };
  }
  if (planState !== 'current') {
    return {
      classification: 'unavailable',
      reasonCode: planState === 'expired' ? 'HOST_REALIZATION_PLAN_EXPIRED' : 'HOST_REALIZATION_PLAN_STALE',
      reason: 'The private host realization plan is no longer current.',
      permittedNextAction: 'replan'
    };
  }
  if (confirmation) {
    return {
      classification: 'safe',
      reasonCode: 'HOST_REALIZATION_CONFIRMATION_CURRENT',
      reason: 'The exact confirmation may be consumed once before its request expires.',
      permittedNextAction: 'start'
    };
  }
  if (request) {
    const expired = at(currentAt, 'Inspection time') > at(request.expiresAt, 'Request expiry');
    return expired ? {
      classification: 'unavailable',
      reasonCode: 'HOST_REALIZATION_REQUEST_EXPIRED',
      reason: 'The exact confirmation request expired.',
      permittedNextAction: 'request-confirmation'
    } : {
      classification: 'safe',
      reasonCode: 'HOST_REALIZATION_CONFIRMATION_PENDING',
      reason: 'The exact expiring request is awaiting local operator confirmation.',
      permittedNextAction: 'confirm'
    };
  }
  return {
    classification: 'safe',
    reasonCode: 'HOST_REALIZATION_PLAN_CURRENT',
    reason: 'The exact private plan is current and may request confirmation.',
    permittedNextAction: 'request-confirmation'
  };
}

export function inspectHostRealization({
  root,
  planId,
  requestId = null,
  confirmationId = null,
  consumptionId = null,
  checkpointId = null,
  at: currentAt
}) {
  const resolvedRoot = path.resolve(root);
  const plan = readPlan(resolvedRoot, planId);
  const request = requestId ? readRequest(resolvedRoot, requestId).request : null;
  const confirmation = confirmationId
    ? readConfirmation(resolvedRoot, confirmationId).confirmation
    : null;
  const consumption = consumptionId
    ? readConsumption(resolvedRoot, consumptionId).consumption
    : null;
  const checkpoint = checkpointId ? readCheckpoint(resolvedRoot, checkpointId).checkpoint : null;
  if ((request && request.plan.id !== plan.id)
    || (confirmation && confirmation.plan.id !== plan.id)
    || (consumption && consumption.plan.id !== plan.id)
    || (checkpoint && checkpoint.plan.id !== plan.id)) {
    fail('HOST_REALIZATION_INSPECTION_BINDING_INVALID', 'Inspection references do not bind one exact host realization plan.');
  }
  const planState = applicability(resolvedRoot, plan, currentAt, checkpoint);
  const inspection = {
    $contract: CONTRACTS.inspection[0],
    contractVersion: '1.0.0',
    plan: {
      id: plan.id,
      fingerprint: plan.planFingerprint,
      createdAt: plan.createdAt,
      validUntil: plan.validUntil,
      applicability: planState
    },
    target: { fingerprint: plan.target.fingerprint },
    host: clone(plan.host),
    configuration: {
      name: plan.configuration.name,
      lockFingerprint: plan.configuration.lockFingerprint,
      graphFingerprint: plan.configuration.graphFingerprint
    },
    scope: {
      fingerprint: plan.scopeFingerprint,
      outputs: scopeRows(plan.operations)
    },
    request: lifecycleRecord(
      request,
      'requestFingerprint',
      request && at(currentAt, 'Inspection time') > at(request.expiresAt, 'Request expiry')
        ? 'expired'
        : 'current',
      request?.expiresAt || null
    ),
    confirmation: confirmationRecord(confirmation),
    consumption: lifecycleRecord(
      consumption,
      'consumptionFingerprint',
      consumption?.state || 'reserved',
      consumption?.updatedAt || null
    ),
    checkpoint: checkpoint ? {
      id: checkpoint.id,
      fingerprint: checkpoint.checkpointFingerprint,
      state: checkpoint.state,
      phase: checkpoint.phase,
      currentOutputId: checkpoint.currentOutputId,
      outputs: checkpoint.outputs.map(({ id, sequence, state }) => ({ id, sequence, state })),
      failure: clone(checkpoint.failure)
    } : null,
    resume: resumeProjection({
      planState,
      request,
      confirmation,
      consumption,
      checkpoint,
      currentAt
    }),
    claims: {
      localProjection: checkpoint?.state === 'completed' ? 'passed' : 'unknown',
      hostLaunch: 'unknown',
      toolDiscovery: 'unknown',
      authentication: 'unknown',
      providerReachability: 'unknown',
      connectedBehavior: 'unknown',
      health: 'unknown'
    },
    inspectionFingerprint: null
  };
  seal(inspection, 'inspectionFingerprint');
  return assertFingerprint(
    resolvedRoot,
    inspection,
    'inspection',
    'inspectionFingerprint',
    'Host realization inspection'
  );
}
