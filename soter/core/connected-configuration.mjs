import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { listProviderDeclarations } from './capabilities.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import {
  hasPrivateConfigurationState,
  privateConfigurationStatePath,
  readPrivateConfigurationState
} from './private-configurations.mjs';
import {
  fingerprintLock,
  lockMatchesResolution
} from './resolve.mjs';
import {
  activeConfigurationLockStatePath,
  hasActiveConfigurationLockState,
  readActiveConfigurationLockState
} from './runtime-state.mjs';

const CONFIGURATION_BASES = new Set(['tracked-contained', 'private-active']);
const SAFE_CONFIGURATION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ConnectedConfigurationError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ConnectedConfigurationError';
    this.code = code;
  }
}

function fail(code, message, cause = null) {
  throw new ConnectedConfigurationError(code, message, cause);
}

function validateLock(root, lock) {
  let schema;
  try {
    schema = readJson(path.join(root, 'soter/contracts/lock.schema.json'));
  } catch (error) {
    fail(
      'CONNECTED_CONFIGURATION_LOCK_INVALID',
      'The selected configuration lock contract is unavailable.',
      error
    );
  }
  const failures = validateJsonSchema(lock, schema);
  if (failures.length) {
    fail(
      'CONNECTED_CONFIGURATION_LOCK_INVALID',
      'The selected configuration lock is malformed.'
    );
  }
}

function readExactRegularFile(
  root,
  file,
  code,
  message,
  { privateMode = false, privateDirectory = false } = {}
) {
  const relative = path.relative(root, file);
  if (!relative
    || relative === '..'
    || relative.startsWith('..' + path.sep)
    || path.isAbsolute(relative)) {
    fail(code, message);
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    let component;
    try {
      component = fs.lstatSync(current);
    } catch (error) {
      fail(code, message, error);
    }
    if (component.isSymbolicLink()) fail(code, message);
  }
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    fail(code, message, error);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (privateMode && process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)) {
    fail(code, message);
  }
  if (privateDirectory) {
    let directory;
    try {
      directory = fs.lstatSync(path.dirname(file));
    } catch (error) {
      fail(code, message, error);
    }
    if (!directory.isDirectory()
      || directory.isSymbolicLink()
      || (process.platform !== 'win32' && (directory.mode & 0o7777) !== 0o700)) {
      fail(code, message);
    }
  }
  return stat;
}

function configurationStatePair(root, name) {
  let desired;
  let activeLock;
  try {
    desired = hasPrivateConfigurationState(root, name);
    activeLock = hasActiveConfigurationLockState(root, name);
  } catch (error) {
    fail(
      'CONNECTED_CONFIGURATION_PRIVATE_STATE_INVALID',
      'Private desired configuration or active exact lock state is malformed or unsafe.',
      error
    );
  }
  if (desired !== activeLock) {
    fail(
      'CONNECTED_CONFIGURATION_HALF_STATE',
      'Private desired configuration and active exact lock must both exist or both be absent.'
    );
  }
  return { desired, activeLock };
}

function requestedPrivateConfigurationName(root, lockPath) {
  let lockFile;
  try {
    lockFile = resolveRepoPath(root, lockPath);
  } catch (error) {
    fail(
      'CONNECTED_CONFIGURATION_PRIVATE_PATH_MISMATCH',
      'Private-active configuration lock path is invalid.',
      error
    );
  }
  const directory = path.dirname(activeConfigurationLockStatePath(root, 'configuration'));
  const name = path.basename(lockFile, '.json');
  if (path.dirname(lockFile) !== directory
    || path.extname(lockFile) !== '.json'
    || !SAFE_CONFIGURATION_NAME.test(name)
    || lockFile !== activeConfigurationLockStatePath(root, name)) {
    fail(
      'CONNECTED_CONFIGURATION_PRIVATE_PATH_MISMATCH',
      'Private-active configuration requires the exact private active-lock path.'
    );
  }
  const state = configurationStatePair(root, name);
  if (!state.desired || !state.activeLock) {
    fail(
      'CONNECTED_CONFIGURATION_PRIVATE_STATE_MISSING',
      'Private-active configuration requires the exact private desired configuration and active lock.'
    );
  }
  return name;
}

function exactProviderDeclarations(root, providerImplementations) {
  if (!Array.isArray(providerImplementations)
    || providerImplementations.length < 1
    || providerImplementations.some((id) => typeof id !== 'string' || !id)
    || new Set(providerImplementations).size !== providerImplementations.length) {
    fail(
      'CONNECTED_CONFIGURATION_PROVIDER_SCOPE_INVALID',
      'Connected configuration selection requires unique exact provider implementations.'
    );
  }
  let declarations;
  try {
    declarations = listProviderDeclarations(root);
  } catch (error) {
    fail(
      'CONNECTED_CONFIGURATION_PROVIDER_SCOPE_INVALID',
      'Connected configuration provider declarations are unavailable or invalid.',
      error
    );
  }
  return providerImplementations.map((id) => {
    const matches = declarations.filter((provider) => provider.id === id);
    if (matches.length !== 1) {
      fail(
        'CONNECTED_CONFIGURATION_PROVIDER_SCOPE_INVALID',
        'Connected configuration selection references an unavailable provider implementation.'
      );
    }
    return matches[0];
  });
}

