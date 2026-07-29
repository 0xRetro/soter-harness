import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from '../../core/inspection.mjs';
import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  writeJson
} from '../../core/lib/canonical-json.mjs';
import {
  inspectPreparedAutomationDerivedReviewMaterial,
  inspectPreparedAutomationReviewMaterial,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import { createPreparedReviewBatch } from '../../core/prepared-review-batches.mjs';
import { resolveConfiguration } from '../../core/resolve.mjs';
import {
  loadProjectWorkPolicyDefinition,
  projectWorkPolicyFields
} from '../../contexts/projects/project-work-policy.mjs';
import { buildProjectDecisionResolutionPreview } from './prepare.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixture = readJson(path.join(root, 'soter/fixtures/providers/notion/workspace-records.json')).data;
const policy = projectWorkPolicyFields(loadProjectWorkPolicyDefinition(root));
const derivedDefinition = readJson(path.join(
  root,
  'soter/automations/project-decision-resolution/derived-review.json'
));
const projectId = 'https://www.notion.so/33333333333333333333333333333331';
const questionId = 'soter-fixture://projects/project-feed/question-confirm-scope';

function record(id) {
  const value = fixture.records.find((item) => item.id === id);
  assert(value, 'missing fixture record ' + id);
  return structuredClone(value);
}

function projectDocument() {
  const value = fixture.documents.find((item) => item.uri === projectId);
  assert(value, 'missing sparse project fixture document');
  return {
    ...structuredClone(value),
    format: 'markdown',
    bodyFingerprint: fingerprintJson(value.body)
  };
}

function privateFields(result, kind) {
  const item = result.derivedReview.items.find((candidate) => candidate.kind === kind);
  assert(item, 'missing private review item ' + kind);
  return Object.fromEntries(item.fields.map((field) => [field.id, field.reviewValue]));
}

const input = {
  project: projectId,
  question: questionId,
  workItemAction: 'Confirm delivery scope',
  decisionHeadline: 'Delivery scope approved PRIVATE_DECISION_HEADLINE_SENTINEL',
  decisionWhat: 'Ship the bounded first delivery PRIVATE_DECISION_WHAT_SENTINEL',
  decidedBy: 'Maya PRIVATE_DECIDED_BY_SENTINEL',
  decisionWhy: 'The evidence supports the bounded scope PRIVATE_DECISION_WHY_SENTINEL',
  decisionDate: '2026-07-22',
  visibility: 'Internal'
};

const ready = buildProjectDecisionResolutionPreview({
  input,
  policy,
  project: record(projectId),
  questionRecords: [record(questionId)],
  document: projectDocument(),
  derivedDefinition
});
assert.equal(ready.ready, true);
assert.deepEqual(ready.issues, []);
assert.equal(ready.preview.collections.length, 1);
assert.equal(ready.preview.collections[0].coverage.complete, true);
assert.equal(ready.preview.collections[0].coverage.observedCount, 3);
assert.equal(ready.preview.collections[0].rows.length, 3);
assert.equal(ready.preview.proposedChanges.length, 3);
assert.deepEqual(
  ready.preview.collections[0].rows.map((row) => row.actions[0].state),
  ['proposed', 'proposed', 'proposed']
);
assert.deepEqual(
  ready.preview.collections[0].rows.map((row) => row.actions[0].capability),
  ['projects.records.update', 'documents.content.update', 'projects.records.create']
);
for (const row of ready.preview.collections[0].rows) {
  assert.match(row.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(row.privateDetailFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(row.actions[0].changeFingerprint, /^sha256:[a-f0-9]{64}$/);
}
const requiredActionIds = [
  'action.project-decision-resolution.question-process',
  'action.project-decision-resolution.work-item-complete',
  'action.project-decision-resolution.decision-create'
];
assert.deepEqual(
  privateFields(ready, 'project-question-process').batchActionIds,
  requiredActionIds
);
assert.deepEqual(
  privateFields(ready, 'project-work-item-complete').batchActionIds,
  requiredActionIds
);
assert.deepEqual(
  privateFields(ready, 'project-decision-create').batchActionIds,
  requiredActionIds
);
assert.equal(privateFields(ready, 'project-question-process').afterProcessed, true);
assert.equal(
  privateFields(ready, 'project-work-item-complete').oldText,
  '\t- [ ] @2026-07-24 - Maya - Confirm delivery scope'
);
assert.equal(
  privateFields(ready, 'project-work-item-complete').newText,
  '\t- [x] @2026-07-24 - Maya - Confirm delivery scope'
);
assert.equal(
  privateFields(ready, 'project-decision-create').summary,
  input.decisionWhat + ' - ' + input.decidedBy + ' - ' + input.decisionWhy
);
assert.equal(privateFields(ready, 'project-decision-create').missingWhy, false);
const sanitizedReady = JSON.stringify(ready.preview);
for (const privateValue of [
  input.workItemAction,
  input.decisionHeadline,
  input.decisionWhat,
  input.decidedBy,
  input.decisionWhy,
  input.decisionDate
]) {
  assert.equal(sanitizedReady.includes(privateValue), false);
}
assert.equal(JSON.stringify(ready.derivedReview).includes(input.decisionWhy), true);

const missingWhyInput = structuredClone(input);
delete missingWhyInput.decisionWhy;
const missingWhy = buildProjectDecisionResolutionPreview({
  input: missingWhyInput,
  policy,
  project: record(projectId),
  questionRecords: [record(questionId)],
  document: projectDocument(),
  derivedDefinition
});
assert.equal(missingWhy.ready, true);
assert.equal(missingWhy.preview.proposedChanges.length, 3);
assert.equal(
  privateFields(missingWhy, 'project-decision-create').summary,
  input.decisionWhat + ' - ' + input.decidedBy + ' - [why not supplied]'
);
assert.equal(privateFields(missingWhy, 'project-decision-create').missingWhy, true);
assert(missingWhy.preview.contradictions.some((item) => {
  return item.id === 'project-decision-why-unavailable';
}));
assert.equal(JSON.stringify(missingWhy.preview).includes(input.decisionWhat), false);

const processedQuestion = record(questionId);
processedQuestion.fields.processed = true;
const alreadyProcessed = buildProjectDecisionResolutionPreview({
  input,
  policy,
  project: record(projectId),
  questionRecords: [processedQuestion],
  document: projectDocument(),
  derivedDefinition
});
assert.equal(alreadyProcessed.ready, false);
assert(alreadyProcessed.issues.includes('PROJECT_QUESTION_ALREADY_PROCESSED'));
assert.equal(alreadyProcessed.preview.proposedChanges.length, 0);
assert(alreadyProcessed.preview.collections[0].rows.every((row) => {
  return row.actions[0].state === 'held' && row.actions[0].changeFingerprint === null;
}));

const mismatchedQuestion = record(questionId);
mismatchedQuestion.fields.projectIds = ['https://www.notion.so/11111111111111111111111111111111'];
const projectMismatch = buildProjectDecisionResolutionPreview({
  input,
  policy,
  project: record(projectId),
  questionRecords: [mismatchedQuestion],
  document: projectDocument(),
  derivedDefinition
});
assert.equal(projectMismatch.ready, false);
assert(projectMismatch.issues.includes('PROJECT_QUESTION_PROJECT_MISMATCH'));
assert.equal(projectMismatch.preview.proposedChanges.length, 0);

const missingWorkInput = { ...input, workItemAction: 'PRIVATE_NONEXISTENT_WORK_SENTINEL' };
const missingWork = buildProjectDecisionResolutionPreview({
  input: missingWorkInput,
  policy,
  project: record(projectId),
  questionRecords: [record(questionId)],
  document: projectDocument(),
  derivedDefinition
});
assert.equal(missingWork.ready, false);
assert(missingWork.issues.includes('PROJECT_WORK_ITEM_NOT_FOUND'));
assert.equal(missingWork.preview.proposedChanges.length, 0);
assert.equal(JSON.stringify(missingWork.preview).includes(missingWorkInput.workItemAction), false);

function copyHarness(sourceRoot) {
  const temporaryRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'soter-project-decision-resolution-selftest-'
  ));
  for (const directory of ['soter']) {
    fs.cpSync(path.join(sourceRoot, directory), path.join(temporaryRoot, directory), {
      recursive: true
    });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(sourceRoot, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

async function coreBoundarySelftest(sourceRoot) {
  const temporaryRoot = copyHarness(sourceRoot);
  try {
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/project-decision-resolution.config.json'
    });
    const fixtureDirectory = path.join(
      temporaryRoot,
      'soter/fixtures/project-decision-resolution'
    );
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    writeJson(path.join(fixtureDirectory, 'project-decision-resolution.lock.json'), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const privateInput = {
      ...input,
      decisionHeadline: 'PRIVATE_CORE_DECISION_HEADLINE_SENTINEL',
      decisionWhat: 'PRIVATE_CORE_DECISION_WHAT_SENTINEL',
      decidedBy: 'PRIVATE_CORE_DECISION_ACTOR_SENTINEL',
      decisionWhy: 'PRIVATE_CORE_DECISION_REASON_SENTINEL'
    };
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-decision-resolution',
      configurationName: 'project-decision-resolution',
      configurationBasis: 'tracked-contained',
      input: privateInput,
      createdAt: '2026-07-22T12:10:00.000Z'
    });
    assert.equal(work.state, 'ready-for-review');
    assert.equal(work.preview.proposedChanges.length, 3);
    assert.equal(work.approval.state, 'not-requested');
    assert.equal(work.continuationRequest, null);
    assert.equal(work.resume.classification, 'requires-review');
    assert(work.preview.collections[0].rows.every((row) => {
      return row.actions[0].state === 'proposed';
    }));
    for (const fieldId of [
      'workItemAction',
      'decisionHeadline',
      'decisionWhat',
      'decidedBy',
      'decisionWhy',
      'decisionDate'
    ]) {
      const field = work.inputSummary.fields.find((candidate) => candidate.id === fieldId);
      assert.equal(field.exposure, 'private');
      assert.equal(Object.hasOwn(field, 'value'), false);
    }
    const review = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.equal(
      review.fields.find((field) => field.id === 'decisionWhy').reviewValue,
      privateInput.decisionWhy
    );
    const derived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.equal(derived.kind, 'project-decision-resolution-derived-review');
    assert.equal(derived.items.length, 3);
    const privateDecision = new Map(derived.items.find((item) => {
      return item.kind === 'project-decision-create';
    }).fields.map((field) => [field.id, field.reviewValue]));
    assert.equal(
      privateDecision.get('summary'),
      privateInput.decisionWhat + ' - ' + privateInput.decidedBy + ' - '
        + privateInput.decisionWhy
    );
    const batch = createPreparedReviewBatch({
      root: temporaryRoot,
      workId: work.id,
      actionIds: requiredActionIds,
      createdAt: '2026-07-22T12:11:00.000Z'
    });
    assert.equal(batch.scope.partial, false);
    assert.equal(batch.actions.length, 3);
    assert.equal(batch.state, 'review-only');
    assert.equal(batch.privacy.authority, 'none');
    assert.equal(batch.privacy.executionAuthorityIncluded, false);
    const inspection = inspectWorkspace({ root: temporaryRoot });
    const sanitized = JSON.stringify({ work, inspection, batch });
    for (const sentinel of [
      privateInput.decisionHeadline,
      privateInput.decisionWhat,
      privateInput.decidedBy,
      privateInput.decisionWhy
    ]) {
      assert.equal(sanitized.includes(sentinel), false);
    }
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function selftestProjectDecisionResolution(sourceRoot = root) {
  await coreBoundarySelftest(sourceRoot);
  process.stdout.write(
    'Project Decision Resolution exact-group, missing-why, Core boundary, and privacy selftest passed.\n'
  );
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await selftestProjectDecisionResolution();
}
