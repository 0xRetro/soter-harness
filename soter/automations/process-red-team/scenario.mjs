import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareProcessRedTeamRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.process-red-team';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'process-red-team.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Process Red Team fixture execution requires the exact preparation scenario.');
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
    state: Object.entries(scenario.expected.effectModes).every(([effect, mode]) => observedModes[effect] === mode)
      ? 'passed'
      : 'failed'
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

function privateFields(execution) {
  return execution.derivedReview.items.map((item) => {
    return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
  });
}

function noAuthority(execution) {
  return execution.envelope.lifecycleState === 'paused'
    && execution.envelope.approvals.length === 0
    && execution.preview.proposedChanges.length === 0
    && execution.envelope.effects.every((effect) => {
      return !effect.declaredEffects.includes('write')
        && !effect.declaredEffects.includes('dispatch')
        && !effect.declaredEffects.includes('destructive');
    });
}

export async function runContainedProcessRedTeamScenario({
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
  const baseInput = {
    processUri: 'soter-fixture://process/definition/wallet-penny-test',
    includeLatestRun: true,
    fixRequested: false
  };
  const happy = await prepareProcessRedTeamRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId,
    scenarioPath: loaded.path,
    input: baseInput,
    createdAt
  });
  const pressure = await prepareProcessRedTeamRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.fix-pressure',
    scenarioPath: loaded.path,
    input: { ...baseInput, fixRequested: true },
    createdAt
  });
  const noRun = await prepareProcessRedTeamRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.no-run',
    scenarioPath: loaded.path,
    input: { ...baseInput, includeLatestRun: false },
    createdAt
  });
  const fields = privateFields(happy);
  const pressureFields = privateFields(pressure);
  const noRunFields = privateFields(noRun);
  const policyEntry = happy.snapshot.entries.find((entry) => entry.id === 'context.process-review.policy');
  const targetEntry = happy.snapshot.entries.find((entry) => entry.id === 'context.process-review.target');
  const standardsEntry = happy.snapshot.entries.find((entry) => entry.id === 'context.process-review.policy-standards');
  const schemaEntry = happy.snapshot.entries.find((entry) => entry.id === 'context.process-review.write-target-schema');
  const runsEntry = happy.snapshot.entries.find((entry) => entry.id === 'context.process-review.runs');
  const severityOrder = { critical: 0, 'should-fix': 1, 'nice-to-have': 2 };
  const severities = fields.map((item) => item.get('severity'));
  const privateValues = [
    baseInput.processUri,
    ...targetEntry.value.records.flatMap((record) => [
      record.id,
      record.fields.name,
      record.body,
      ...(record.fields.declaredClaims || [])
    ]),
    ...standardsEntry.value.records.flatMap((record) => [
      record.id,
      record.fields.name,
      record.body,
      ...(record.fields.requiredClaims || [])
    ]),
    ...runsEntry.value.records.flatMap((record) => [
      record.id,
      record.fields.name,
      record.fields.outcome,
      record.body,
      ...(record.fields.observedClaims || [])
    ]),
    ...fields.flatMap((item) => [
      item.get('title'),
      item.get('finding'),
      item.get('reproduction'),
      item.get('proposedFix'),
      ...item.get('sourceIds')
    ])
  ].filter(Boolean);
  const sanitized = JSON.stringify({
    envelopes: [happy.envelope, pressure.envelope, noRun.envelope],
    previews: [happy.preview, pressure.preview, noRun.preview]
  });
  const facts = {
    outcomes: {
      'review-policy.grounded': Boolean(policyEntry),
      'complete-source-set.grounded': [targetEntry, standardsEntry, schemaEntry, runsEntry].every(Boolean)
        && standardsEntry.value.records.length === 1
        && runsEntry.value.records.length === 1,
      'five-lens-review.applied': policyEntry.value.definitionFingerprint === fingerprintJson(
        readJson(path.join(resolvedRoot, 'soter/contexts/process/process-review.policy.json'))
      ),
      'critical-findings.reproduced': fields.some((item) => item.get('severity') === 'critical')
        && fields.filter((item) => item.get('severity') === 'critical').every((item) => item.get('reproduced') === true),
      'ranked-findings.prepared': severities.every((severity, index) => {
        return index === 0 || severityOrder[severities[index - 1]] <= severityOrder[severity];
      }),
      'writes-prohibited': [happy, pressure, noRun].every(noAuthority)
    },
    invariants: {
      'process-doc-alone-insufficient': happy.snapshot.entries.length === 5
        && standardsEntry.value.records.length === 1
        && schemaEntry.value.schema.recordType === 'process-run'
        && runsEntry.value.records.length === 1,
      'unverified-critical-never-reported': noRunFields.every((item) => item.get('severity') !== 'critical'),
      'fix-pressure-never-writes': noAuthority(pressure)
        && pressureFields.every((item) => item.get('disposition') === 'reported-fix-request-withheld')
        && pressure.preview.collections[0].rows.every((row) => row.actions[0].state === 'held'),
      'private-source-values-excluded': privateValues.every((value) => !sanitized.includes(value)),
      'no-write-or-approval-during-preparation': [happy, pressure, noRun].every(noAuthority)
    },
    evidence: {
      'exact-lock': [happy, pressure, noRun].every((execution) => {
        return execution.envelope.configurationLock.fingerprint === fingerprintLock(lock)
          && execution.envelope.graphFingerprint === lock.graphFingerprint;
      }),
      'policy-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(policyEntry.value.definitionFingerprint || ''),
      'process-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(targetEntry.valueFingerprint || ''),
      'related-source-fingerprints': [standardsEntry, runsEntry].every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.valueFingerprint || '')),
      'schema-observation-fingerprint': /^sha256:[a-f0-9]{64}$/.test(schemaEntry.value.schema.fingerprint || ''),
      'private-values-sanitized': privateValues.every((value) => !sanitized.includes(value))
    }
  };
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: happy.envelope,
    facts,
    artifacts: [
      { role: 'context-snapshot', id: happy.snapshot.id, fingerprint: fingerprintJson(happy.snapshot) },
      { role: 'process-red-team-preview', fingerprint: happy.preview.fingerprint },
      { role: 'fix-pressure-preview', fingerprint: pressure.preview.fingerprint },
      { role: 'no-run-preview', fingerprint: noRun.preview.fingerprint }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: happy.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    assessment,
    evaluatorId: 'automation.process-red-team.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return {
    ...happy,
    scenario: loaded.scenario,
    assessment,
    scenarioEvidence,
    variants: { pressure, noRun }
  };
}
