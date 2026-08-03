import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareProjectPageReconciliationRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.project-page-reconciliation';

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function runContainedProjectPageReconciliationScenario({
  root,
  lock,
  lockPath,
  scenarioPath,
  workId,
  scenarioEvidenceId = 'evidence.project-page-reconciliation.preparation.fixture',
  createdAt
}) {
  const resolvedRoot = path.resolve(root);
  const resolvedScenarioPath = resolveRepoPath(resolvedRoot, scenarioPath);
  const scenario = readJson(resolvedScenarioPath);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'project-page-reconciliation.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Project page reconciliation requires its exact contained scenario.');
  }
  const input = {
    project: 'soter-fixture://projects/project/launch',
    projectType: 'Project',
    status: 'Active',
    oldTexts: ['Confirm launch readiness.'],
    newTexts: ['SCENARIO_PRIVATE_PROJECT_REPLACEMENT_SENTINEL']
  };
  const execution = await prepareProjectPageReconciliationRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId,
    input,
    createdAt,
    scenarioPath: repoRelativePath(resolvedRoot, resolvedScenarioPath)
  });
  const capabilityOrder = execution.envelope.effects.map((effect) => effect.capability);
  const expectedModes = scenario.expected.effectModes;
  const observedModes = Object.fromEntries(Object.keys(expectedModes).map((effect) => [
    effect,
    execution.envelope.effectPolicies[effect]?.mode || 'unknown'
  ]));
  const privateSerialized = JSON.stringify({
    envelope: execution.envelope,
    preview: execution.preview,
    outcomes: execution.outcomes
  });
  const noAuthority = execution.envelope.lifecycleState === 'paused'
    && execution.envelope.approvals.length === 0
    && execution.envelope.effects.every((effect) => !effect.declaredEffects.includes('write'));
  const facts = {
    outcomes: {
      'project-current-state.exact': execution.snapshot.entries.length === 4,
      'project-change.reviewable': execution.preview.proposedChanges.length === 2,
      'project-change.preparation-grants-no-authority': noAuthority
    },
    invariants: {
      'unselected-project-values-preserved': execution.derivedReview.items.some((item) => {
        if (item.kind !== 'project-properties-update') return false;
        const fields = new Map(item.fields.map((field) => [field.id, field.reviewValue]));
        const before = JSON.parse(fields.get('beforeFieldsJson'));
        const after = JSON.parse(fields.get('afterFieldsJson'));
        return fingerprintJson(before.organizationUris) === fingerprintJson(after.organizationUris)
          && fingerprintJson(before.taskUris) === fingerprintJson(after.taskUris)
          && before.name === after.name;
      }),
      'body-replacements-match-once': execution.derivedReview.items.some((item) => {
        return item.kind === 'project-body-update';
      }),
      'private-values-excluded-from-inspection': !privateSerialized.includes(input.project)
        && !privateSerialized.includes(input.oldTexts[0])
        && !privateSerialized.includes(input.newTexts[0]),
      'no-write-or-approval-during-preparation': noAuthority
    },
    evidence: {
      'exact-lock': execution.envelope.configurationLock.fingerprint === fingerprintLock(lock),
      'policy-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        execution.snapshot.entries[0]?.valueFingerprint || ''
      ),
      'schema-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        execution.snapshot.entries[1]?.valueFingerprint || ''
      ),
      'project-source-fingerprint': execution.snapshot.entries.slice(2).every((entry) => {
        return /^sha256:[a-f0-9]{64}$/.test(entry.valueFingerprint);
      }),
      'private-review-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        execution.preview.privateReview.contentFingerprint || ''
      ),
      'write-boundary-state': noAuthority
        && execution.envelope.effectPolicies.write.mode === 'confirm'
    }
  };
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
  const capabilityAssessment = {
    expected: [...scenario.expected.capabilityOrder],
    observed: capabilityOrder,
    state: exactArray(scenario.expected.capabilityOrder, capabilityOrder) ? 'passed' : 'failed'
  };
  const effectAssessment = {
    expected: scenario.expected.effectModes,
    observed: observedModes,
    state: Object.entries(expectedModes).every(([effect, mode]) => {
      return observedModes[effect] === mode;
    }) ? 'passed' : 'failed'
  };
  const assessment = {
    result: capabilityAssessment.state === 'passed'
      && effectAssessment.state === 'passed'
      && checks.every((check) => check.state === 'passed')
      ? 'passed'
      : 'failed',
    capabilityOrder: capabilityAssessment,
    effectModes: effectAssessment,
    checks,
    artifacts: [
      {
        role: 'context-snapshot',
        id: execution.snapshot.id,
        fingerprint: fingerprintJson(execution.snapshot)
      },
      {
        role: 'project-page-reconciliation-preview',
        fingerprint: execution.preview.fingerprint
      }
    ],
    observationFingerprint: fingerprintJson({
      facts,
      capabilityAssessment,
      effectAssessment,
      checks
    })
  };
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: execution.envelope,
    scenario,
    scenarioPath: repoRelativePath(resolvedRoot, resolvedScenarioPath),
    assessment,
    evaluatorId: 'automation.project-page-reconciliation.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return {
    ...execution,
    scenario,
    assessment,
    scenarioEvidence
  };
}
