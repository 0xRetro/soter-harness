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
import { createReviewOnlyCandidateSelection } from '../../core/review-only-candidate-selections.mjs';
import { resolveConfiguration } from '../../core/resolve.mjs';
import {
  loadProjectWorkPolicyDefinition,
  projectWorkPolicyFields
} from '../../contexts/projects/project-work-policy.mjs';
import {
  loadTaskWorkPolicyDefinition,
  taskWorkPolicyFields
} from '../../contexts/tasks/task-work-policy.mjs';
import { buildProjectWorkPromotionPreview } from './prepare.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixture = readJson(path.join(root, 'soter/fixtures/providers/notion/workspace-records.json')).data;
const projectPolicy = projectWorkPolicyFields(loadProjectWorkPolicyDefinition(root));
const taskPolicy = taskWorkPolicyFields(loadTaskWorkPolicyDefinition(root));
const derivedDefinition = readJson(path.join(
  root,
  'soter/automations/project-work-promotion/derived-review.json'
));
const sparseProjectId = 'https://www.notion.so/33333333333333333333333333333331';
const healthyProjectId = 'https://www.notion.so/11111111111111111111111111111111';

function record(id) {
  const value = fixture.records.find((item) => item.id === id);
  assert(value, 'missing fixture record ' + id);
  return structuredClone(value);
}

function projectDocument(uri) {
  const value = fixture.documents.find((item) => item.uri === uri);
  assert(value, 'missing project fixture document ' + uri);
  return {
    ...structuredClone(value),
    format: 'markdown',
    bodyFingerprint: fingerprintJson(value.body)
  };
}

function privateFields(result) {
  assert.equal(result.derivedReview.items.length, 1);
  return Object.fromEntries(result.derivedReview.items[0].fields.map((field) => {
    return [field.id, field.reviewValue];
  }));
}

const trackedInput = {
  project: sparseProjectId,
  workItemAction: 'confirm delivery scope',
  disposition: 'tracked-execution',
  assignee: 'self'
};
const tracked = buildProjectWorkPromotionPreview({
  input: trackedInput,
  projectPolicy,
  taskPolicy,
  project: record(sparseProjectId),
  document: projectDocument(sparseProjectId),
  duplicateIds: [],
  assigneeIds: ['provider-person.maya'],
  derivedDefinition
});
assert.equal(tracked.ready, true);
assert.deepEqual(tracked.issues, []);
assert.equal(tracked.preview.proposedChanges.length, 1);
assert.equal(tracked.preview.proposedChanges[0].effect, 'tasks.records.create');
assert.equal(tracked.preview.proposedChanges[0].beforeFingerprint, null);
assert.equal(tracked.preview.collections[0].rows[0].actions[0].kind, 'project-work-task-create');
assert.equal(tracked.preview.collections[0].rows[0].actions[0].state, 'proposed');
assert.equal(privateFields(tracked).title, 'Confirm delivery scope');
assert.equal(privateFields(tracked).status, 'To Do');
assert.equal(privateFields(tracked).context, 'Project');
assert.deepEqual(privateFields(tracked).projectUris, [sparseProjectId]);
assert.deepEqual(privateFields(tracked).assigneeIds, ['provider-person.maya']);
assert.deepEqual(privateFields(tracked).nextActionOn, ['2026-07-24']);
assert.deepEqual(privateFields(tracked).duplicateCandidateIds, []);
assert.equal(
  tracked.preview.facts.find((fact) => fact.id === 'project-work-completion-boundary').value,
  'source-remains-incomplete'
);
const sanitizedTracked = JSON.stringify(tracked.preview);
assert.equal(sanitizedTracked.includes('Confirm delivery scope'), false);
assert.equal(sanitizedTracked.includes('confirm delivery scope'), false);
assert.equal(sanitizedTracked.includes('provider-person.maya'), false);
assert.equal(JSON.stringify(tracked.derivedReview).includes('Confirm delivery scope'), true);

