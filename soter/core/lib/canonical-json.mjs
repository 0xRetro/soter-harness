import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}

export function fingerprintJson(value) {
  return sha256(canonicalJson(value));
}

export function fingerprintFile(file) {
  return sha256(fs.readFileSync(file));
}

function walkFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      } else if (entry.isFile()) {
        files.push(target);
      }
    }
  };
  visit(directory);
  return files.sort();
}

export function fingerprintPath(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return fingerprintFile(target);
  }
  if (!stat.isDirectory()) {
    throw new Error('Cannot fingerprint non-file path: ' + target);
  }
  const entries = walkFiles(target).map((file) => ({
    path: path.relative(target, file).split(path.sep).join('/'),
    fingerprint: fingerprintFile(file)
  }));
  return fingerprintJson({ type: 'directory', entries });
}

function governedRoot(root) {
  const resolved = path.resolve(root);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Governed repository root must be one exact ordinary directory.');
  }
  return {
    path: resolved,
    realpath: fs.realpathSync(resolved)
  };
}

function governedFileState(root, requestedPath) {
  const exactRoot = governedRoot(root);
  const resolved = resolveRepoPath(exactRoot.path, requestedPath);
  const relative = path.relative(exactRoot.path, resolved);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Governed artifact must be one exact repository-relative file.');
  }
  const parts = relative.split(path.sep);
  let current = exactRoot.path;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error('Governed artifact path cannot contain symbolic links.');
    }
    const leaf = index === parts.length - 1;
    if ((!leaf && !stat.isDirectory())
      || (leaf && (!stat.isFile() || stat.nlink !== 1))) {
      throw new Error(
        leaf
          ? 'Governed artifact must be one exact ordinary singly linked file.'
          : 'Governed artifact parent must be one exact ordinary directory.'
      );
    }
  }
  const realpath = fs.realpathSync(resolved);
  if (realpath !== exactRoot.realpath
    && !realpath.startsWith(exactRoot.realpath + path.sep)) {
    throw new Error('Governed artifact real path escapes the repository root.');
  }
  const stat = fs.lstatSync(resolved);
  return {
    path: resolved,
    realpath,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
    nlink: stat.nlink
  };
}

function sameGovernedFile(left, right) {
  return left.path === right.path
    && left.realpath === right.realpath
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

export function resolveGovernedFile(root, requestedPath) {
  return governedFileState(root, requestedPath).path;
}

function readBoundedDescriptor(descriptor, maxBytes) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (read === 0) break;
    offset += read;
  }
  if (offset > maxBytes) {
    throw new Error('Governed artifact exceeds its exact bounded read limit.');
  }
  return buffer.subarray(0, offset);
}

export function readGovernedFile(root, requestedPath, { maxBytes = null } = {}) {
  if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error('Governed artifact bounded read limit must be a non-negative safe integer.');
  }
  const before = governedFileState(root, requestedPath);
  if (maxBytes !== null && before.size > maxBytes) {
    throw new Error('Governed artifact exceeds its exact bounded read limit.');
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(before.path, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Governed artifact changed before its exact read.');
    }
    if (maxBytes !== null && opened.size > maxBytes) {
      throw new Error('Governed artifact exceeds its exact bounded read limit.');
    }
    const bytes = maxBytes === null
      ? fs.readFileSync(descriptor)
      : readBoundedDescriptor(descriptor, maxBytes);
    const afterRead = fs.fstatSync(descriptor);
    const after = governedFileState(root, requestedPath);
    if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino
      || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs
      || afterRead.mode !== opened.mode || afterRead.nlink !== 1
      || !sameGovernedFile(before, after)) {
      throw new Error('Governed artifact changed during its exact read.');
    }
    return {
      path: before.path,
      bytes,
      fingerprint: sha256(bytes),
      state: before
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function fingerprintGovernedFile(root, requestedPath) {
  return readGovernedFile(root, requestedPath).fingerprint;
}

export function readGovernedJson(root, requestedPath) {
  const exact = readGovernedFile(root, requestedPath);
  return JSON.parse(exact.bytes.toString('utf8'));
}

export async function importGovernedModule(root, requestedPath) {
  const before = readGovernedFile(root, requestedPath);
  const imported = await import(
    pathToFileURL(before.path).href
      + '?soter-governed-artifact='
      + before.fingerprint.slice('sha256:'.length)
  );
  const after = readGovernedFile(root, requestedPath);
  if (before.fingerprint !== after.fingerprint
    || !sameGovernedFile(before.state, after.state)) {
    throw new Error('Governed module changed during its exact import.');
  }
  return imported;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readPrivateJsonInput(root, requestedPath, { maxBytes = null } = {}) {
  if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
    throw new Error('Private input byte bound is invalid.');
  }
  if (!path.isAbsolute(requestedPath)) {
    throw new Error('Private input path must be absolute and outside the repository: ' + requestedPath);
  }
  const realRoot = fs.realpathSync(path.resolve(root));
  const resolvedInput = path.resolve(requestedPath);
  const inputStat = fs.lstatSync(resolvedInput);
  const realInput = fs.realpathSync(resolvedInput);
  const inputDirectory = path.dirname(resolvedInput);
  const directoryStat = fs.lstatSync(inputDirectory);
  const realDirectory = fs.realpathSync(inputDirectory);
  if (realInput === realRoot || realInput.startsWith(realRoot + path.sep)) {
    throw new Error('Private input path must remain outside the repository: ' + requestedPath);
  }
  if (realInput !== resolvedInput || realDirectory !== inputDirectory
    || inputStat.isSymbolicLink() || !inputStat.isFile() || inputStat.nlink !== 1) {
    throw new Error('Private input path must be one non-linked regular file: ' + requestedPath);
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Private input directory must be one non-linked directory: ' + inputDirectory);
  }
  if (process.platform !== 'win32'
    && ((inputStat.mode & 0o7777) !== 0o600
      || (directoryStat.mode & 0o7777) !== 0o700)) {
    throw new Error(
      'Private input file and directory must use modes 0600 and 0700: ' + requestedPath
    );
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      resolvedInput,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1
      || before.dev !== inputStat.dev || before.ino !== inputStat.ino
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o600)) {
      throw new Error('Private input path changed before its exact read: ' + requestedPath);
    }
    if (maxBytes !== null && before.size > maxBytes) {
      throw new Error('Private input exceeds its exact byte bound: ' + requestedPath);
    }
    let bytes;
    if (maxBytes === null) {
      bytes = fs.readFileSync(descriptor);
    } else {
      const chunks = [];
      let total = 0;
      while (total <= maxBytes) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
        const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
        if (count === 0) break;
        chunks.push(chunk.subarray(0, count));
        total += count;
      }
      if (total > maxBytes) {
        throw new Error('Private input exceeds its exact byte bound: ' + requestedPath);
      }
      bytes = Buffer.concat(chunks, total);
    }
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size
      || (maxBytes !== null && after.size > maxBytes)
      || after.nlink !== 1 || fs.realpathSync(resolvedInput) !== realInput
      || (process.platform !== 'win32' && (after.mode & 0o7777) !== 0o600)) {
      throw new Error('Private input path changed during its exact read: ' + requestedPath);
    }
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function resolveRepoPath(root, requestedPath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requestedPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Path escapes repository root: ' + requestedPath);
  }
  return resolved;
}

export function repoRelativePath(root, target) {
  return path.relative(path.resolve(root), path.resolve(target)).split(path.sep).join('/');
}
