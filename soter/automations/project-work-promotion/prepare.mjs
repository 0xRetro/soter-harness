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
  assertProjectWorkPolicySelection,
  loadProjectWorkPolicyDefinition
} from '../../contexts/projects/project-work-policy.mjs';
import {
  parseProjectWorkDocument,
  renderCompletedProjectWorkItemLine
} from '../../contexts/projects/project-work.mjs';
import {
  assertTaskWorkPolicySelection,
  loadTaskWorkPolicyDefinition
} from '../../contexts/tasks/task-work-policy.mjs';

const AUTOMATION_ID = 'automation.project-work-promotion';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';
const TASK_ACTION = 'action.project-work-promotion.task-create';
const COMPLETE_ACTION = 'action.project-work-promotion.complete-in-place';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lower(value) {
  return String(value).trim().toLocaleLowerCase('en');
}

function derivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'project-work-promotion',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'project-work-promotion-derived-review') {
    throw new Error('Project Work Promotion derived-review definition drifted.');
  }
  return definition;
}

function authority(lock, role, subject = 'projects.records') {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error(
      'Project Work Promotion requires one exact ' + role + ' authority for ' + subject + '.'
    );
  }
  return matches[0].id;
}

function sourceFor(lock, definitionAuthority, purpose, recordType, capability) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === purpose;
  }));
  if (matches.length !== 1) {
    throw new Error('Project Work Promotion requires one configured ' + purpose + ' source.');
  }
  const source = matches[0];
  if (source.capability !== capability
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || fingerprintJson(source.input.recordTypes) !== fingerprintJson([recordType])
    || source.input.ids?.length !== 1) {
    throw new Error('Project Work Promotion ' + purpose + ' source is not one exact governed read.');
  }
  return source;
}

async function readFixture({
  root,
  lock,
  capability = 'projects.records.read',
  authorityId,
  input,
  effectId,
  at
}) {
  const result = await invokeCapability({
    root,
    lock,
    capability,
    authority: authorityId,
    containment: 'fixture',
    input,
    effectId,
    at
  });
  if (result.invocation.state !== 'passed') {
    throw new Error('Project Work Promotion contained read did not pass: ' + effectId + '.');
  }
  return result;
}

function snapshotEntry({ id, subject, authorityId, role, result, value = result.output }) {
  return {
    id,
    subject,
    authority: authorityId,
    role,
    capability: result.invocation.capability,
    providerPack: result.invocation.providerPack,
    providerImplementation: result.invocation.providerImplementation,
    providerVersion: result.invocation.providerVersion,
    observedAt: result.output.observedAt,
    freshness: 'passed',
    provenance: result.output.provenance,
    valueFingerprint: fingerprintJson(value),
    value
  };
}

function contextStep(entry, invocation, sequence) {
  const labels = {
    'context.project-work-promotion.project-policy': 'Load exact shared Projects policy',
    'context.project-work-promotion.task-policy': 'Load exact shared Tasks policy',
    'context.project-work-promotion.project': 'Load exact project record',
    'context.project-work-promotion.document': 'Load exact project work document',
    'context.project-work-promotion.identity': 'Resolve authenticated current-user identity',
    'context.project-work-promotion.duplicates': 'Inspect bounded exact-title Task candidates'
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
    limitation: 'This fixture read proves contained normalization only; it does not establish connected permission, write behavior, readiness, verification, or health.'
  };
}

function privateField(id, label, type, reviewValue) {
  return { id, label, type, fingerprint: fingerprintJson(reviewValue), reviewValue };
}

