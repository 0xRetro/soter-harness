import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { analyzeProjectPulse } from './analysis.mjs';
import {
  compileProjectPulseConnectedOperations,
  evaluateProjectPulseConnectedVerification
} from './connected.mjs';
import {
  assertProjectWorkPolicySelection,
  loadProjectWorkPolicyDefinition,
  projectWorkPolicyFields
} from '../../contexts/projects/project-work-policy.mjs';
import { buildProjectPulseReview } from './prepare.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixture = readJson(path.join(root, 'soter/fixtures/providers/notion/workspace-records.json')).data;
const definition = loadProjectWorkPolicyDefinition(root);
const policy = projectWorkPolicyFields(definition);

function record(id) {
  return fixture.records.find((item) => item.id === id);
}

function document(uri) {
  const source = fixture.documents.find((item) => item.uri === uri);
  return {
    ...source,
    format: 'markdown',
    bodyFingerprint: fingerprintJson(source.body)
  };
}

function analysisFor(projectId, health, healthMilestones = []) {
  const project = record(projectId);
  const taskIds = new Set(project.fields.taskUris);
  return analyzeProjectPulse({
    policy,
    project,
    tasks: fixture.records.filter((item) => item.type === 'task' && taskIds.has(item.id)),
    document: document(projectId),
    statusDate: '2026-07-20',
    visibility: 'Internal',
    health,
    healthMilestones
  });
}

const externalPolicy = fixture.records.find((item) => item.type === 'project-work-policy');
assertProjectWorkPolicySelection({ records: [externalPolicy] }, definition, {
  requireProjectedRules: true
});
const driftedPolicy = structuredClone(externalPolicy);
driftedPolicy.fields.healthMustBeOperatorJudgment = false;
assert.throws(
  () => assertProjectWorkPolicySelection({ records: [driftedPolicy] }, definition, {
    requireProjectedRules: true
  }),
  /does not match the exact governed Context definition/
);

const healthyId = 'https://www.notion.so/11111111111111111111111111111111';
const healthy = analysisFor(healthyId, 'on-track');
assert.equal(healthy.state, 'ready');
assert.equal(healthy.health.state, 'on-track');
assert.equal(healthy.tasks.completionPercent, 50);
assert.equal(healthy.document.updates.length, 1);
assert.equal(healthy.milestones[0].proposedProgressTag, 'in-progress');
assert.equal(healthy.status.fields.category, 'Status');
assert.equal(healthy.status.fields.visibility, 'Internal');
assert.deepEqual(healthy.status.fields.projectIds, [healthyId]);

const riskId = 'https://www.notion.so/22222222222222222222222222222221';
const risk = analysisFor(riskId, 'on-track');
assert.equal(risk.state, 'needs-input');
assert.equal(risk.health.state, 'on-track');
assert.equal(risk.health.contradicted, true);
assert.equal(risk.tasks.blocked, 1);
assert(risk.issues.some((issue) => issue.startsWith('PROJECT_HEALTH_JUDGMENT_CONTRADICTED:')));
const acceptedRisk = analysisFor(riskId, 'at-risk');
assert.equal(acceptedRisk.state, 'ready');
assert.equal(acceptedRisk.health.state, 'at-risk');
assert.equal(acceptedRisk.health.contradicted, false);

const sparse = analysisFor('https://www.notion.so/33333333333333333333333333333331', 'on-track');
assert.equal(sparse.state, 'needs-input');
assert.equal(sparse.tasks.completionPercent, null);
assert(sparse.issues.some((issue) => issue.startsWith('PROJECT_PROMOTED_TASKS_REQUIRED:')));

const unattributed = structuredClone(fixture);
const unattributedDocument = unattributed.documents.find((item) => item.uri === riskId);
unattributedDocument.body = unattributedDocument.body.replace('`at risk`', '');
assert(analyzeProjectPulse({
  policy,
  project: unattributed.records.find((item) => item.id === riskId),
  tasks: unattributed.records.filter((item) => {
    return ['https://www.notion.so/22222222222222222222222222222222',
      'https://www.notion.so/22222222222222222222222222222223'].includes(item.id);
  }),
  document: {
    ...unattributedDocument,
    format: 'markdown',
    bodyFingerprint: fingerprintJson(unattributedDocument.body)
  },
  statusDate: '2026-07-20',
  visibility: 'Internal',
  health: 'on-track'
}).issues.some((issue) => issue.startsWith('PROJECT_MILESTONE_HEALTH_CONTRADICTION:')));

const malformed = document(healthyId);
malformed.body = malformed.body.replace('**Launch readiness - ***', 'Launch readiness - ');
malformed.bodyFingerprint = fingerprintJson(malformed.body);
assert.throws(() => analyzeProjectPulse({
  policy,
  project: record(healthyId),
  tasks: fixture.records.filter((item) => record(healthyId).fields.taskUris.includes(item.id)),
  document: malformed,
  statusDate: '2026-07-20',
  visibility: 'Internal',
  health: 'on-track'
}), /no exact governed milestone lines/);

