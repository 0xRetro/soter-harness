import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from '../../core/inspection.mjs';
import { fingerprintPath, writeJson } from '../../core/lib/canonical-json.mjs';
import {
  inspectPreparedAutomationDerivedReviewMaterial,
  inspectPreparedAutomationReviewMaterial,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import { resolveConfiguration } from '../../core/resolve.mjs';
import { runContainedProcessRedTeamScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T22:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-process-red-team-selftest-'));
  for (const directory of ['soter']) {
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function privateFields(material) {
  return material.items.map((item) => new Map(item.fields.map((field) => [field.id, field.reviewValue])));
}

function input(overrides = {}) {
  return {
    processUri: 'soter-fixture://process/definition/wallet-penny-test',
    includeLatestRun: true,
    fixRequested: false,
    ...overrides
  };
}

export async function selftestProcessRedTeam(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/process-red-team.config.json'
    });
    const fixtureDirectory = path.join(temporaryRoot, 'soter', 'fixtures', 'process-red-team');
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const lockPath = 'soter/fixtures/process-red-team/process-red-team.lock.json';
    writeJson(path.join(temporaryRoot, lockPath), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const scenario = await runContainedProcessRedTeamScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/process-red-team/preparation.scenario.json',
      workId: 'work.process-red-team.preparation-fixture',
      scenarioEvidenceId: 'evidence.process-red-team.preparation.fixture',
      createdAt: AT
    });
    assert.equal(scenario.assessment.result, 'passed', JSON.stringify(scenario.assessment, null, 2));
    assert.equal(scenario.scenarioEvidence.result, 'passed');

    const exactInput = input();
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.process-red-team',
      configurationName: 'process-red-team',
      configurationBasis: 'tracked-contained',
      input: exactInput,
      createdAt: '2026-07-21T22:01:00.000Z'
    });
    assert.equal(work.state, 'ready-for-review');
    assert.equal(work.preview.kind, 'process-red-team-preview');
    assert.equal(work.preview.proposedChanges.length, 0);
    assert.equal(work.approval.state, 'not-requested');
    assert.equal(work.continuationRequest, null);
    assert(work.preview.collections[0].rows.every((row) => row.actions[0].state === 'held'));
    const review = inspectPreparedAutomationReviewMaterial({ root: temporaryRoot, workId: work.id });
    assert.equal(review.fields.find((field) => field.id === 'processUri').reviewValue, exactInput.processUri);
    const derived = inspectPreparedAutomationDerivedReviewMaterial({ root: temporaryRoot, workId: work.id });
    const fields = privateFields(derived);
    assert(fields.some((item) => item.get('severity') === 'critical' && item.get('reproduced') === true));
    assert(fields.some((item) => item.get('lens') === 'operator-execution'));
    assert(fields.every((item) => item.get('disposition') === 'reported-for-decision'));

    const pressure = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.process-red-team',
      configurationName: 'process-red-team',
      configurationBasis: 'tracked-contained',
      input: input({ fixRequested: true }),
      createdAt: '2026-07-21T22:02:00.000Z'
    });
    assert.equal(pressure.preview.proposedChanges.length, 0);
    assert(pressure.preview.contradictions.some((item) => item.id === 'process-auto-fix-request-withheld'));
    const pressureDerived = inspectPreparedAutomationDerivedReviewMaterial({ root: temporaryRoot, workId: pressure.id });
    assert(privateFields(pressureDerived).every((item) => item.get('disposition') === 'reported-fix-request-withheld'));

    const noRun = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.process-red-team',
      configurationName: 'process-red-team',
      configurationBasis: 'tracked-contained',
      input: input({ includeLatestRun: false }),
      createdAt: '2026-07-21T22:03:00.000Z'
    });
    const noRunDerived = inspectPreparedAutomationDerivedReviewMaterial({ root: temporaryRoot, workId: noRun.id });
    assert(privateFields(noRunDerived).every((item) => item.get('severity') !== 'critical'));

    const missingTarget = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.process-red-team',
      configurationName: 'process-red-team',
      configurationBasis: 'tracked-contained',
      input: input({ processUri: 'soter-fixture://process/definition/private-missing-process' }),
      createdAt: '2026-07-21T22:04:00.000Z'
    });
    assert.equal(missingTarget.state, 'needs-input');
    assert.equal(missingTarget.readiness.blockers[0].reasonCode, 'PREPARATION_CONTEXT_UNAVAILABLE');

    const sanitized = JSON.stringify({ work, pressure, noRun, missingTarget, inspection: inspectWorkspace({ root: temporaryRoot }) });
    for (const sentinel of [
      exactInput.processUri,
      'Wallet Penny Test',
      'Address Verification',
      'Wallet Penny Test run 42',
      'destination.full-address-independently-compared',
      'The exact completed run reached the verified outcome without observing the required claim.',
      'Replace the contradictory instruction with an exact independent full-address comparison work-item after human approval.'
    ]) {
      assert(!sanitized.includes(sentinel), 'Sanitized projection leaked ' + sentinel + '.');
    }
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore);
    process.stdout.write('Process Red Team selftest: complete source scope, five governed lenses, reproduced criticals, ranked private findings, auto-fix refusal, read-only authority, and inspection privacy passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await selftestProcessRedTeam();
}
