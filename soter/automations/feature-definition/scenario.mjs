import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { buildDefinedFeatureBody, loadFeatureWorkflowPolicy } from '../../contexts/product/feature-workflow.mjs';
import { prepareFeatureDefinitionRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.feature-definition';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'feature-definition.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Feature Definition fixture execution requires the exact preparation scenario.');
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function row(execution) {
  return execution.preview.collections[0].rows[0];
}

function privateFields(execution) {
  return new Map(execution.derivedReview.items[0].fields.map((field) => {
    return [field.id, field.reviewValue];
  }));
}

function noAuthority(execution) {
  return execution.envelope.lifecycleState === 'paused'
    && execution.envelope.approvals.length === 0
    && execution.envelope.effects.every((effect) => {
      return !effect.declaredEffects.includes('write')
        && !effect.declaredEffects.includes('dispatch')
        && !effect.declaredEffects.includes('destructive');
    });
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

export async function runContainedFeatureDefinitionScenario({
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
  const input = {
    feature: 'https://www.notion.so/44444444444444444444444444444444',
    whatItIs: 'A write-once self-serve guide that takes a new integrator to a first successful integration.',
    scopeIn: ['One supported integration path', 'A verifiable first successful result'],
    scopeOut: ['Every provider and advanced troubleshooting'],
    doneWhen: ['A new integrator completes the guide without a private walkthrough'],
    openQuestions: ['Which integration is the first worked example?'],
    statusChangeRequested: false
  };
  const happy = await prepareFeatureDefinitionRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId,
    scenarioPath: loaded.path,
    input,
    createdAt
  });
  const pressured = await prepareFeatureDefinitionRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.pressure',
    scenarioPath: loaded.path,
    input: { ...input, statusChangeRequested: true },
    createdAt
  });
  const fields = privateFields(happy);
  const pressureFields = privateFields(pressured);
  const policyEntry = happy.snapshot.entries.find((entry) => entry.id === 'context.feature-definition.policy');
  const recordEntry = happy.snapshot.entries.find((entry) => entry.id === 'context.feature-definition.record');
  const bodyEntry = happy.snapshot.entries.find((entry) => entry.id === 'context.feature-definition.body');
  const malformed = buildDefinedFeatureBody({
    policy: loadFeatureWorkflowPolicy(resolvedRoot),
    currentBody: '# Unsupported body\n\nNo governed headings.\n',
    featureType: 'Feature',
    whatItIs: input.whatItIs,
    scopeIn: input.scopeIn,
    scopeOut: input.scopeOut,
    doneWhen: input.doneWhen,
    openQuestions: input.openQuestions
  });
  const serialized = JSON.stringify({
    envelopes: [happy.envelope, pressured.envelope],
    previews: [happy.preview, pressured.preview]
  });
  const privateValues = [
    input.whatItIs,
    ...input.scopeIn,
    ...input.scopeOut,
    ...input.doneWhen,
    ...input.openQuestions,
    fields.get('description'),
    fields.get('currentBody'),
    fields.get('proposedBody')
  ];
  const facts = {
    outcomes: {
      'feature-policy.grounded': Boolean(policyEntry),
      'feature-record.exactly-resolved': fields.get('featureId') === input.feature,
      'feature-body.exactly-grounded': bodyEntry?.value?.document?.bodyFingerprint === fingerprintJson(fields.get('currentBody')),
      'definition-written-to-body-review': fields.get('proposedBody').includes(input.whatItIs)
        && fields.get('proposedBody').includes('### In scope')
        && fields.get('proposedBody').includes('- [ ] ' + input.doneWhen[0]),
      'description-why-preserved': fields.get('description') === recordEntry.value.records[0].fields.description,
      'planned-status-preserved': fields.get('status') === 'Planned'
        && pressureFields.get('status') === 'Planned',
      'writes-held-for-separate-authority': noAuthority(happy) && noAuthority(pressured)
    },
    invariants: {
      'feature-reference-never-guessed': fields.get('featureId') === input.feature,
      'description-never-appended-or-overwritten': happy.preview.facts.find((fact) => fact.id === 'feature-description-change-count')?.value === 0,
      'status-never-advanced-by-definition': happy.preview.facts.find((fact) => fact.id === 'feature-status-change-count')?.value === 0
        && row(pressured).flags.includes('FEATURE_STATUS_CHANGE_EXCLUDED_FROM_DEFINITION')
        && row(pressured).actions[0].capability === 'documents.content.update',
      'unsupported-template-never-rewritten': malformed.compatible === false
        && malformed.body === null
        && malformed.reasonCode === 'FEATURE_BODY_TEMPLATE_UNSUPPORTED',
      'no-write-or-approval-during-preparation': noAuthority(happy) && noAuthority(pressured)
    },
    evidence: {
      'exact-lock': [happy, pressured].every((execution) => {
        return execution.envelope.configurationLock.fingerprint === fingerprintLock(lock)
          && execution.envelope.graphFingerprint === lock.graphFingerprint;
      }),
      'policy-fingerprint': /^sha256:[a-f0-9]{64}$/.test(policyEntry?.value?.definitionFingerprint || ''),
      'record-fingerprint': /^sha256:[a-f0-9]{64}$/.test(recordEntry?.valueFingerprint || ''),
      'body-fingerprint': /^sha256:[a-f0-9]{64}$/.test(bodyEntry?.value?.document?.bodyFingerprint || ''),
      'private-values-sanitized': privateValues.every((value) => !serialized.includes(value))
    }
  };
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: happy.envelope,
    facts,
    artifacts: [
      { role: 'context-snapshot', id: happy.snapshot.id, fingerprint: fingerprintJson(happy.snapshot) },
      { role: 'feature-definition-preview', fingerprint: happy.preview.fingerprint },
      { role: 'status-pressure-preview', fingerprint: pressured.preview.fingerprint }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: happy.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    assessment,
    evaluatorId: 'automation.feature-definition.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return {
    ...happy,
    scenario: loaded.scenario,
    assessment,
    scenarioEvidence,
    variants: { pressured }
  };
}
