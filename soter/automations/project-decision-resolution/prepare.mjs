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

const AUTOMATION_ID = 'automation.project-decision-resolution';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';
const DECISION_ACTION = 'action.project-decision-resolution.decision-create';
const QUESTION_ACTION = 'action.project-decision-resolution.question-process';
const WORK_ITEM_ACTION = 'action.project-decision-resolution.work-item-complete';
const BATCH_ACTION_IDS = [QUESTION_ACTION, WORK_ITEM_ACTION, DECISION_ACTION];

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
    'project-decision-resolution',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'project-decision-resolution-derived-review') {
    throw new Error('Project Decision Resolution derived-review definition drifted.');
  }
  return definition;
}

function authority(lock, role, subject = 'projects.records') {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error(
      'Project Decision Resolution requires one exact ' + role + ' authority for ' + subject + '.'
    );
  }
  return matches[0].id;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'project-work-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Project Decision Resolution requires one configured Projects policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'projects.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || fingerprintJson(source.input.recordTypes) !== fingerprintJson(['project-work-policy'])
    || source.input.ids?.length !== 1) {
    throw new Error('Project Decision Resolution policy source is not one exact governed read.');
  }
  return source;
}

async function readFixture({ root, lock, capability, authorityId, input, effectId, at }) {
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
    throw new Error('Project Decision Resolution contained read did not pass: ' + effectId + '.');
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
    'context.project-decision-resolution.policy': 'Load exact shared Projects policy',
    'context.project-decision-resolution.project': 'Load exact project record',
    'context.project-decision-resolution.question': 'Load exact unprocessed Question entry',
    'context.project-decision-resolution.document': 'Load exact project work document'
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

function action(id, kind, capability, ready, heldReason, readyReason) {
  return {
    id,
    kind,
    capability,
    effect: 'write',
    state: ready ? 'proposed' : 'held',
    reasonCode: ready ? readyReason : heldReason,
    changeFingerprint: null
  };
}

function reviewRow({ id, sequence, kind, fingerprint, reasonCode, flags, actionValue }) {
  const row = {
    id,
    sequence,
    representedCount: 1,
    subject: { kind, fingerprint },
    group: 'project-decision-resolution',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode,
    flags,
    actions: [actionValue],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  row.fingerprint = rowFingerprint(row);
  return row;
}

function exactReplace(body, oldText, newText) {
  const first = body.indexOf(oldText);
  const second = first < 0 ? -1 : body.indexOf(oldText, first + oldText.length);
  if (first < 0 || second >= 0 || oldText === newText) {
    throw new Error('Project Decision Resolution requires one exact changing work-item replacement.');
  }
  return body.slice(0, first) + newText + body.slice(first + oldText.length);
}

function issue(code, claim, basisIds) {
  return { code, claim, basisIds };
}

export function buildProjectDecisionResolutionPreview({
  input,
  policy,
  project,
  questionRecords,
  document,
  derivedDefinition
}) {
  const issues = [];
  const questionMatches = questionRecords.filter((record) => {
    return record.type === 'project-feed-entry';
  });
  const question = questionMatches.length === 1 && questionRecords.length === 1
    ? questionMatches[0]
    : null;
  if (!question) {
    issues.push(issue(
      'PROJECT_QUESTION_IDENTITY_UNRESOLVED',
      'The selected Question reference did not resolve to one exact project-feed entry.',
      ['context.project-decision-resolution.question']
    ));
  } else {
    if (question.fields?.category !== policy.questionCategory) {
      issues.push(issue(
        'PROJECT_QUESTION_CATEGORY_INVALID',
        'The selected feed entry is not a Question under the current Projects policy.',
        ['context.project-decision-resolution.policy', 'context.project-decision-resolution.question']
      ));
    }
    if (question.fields?.processed !== false) {
      issues.push(issue(
        'PROJECT_QUESTION_ALREADY_PROCESSED',
        'The selected Question is already processed and cannot be resolved again.',
        ['context.project-decision-resolution.question']
      ));
    }
    if (fingerprintJson(question.fields?.projectIds) !== fingerprintJson([project.id])) {
      issues.push(issue(
        'PROJECT_QUESTION_PROJECT_MISMATCH',
        'The selected Question does not bind exactly the selected project.',
        ['context.project-decision-resolution.project', 'context.project-decision-resolution.question']
      ));
    }
  }
  if (!policy.allowedVisibilities.includes(input.visibility)) {
    issues.push(issue(
      'PROJECT_DECISION_VISIBILITY_INVALID',
      'The selected visibility is outside the shared Projects policy.',
      ['context.project-decision-resolution.policy']
    ));
  }
  const parsed = parseProjectWorkDocument(document, policy);
  const workMatches = parsed.workItems.filter((item) => lower(item.action) === lower(input.workItemAction));
  const workItem = workMatches.length === 1 ? workMatches[0] : null;
  if (!workItem) {
    issues.push(issue(
      workMatches.length > 1
        ? 'PROJECT_WORK_ITEM_ACTION_AMBIGUOUS'
        : 'PROJECT_WORK_ITEM_NOT_FOUND',
      workMatches.length > 1
        ? 'Several current project work items share the requested action.'
        : 'No current project work item exactly matches the requested action.',
      ['context.project-decision-resolution.document']
    ));
  } else if (workItem.checked) {
    issues.push(issue(
      'PROJECT_WORK_ITEM_ALREADY_COMPLETE',
      'The selected project work item is already complete.',
      ['context.project-decision-resolution.document']
    ));
  }
  const ready = issues.length === 0;
  const reasonCode = ready ? 'PROJECT_DECISION_RESOLUTION_READY_FOR_REVIEW' : issues[0].code;
  const decisionSummary = [
    input.decisionWhat,
    input.decidedBy,
    input.decisionWhy || policy.missingDecisionWhyMarker
  ].join(' - ');
  const decisionFields = {
    headline: input.decisionHeadline,
    category: policy.decisionCategory,
    date: input.decisionDate,
    summary: decisionSummary,
    processed: true,
    visibility: input.visibility,
    projectIds: [project.id]
  };
  const decisionFingerprint = fingerprintJson({
    recordType: 'project-feed-entry',
    fields: decisionFields
  });
  const questionFingerprint = fingerprintJson(question || input.question);
  const newLine = workItem && !workItem.checked
    ? renderCompletedProjectWorkItemLine(workItem)
    : workItem?.oldLine || 'unavailable';
  const afterBody = workItem && !workItem.checked
    ? exactReplace(document.body, workItem.oldLine, newLine)
    : document.body;
  const afterBodyFingerprint = fingerprintJson(afterBody);
  const decisionAction = action(
    DECISION_ACTION,
    'project-decision-create',
    'projects.records.create',
    ready,
    reasonCode,
    'PROJECT_DECISION_CREATE_READY_FOR_REVIEW'
  );
  const questionAction = action(
    QUESTION_ACTION,
    'project-question-process',
    'projects.records.update',
    ready,
    reasonCode,
    'PROJECT_QUESTION_PROCESS_READY_FOR_REVIEW'
  );
  const workAction = action(
    WORK_ITEM_ACTION,
    'project-work-item-complete',
    'documents.content.update',
    ready,
    reasonCode,
    'PROJECT_WORK_ITEM_COMPLETION_READY_FOR_REVIEW'
  );
  const rows = [
    reviewRow({
      id: 'row.project-decision-resolution.question',
      sequence: 1,
      kind: 'project-question',
      fingerprint: questionFingerprint,
      reasonCode: questionAction.reasonCode,
      flags: issues.map((item) => item.code),
      actionValue: questionAction
    }),
    reviewRow({
      id: 'row.project-decision-resolution.work-item',
      sequence: 2,
      kind: 'project-work-item',
      fingerprint: workItem?.fingerprint || fingerprintJson(input.workItemAction),
      reasonCode: workAction.reasonCode,
      flags: issues.map((item) => item.code),
      actionValue: workAction
    }),
    reviewRow({
      id: 'row.project-decision-resolution.decision',
      sequence: 3,
      kind: 'project-decision',
      fingerprint: decisionFingerprint,
      reasonCode: decisionAction.reasonCode,
      flags: issues.map((item) => item.code),
      actionValue: decisionAction
    })
  ];
  const collectionId = 'collection.project-decision-resolution.changes';
  const source = (row) => ({
    collectionId,
    rowId: row.id,
    rowFingerprint: row.fingerprint
  });
  const questionItem = privateItem(
    'review-item.project-decision-resolution.question',
    'project-question-process',
    [source(rows[0])],
    [
      privateField('recordId', 'Question identity', 'text', question?.id || input.question),
      privateField('expectedVersion', 'Expected question version', 'text', question?.version || 'unavailable'),
      privateField('beforeFingerprint', 'Current question fingerprint', 'text', questionFingerprint),
      privateField('afterProcessed', 'Processed after review', 'boolean', true),
      privateField('batchActionIds', 'Required complete-group actions', 'string-list', BATCH_ACTION_IDS)
    ]
  );
  const workItemReview = privateItem(
    'review-item.project-decision-resolution.work-item',
    'project-work-item-complete',
    [source(rows[1])],
    [
      privateField('uri', 'Project document identity', 'text', document.uri),
      privateField('expectedTitle', 'Expected project title', 'text', document.title),
      privateField('expectedBodyFingerprint', 'Current document fingerprint', 'text', document.bodyFingerprint),
      privateField('afterBodyFingerprint', 'Expected document fingerprint', 'text', afterBodyFingerprint),
      privateField('workItemId', 'Exact work-item identity', 'text', workItem?.id || 'unavailable'),
      privateField('oldText', 'Current work-item line', 'text', workItem?.oldLine || 'unavailable'),
      privateField('newText', 'Completed work-item line', 'text', newLine),
      privateField('batchActionIds', 'Required complete-group actions', 'string-list', BATCH_ACTION_IDS)
    ]
  );
  const decisionItem = privateItem(
    'review-item.project-decision-resolution.decision',
    'project-decision-create',
    [source(rows[2])],
    [
      privateField('headline', 'Decision headline', 'text', decisionFields.headline),
      privateField('category', 'Category', 'text', decisionFields.category),
      privateField('date', 'Decision date', 'text', decisionFields.date),
      privateField('summary', 'Complete decision summary', 'text', decisionFields.summary),
      privateField('processed', 'Processed', 'boolean', decisionFields.processed),
      privateField('visibility', 'Visibility', 'text', decisionFields.visibility),
      privateField('projectIds', 'Project identities', 'string-list', decisionFields.projectIds),
      privateField('missingWhy', 'Why was unavailable', 'boolean', !input.decisionWhy),
      privateField('batchActionIds', 'Required complete-group actions', 'string-list', BATCH_ACTION_IDS)
    ]
  );
  rows[0].privateDetailFingerprint = questionItem.fingerprint;
  rows[1].privateDetailFingerprint = workItemReview.fingerprint;
  rows[2].privateDetailFingerprint = decisionItem.fingerprint;
  const proposedChanges = [];
  if (ready) {
    const changes = [
      {
        id: QUESTION_ACTION,
        recordId: question.id,
        effect: 'projects.records.update',
        beforeFingerprint: questionFingerprint,
        afterFingerprint: questionItem.fingerprint
      },
      {
        id: WORK_ITEM_ACTION,
        recordId: 'document:' + fingerprintJson(document.uri).slice(7, 23),
        effect: 'documents.content.update',
        beforeFingerprint: document.bodyFingerprint,
        afterFingerprint: workItemReview.fingerprint
      },
      {
        id: DECISION_ACTION,
        recordId: 'new:project-decision:' + decisionFingerprint.slice(7, 23),
        effect: 'projects.records.create',
        beforeFingerprint: null,
        afterFingerprint: decisionItem.fingerprint
      }
    ];
    for (const change of changes) {
      const row = rows.find((candidate) => candidate.actions[0].id === change.id);
      row.actions[0].changeFingerprint = fingerprintJson(change);
      proposedChanges.push(change);
    }
  }
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'project-decision-resolution-changes',
    labelKey: 'project-decision-resolution-changes',
    coverage: {
      complete: true,
      observedCount: 3,
      includedCount: 3,
      excludedCount: 0,
      exclusions: []
    },
    rows,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  collection.fingerprint = collectionFingerprint(collection);
  const derivedReview = {
    kind: derivedDefinition.kind,
    items: [questionItem, workItemReview, decisionItem]
  };
  const facts = [
    { id: 'project-grounded', label: 'Exact project grounded', value: true, state: 'supported', basisIds: ['context.project-decision-resolution.project'] },
    { id: 'question-current', label: 'Question is current and unprocessed', value: Boolean(question && question.fields.processed === false), state: question && question.fields.processed === false ? 'supported' : 'contradicted', basisIds: ['context.project-decision-resolution.question'] },
    { id: 'work-item-grounded', label: 'Exact unchecked work item grounded', value: Boolean(workItem && !workItem.checked), state: workItem && !workItem.checked ? 'supported' : 'contradicted', basisIds: ['context.project-decision-resolution.document'] },
    { id: 'decision-why-state', label: 'Decision why supplied', value: Boolean(input.decisionWhy), state: input.decisionWhy ? 'supported' : 'unavailable', basisIds: ['context.project-decision-resolution.policy'] },
    { id: 'complete-group-size', label: 'Required exact write group', value: BATCH_ACTION_IDS.length, state: ready ? 'supported' : 'unavailable', basisIds: ['context.project-decision-resolution.question', 'context.project-decision-resolution.document'] }
  ];
  const contradictions = issues.map((item) => ({
    id: item.code.toLocaleLowerCase('en').replaceAll('_', '-'),
    claim: item.claim,
    state: 'observed',
    basisIds: item.basisIds
  }));
  if (!input.decisionWhy) {
    contradictions.push({
      id: 'project-decision-why-unavailable',
      claim: 'No rationale was supplied; the exact review uses the governed missing-why marker and invents no explanation.',
      state: 'observed',
      basisIds: ['context.project-decision-resolution.policy']
    });
  }
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'project-decision-resolution-preview',
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
    issues: issues.map((item) => item.code).sort(compareCodepoint),
    preview,
    derivedReview,
    decisionFields,
    question,
    workItem,
    document: {
      uri: document.uri,
      title: document.title,
      expectedBodyFingerprint: document.bodyFingerprint,
      afterBodyFingerprint,
      oldText: workItem?.oldLine || null,
      newText: ready ? newLine : null
    }
  };
}

export async function prepareProjectDecisionResolutionRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const definitionAuthority = authority(lock, 'definition');
  const instanceAuthority = authority(lock, 'instance');
  const policyDefinition = loadProjectWorkPolicyDefinition(root);
  const source = policySource(lock, definitionAuthority);
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
    requestedOutcome: 'Prepare one exact Decision, matching Question resolution, and project work-item completion as an indivisible review group.',
    evidenceIds: []
  });
  const policyResult = await readFixture({
    root,
    lock,
    capability: 'projects.records.read',
    authorityId: definitionAuthority,
    input: source.input,
    effectId: 'effect.project-decision-resolution.policy.fixture',
    at: createdAt
  });
  const policy = assertProjectWorkPolicySelection(policyResult.output, policyDefinition, {
    requireProjectedRules: true
  });
  const projectResult = await readFixture({
    root,
    lock,
    capability: 'projects.records.read',
    authorityId: instanceAuthority,
    input: { recordTypes: ['project'], ids: [input.project], limit: 2 },
    effectId: 'effect.project-decision-resolution.project.fixture',
    at: createdAt
  });
  const project = exactRequestedContextRecord(projectResult.output, {
    recordType: 'project',
    requestedId: input.project
  });
  const questionResult = await readFixture({
    root,
    lock,
    capability: 'projects.records.read',
    authorityId: instanceAuthority,
    input: { recordTypes: ['project-feed-entry'], ids: [input.question], limit: 2 },
    effectId: 'effect.project-decision-resolution.question.fixture',
    at: createdAt
  });
  const question = exactRequestedContextRecord(questionResult.output, {
    recordType: 'project-feed-entry',
    requestedId: input.question
  });
  const documentResult = await readFixture({
    root,
    lock,
    capability: 'documents.content.read',
    authorityId: instanceAuthority,
    input: { uri: project.id, expectedTitle: project.fields.name },
    effectId: 'effect.project-decision-resolution.document.fixture',
    at: createdAt
  });
  const document = documentResult.output.document;
  if (document.uri !== project.id || document.title !== project.fields.name) {
    throw new Error('Project Decision Resolution document does not match the selected project.');
  }
  const acquired = [
    {
      result: policyResult,
      entry: snapshotEntry({
        id: 'context.project-decision-resolution.policy',
        subject: 'projects.records.project-work-policy',
        authorityId: definitionAuthority,
        role: 'definition',
        result: policyResult,
        value: {
          record: policy.record,
          definitionFingerprint: policy.definitionFingerprint
        }
      })
    },
    {
      result: projectResult,
      entry: snapshotEntry({
        id: 'context.project-decision-resolution.project',
        subject: 'projects.records.project',
        authorityId: instanceAuthority,
        role: 'instance',
        result: projectResult
      })
    },
    {
      result: questionResult,
      entry: snapshotEntry({
        id: 'context.project-decision-resolution.question',
        subject: 'projects.records.project-feed-entry',
        authorityId: instanceAuthority,
        role: 'instance',
        result: questionResult
      })
    },
    {
      result: documentResult,
      entry: snapshotEntry({
        id: 'context.project-decision-resolution.document',
        subject: 'documents.project-work',
        authorityId: instanceAuthority,
        role: 'instance',
        result: documentResult
      })
    }
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
        'Decision text, attribution, rationale, work-item text, Question content, provider responses, and credentials are excluded from general inspection.'
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
    { id: 'project-decision-resolution-grounded', state: 'passed', details: 'The exact Projects policy, project, Question, and current work document were loaded.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No approval, continuation, provider write, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;
  const result = buildProjectDecisionResolutionPreview({
    input,
    policy: policy.fields,
    project,
    questionRecords: [question],
    document,
    derivedDefinition
  });
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      { id: 'projects-policy-grounded', label: 'Shared Projects policy grounded', state: 'supported', basis: ['context.project-decision-resolution.policy'], limitation: 'Contained policy selection does not establish live provider readiness.' },
      { id: 'decision-resolution-review', label: 'Complete three-surface Decision resolution prepared', state: result.ready ? 'proposed' : 'blocked', basis: entries.map((entry) => entry.id), limitation: result.ready ? 'The exact group is review-only and cannot be partially compiled or executed from preparation.' : result.issues.join(', ') + ' blocks every proposed write.' },
      { id: 'external-write-boundary', label: 'All external writes held behind separate authority', state: 'supported', basis: entries.map((entry) => entry.id), limitation: 'Preparation performs no provider write and grants no approval, continuation, execution, or retry authority.' }
    ],
    preview: result.preview,
    derivedReview: result.derivedReview
  };
}
