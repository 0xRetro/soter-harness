#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  parseParallelSelftestJobs,
  runParallelCoreSelftests
} from './selftest.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptFile), '..', '..');
const runnerModuleUrl = pathToFileURL(path.join(repositoryRoot, 'soter/core/selftest.mjs')).href;
const LOG_PREFIX = '.soter-core-selftest-';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function matchingLogDirectories(directory) {
  return new Set(fs.readdirSync(directory).filter((name) => name.startsWith(LOG_PREFIX)));
}

function writeFixtureFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

function writeStatefulFixtureCli(root) {
  writeFixtureFile(path.join(root, 'soter/core/cli.mjs'), `
    import fs from 'node:fs';
    const args = process.argv.slice(2);
    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const suites = JSON.parse(process.env.SOTER_RUNNER_FIXTURE_SUITES);
    function updateState(mutator) {
      const lockPath = process.env.SOTER_RUNNER_FIXTURE_STATE + '.lock';
      let descriptor;
      while (descriptor === undefined) {
        try { descriptor = fs.openSync(lockPath, 'wx', 0o600); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
      }
      try {
        const state = JSON.parse(fs.readFileSync(process.env.SOTER_RUNNER_FIXTURE_STATE, 'utf8'));
        mutator(state);
        fs.writeFileSync(process.env.SOTER_RUNNER_FIXTURE_STATE, JSON.stringify(state), {
          mode: 0o600
        });
      } finally {
        fs.closeSync(descriptor);
        fs.unlinkSync(lockPath);
      }
    }
    if (args[0] !== 'selftest') process.exit(2);
    if (args[1] === '--list-suites') {
      process.stdout.write(suites.join('\\n') + '\\n');
      process.exit(0);
    }
    if (args[1] !== '--suite' || !suites.includes(args[2])) process.exit(2);
    const suite = args[2];
    updateState((state) => {
      state.active += 1;
      state.maximum = Math.max(state.maximum, state.active);
      state.count += 1;
      state.seen.push(suite);
      state.insideLogObserved = state.insideLogObserved
        || fs.readdirSync(process.cwd()).some((name) => name.startsWith('.soter-core-selftest-'));
    });
    const position = suites.indexOf(suite);
    const failure = process.env.SOTER_RUNNER_FIXTURE_FAILURE;
    const delay = failure
      ? (suite === failure ? 50 : (position === 0 ? 300 : 100))
      : 300 + ((suites.length - position) * 10);
    await sleep(delay);
    updateState((state) => { state.active -= 1; });
    if (suite === failure) {
      process.stderr.write('EXPECTED_RUNNER_FAILURE_DETAIL\\n');
      process.exit(7);
    }
    if (suite === process.env.SOTER_RUNNER_FIXTURE_NO_SENTINEL) {
      process.stdout.write('EXPECTED_ZERO_EXIT_WITHOUT_SENTINEL\\n');
      process.exit(0);
    }
    process.stdout.write('PASS_LOG_MUST_NOT_BE_REPORTED_' + suite + '\\n');
    process.stdout.write('CORE SELFTEST SUMMARY: all 1 suites passed.\\n');
  `);
}

async function captureRunner({ args, root }) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = '';
  process.stdout.write = (chunk) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return true;
  };
  try {
    const exitCode = await runParallelCoreSelftests({ args, root });
    return { exitCode, output };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function initializeFixture({ roots, suites }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soter runner selftest '));
  roots.push(root);
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({ active: 0, maximum: 0, count: 0, seen: [], insideLogObserved: false }),
    { mode: 0o600 }
  );
  writeStatefulFixtureCli(root);
  process.env.SOTER_RUNNER_FIXTURE_STATE = statePath;
  process.env.SOTER_RUNNER_FIXTURE_SUITES = JSON.stringify(suites);
  delete process.env.SOTER_RUNNER_FIXTURE_FAILURE;
  delete process.env.SOTER_RUNNER_FIXTURE_NO_SENTINEL;
  return { root, statePath };
}

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    await sleep(20);
  }
  throw new Error('parallel runner interruption fixture did not start');
}

