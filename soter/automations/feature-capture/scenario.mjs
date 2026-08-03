import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareFeatureCaptureRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.feature-capture';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'feature-capture.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Feature Capture fixture execution requires the exact preparation scenario.');
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

export async function runContainedFeatureCaptureScenario({
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
  const inputs = {
    happy: {
      name: 'Reusable integrator onboarding',
      why: 'Manual re-explanation wastes time and makes first integrations inconsistent.',
      whyState: 'confirmed',
      featureType: 'Feature',
      summary: 'A write-once self-serve guide takes a new integrator to a first successful integration.',
      sectionTwo: ['A new integrator can complete the guide without a private walkthrough.'],
      currentState: 'Not built yet.',
      relationships: ['Soter Harness'],
      openQuestions: ['Which integration should be the first worked example?'],
      area: 'Context',
      priority: 'Next'
    },
    provisional: {
      name: 'Dashboard dark mode',
      why: 'A low-light theme may reduce eye strain for operators.',
      whyState: 'provisional',
      featureType: 'Feature',
      summary: 'Add a low-light visual theme to the dashboard.',
      sectionTwo: ['Theme selection persists between sessions.']
    },
    duplicate: {
      name: 'Existing dark mode',
      why: 'Reduces eye strain in low-light environments.',
      whyState: 'confirmed',
      featureType: 'Feature',
      summary: 'Add an existing low-light visual theme.',
      sectionTwo: ['The current duplicate must be reviewed before any create.']
    },
    bug: {
      name: 'Prevent initial theme flash',
      why: 'A wrong-theme flash undermines the polished first impression on slow connections.',
      whyState: 'confirmed',
      featureType: 'Bug',
      summary: 'Initialize the correct theme before the first visible paint.',
      sectionTwo: ['Repro: load on a throttled connection.', 'Expected: the selected theme is visible from first paint.', 'Actual: the opposite theme flashes first.'],
      currentState: 'The exact current file reference is not yet grounded.',
      relationships: ['Soter Labs Landing Page']
    }
  };
  const happy = await prepareFeatureCaptureRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId,
    scenarioPath: loaded.path,
    input: inputs.happy,
    createdAt
  });
  const provisional = await prepareFeatureCaptureRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.provisional',
    scenarioPath: loaded.path,
    input: inputs.provisional,
    createdAt
  });
  const duplicate = await prepareFeatureCaptureRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.duplicate',
    scenarioPath: loaded.path,
    input: inputs.duplicate,
    createdAt
  });
  const bug = await prepareFeatureCaptureRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.bug',
    scenarioPath: loaded.path,
    input: inputs.bug,
    createdAt
  });
  const happyFields = privateFields(happy);
  const bugFields = privateFields(bug);
  const happyPolicy = happy.snapshot.entries.find((entry) => entry.id === 'context.feature-capture.policy');
  const happySchema = happy.snapshot.entries.find((entry) => entry.id === 'context.feature-capture.schema');
  const happyCandidates = happy.snapshot.entries.find((entry) => entry.id === 'context.feature-capture.candidates');
  const serialized = JSON.stringify({
    envelopes: [happy.envelope, provisional.envelope, duplicate.envelope, bug.envelope],
    previews: [happy.preview, provisional.preview, duplicate.preview, bug.preview]
  });
  const privateValues = Object.values(inputs).flatMap((input) => [
    input.name,
    input.why,
    input.summary,
    input.currentState,
    ...(input.sectionTwo || []),
    ...(input.relationships || []),
    ...(input.openQuestions || [])
  ]).filter(Boolean);
  const facts = {
    outcomes: {
      'feature-policy.grounded': Boolean(happyPolicy),
      'feature-schema.grounded': Boolean(happySchema),
      'why-kept-in-description': happyFields.get('why') === inputs.happy.why,
      'planned-status-preserved': happyFields.get('status') === 'Planned',
      'type-specific-body-shaped': bugFields.get('featureType') === 'Bug'
        && bugFields.get('body').includes('## Repro / Expected vs Actual')
        && !bugFields.get('body').includes('## Behavior / Acceptance'),
      'complete-create-reviewed-or-held': happy.preview.proposedChanges.length === 1
        && row(happy).actions[0].state === 'proposed'
        && provisional.preview.proposedChanges.length === 0
        && duplicate.preview.proposedChanges.length === 0,
      'writes-held-for-separate-authority': [happy, provisional, duplicate, bug].every(noAuthority)
    },
    invariants: {
      'configured-board-only': lock.configuration.name === 'feature-capture'
        && happy.envelope.effects.every((effect) => effect.providerPack === 'integration.notion'),
      'name-and-why-remain-distinct': happyFields.get('name') === inputs.happy.name
        && happyFields.get('why') === inputs.happy.why
        && happyFields.get('name') !== happyFields.get('why'),
      'provisional-why-never-silently-created': row(provisional).flags.includes('FEATURE_WHY_PROVISIONAL_CONFIRM_REQUIRED')
        && row(provisional).actions[0].state === 'held',
      'duplicate-never-silently-created': row(duplicate).flags.includes('FEATURE_DUPLICATE_CANDIDATE_OBSERVED')
        && row(duplicate).actions[0].state === 'held',
      'options-never-invented': happyFields.get('featureType') === 'Feature'
        && exactArray(happyFields.get('area'), ['Context'])
        && exactArray(happyFields.get('priority'), ['Next']),
      'no-write-or-approval-during-preparation': [happy, provisional, duplicate, bug].every(noAuthority)
    },
    evidence: {
      'exact-lock': [happy, provisional, duplicate, bug].every((execution) => {
        return execution.envelope.configurationLock.fingerprint === fingerprintLock(lock)
          && execution.envelope.graphFingerprint === lock.graphFingerprint;
      }),
      'policy-fingerprint': /^sha256:[a-f0-9]{64}$/.test(happyPolicy?.value?.definitionFingerprint || ''),
      'schema-fingerprint': /^sha256:[a-f0-9]{64}$/.test(happySchema?.value?.schema?.fingerprint || ''),
      'duplicate-query-fingerprint': /^sha256:[a-f0-9]{64}$/.test(happyCandidates?.value?.providerOutputFingerprint || ''),
      'private-values-sanitized': privateValues.every((value) => !serialized.includes(value))
    }
  };
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: happy.envelope,
    facts,
    artifacts: [
      { role: 'context-snapshot', id: happy.snapshot.id, fingerprint: fingerprintJson(happy.snapshot) },
      { role: 'feature-capture-preview', fingerprint: happy.preview.fingerprint },
      { role: 'provisional-why-preview', fingerprint: provisional.preview.fingerprint },
      { role: 'duplicate-preview', fingerprint: duplicate.preview.fingerprint },
      { role: 'bug-body-preview', fingerprint: bug.preview.fingerprint }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: happy.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    assessment,
    evaluatorId: 'automation.feature-capture.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return {
    ...happy,
    scenario: loaded.scenario,
    assessment,
    scenarioEvidence,
    variants: { provisional, duplicate, bug }
  };
}
