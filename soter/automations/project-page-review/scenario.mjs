import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareProjectPageReviewRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.project-page-review';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'project-page-review.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Project-page review requires the exact contained preparation scenario.');
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assessmentFor({ scenario, envelope, facts, artifacts }) {
  const observedCapabilities = envelope.effects.map((effect) => effect.capability);
  const observedModes = Object.fromEntries(Object.keys(scenario.expected.effectModes)
    .sort()
    .map((effect) => [effect, envelope.effectPolicies[effect]?.mode || 'unknown']));
  const checks = [
    ...scenario.expected.outcomes.map((id) => ({
      id,
      category: 'outcome',
      state: facts.outcomes[id] === true ? 'passed' : 'failed'
    })),
    ...scenario.expected.invariants.map((id) => ({
      id,
      category: 'invariant',
      state: facts.invariants[id] === true ? 'passed' : 'failed'
    })),
    ...scenario.expected.evidence.map((id) => ({
      id,
      category: 'evidence',
      state: facts.evidence[id] === true ? 'passed' : 'failed'
    }))
  ];
  const capabilityOrder = {
    expected: [...scenario.expected.capabilityOrder],
    observed: observedCapabilities,
    state: exactArray(scenario.expected.capabilityOrder, observedCapabilities)
      ? 'passed'
      : 'failed'
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

function entry(execution, id) {
  return execution.snapshot.entries.find((candidate) => candidate.id === id);
}

function fact(execution, id) {
  return execution.preview.facts.find((candidate) => candidate.id === id);
}

function noAuthority(execution) {
  return execution.envelope.lifecycleState === 'paused'
    && execution.envelope.approvals.length === 0
    && execution.preview.proposedChanges.length === 0
    && execution.preview.collections.every((collection) => {
      return collection.rows.every((row) => row.actions.length === 0);
    })
    && execution.envelope.effects.every((effect) => {
      return !effect.declaredEffects.includes('write')
        && !effect.declaredEffects.includes('dispatch')
        && !effect.declaredEffects.includes('destructive');
    });
}

export async function runContainedProjectPageReviewScenario({
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
  const execution = await prepareProjectPageReviewRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId,
    scenarioPath: loaded.path,
    input: {
      project: 'soter-fixture://projects/project/launch',
      focus: 'Check exact configured structure without proposing any mutation.'
    },
    createdAt
  });
  const sanitized = JSON.stringify({
    envelope: execution.envelope,
    preview: execution.preview,
    outcomes: execution.outcomes,
    contextPlan: execution.contextPlan
  });
  const privateValues = [
    'soter-fixture://projects/project/launch',
    'soter-fixture://tasks/task/existing-deck',
    'Acme launch',
    'Send launch deck',
    'Launch the customer program with an attributable delivery plan.',
    'Check exact configured structure without proposing any mutation.'
  ];
  const taskEntry = entry(execution, 'context.project-page-review.tasks');
  const projectEntry = entry(execution, 'context.project-page-review.project');
  const pageItem = execution.derivedReview.items.find((item) => {
    return item.kind === 'project-page-detail';
  });
  const taskItem = execution.derivedReview.items.find((item) => {
    return item.kind === 'project-task-detail';
  });
  const structuralDrift = fact(execution, 'template-database-count').value === 6
    && fact(execution, 'page-database-count').value === 1
    && fact(execution, 'template-columns-count').value === 1
    && fact(execution, 'page-columns-count').value === 0;
  const attentionCodes = pageItem.fields.find((field) => field.id === 'reasonCodes').reviewValue;
  const taskCodes = taskItem.fields.find((field) => field.id === 'reasonCodes').reviewValue;
  const facts = {
    outcomes: {
      'portable-policies.exactly-grounded': [
        'context.project-page-review.project-capture-policy',
        'context.project-page-review.project-work-policy',
        'context.project-page-review.task-work-policy'
      ].every((id) => Boolean(entry(execution, id))),
      'template-and-page.exactly-compared': Boolean(
        entry(execution, 'context.project-page-review.template')
      ) && Boolean(entry(execution, 'context.project-page-review.document')),
      'related-tasks.complete': taskEntry.value.records.length === 1
        && projectEntry.value.records[0].fields.taskUris.length === 1,
      'structural-drift.visible': structuralDrift
        && attentionCodes.includes('PROJECT_PAGE_TEMPLATE_STRUCTURE_DRIFT'),
      'attention-only-fields.not-promoted': taskCodes.length === 0
        && attentionCodes.includes('PROJECT_PAGE_MANAGER_IDENTITY_UNAVAILABLE')
        && attentionCodes.includes('PROJECT_PAGE_PROVIDER_LIVE_VIEW_WIRING_UNAVAILABLE'),
      'proposals-and-writes.absent': noAuthority(execution)
    },
    invariants: {
      'template-is-configured-source': entry(
        execution,
        'context.project-page-review.template'
      ).value.document.bodyFingerprint === pageItem.fields.find((field) => {
        return field.id === 'templateFingerprint';
      }).reviewValue,
      'page-body-and-task-title.private': taskItem.fields.find((field) => {
        return field.id === 'title';
      }).reviewValue === 'Send launch deck'
        && pageItem.fields.some((field) => field.id === 'pageOutline'),
      'raw-urls-and-bodies.excluded': privateValues.every((value) => !sanitized.includes(value)),
      'provider-live-view-wiring.unavailable': fact(
        execution,
        'provider-live-view-wiring'
      ).state === 'unavailable',
      'no-approval-continuation-or-write-authority': noAuthority(execution)
    },
    evidence: {
      'exact-lock': execution.envelope.configurationLock.fingerprint === fingerprintLock(lock)
        && execution.envelope.graphFingerprint === lock.graphFingerprint,
      'policy-source-fingerprints': [
        'context.project-page-review.project-capture-policy',
        'context.project-page-review.project-work-policy',
        'context.project-page-review.task-work-policy'
      ].every((id) => /^sha256:[a-f0-9]{64}$/.test(entry(execution, id).valueFingerprint)),
      'template-and-page-fingerprints': [
        'context.project-page-review.template',
        'context.project-page-review.document'
      ].every((id) => /^sha256:[a-f0-9]{64}$/.test(entry(execution, id).valueFingerprint)),
      'complete-task-coverage-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        taskEntry.valueFingerprint
      ),
      'automation-owned-derived-review-contract-fingerprint':
        /^sha256:[a-f0-9]{64}$/.test(execution.preview.privateReview.contractFingerprint)
    }
  };
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: execution.envelope,
    facts,
    artifacts: [
      {
        role: 'context-snapshot',
        id: execution.snapshot.id,
        fingerprint: fingerprintJson(execution.snapshot)
      },
      {
        role: 'project-page-review-preview',
        fingerprint: execution.preview.fingerprint
      }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: execution.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    assessment,
    evaluatorId: 'automation.project-page-review.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return { ...execution, scenario: loaded.scenario, assessment, scenarioEvidence };
}