const malformedWorkItem = document(healthyId);
malformedWorkItem.body = malformedWorkItem.body.replace(
  '\t- [ ] Maya - Publish launch brief',
  '\t- [ ] Publish launch brief'
);
malformedWorkItem.bodyFingerprint = fingerprintJson(malformedWorkItem.body);
assert.throws(() => analyzeProjectPulse({
  policy,
  project: record(healthyId),
  tasks: fixture.records.filter((item) => record(healthyId).fields.taskUris.includes(item.id)),
  document: malformedWorkItem,
  statusDate: '2026-07-20',
  visibility: 'Internal',
  health: 'on-track'
}), /work-item line does not satisfy/);

const invalidDate = analyzeProjectPulse({
  policy,
  project: record(healthyId),
  tasks: fixture.records.filter((item) => record(healthyId).fields.taskUris.includes(item.id)),
  document: document(healthyId),
  statusDate: '2026-02-31',
  visibility: 'Internal',
  health: 'on-track'
});
assert(invalidDate.issues.some((issue) => issue.startsWith('PROJECT_STATUS_DATE_INVALID:')));

const derivedReviewDefinition = readJson(path.join(
  root,
  'soter/automations/project-pulse/derived-review.json'
));
const connectedReview = buildProjectPulseReview({
  analysis: healthy,
  derivedReviewDefinition
});
const collection = connectedReview.preview.collections[0];
const selectedActions = collection.rows.flatMap((row) => {
  return row.actions.filter((action) => action.state === 'proposed').map((action) => ({ row, action }));
});
const batch = {
  id: 'batch.project-pulse.selftest',
  fingerprint: fingerprintJson({ id: 'batch.project-pulse.selftest' }),
  work: { automationId: 'automation.project-pulse' },
  actions: selectedActions.map(({ action }) => structuredClone(action))
};
const material = {
  selection: { id: batch.id, fingerprint: batch.fingerprint },
  actions: selectedActions.map(({ row, action }) => ({
    selection: structuredClone(action),
    proposed: structuredClone(connectedReview.derivedReview.items.find((item) => {
      return item.sources.some((source) => source.rowId === row.id);
    }))
  }))
};
const compiled = compileProjectPulseConnectedOperations({ batch, material });
assert.deepEqual(
  compiled.operations.map((operation) => operation.capability),
  ['documents.content.update', 'projects.records.create']
);
assert.equal(compiled.operations[0].precondition.capability, 'documents.content.read');
assert.equal(compiled.operations[1].precondition.capability, 'projects.records.read');
assert.deepEqual(compiled.operations[1].verification.inputBindings, [{
  id: 'binding.project-pulse.created-status-id',
  sourceStage: 'write',
  sourcePath: ['record', 'id'],
  targetPath: ['ids'],
  transform: 'singleton-string-list'
}]);
assert.equal(evaluateProjectPulseConnectedVerification({
  operation: compiled.operations[0],
  phase: 'precondition',
  output: {
    document: {
      uri: healthy.document.uri,
      title: healthy.document.title,
      bodyFingerprint: healthy.document.expectedBodyFingerprint,
      body: 'PRIVATE_DOCUMENT_BODY_NOT_USED_BY_EVALUATOR'
    }
  }
}).state, 'passed');
assert.equal(evaluateProjectPulseConnectedVerification({
  operation: compiled.operations[0],
  output: {
    document: {
      uri: healthy.document.uri,
      title: healthy.document.title,
      bodyFingerprint: healthy.document.afterBodyFingerprint,
      body: 'PRIVATE_DOCUMENT_BODY_NOT_USED_BY_EVALUATOR'
    }
  }
}).state, 'passed');
assert.equal(evaluateProjectPulseConnectedVerification({
  operation: compiled.operations[1],
  phase: 'precondition',
  output: { records: [] }
}).state, 'passed');
assert.equal(evaluateProjectPulseConnectedVerification({
  operation: compiled.operations[1],
  resolvedInput: {
    recordTypes: ['project-feed-entry'],
    ids: ['private-provider-record-id'],
    limit: 2
  },
  output: {
    records: [{
      type: 'project-feed-entry',
      id: 'private-provider-record-id',
      fields: structuredClone(healthy.status.fields)
    }]
  }
}).state, 'passed');
assert.equal(evaluateProjectPulseConnectedVerification({
  operation: compiled.operations[1],
  resolvedInput: {
    recordTypes: ['project-feed-entry'],
    ids: ['private-provider-record-id'],
    limit: 2
  },
  output: {
    records: [{
      type: 'project-feed-entry',
      id: 'concurrent-same-headline-record-id',
      fields: structuredClone(healthy.status.fields)
    }]
  }
}).state, 'failed');
const partialBatch = {
  ...structuredClone(batch),
  fingerprint: fingerprintJson({ id: 'batch.project-pulse.partial' }),
  actions: [structuredClone(batch.actions[1])]
};
const partialMaterial = {
  selection: { id: partialBatch.id, fingerprint: partialBatch.fingerprint },
  actions: [structuredClone(material.actions[1])]
};
assert.throws(
  () => compileProjectPulseConnectedOperations({ batch: partialBatch, material: partialMaterial }),
  /partial selection is not allowed/
);

process.stdout.write('Project Pulse shared-policy, exact candidate selection, verification, and abstention selftest passed.\n');
