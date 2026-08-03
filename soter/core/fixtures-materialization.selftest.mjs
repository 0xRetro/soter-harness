import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  generatedFixtureMaterializationPlan,
  materializeGeneratedFixtureSet
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-fixture-materialization-'));
  try {
    const directory = path.join(root, 'soter/fixtures/repository-review');
    const retained = path.join(directory, 'retained.json');
    const obsolete = path.join(directory, 'obsolete.json');
    writeJson(retained, { state: 'old' });
    writeJson(obsolete, { state: 'obsolete' });

    const builder = async () => new Map([
      ['soter/fixtures/repository-review/retained.json', { state: 'current' }],
      ['soter/fixtures/repository-review/new.json', { state: 'new' }]
    ]);
    const plan = generatedFixtureMaterializationPlan(root, await builder());
    assert(plan.writes.length === 2, 'fixture materialization did not plan the exact write set');
    assert(plan.removals.length === 1
      && plan.removals[0].relativePath === 'soter/fixtures/repository-review/obsolete.json',
    'fixture materialization did not plan the exact obsolete output');

    await materializeGeneratedFixtureSet(root, builder);
    assert(readJson(retained).state === 'current',
      'fixture materialization did not replace exact bytes');
    assert(readJson(path.join(directory, 'new.json')).state === 'new',
      'fixture materialization did not create the expected output');
    assert(!fs.existsSync(obsolete),
      'fixture materialization stranded an obsolete governed output');

    let invalidPathRejected = false;
    try {
      generatedFixtureMaterializationPlan(root, new Map([
        ['soter/fixtures/../outside.json', { state: 'forbidden' }]
      ]));
    } catch (error) {
      invalidPathRejected = error.message.includes('normalized governed JSON output');
    }
    assert(invalidPathRejected, 'fixture materialization accepted path traversal');

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
    assert(!fs.existsSync(path.join(directory, 'would-write.json')),
      'fixture materialization wrote before complete removal preflight');
    assert((fs.lstatSync(external).mode & 0o7777) === beforeMode,
      'fixture materialization changed an external hardlink target mode');
    assert(readJson(external).state === 'external',
      'fixture materialization changed external hardlink target bytes');

    fs.unlinkSync(linked);
    fs.symlinkSync(external, linked);
    let symlinkRejected = false;
    try {
      await materializeGeneratedFixtureSet(root, async () => new Map());
    } catch (error) {
      symlinkRejected = error.message.includes('not one confined regular file');
    }
    assert(symlinkRejected, 'fixture materialization accepted a symlinked obsolete output');
    assert(readJson(external).state === 'external',
      'fixture materialization followed an obsolete symlink');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return true;
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await selftestFixtureMaterialization();
  process.stdout.write(
    'Generated fixture materialization self-test passed: exact-set writes/removals and no-mutation path, symlink, and hardlink preflight.\n'
  );
}
