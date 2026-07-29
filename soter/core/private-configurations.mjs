import fs from 'node:fs';
import path from 'node:path';

import { readJson, repoRelativePath, resolveRepoPath } from './lib/canonical-json.mjs';

const SAFE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRIVATE_CONFIGURATION_ROOT = '.soter/state/configurations';

export class PrivateConfigurationStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrivateConfigurationStateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PrivateConfigurationStateError(code, message);
}

function assertNoSymlinkAncestors(directory) {
  const ancestors = [path.dirname(path.dirname(directory)), path.dirname(directory), directory];
  for (const item of ancestors) {
    if (!fs.existsSync(item)) continue;
    const stat = fs.lstatSync(item);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('CONFIGURATION_PRIVATE_STATE_INVALID', 'Private desired configuration parent is invalid.');
    }
  }
}

function safeName(name) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) {
    fail('CONFIGURATION_NAME_INVALID', 'Private desired configuration name is invalid.');
  }
  return name;
}

function assertPrivateDirectory(directory) {
  assertNoSymlinkAncestors(directory);
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('CONFIGURATION_PRIVATE_STATE_INVALID', 'Private desired configuration directory is invalid.');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o700) {
    fail('CONFIGURATION_PRIVATE_STATE_PERMISSIONS_INVALID', 'Private desired configuration directory must use mode 0700.');
  }
}

function assertPrivateFile(file) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail('CONFIGURATION_PRIVATE_STATE_INVALID', 'Private desired configuration must be one regular unlinked file.');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600) {
    fail('CONFIGURATION_PRIVATE_STATE_PERMISSIONS_INVALID', 'Private desired configuration must use mode 0600.');
  }
}

function ensurePrivateDirectory(directory) {
  assertNoSymlinkAncestors(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(directory);
  const stateRoot = path.dirname(directory);
  for (const item of [stateRoot, directory]) {
    try {
      fs.chmodSync(item, 0o700);
    } catch {
      // Some filesystems do not expose POSIX permission changes.
    }
  }
  assertPrivateDirectory(directory);
}

export function privateConfigurationStatePath(root, name) {
  return resolveRepoPath(
    root,
    path.join(PRIVATE_CONFIGURATION_ROOT, safeName(name) + '.json')
  );
}

export function isPrivateConfigurationPath(root, requestedPath) {
  const file = resolveRepoPath(root, requestedPath);
  const directory = resolveRepoPath(root, PRIVATE_CONFIGURATION_ROOT);
  return path.dirname(file) === directory && SAFE_NAME.test(path.basename(file, '.json'))
    && path.extname(file) === '.json';
}

export function hasPrivateConfigurationState(root, name) {
  const file = privateConfigurationStatePath(root, name);
  if (!fs.existsSync(file)) return false;
  assertPrivateDirectory(path.dirname(file));
  assertPrivateFile(file);
  return true;
}

export function readPrivateConfigurationState(root, name) {
  const file = privateConfigurationStatePath(root, name);
  if (!fs.existsSync(file)) {
    fail('CONFIGURATION_PRIVATE_STATE_MISSING', 'Private desired configuration is unavailable.');
  }
  assertPrivateDirectory(path.dirname(file));
  assertPrivateFile(file);
  let configuration;
  try {
    configuration = readJson(file);
  } catch {
    fail('CONFIGURATION_PRIVATE_STATE_MALFORMED', 'Private desired configuration is malformed.');
  }
  if (configuration?.$contract !== 'soter://contracts/configuration/v1'
    || configuration?.contractVersion !== '1.0.0'
    || configuration?.name !== name) {
    fail('CONFIGURATION_PRIVATE_STATE_MALFORMED', 'Private desired configuration identity is invalid.');
  }
  return { file, path: repoRelativePath(root, file), configuration };
}

export function writePrivateConfigurationState(root, name, configuration) {
  if (configuration?.$contract !== 'soter://contracts/configuration/v1'
    || configuration?.contractVersion !== '1.0.0'
    || configuration?.name !== name) {
    fail('CONFIGURATION_PRIVATE_STATE_MALFORMED', 'Private desired configuration identity is invalid.');
  }
  const file = privateConfigurationStatePath(root, name);
  const directory = path.dirname(file);
  ensurePrivateDirectory(directory);
  if (fs.existsSync(file)) assertPrivateFile(file);
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(configuration, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
      const directoryDescriptor = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch {
      // Some filesystems do not support POSIX permissions or directory fsync.
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  assertPrivateFile(file);
  return { file, path: repoRelativePath(root, file) };
}

export function removePrivateConfigurationState(root, name) {
  const file = privateConfigurationStatePath(root, name);
  if (fs.existsSync(file)) {
    assertPrivateFile(file);
    fs.rmSync(file);
  }
  return { file, path: repoRelativePath(root, file) };
}