export async function selftestParallelSelftestRunner() {
  assert.equal(parseParallelSelftestJobs([]), 8);
  for (let jobs = 2; jobs <= 8; jobs += 1) {
    assert.equal(parseParallelSelftestJobs(['--jobs', String(jobs)]), jobs);
  }
  for (const args of [
    ['--jobs', '1'],
    ['--jobs', '9'],
    ['--jobs', '2.5'],
    ['--jobs'],
    ['--jobs', '2', '--jobs', '3'],
    ['--suite', 'core']
  ]) {
    assert.throws(() => parseParallelSelftestJobs(args), /Usage: npm run soter:selftest/);
  }

  const bareCli = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'soter/core/cli.mjs'),
    'selftest'
  ], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  assert.equal(bareCli.status, 1);
  assert.match(bareCli.stderr, /npm run soter:selftest/);

  const roots = [];
  const ordinaryLogDirectories = matchingLogDirectories(os.tmpdir());
  try {
    const defaultSuites = Array.from({ length: 10 }, (_, index) => 'suite-' + index);
    const defaults = initializeFixture({ roots, suites: defaultSuites });
    const defaultResult = await captureRunner({ args: [], root: defaults.root });
    assert.equal(defaultResult.exitCode, 0);
    assert(!defaultResult.output.includes('PASS_LOG_MUST_NOT_BE_REPORTED'));
    assert.match(defaultResult.output, /all 10 suites passed/);
    const defaultState = JSON.parse(fs.readFileSync(defaults.statePath, 'utf8'));
    assert.equal(defaultState.active, 0);
    assert.equal(defaultState.maximum, 8);
    assert.equal(defaultState.count, defaultSuites.length);
    assert.equal(defaultState.insideLogObserved, false);
    assert.deepEqual([...defaultState.seen].sort(), [...defaultSuites].sort());
    assert.deepEqual(matchingLogDirectories(os.tmpdir()), ordinaryLogDirectories);

    const failureSuites = ['alpha', 'beta', 'gamma', 'delta'];
    const failure = initializeFixture({ roots, suites: failureSuites });
    process.env.SOTER_RUNNER_FIXTURE_FAILURE = 'beta';
    process.env.SOTER_RUNNER_FIXTURE_NO_SENTINEL = 'delta';
    const failureResult = await captureRunner({ args: ['--jobs', '2'], root: failure.root });
    assert.equal(failureResult.exitCode, 1);
    assert(failureResult.output.indexOf('PASS alpha') < failureResult.output.indexOf('FAIL beta'));
    assert(failureResult.output.indexOf('FAIL beta') < failureResult.output.indexOf('PASS gamma'));
    assert(failureResult.output.indexOf('PASS gamma') < failureResult.output.indexOf('FAIL delta'));
    assert(failureResult.output.includes('EXPECTED_RUNNER_FAILURE_DETAIL'));
    assert(failureResult.output.includes('EXPECTED_ZERO_EXIT_WITHOUT_SENTINEL'));
    assert(failureResult.output.includes('missing the exact single-suite pass sentinel'));
    assert(!failureResult.output.includes('PASS_LOG_MUST_NOT_BE_REPORTED'));
    assert.match(failureResult.output, /2 of 4 suites failed/);
    const failureState = JSON.parse(fs.readFileSync(failure.statePath, 'utf8'));
    assert.equal(failureState.active, 0);
    assert.equal(failureState.maximum, 2);
    assert.equal(failureState.count, failureSuites.length);
    assert.equal(failureState.insideLogObserved, false);
    assert.deepEqual([...failureState.seen].sort(), [...failureSuites].sort());
    assert.deepEqual(matchingLogDirectories(os.tmpdir()), ordinaryLogDirectories);

    if (process.platform !== 'win32') {
      const interruptRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'soter runner interrupt selftest ')
      );
      roots.push(interruptRoot);
      const grandchildReadyPath = path.join(interruptRoot, 'grandchild-ready');
      const latePath = path.join(interruptRoot, 'late');
      const insideLogPath = path.join(interruptRoot, 'inside-log-observed');
      writeFixtureFile(path.join(interruptRoot, 'soter/core/cli.mjs'), `
        import fs from 'node:fs';
        import { spawn } from 'node:child_process';
        const args = process.argv.slice(2);
        if (args[1] === '--list-suites') {
          process.stdout.write('interrupt\\n');
          process.exit(0);
        }
        process.on('SIGTERM', () => {});
        if (fs.readdirSync(process.cwd()).some((name) => name.startsWith('.soter-core-selftest-'))) {
          fs.writeFileSync(process.env.SOTER_RUNNER_INSIDE_LOG, 'inside');
        }
        spawn(process.execPath, ['-e', \`process.on('SIGTERM', () => {}); const fs = require('fs'); fs.writeFileSync(process.env.SOTER_RUNNER_GRANDCHILD_READY, 'ready'); setTimeout(() => fs.writeFileSync(process.env.SOTER_RUNNER_LATE_MARKER, 'late'), 2500);\`], { stdio: 'ignore', env: process.env });
        setTimeout(() => {}, 10000);
      `);
      const wrapperPath = path.join(interruptRoot, 'run.mjs');
      writeFixtureFile(wrapperPath, `
        import { runParallelCoreSelftests } from ${JSON.stringify(runnerModuleUrl)};
        process.exitCode = await runParallelCoreSelftests({
          args: ['--jobs', '2'],
          root: process.env.SOTER_RUNNER_INTERRUPT_ROOT
        });
      `);
      const externalLogParent = path.dirname(interruptRoot);
      const externalLogsBefore = matchingLogDirectories(externalLogParent);
      const wrapper = spawn(process.execPath, [wrapperPath], {
        cwd: interruptRoot,
        env: {
          ...process.env,
          TMPDIR: interruptRoot,
          SOTER_RUNNER_INTERRUPT_ROOT: interruptRoot,
          SOTER_RUNNER_GRANDCHILD_READY: grandchildReadyPath,
          SOTER_RUNNER_LATE_MARKER: latePath,
          SOTER_RUNNER_INSIDE_LOG: insideLogPath
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let interruptionOutput = '';
      wrapper.stdout.on('data', (chunk) => { interruptionOutput += chunk.toString('utf8'); });
      wrapper.stderr.on('data', (chunk) => { interruptionOutput += chunk.toString('utf8'); });
      await waitForFile(grandchildReadyPath);
      wrapper.kill('SIGINT');
      const exit = await new Promise((resolve) => {
        wrapper.once('close', (code, signal) => resolve({ code, signal }));
      });
      assert.deepEqual(exit, { code: 130, signal: null });
      assert.match(interruptionOutput, /interrupted by SIGINT/);
      await sleep(800);
      assert(!fs.existsSync(latePath));
      assert(!fs.existsSync(insideLogPath));
      assert.deepEqual(matchingLogDirectories(externalLogParent), externalLogsBefore);
      assert.equal(
        fs.readdirSync(interruptRoot).filter((name) => name.startsWith(LOG_PREFIX)).length,
        0
      );
    }
  } finally {
    delete process.env.SOTER_RUNNER_FIXTURE_STATE;
    delete process.env.SOTER_RUNNER_FIXTURE_SUITES;
    delete process.env.SOTER_RUNNER_FIXTURE_FAILURE;
    delete process.env.SOTER_RUNNER_FIXTURE_NO_SENTINEL;
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }

  process.stdout.write(
    'Parallel Core selftest runner selftest passed: bounded jobs, exact execution, deterministic reports, failure-only logs, external temporary state, and interruption cleanup passed.\n'
  );
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  selftestParallelSelftestRunner().then((passed) => {
    process.exitCode = passed ? 0 : 1;
  }).catch((error) => {
    process.stderr.write((error?.stack || error?.message || String(error)) + '\n');
    process.exitCode = 1;
  });
}
