import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { materializeContainedPrivateConfiguration } from '../../core/contained-private-configurations.mjs';
import {
  fingerprintJson,
  readJson
} from '../../core/lib/canonical-json.mjs';
import {
  assertDeclaredAutomationAcquisitionInspection,
  recoverDeclaredAutomationAcquisition
} from '../../core/connected-acquisitions.mjs';
import {
  inspectPreparedAutomationWork,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import {
  assertOperationPlanCheckpoint,
  assertOperationPlanDocument
} from '../../core/operation-plans.mjs';
import { fingerprintLock, resolveConfiguration } from '../../core/resolve.mjs';
import {
  completeDurableOperationPlanExecution,
  failDurableHostExecution
} from '../../core/service.mjs';
import {
  loadProjectCapturePolicyDefinition,
  projectCapturePolicyFields
} from '../../contexts/projects/project-capture-policy.mjs';
import {
  loadProjectWorkPolicyDefinition,
  projectWorkPolicyFields
} from '../../contexts/projects/project-work-policy.mjs';
import {
  loadTaskWorkPolicyDefinition,
  taskWorkPolicyFields
} from '../../contexts/tasks/task-work-policy.mjs';
import { validateJsonSchema } from '../../kernel/verify.mjs';
import { analyzeProjectPageReview } from './analysis.mjs';
import {
  assertProjectPageReviewConnectedPlan,
  buildProjectPageReviewConnectedViews,
  finalizeProjectPageReviewConnectedAcquisition,
  inspectProjectPageReviewConnected,
  inspectProjectPageReviewConnectedPrivate,
  prepareProjectPageReviewConnectedAcquisition
} from './context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HASH = 'sha256:' + '1'.repeat(64);
const WORK_ID = 'work.project-page-review.0123456789abcdef01234567';

function analysisPolicies(root) {
  return {
    projectCapture: projectCapturePolicyFields(loadProjectCapturePolicyDefinition(root)),
    projectWork: projectWorkPolicyFields(loadProjectWorkPolicyDefinition(root)),
    taskWork: taskWorkPolicyFields(loadTaskWorkPolicyDefinition(root))
  };
}

function providerOption(field, portable) {
  return 'PRIVATE_PROVIDER_PROJECT_PAGE_REVIEW_OPTION_'
    + field.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    + '_'
    + portable.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function optionMapping(mapping, recordType, field, values) {
  return {
    mapping,
    recordType,
    field,
    mode: 'exact-bijection',
    entries: values.map((portable) => ({
      portable,
      provider: providerOption(field, portable)
    }))
  };
}

function containedOptionMappings() {
  return [
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'projectType',
      ['Project']
    ),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'status',
      ['Active']
    ),
    optionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'status',
      ['To Do']
    ),
    optionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'context',
      ['Project']
    )
  ];
}

function copyHarness(sourceRoot) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'soter-project-page-connected-selftest-')
  );
  fs.cpSync(path.join(sourceRoot, 'soter'), path.join(temporaryRoot, 'soter'), {
    recursive: true
  });
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(sourceRoot, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function restorePrivateStateModes(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      fs.chmodSync(target, 0o700);
      restorePrivateStateModes(target);
    } else if (entry.isFile()) {
      fs.chmodSync(target, 0o600);
    }
  }
  fs.chmodSync(directory, 0o700);
}

