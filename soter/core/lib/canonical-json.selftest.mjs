#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readGovernedFile,
  readPrivateJsonInput
} from './canonical-json.mjs';

const file = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(file), '..', '..', '..');
function writePrivateInput(target, value = { state: 'private' }) {
  fs.writeFileSync(target, JSON.stringify(value) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
}

function rejects(run, pattern) {
  assert.throws(run, pattern);
}

export function selftestPrivateJsonInput() {
  const temporaryRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'soter-private-json-input-'))
  );
  const privateDirectory = path.join(temporaryRoot, 'private');
  const privateInput = path.join(privateDirectory, 'input.json');
  try {
    fs.mkdirSync(privateDirectory, { mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(privateDirectory, 0o700);
    writePrivateInput(privateInput);

    assert.deepEqual(
      readPrivateJsonInput(repositoryRoot, privateInput),
      { state: 'private' }
    );
    rejects(
      () => readPrivateJsonInput(repositoryRoot, 'relative-input.json'),
      /absolute and outside/
    );
    rejects(
      () => readPrivateJsonInput(repositoryRoot, path.join(repositoryRoot, 'package.json')),
      /outside the repository/
    );

    const directoryInput = path.join(privateDirectory, 'directory.json');
    fs.mkdirSync(directoryInput);
    rejects(
      () => readPrivateJsonInput(repositoryRoot, directoryInput),
      /non-linked regular file/
    );

    const hardlinkedInput = path.join(privateDirectory, 'hardlinked.json');
    fs.linkSync(privateInput, hardlinkedInput);
    rejects(
      () => readPrivateJsonInput(repositoryRoot, hardlinkedInput),
      /non-linked regular file/
    );
    fs.unlinkSync(hardlinkedInput);

    if (process.platform !== 'win32') {
      const linkedInput = path.join(privateDirectory, 'linked.json');
      fs.symlinkSync(privateInput, linkedInput);
      rejects(
        () => readPrivateJsonInput(repositoryRoot, linkedInput),
        /non-linked regular file/
      );
      fs.unlinkSync(linkedInput);

      const realParent = path.join(temporaryRoot, 'real-parent');
      const linkedParent = path.join(temporaryRoot, 'linked-parent');
      fs.mkdirSync(realParent, { mode: 0o700 });
      fs.chmodSync(realParent, 0o700);
      const parentInput = path.join(realParent, 'input.json');
      writePrivateInput(parentInput);
      fs.symlinkSync(realParent, linkedParent, 'dir');
      rejects(
        () => readPrivateJsonInput(repositoryRoot, path.join(linkedParent, 'input.json')),
        /non-linked regular file/
      );

      fs.chmodSync(privateInput, 0o644);
      rejects(
        () => readPrivateJsonInput(repositoryRoot, privateInput),
        /modes 0600 and 0700/
      );
      fs.chmodSync(privateInput, 0o600);

      fs.chmodSync(privateDirectory, 0o755);
      rejects(
        () => readPrivateJsonInput(repositoryRoot, privateInput),
        /modes 0600 and 0700/
      );
      fs.chmodSync(privateDirectory, 0o700);

      const governedRoot = path.join(temporaryRoot, 'governed-root');
      const governedOutside = path.join(temporaryRoot, 'governed-outside');
      fs.mkdirSync(governedRoot);
      fs.mkdirSync(governedOutside);
      fs.writeFileSync(
        path.join(governedOutside, 'adapter.mjs'),
        'export const source = "outside";\n'
      );
      fs.symlinkSync(governedOutside, path.join(governedRoot, 'linked-parent'), 'dir');
      rejects(
        () => readGovernedFile(governedRoot, 'linked-parent/adapter.mjs'),
        /symbolic links/
      );
    }

    process.stdout.write('Private JSON input and governed artifact selftest passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === file) {
  selftestPrivateJsonInput();
}
