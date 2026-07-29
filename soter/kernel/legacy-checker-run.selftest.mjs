#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fingerprintFile,
  fingerprintJson,
  readJson,
  writeJson
} from '../core/lib/canonical-json.mjs';
import {
  assertLegacyCheckerRunProjection,
  assertLegacyCheckerRunReceipt,
  expectedLegacyCheckerChannelShim,
  inspectCurrentLegacyCheckerRunReceipt,
  inspectLegacyCheckerPreRemovalBasis,
  inspectLegacyCheckerRunProjection,
  inspectLegacyCheckerRunReceipt,
  LEGACY_CHECKER_RUN_PROJECTION_PATH,
  parseLegacyCheckerRunResult,
  projectLegacyCheckerRunReceipt,
  runLegacyCheckerPreRemoval
} from './legacy-checker-run.mjs';

const file = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(file), '..', '..');
const RECEIPT_CONTRACT = 'soter://contracts/legacy-checker-run-receipt/v1';
const STATE_DIRECTORY = '.soter/state/legacy-checker-runs';
const FIXED_LIMITATIONS = [
  'This receipt records one exact immutable legacy checker observation only; it does not grant migration, fallback-removal, execution, provider, publication, or merge authority.',
  'The temporary CRM Channel vocabulary fragment exists only to satisfy the immutable pre-cutover compatibility pointer check and must be removed with the legacy cutover.',
  'Raw checker output, absolute paths, source content, inherited environment values, credentials, provider data, readiness, verification, and health claims are excluded.'
];
const CLEAN_CENSUS = 'Scanned: 1 CLAUDE.md, 2 skills, 3 system cards, 4 molds, 5 standards, 6 singletons, 7 rules, 8 eval cases, 9 ADRs, 10 alias rows.';

