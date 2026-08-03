import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareProjectWorkPromotionRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.project-work-promotion';
const IDS = new Set([
  'project-work-promotion.tracked-execution',
  'project-work-promotion.coordination-only',
  'project-work-promotion.duplicate-task'
]);

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || !IDS.has(scenario.id)
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Project Work Promotion requires one declared contained scenario.');
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fields(item) {
  return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
}

function assessmentFor({ scenario, envelope, facts, artifacts }) {
  const observedCapabilities = envelope.effects.map((effect) => effect.capability);
  const observedModes = Object.fromEntries(Object.keys(scenario.expected.effectModes)
    .sort()
    .map((effect) => [effect, envelope.effectPolicies[effect]?.mode || 'unknown']));
  const checks = [
    ...scenario.expected.outcomes.map((id) => ({ id, category: 'outcome', state: facts.outcomes[id] === true ? 'passed' : 'failed' })),
    ...scenario.expected.invariants.map((id) => ({ id, category: 'invariant', state: facts.invariants[id] === true ? 'passed' : 'failed' })),
    ...scenario.expected.evidence.map((id) => ({ id, category: 'evidence', state: facts.evidence[id] === true ? 'passed' : 'failed' }))
  ];
  const capabilityOrder = {
    expected: [...scenario.expected.capabilityOrder],
    observed: observedCapabilities,
    state: exactArray(scenario.expected.capabilityOrder, observedCapabilities) ? 'passed' : 'failed'
  };
  const effectModes = {
    expected: scenario.expected.effectModes,
    observed: observedModes,
    state: Object.entries(scenario.expected.effectModes).every(([effect, mode]) => {
      return observedModes[effect] === mode;
    }) ? 'passed' : 'failed'
  };
  const result = capabilityOrder.state === 'passed'
    && effectModes.state === 'passed'
    && checks.every((check) => check.state === 'passed')
    ? 'passed'
    : 'failed';
  return {
    result,
    capabilityOrder,
    effectModes,
    checks,
    artifacts,
    observationFingerprint: fingerprintJson({ capabilityOrder, effectModes, checks })
  };
}

function inputFor(id) {
  if (id === 'project-work-promotion.duplicate-task') {
    return {
      project: 'https://www.notion.so/11111111111111111111111111111111',
      workItemAction: 'Publish launch brief',
      disposition: 'tracked-execution'
    };
  }
  return {
    project: 'https://www.notion.so/33333333333333333333333333333331',
    workItemAction: 'Confirm delivery scope',
    disposition: id === 'project-work-promotion.coordination-only'
      ? 'coordination-only'
      : 'tracked-execution',
    ...(id === 'project-work-promotion.tracked-execution' ? { assignee: 'self' } : {})
  };
}

