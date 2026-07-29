import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { fingerprintLegacySource } from '../../kernel/legacy-inventory.mjs';
import { prepareProjectDecisionResolutionRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.project-decision-resolution';
const IDS = new Set([
  'project-decision-resolution.happy-path',
  'project-decision-resolution.missing-why'
]);
const REQUIRED_ACTION_IDS = [
  'action.project-decision-resolution.question-process',
  'action.project-decision-resolution.work-item-complete',
  'action.project-decision-resolution.decision-create'
];

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || !IDS.has(scenario.id)
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Project Decision Resolution requires one declared contained scenario.');
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

export async function runContainedProjectDecisionResolutionScenario({
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
  const sourceCaseArtifacts = loaded.scenario.sourceCases.map((sourcePath) => ({
    role: 'source-case',
    path: sourcePath,
    fingerprint: fingerprintLegacySource(resolvedRoot, sourcePath)
  }));
  const input = {
    project: 'https://www.notion.so/33333333333333333333333333333331',
    question: 'soter-fixture://projects/project-feed/question-confirm-scope',
    workItemAction: 'Confirm delivery scope',
    decisionHeadline: 'Delivery scope approved',
    decisionWhat: 'Ship the bounded first delivery',
    decidedBy: 'Maya',
    ...(loaded.scenario.id === 'project-decision-resolution.happy-path'
      ? { decisionWhy: 'The current evidence supports the bounded scope' }
      : {}),
    decisionDate: '2026-07-22',
    visibility: 'Internal'
  };
  const execution = await prepareProjectDecisionResolutionRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId,
    scenarioPath: loaded.path,
    input,
    createdAt
  });
  const rows = execution.preview.collections[0]?.rows || [];
  const items = execution.derivedReview.items;
  const question = fields(items.find((item) => item.kind === 'project-question-process'));
  const workItem = fields(items.find((item) => item.kind === 'project-work-item-complete'));
  const decision = fields(items.find((item) => item.kind === 'project-decision-create'));
  const completeGroup = [question, workItem, decision].every((item) => {
    return exactArray(item.get('batchActionIds'), REQUIRED_ACTION_IDS);
  });
  const boundaryHeld = execution.envelope.lifecycleState === 'paused'
    && execution.envelope.approvals.length === 0
    && execution.envelope.effects.every((effect) => !effect.declaredEffects.includes('write'));
  const privateValues = [
    input.workItemAction,
    input.decisionHeadline,
    input.decisionWhat,
    input.decidedBy,
    input.decisionWhy,
    input.decisionDate
  ].filter(Boolean);
  const previewSanitized = privateValues.every((value) => {
    return !JSON.stringify(execution.preview).includes(value);
  });
  const facts = {
    outcomes: {
      'projects-policy.grounded': Boolean(execution.snapshot.entries.find((entry) => {
        return entry.id === 'context.project-decision-resolution.policy';
      })),
      'question.exact-and-unprocessed': question.get('recordId') === input.question
        && question.get('afterProcessed') === true,
      'work-item.exact-and-unchecked': workItem.get('oldText')
        === '\t- [ ] @2026-07-24 - Maya - Confirm delivery scope',
      'decision-three-surface-group.previewed': execution.preview.proposedChanges.length === 3
        && rows.length === 3
        && rows.every((row) => row.actions[0].state === 'proposed')
        && completeGroup,
      'missing-why.explicitly-marked': !input.decisionWhy
        && decision.get('missingWhy') === true
        && decision.get('summary').endsWith(' - [why not supplied]'),
      'writes-held-for-separate-authority': boundaryHeld
    },
    invariants: {
      'decision-summary-preserves-exact-what-who-why': decision.get('summary')
        === [input.decisionWhat, input.decidedBy, input.decisionWhy].join(' - '),
      'question-only-processed-field-may-change': question.get('afterProcessed') === true
        && question.get('expectedVersion') === '1',
      'work-item-only-exact-checkbox-may-change': workItem.get('newText')
        === workItem.get('oldText').replace('- [ ] ', '- [x] '),
      'three-actions-proposed-or-held-together': completeGroup
        && rows.every((row) => row.actions[0].state === rows[0].actions[0].state),
      'private-values-excluded-from-inspection': previewSanitized,
      'no-write-or-approval-during-preparation': boundaryHeld,
      'missing-why-never-invented': !input.decisionWhy
        && decision.get('summary') === input.decisionWhat + ' - ' + input.decidedBy
          + ' - [why not supplied]',
      'governed-missing-why-marker-visible-in-private-review': !input.decisionWhy
        && decision.get('missingWhy') === true
        && decision.get('summary').includes('[why not supplied]')
    },
    evidence: {
      'exact-lock': execution.envelope.configurationLock.fingerprint === fingerprintLock(lock)
        && execution.envelope.graphFingerprint === lock.graphFingerprint,
      'policy-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        execution.snapshot.entries.find((entry) => {
          return entry.id === 'context.project-decision-resolution.policy';
        })?.valueFingerprint || ''
      ),
      'question-read-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        execution.snapshot.entries.find((entry) => {
          return entry.id === 'context.project-decision-resolution.question';
        })?.valueFingerprint || ''
      ),
      'document-read-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        execution.snapshot.entries.find((entry) => {
          return entry.id === 'context.project-decision-resolution.document';
        })?.valueFingerprint || ''
      ),
      'private-review-material': items.length === 3
        && items.every((item) => rows.some((row) => {
          return row.privateDetailFingerprint === item.fingerprint;
        })),
      'complete-group-fingerprint': completeGroup
        && rows.every((row) => /^sha256:[a-f0-9]{64}$/.test(
          row.actions[0].changeFingerprint || ''
        )),
      'write-boundary-state': boundaryHeld
        && execution.envelope.effectPolicies.write.mode === 'confirm',
      'source-cases-exactly-fingerprinted': sourceCaseArtifacts.length > 0
        && sourceCaseArtifacts.every((artifact) => /^sha256:[a-f0-9]{64}$/.test(
          artifact.fingerprint
        ))
    }
  };
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: execution.envelope,
    facts,
    artifacts: [
      { role: 'context-snapshot', id: execution.snapshot.id, fingerprint: fingerprintJson(execution.snapshot) },
      { role: 'project-decision-resolution-preview', fingerprint: execution.preview.fingerprint }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: execution.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    sourceCaseArtifacts,
    assessment,
    evaluatorId: 'automation.project-decision-resolution.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return { ...execution, scenario: loaded.scenario, assessment, scenarioEvidence };
}