function expectCode(action, code) {
  try {
    action();
  } catch (error) {
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail('Expected ' + code);
}

function copyFile(sourceRoot, targetRoot, relative) {
  const source = path.join(sourceRoot, relative);
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function makeBasisRoot() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-legacy-checker-run-'));
  const transition = readJson(path.join(root, 'soter/kernel/legacy-checker-transition.json'));
  const requiredFiles = new Set([
    'soter/contracts/legacy-checker-run-projection.schema.json',
    'soter/contracts/legacy-checker-run-receipt.schema.json',
    'soter/contracts/legacy-checker-transition.schema.json',
    'soter/migrations/legacy-inventory.json',
    'soter/contexts/crm/vocabulary.json'
  ]);
  for (const rule of transition.rules) {
    for (const enforcement of rule.enforcements || []) requiredFiles.add(enforcement.path);
  }
  for (const relative of [...requiredFiles].sort()) copyFile(root, temp, relative);
  fs.writeFileSync(path.join(temp, 'CLAUDE.md'), '# Synthetic clean checker input\n');

  const checkerPath = path.join(temp, '.claude/scripts/check.mjs');
  fs.mkdirSync(path.dirname(checkerPath), { recursive: true });
  const checkerSource = [
    '#!/usr/bin/env node',
    ...transition.rules.map((rule) => `// V(null, '${rule.legacyCode}')`),
    `console.log(${JSON.stringify(CLEAN_CENSUS)});`,
    "console.log('Checker: 0 error(s), 0 warning(s).');",
    ''
  ].join('\n');
  fs.writeFileSync(checkerPath, checkerSource);
  transition.source.fingerprint = fingerprintFile(checkerPath);
  transition.source.effectiveCodesFingerprint = fingerprintJson(
    transition.rules.map((rule) => rule.legacyCode)
  );
  transition.transitionFingerprint = null;
  transition.transitionFingerprint = fingerprintJson(transition);
  writeJson(
    path.join(temp, 'soter/kernel/legacy-checker-transition.json'),
    transition
  );

  const inventoryPath = path.join(temp, 'soter/migrations/legacy-inventory.json');
  const inventory = readJson(inventoryPath);
  const checkerItem = inventory.items.find((item) => {
    return item.sourcePath === '.claude/scripts/check.mjs';
  });
  assert(checkerItem, 'synthetic historical basis requires the checker inventory row');
  checkerItem.sourceFingerprint = transition.source.fingerprint;
  writeJson(inventoryPath, inventory);

  const vocabularyPath = path.join(temp, 'soter/contexts/crm/vocabulary.json');
  const vocabulary = readJson(vocabularyPath);
  assert.equal(
    fingerprintJson(vocabulary),
    'sha256:931c5deffaa7ce0015879013e0d6260a6288f639af232f9d7cc0eccd1462bbfd',
    'the final CRM vocabulary must remain the exact shim-free historical base'
  );
  vocabulary.entries.push(expectedLegacyCheckerChannelShim());
  writeJson(vocabularyPath, vocabulary);
  const channelEntries = vocabulary.entries.filter((entry) => entry.id === 'channel');
  assert.deepEqual(
    channelEntries,
    [expectedLegacyCheckerChannelShim()],
    'the copied pre-cutover basis must contain exactly one exact temporary Channel shim'
  );
  assert.equal(
    vocabulary.invariants.runtimeAuthority,
    'none',
    'the temporary Channel shim must grant no runtime authority'
  );
  return fs.realpathSync(temp);
}

function fingerprintReceipt(receipt) {
  const unsigned = structuredClone(receipt);
  unsigned.receiptFingerprint = null;
  return fingerprintJson(unsigned);
}

function cleanResult(stdout = CLEAN_CENSUS + '\nChecker: 0 error(s), 0 warning(s).\n') {
  return parseLegacyCheckerRunResult({
    status: 0,
    signal: null,
    errorCode: null,
    stdout,
    stderr: ''
  });
}

function receiptFor(inspected, result = cleanResult()) {
  const receipt = {
    $contract: RECEIPT_CONTRACT,
    contractVersion: '1.0.0',
    id: inspected.receiptId,
    observedAt: '2026-07-22T12:00:00.000Z',
    basis: structuredClone(inspected.basis),
    command: structuredClone(inspected.command),
    result: structuredClone(result),
    authority: {
      kind: 'none',
      grantsMigration: false,
      grantsFallbackRemoval: false,
      grantsExecution: false,
      grantsProviderRead: false,
      grantsProviderWrite: false,
      grantsPublication: false,
      grantsMerge: false
    },
    privacy: {
      rawOutputIncluded: false,
      absolutePathsIncluded: false,
      sourceContentIncluded: false,
      environmentValuesIncluded: false
    },
    limitations: [...FIXED_LIMITATIONS],
    receiptFingerprint: null
  };
  receipt.receiptFingerprint = fingerprintReceipt(receipt);
  return receipt;
}

function writePrivateReceipt(temp, receipt) {
  const directory = path.join(temp, STATE_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const receiptPath = path.join(directory, receipt.id + '.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(receiptPath, 0o600);
  return receiptPath;
}

const temp = makeBasisRoot();
try {
  const inspected = inspectLegacyCheckerPreRemovalBasis({ root: temp });
  assert.match(inspected.receiptId, /^legacy-checker-run[.][a-f0-9]{64}$/);
  assert.equal(inspected.authority, 'none');
  assert.equal(inspected.basis.checkerVisibleInputTree.scope, 'complete-public-repository-tree');
  assert.deepEqual(
    inspected.basis.checkerVisibleInputTree.excludedRoots,
    ['.git', '.soter', 'node_modules']
  );
  assert(inspected.basis.checkerVisibleInputTree.fileCount > 0);
  assert.match(inspected.basis.checkerVisibleInputTree.treeFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(inspected.basis.gitFreshnessInputs.state, 'unavailable');
  assert.equal(inspected.basis.gitFreshnessInputs.observationCount, 0);
  assert.match(
    inspected.basis.gitFreshnessInputs.observationsFingerprint,
    /^sha256:[a-f0-9]{64}$/
  );
  assert.deepEqual(inspected.command, {
    executable: 'current-node-binary',
    script: '.claude/scripts/check.mjs',
    arguments: ['--all'],
    cwd: 'repository-root',
    environmentPolicy: 'fixed-minimal-v1',
    timeoutMs: 60000
  });

  const hostileOutput = CLEAN_CENSUS
    + '\nPRIVATE_RAW_BODY_SENTINEL=/private/user/secrets.json sk-hostile-value\n'
    + 'Checker: 0 error(s), 0 warning(s).\n';
  const sanitizedResult = cleanResult(hostileOutput);
  assert.equal(JSON.stringify(sanitizedResult).includes('PRIVATE_RAW_BODY_SENTINEL'), false);
  assert.equal(JSON.stringify(sanitizedResult).includes('/private/user/secrets.json'), false);
  assert.deepEqual(Object.keys(sanitizedResult).sort(), [
    'errorCount',
    'exitStatus',
    'stderrFingerprint',
    'stdoutFingerprint',
    'warningCount'
  ]);

  const receipt = receiptFor(inspected, sanitizedResult);
  assert.deepEqual(assertLegacyCheckerRunReceipt({
    root: temp,
    receipt,
    expectedBasis: inspected.basis,
    expectedCommand: inspected.command
  }), receipt);
  const serializedReceipt = JSON.stringify(receipt);
  assert.equal(serializedReceipt.includes(hostileOutput), false);
  assert.equal(serializedReceipt.includes(temp), false);
  assert.equal(serializedReceipt.includes('sk-hostile-value'), false);
  assert.equal(receipt.authority.kind, 'none');
  assert.deepEqual(new Set(Object.values(receipt.authority)), new Set(['none', false]));

  const hostileRuntime = structuredClone(receipt);
  hostileRuntime.basis.runtime.version = 'v23.5.0/private/user/secrets.json';
  hostileRuntime.id = 'legacy-checker-run.' + fingerprintJson({
    basis: hostileRuntime.basis,
    command: hostileRuntime.command
  }).slice('sha256:'.length);
  hostileRuntime.receiptFingerprint = fingerprintReceipt(hostileRuntime);
  expectCode(() => assertLegacyCheckerRunReceipt({
    root: temp,
    receipt: hostileRuntime
  }), 'LEGACY_CHECKER_RUN_RECEIPT_INVALID');

  expectCode(() => parseLegacyCheckerRunResult({
    status: 1,
    signal: null,
    errorCode: null,
    stdout: CLEAN_CENSUS + '\nChecker: 0 error(s), 0 warning(s).\n',
    stderr: ''
  }), 'LEGACY_CHECKER_RUN_NOT_CLEAN');
  expectCode(() => parseLegacyCheckerRunResult({
    status: 0,
    signal: null,
    errorCode: null,
    stdout: CLEAN_CENSUS + '\nChecker: 0 error(s), 1 warning(s).\n',
    stderr: ''
  }), 'LEGACY_CHECKER_RUN_NOT_CLEAN');
  expectCode(() => parseLegacyCheckerRunResult({
    status: 0,
    signal: 'SIGTERM',
    errorCode: null,
    stdout: CLEAN_CENSUS + '\nChecker: 0 error(s), 0 warning(s).\n',
    stderr: ''
  }), 'LEGACY_CHECKER_RUN_NOT_CLEAN');
  expectCode(() => parseLegacyCheckerRunResult({
    status: 0,
    signal: null,
    errorCode: 'ETIMEDOUT',
    stdout: CLEAN_CENSUS + '\nChecker: 0 error(s), 0 warning(s).\n',
    stderr: ''
  }), 'LEGACY_CHECKER_RUN_NOT_CLEAN');
  expectCode(() => parseLegacyCheckerRunResult({
    status: 0,
    signal: null,
    errorCode: null,
    stdout: CLEAN_CENSUS + '\nChecker: 0 error(s), 0 warning(s).\n',
    stderr: 'unexpected stderr'
  }), 'LEGACY_CHECKER_RUN_NOT_CLEAN');
  expectCode(() => parseLegacyCheckerRunResult({
    status: 0,
    signal: null,
    errorCode: null,
    stdout: CLEAN_CENSUS + '\nChecker: 0 error(s), 0 warning(s).\nChecker: 0 error(s), 0 warning(s).\n',
    stderr: ''
  }), 'LEGACY_CHECKER_RUN_OUTPUT_AMBIGUOUS');
  expectCode(() => parseLegacyCheckerRunResult({
    status: 0,
    signal: null,
    errorCode: null,
    stdout: 'Checker: 0 error(s), 0 warning(s).\n',
    stderr: ''
  }), 'LEGACY_CHECKER_RUN_OUTPUT_AMBIGUOUS');
  expectCode(() => parseLegacyCheckerRunResult({
    status: 0,
    signal: null,
    errorCode: null,
    stdout: CLEAN_CENSUS + '\nChecker: 0 error(s), 0 warning(s).\n',
    stderr: '',
    spawn: () => ({ status: 0 })
  }), 'LEGACY_CHECKER_RUN_RESULT_INVALID');

  for (const injected of [
    { spawn: () => ({ status: 0 }) },
    { now: () => '2026-07-22T12:00:00.000Z' },
    { env: { PATH: '/hostile' } },
    { executable: '/tmp/fake-node' }
  ]) {
    expectCode(
      () => runLegacyCheckerPreRemoval({ root: temp, ...injected }),
      'LEGACY_CHECKER_RUN_REQUEST_INVALID'
    );
  }

  const moduleSource = fs.readFileSync(path.join(root, 'soter/kernel/legacy-checker-run.mjs'), 'utf8');
  assert.match(moduleSource, /import \{ spawnSync \} from 'node:child_process';/);
  assert.match(moduleSource, /spawnSync\(\s*process[.]execPath,/);
  assert.match(moduleSource, /\[inspected[.]checkerFile, '--all'\]/);
  assert.match(moduleSource, /PATH: '\/usr\/bin:\/bin:\/usr\/sbin:\/sbin'/);
  assert.equal(moduleSource.includes('...process.env'), false);

  const checkerPath = path.join(temp, '.claude/scripts/check.mjs');
  const checkerBytes = fs.readFileSync(checkerPath);
  fs.appendFileSync(checkerPath, '\n// drift\n');
  expectCode(
    () => inspectLegacyCheckerPreRemovalBasis({ root: temp }),
    'LEGACY_CHECKER_RUN_BASIS_STALE'
  );
  fs.writeFileSync(checkerPath, checkerBytes);

  const externalChecker = path.join(temp, 'external-checker.mjs');
  fs.writeFileSync(externalChecker, checkerBytes);
  fs.rmSync(checkerPath);
  fs.linkSync(externalChecker, checkerPath);
  expectCode(
    () => inspectLegacyCheckerPreRemovalBasis({ root: temp }),
    'LEGACY_CHECKER_RUN_BASIS_INVALID'
  );
  fs.rmSync(checkerPath);
  fs.rmSync(externalChecker);
  fs.writeFileSync(checkerPath, checkerBytes);

  const vocabularyPath = path.join(temp, 'soter/contexts/crm/vocabulary.json');
  const vocabulary = readJson(vocabularyPath);
  const channel = vocabulary.entries.find((entry) => entry.id === 'channel');
  channel.definition += ' drift';
  writeJson(vocabularyPath, vocabulary);
  expectCode(
    () => inspectLegacyCheckerPreRemovalBasis({ root: temp }),
    'LEGACY_CHECKER_RUN_SHIM_INVALID'
  );
  channel.definition = expectedLegacyCheckerChannelShim().definition;
  writeJson(vocabularyPath, vocabulary);

  const transitionPath = path.join(temp, 'soter/kernel/legacy-checker-transition.json');
  const transitionBytes = fs.readFileSync(transitionPath);
  const externalTransition = path.join(temp, 'external-transition.json');
  fs.writeFileSync(externalTransition, transitionBytes);
  fs.rmSync(transitionPath);
  fs.symlinkSync(externalTransition, transitionPath);
  expectCode(
    () => inspectLegacyCheckerPreRemovalBasis({ root: temp }),
    'LEGACY_CHECKER_RUN_BASIS_INVALID'
  );
  fs.rmSync(transitionPath);
  fs.rmSync(externalTransition);
  fs.writeFileSync(transitionPath, transitionBytes);

  const hiddenPrivateMarkdown = path.join(temp, '.soter/state/hidden.md');
  fs.mkdirSync(path.dirname(hiddenPrivateMarkdown), { recursive: true });
  fs.writeFileSync(hiddenPrivateMarkdown, '[hidden](missing-private-target)\n');
  expectCode(
    () => inspectLegacyCheckerPreRemovalBasis({ root: temp }),
    'LEGACY_CHECKER_RUN_INPUT_TREE_INVALID'
  );
  fs.rmSync(hiddenPrivateMarkdown);

  const privateStateLink = path.join(temp, 'private-state-link.md');
  fs.writeFileSync(privateStateLink, '[private](.soter/state/private.json)\n');
  expectCode(
    () => inspectLegacyCheckerPreRemovalBasis({ root: temp }),
    'LEGACY_CHECKER_RUN_INPUT_TREE_INVALID'
  );
  fs.rmSync(privateStateLink);

  const restoredInspection = inspectLegacyCheckerPreRemovalBasis({ root: temp });
  const storedReceipt = receiptFor(restoredInspection, sanitizedResult);
  const storedPath = writePrivateReceipt(temp, storedReceipt);
  if (process.platform !== 'win32') {
    assert.equal(fs.lstatSync(path.dirname(storedPath)).mode & 0o7777, 0o700);
    assert.equal(fs.lstatSync(storedPath).mode & 0o7777, 0o600);
  }
  const storedInspection = inspectLegacyCheckerRunReceipt({
    root: temp,
    receiptId: restoredInspection.receiptId
  });
  assert.deepEqual(storedInspection.receipt, storedReceipt);
  assert.equal(storedInspection.receiptPath, `${STATE_DIRECTORY}/${storedReceipt.id}.json`);

  const reentry = runLegacyCheckerPreRemoval({ root: temp });
  assert.deepEqual(reentry.receipt, storedReceipt);
  assert.equal(fs.readdirSync(path.dirname(storedPath)).length, 1);
  assert.deepEqual(inspectCurrentLegacyCheckerRunReceipt({
    root: temp,
    receiptId: restoredInspection.receiptId
  }).receipt, storedReceipt);
  const unrelatedReceipt = path.join(path.dirname(storedPath), 'unrelated.json');
  fs.writeFileSync(unrelatedReceipt, '{}\n', { mode: 0o600 });
  expectCode(() => inspectCurrentLegacyCheckerRunReceipt({
    root: temp,
    receiptId: restoredInspection.receiptId
  }), 'LEGACY_CHECKER_RUN_RECEIPT_REENTRY_MISMATCH');
  fs.rmSync(unrelatedReceipt);

  const claudePath = path.join(temp, 'CLAUDE.md');
  const claudeBytes = fs.readFileSync(claudePath);
  fs.appendFileSync(claudePath, '\nsk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  expectCode(() => inspectCurrentLegacyCheckerRunReceipt({
    root: temp,
    receiptId: restoredInspection.receiptId
  }), 'LEGACY_CHECKER_RUN_RECEIPT_BASIS_STALE');
  expectCode(
    () => runLegacyCheckerPreRemoval({ root: temp }),
    'LEGACY_CHECKER_RUN_RECEIPT_REENTRY_MISMATCH'
  );
  fs.writeFileSync(claudePath, claudeBytes);

  const tampered = structuredClone(storedReceipt);
  tampered.result.stdoutFingerprint = 'sha256:' + 'f'.repeat(64);
  fs.writeFileSync(storedPath, JSON.stringify(tampered, null, 2) + '\n');
  expectCode(() => inspectLegacyCheckerRunReceipt({
    root: temp,
    receiptId: restoredInspection.receiptId
  }), 'LEGACY_CHECKER_RUN_RECEIPT_TAMPERED');

  const substituted = structuredClone(storedReceipt);
  substituted.basis.runtime.version = 'v999.0.0';
  substituted.receiptFingerprint = fingerprintReceipt(substituted);
  fs.writeFileSync(storedPath, JSON.stringify(substituted, null, 2) + '\n');
  expectCode(
    () => runLegacyCheckerPreRemoval({ root: temp }),
    'LEGACY_CHECKER_RUN_RECEIPT_BINDING_INVALID'
  );

  fs.writeFileSync(storedPath, JSON.stringify(storedReceipt, null, 2) + '\n');
  if (process.platform !== 'win32') {
    fs.chmodSync(path.dirname(storedPath), 0o755);
    expectCode(() => inspectLegacyCheckerRunReceipt({
      root: temp,
      receiptId: restoredInspection.receiptId
    }), 'LEGACY_CHECKER_RUN_PRIVATE_STATE_INVALID');
    fs.chmodSync(path.dirname(storedPath), 0o700);
    fs.chmodSync(storedPath, 0o644);
    expectCode(() => inspectLegacyCheckerRunReceipt({
      root: temp,
      receiptId: restoredInspection.receiptId
    }), 'LEGACY_CHECKER_RUN_PRIVATE_STATE_INVALID');
    fs.chmodSync(storedPath, 0o600);
  }

  const receiptBackup = fs.readFileSync(storedPath);
  const externalReceipt = path.join(temp, 'external-receipt.json');
  fs.writeFileSync(externalReceipt, receiptBackup, { mode: 0o600 });
  fs.rmSync(storedPath);
  fs.linkSync(externalReceipt, storedPath);
  expectCode(() => inspectLegacyCheckerRunReceipt({
    root: temp,
    receiptId: restoredInspection.receiptId
  }), 'LEGACY_CHECKER_RUN_PRIVATE_STATE_INVALID');
  fs.rmSync(storedPath);
  fs.rmSync(externalReceipt);
  fs.writeFileSync(storedPath, receiptBackup, { mode: 0o600 });

  fs.rmSync(storedPath);
  expectCode(
    () => runLegacyCheckerPreRemoval({ root: temp }),
    'LEGACY_CHECKER_RUN_RECEIPT_MISSING'
  );
  fs.writeFileSync(unrelatedReceipt, '{}\n', { mode: 0o600 });
  expectCode(
    () => runLegacyCheckerPreRemoval({ root: temp }),
    'LEGACY_CHECKER_RUN_RECEIPT_REENTRY_MISMATCH'
  );

  expectCode(() => inspectLegacyCheckerRunReceipt({
    root: temp,
    receiptId: 'legacy-checker-run.' + '0'.repeat(64)
  }), 'LEGACY_CHECKER_RUN_RECEIPT_MISSING');

  const projection = projectLegacyCheckerRunReceipt({ root: temp, receipt: storedReceipt });
  assert.equal(projection.receipt.id, storedReceipt.id);
  assert.equal(projection.receipt.fingerprint, storedReceipt.receiptFingerprint);
  assert.equal(
    projection.basis.checkerVisibleInputTree.treeFingerprint,
    storedReceipt.basis.checkerVisibleInputTree.treeFingerprint
  );
  assert.equal(projection.result.errorCount, 0);
  assert.equal(projection.result.warningCount, 0);
  assert.equal(projection.authority.kind, 'none');
  assert.deepEqual(new Set(Object.values(projection.authority)), new Set(['none', false]));
  assert.equal(projection.privacy.privateStatePathIncluded, false);
  assert.equal(JSON.stringify(projection).includes(temp), false);
  assert.equal(JSON.stringify(projection).includes(STATE_DIRECTORY), false);
  assert.deepEqual(assertLegacyCheckerRunProjection({
    root: temp,
    projection,
    expectedReceipt: storedReceipt
  }), projection);
  const hostileProjection = structuredClone(projection);
  hostileProjection.rawOutput = 'sk-' + 'a'.repeat(32);
  expectCode(() => assertLegacyCheckerRunProjection({
    root: temp,
    projection: hostileProjection
  }), 'LEGACY_CHECKER_RUN_PROJECTION_INVALID');
  writeJson(path.join(temp, LEGACY_CHECKER_RUN_PROJECTION_PATH), projection);
  assert.deepEqual(inspectLegacyCheckerRunProjection({ root: temp }), projection);

  console.log('Legacy checker immutable pre-removal run receipt and governed projection selftest passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
