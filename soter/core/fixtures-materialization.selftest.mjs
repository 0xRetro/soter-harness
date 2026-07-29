import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  generatedFixtureMaterializationPlan,
  harnessDevelopmentCatalogFinalLockPaths,
  materializeGeneratedFixtureSet,
  selectLegacyBindingFixtureOutputPath
} from './fixtures.mjs';
import { readJson } from './lib/canonical-json.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export async function selftestFixtureMaterialization() {
  const oldBridgePath = 'soter/fixtures/example/old.bridge.evidence.json';
  const newCompletionPath = 'soter/fixtures/finalization/new.migration.evidence.json';
  assert(selectLegacyBindingFixtureOutputPath({
    sourcePath: '.claude/example.md',
    targetPath: 'soter/packs/example/pack.json',
    bridgePath: oldBridgePath,
    binding: { state: 'bridged', evidence: [oldBridgePath] }
  }) === oldBridgePath, 'unfinished binding did not retain its exact bridge output');
  assert(selectLegacyBindingFixtureOutputPath({
    sourcePath: '.claude/example.md',
    targetPath: 'soter/packs/example/pack.json',
    bridgePath: oldBridgePath,
    binding: { state: 'migrated', evidence: [newCompletionPath] }
  }) === newCompletionPath, 'completed binding regenerated its obsolete bridge output');
  for (const binding of [
    { state: 'migrated', evidence: [] },
    { state: 'migrated', evidence: [newCompletionPath, oldBridgePath] },
    { state: 'migrated', evidence: ['soter/evidence/development/shared.json'] }
  ]) {
    let rejected = false;
    try {
      selectLegacyBindingFixtureOutputPath({
        sourcePath: '.claude/example.md',
        targetPath: 'soter/packs/example/pack.json',
        bridgePath: oldBridgePath,
        binding
      });
    } catch (error) {
      rejected = error.message.includes('one exact governed fixture output');
    }
    assert(rejected, 'ordinary completion accepted missing, shared, or external evidence output');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-fixture-materialization-'));
  try {
    const directory = path.join(root, 'soter/fixtures/repository-review');
    const retained = path.join(directory, 'retained.json');
    const obsolete = path.join(directory, 'obsolete.json');
    writeJson(retained, { state: 'old' });
    writeJson(obsolete, { state: 'obsolete' });

    await materializeGeneratedFixtureSet(root, async () => new Map([
      ['soter/fixtures/repository-review/retained.json', { state: 'current' }],
      ['soter/fixtures/repository-review/new.json', { state: 'new' }]
    ]));
    assert(readJson(retained).state === 'current', 'fixture materialization did not replace exact bytes');
    assert(readJson(path.join(directory, 'new.json')).state === 'new', 'fixture materialization did not create the expected output');
    assert(!fs.existsSync(obsolete), 'fixture materialization stranded an obsolete governed output');

    const verifyOnlyPath = 'soter/fixtures/repository-review/create-only.json';
    const verifyOnlyFile = path.join(root, verifyOnlyPath);
    writeJson(verifyOnlyFile, { state: 'create-only' });
    if (process.platform !== 'win32') fs.chmodSync(verifyOnlyFile, 0o644);
    const verifyOnlyBefore = fs.lstatSync(verifyOnlyFile);
    await materializeGeneratedFixtureSet(
      root,
      async () => new Map([
        ['soter/fixtures/repository-review/retained.json', { state: 'current' }],
        ['soter/fixtures/repository-review/new.json', { state: 'new' }],
        [verifyOnlyPath, { state: 'create-only' }]
      ]),
      { verifyOnlyPaths: [verifyOnlyPath] }
    );
    const verifyOnlyAfter = fs.lstatSync(verifyOnlyFile);
    assert(verifyOnlyAfter.dev === verifyOnlyBefore.dev
      && verifyOnlyAfter.ino === verifyOnlyBefore.ino
      && (verifyOnlyAfter.mode & 0o7777) === (verifyOnlyBefore.mode & 0o7777),
    'verify-only fixture ownership changed the create-only inode or mode');
    let verifyOnlyMismatchRejected = false;
    try {
      await materializeGeneratedFixtureSet(
        root,
        async () => new Map([[verifyOnlyPath, { state: 'different' }]]),
        { verifyOnlyPaths: [verifyOnlyPath] }
      );
    } catch (error) {
      verifyOnlyMismatchRejected = error.message.includes('not exact');
    }
    assert(verifyOnlyMismatchRejected, 'verify-only fixture ownership accepted different bytes');
    assert(readJson(verifyOnlyFile).state === 'create-only', 'verify-only mismatch changed create-only bytes');

    const finalLockPath = harnessDevelopmentCatalogFinalLockPaths().codex;
    const finalLockFile = path.join(root, finalLockPath);
    const ordinaryBuilder = async () => new Map([
      ['soter/fixtures/repository-review/retained.json', { state: 'current' }],
      ['soter/fixtures/repository-review/new.json', { state: 'new' }]
    ]);
    const ordinaryAbsentPlan = generatedFixtureMaterializationPlan(
      root,
      await ordinaryBuilder()
    );
    assert(!ordinaryAbsentPlan.writes.some((row) => row.relativePath === finalLockPath)
      && !ordinaryAbsentPlan.removals.some((row) => row.relativePath === finalLockPath),
    'ordinary fixture plan claimed an absent final development lock');
    await materializeGeneratedFixtureSet(root, ordinaryBuilder);
    assert(!fs.existsSync(finalLockFile),
      'ordinary fixture update created a final development lock before exact consumption');

    writeJson(finalLockFile, { state: 'batch-owned' });
    if (process.platform !== 'win32') fs.chmodSync(finalLockFile, 0o644);
    const finalLockBefore = fs.lstatSync(finalLockFile);
    const finalLockBytes = fs.readFileSync(finalLockFile);
    const ordinaryPresentPlan = generatedFixtureMaterializationPlan(
      root,
      await ordinaryBuilder()
    );
    assert(!ordinaryPresentPlan.writes.some((row) => row.relativePath === finalLockPath)
      && !ordinaryPresentPlan.removals.some((row) => row.relativePath === finalLockPath),
    'ordinary fixture plan adopted or retired a batch-owned final development lock');
    await materializeGeneratedFixtureSet(root, ordinaryBuilder);
    const finalLockAfter = fs.lstatSync(finalLockFile);
    assert(finalLockAfter.dev === finalLockBefore.dev
      && finalLockAfter.ino === finalLockBefore.ino
      && (finalLockAfter.mode & 0o7777) === (finalLockBefore.mode & 0o7777)
      && fs.readFileSync(finalLockFile).equals(finalLockBytes),
    'ordinary fixture update changed a batch-owned final development lock');

    const alreadyRemovedPath
      = 'soter/fixtures/repository-review/already-authorized-and-removed.json';
    await materializeGeneratedFixtureSet(
      root,
      ordinaryBuilder,
      { expectedRemovals: [alreadyRemovedPath] }
    );
    assert(!fs.existsSync(path.join(root, alreadyRemovedPath)),
      'idempotent exact removal recreated an already-removed governed fixture');

    let exactRemovalRejected = false;
    try {
      await materializeGeneratedFixtureSet(
        root,
        async () => new Map([
          ['soter/fixtures/repository-review/retained.json', { state: 'must-not-write' }]
        ]),
        { expectedRemovals: ['soter/fixtures/repository-review/not-the-observed-file.json'] }
      );
    } catch (error) {
      exactRemovalRejected = error.message.includes('exact finalization request');
    }
    assert(exactRemovalRejected, 'fixture materialization accepted a mismatched requested removal set');
    assert(readJson(retained).state === 'current', 'fixture materialization wrote before exact removal-set validation');
    assert(readJson(path.join(directory, 'new.json')).state === 'new', 'fixture materialization removed before exact removal-set validation');

    const external = path.join(root, 'external.json');
    const linked = path.join(directory, 'linked-obsolete.json');
    writeJson(external, { state: 'external' });
    fs.chmodSync(external, 0o600);
    fs.linkSync(external, linked);
    const beforeMode = fs.lstatSync(external).mode & 0o7777;
    let hardlinkRejected = false;
    try {
      await materializeGeneratedFixtureSet(root, async () => new Map([
        ['soter/fixtures/repository-review/would-write.json', { state: 'forbidden' }]
      ]));
    } catch (error) {
      hardlinkRejected = error.message.includes('not one confined regular file');
    }
    assert(hardlinkRejected, 'fixture materialization accepted a hardlinked obsolete output');
    assert(!fs.existsSync(path.join(directory, 'would-write.json')), 'fixture materialization wrote before complete removal preflight');
    assert(fs.lstatSync(external).mode % 0o10000 === beforeMode, 'fixture materialization changed an external hardlink target mode');
    assert(readJson(external).state === 'external', 'fixture materialization changed external hardlink target bytes');

    fs.unlinkSync(linked);
    const symlink = path.join(directory, 'linked-obsolete.json');
    fs.symlinkSync(external, symlink);
    let symlinkRejected = false;
    try {
      await materializeGeneratedFixtureSet(root, async () => new Map());
    } catch (error) {
      symlinkRejected = error.message.includes('not one confined regular file');
    }
    assert(symlinkRejected, 'fixture materialization accepted a symlinked obsolete output');
    assert(readJson(external).state === 'external', 'fixture materialization followed an obsolete symlink');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await selftestFixtureMaterialization();
  process.stdout.write('Generated fixture materialization self-test passed: exact-set writes/removals and no-mutation symlink/hardlink preflight.\n');
}
