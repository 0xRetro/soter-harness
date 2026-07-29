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
import { createPreparedConnectedPlan } from '../../core/prepared-connected-plans.mjs';
import { createPreparedReviewBatch } from '../../core/prepared-review-batches.mjs';
import { resolveConfiguration } from '../../core/resolve.mjs';
import { buildCapturedProcessBody, loadProcessCapturePolicy } from '../../contexts/process/process-capture.mjs';
import { runContainedProcessCaptureScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T20:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-process-capture-selftest-'));
  for (const directory of ['soter']) {
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function privateFields(material) {
  return new Map(material.items[0].fields.map((field) => [field.id, field.reviewValue]));
}

function input(overrides = {}) {
  return {
    name: 'PRIVATE_PROCESS_NAME_SENTINEL',
    purpose: 'PRIVATE_PROCESS_PURPOSE_SENTINEL verifies one repeatable security outcome.',
    triggerKinds: ['Schedule'],
    triggers: ['PRIVATE_PROCESS_TRIGGER_SENTINEL the monthly review date is reached.'],
    frequency: 'Monthly',
    processLogicOwner: 'Security lead',
    stepRoles: ['Security lead'],
    stepCapabilities: ['Security Review'],
    stepObjectives: ['PRIVATE_PROCESS_STEP_SENTINEL verify the current signer set'],
    workItems: ['PRIVATE_PROCESS_WORK_ITEM_SENTINEL compare every signer with the reference.'],
    exceptionHandling: ['PRIVATE_PROCESS_EXCEPTION_SENTINEL unresolved identity stops the run.'],
    postRunSummaryFields: ['PRIVATE_PROCESS_SUMMARY_SENTINEL signer count'],
    category: 'Operations — Security',
    tags: ['Multisig'],
    relatedService: 'Security Operations',
    spawnTasks: false,
    ...overrides
  };
}

export async function selftestProcessCapture(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/process-capture.config.json'
    });
    const fixtureDirectory = path.join(temporaryRoot, 'soter', 'fixtures', 'process-capture');
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const lockPath = 'soter/fixtures/process-capture/process-capture.lock.json';
    writeJson(path.join(temporaryRoot, lockPath), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const policy = loadProcessCapturePolicy(temporaryRoot);
    assert.throws(() => buildCapturedProcessBody({
      policy,
      name: 'Injected\n## Purpose',
      purpose: 'Safe purpose.',
      triggerKinds: ['Schedule'],
      triggers: ['Safe trigger.'],
      frequency: 'Monthly',
      stepRoles: ['Security lead'],
      stepCapabilities: ['Security Review'],
      stepObjectives: ['Safe objective'],
      workItems: ['Safe work-item'],
      postRunSummaryFields: ['Outcome'],
      processLogicOwner: 'Security lead'
    }), /one bounded line/);
    assert.throws(() => buildCapturedProcessBody({
      policy,
      name: 'Safe name',
      purpose: 'Safe purpose.',
      triggerKinds: ['Schedule'],
      triggers: ['Safe trigger.'],
      frequency: 'Monthly',
      stepRoles: ['Security | hidden role'],
      stepCapabilities: ['Security Review'],
      stepObjectives: ['Safe objective'],
      workItems: ['Safe work-item'],
      postRunSummaryFields: ['Outcome'],
      processLogicOwner: 'Security lead'
    }), /Markdown table or code delimiters/);
    assert.throws(() => buildCapturedProcessBody({
      policy,
      name: 'Safe name',
      purpose: 'Safe purpose.',
      triggerKinds: ['Schedule'],
      triggers: ['Safe trigger.'],
      frequency: 'Monthly',
      stepRoles: ['Security lead'],
      stepCapabilities: ['Security `Review`'],
      stepObjectives: ['Safe objective'],
      workItems: ['Safe work-item'],
      postRunSummaryFields: ['Outcome'],
      processLogicOwner: 'Security lead'
    }), /Markdown table or code delimiters/);
    const scenario = await runContainedProcessCaptureScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/process-capture/preparation.scenario.json',
      workId: 'work.process-capture.preparation-fixture',
      scenarioEvidenceId: 'evidence.process-capture.preparation.fixture',
      createdAt: AT
    });
    assert.equal(scenario.assessment.result, 'passed');
    assert.equal(scenario.scenarioEvidence.result, 'passed');

    const exactInput = input();
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.process-capture',
      configurationName: 'process-capture',
      configurationBasis: 'tracked-contained',
      input: exactInput,
      createdAt: '2026-07-21T20:01:00.000Z'
    });
    assert.equal(work.state, 'ready-for-review');
    assert.equal(work.preview.kind, 'process-capture-preview');
    assert.equal(work.preview.proposedChanges.length, 1);
    assert.equal(work.approval.state, 'not-requested');
    assert.equal(work.continuationRequest, null);
    assert.equal(work.preview.collections[0].rows[0].actions[0].state, 'proposed');
    const review = inspectPreparedAutomationReviewMaterial({ root: temporaryRoot, workId: work.id });
    assert.equal(review.fields.find((field) => field.id === 'purpose').reviewValue, exactInput.purpose);
    const derived = inspectPreparedAutomationDerivedReviewMaterial({ root: temporaryRoot, workId: work.id });
    const fields = privateFields(derived);
    assert.equal(fields.get('name'), exactInput.name);
    assert.equal(fields.get('status'), 'Draft');
    assert.equal(fields.get('frequency'), 'Monthly');
    assert.deepEqual(fields.get('processLogicOwnerUris'), ['soter-fixture://process/role/security-lead']);
    assert(fields.get('body').includes('## Initialization'));
    assert(fields.get('body').includes(exactInput.workItems[0]));

    const batch = createPreparedReviewBatch({
      root: temporaryRoot,
      workId: work.id,
      actionIds: ['action.process-capture.create'],
      createdAt: '2026-07-21T20:01:30.000Z'
    });
    await assert.rejects(
      createPreparedConnectedPlan({
        root: temporaryRoot,
        batchId: batch.id,
        createdAt: '2026-07-21T20:02:00.000Z'
      }),
      (error) => error?.code === 'PREPARED_CONNECTED_PLAN_COMPILER_INVALID'
    );

    const duplicate = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.process-capture',
      configurationName: 'process-capture',
      configurationBasis: 'tracked-contained',
      input: input({ name: 'Existing incident response', frequency: 'Ad Hoc' }),
      createdAt: '2026-07-21T20:03:00.000Z'
    });
    assert.equal(duplicate.preview.proposedChanges.length, 0);
    assert(duplicate.preview.collections[0].rows[0].flags.includes('PROCESS_DUPLICATE_CANDIDATE_OBSERVED'));

    const tasks = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.process-capture',
      configurationName: 'process-capture',
      configurationBasis: 'tracked-contained',
      input: input({ name: 'Task-boundary process', spawnTasks: true }),
      createdAt: '2026-07-21T20:04:00.000Z'
    });
    assert.equal(tasks.preview.proposedChanges.length, 1);
    assert(tasks.preview.collections[0].rows[0].flags.includes('PROCESS_TASK_SPAWN_DECLINED'));
    assert(tasks.preview.collections[0].rows[0].actions.every((action) => action.capability === 'process.records.create'));

    const invalidParallelInput = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.process-capture',
      configurationName: 'process-capture',
      configurationBasis: 'tracked-contained',
      input: input({ stepRoles: ['Security lead', 'Treasury lead'] }),
      createdAt: '2026-07-21T20:05:00.000Z'
    });
    assert.equal(invalidParallelInput.state, 'needs-input');
    assert.equal(invalidParallelInput.readiness.blockers[0].reasonCode, 'PREPARATION_INPUT_INVALID');

    const sanitized = JSON.stringify({ work, duplicate, tasks, inspection: inspectWorkspace({ root: temporaryRoot }) });
    for (const sentinel of [
      exactInput.name,
      exactInput.purpose,
      ...exactInput.triggers,
      ...exactInput.stepObjectives,
      ...exactInput.workItems,
      ...exactInput.exceptionHandling,
      ...exactInput.postRunSummaryFields
    ]) {
      assert(!sanitized.includes(sentinel), 'Sanitized projection leaked ' + sentinel + '.');
    }
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore);
    process.stdout.write('Process Capture selftest: policy and schema grounding, exact options and relations, deterministic body, duplicate and task boundaries, private review, no authority, and inspection privacy passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await selftestProcessCapture();
}