export async function runContainedProjectWorkPromotionScenario({
  root,
  lock,
  lockPath,
  scenarioPath,
  workId,
  scenarioEvidenceId,
  createdAt
}) {
  const resolvedRoot = path.resolve(root);
  const loaded = loadScenario(resolvedRoot, scenarioPath);
  const input = inputFor(loaded.scenario.id);
  const execution = await prepareProjectWorkPromotionRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId,
    scenarioPath: loaded.path,
    input,
    createdAt
  });
  const row = execution.preview.collections[0]?.rows[0];
  const action = row?.actions[0];
  const item = execution.derivedReview.items[0];
  const privateFields = fields(item);
  const tracked = input.disposition === 'tracked-execution';
  const duplicate = loaded.scenario.id === 'project-work-promotion.duplicate-task';
  const boundaryHeld = execution.envelope.lifecycleState === 'paused'
    && execution.envelope.approvals.length === 0
    && execution.envelope.effects.every((effect) => !effect.declaredEffects.includes('write'));
  const previewSanitized = !JSON.stringify(execution.preview).includes(input.workItemAction)
    && !JSON.stringify(execution.preview).includes('provider-person.maya');
  const duplicateEntry = execution.snapshot.entries.find((entry) => {
    return entry.id === 'context.project-work-promotion.duplicates';
  });
  const completionBoundary = execution.preview.facts.find((fact) => {
    return fact.id === 'project-work-completion-boundary';
  })?.value;
  const facts = {
    outcomes: {
      'projects-and-tasks-policies.grounded': ['project-policy', 'task-policy'].every((suffix) => {
        return execution.snapshot.entries.some((entry) => {
          return entry.id === 'context.project-work-promotion.' + suffix;
        });
      }),
      'work-item.exact-and-unchecked': privateFields.get('workItemId') !== 'unavailable'
        && !row.flags.some((code) => [
          'PROJECT_WORK_ITEM_ACTION_AMBIGUOUS',
          'PROJECT_WORK_ITEM_NOT_FOUND',
          'PROJECT_WORK_ITEM_ALREADY_COMPLETE'
        ].includes(code)),
      'tracked-task-create.previewed': tracked && !duplicate
        && action?.kind === 'project-work-task-create'
        && action.state === 'proposed'
        && execution.preview.proposedChanges.length === 1,
      'source-work-item.remains-incomplete': tracked && !duplicate
        && completionBoundary === 'source-remains-incomplete'
        && action?.capability === 'tasks.records.create',
      'coordination-completion.previewed': !tracked
        && action?.kind === 'project-work-item-complete'
        && action.state === 'proposed'
        && execution.preview.proposedChanges.length === 1,
      'no-task-create.previewed': !tracked
        && execution.preview.proposedChanges.every((change) => {
          return change.effect !== 'tasks.records.create';
        }),
      'duplicate-task.observed': duplicate
        && action?.reasonCode === 'PROJECT_WORK_TASK_DUPLICATE_CANDIDATE'
        && duplicateEntry?.value.candidateCount === 1,
      'task-create.held': duplicate
        && action?.state === 'held'
        && execution.preview.proposedChanges.length === 0,
      'writes-held-for-separate-authority': boundaryHeld
    },
    invariants: {
      'task-title-inherits-exact-action': tracked && !duplicate
        && privateFields.get('title') === 'Confirm delivery scope',
      'project-relation-exact': tracked && !duplicate
        && exactArray(privateFields.get('projectUris'), [input.project]),
      'date-inherited-when-present': tracked && !duplicate
        && exactArray(privateFields.get('nextActionOn'), ['2026-07-24']),
      'assignee-limited-to-authenticated-self': tracked && !duplicate
        && exactArray(privateFields.get('assigneeIds'), ['provider-person.maya']),
      'deduplicate-before-create': tracked
        && duplicateEntry
        && execution.envelope.effects.at(-1).capability === 'tasks.records.read',
      'private-values-excluded-from-inspection': previewSanitized,
      'no-write-or-approval-during-preparation': boundaryHeld,
      'operator-explicitly-selects-disposition': ['tracked-execution', 'coordination-only']
        .includes(input.disposition),
      'coordination-never-creates-task': !tracked
        && action?.capability === 'documents.content.update',
      'work-item-only-exact-checkbox-may-change': !tracked
        && privateFields.get('newText') === privateFields.get('oldText').replace('- [ ] ', '- [x] '),
      'duplicate-task-never-created': duplicate
        && action?.state === 'held'
        && execution.preview.proposedChanges.length === 0,
      'source-work-item-remains-unchanged': duplicate
        && completionBoundary === 'source-remains-incomplete'
        && action?.capability === 'tasks.records.create'
    },
    evidence: {
      'exact-lock': execution.envelope.configurationLock.fingerprint === fingerprintLock(lock)
        && execution.envelope.graphFingerprint === lock.graphFingerprint,
      'policy-source-fingerprints': ['project-policy', 'task-policy'].every((suffix) => {
        return /^sha256:[a-f0-9]{64}$/.test(execution.snapshot.entries.find((entry) => {
          return entry.id === 'context.project-work-promotion.' + suffix;
        })?.valueFingerprint || '');
      }),
      'document-read-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        execution.snapshot.entries.find((entry) => {
          return entry.id === 'context.project-work-promotion.document';
        })?.valueFingerprint || ''
      ),
      'duplicate-query-fingerprint': tracked
        && /^sha256:[a-f0-9]{64}$/.test(duplicateEntry?.valueFingerprint || ''),
      'private-review-material': item.fingerprint === row?.privateDetailFingerprint,
      'write-boundary-state': boundaryHeld
        && execution.envelope.effectPolicies.write.mode === 'confirm'
    }
  };
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: execution.envelope,
    facts,
    artifacts: [
      { role: 'context-snapshot', id: execution.snapshot.id, fingerprint: fingerprintJson(execution.snapshot) },
      { role: 'project-work-promotion-preview', fingerprint: execution.preview.fingerprint }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: execution.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    assessment,
    evaluatorId: 'automation.project-work-promotion.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return { ...execution, scenario: loaded.scenario, assessment, scenarioEvidence };
}
