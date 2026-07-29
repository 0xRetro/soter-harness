#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  developmentCandidateLockStatePath,
  materializeDevelopmentCandidateLock,
  readDevelopmentCandidateLock,
  resolveDevelopmentCandidateLock
} from './development-candidate-locks.mjs';
import { readJson, writeJson } from './lib/canonical-json.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function copyHarnessRoot(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.soter' || entry.name === 'node_modules') continue;
    fs.cpSync(path.join(source, entry.name), path.join(target, entry.name), { recursive: true });
  }
}

function expectCode(action, code) {
  let observed = null;
  try {
    action();
  } catch (error) {
    observed = error?.code || null;
  }
  assert.equal(observed, code, 'expected stable failure code ' + code);
}

export function selftestDevelopmentCandidateLocks(root = scriptRoot) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-development-candidate-locks-'));
  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-development-candidate-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-development-candidate-outside-'));
  try {
    fs.symlinkSync(outside, path.join(symlinkRoot, '.soter'));
    expectCode(
      () => developmentCandidateLockStatePath(symlinkRoot, 'automation.forge', 'codex'),
      'DEVELOPMENT_CANDIDATE_LOCK_PATH_UNSAFE'
    );
    assert.deepEqual(fs.readdirSync(outside), [], 'symlink escape must produce zero outside writes');

    copyHarnessRoot(root, temp);
    const input = {
      root: temp,
      configPath: 'soter/configurations/harness-development-catalog.config.json',
      workflowId: 'automation.forge',
      host: 'codex'
    };
    const resolved = resolveDevelopmentCandidateLock(input);
    assert.equal(resolved.authority.kind, 'private-development-lock-only');
    assert.equal(resolved.authority.grantsExecution, false);
    assert.equal(resolved.authority.grantsMigration, false);
    assert.equal(resolved.authority.grantsFallbackRemoval, false);
    assert.equal(resolved.lock.configuration.path, input.configPath);
    assert.equal(resolved.lock.host.id, 'codex');
    assert.equal(fs.existsSync(path.join(temp, resolved.path)), false, 'resolution must not write state');

    const created = materializeDevelopmentCandidateLock(input);
    const file = path.join(temp, created.path);
    assert.equal(file.startsWith(path.join(temp, '.soter/state/development-candidate-locks/')), true);
    assert.deepEqual(readJson(file), created.lock);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o7777, 0o700);
      assert.equal(fs.statSync(file).mode & 0o7777, 0o600);
    }
    const reentry = materializeDevelopmentCandidateLock(input);
    assert.equal(reentry.lockFingerprint, created.lockFingerprint);
    const current = readDevelopmentCandidateLock({
      root: temp,
      lockPath: created.path,
      workflowId: input.workflowId,
      requireCurrent: true
    });
    assert.equal(current.lockFingerprint, created.lockFingerprint);

    const configFile = path.join(temp, input.configPath);
    const config = readJson(configFile);
    config.host.reason += ' Changed only to prove exact candidate-lock drift handling.';
    writeJson(configFile, config);
    expectCode(() => readDevelopmentCandidateLock({
      root: temp,
      lockPath: created.path,
      workflowId: input.workflowId,
      requireCurrent: true
    }), 'DEVELOPMENT_CANDIDATE_LOCK_STALE');
    expectCode(() => materializeDevelopmentCandidateLock(input), 'DEVELOPMENT_CANDIDATE_LOCK_REENTRY_MISMATCH');

    fs.rmSync(path.join(temp, '.soter'), { recursive: true, force: true });
    copyHarnessRoot(root, temp);
    const mappingPath = path.join(temp, 'soter/integrations/notion/projects-records.mapping.json');
    const mapping = readJson(mappingPath);
    mapping.recordTypes[0].fields[0].portable = 'inventedProviderShapedField';
    writeJson(mappingPath, mapping);
    expectCode(() => materializeDevelopmentCandidateLock(input), 'DEVELOPMENT_CANDIDATE_LOCK_GRAPH_INVALID');

    process.stdout.write(
      'Soter development candidate lock self-test passed: ordinary strict resolution, no-authority inspection, private 0700/0600 create-only materialization, exact re-entry, drift rejection, and unrelated provider-mapping failure rejection.\n'
    );
    return true;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(symlinkRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    selftestDevelopmentCandidateLocks();
  } catch (error) {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  }
}