const coordinationInput = {
  project: sparseProjectId,
  workItemAction: 'Confirm delivery scope',
  disposition: 'coordination-only'
};
const coordination = buildProjectWorkPromotionPreview({
  input: coordinationInput,
  projectPolicy,
  taskPolicy,
  project: record(sparseProjectId),
  document: projectDocument(sparseProjectId),
  duplicateIds: [],
  assigneeIds: [],
  derivedDefinition
});
assert.equal(coordination.ready, true);
assert.equal(coordination.preview.proposedChanges.length, 1);
assert.equal(coordination.preview.proposedChanges[0].effect, 'documents.content.update');
assert.equal(coordination.preview.collections[0].rows[0].actions[0].kind, 'project-work-item-complete');
assert.equal(coordination.preview.collections[0].rows[0].actions[0].state, 'proposed');
assert.equal(
  privateFields(coordination).oldText,
  '\t- [ ] @2026-07-24 - Maya - Confirm delivery scope'
);
assert.equal(
  privateFields(coordination).newText,
  '\t- [x] @2026-07-24 - Maya - Confirm delivery scope'
);
assert.equal(
  coordination.preview.facts.find((fact) => fact.id === 'project-work-completion-boundary').value,
  'source-completes-in-place'
);
assert.equal(
  coordination.preview.facts.some((fact) => fact.id === 'project-work-duplicate-count'),
  false
);
assert.equal(
  coordination.preview.facts.find((fact) => {
    return fact.id === 'project-work-duplicate-scan-applicability';
  }).value,
  false
);
assert.equal(JSON.stringify(coordination.preview).includes('Confirm delivery scope'), false);

const invalidCoordination = buildProjectWorkPromotionPreview({
  input: { ...coordinationInput, assignee: 'self' },
  projectPolicy,
  taskPolicy,
  project: record(sparseProjectId),
  document: projectDocument(sparseProjectId),
  duplicateIds: [],
  assigneeIds: ['provider-person.maya'],
  derivedDefinition
});
assert.equal(invalidCoordination.ready, false);
assert(invalidCoordination.issues.includes('PROJECT_COORDINATION_ASSIGNEE_INVALID'));
assert.equal(invalidCoordination.preview.proposedChanges.length, 0);
assert.equal(invalidCoordination.preview.collections[0].rows[0].actions[0].state, 'held');

const duplicate = buildProjectWorkPromotionPreview({
  input: {
    project: healthyProjectId,
    workItemAction: 'Publish launch brief',
    disposition: 'tracked-execution'
  },
  projectPolicy,
  taskPolicy,
  project: record(healthyProjectId),
  document: projectDocument(healthyProjectId),
  duplicateIds: ['https://www.notion.so/11111111111111111111111111111113'],
  assigneeIds: [],
  derivedDefinition
});
assert.equal(duplicate.ready, false);
assert(duplicate.issues.includes('PROJECT_WORK_TASK_DUPLICATE_CANDIDATE'));
assert.equal(duplicate.preview.proposedChanges.length, 0);
assert.equal(duplicate.preview.collections[0].rows[0].actions[0].state, 'held');
assert.equal(JSON.stringify(duplicate.preview).includes('Publish launch brief'), false);

const completedDocument = projectDocument(sparseProjectId);
completedDocument.body = completedDocument.body.replace(
  '\t- [ ] @2026-07-24 - Maya - Confirm delivery scope',
  '\t- [x] @2026-07-24 - Maya - Confirm delivery scope'
);
completedDocument.bodyFingerprint = fingerprintJson(completedDocument.body);
const completed = buildProjectWorkPromotionPreview({
  input: trackedInput,
  projectPolicy,
  taskPolicy,
  project: record(sparseProjectId),
  document: completedDocument,
  duplicateIds: [],
  assigneeIds: ['provider-person.maya'],
  derivedDefinition
});
assert.equal(completed.ready, false);
assert(completed.issues.includes('PROJECT_WORK_ITEM_ALREADY_COMPLETE'));
assert.equal(completed.preview.proposedChanges.length, 0);

const incompatibleTaskPolicy = structuredClone(taskPolicy);
incompatibleTaskPolicy.allowedContexts = ['Internal'];
const policyMismatch = buildProjectWorkPromotionPreview({
  input: trackedInput,
  projectPolicy,
  taskPolicy: incompatibleTaskPolicy,
  project: record(sparseProjectId),
  document: projectDocument(sparseProjectId),
  duplicateIds: [],
  assigneeIds: ['provider-person.maya'],
  derivedDefinition
});
assert.equal(policyMismatch.ready, false);
assert(policyMismatch.issues.includes('PROJECT_TASK_POLICY_INCOMPATIBLE'));
assert.equal(policyMismatch.preview.proposedChanges.length, 0);

