import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readPrivateJsonInput(root, requestedPath) {
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
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
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
