import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from './lib/canonical-json.mjs';

function fail(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}
function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function isInside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

function exactExternalOutput(root, requestedPath) {
  if (typeof root !== 'string' || typeof requestedPath !== 'string'
    || !path.isAbsolute(requestedPath)) {
    fail(
      'PRIVATE_REQUEST_OUTPUT_PATH_INVALID',
      'Private request output must be one absolute path outside the repository.'
    );
  }
  let resolvedRoot;
  try {
    resolvedRoot = fs.realpathSync(path.resolve(root));
  } catch (error) {
    fail(
      'PRIVATE_REQUEST_OUTPUT_PATH_INVALID',
      'Private request repository root is unavailable.',
      error
    );
  }
  const output = path.resolve(requestedPath);
  const directory = path.dirname(output);
  let directoryStat;
  let realDirectory;
  try {
    directoryStat = fs.lstatSync(directory);
    realDirectory = fs.realpathSync(directory);
  } catch (error) {
    fail(
      'PRIVATE_REQUEST_OUTPUT_PATH_INVALID',
      'Private request output parent directory is unavailable.',
      error
    );
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || realDirectory !== directory
    || isInside(resolvedRoot, output)) {
    fail(
      'PRIVATE_REQUEST_OUTPUT_PATH_INVALID',
      'Private request output must remain outside the repository under one exact non-symlink directory.'
    );
  }
  return { directory, output };
}

function stableExistingBytes(file, expectedBytes) {
  let pathStat;
  let real;
  try {
    pathStat = fs.lstatSync(file);
    real = fs.realpathSync(file);
  } catch (error) {
    fail(
      'PRIVATE_REQUEST_OUTPUT_INVALID',
      'Existing private request output is unavailable.',
      error
    );
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1
    || real !== file
    || (process.platform !== 'win32' && (pathStat.mode & 0o7777) !== 0o600)) {
    fail(
      'PRIVATE_REQUEST_OUTPUT_INVALID',
      'Existing private request output must be one exact non-linked regular file with mode 0600.'
    );
  }
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1
      || before.dev !== pathStat.dev || before.ino !== pathStat.ino
      || before.size !== pathStat.size || before.mtimeMs !== pathStat.mtimeMs
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o600)) {
      fail(
        'PRIVATE_REQUEST_OUTPUT_INVALID',
        'Existing private request output changed before its exact read.'
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || after.nlink !== 1
      || (process.platform !== 'win32' && (after.mode & 0o7777) !== 0o600)) {
      fail(
        'PRIVATE_REQUEST_OUTPUT_INVALID',
        'Existing private request output changed while it was read.'
      );
    }
    if (!bytes.equals(expectedBytes)) {
      fail(
        'PRIVATE_REQUEST_OUTPUT_EXISTS_DIFFERENT',
        'Private request output already exists with different canonical content.'
      );
    }
    return bytes;
  } catch (error) {
    if (error?.code?.startsWith('PRIVATE_REQUEST_')) throw error;
    fail(
      'PRIVATE_REQUEST_OUTPUT_INVALID',
      'Existing private request output could not be read exactly.',
      error
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/**
 * Persist one already-built, closed request document without changing it.
 *
 * Publication uses an exclusive temporary file followed by an exclusive
 * same-directory link, so an existing output is never overwritten. Exact
 * re-entry is accepted only when the existing file is the same canonical
 * bytes, mode 0600, and has one link. The returned receipt is deliberately
 * non-authoritative and never contains the request document itself.
 */
export function persistCanonicalPrivateRequest({
  root,
  outputPath,
  request,
  kind,
  ...unknown
} = {}) {
  if (Object.keys(unknown).length || !request || typeof request !== 'object'
    || Array.isArray(request) || typeof kind !== 'string' || kind.length < 1) {
    fail(
      'PRIVATE_REQUEST_OUTPUT_ARGUMENTS_INVALID',
      'Private request persistence requires one exact root, output, kind, and request document.'
    );
  }
  const { directory, output } = exactExternalOutput(root, outputPath);
  const bytes = canonicalBytes(request);
  const contentFingerprint = sha256(bytes);
  if (fs.existsSync(output)) {
    stableExistingBytes(output, bytes);
    return {
      persisted: true,
      created: false,
      kind,
      requestFingerprint: request.requestFingerprint || contentFingerprint,
      contentFingerprint,
      authority: {
        executionGranted: false,
        repositoryWritesGranted: false,
        fixtureWritesGranted: false,
        fallbackRemovalGranted: false
      }
    };
  }

  const temporary = path.join(
    directory,
    '.' + path.basename(output) + '.pending.'
      + process.pid + '.' + crypto.randomBytes(12).toString('hex')
  );
  let descriptor;
  let temporaryCreated = false;
  let published = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    temporaryCreated = true;
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    stableExistingBytes(temporary, bytes);
    try {
      fs.linkSync(temporary, output);
      published = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    fs.unlinkSync(temporary);
    temporaryCreated = false;
    fsyncDirectory(directory);
    stableExistingBytes(output, bytes);
    return {
      persisted: true,
      created: published,
      kind,
      requestFingerprint: request.requestFingerprint || contentFingerprint,
      contentFingerprint,
      authority: {
        executionGranted: false,
        repositoryWritesGranted: false,
        fixtureWritesGranted: false,
        fallbackRemovalGranted: false
      }
    };
  } catch (error) {
    if (error?.code?.startsWith('PRIVATE_REQUEST_')) throw error;
    fail(
      'PRIVATE_REQUEST_OUTPUT_INVALID',
      'Private request output could not be published atomically.',
      error
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryCreated && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