function assertCurrentLock({ root, lock, configPath, host, label }) {
  let current;
  try {
    current = lockMatchesResolution({
      root,
      lock,
      configPath,
      host
    });
  } catch (error) {
    fail(
      'CONNECTED_CONFIGURATION_LOCK_STALE',
      label + ' configuration lock cannot be reproduced from the current governed graph.',
      error
    );
  }
  if (!current.matches) {
    fail(
      'CONNECTED_CONFIGURATION_LOCK_STALE',
      label + ' configuration lock is stale.'
    );
  }
}

function assertBasisProviderScope(root, configurationBasis, providerImplementations) {
  const providers = exactProviderDeclarations(root, providerImplementations);
  if (configurationBasis === 'private-active') {
    if (providers.some((provider) => provider.containment !== 'connected'
      || provider.runtime?.engine !== 'mcp')) {
      fail(
        'CONNECTED_CONFIGURATION_PROVIDER_SCOPE_INVALID',
        'Private-active host execution requires exact connected MCP providers.'
      );
    }
    return providers;
  }
  if (providers.some((provider) => provider.containment !== 'fixture'
    || provider.runtime?.engine !== 'node'
    || !Array.isArray(provider.fixtures)
    || provider.fixtures.length < 1)) {
    fail(
      'CONNECTED_CONFIGURATION_BASIS_PROHIBITED',
      'Tracked-contained configuration can authorize only mechanically contained fixture providers.'
    );
  }
  return providers;
}

function assertProvidersSelectedByLock(lock, providers) {
  for (const provider of providers) {
    const packSelected = lock.packs.some((pack) => pack.id === provider.pack);
    const capabilitySelected = provider.capabilities.some((capability) => {
      return lock.bindings.some((binding) => {
        return binding.providerPack === provider.pack
          && binding.capability === capability.id
          && binding.capabilityVersion === capability.version;
      });
    });
    if (!packSelected || !capabilitySelected) {
      fail(
        'CONNECTED_CONFIGURATION_PROVIDER_SCOPE_INVALID',
        'Connected configuration provider scope is not selected by the exact lock.'
      );
    }
  }
}

function exactTrackedConfiguration({
  root,
  lockFile,
  lock,
  configurationBasis
}) {
  const name = lock.configuration.name;
  const state = configurationStatePair(root, name);
  if (state.desired || state.activeLock) {
    fail(
      'CONNECTED_CONFIGURATION_SOURCE_SWITCH',
      'Tracked-contained configuration cannot bypass an existing private-active selection.'
    );
  }
  const lockPath = repoRelativePath(root, lockFile);
  const configurationPath = lock.configuration.path;
  if (!lockPath.startsWith('soter/fixtures/')
    || !lockPath.endsWith('.lock.json')
    || !configurationPath.startsWith('soter/configurations/')
    || !configurationPath.endsWith('.config.json')) {
    fail(
      'CONNECTED_CONFIGURATION_TRACKED_PATH_INVALID',
      'Tracked-contained configuration requires one checked-in configuration and fixture lock.'
    );
  }
  readExactRegularFile(
    root,
    resolveRepoPath(root, configurationPath),
    'CONNECTED_CONFIGURATION_TRACKED_PATH_INVALID',
    'Tracked-contained configuration source is unavailable or unsafe.'
  );
  assertCurrentLock({
    root,
    lock,
    configPath: configurationPath,
    host: lock.host.id,
    label: 'Tracked-contained'
  });
  return {
    name,
    configurationBasis,
    path: configurationPath,
    lockPath,
    lockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint
  };
}