function copyHarness(sourceRoot) {
  const temporaryRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'soter-project-work-promotion-selftest-'
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
    const providerFixturePath = path.join(
      temporaryRoot,
      'soter/fixtures/providers/notion/workspace-records.json'
    );
    const privateAction = 'PRIVATE_CORE_PROMOTION_ACTION_SENTINEL';
    const privateFixture = readJson(providerFixturePath);
    const privateDocument = privateFixture.data.documents.find((document) => {
      return document.uri === sparseProjectId;
    });
    privateDocument.body = privateDocument.body.replace(
      'Confirm delivery scope',
      privateAction
    );
    writeJson(providerFixturePath, privateFixture);
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/project-work-promotion.config.json'
    });
    const fixtureDirectory = path.join(
      temporaryRoot,
      'soter/fixtures/project-work-promotion'
    );
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    writeJson(path.join(fixtureDirectory, 'project-work-promotion.lock.json'), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const trackedWork = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-work-promotion',
      configurationName: 'project-work-promotion',
      configurationBasis: 'tracked-contained',
      input: {
        project: sparseProjectId,
        workItemAction: privateAction,
        disposition: 'tracked-execution',
        assignee: 'self'
      },
      createdAt: '2026-07-22T12:20:00.000Z'
    });
    assert.equal(trackedWork.state, 'ready-for-review');
    assert.equal(trackedWork.preview.proposedChanges.length, 1);
    assert.equal(trackedWork.preview.proposedChanges[0].effect, 'tasks.records.create');
    assert.equal(trackedWork.approval.state, 'not-requested');
    assert.equal(trackedWork.continuationRequest, null);
    const inputReview = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: trackedWork.id
    });
    assert.equal(
      inputReview.fields.find((field) => field.id === 'workItemAction').reviewValue,
      privateAction
    );
    const trackedDerived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: trackedWork.id
    });
    const trackedFields = new Map(trackedDerived.items[0].fields.map((field) => {
      return [field.id, field.reviewValue];
    }));
    assert.equal(trackedDerived.items[0].kind, 'project-work-task-create');
    assert.equal(trackedFields.get('title'), privateAction);
    assert.deepEqual(trackedFields.get('projectUris'), [sparseProjectId]);
    assert.deepEqual(trackedFields.get('assigneeIds'), ['provider-person.maya']);
    assert.deepEqual(trackedFields.get('nextActionOn'), ['2026-07-24']);
    const trackedAction = trackedWork.preview.collections[0].rows[0].actions[0];
    const selection = createReviewOnlyCandidateSelection({
      root: temporaryRoot,
      workId: trackedWork.id,
      actionIds: [trackedAction.id],
      createdAt: '2026-07-22T12:21:00.000Z'
    });
    assert.equal(selection.scope.partial, false);
    assert.equal(selection.state, 'review-only');
    assert.equal(selection.privacy.authority, 'none');
    assert.equal(selection.privacy.executionAuthorityIncluded, false);

    const coordinationWork = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-work-promotion',
      configurationName: 'project-work-promotion',
      configurationBasis: 'tracked-contained',
      input: {
        project: sparseProjectId,
        workItemAction: privateAction,
        disposition: 'coordination-only'
      },
      createdAt: '2026-07-22T12:22:00.000Z'
    });
    assert.equal(coordinationWork.state, 'ready-for-review');
    assert.equal(coordinationWork.preview.proposedChanges.length, 1);
    assert.equal(
      coordinationWork.preview.proposedChanges[0].effect,
      'documents.content.update'
    );
    const coordinationDerived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: coordinationWork.id
    });
    assert.equal(coordinationDerived.items[0].kind, 'project-work-item-complete');

    const duplicateWork = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-work-promotion',
      configurationName: 'project-work-promotion',
      configurationBasis: 'tracked-contained',
      input: {
        project: healthyProjectId,
        workItemAction: 'Publish launch brief',
        disposition: 'tracked-execution'
      },
      createdAt: '2026-07-22T12:23:00.000Z'
    });
    assert.equal(duplicateWork.state, 'ready-for-review');
    assert.equal(duplicateWork.preview.proposedChanges.length, 0);
    assert.equal(
      duplicateWork.preview.collections[0].rows[0].actions[0].reasonCode,
      'PROJECT_WORK_TASK_DUPLICATE_CANDIDATE'
    );
    assert.equal(duplicateWork.preview.collections[0].rows[0].actions[0].state, 'held');

    const inspection = inspectWorkspace({ root: temporaryRoot });
    const sanitized = JSON.stringify({
      trackedWork,
      coordinationWork,
      duplicateWork,
      inspection,
      selection
    });
    assert.equal(sanitized.includes(privateAction), false);
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function selftestProjectWorkPromotion(sourceRoot = root) {
  await coreBoundarySelftest(sourceRoot);
  process.stdout.write(
    'Project Work Promotion tracked, coordination, duplicate, Core boundary, and privacy selftest passed.\n'
  );
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await selftestProjectWorkPromotion();
}
