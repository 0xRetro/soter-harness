import fs from 'node:fs';
import path from 'node:path';

import { invokeCapability } from '../../core/capabilities.mjs';
import { exactRequestedContextRecord } from '../../core/context-records.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import {
  derivedReviewContentFingerprint,
  derivedReviewItemFingerprint
} from '../../core/review-projections.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';
import {
  assertProjectCapturePolicySelection,
  loadProjectCapturePolicyDefinition,
  projectCapturePolicyFields
} from '../../contexts/projects/project-capture-policy.mjs';
import {
  assertProjectWorkPolicySelection,
  loadProjectWorkPolicyDefinition,
  projectWorkPolicyFields
} from '../../contexts/projects/project-work-policy.mjs';
import {
  assertTaskWorkPolicySelection,
  loadTaskWorkPolicyDefinition,
  taskWorkPolicyFields
} from '../../contexts/tasks/task-work-policy.mjs';
import {
  analyzeProjectPageReview,
  projectPageReviewAttention
} from './analysis.mjs';

const AUTOMATION_ID = 'automation.project-page-review';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareCodepoint);
}

function preparationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactAuthority(lock, role, subject) {
  const matches = lock.authorities.filter((authority) => {
    return authority.role === role && authority.subject === subject;
  });
  if (matches.length !== 1) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project-page review requires one exact ' + role + ' authority for ' + subject + '.'
    );
  }
  return matches[0].id;
}

function exactSettings(lock) {
  const settings = lock.settings?.[AUTOMATION_ID];
  if (!settings
    || Object.keys(settings).length !== 3
    || !Number.isInteger(settings.maximumOutlineEntries)
    || settings.maximumOutlineEntries < 2
    || settings.maximumOutlineEntries > 200
    || settings.semanticLabelMatcher !== 'headings-and-standalone-bold/v1'
    || settings.structuralBlockMatcher !== 'normalized-structural-block-tags/v1') {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project-page review matcher settings are unavailable or invalid.'
    );
  }
  return structuredClone(settings);
}

function exactSource(lock, purpose, capability, authority, expectedInput) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === purpose;
  }));
  if (matches.length !== 1) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project-page review requires one exact configured source for ' + purpose + '.'
    );
  }
  const source = matches[0];
  if (source.capability !== capability
    || source.authority !== authority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || (expectedInput && !sameJson(source.input, expectedInput))) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project-page review source drifted for ' + purpose + '.'
    );
  }
  return source;
}

function exactDerivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'project-page-review',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'project-page-review-derived-review') {
    throw preparationError(
      'PREPARATION_ADAPTER_INVALID',
      'Project-page review derived-review declaration drifted.'
    );
  }
  return definition;
}

function freshnessState(root, capability, observedAt, at) {
  const contract = readJson(path.join(root, 'soter', 'capabilities', capability + '.json'));
  const maxAge = contract.freshness.maxAgeSeconds;
  if (maxAge === null) return 'unknown';
  const age = (Date.parse(at) - Date.parse(observedAt)) / 1000;
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  return age <= maxAge ? 'passed' : 'stale';
}

async function readFixture({ root, lock, capability, authority, input, effectId, at }) {
  const result = await invokeCapability({
    root,
    lock,
    capability,
    authority,
    containment: 'fixture',
    input,
    effectId,
    at
  });
  if (result.invocation.state !== 'passed') {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project-page review contained read failed for ' + capability + '.'
    );
  }
  return result;
}

function snapshotEntry({ root, id, subject, authority, role, result, at }) {
  return {
    id,
    subject,
    authority,
    role,
    capability: result.invocation.capability,
    providerPack: result.invocation.providerPack,
    providerImplementation: result.invocation.providerImplementation,
    providerVersion: result.invocation.providerVersion,
    observedAt: result.output.observedAt,
    freshness: freshnessState(root, result.invocation.capability, result.output.observedAt, at),
    provenance: result.output.provenance,
    valueFingerprint: fingerprintJson(result.output),
    value: result.output
  };
}

function exactTaskUris(project) {
  const fields = project?.fields;
  if (!fields
    || !Object.hasOwn(fields, 'taskUris')
    || !Array.isArray(fields.taskUris)) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project-page review requires an explicitly available Project taskUris array.'
    );
  }
  const values = fields.taskUris;
  if (values.length > 100
    || values.some((value) => typeof value !== 'string' || !value)
    || new Set(values).size !== values.length) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project-page review requires at most 100 unique related Task identities.'
    );
  }
  return [...values].sort(compareCodepoint);
}

