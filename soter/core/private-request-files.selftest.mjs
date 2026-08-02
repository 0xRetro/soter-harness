#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  persistCanonicalPrivateRequest
} from './private-request-files.mjs';

function canonicalBytes(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function expectCode(run, code) {
  assert.throws(run, (error) => error?.code === code, code);
}

export function selftestPrivateRequestFiles() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soter-request-root-')));
  const external = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'soter-request-output-'))
  );
  const request = {
    zPrivateSentinel: 'PRIVATE_REQUEST_DOCUMENT_SENTINEL',
    requestFingerprint: 'sha256:' + 'a'.repeat(64),
    $contract: 'soter://private/selftest-request/v1',
    nested: { z: 2, a: 1 }
  };
  try {
    const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const acquisitionCommands = ['operator-acquisition-prepare'];
    for (const command of acquisitionCommands) {
      for (const staleOption of ['--lock', '--run', '--query', '--snapshot']) {
        const rejected = spawnSync(process.execPath, [
          cliPath,
          command,
          '--root', root,
          '--json',
          '--automation', 'automation.argument-boundary-selftest',
          '--work', 'work.argument-boundary-selftest',
          '--at', '2026-07-25T12:00:00.000Z',
          staleOption, 'legacy-caller-selected-value'
        ], {
          encoding: 'utf8'
        });
        assert.notEqual(
          rejected.status,
          0,
          command + ' accepted stale caller-controlled option ' + staleOption + '.'
        );
        assert.equal(rejected.stdout, '');
        assert.match(
          rejected.stderr,
          new RegExp(
            'Unexpected argument for ' + command + ': ' + staleOption.replace('-', '\\-') + '\\.'
          )
        );
      }
    }
    const retiredAcquisitionAliases = [
      'context-connected-prepare',
      'context-connected-finalize',
      'email-context-connected-prepare',
      'email-context-connected-finalize',
      'slack-conversation-context-connected-prepare',
      'slack-conversation-context-connected-finalize',
      'slack-conversation-connected-inspect',
      'slack-conversation-connected-review',
      'task-context-connected-prepare',
      'task-context-connected-finalize',
      'organization-context-connected-prepare',
      'organization-context-connected-finalize',
      'project-capture-context-connected-prepare',
      'project-capture-context-connected-finalize',
      'contact-context-connected-prepare',
      'contact-context-connected-finalize',
      'project-context-connected-prepare',
      'project-context-connected-finalize'
    ];
    for (const command of retiredAcquisitionAliases) {
      const rejected = spawnSync(process.execPath, [
        cliPath,
        command,
        '--root', root,
        '--json'
      ], { encoding: 'utf8' });
      assert.notEqual(rejected.status, 0, command + ' remained an executable CLI bypass.');
      assert.equal(rejected.stdout, '');
      assert.match(rejected.stderr, /Usage: node soter\/core\/cli\.mjs/);
      assert.equal(
        rejected.stderr.includes('Private snapshot:'),
        false,
        command + ' exposed a private durable projection.'
      );
    }

    const output = path.join(external, 'request.json');
    const created = persistCanonicalPrivateRequest({
      root,
      outputPath: output,
      request,
      kind: 'selftest-request'
    });
    assert.equal(created.persisted, true);
    assert.equal(created.created, true);
    assert.equal(created.kind, 'selftest-request');
    assert.equal(created.requestFingerprint, request.requestFingerprint);
    assert.equal(JSON.stringify(created).includes(request.zPrivateSentinel), false);
    assert.equal(Object.hasOwn(created, '$contract'), false);
    assert.equal(
      fs.readFileSync(output, 'utf8'),
      canonicalBytes(request)
    );
    const outputStat = fs.lstatSync(output);
    assert.equal(outputStat.isFile(), true);
    assert.equal(outputStat.nlink, 1);
    if (process.platform !== 'win32') {
      assert.equal(outputStat.mode & 0o7777, 0o600);
    }
    const originalInode = outputStat.ino;
    const reentered = persistCanonicalPrivateRequest({
      root,
      outputPath: output,
      request: structuredClone(request),
      kind: 'selftest-request'
    });
    assert.equal(reentered.created, false);
    assert.equal(fs.lstatSync(output).ino, originalInode);

    const different = structuredClone(request);
    different.nested.a = 3;
    expectCode(() => persistCanonicalPrivateRequest({
      root,
      outputPath: output,
      request: different,
      kind: 'selftest-request'
    }), 'PRIVATE_REQUEST_OUTPUT_EXISTS_DIFFERENT');
    assert.equal(fs.readFileSync(output, 'utf8'), canonicalBytes(request));

    if (process.platform !== 'win32') {
      const wrongModeOutput = path.join(external, 'wrong-mode-request.json');
      fs.writeFileSync(wrongModeOutput, canonicalBytes(request), { mode: 0o644 });
      fs.chmodSync(wrongModeOutput, 0o644);
      expectCode(() => persistCanonicalPrivateRequest({
        root,
        outputPath: wrongModeOutput,
        request,
        kind: 'selftest-request'
      }), 'PRIVATE_REQUEST_OUTPUT_INVALID');
      assert.equal(fs.lstatSync(wrongModeOutput).mode & 0o7777, 0o644);
    }

    const linkedTarget = path.join(external, 'linked-target.json');
    fs.writeFileSync(linkedTarget, canonicalBytes(request), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(linkedTarget, 0o600);
    const symlinkOutput = path.join(external, 'symlink-request.json');
    fs.symlinkSync(linkedTarget, symlinkOutput);
    expectCode(() => persistCanonicalPrivateRequest({
      root,
      outputPath: symlinkOutput,
      request,
      kind: 'selftest-request'
    }), 'PRIVATE_REQUEST_OUTPUT_INVALID');

    const hardlinkOutput = path.join(external, 'hardlink-request.json');
    fs.linkSync(linkedTarget, hardlinkOutput);
    const linkedMode = fs.lstatSync(linkedTarget).mode & 0o7777;
    expectCode(() => persistCanonicalPrivateRequest({
      root,
      outputPath: hardlinkOutput,
      request,
      kind: 'selftest-request'
    }), 'PRIVATE_REQUEST_OUTPUT_INVALID');
    assert.equal(fs.lstatSync(linkedTarget).mode & 0o7777, linkedMode);
    assert.equal(fs.lstatSync(linkedTarget).nlink, 2);

    expectCode(() => persistCanonicalPrivateRequest({
      root,
      outputPath: 'relative-request.json',
      request,
      kind: 'selftest-request'
    }), 'PRIVATE_REQUEST_OUTPUT_PATH_INVALID');
    expectCode(() => persistCanonicalPrivateRequest({
      root,
      outputPath: path.join(root, 'inside-repository.json'),
      request,
      kind: 'selftest-request'
    }), 'PRIVATE_REQUEST_OUTPUT_PATH_INVALID');

    const realDirectory = path.join(external, 'real-directory');
    const linkedDirectory = path.join(external, 'linked-directory');
    fs.mkdirSync(realDirectory);
    fs.symlinkSync(realDirectory, linkedDirectory, 'dir');
    expectCode(() => persistCanonicalPrivateRequest({
      root,
      outputPath: path.join(linkedDirectory, 'request.json'),
      request,
      kind: 'selftest-request'
    }), 'PRIVATE_REQUEST_OUTPUT_PATH_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
  process.stdout.write(
    'Private request file selftest: exact work-owned acquisition arguments, canonical 0600 atomic publication, exact re-entry, linked-output rejection, and non-authoritative receipts passed.\n'
  );
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    selftestPrivateRequestFiles();
  } catch (error) {
    process.stderr.write((error.stack || String(error)) + '\n');
    process.exitCode = 1;
  }
}
