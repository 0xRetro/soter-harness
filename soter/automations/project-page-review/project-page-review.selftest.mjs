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
import { resolveConfiguration } from '../../core/resolve.mjs';
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
import { verifyConfigurationCandidate } from '../../kernel/verify.mjs';
import {
  analyzeProjectPageReview,
  compareProjectPageOutlines,
  normalizedProjectPageStructure,
  projectPageReviewAttention
} from './analysis.mjs';
import { runContainedProjectPageReviewScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-29T10:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-project-page-review-'));
  fs.cpSync(path.join(root, 'soter'), path.join(temporaryRoot, 'soter'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function field(material, kind, id) {
  const item = material.items.find((candidate) => candidate.kind === kind);
  return item.fields.find((candidate) => candidate.id === id).reviewValue;
}

function analysisPolicies(root) {
  return {
    projectCapture: projectCapturePolicyFields(loadProjectCapturePolicyDefinition(root)),
    projectWork: projectWorkPolicyFields(loadProjectWorkPolicyDefinition(root)),
    taskWork: taskWorkPolicyFields(loadTaskWorkPolicyDefinition(root))
  };
}

export async function selftestProjectPageReview(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const configurationPath = 'soter/configurations/project-page-review.config.json';
    const configuration = readJson(path.join(temporaryRoot, configurationPath));
    const invalidSettings = structuredClone(configuration);
    invalidSettings.settings['automation.project-page-review'].maximumOutlineEntries = 500;
    const invalid = verifyConfigurationCandidate(temporaryRoot, {
      configPath: path.join(temporaryRoot, configurationPath),
      configuration: invalidSettings
    });
    assert(invalid.violations.some((violation) => {
      return violation.code === 'SOTER_PACK_SETTINGS_SCHEMA'
        && violation.what.includes('automation.project-page-review');
    }));

    const fixture = readJson(path.join(
      temporaryRoot,
      'soter/fixtures/providers/notion/workspace-records.json'
    )).data;
    const template = fixture.documents.find((document) => {
      return document.uri
        === 'soter-fixture://configuration-template/notion/document/project-page-template';
    });
    const project = fixture.records.find((record) => {
      return record.id === 'soter-fixture://projects/project/launch';
    });
    const task = fixture.records.find((record) => {
      return record.id === 'soter-fixture://tasks/task/existing-deck';
    });
    const document = fixture.documents.find((candidate) => candidate.uri === project.id);
    const analysis = analyzeProjectPageReview({
      project,
      tasks: [task],
      document: {
        ...document,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(document.body)
      },
      templateDocument: {
        ...template,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(template.body)
      },
      settings: configuration.settings['automation.project-page-review'],
      policies: analysisPolicies(temporaryRoot)
    });
    assert.equal(analysis.state, 'attention-required');
    assert.deepEqual(
      {
        state: analysis.taskCoverage.state,
        reasonCode: analysis.taskCoverage.reasonCode,
        expected: analysis.taskCoverage.expectedCount,
        observed: analysis.taskCoverage.observedCount,
        unavailable: analysis.taskCoverage.unavailableCount
      },
      {
        state: 'complete',
        reasonCode: 'PROJECT_TASK_COVERAGE_COMPLETE',
        expected: 1,
        observed: 1,
        unavailable: 0
      }
    );
    assert.equal(analysis.counts.templateDatabases, 6);
    assert.equal(analysis.counts.pageDatabases, 1);
    assert.equal(analysis.counts.templateColumns, 1);
    assert.equal(analysis.counts.pageColumns, 0);
    assert(analysis.project.reasonCodes.includes('PROJECT_PAGE_TEMPLATE_STRUCTURE_DRIFT'));
    assert(analysis.project.reasonCodes.includes('PROJECT_PAGE_TYPE_FIELD_UNAVAILABLE'));
    assert(analysis.project.reasonCodes.includes('PROJECT_PAGE_MANAGER_IDENTITY_UNAVAILABLE'));
    assert(analysis.project.reasonCodes.includes(
      'PROJECT_PAGE_PROVIDER_LIVE_VIEW_WIRING_UNAVAILABLE'
    ));
    assert.deepEqual(analysis.tasks[0].reasonCodes, []);
    assert.equal(projectPageReviewAttention([
      'PROJECT_PAGE_MANAGER_IDENTITY_UNAVAILABLE',
      'PROJECT_PAGE_PROVIDER_LIVE_VIEW_WIRING_UNAVAILABLE'
    ]), 'no-one');
    assert.equal(projectPageReviewAttention([
      'PROJECT_TASK_ASSIGNEE_UNASSIGNED_ALLOWED'
    ]), 'no-one');
    assert.equal(projectPageReviewAttention([
      'PROJECT_TASK_NEXT_ACTION_NOT_SET'
    ]), 'operator');

    const reordered = compareProjectPageOutlines(
      '# Template\n\n## One\n\n**Two**\n',
      '# Page\n\n**Two**\n\n## One\n',
      { maximumOutlineEntries: 10 }
    );
    assert.equal(reordered.orderDrift, true);
    const fenced = compareProjectPageOutlines(
      '# Template\n\n## Real\n\n````md\n## Hostile injected heading\n<database />\n````\n',
      '# Page\n\n## Real\n\n~~~text\n**Hostile injected label**\n<callout />\n~~~\n',
      { maximumOutlineEntries: 10 }
    );
    assert.deepEqual(fenced.missing, []);
    assert.deepEqual(fenced.extra, []);
    assert.equal(fenced.orderDrift, false);
    assert.deepEqual(
      normalizedProjectPageStructure(
        '<database />\n```md\n<database />\n<callout />\n```\n<column_list />'
      ).counts,
      { database: 1, callout: 0, columns: 1 }
    );
    const duplicateMissing = compareProjectPageOutlines(
      '# Template\n\n## Repeat\n\n## Repeat\n',
      '# Page\n\n## Repeat\n',
      { maximumOutlineEntries: 10 }
    );
    assert.equal(duplicateMissing.template.length, 2);
    assert.equal(duplicateMissing.page.length, 1);
    assert.deepEqual(duplicateMissing.missing.map((entry) => entry.label), ['Repeat']);
    const duplicateExtra = compareProjectPageOutlines(
      '# Template\n\n## Repeat\n',
      '# Page\n\n## Repeat\n\n## Repeat\n',
      { maximumOutlineEntries: 10 }
    );
    assert.deepEqual(duplicateExtra.extra.map((entry) => entry.label), ['Repeat']);
    const structure = normalizedProjectPageStructure(
      '<database />\n<database />\n<callout />\n<column_list />'
    );
    assert.deepEqual(structure.counts, { database: 2, callout: 1, columns: 1 });

    const relationDrift = structuredClone(task);
    relationDrift.fields.projectUris = ['soter-fixture://projects/project/other'];
    const relationAnalysis = analyzeProjectPageReview({
      project,
      tasks: [relationDrift],
      document: {
        ...document,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(document.body)
      },
      templateDocument: {
        ...template,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(template.body)
      },
      settings: configuration.settings['automation.project-page-review'],
      policies: analysisPolicies(temporaryRoot)
    });
    assert(relationAnalysis.tasks[0].reasonCodes.includes(
      'PROJECT_TASK_RELATION_INCONSISTENT'
    ));
    const tooManyTasks = structuredClone(project);
    tooManyTasks.fields.taskUris = Array.from(
      { length: 101 },
      (_, index) => 'soter-fixture://tasks/task/' + String(index)
    );
    assert.throws(() => analyzeProjectPageReview({
      project: tooManyTasks,
      tasks: [],
      document: {
        ...document,
        uri: tooManyTasks.id,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(document.body)
      },
      templateDocument: {
        ...template,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(template.body)
      },
      settings: configuration.settings['automation.project-page-review'],
      policies: analysisPolicies(temporaryRoot)
    }), /at most 100 unique related Task/);

    const outOfPolicyProject = structuredClone(project);
    outOfPolicyProject.fields.projectType = 'Imaginary';
    outOfPolicyProject.fields.status = 'Imaginary Status';
    const outOfPolicyTask = structuredClone(task);
    outOfPolicyTask.fields.context = 'Alien';
    const policyAnalysis = analyzeProjectPageReview({
      project: outOfPolicyProject,
      tasks: [outOfPolicyTask],
      document: {
        ...document,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(document.body)
      },
      templateDocument: {
        ...template,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(template.body)
      },
      settings: configuration.settings['automation.project-page-review'],
      policies: analysisPolicies(temporaryRoot)
    });
    assert(policyAnalysis.project.reasonCodes.includes('PROJECT_PAGE_TYPE_OUT_OF_POLICY'));
    assert(policyAnalysis.project.reasonCodes.includes('PROJECT_PAGE_STATUS_OUT_OF_POLICY'));
    assert(policyAnalysis.tasks[0].reasonCodes.includes('PROJECT_TASK_CONTEXT_OUT_OF_POLICY'));
    assert.equal(policyAnalysis.state, 'attention-required');
    const driftedPolicies = analysisPolicies(temporaryRoot);
    driftedPolicies.projectWork.milestoneWorkItemsRemainDistinct = false;
    assert.throws(() => analyzeProjectPageReview({
      project,
      tasks: [task],
      document: {
        ...document,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(document.body)
      },
      templateDocument: {
        ...template,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(template.body)
      },
      settings: configuration.settings['automation.project-page-review'],
      policies: driftedPolicies
    }), /exact supported Project capture, Project work, and Task work policy semantics/);

    const unavailableProject = structuredClone(project);
    unavailableProject.id = 'soter-fixture://projects/project/availability-test';
    unavailableProject.fields.name = 'Availability test';
    unavailableProject.fields.taskUris = [
      'soter-fixture://tasks/task/availability-test'
    ];
    delete unavailableProject.fields.projectType;
    delete unavailableProject.fields.status;
    delete unavailableProject.fields.organizationUris;
    const unavailableTask = structuredClone(task);
    unavailableTask.id = unavailableProject.fields.taskUris[0];
    unavailableTask.fields.projectUris = [unavailableProject.id];
    delete unavailableTask.fields.context;
    delete unavailableTask.fields.nextActionOn;
    delete unavailableTask.fields.assigneeIds;
    const unavailableDocument = {
      uri: unavailableProject.id,
      title: unavailableProject.fields.name,
      format: 'markdown',
      body: template.body,
      bodyFingerprint: fingerprintJson(template.body)
    };
    const unavailableAnalysis = analyzeProjectPageReview({
      project: unavailableProject,
      tasks: [unavailableTask],
      document: unavailableDocument,
      templateDocument: {
        ...template,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(template.body)
      },
      settings: configuration.settings['automation.project-page-review'],
      policies: analysisPolicies(temporaryRoot)
    });
    assert.equal(unavailableAnalysis.state, 'reviewed');
    assert(unavailableAnalysis.project.reasonCodes.includes(
      'PROJECT_PAGE_TYPE_FIELD_UNAVAILABLE'
    ));
    assert(unavailableAnalysis.project.reasonCodes.includes(
      'PROJECT_PAGE_STATUS_FIELD_UNAVAILABLE'
    ));
    assert(unavailableAnalysis.tasks[0].reasonCodes.includes(
      'PROJECT_TASK_CONTEXT_FIELD_UNAVAILABLE'
    ));
    assert.equal(
      projectPageReviewAttention(unavailableAnalysis.project.reasonCodes),
      'no-one'
    );
    assert.equal(
      projectPageReviewAttention(unavailableAnalysis.tasks[0].reasonCodes),
      'no-one'
    );
    const relationUnavailableTask = structuredClone(unavailableTask);
    delete relationUnavailableTask.fields.projectUris;
    const relationUnavailable = analyzeProjectPageReview({
      project: unavailableProject,
      tasks: [relationUnavailableTask],
      document: unavailableDocument,
      templateDocument: {
        ...template,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(template.body)
      },
      settings: configuration.settings['automation.project-page-review'],
      policies: analysisPolicies(temporaryRoot)
    });
    assert(relationUnavailable.tasks[0].reasonCodes.includes(
      'PROJECT_TASK_RELATION_VERIFICATION_UNAVAILABLE'
    ));
    assert.equal(relationUnavailable.state, 'attention-required');
    assert.equal(
      projectPageReviewAttention(relationUnavailable.tasks[0].reasonCodes),
      'operator'
    );
    const unavailableTaskUris = structuredClone(unavailableProject);
    delete unavailableTaskUris.fields.taskUris;
    assert.throws(() => analyzeProjectPageReview({
      project: unavailableTaskUris,
      tasks: [],
      document: {
        ...unavailableDocument,
        uri: unavailableTaskUris.id,
        title: unavailableTaskUris.fields.name
      },
      templateDocument: {
        ...template,
        format: 'markdown',
        bodyFingerprint: fingerprintJson(template.body)
      },
      settings: configuration.settings['automation.project-page-review'],
      policies: analysisPolicies(temporaryRoot)
    }), /explicitly available Project taskUris array/);

    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: configurationPath
    });
    const fixtureDirectory = path.join(
      temporaryRoot,
      'soter',
      'fixtures',
      'project-page-review'
    );
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const lockPath = 'soter/fixtures/project-page-review/project-page-review.lock.json';
    writeJson(path.join(temporaryRoot, lockPath), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const scenario = await runContainedProjectPageReviewScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/project-page-review/preparation.scenario.json',
      workId: 'work.project-page-review.preparation-fixture',
      scenarioEvidenceId: 'evidence.project-page-review.preparation.fixture',
      createdAt: AT
    });
    assert.equal(scenario.assessment.result, 'passed');
    assert.equal(scenario.scenarioEvidence.result, 'passed');

    const focus = 'PRIVATE_PROJECT_REVIEW_FOCUS_SENTINEL';
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-page-review',
      configurationName: 'project-page-review',
      configurationBasis: 'tracked-contained',
      input: {
        project: project.id,
        focus
      },
      createdAt: '2026-07-29T10:01:00.000Z'
    });
    assert.equal(work.state, 'ready-for-review');
    assert.equal(work.preview.kind, 'project-page-review-preview');
    assert.equal(work.preview.proposedChanges.length, 0);
    assert.equal(work.approval.state, 'not-requested');
    assert.equal(work.continuationRequest, null);
    assert(work.preview.collections.every((collection) => {
      return collection.rows.every((row) => row.actions.length === 0);
    }));
    const inputReview = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.equal(inputReview.fields.find((item) => item.id === 'focus').reviewValue, focus);
    const derived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.equal(derived.kind, 'project-page-review-derived-review');
    assert.equal(field(derived, 'project-page-detail', 'name'), 'Acme launch');
    assert.equal(field(derived, 'project-task-detail', 'title'), 'Send launch deck');
    assert.deepEqual(
      field(derived, 'project-page-detail', 'templateStructuralCounts'),
      ['callout=1', 'columns=1', 'database=6']
    );
    assert.deepEqual(
      field(derived, 'project-page-detail', 'pageStructuralCounts'),
      ['callout=1', 'columns=0', 'database=1']
    );

    const inspection = inspectWorkspace({ root: temporaryRoot });
    const sanitized = JSON.stringify({ work, inspection });
    for (const sentinel of [
      project.id,
      task.id,
      'Acme launch',
      'Send launch deck',
      'Launch the customer program with an attributable delivery plan.',
      focus
    ]) {
      assert.equal(sanitized.includes(sentinel), false, 'sanitized projection leaked ' + sentinel);
    }
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write(
    'Project-page review contained policy, template, structure, privacy, and no-authority selftest passed.\n'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestProjectPageReview().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