function privateItem(id, kind, sources, fields) {
  const item = {
    id,
    kind,
    sources,
    fields,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  item.fingerprint = derivedReviewItemFingerprint(item);
  return item;
}

function rowFingerprint(row) {
  const unsigned = structuredClone(row);
  delete unsigned.fingerprint;
  delete unsigned.privateDetailFingerprint;
  for (const action of unsigned.actions) delete action.changeFingerprint;
  return fingerprintJson(unsigned);
}

function collectionFingerprint(collection) {
  const unsigned = structuredClone(collection);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function exactReplace(body, oldText, newText) {
  const first = body.indexOf(oldText);
  const second = first < 0 ? -1 : body.indexOf(oldText, first + oldText.length);
  if (first < 0 || second >= 0 || oldText === newText) {
    throw new Error('Project Work Promotion requires one exact changing work-item replacement.');
  }
  return body.slice(0, first) + newText + body.slice(first + oldText.length);
}

function issue(code, claim, basisIds) {
  return { code, claim, basisIds };
}

export function buildProjectWorkPromotionPreview({
  input,
  projectPolicy,
  taskPolicy,
  project,
  document,
  duplicateIds,
  assigneeIds,
  derivedDefinition
}) {
  const parsed = parseProjectWorkDocument(document, projectPolicy);
  const matches = parsed.workItems.filter((item) => lower(item.action) === lower(input.workItemAction));
  const workItem = matches.length === 1 ? matches[0] : null;
  const issues = [];
  if (!workItem) {
    issues.push(issue(
      matches.length > 1
        ? 'PROJECT_WORK_ITEM_ACTION_AMBIGUOUS'
        : 'PROJECT_WORK_ITEM_NOT_FOUND',
      matches.length > 1
        ? 'Several current project work items share the requested action.'
        : 'No current project work item exactly matches the requested action.',
      ['context.project-work-promotion.document']
    ));
  } else if (workItem.checked) {
    issues.push(issue(
      'PROJECT_WORK_ITEM_ALREADY_COMPLETE',
      'The selected project work item is already complete.',
      ['context.project-work-promotion.document']
    ));
  }
  if (input.disposition === 'tracked-execution' && duplicateIds.length) {
    issues.push(issue(
      'PROJECT_WORK_TASK_DUPLICATE_CANDIDATE',
      'An exact-title Task already exists and must be reviewed instead of creating a duplicate.',
      ['context.project-work-promotion.duplicates']
    ));
  }
  if (input.disposition === 'coordination-only' && input.assignee) {
    issues.push(issue(
      'PROJECT_COORDINATION_ASSIGNEE_INVALID',
      'Coordination-only work completes in place and cannot carry a Task assignee.',
      ['context.project-work-promotion.project-policy']
    ));
  }
  if (!taskPolicy.allowedContexts.includes(projectPolicy.promotionTaskContext)
    || taskPolicy.projectRequired !== true
    || taskPolicy.createRequiresConfirmation !== true) {
    issues.push(issue(
      'PROJECT_TASK_POLICY_INCOMPATIBLE',
      'The current Tasks policy does not support confirmation-gated Project work.',
      ['context.project-work-promotion.task-policy', 'context.project-work-promotion.project-policy']
    ));
  }
  const ready = issues.length === 0;
  const tracked = input.disposition === 'tracked-execution';
  const actionId = tracked ? TASK_ACTION : COMPLETE_ACTION;
  const actionKind = tracked ? 'project-work-task-create' : 'project-work-item-complete';
  const capability = tracked ? 'tasks.records.create' : 'documents.content.update';
  const reasonCode = ready
    ? tracked
      ? 'PROJECT_WORK_TASK_CREATE_READY_FOR_REVIEW'
      : 'PROJECT_COORDINATION_COMPLETION_READY_FOR_REVIEW'
    : issues[0].code;
  const action = {
    id: actionId,
    kind: actionKind,
    capability,
    effect: 'write',
    state: ready ? 'proposed' : 'held',
    reasonCode,
    changeFingerprint: null
  };
  const subjectFingerprint = workItem?.fingerprint || fingerprintJson(input.workItemAction);
  const row = {
    id: 'row.project-work-promotion.work-item',
    sequence: 1,
    representedCount: 1,
    subject: { kind: 'project-work-item', fingerprint: subjectFingerprint },
    group: 'project-work-promotion',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode,
    flags: issues.map((item) => item.code).sort(compareCodepoint),
    actions: [action],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  row.fingerprint = rowFingerprint(row);
  const collectionId = 'collection.project-work-promotion.changes';
  const source = [{
    collectionId,
    rowId: row.id,
    rowFingerprint: row.fingerprint
  }];
  let item;
  let afterFingerprint;
  let beforeFingerprint;
  if (tracked) {
    const taskFields = {
      title: workItem?.action || input.workItemAction,
      status: taskPolicy.defaultStatus,
      context: projectPolicy.promotionTaskContext,
      projectUris: [project.id],
      ...(assigneeIds.length ? { assigneeIds } : {}),
      ...(workItem?.date ? { nextActionOn: workItem.date } : {})
    };
    item = privateItem(
      'review-item.project-work-promotion.task',
      'project-work-task-create',
      source,
      [
        privateField('workItemId', 'Source work-item identity', 'text', workItem?.id || 'unavailable'),
        privateField('title', 'Inherited exact Task title', 'text', taskFields.title),
        privateField('status', 'Task status', 'text', taskFields.status),
        privateField('context', 'Task context', 'text', taskFields.context),
        privateField('projectUris', 'Project identities', 'string-list', taskFields.projectUris),
        privateField('assigneeIds', 'Assignee identities', 'string-list', assigneeIds),
        privateField('nextActionOn', 'Inherited next-action date', 'string-list', workItem?.date ? [workItem.date] : []),
        privateField('duplicateCandidateIds', 'Exact duplicate candidates', 'string-list', duplicateIds)
      ]
    );
    beforeFingerprint = null;
    afterFingerprint = item.fingerprint;
  } else {
    const newLine = workItem && !workItem.checked
      ? renderCompletedProjectWorkItemLine(workItem)
      : workItem?.oldLine || 'unavailable';
    const afterBody = workItem && !workItem.checked
      ? exactReplace(document.body, workItem.oldLine, newLine)
      : document.body;
    item = privateItem(
      'review-item.project-work-promotion.completion',
      'project-work-item-complete',
      source,
      [
        privateField('uri', 'Project document identity', 'text', document.uri),
        privateField('expectedTitle', 'Expected project title', 'text', document.title),
        privateField('expectedBodyFingerprint', 'Current document fingerprint', 'text', document.bodyFingerprint),
        privateField('afterBodyFingerprint', 'Expected document fingerprint', 'text', fingerprintJson(afterBody)),
        privateField('workItemId', 'Exact work-item identity', 'text', workItem?.id || 'unavailable'),
        privateField('oldText', 'Current work-item line', 'text', workItem?.oldLine || 'unavailable'),
        privateField('newText', 'Completed work-item line', 'text', newLine)
      ]
    );
    beforeFingerprint = document.bodyFingerprint;
    afterFingerprint = item.fingerprint;
  }
  row.privateDetailFingerprint = item.fingerprint;
  const proposedChanges = [];
  if (ready) {
    const change = {
      id: actionId,
      recordId: tracked
        ? 'new:project-task:' + subjectFingerprint.slice(7, 23)
        : 'document:' + fingerprintJson(document.uri).slice(7, 23),
      effect: capability,
      beforeFingerprint,
      afterFingerprint
    };
    action.changeFingerprint = fingerprintJson(change);
    proposedChanges.push(change);
  }
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'project-work-promotion-changes',
    labelKey: 'project-work-promotion-changes',
    coverage: {
      complete: true,
      observedCount: 1,
      includedCount: 1,
      excludedCount: 0,
      exclusions: []
    },
    rows: [row],
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  collection.fingerprint = collectionFingerprint(collection);
  const derivedReview = { kind: derivedDefinition.kind, items: [item] };
  const facts = [
    { id: 'project-work-item-grounded', label: 'Exact unchecked work item grounded', value: Boolean(workItem && !workItem.checked), state: workItem && !workItem.checked ? 'supported' : 'contradicted', basisIds: ['context.project-work-promotion.document'] },
    { id: 'project-work-disposition', label: 'Operator-selected work disposition', value: input.disposition, state: 'supported', basisIds: ['context.project-work-promotion.project-policy'] },
    ...(tracked ? [{
      id: 'project-work-duplicate-count',
      label: 'Exact-title Task candidates',
      value: duplicateIds.length,
      state: duplicateIds.length ? 'contradicted' : 'supported',
      basisIds: ['context.project-work-promotion.duplicates']
    }] : [{
      id: 'project-work-duplicate-scan-applicability',
      label: 'Task duplicate scan required',
      value: false,
      state: 'supported',
      basisIds: ['context.project-work-promotion.project-policy']
    }]),
    {
      id: 'project-work-completion-boundary',
      label: 'Selected source-work-item disposition',
      value: tracked ? 'source-remains-incomplete' : 'source-completes-in-place',
      state: 'supported',
      basisIds: ['context.project-work-promotion.project-policy']
    }
  ];
  const contradictions = issues.map((entry) => ({
    id: entry.code.toLocaleLowerCase('en').replaceAll('_', '-'),
    claim: entry.claim,
    state: 'observed',
    basisIds: entry.basisIds
  }));
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'project-work-promotion-preview',
    fingerprint: null,
    facts,
    contradictions,
    collections: [collection],
    privateReview,
    proposedChanges
  };
  preview.fingerprint = fingerprintJson({
    kind: preview.kind,
    facts,
    contradictions,
    collections: preview.collections,
    privateReview,
    proposedChanges
  });
  return {
    ready,
    issues: issues.map((entry) => entry.code).sort(compareCodepoint),
    workItem,
    preview,
    derivedReview
  };
}

export async function prepareProjectWorkPromotionRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const projectDefinitionAuthority = authority(lock, 'definition', 'projects.records');
  const taskDefinitionAuthority = authority(lock, 'definition', 'tasks.records');
  const projectAuthority = authority(lock, 'instance', 'projects.records');
  const taskAuthority = authority(lock, 'instance', 'tasks.records');
  const providerAuthority = authority(lock, 'provider', 'notion.workspace');
  const projectPolicyDefinition = loadProjectWorkPolicyDefinition(root);
  const taskPolicyDefinition = loadTaskWorkPolicyDefinition(root);
  const projectSource = sourceFor(
    lock,
    projectDefinitionAuthority,
    'project-work-policy',
    'project-work-policy',
    'projects.records.read'
  );
  const taskSource = sourceFor(
    lock,
    taskDefinitionAuthority,
    'task-work-policy',
    'task-work-policy',
    'tasks.records.read'
  );
  const derivedDefinition = derivedReviewDefinition(root);
  const runId = 'run.' + workId.slice('work.'.length);
  const snapshotId = 'context.' + workId.slice('work.'.length);
  const envelope = prepareRunEnvelope({
    root,
    lock,
    lockPath,
    scenarioPath,
    automationId: AUTOMATION_ID,
    runId,
    createdAt,
    requestedOutcome: 'Prepare one exact operator-classified project work-item disposition without inferring whether coordination requires tracked execution.',
    evidenceIds: []
  });
  const projectPolicyResult = await readFixture({
    root,
    lock,
    authorityId: projectDefinitionAuthority,
    input: projectSource.input,
    effectId: 'effect.project-work-promotion.project-policy.fixture',
    at: createdAt
  });
  const projectPolicy = assertProjectWorkPolicySelection(
    projectPolicyResult.output,
    projectPolicyDefinition,
    { requireProjectedRules: true }
  );
  const taskPolicyResult = await readFixture({
    root,
    lock,
    capability: 'tasks.records.read',
    authorityId: taskDefinitionAuthority,
    input: taskSource.input,
    effectId: 'effect.project-work-promotion.task-policy.fixture',
    at: createdAt
  });
  const taskPolicy = assertTaskWorkPolicySelection(
    taskPolicyResult.output,
    taskPolicyDefinition,
    { requireProjectedRules: true }
  );
  const projectResult = await readFixture({
    root,
    lock,
    authorityId: projectAuthority,
    input: { recordTypes: ['project'], ids: [input.project], limit: 2 },
    effectId: 'effect.project-work-promotion.project.fixture',
    at: createdAt
  });
  const project = exactRequestedContextRecord(projectResult.output, {
    recordType: 'project',
    requestedId: input.project
  });
  const documentResult = await readFixture({
    root,
    lock,
    capability: 'documents.content.read',
    authorityId: projectAuthority,
    input: { uri: project.id, expectedTitle: project.fields.name },
    effectId: 'effect.project-work-promotion.document.fixture',
    at: createdAt
  });
  const document = documentResult.output.document;
  if (document.uri !== project.id || document.title !== project.fields.name) {
    throw new Error('Project Work Promotion document does not match the selected project.');
  }
  const identityResult = input.assignee === 'self'
    ? await readFixture({
      root,
      lock,
      capability: 'workspace.identity.read',
      authorityId: providerAuthority,
      input: { identity: 'current-user' },
      effectId: 'effect.project-work-promotion.identity.fixture',
      at: createdAt
    })
    : null;
  const assigneeIds = identityResult
    ? [identityResult.output.identity.providerPersonId]
    : [];
  const duplicateResult = input.disposition === 'tracked-execution'
    ? await readFixture({
      root,
      lock,
      capability: 'tasks.records.read',
      authorityId: taskAuthority,
      input: {
        recordTypes: ['task'],
        filters: { title: input.workItemAction },
        limit: taskPolicy.fields.duplicateCandidateLimit
      },
      effectId: 'effect.project-work-promotion.duplicates.fixture',
      at: createdAt
    })
    : null;
  const duplicateIds = duplicateResult
    ? duplicateResult.output.records
      .filter((record) => record.type === 'task')
      .map((record) => record.id)
      .sort(compareCodepoint)
    : [];
  const acquired = [
    {
      result: projectPolicyResult,
      entry: snapshotEntry({
        id: 'context.project-work-promotion.project-policy',
        subject: 'projects.records.project-work-policy',
        authorityId: projectDefinitionAuthority,
        role: 'definition',
        result: projectPolicyResult,
        value: {
          record: projectPolicy.record,
          definitionFingerprint: projectPolicy.definitionFingerprint
        }
      })
    },
    {
      result: taskPolicyResult,
      entry: snapshotEntry({
        id: 'context.project-work-promotion.task-policy',
        subject: 'tasks.records.task-work-policy',
        authorityId: taskDefinitionAuthority,
        role: 'definition',
        result: taskPolicyResult,
        value: {
          record: taskPolicy.record,
          definitionFingerprint: taskPolicy.definitionFingerprint
        }
      })
    },
    {
      result: projectResult,
      entry: snapshotEntry({
        id: 'context.project-work-promotion.project',
        subject: 'projects.records.project',
        authorityId: projectAuthority,
        role: 'instance',
        result: projectResult
      })
    },
    {
      result: documentResult,
      entry: snapshotEntry({
        id: 'context.project-work-promotion.document',
        subject: 'documents.project-work',
        authorityId: projectAuthority,
        role: 'instance',
        result: documentResult
      })
    },
    ...(identityResult ? [{
      result: identityResult,
      entry: snapshotEntry({
        id: 'context.project-work-promotion.identity',
        subject: 'notion.workspace.current-user',
        authorityId: providerAuthority,
        role: 'provider',
        result: identityResult,
        value: {
          providerPersonId: identityResult.output.identity.providerPersonId,
          identityFingerprint: fingerprintJson(identityResult.output.identity)
        }
      })
    }] : []),
    ...(duplicateResult ? [{
      result: duplicateResult,
      entry: snapshotEntry({
        id: 'context.project-work-promotion.duplicates',
        subject: 'tasks.records.task-candidates',
        authorityId: taskAuthority,
        role: 'instance',
        result: duplicateResult,
        value: {
          candidateCount: duplicateIds.length,
          candidateIds: duplicateIds,
          providerOutputFingerprint: duplicateResult.invocation.outputFingerprint
        }
      })
    }] : [])
  ];
  const entries = acquired.map((item) => item.entry);
  const effects = acquired.map((item) => item.result.invocation);
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
        'Work-item text, owner names, provider identities, Task candidate values, raw provider responses, and credentials are excluded from general inspection.'
      ]
    }
  };
  const grouped = new Map();
  for (const entry of entries) {
    const values = grouped.get(entry.authority) || [];
    values.push(entry.valueFingerprint);
    grouped.set(entry.authority, values);
  }
  envelope.context = envelope.context.map((item) => {
    const values = grouped.get(item.authority);
    return values ? {
      ...item,
      status: 'loaded',
      provenance: 'fixture:' + fingerprintJson(values),
      freshness: 'passed'
    } : item;
  });
  envelope.lifecycleState = 'paused';
  envelope.checkpoints = [
    { id: 'effects-established', state: 'passed', details: 'Read and disclosure policies were evaluated before contained context acquisition.' },
    { id: 'project-work-promotion-grounded', state: 'passed', details: 'The exact shared policies, project, current work document, optional identity, and bounded Task candidates were loaded.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No approval, continuation, provider write, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;
  const result = buildProjectWorkPromotionPreview({
    input,
    projectPolicy: projectPolicy.fields,
    taskPolicy: taskPolicy.fields,
    project,
    document,
    duplicateIds,
    assigneeIds,
    derivedDefinition
  });
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      { id: 'project-and-task-policies-grounded', label: 'Shared Projects and Tasks policies grounded', state: 'supported', basis: ['context.project-work-promotion.project-policy', 'context.project-work-promotion.task-policy'], limitation: 'Contained policy selection does not establish live provider readiness.' },
      { id: 'work-disposition-review', label: 'Exact operator-classified work disposition prepared', state: result.ready ? 'proposed' : 'blocked', basis: entries.map((entry) => entry.id), limitation: result.ready ? 'Tracked execution creates one Task without completing the source line; coordination-only work completes only the exact source line.' : result.issues.join(', ') + ' blocks every proposed write.' },
      { id: 'external-write-boundary', label: 'All external writes held behind separate authority', state: 'supported', basis: entries.map((entry) => entry.id), limitation: 'Preparation performs no provider write and grants no approval, continuation, execution, or retry authority.' }
    ],
    preview: result.preview,
    derivedReview: result.derivedReview
  };
}