function privateField(id, label, type, reviewValue) {
  return { id, label, type, fingerprint: fingerprintJson(reviewValue), reviewValue };
}

function privateItem(id, kind, source, fields) {
  const value = {
    id,
    kind,
    sources: [source],
    fields,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  value.fingerprint = derivedReviewItemFingerprint(value);
  return value;
}

function rowFingerprint(row) {
  const unsigned = structuredClone(row);
  delete unsigned.fingerprint;
  delete unsigned.privateDetailFingerprint;
  return fingerprintJson(unsigned);
}

function collectionFingerprint(collection) {
  const unsigned = structuredClone(collection);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function reviewRow({
  id,
  sequence,
  subjectKind,
  subjectFingerprint,
  group,
  reasonCode,
  flags
}) {
  const value = {
    id,
    sequence,
    representedCount: 1,
    subject: { kind: subjectKind, fingerprint: subjectFingerprint },
    group,
    attention: projectPageReviewAttention(flags),
    disposition: 'itemized',
    reasonCode,
    flags: uniqueSorted(flags),
    actions: [],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  value.fingerprint = rowFingerprint(value);
  return value;
}

function reviewCollection(id, kind, labelKey, rows) {
  const value = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id,
    kind,
    labelKey,
    coverage: {
      complete: true,
      observedCount: rows.length,
      includedCount: rows.length,
      excludedCount: 0,
      exclusions: []
    },
    rows,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  value.fingerprint = collectionFingerprint(value);
  return value;
}

function outlineStrings(entries) {
  return entries.map((entry) => {
    return entry.kind + ':' + String(entry.level) + ':' + entry.label;
  });
}

function identityFingerprints(values) {
  return (Array.isArray(values) ? values : []).map((value) => fingerprintJson(value));
}

function structuralStrings(value) {
  return Object.keys(value).sort(compareCodepoint).map((key) => key + '=' + String(value[key]));
}

function buildReview(analysis, definition) {
  const projectFlags = analysis.project.reasonCodes;
  const projectRow = reviewRow({
    id: 'row.project-page-review.page',
    sequence: 1,
    subjectKind: 'project-page',
    subjectFingerprint: analysis.document.bodyFingerprint,
    group: 'project-page',
    reasonCode: analysis.state === 'attention-required'
      ? 'PROJECT_PAGE_REVIEW_ATTENTION_REQUIRED'
      : 'PROJECT_PAGE_REVIEW_CURRENT',
    flags: projectFlags
  });
  const pageCollectionId = 'collection.project-page-review.page';
  const pageSource = {
    collectionId: pageCollectionId,
    rowId: projectRow.id,
    rowFingerprint: projectRow.fingerprint
  };
  const projectFields = analysis.project.record.fields || {};
  const pageItem = privateItem(
    'review-item.project-page-review.page',
    'project-page-detail',
    pageSource,
    [
      privateField(
        'projectIdentityFingerprint',
        'Project identity fingerprint',
        'text',
        fingerprintJson(analysis.project.record.id)
      ),
      privateField('name', 'Project name', 'text', projectFields.name),
      privateField('projectType', 'Project type', 'string-list', projectFields.projectType ? [projectFields.projectType] : []),
      privateField('status', 'Project status', 'string-list', projectFields.status ? [projectFields.status] : []),
      privateField(
        'organizationIdentityFingerprints',
        'Organization relationship fingerprints',
        'string-list',
        identityFingerprints(projectFields.organizationUris)
      ),
      privateField('bodyFingerprint', 'Current page-body fingerprint', 'text', analysis.document.bodyFingerprint),
      privateField('templateFingerprint', 'Exact template fingerprint', 'text', analysis.templateDocument.bodyFingerprint),
      privateField('templateOutline', 'Template semantic outline', 'string-list', outlineStrings(analysis.outline.template)),
      privateField('pageOutline', 'Page semantic outline', 'string-list', outlineStrings(analysis.outline.page)),
      privateField('missingOutlineEntries', 'Missing semantic outline entries', 'string-list', outlineStrings(analysis.outline.missing)),
      privateField('extraOutlineEntries', 'Additional semantic outline entries', 'string-list', outlineStrings(analysis.outline.extra)),
      privateField('templateStructuralCounts', 'Template structural block counts', 'string-list', structuralStrings(analysis.structure.template.counts)),
      privateField('pageStructuralCounts', 'Page structural block counts', 'string-list', structuralStrings(analysis.structure.page.counts)),
      privateField('reasonCodes', 'Review reason codes', 'string-list', projectFlags)
    ]
  );
  projectRow.privateDetailFingerprint = pageItem.fingerprint;

  const taskRows = [];
  const taskItems = [];
  for (const [index, review] of analysis.tasks.entries()) {
    const row = reviewRow({
      id: 'row.project-page-review.task-' + String(index + 1).padStart(3, '0'),
      sequence: index + 1,
      subjectKind: 'project-task',
      subjectFingerprint: review.fingerprint,
      group: 'project-task',
      reasonCode: review.reasonCodes[0] || 'PROJECT_TASK_REVIEW_CURRENT',
      flags: review.reasonCodes
    });
    const source = {
      collectionId: 'collection.project-page-review.tasks',
      rowId: row.id,
      rowFingerprint: row.fingerprint
    };
    const fields = review.task.fields || {};
    const item = privateItem(
      'review-item.project-page-review.task-' + String(index + 1).padStart(3, '0'),
      'project-task-detail',
      source,
      [
        privateField('taskIdentityFingerprint', 'Task identity fingerprint', 'text', fingerprintJson(review.task.id)),
        privateField('title', 'Task title', 'text', fields.title),
        privateField('status', 'Task status', 'string-list', fields.status ? [fields.status] : []),
        privateField('context', 'Task context', 'string-list', fields.context ? [fields.context] : []),
        privateField('nextActionOn', 'Next action date', 'string-list', fields.nextActionOn ? [fields.nextActionOn] : []),
        privateField('assigneeIdentityFingerprints', 'Assignee identity fingerprints', 'string-list', identityFingerprints(fields.assigneeIds)),
        privateField('projectIdentityFingerprints', 'Project relationship fingerprints', 'string-list', identityFingerprints(fields.projectUris)),
        privateField('reasonCodes', 'Review reason codes', 'string-list', review.reasonCodes)
      ]
    );
    row.privateDetailFingerprint = item.fingerprint;
    taskRows.push(row);
    taskItems.push(item);
  }

  const collections = [
    reviewCollection(pageCollectionId, 'project-page-standard', 'project-page-standard', [projectRow]),
    reviewCollection(
      'collection.project-page-review.tasks',
      'project-related-tasks',
      'project-related-tasks',
      taskRows
    )
  ];
  const derivedReview = { kind: definition.kind, items: [pageItem, ...taskItems] };
  const basisIds = [
    'context.project-page-review.project-capture-policy',
    'context.project-page-review.project-work-policy',
    'context.project-page-review.task-work-policy',
    'context.project-page-review.template',
    'context.project-page-review.project',
    'context.project-page-review.tasks',
    'context.project-page-review.document'
  ];
  const facts = [
    { id: 'evaluated-policy-semantics-fingerprint', label: 'Evaluated portable policy semantics fingerprint', value: analysis.policy.fingerprint, state: 'supported', basisIds },
    { id: 'template-outline-entry-count', label: 'Configured template outline entries', value: analysis.outline.template.length, state: 'supported', basisIds },
    { id: 'page-outline-entry-count', label: 'Observed page outline entries', value: analysis.outline.page.length, state: 'supported', basisIds },
    { id: 'missing-template-entry-count', label: 'Missing configured template entries', value: analysis.counts.missingTemplateEntries, state: analysis.counts.missingTemplateEntries ? 'contradicted' : 'supported', basisIds },
    { id: 'extra-page-entry-count', label: 'Additional observed page entries', value: analysis.counts.extraTemplateEntries, state: 'supported', basisIds },
    { id: 'template-database-count', label: 'Configured template database blocks', value: analysis.counts.templateDatabases, state: 'supported', basisIds },
    { id: 'page-database-count', label: 'Observed page database blocks', value: analysis.counts.pageDatabases, state: analysis.counts.pageDatabases === analysis.counts.templateDatabases ? 'supported' : 'contradicted', basisIds },
    { id: 'template-callout-count', label: 'Configured template callout blocks', value: analysis.counts.templateCallouts, state: 'supported', basisIds },
    { id: 'page-callout-count', label: 'Observed page callout blocks', value: analysis.counts.pageCallouts, state: analysis.counts.pageCallouts === analysis.counts.templateCallouts ? 'supported' : 'contradicted', basisIds },
    { id: 'template-columns-count', label: 'Configured template column groups', value: analysis.counts.templateColumns, state: 'supported', basisIds },
    { id: 'page-columns-count', label: 'Observed page column groups', value: analysis.counts.pageColumns, state: analysis.counts.pageColumns === analysis.counts.templateColumns ? 'supported' : 'contradicted', basisIds },
    { id: 'related-task-coverage-state', label: 'Related Task coverage state', value: analysis.taskCoverage.state, state: analysis.taskCoverage.state === 'complete' ? 'supported' : 'contradicted', basisIds },
    { id: 'related-task-expected-count', label: 'Exact related Tasks expected', value: analysis.taskCoverage.expectedCount, state: 'supported', basisIds },
    { id: 'related-task-observed-count', label: 'Related Tasks observed and reviewed', value: analysis.taskCoverage.observedCount, state: 'supported', basisIds },
    { id: 'related-task-unavailable-count', label: 'Related Tasks unavailable to this exact read', value: analysis.taskCoverage.unavailableCount, state: analysis.taskCoverage.unavailableCount ? 'contradicted' : 'supported', basisIds },
    { id: 'task-context-not-set-count', label: 'Related Tasks without portable context', value: analysis.counts.taskContextNotSet, state: 'supported', basisIds },
    { id: 'task-next-action-not-set-count', label: 'Related Tasks without next-action date', value: analysis.counts.taskNextActionNotSet, state: 'supported', basisIds },
    { id: 'task-unassigned-count', label: 'Related Tasks unassigned under allowed policy', value: analysis.counts.taskAssigneeUnassigned, state: 'supported', basisIds },
    { id: 'project-manager-identity-wiring', label: 'Portable Project manager identity wiring', value: 'unavailable', state: 'unavailable', basisIds },
    { id: 'provider-live-view-wiring', label: 'Provider-native live view identity wiring', value: 'unavailable', state: 'unavailable', basisIds },
    { id: 'proposed-change-count', label: 'Proposed changes', value: 0, state: 'supported', basisIds }
  ];
  const contradictions = [];
  if (analysis.counts.missingTemplateEntries) {
    contradictions.push({
      id: 'configured-template-entries-missing',
      claim: 'The selected Project page is missing one or more semantic entries declared by the exact configured template.',
      state: 'observed',
      basisIds
    });
  }
  if (analysis.outline.orderDrift) {
    contradictions.push({
      id: 'configured-template-order-drift',
      claim: 'Shared semantic entries appear in a different order from the exact configured template.',
      state: 'observed',
      basisIds
    });
  }
  if (analysis.structure.drift) {
    contradictions.push({
      id: 'configured-template-structure-drift',
      claim: 'Normalized database, callout, or column-group counts differ from the exact configured template.',
      state: 'observed',
      basisIds
    });
  }
  if (analysis.tasks.some((review) => {
    return review.reasonCodes.includes('PROJECT_TASK_RELATION_INCONSISTENT');
  })) {
    contradictions.push({
      id: 'project-task-relation-inconsistent',
      claim: 'At least one exact related Task does not reciprocally reference the selected Project.',
      state: 'observed',
      basisIds
    });
  }
  if (analysis.taskCoverage.state === 'incomplete') {
    contradictions.push({
      id: 'related-task-coverage-incomplete',
      claim: 'The exact bounded related-Task read returned only a strict subset of the Project relation identities; the review is incomplete and cannot be treated as current.',
      state: 'observed',
      basisIds
    });
  }
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: definition.$contract,
    contractFingerprint: fingerprintJson(definition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'project-page-review-preview',
    fingerprint: null,
    facts,
    contradictions,
    collections,
    privateReview,
    proposedChanges: []
  };
  preview.fingerprint = fingerprintJson({
    kind: preview.kind,
    facts,
    contradictions,
    collections,
    privateReview,
    proposedChanges: []
  });
  return { preview, derivedReview };
}

function contextStep(entry, invocation, sequence) {
  const labels = {
    'context.project-page-review.project-capture-policy': 'Load exact portable Project capture policy',
    'context.project-page-review.project-work-policy': 'Load exact portable Project work policy',
    'context.project-page-review.task-work-policy': 'Load exact portable Task work policy',
    'context.project-page-review.template': 'Load exact configured Project template',
    'context.project-page-review.project': 'Load exact selected Project',
    'context.project-page-review.tasks': 'Load every exact related Task',
    'context.project-page-review.document': 'Load exact current Project page'
  };
  return {
    id: 'preparation.context.' + String(sequence),
    sequence,
    label: labels[entry.id],
    capability: entry.capability,
    authority: entry.authority,
    containment: 'fixture',
    state: 'completed',
    inputFingerprint: invocation.inputFingerprint,
    outputFingerprint: entry.valueFingerprint,
    limitation: 'This typed fixture read does not establish connected provider readiness, live-view identity, authentication, verification, or health.'
  };
}

export async function prepareProjectPageReviewRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  if (!input
    || typeof input.project !== 'string'
    || input.project.length < 3
    || input.project.length > 500
    || (input.focus !== undefined
      && (typeof input.focus !== 'string' || input.focus.length > 500))) {
    throw preparationError(
      'PREPARATION_INPUT_INVALID',
      'Project-page review requires one exact Project reference and at most one bounded private focus note.'
    );
  }
  const resolvedRoot = path.resolve(root);
  const settings = exactSettings(lock);
  const definition = exactDerivedReviewDefinition(resolvedRoot);
  const projectDefinitionAuthority = exactAuthority(lock, 'definition', 'projects.records');
  const projectInstanceAuthority = exactAuthority(lock, 'instance', 'projects.records');
  const taskDefinitionAuthority = exactAuthority(lock, 'definition', 'tasks.records');
  const taskInstanceAuthority = exactAuthority(lock, 'instance', 'tasks.records');
  const captureSource = exactSource(
    lock,
    'project-capture-policy',
    'projects.records.read',
    projectDefinitionAuthority,
    { recordTypes: ['project-capture-policy'], ids: ['policy.project-capture'], limit: 2 }
  );
  const workSource = exactSource(
    lock,
    'project-work-policy',
    'projects.records.read',
    projectDefinitionAuthority,
    { recordTypes: ['project-work-policy'], ids: ['policy.projects'], limit: 2 }
  );
  const taskSource = exactSource(
    lock,
    'task-work-policy',
    'tasks.records.read',
    taskDefinitionAuthority,
    { recordTypes: ['task-work-policy'], ids: ['policy.tasks'], limit: 2 }
  );
  const templateSource = exactSource(
    lock,
    'project-page-template',
    'documents.content.read',
    projectDefinitionAuthority
  );
  const runId = 'run.' + workId.slice('work.'.length);
  const snapshotId = 'context.' + workId.slice('work.'.length);
  const envelope = prepareRunEnvelope({
    root: resolvedRoot,
    lock,
    lockPath,
    scenarioPath,
    automationId: AUTOMATION_ID,
    runId,
    createdAt,
    requestedOutcome: 'Review one exact Project page and every explicitly related Task against portable Context policy plus one exact configured template, then stop without any proposal or write authority.',
    evidenceIds: []
  });
  const requests = [
    {
      id: 'context.project-page-review.project-capture-policy',
      subject: 'projects.records',
      role: 'definition',
      capability: captureSource.capability,
      authority: projectDefinitionAuthority,
      input: captureSource.input,
      effectId: 'effect.project-page-review.project-capture-policy.fixture'
    },
    {
      id: 'context.project-page-review.project-work-policy',
      subject: 'projects.records',
      role: 'definition',
      capability: workSource.capability,
      authority: projectDefinitionAuthority,
      input: workSource.input,
      effectId: 'effect.project-page-review.project-work-policy.fixture'
    },
    {
      id: 'context.project-page-review.task-work-policy',
      subject: 'tasks.records',
      role: 'definition',
      capability: taskSource.capability,
      authority: taskDefinitionAuthority,
      input: taskSource.input,
      effectId: 'effect.project-page-review.task-work-policy.fixture'
    },
    {
      id: 'context.project-page-review.template',
      subject: 'projects.records',
      role: 'definition',
      capability: templateSource.capability,
      authority: projectDefinitionAuthority,
      input: templateSource.input,
      effectId: 'effect.project-page-review.template.fixture'
    },
    {
      id: 'context.project-page-review.project',
      subject: 'projects.records',
      role: 'instance',
      capability: 'projects.records.read',
      authority: projectInstanceAuthority,
      input: { recordTypes: ['project'], ids: [input.project], limit: 2 },
      effectId: 'effect.project-page-review.project.fixture'
    }
  ];
  const acquired = [];
  for (const request of requests) {
    const result = await readFixture({
      root: resolvedRoot,
      lock,
      capability: request.capability,
      authority: request.authority,
      input: request.input,
      effectId: request.effectId,
      at: createdAt
    });
    acquired.push({
      ...request,
      result,
      entry: snapshotEntry({
        root: resolvedRoot,
        id: request.id,
        subject: request.subject,
        authority: request.authority,
        role: request.role,
        result,
        at: createdAt
      })
    });
  }
  const capture = acquired[0].result.output;
  const work = acquired[1].result.output;
  const taskPolicy = acquired[2].result.output;
  const template = acquired[3].result.output.document;
  const projectOutput = acquired[4].result.output;
  const captureDefinition = loadProjectCapturePolicyDefinition(resolvedRoot);
  const projectWorkDefinition = loadProjectWorkPolicyDefinition(resolvedRoot);
  const taskWorkDefinition = loadTaskWorkPolicyDefinition(resolvedRoot);
  assertProjectCapturePolicySelection(
    capture,
    captureDefinition
  );
  assertProjectWorkPolicySelection(
    work,
    projectWorkDefinition,
    { requireProjectedRules: true }
  );
  assertTaskWorkPolicySelection(
    taskPolicy,
    taskWorkDefinition,
    { requireProjectedRules: true }
  );
  if (template.uri !== templateSource.input.uri
    || template.title !== templateSource.input.expectedTitle
    || template.bodyFingerprint !== fingerprintJson(template.body)) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project-page review template did not resolve exactly.'
    );
  }
  const project = exactRequestedContextRecord(projectOutput, {
    recordType: 'project',
    requestedId: input.project
  });
  const taskUris = exactTaskUris(project);
  const taskResult = await readFixture({
    root: resolvedRoot,
    lock,
    capability: 'tasks.records.read',
    authority: taskInstanceAuthority,
    input: taskUris.length
      ? { recordTypes: ['task'], ids: taskUris, limit: 100 }
      : { recordTypes: ['task'], filters: { projectId: project.id }, limit: 1 },
    effectId: 'effect.project-page-review.tasks.fixture',
    at: createdAt
  });
  const taskIds = taskResult.output.records.map((record) => record.id).sort(compareCodepoint);
  if (taskResult.output.records.some((record) => record.type !== 'task')
    || !sameJson(taskIds, taskUris)) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project-page review Task output does not match every exact Project relation.'
    );
  }
  const documentResult = await readFixture({
    root: resolvedRoot,
    lock,
    capability: 'documents.content.read',
    authority: projectInstanceAuthority,
    input: { uri: project.id, expectedTitle: project.fields.name },
    effectId: 'effect.project-page-review.document.fixture',
    at: createdAt
  });
  const document = documentResult.output.document;
  if (document.uri !== project.id
    || document.title !== project.fields.name
    || document.bodyFingerprint !== fingerprintJson(document.body)) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project-page review current page did not resolve exactly.'
    );
  }
  const trailing = [
    {
      id: 'context.project-page-review.tasks',
      subject: 'tasks.records',
      role: 'instance',
      authority: taskInstanceAuthority,
      result: taskResult
    },
    {
      id: 'context.project-page-review.document',
      subject: 'projects.records',
      role: 'instance',
      authority: projectInstanceAuthority,
      result: documentResult
    }
  ].map((item) => ({
    ...item,
    entry: snapshotEntry({
      root: resolvedRoot,
      id: item.id,
      subject: item.subject,
      authority: item.authority,
      role: item.role,
      result: item.result,
      at: createdAt
    })
  }));
  const all = [...acquired, ...trailing];
  const analysis = analyzeProjectPageReview({
    project,
    tasks: taskResult.output.records,
    document,
    templateDocument: template,
    settings,
    policies: {
      projectCapture: projectCapturePolicyFields(captureDefinition),
      projectWork: projectWorkPolicyFields(projectWorkDefinition),
      taskWork: taskWorkPolicyFields(taskWorkDefinition)
    }
  });
  const review = buildReview(analysis, definition);
  const entries = all.map((item) => item.entry);
  const effects = all.map((item) => item.result.invocation);
  const snapshot = {
    $contract: 'soter://contracts/context-snapshot/v1',
    contractVersion: '1.0.0',
    id: snapshotId,
    runId,
    createdAt,
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    containment: 'fixture',
    entries,
    effectIds: effects.map((effect) => effect.id),
    privacy: {
      scope: 'private',
      redactions: [
        'Project page bodies, Project names, Task titles, resource identifiers, provider responses, configuration targets, focus text, and credential values are excluded from general inspection and evidence.',
        'Only selected-work private review may expose normalized names, titles, semantic labels, and attention facts; raw page bodies and URLs are not projected.'
      ]
    }
  };
  const byAuthority = new Map();
  for (const entry of entries) {
    const values = byAuthority.get(entry.authority) || [];
    values.push(entry.valueFingerprint);
    byAuthority.set(entry.authority, values);
  }
  envelope.context = envelope.context.map((item) => {
    const values = byAuthority.get(item.authority);
    return values ? {
      ...item,
      status: 'loaded',
      provenance: 'fixture:' + fingerprintJson(values),
      freshness: entries.some((entry) => {
        return entry.authority === item.authority && entry.freshness === 'stale';
      }) ? 'stale' : 'passed'
    } : item;
  });
  envelope.lifecycleState = 'paused';
  envelope.checkpoints = [
    {
      id: 'effects-established',
      state: 'passed',
      details: 'Read and disclosure policy was evaluated before every exact contained source.'
    },
    {
      id: 'project-page-review-grounded',
      state: 'passed',
      details: 'Portable policies, exact template, selected Project, every related Task, and current page were read with complete exact coverage.'
    },
    {
      id: 'private-review-boundary-held',
      state: 'passed',
      details: 'Page bodies, URLs, names, titles, provider responses, and focus text did not enter sanitized inspection or evidence.'
    },
    {
      id: 'write-boundary-held',
      state: 'passed',
      details: 'No proposed change, approval, continuation request, provider mutation, retry authority, or canonical write was created.'
    }
  ];
  envelope.outputs = [{
    id: snapshot.id,
    type: 'context-snapshot',
    fingerprint: fingerprintJson(snapshot)
  }];
  envelope.effects = effects;
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      {
        id: 'portable-context-rules-grounded',
        label: 'Evaluated Project type, Project/Task distinction, and Task relation policy grounded',
        state: 'supported',
        basis: [
          'context.project-page-review.project-capture-policy',
          'context.project-page-review.project-work-policy',
          'context.project-page-review.task-work-policy'
        ],
        limitation: 'Only allowed/default Project status, allowed Project types, the explicit promoted-Task relation boundary, required reciprocal Task links, allowed Task contexts, and unassigned-Task semantics are evaluated. Task status is observed privately but not judged because Task policy has no exhaustive status vocabulary. Page-embedded work items, progress, health, and other policy fields are not evaluated.'
      },
      {
        id: 'configured-template-compared',
        label: 'Exact configured template outline and normalized structure compared',
        state: 'supported',
        basis: [
          'context.project-page-review.template',
          'context.project-page-review.document'
        ],
        limitation: 'Provider-native live view identities are unavailable; only normalized structural block tags are compared.'
      },
      {
        id: 'related-task-coverage-complete',
        label: 'Every and only the exact related Tasks reviewed',
        state: 'supported',
        basis: [
          'context.project-page-review.project',
          'context.project-page-review.tasks'
        ],
        limitation: 'No Task is created, assigned, dated, or updated.'
      },
      {
        id: 'external-effect-boundary',
        label: 'No proposal, approval, continuation, or write authority exists',
        state: 'supported',
        basis: [
          'context.project-page-review.project',
          'context.project-page-review.document'
        ],
        limitation: 'A later standardization workflow would require a separate exact write contract and authority path.'
      }
    ],
    preview: review.preview,
    derivedReview: review.derivedReview
  };
}