function recordResponse(records, marker) {
  return {
    structuredContent: {
      result: {
        results: records.map((record) => ({
          __soterType: record.type,
          __soterId: record.id,
          __soterFields: JSON.stringify(record.fields)
        })),
        has_more: false,
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function documentResponse({ uri, title, body }, marker) {
  return {
    structuredContent: {
      result: {
        metadata: { type: 'page' },
        title,
        url: uri,
        text: '<page url="' + uri + '"><properties>{"title":'
          + JSON.stringify(title) + '}</properties>\n' + body + '\n</page>',
        rawProviderResponse: marker
      }
    },
    isError: false
  };
}

function step(id, capability, input = {}, inputBindings = []) {
  return {
    id,
    capability,
    authority: capability.startsWith('tasks.')
      ? 'authority.tasks.instance'
      : 'authority.projects.instance',
    providerImplementation: 'provider.integration.notion.mcp',
    input,
    inputBindings,
    reason: 'Exact read-only connected Project-page review source.'
  };
}

const plan = {
  $contract: 'soter://contracts/operation-plan/v2',
  contractVersion: '2.0.0',
  id: 'plan.project-page-review.connected-acquisition.0123456789abcdef01234567',
  runId: 'run.project-page-review.connected-acquisition.0123456789abcdef01234567',
  createdAt: '2026-07-29T11:00:00.000Z',
  mode: 'sequential',
  failurePolicy: 'stop',
  reason: 'Exact read-only Project-page acquisition selftest.',
  configuration: {
    name: 'project-page-review',
    configurationBasis: 'private-active',
    path: '.soter/state/configurations/project-page-review.json',
    lockPath: '.soter/state/configuration-locks/project-page-review.json',
    lockFingerprint: HASH,
    graphFingerprint: HASH
  },
  steps: [
    step(
      'step.project-page-review.capture-policy',
      'projects.records.read',
      { recordTypes: ['project-capture-policy'], ids: ['policy.project-capture'], limit: 2 }
    ),
    step(
      'step.project-page-review.project-work-policy',
      'projects.records.read',
      { recordTypes: ['project-work-policy'], ids: ['policy.projects'], limit: 2 }
    ),
    step(
      'step.project-page-review.task-work-policy',
      'tasks.records.read',
      { recordTypes: ['task-work-policy'], ids: ['policy.tasks'], limit: 2 }
    ),
    step(
      'step.project-page-review.template',
      'documents.content.read',
      {
        uri: 'soter-fixture://configuration-template/notion/document/project-page-template',
        expectedTitle: 'Portable Project page template'
      }
    ),
    step(
      'step.project-page-review.project',
      'projects.records.read',
      { recordTypes: ['project'], ids: ['private-project-reference'], limit: 2 }
    ),
    step(
      'step.project-page-review.tasks',
      'tasks.records.read',
      { recordTypes: ['task'], limit: 100 },
      [{
        id: 'binding.project-page-review-task-uris',
        sourceStepId: 'step.project-page-review.project',
        sourcePath: ['records', '*', 'fields', 'taskUris'],
        targetPath: ['ids'],
        transform: 'unique-string-list',
        onEmpty: 'skip-step'
      }]
    ),
    step(
      'step.project-page-review.document',
      'documents.content.read',
      {},
      [
        {
          id: 'binding.project-page-review-document-uri',
          sourceStepId: 'step.project-page-review.project',
          sourcePath: ['records', '*', 'id'],
          targetPath: ['uri'],
          transform: 'exact-string',
          onEmpty: 'fail-plan'
        },
        {
          id: 'binding.project-page-review-document-title',
          sourceStepId: 'step.project-page-review.project',
          sourcePath: ['records', '*', 'fields', 'name'],
          targetPath: ['expectedTitle'],
          transform: 'exact-string',
          onEmpty: 'fail-plan'
        }
      ]
    )
  ]
};

const shape = assertProjectPageReviewConnectedPlan(plan);
assert.equal(shape.workId, WORK_ID);
assert.equal(
  shape.snapshotId,
  'context.project-page-review.connected-acquisition.0123456789abcdef01234567'
);
const reordered = structuredClone(plan);
[reordered.steps[0], reordered.steps[1]] = [reordered.steps[1], reordered.steps[0]];
assert.throws(
  () => assertProjectPageReviewConnectedPlan(reordered),
  (error) => error.code === 'PROJECT_PAGE_CONNECTED_PLAN_INVALID'
);
const wrongBinding = structuredClone(plan);
wrongBinding.steps[5].inputBindings[0].onEmpty = 'fail-plan';
assert.throws(
  () => assertProjectPageReviewConnectedPlan(wrongBinding),
  (error) => error.code === 'PROJECT_PAGE_CONNECTED_PLAN_INVALID'
);
const wrongDocument = structuredClone(plan);
wrongDocument.steps[6].inputBindings[0].sourcePath = ['records', '*', 'providerId'];
assert.throws(
  () => assertProjectPageReviewConnectedPlan(wrongDocument),
  (error) => error.code === 'PROJECT_PAGE_CONNECTED_PLAN_INVALID'
);
const derivedIdCollision = structuredClone(plan);
derivedIdCollision.steps = derivedIdCollision.steps.slice(0, 2);
derivedIdCollision.steps[0].id = 'step.project-page-review.a-b';
derivedIdCollision.steps[1].id = 'step.project-page-review.a.b';
assert.throws(
  () => assertOperationPlanDocument(root, derivedIdCollision),
  /unique exact host-call identifiers/
);

const fixture = readJson(path.join(
  root,
  'soter/fixtures/providers/notion/workspace-records.json'
)).data;
const templateSource = fixture.documents.find((document) => {
  return document.uri
    === 'soter-fixture://configuration-template/notion/document/project-page-template';
});
const projectRecord = fixture.records.find((record) => {
  return record.id === 'soter-fixture://projects/project/launch';
});
const taskRecord = fixture.records.find((record) => {
  return record.id === 'soter-fixture://tasks/task/existing-deck';
});
const pageSource = fixture.documents.find((document) => document.uri === projectRecord.id);
const templateDocument = {
  ...templateSource,
  format: 'markdown',
  bodyFingerprint: fingerprintJson(templateSource.body)
};
const document = {
  ...pageSource,
  format: 'markdown',
  bodyFingerprint: fingerprintJson(pageSource.body)
};
const lock = resolveConfiguration({
  root,
  configPath: 'soter/configurations/project-page-review.config.json'
});
const analysis = analyzeProjectPageReview({
  project: projectRecord,
  tasks: [taskRecord],
  document,
  templateDocument,
  settings: lock.settings['automation.project-page-review'],
  policies: analysisPolicies(root)
});
const work = {
  id: WORK_ID,
  fingerprint: fingerprintJson({ id: WORK_ID }),
  checkpoint: {
    fingerprint: fingerprintJson({ id: 'checkpoint.' + WORK_ID })
  },
  configuration: {
    name: 'project-page-review'
  }
};
const prepared = {
  work,
  lock,
  privateInputFingerprint: fingerprintJson({
    project: projectRecord.id,
    focus: 'PRIVATE_FOCUS_NOT_PROJECTED'
  })
};
const snapshot = {
  id: shape.snapshotId,
  runId: plan.runId,
  createdAt: plan.createdAt,
  marker: fingerprintJson('private-snapshot')
};
const views = buildProjectPageReviewConnectedViews({
  root,
  prepared,
  snapshot,
  analysis
});
assert.equal(views.inspection.authority.state, 'none');
assert.equal(views.inspection.authority.approvalIncluded, false);
assert.equal(views.inspection.authority.continuationIncluded, false);
assert.equal(views.inspection.authority.providerWriteIncluded, false);
assert.equal(views.inspection.findings.counts.templateDatabases, 6);
assert.equal(views.inspection.findings.counts.pageDatabases, 1);
assert.deepEqual(
  {
    state: views.inspection.taskCoverage.state,
    reasonCode: views.inspection.taskCoverage.reasonCode,
    expected: views.inspection.taskCoverage.expectedCount,
    observed: views.inspection.taskCoverage.observedCount,
    unavailable: views.inspection.taskCoverage.unavailableCount
  },
  {
    state: 'complete',
    reasonCode: 'PROJECT_TASK_COVERAGE_COMPLETE',
    expected: 1,
    observed: 1,
    unavailable: 0
  }
);
assert.equal(views.review.project.name, 'Acme launch');
assert.equal(views.review.tasks[0].title, 'Send launch deck');
assert.deepEqual(views.review.taskCoverage.unavailableIdentityFingerprints, []);
assert.equal(views.review.privacy.rawUrlsIncluded, false);
assert.equal(views.review.privacy.rawPageBodiesIncluded, false);
assert.equal(views.review.authority.state, 'none');
assert.equal(views.review.fingerprint, (() => {
  const unsigned = structuredClone(views.review);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
})());
const sanitized = JSON.stringify(views.inspection);
for (const value of [
  projectRecord.id,
  taskRecord.id,
  projectRecord.fields.name,
  taskRecord.fields.title,
  document.body,
  templateDocument.body,
  'PRIVATE_FOCUS_NOT_PROJECTED'
]) {
  assert.equal(sanitized.includes(value), false, 'sanitized inspection leaked ' + value);
}
const selectedPrivate = JSON.stringify(views.review);
for (const value of [projectRecord.id, taskRecord.id, document.body, templateDocument.body]) {
  assert.equal(selectedPrivate.includes(value), false, 'private review leaked raw URL/body ' + value);
}
assert(selectedPrivate.includes('Acme launch'));
assert(selectedPrivate.includes('Send launch deck'));
assert(selectedPrivate.includes('Overview'));
assert(selectedPrivate.includes('database'));

const inspectionSchema = readJson(path.join(
  root,
  'soter/automations/project-page-review/connected-inspection.schema.json'
));
const reviewSchema = readJson(path.join(
  root,
  'soter/automations/project-page-review/connected-review.schema.json'
));
const hostileInspection = structuredClone(views.inspection);
hostileInspection.rawPageBody = 'HOSTILE_PRIVATE_BODY';
assert(validateJsonSchema(hostileInspection, inspectionSchema).length > 0);
const hostileReview = structuredClone(views.review);
hostileReview.project.rawUrl = 'https://provider.invalid/private-project';
assert(validateJsonSchema(hostileReview, reviewSchema).length > 0);
const hostileBody = structuredClone(views.review);
hostileBody.project.body = 'HOSTILE_PRIVATE_BODY';
assert(validateJsonSchema(hostileBody, reviewSchema).length > 0);
const hostileCoverage = structuredClone(views.inspection);
hostileCoverage.taskCoverage.unavailableIdentityFingerprints = [
  fingerprintJson('HOSTILE_PRIVATE_TASK_ID')
];
assert(validateJsonSchema(hostileCoverage, inspectionSchema).length > 0);

const emptyProject = structuredClone(projectRecord);
emptyProject.id = 'soter-fixture://projects/project/empty';
emptyProject.fields.name = 'Empty Project';
emptyProject.fields.taskUris = [];
const emptyDocument = {
  ...document,
  uri: emptyProject.id,
  title: emptyProject.fields.name
};
const emptyAnalysis = analyzeProjectPageReview({
  project: emptyProject,
  tasks: [],
  document: emptyDocument,
  templateDocument,
  settings: lock.settings['automation.project-page-review'],
  policies: analysisPolicies(root)
});
assert.equal(emptyAnalysis.tasks.length, 0);
assert.equal(emptyAnalysis.counts.relatedTasks, 0);
assert.equal(emptyAnalysis.state, 'attention-required');
assert.equal(emptyAnalysis.taskCoverage.state, 'complete');
assert.equal(emptyAnalysis.taskCoverage.expectedCount, 0);
assert.equal(emptyAnalysis.taskCoverage.observedCount, 0);
assert.equal(emptyAnalysis.taskCoverage.unavailableCount, 0);

const partialProject = structuredClone(projectRecord);
partialProject.id = 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
partialProject.fields = {
  ...partialProject.fields,
  name: 'Partial coverage Project',
  projectType: 'Project',
  status: 'Active',
  organizationUris: [],
  taskUris: Array.from({ length: 71 }, (_, index) => {
    return 'https://www.notion.so/'
      + String(index + 1).padStart(32, '0');
  })
};
const partialTasks = partialProject.fields.taskUris.slice(0, 28).map((id, index) => ({
  ...structuredClone(taskRecord),
  id,
  version: String(index + 1),
  fields: {
    ...structuredClone(taskRecord.fields),
    status: 'To Do',
    context: 'Project',
    projectUris: [partialProject.id]
  }
}));
const partialDocument = {
  uri: partialProject.id,
  title: partialProject.fields.name,
  format: 'markdown',
  body: templateDocument.body,
  bodyFingerprint: fingerprintJson(templateDocument.body)
};
assert.throws(() => analyzeProjectPageReview({
  project: partialProject,
  tasks: partialTasks,
  document: partialDocument,
  templateDocument,
  settings: lock.settings['automation.project-page-review'],
  policies: analysisPolicies(root)
}), /requires every and only the Tasks related by the Project/);
const partialAnalysis = analyzeProjectPageReview({
  project: partialProject,
  tasks: partialTasks,
  document: partialDocument,
  templateDocument,
  settings: lock.settings['automation.project-page-review'],
  policies: analysisPolicies(root),
  taskCoverageMode: 'allow-incomplete-no-authority'
});
assert.deepEqual(
  {
    state: partialAnalysis.taskCoverage.state,
    reasonCode: partialAnalysis.taskCoverage.reasonCode,
    expected: partialAnalysis.taskCoverage.expectedCount,
    observed: partialAnalysis.taskCoverage.observedCount,
    unavailable: partialAnalysis.taskCoverage.unavailableCount
  },
  {
    state: 'incomplete',
    reasonCode: 'PROJECT_TASK_COVERAGE_INCOMPLETE',
    expected: 71,
    observed: 28,
    unavailable: 43
  }
);
assert.equal(partialAnalysis.state, 'attention-required');
assert(partialAnalysis.project.reasonCodes.includes('PROJECT_TASK_COVERAGE_INCOMPLETE'));
assert.equal(partialAnalysis.taskCoverage.unavailableIdentityFingerprints.length, 43);
const partialViews = buildProjectPageReviewConnectedViews({
  root,
  prepared,
  snapshot,
  analysis: partialAnalysis
});
assert.equal(partialViews.inspection.taskCoverage.state, 'incomplete');
assert.equal(partialViews.inspection.taskCoverage.expectedCount, 71);
assert.equal(partialViews.inspection.taskCoverage.observedCount, 28);
assert.equal(partialViews.inspection.taskCoverage.unavailableCount, 43);
assert.equal(
  Object.hasOwn(
    partialViews.inspection.taskCoverage,
    'unavailableIdentityFingerprints'
  ),
  false
);
assert.equal(
  partialViews.review.taskCoverage.unavailableIdentityFingerprints.length,
  43
);
assert.equal(partialViews.inspection.findings.state, 'attention-required');
assert(partialViews.inspection.findings.reasonCodes.includes(
  'PROJECT_TASK_COVERAGE_INCOMPLETE'
));
assert.equal(partialViews.inspection.authority.state, 'none');
assert.equal(partialViews.inspection.authority.approvalIncluded, false);
assert.equal(partialViews.inspection.authority.continuationIncluded, false);
assert.equal(partialViews.inspection.authority.providerWriteIncluded, false);
const partialSanitized = JSON.stringify(partialViews.inspection);
const partialPrivate = JSON.stringify(partialViews.review);
assert.equal(partialSanitized.includes('PROJECT_TASK_COVERAGE_COMPLETE'), false);
assert.equal(partialSanitized.includes('PROJECT_PAGE_REVIEW_CURRENT'), false);
for (const unavailableId of partialProject.fields.taskUris.slice(28)) {
  assert.equal(partialSanitized.includes(unavailableId), false);
  assert.equal(partialPrivate.includes(unavailableId), false);
}
const duplicatePartialTasks = [...partialTasks, structuredClone(partialTasks[0])];
assert.throws(() => analyzeProjectPageReview({
  project: partialProject,
  tasks: duplicatePartialTasks,
  document: partialDocument,
  templateDocument,
  settings: lock.settings['automation.project-page-review'],
  policies: analysisPolicies(root),
  taskCoverageMode: 'allow-incomplete-no-authority'
}), /rejects duplicate observed Task identities/);
const substitutedPartialTasks = structuredClone(partialTasks);
substitutedPartialTasks[0].id = 'https://www.notion.so/ffffffffffffffffffffffffffffffff';
assert.throws(() => analyzeProjectPageReview({
  project: partialProject,
  tasks: substitutedPartialTasks,
  document: partialDocument,
  templateDocument,
  settings: lock.settings['automation.project-page-review'],
  policies: analysisPolicies(root),
  taskCoverageMode: 'allow-incomplete-no-authority'
}), /rejects substituted or out-of-scope Task identities/);

async function durableEmptyTaskConnectedSelftest() {
  const temporaryRoot = copyHarness(root);
  try {
    const { notion } = materializeContainedPrivateConfiguration({
      root: temporaryRoot,
      configurationName: 'project-page-review',
      notionOptionMappings: containedOptionMappings()
    });
    const privateProjectId = 'https://www.notion.so/99999999999999999999999999999999';
    const privateProjectName = 'PRIVATE_EMPTY_CONNECTED_PROJECT';
    const preparedWork = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-page-review',
      configurationName: 'project-page-review',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        project: privateProjectId,
        focus: 'PRIVATE_EMPTY_TASK_SKIP_FOCUS'
      },
      createdAt: '2026-07-29T11:30:00.000Z'
    });
    assert.equal(preparedWork.state, 'ready-for-acquisition');
    const durableWork = inspectPreparedAutomationWork({
      root: temporaryRoot,
      workId: preparedWork.id
    });
    assert.equal(durableWork.id, preparedWork.id);

    const captureDefinition = loadProjectCapturePolicyDefinition(temporaryRoot);
    const projectWorkDefinition = loadProjectWorkPolicyDefinition(temporaryRoot);
    const taskWorkDefinition = loadTaskWorkPolicyDefinition(temporaryRoot);
    const fixtureData = readJson(path.join(
      temporaryRoot,
      'soter/fixtures/providers/notion/workspace-records.json'
    )).data;
    const templateUri = notion.documentUris[
      'soter-fixture://configuration-template/notion/document/project-page-template'
    ];
    const template = fixtureData.documents.find((item) => item.uri === templateUri);
    assert(template);

    let execution = await prepareProjectPageReviewConnectedAcquisition({
      root: temporaryRoot,
      workId: preparedWork.id,
      at: '2026-07-29T11:30:01.000Z',
      expectedHost: 'codex'
    });
    const complete = async (response, at) => {
      execution = await completeDurableOperationPlanExecution({
        root: temporaryRoot,
        checkpointId: execution.checkpoint.id,
        callId: execution.currentCall.id,
        response,
        at,
        expectedHost: 'codex'
      });
    };
    await complete(recordResponse([{
      type: 'project-capture-policy',
      id: notion.recordUris['policy.project-capture'],
      fields: { name: captureDefinition.name }
    }], 'RAW_EMPTY_CAPTURE_POLICY_SENTINEL'), '2026-07-29T11:30:02.000Z');
    await complete(recordResponse([{
      type: 'project-work-policy',
      id: notion.recordUris['policy.projects'],
      fields: { name: projectWorkDefinition.name }
    }], 'RAW_EMPTY_PROJECT_WORK_POLICY_SENTINEL'), '2026-07-29T11:30:03.000Z');
    await complete(recordResponse([{
      type: 'task-work-policy',
      id: notion.recordUris['policy.tasks'],
      fields: { name: taskWorkDefinition.name }
    }], 'RAW_EMPTY_TASK_WORK_POLICY_SENTINEL'), '2026-07-29T11:30:04.000Z');
    await complete(documentResponse({
      uri: templateUri,
      title: template.title,
      body: template.body
    }, 'RAW_EMPTY_TEMPLATE_SENTINEL'), '2026-07-29T11:30:05.000Z');
    await complete(recordResponse([{
      type: 'project',
      id: privateProjectId,
      fields: {
        name: privateProjectName,
        projectType: providerOption('projectType', 'Project'),
        status: providerOption('status', 'Active'),
        organizationUris: JSON.stringify([]),
        taskUris: JSON.stringify([])
      }
    }], 'RAW_EMPTY_PROJECT_SENTINEL'), '2026-07-29T11:30:06.000Z');
    assert.equal(execution.currentCall.capability.id, 'documents.content.read');
    const skippedTaskStep = execution.checkpoint.steps.find((item) => {
      return item.id === 'step.project-page-review.tasks';
    });
    assert.equal(skippedTaskStep.state, 'skipped');
    assert.equal(skippedTaskStep.call, null);
    await complete(documentResponse({
      uri: privateProjectId,
      title: privateProjectName,
      body: template.body
    }, 'RAW_EMPTY_PROJECT_DOCUMENT_SENTINEL'), '2026-07-29T11:30:07.000Z');
    assert.equal(execution.checkpoint.state, 'completed');

    const finalized = finalizeProjectPageReviewConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex'
    });
    assert.deepEqual(finalized.snapshot.entries.map((entry) => entry.id), [
      'context.project-page-review.project-capture-policy',
      'context.project-page-review.project-work-policy',
      'context.project-page-review.task-work-policy',
      'context.project-page-review.template',
      'context.project-page-review.project',
      'context.project-page-review.document'
    ]);
    assert.equal(
      finalized.snapshot.entries.some((entry) => {
        return entry.id === 'context.project-page-review.tasks';
      }),
      false
    );
    assert.match(
      finalized.snapshot.runId,
      /^run\.project-page-review\.connected-acquisition\.[a-f0-9]{24}$/
    );
    const inspected = inspectProjectPageReviewConnected({
      root: temporaryRoot,
      workId: preparedWork.id,
      expectedHost: 'codex'
    });
    assert.equal(inspected.findings.counts.relatedTasks, 0);
    assert.equal(inspected.taskCoverage.state, 'complete');
    assert.equal(inspected.taskCoverage.expectedCount, 0);
    assert.equal(inspected.taskCoverage.observedCount, 0);
    assert.equal(inspected.taskCoverage.unavailableCount, 0);
    assert.equal(inspected.authority.state, 'none');
    assert.equal(JSON.stringify(inspected).includes(privateProjectId), false);
    assert.equal(JSON.stringify(inspected).includes(privateProjectName), false);
    const privateInspected = inspectProjectPageReviewConnectedPrivate({
      root: temporaryRoot,
      workId: preparedWork.id,
      expectedHost: 'codex'
    });
    await assertDeclaredAutomationAcquisitionInspection({
      root: temporaryRoot,
      automationId: 'automation.project-page-review',
      workId: preparedWork.id,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex',
      privateSelectedWork: false,
      projection: inspected
    });
    await assertDeclaredAutomationAcquisitionInspection({
      root: temporaryRoot,
      automationId: 'automation.project-page-review',
      workId: preparedWork.id,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex',
      privateSelectedWork: true,
      projection: privateInspected
    });
    const reseal = (value) => {
      const unsigned = structuredClone(value);
      delete unsigned.fingerprint;
      return { ...unsigned, fingerprint: fingerprintJson(unsigned) };
    };
    const hostileRawProvider = reseal({
      ...inspected,
      rawProviderResponse: 'HOSTILE_RAW_PROVIDER_SENTINEL'
    });
    await assert.rejects(
      assertDeclaredAutomationAcquisitionInspection({
        root: temporaryRoot,
        automationId: 'automation.project-page-review',
        workId: preparedWork.id,
        checkpointId: execution.checkpoint.id,
        expectedHost: 'codex',
        privateSelectedWork: false,
        projection: hostileRawProvider
      }),
      (error) => error.code === 'PREPARED_ACQUISITION_ADAPTER_INVALID'
    );
    const hostileAuthority = reseal({
      ...inspected,
      authority: { ...inspected.authority, state: 'approved' }
    });
    await assert.rejects(
      assertDeclaredAutomationAcquisitionInspection({
        root: temporaryRoot,
        automationId: 'automation.project-page-review',
        workId: preparedWork.id,
        checkpointId: execution.checkpoint.id,
        expectedHost: 'codex',
        privateSelectedWork: false,
        projection: hostileAuthority
      }),
      (error) => error.code === 'PREPARED_ACQUISITION_ADAPTER_INVALID'
    );
    const hostilePathProject = reseal({
      ...privateInspected.project,
      name: temporaryRoot
    });
    const hostilePath = reseal({
      ...privateInspected,
      project: hostilePathProject
    });
    await assert.rejects(
      assertDeclaredAutomationAcquisitionInspection({
        root: temporaryRoot,
        automationId: 'automation.project-page-review',
        workId: preparedWork.id,
        checkpointId: execution.checkpoint.id,
        expectedHost: 'codex',
        privateSelectedWork: true,
        projection: hostilePath
      }),
      (error) => error.code === 'PREPARED_ACQUISITION_ADAPTER_INVALID'
    );
    const hostileCredentialValue = [
      's',
      'k-',
      'HOSTILE_PRIVATE_CREDENTIAL_SENTINEL_1234567890'
    ].join('');
    const hostileCredentialProject = reseal({
      ...privateInspected.project,
      name: hostileCredentialValue
    });
    const hostileCredential = reseal({
      ...privateInspected,
      project: hostileCredentialProject
    });
    await assert.rejects(
      assertDeclaredAutomationAcquisitionInspection({
        root: temporaryRoot,
        automationId: 'automation.project-page-review',
        workId: preparedWork.id,
        checkpointId: execution.checkpoint.id,
        expectedHost: 'codex',
        privateSelectedWork: true,
        projection: hostileCredential
      }),
      (error) => error.code === 'PREPARED_ACQUISITION_ADAPTER_INVALID'
    );
    const durable = JSON.stringify({
      checkpoint: execution.checkpoint,
      snapshot: finalized.snapshot,
      inspection: inspected
    });
    for (const marker of [
      'RAW_EMPTY_CAPTURE_POLICY_SENTINEL',
      'RAW_EMPTY_PROJECT_WORK_POLICY_SENTINEL',
      'RAW_EMPTY_TASK_WORK_POLICY_SENTINEL',
      'RAW_EMPTY_TEMPLATE_SENTINEL',
      'RAW_EMPTY_PROJECT_SENTINEL',
      'RAW_EMPTY_PROJECT_DOCUMENT_SENTINEL',
      'PRIVATE_EMPTY_TASK_SKIP_FOCUS'
    ]) {
      assert.equal(durable.includes(marker), false, marker + ' entered durable state.');
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function durablePartialTaskConnectedSelftest() {
  const temporaryRoot = copyHarness(root);
  try {
    const { notion } = materializeContainedPrivateConfiguration({
      root: temporaryRoot,
      configurationName: 'project-page-review',
      notionOptionMappings: containedOptionMappings()
    });
    const privateProjectId = 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const privateProjectName = 'PRIVATE_PARTIAL_CONNECTED_PROJECT';
    const expectedTaskIds = Array.from({ length: 71 }, (_, index) => {
      return 'https://www.notion.so/' + String(index + 1).padStart(32, '0');
    });
    const observedTaskIds = expectedTaskIds.slice(0, 28);
    const unavailableTaskIds = expectedTaskIds.slice(28);
    const preparedWork = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-page-review',
      configurationName: 'project-page-review',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        project: privateProjectId,
        focus: 'PRIVATE_PARTIAL_TASK_COVERAGE_FOCUS'
      },
      createdAt: '2026-07-29T12:30:00.000Z'
    });
    assert.equal(preparedWork.state, 'ready-for-acquisition');

    const captureDefinition = loadProjectCapturePolicyDefinition(temporaryRoot);
    const projectWorkDefinition = loadProjectWorkPolicyDefinition(temporaryRoot);
    const taskWorkDefinition = loadTaskWorkPolicyDefinition(temporaryRoot);
    const fixtureData = readJson(path.join(
      temporaryRoot,
      'soter/fixtures/providers/notion/workspace-records.json'
    )).data;
    const templateUri = notion.documentUris[
      'soter-fixture://configuration-template/notion/document/project-page-template'
    ];
    const template = fixtureData.documents.find((item) => item.uri === templateUri);
    assert(template);

    let execution = await prepareProjectPageReviewConnectedAcquisition({
      root: temporaryRoot,
      workId: preparedWork.id,
      at: '2026-07-29T12:30:01.000Z',
      expectedHost: 'codex'
    });
    const complete = async (response, at) => {
      execution = await completeDurableOperationPlanExecution({
        root: temporaryRoot,
        checkpointId: execution.checkpoint.id,
        callId: execution.currentCall.id,
        response,
        at,
        expectedHost: 'codex'
      });
    };
    await complete(recordResponse([{
      type: 'project-capture-policy',
      id: notion.recordUris['policy.project-capture'],
      fields: { name: captureDefinition.name }
    }], 'RAW_PARTIAL_CAPTURE_POLICY_SENTINEL'), '2026-07-29T12:30:02.000Z');
    await complete(recordResponse([{
      type: 'project-work-policy',
      id: notion.recordUris['policy.projects'],
      fields: { name: projectWorkDefinition.name }
    }], 'RAW_PARTIAL_PROJECT_WORK_POLICY_SENTINEL'), '2026-07-29T12:30:03.000Z');
    await complete(recordResponse([{
      type: 'task-work-policy',
      id: notion.recordUris['policy.tasks'],
      fields: { name: taskWorkDefinition.name }
    }], 'RAW_PARTIAL_TASK_WORK_POLICY_SENTINEL'), '2026-07-29T12:30:04.000Z');
    await complete(documentResponse({
      uri: templateUri,
      title: template.title,
      body: template.body
    }, 'RAW_PARTIAL_TEMPLATE_SENTINEL'), '2026-07-29T12:30:05.000Z');
    await complete(recordResponse([{
      type: 'project',
      id: privateProjectId,
      fields: {
        name: privateProjectName,
        projectType: providerOption('projectType', 'Project'),
        status: providerOption('status', 'Active'),
        organizationUris: JSON.stringify([]),
        taskUris: JSON.stringify(expectedTaskIds)
      }
    }], 'RAW_PARTIAL_PROJECT_SENTINEL'), '2026-07-29T12:30:06.000Z');
    assert.equal(execution.currentCall.capability.id, 'tasks.records.read');
    assert.deepEqual(
      execution.checkpoint.steps.find((item) => {
        return item.id === 'step.project-page-review.tasks';
      }).resolvedInput.ids,
      expectedTaskIds
    );
    const ineligibleRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'soter-project-page-recovery-ineligible-')
    );
    try {
      fs.cpSync(temporaryRoot, ineligibleRoot, { recursive: true });
      restorePrivateStateModes(path.join(ineligibleRoot, '.soter'));
      const ineligible = await failDurableHostExecution({
        root: ineligibleRoot,
        checkpointId: execution.checkpoint.id,
        callId: execution.currentCall.id,
        errorKind: 'authentication',
        at: '2026-07-29T12:30:06.050Z',
        expectedHost: 'codex'
      });
      const ineligibleStep = ineligible.checkpoint.steps.find((item) => {
        return item.id === 'step.project-page-review.tasks';
      });
      const ineligibleFile = path.join(ineligibleRoot, ineligible.checkpointPath);
      const beforeIneligibleRecovery = fs.readFileSync(ineligibleFile, 'utf8');
      await assert.rejects(
        recoverDeclaredAutomationAcquisition({
          root: ineligibleRoot,
          automationId: 'automation.project-page-review',
          workId: preparedWork.id,
          checkpointId: ineligible.checkpoint.id,
          checkpointFingerprint: ineligible.checkpoint.checkpointFingerprint,
          stepId: ineligibleStep.id,
          callId: ineligibleStep.call.id,
          callFingerprint: fingerprintJson(ineligibleStep.call),
          at: '2026-07-29T12:30:06.075Z',
          expectedHost: 'codex'
        }),
        (error) => error.code === 'PREPARED_ACQUISITION_RECOVERY_INVALID'
      );
      assert.equal(fs.readFileSync(ineligibleFile, 'utf8'), beforeIneligibleRecovery);
    } finally {
      fs.rmSync(ineligibleRoot, { recursive: true, force: true });
    }
    const completedPrefixFingerprint = fingerprintJson(
      execution.checkpoint.steps.slice(0, 5)
    );
    const failedCallId = execution.currentCall.id;
    execution = await failDurableHostExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: failedCallId,
      errorKind: 'rate-limit',
      at: '2026-07-29T12:30:06.100Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.checkpoint.state, 'failed');
    const failedTaskStep = execution.checkpoint.steps.find((item) => {
      return item.id === 'step.project-page-review.tasks';
    });
    assert.equal(failedTaskStep.error.code, 'HOST_CALL_RATE_LIMITED');
    const sourceCheckpointFingerprint = execution.checkpoint.checkpointFingerprint;
    const failedCallFingerprint = fingerprintJson(failedTaskStep.call);
    const checkpointFile = path.join(temporaryRoot, execution.checkpointPath);
    const cliParent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'soter-project-page-recovery-cli-')
    );
    try {
      const cliRoot = path.join(cliParent, 'harness');
      fs.cpSync(temporaryRoot, cliRoot, { recursive: true });
      restorePrivateStateModes(path.join(cliRoot, '.soter'));
      if (fs.existsSync(path.join(root, 'node_modules'))) {
        fs.symlinkSync(
          fs.realpathSync(path.join(root, 'node_modules')),
          path.join(cliRoot, 'node_modules'),
          'dir'
        );
      }
      const cliArguments = [
        path.join(cliRoot, 'soter/core/cli.mjs'),
        'operator-acquisition-recover',
        '--automation', 'automation.project-page-review',
        '--work', preparedWork.id,
        '--checkpoint', execution.checkpoint.id,
        '--checkpoint-fingerprint', sourceCheckpointFingerprint,
        '--step', failedTaskStep.id,
        '--call', failedCallId,
        '--call-fingerprint', failedCallFingerprint,
        '--host', 'codex',
        '--json'
      ];
      const recoveredByCli = spawnSync(process.execPath, [
        ...cliArguments,
        '--at', '2026-07-29T12:30:06.150Z'
      ], {
        cwd: cliRoot,
        encoding: 'utf8'
      });
      assert.equal(recoveredByCli.status, 0, recoveredByCli.stderr);
      const cliReceipt = JSON.parse(recoveredByCli.stdout);
      assert.equal(cliReceipt.currentCall.id, failedCallId + '.attempt-2');
      assert.equal(cliReceipt.recovery.replacementCallId, cliReceipt.currentCall.id);
      assert.equal(cliReceipt.recovery.authority.providerCallPerformed, false);
      const advancedCli = await completeDurableOperationPlanExecution({
        root: cliRoot,
        checkpointId: cliReceipt.checkpoint.id,
        callId: cliReceipt.currentCall.id,
        response: recordResponse(observedTaskIds.map((id, index) => ({
          type: 'task',
          id,
          fields: {
            title: 'PRIVATE_CLI_OBSERVED_TASK_' + String(index + 1).padStart(2, '0'),
            status: providerOption('status', 'To Do'),
            context: providerOption('context', 'Project'),
            projectUris: JSON.stringify([privateProjectId]),
            assigneeIds: JSON.stringify([]),
            nextActionOn: '2026-08-15'
          }
        })), 'HOSTILE_CLI_PROVIDER_PROSE_SENTINEL'),
        at: '2026-07-29T12:30:06.175Z',
        expectedHost: 'codex'
      });
      assert.equal(advancedCli.currentCall.capability.id, 'documents.content.read');
      const cliCheckpointFile = path.join(cliRoot, advancedCli.checkpointPath);
      const beforeStaleCli = fs.readFileSync(cliCheckpointFile, 'utf8');
      const staleCli = spawnSync(process.execPath, [
        ...cliArguments,
        '--at', '2026-07-29T12:30:06.200Z'
      ], {
        cwd: cliRoot,
        encoding: 'utf8'
      });
      assert.notEqual(staleCli.status, 0);
      assert.equal(
        fs.readFileSync(cliCheckpointFile, 'utf8'),
        beforeStaleCli,
        'Stale CLI recovery replay mutated the advanced checkpoint.'
      );
      assert.equal(staleCli.stderr.includes(advancedCli.currentCall.id), false);
      assert.equal(staleCli.stderr.includes('HOSTILE_CLI_PROVIDER_PROSE_SENTINEL'), false);
    } finally {
      fs.rmSync(cliParent, { recursive: true, force: true });
    }
    const beforeRejectedRecovery = fs.readFileSync(checkpointFile, 'utf8');
    await assert.rejects(
      recoverDeclaredAutomationAcquisition({
        root: temporaryRoot,
        automationId: 'automation.project-page-review',
        workId: preparedWork.id,
        checkpointId: execution.checkpoint.id,
        checkpointFingerprint: sourceCheckpointFingerprint,
        stepId: failedTaskStep.id,
        callId: failedCallId,
        callFingerprint: HASH,
        at: '2026-07-29T12:30:06.200Z',
        expectedHost: 'codex'
      }),
      (error) => error.code === 'PREPARED_ACQUISITION_RECOVERY_INVALID'
    );
    assert.equal(
      fs.readFileSync(checkpointFile, 'utf8'),
      beforeRejectedRecovery,
      'Rejected recovery mutated the exact failed checkpoint.'
    );
    const recovered = await recoverDeclaredAutomationAcquisition({
      root: temporaryRoot,
      automationId: 'automation.project-page-review',
      workId: preparedWork.id,
      checkpointId: execution.checkpoint.id,
      checkpointFingerprint: sourceCheckpointFingerprint,
      stepId: failedTaskStep.id,
      callId: failedCallId,
      callFingerprint: failedCallFingerprint,
      at: '2026-07-29T12:30:06.300Z',
      expectedHost: 'codex'
    });
    execution = recovered;
    assert.equal(execution.checkpoint.state, 'requested');
    assert.equal(execution.checkpoint.currentStepId, failedTaskStep.id);
    assert.equal(
      fingerprintJson(execution.checkpoint.steps.slice(0, 5)),
      completedPrefixFingerprint
    );
    assert.equal(
      execution.currentCall.id,
      failedCallId + '.attempt-2'
    );
    const recoveredTaskStep = execution.checkpoint.steps.find((item) => {
      return item.id === 'step.project-page-review.tasks';
    });
    assert.equal(recoveredTaskStep.priorCalls.length, 1);
    assert.equal(recoveredTaskStep.priorCalls[0].id, failedCallId);
    assert.equal(recoveredTaskStep.priorCalls[0].state, 'failed');
    assert.equal(recoveredTaskStep.priorCalls[0].error.code, 'HOST_CALL_RATE_LIMITED');
    assert.equal(recoveredTaskStep.call.argumentsFingerprint,
      recoveredTaskStep.priorCalls[0].argumentsFingerprint);
    assert.equal(execution.recovery.attempt, 2);
    assert.equal(execution.recovery.retry.maxAttempts, 3);
    assert.equal(Object.hasOwn(execution.recovery, 'sourceCheckpointFingerprint'), false);
    assert.equal(
      execution.recovery.replacementRequestFingerprint.startsWith('sha256:'),
      true
    );
    assert.equal(execution.recovery.authority.providerCallPerformed, false);
    assert.equal(execution.recovery.authority.writeAuthorityIncluded, false);
    assert.equal(execution.recovery.authority.reusableRetryAuthorityIncluded, false);
    assert.equal(
      JSON.stringify(execution.recovery).includes(privateProjectId),
      false
    );
    const beforeStaleSourceReplay = fs.readFileSync(checkpointFile, 'utf8');
    await assert.rejects(
      recoverDeclaredAutomationAcquisition({
        root: temporaryRoot,
        automationId: 'automation.project-page-review',
        workId: preparedWork.id,
        checkpointId: execution.checkpoint.id,
        checkpointFingerprint: sourceCheckpointFingerprint,
        stepId: failedTaskStep.id,
        callId: failedCallId,
        callFingerprint: failedCallFingerprint,
        at: '2026-07-29T12:30:06.350Z',
        expectedHost: 'codex'
      }),
      (error) => error.code === 'PREPARED_ACQUISITION_RECOVERY_INVALID'
    );
    assert.equal(fs.readFileSync(checkpointFile, 'utf8'), beforeStaleSourceReplay);
    const replayedRecovery = await recoverDeclaredAutomationAcquisition({
      root: temporaryRoot,
      automationId: 'automation.project-page-review',
      workId: preparedWork.id,
      checkpointId: execution.checkpoint.id,
      checkpointFingerprint: execution.checkpoint.checkpointFingerprint,
      stepId: failedTaskStep.id,
      callId: failedCallId,
      callFingerprint: failedCallFingerprint,
      at: '2026-07-29T12:30:06.400Z',
      expectedHost: 'codex'
    });
    assert.equal(replayedRecovery.idempotent, true);
    assert.equal(
      replayedRecovery.checkpoint.checkpointFingerprint,
      execution.checkpoint.checkpointFingerprint
    );
    assert.equal(replayedRecovery.currentCall.id, failedCallId + '.attempt-2');
    execution = replayedRecovery;
    const secondFailedCallId = execution.currentCall.id;
    execution = await failDurableHostExecution({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      callId: secondFailedCallId,
      errorKind: 'retryable',
      at: '2026-07-29T12:30:06.500Z',
      expectedHost: 'codex'
    });
    const secondFailedTaskStep = execution.checkpoint.steps.find((item) => {
      return item.id === 'step.project-page-review.tasks';
    });
    const secondSourceCheckpointFingerprint
      = execution.checkpoint.checkpointFingerprint;
    const secondFailedCallFingerprint = fingerprintJson(secondFailedTaskStep.call);
    execution = await recoverDeclaredAutomationAcquisition({
      root: temporaryRoot,
      automationId: 'automation.project-page-review',
      workId: preparedWork.id,
      checkpointId: execution.checkpoint.id,
      checkpointFingerprint: secondSourceCheckpointFingerprint,
      stepId: secondFailedTaskStep.id,
      callId: secondFailedCallId,
      callFingerprint: secondFailedCallFingerprint,
      at: '2026-07-29T12:30:06.600Z',
      expectedHost: 'codex'
    });
    assert.equal(execution.currentCall.id, failedCallId + '.attempt-3');
    assert.equal(execution.recovery.attempt, 3);
    assert.equal(secondFailedTaskStep.error.code, 'HOST_CALL_RETRYABLE_FAILURE');
    const thirdAttemptStep = execution.checkpoint.steps.find((item) => {
      return item.id === 'step.project-page-review.tasks';
    });
    assert.equal(thirdAttemptStep.priorCalls.length, 2);
    assert.deepEqual(
      thirdAttemptStep.priorCalls.map((call) => call.id),
      [failedCallId, failedCallId + '.attempt-2']
    );
    assert.equal(execution.checkpoint.recoveries.length, 2);
    const resealCheckpoint = (checkpoint) => {
      const unsigned = structuredClone(checkpoint);
      delete unsigned.checkpointFingerprint;
      return {
        ...unsigned,
        checkpointFingerprint: fingerprintJson(unsigned)
      };
    };
    const substitutedHistory = structuredClone(execution.checkpoint);
    substitutedHistory.steps.find((item) => {
      return item.id === 'step.project-page-review.tasks';
    }).priorCalls[0].id = failedCallId + '.attempt-2';
    assert.throws(
      () => assertOperationPlanCheckpoint(
        temporaryRoot,
        resealCheckpoint(substitutedHistory)
      ),
      /prior call|logical attempt|out-of-sequence/
    );
    const reorderedRecoveries = structuredClone(execution.checkpoint);
    reorderedRecoveries.recoveries.reverse();
    assert.throws(
      () => assertOperationPlanCheckpoint(
        temporaryRoot,
        resealCheckpoint(reorderedRecoveries)
      ),
      /recovery record|unique and contiguous/
    );
    const substitutedRecoveryFingerprint = structuredClone(execution.checkpoint);
    substitutedRecoveryFingerprint.recoveries[0].failedCallFingerprint = HASH;
    assert.throws(
      () => assertOperationPlanCheckpoint(
        temporaryRoot,
        resealCheckpoint(substitutedRecoveryFingerprint)
      ),
      /recovery record/
    );
    const substitutedReplacementFingerprint = structuredClone(execution.checkpoint);
    substitutedReplacementFingerprint.recoveries[0].replacementRequestFingerprint = HASH;
    assert.throws(
      () => assertOperationPlanCheckpoint(
        temporaryRoot,
        resealCheckpoint(substitutedReplacementFingerprint)
      ),
      /recovery record/
    );
    const exhaustedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'soter-project-page-recovery-exhausted-')
    );
    try {
      fs.cpSync(temporaryRoot, exhaustedRoot, { recursive: true });
      restorePrivateStateModes(path.join(exhaustedRoot, '.soter'));
      let exhausted = await failDurableHostExecution({
        root: exhaustedRoot,
        checkpointId: execution.checkpoint.id,
        callId: execution.currentCall.id,
        errorKind: 'rate-limit',
        at: '2026-07-29T12:30:06.700Z',
        expectedHost: 'codex'
      });
      const exhaustedStep = exhausted.checkpoint.steps.find((item) => {
        return item.id === 'step.project-page-review.tasks';
      });
      await assert.rejects(
        recoverDeclaredAutomationAcquisition({
          root: exhaustedRoot,
          automationId: 'automation.project-page-review',
          workId: preparedWork.id,
          checkpointId: exhausted.checkpoint.id,
          checkpointFingerprint: exhausted.checkpoint.checkpointFingerprint,
          stepId: exhaustedStep.id,
          callId: exhaustedStep.call.id,
          callFingerprint: fingerprintJson(exhaustedStep.call),
          at: '2026-07-29T12:30:06.800Z',
          expectedHost: 'codex'
        }),
        (error) => error.code === 'PREPARED_ACQUISITION_RECOVERY_INVALID'
      );
      exhausted = null;
    } finally {
      fs.rmSync(exhaustedRoot, { recursive: true, force: true });
    }
    await complete(recordResponse(observedTaskIds.map((id, index) => ({
      type: 'task',
      id,
      fields: {
        title: 'PRIVATE_OBSERVED_TASK_' + String(index + 1).padStart(2, '0'),
        status: providerOption('status', 'To Do'),
        context: providerOption('context', 'Project'),
        projectUris: JSON.stringify([privateProjectId]),
        assigneeIds: JSON.stringify([]),
        nextActionOn: '2026-08-15'
      }
    })), 'RAW_PARTIAL_TASKS_SENTINEL'), '2026-07-29T12:30:07.000Z');
    assert.equal(execution.currentCall.capability.id, 'documents.content.read');
    const afterTaskCompletionFile = fs.readFileSync(checkpointFile, 'utf8');
    await assert.rejects(
      recoverDeclaredAutomationAcquisition({
        root: temporaryRoot,
        automationId: 'automation.project-page-review',
        workId: preparedWork.id,
        checkpointId: execution.checkpoint.id,
        checkpointFingerprint: sourceCheckpointFingerprint,
        stepId: failedTaskStep.id,
        callId: failedCallId,
        callFingerprint: failedCallFingerprint,
        at: '2026-07-29T12:30:07.100Z',
        expectedHost: 'codex'
      }),
      (error) => error.code === 'PREPARED_ACQUISITION_RECOVERY_INVALID'
        && error.message
          === 'Connected-acquisition read recovery was not eligible under the exact checkpoint and capability contract.'
    );
    await assert.rejects(
      recoverDeclaredAutomationAcquisition({
        root: temporaryRoot,
        automationId: 'automation.project-page-review',
        workId: preparedWork.id,
        checkpointId: execution.checkpoint.id,
        checkpointFingerprint: execution.checkpoint.checkpointFingerprint,
        stepId: failedTaskStep.id,
        callId: failedCallId,
        callFingerprint: failedCallFingerprint,
        at: '2026-07-29T12:30:07.125Z',
        expectedHost: 'codex'
      }),
      (error) => error.code === 'PREPARED_ACQUISITION_RECOVERY_INVALID'
    );
    assert.equal(
      fs.readFileSync(checkpointFile, 'utf8'),
      afterTaskCompletionFile,
      'Consumed recovery replay mutated or replaced the later document call.'
    );
    assert.equal(execution.currentCall.capability.id, 'documents.content.read');
    await complete(documentResponse({
      uri: privateProjectId,
      title: privateProjectName,
      body: template.body
    }, 'RAW_PARTIAL_PROJECT_DOCUMENT_SENTINEL'), '2026-07-29T12:30:08.000Z');
    assert.equal(execution.checkpoint.state, 'completed');
    const afterPlanCompletionFile = fs.readFileSync(checkpointFile, 'utf8');
    await assert.rejects(
      recoverDeclaredAutomationAcquisition({
        root: temporaryRoot,
        automationId: 'automation.project-page-review',
        workId: preparedWork.id,
        checkpointId: execution.checkpoint.id,
        checkpointFingerprint: sourceCheckpointFingerprint,
        stepId: failedTaskStep.id,
        callId: failedCallId,
        callFingerprint: failedCallFingerprint,
        at: '2026-07-29T12:30:08.100Z',
        expectedHost: 'codex'
      }),
      (error) => error.code === 'PREPARED_ACQUISITION_RECOVERY_INVALID'
    );
    await assert.rejects(
      recoverDeclaredAutomationAcquisition({
        root: temporaryRoot,
        automationId: 'automation.project-page-review',
        workId: preparedWork.id,
        checkpointId: execution.checkpoint.id,
        checkpointFingerprint: execution.checkpoint.checkpointFingerprint,
        stepId: failedTaskStep.id,
        callId: failedCallId,
        callFingerprint: failedCallFingerprint,
        at: '2026-07-29T12:30:08.125Z',
        expectedHost: 'codex'
      }),
      (error) => error.code === 'PREPARED_ACQUISITION_RECOVERY_INVALID'
    );
    assert.equal(
      fs.readFileSync(checkpointFile, 'utf8'),
      afterPlanCompletionFile,
      'Consumed recovery replay mutated the completed checkpoint.'
    );

    const finalized = finalizeProjectPageReviewConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex'
    });
    const taskSnapshot = finalized.snapshot.entries.find((entry) => {
      return entry.id === 'context.project-page-review.tasks';
    });
    assert(taskSnapshot);
    assert.equal(taskSnapshot.value.records.length, 28);
    assert.deepEqual(
      taskSnapshot.value.records.map((record) => record.id).sort(),
      observedTaskIds
    );
    assert.equal(
      taskSnapshot.value.records.some((record) => unavailableTaskIds.includes(record.id)),
      false
    );

    const inspected = inspectProjectPageReviewConnected({
      root: temporaryRoot,
      workId: preparedWork.id,
      expectedHost: 'codex'
    });
    assert.deepEqual(
      {
        state: inspected.taskCoverage.state,
        reasonCode: inspected.taskCoverage.reasonCode,
        expected: inspected.taskCoverage.expectedCount,
        observed: inspected.taskCoverage.observedCount,
        unavailable: inspected.taskCoverage.unavailableCount
      },
      {
        state: 'incomplete',
        reasonCode: 'PROJECT_TASK_COVERAGE_INCOMPLETE',
        expected: 71,
        observed: 28,
        unavailable: 43
      }
    );
    assert.equal(inspected.findings.state, 'attention-required');
    assert(inspected.findings.reasonCodes.includes('PROJECT_TASK_COVERAGE_INCOMPLETE'));
    assert.equal(inspected.findings.counts.relatedTasks, 28);
    assert.equal(Object.hasOwn(inspected.taskCoverage, 'unavailableIdentityFingerprints'), false);
    assert.equal(inspected.authority.state, 'none');
    assert.equal(inspected.authority.approvalIncluded, false);
    assert.equal(inspected.authority.continuationIncluded, false);
    assert.equal(inspected.authority.providerWriteIncluded, false);
    assert.equal(Object.hasOwn(inspected, 'actions'), false);
    assert.equal(Object.hasOwn(inspected.taskCoverage, 'supported'), false);
    assert.notEqual(inspected.taskCoverage.state, 'complete');

    const privateInspected = inspectProjectPageReviewConnectedPrivate({
      root: temporaryRoot,
      workId: preparedWork.id,
      expectedHost: 'codex'
    });
    assert.equal(privateInspected.tasks.length, 28);
    assert.deepEqual(
      privateInspected.taskCoverage.unavailableIdentityFingerprints,
      unavailableTaskIds.map((id) => fingerprintJson(id))
    );
    assert.equal(privateInspected.authority.state, 'none');
    assert.equal(Object.hasOwn(privateInspected, 'actions'), false);
    const sanitized = JSON.stringify(inspected);
    const selectedWork = JSON.stringify(privateInspected);
    for (const id of expectedTaskIds) {
      assert.equal(sanitized.includes(id), false);
      assert.equal(selectedWork.includes(id), false);
    }
    for (const marker of [
      'RAW_PARTIAL_CAPTURE_POLICY_SENTINEL',
      'RAW_PARTIAL_PROJECT_WORK_POLICY_SENTINEL',
      'RAW_PARTIAL_TASK_WORK_POLICY_SENTINEL',
      'RAW_PARTIAL_TEMPLATE_SENTINEL',
      'RAW_PARTIAL_PROJECT_SENTINEL',
      'RAW_PARTIAL_TASKS_SENTINEL',
      'RAW_PARTIAL_PROJECT_DOCUMENT_SENTINEL',
      'PRIVATE_PARTIAL_TASK_COVERAGE_FOCUS'
    ]) {
      assert.equal(sanitized.includes(marker), false, marker + ' entered sanitized inspection.');
      assert.equal(selectedWork.includes(marker), false, marker + ' entered selected-work review.');
    }
    await assertDeclaredAutomationAcquisitionInspection({
      root: temporaryRoot,
      automationId: 'automation.project-page-review',
      workId: preparedWork.id,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex',
      privateSelectedWork: false,
      projection: inspected
    });
    await assertDeclaredAutomationAcquisitionInspection({
      root: temporaryRoot,
      automationId: 'automation.project-page-review',
      workId: preparedWork.id,
      checkpointId: execution.checkpoint.id,
      expectedHost: 'codex',
      privateSelectedWork: true,
      projection: privateInspected
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

await durableEmptyTaskConnectedSelftest();
await durablePartialTaskConnectedSelftest();

assert.equal(fingerprintLock(lock), fingerprintLock(resolveConfiguration({
  root,
  configPath: 'soter/configurations/project-page-review.config.json'
})));

process.stdout.write(
  'Project-page review connected plan, selected-work inspection, exact Task coverage, empty-task, privacy, and no-authority selftest passed.\n'
);