function exactPrivateConfiguration({
  root,
  lockFile,
  lock,
  configurationBasis
}) {
  const name = lock.configuration.name;
  const state = configurationStatePair(root, name);
  if (!state.desired || !state.activeLock) {
    fail(
      'CONNECTED_CONFIGURATION_PRIVATE_STATE_MISSING',
      'Private-active configuration requires the exact private desired configuration and active lock.'
    );
  }
  const desiredFile = privateConfigurationStatePath(root, name);
  const activeLockFile = activeConfigurationLockStatePath(root, name);
  const expectedPath = repoRelativePath(root, desiredFile);
  const expectedLockPath = repoRelativePath(root, activeLockFile);
  const suppliedLockPath = repoRelativePath(root, lockFile);
  if (suppliedLockPath !== expectedLockPath
    || lock.configuration.path !== expectedPath) {
    fail(
      'CONNECTED_CONFIGURATION_PRIVATE_PATH_MISMATCH',
      'Private-active configuration paths do not match the exact private desired state and active lock.'
    );
  }
  readExactRegularFile(
    root,
    activeLockFile,
    'CONNECTED_CONFIGURATION_PRIVATE_STATE_INVALID',
    'Private active configuration lock is unavailable or unsafe.',
    { privateMode: true, privateDirectory: true }
  );
  let desired;
  let active;
  try {
    desired = readPrivateConfigurationState(root, name);
    active = readActiveConfigurationLockState(root, name);
  } catch (error) {
    fail(
      'CONNECTED_CONFIGURATION_PRIVATE_STATE_INVALID',
      'Private-active configuration state is malformed or unsafe.',
      error
    );
  }
  if (desired.path !== expectedPath
    || desired.configuration.name !== name
    || fingerprintJson(active.lock) !== fingerprintJson(lock)) {
    fail(
      'CONNECTED_CONFIGURATION_PRIVATE_STATE_MISMATCH',
      'Private desired configuration and active lock do not match the exact selected state.'
    );
  }
  assertCurrentLock({
    root,
    lock,
    configPath: expectedPath,
    host: lock.host.id,
    label: 'Private-active'
  });
  return {
    name,
    configurationBasis,
    path: expectedPath,
    lockPath: expectedLockPath,
    lockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint
  };
}

export function selectExactConnectedConfiguration({
  root,
  configurationBasis,
  lockPath,
  expectedHost = null,
  providerImplementations
}) {
  const resolvedRoot = path.resolve(root);
  if (!CONFIGURATION_BASES.has(configurationBasis)) {
    fail(
      'CONNECTED_CONFIGURATION_BASIS_REQUIRED',
      'Connected execution requires explicit configurationBasis tracked-contained or private-active.'
    );
  }
  if (typeof lockPath !== 'string' || !lockPath) {
    fail(
      'CONNECTED_CONFIGURATION_LOCK_PATH_REQUIRED',
      'Connected execution requires one exact configuration lock path.'
    );
  }
  const requestedPrivateName = configurationBasis === 'private-active'
    ? requestedPrivateConfigurationName(resolvedRoot, lockPath)
    : null;
  let lockFile;
  let lock;
  try {
    lockFile = resolveRepoPath(resolvedRoot, lockPath);
    readExactRegularFile(
      resolvedRoot,
      lockFile,
      'CONNECTED_CONFIGURATION_LOCK_INVALID',
      'The selected configuration lock is unavailable or unsafe.'
    );
    lock = readJson(lockFile);
  } catch (error) {
    if (error instanceof ConnectedConfigurationError) throw error;
    fail(
      'CONNECTED_CONFIGURATION_LOCK_INVALID',
      'The selected configuration lock is unavailable or malformed.',
      error
    );
  }
  validateLock(resolvedRoot, lock);
  if (!SAFE_CONFIGURATION_NAME.test(lock.configuration.name)) {
    fail(
      'CONNECTED_CONFIGURATION_NAME_INVALID',
      'The selected configuration name is invalid.'
    );
  }
  if (requestedPrivateName && lock.configuration.name !== requestedPrivateName) {
    fail(
      'CONNECTED_CONFIGURATION_PRIVATE_STATE_MISMATCH',
      'Private active lock identity does not match its exact private state path.'
    );
  }
  if (expectedHost && lock.host.id !== expectedHost) {
    fail(
      'CONNECTED_CONFIGURATION_HOST_MISMATCH',
      'The selected configuration lock does not match the active host.'
    );
  }
  const providers = assertBasisProviderScope(
    resolvedRoot,
    configurationBasis,
    providerImplementations
  );
  assertProvidersSelectedByLock(lock, providers);
  const selection = configurationBasis === 'private-active'
    ? exactPrivateConfiguration({
      root: resolvedRoot,
      lockFile,
      lock,
      configurationBasis
    })
    : exactTrackedConfiguration({
      root: resolvedRoot,
      lockFile,
      lock,
      configurationBasis
    });
  return { selection, lockFile, lock };
}

export function revalidateExactConnectedConfiguration({
  root,
  selection,
  expectedHost = null,
  providerImplementations
}) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    fail(
      'CONNECTED_CONFIGURATION_BINDING_INVALID',
      'Connected execution has no exact configuration selection binding.'
    );
  }
  const observed = selectExactConnectedConfiguration({
    root,
    configurationBasis: selection.configurationBasis,
    lockPath: selection.lockPath,
    expectedHost,
    providerImplementations
  });
  if (fingerprintJson(observed.selection) !== fingerprintJson(selection)) {
    fail(
      'CONNECTED_CONFIGURATION_BINDING_STALE',
      'Connected execution configuration selection no longer matches its exact durable binding.'
    );
  }
  return observed;
}
