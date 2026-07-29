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
import { prepareProcessCaptureRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.process-capture';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'process-capture.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Process Capture fixture execution requires the exact preparation scenario.');
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function row(execution) {
  return execution.preview.collections[0].rows[0];
}

function privateFields(execution) {
  return new Map(execution.derivedReview.items[0].fields.map((field) => [field.id, field.reviewValue]));
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

function baseInput(overrides = {}) {
  return {
    name: 'Monthly multisig signer review',
    purpose: 'Verify that every current multisig signer remains authorized before proposing any signer change.',
    triggerKinds: ['Schedule'],
    triggers: ['The monthly signer-review date is reached.'],
    frequency: 'Monthly',
    processLogicOwner: 'Security lead',
    stepRoles: ['Security lead', 'Security lead', 'Security lead'],
    stepCapabilities: ['Signer Operations', 'Security Review', 'Signer Operations'],
    stepObjectives: ['Gather the current signer set', 'Verify each signer against the reference', 'Propose and sign reviewed changes'],
    workItems: ['Load the complete current signer set.', 'Compare every signer with the exact authorization reference.', 'Prepare only the signer changes supported by the completed comparison.'],
    exceptionHandling: ['A signer identity cannot be reconciled → stop and route the exact mismatch for operator review.'],
    postRunSummaryFields: ['Signer set reviewed', 'Mismatches observed', 'Changes proposed', 'Evidence retained'],
    category: 'Operations — Security',
    tags: ['Multisig'],
    relatedService: 'Security Operations',
    spawnTasks: false,
    ...overrides
  };
}

export async function runContainedProcessCaptureScenario({
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
  const inputs = {
    happy: baseInput(),
    pressure: baseInput({
      name: 'Treasury rebalance',
      purpose: 'Rebalance treasury positions according to reviewed target allocations.',
      frequency: 'Fortnightly',
      processLogicOwner: 'Treasury lead',
      stepRoles: ['Treasury lead'],
      stepCapabilities: ['Treasury Operations'],
      stepObjectives: ['Review and rebalance treasury positions'],
      workItems: ['Compare current balances with reviewed target allocations and prepare the bounded rebalance.'],
      postRunSummaryFields: ['Positions reviewed', 'Variance observed', 'Rebalance proposed'],
      category: 'Ops-Finance',
      tags: ['Treasury'],
      relatedService: undefined
    }),
    taskSpawn: baseInput({
      name: 'Incident response definition',
      purpose: 'Coordinate one repeatable response to a confirmed operational incident.',
      frequency: 'Ad Hoc',
      category: 'Operations — Security',
      tags: ['Incident Response'],
      spawnTasks: true
    }),
    duplicate: baseInput({ name: 'Existing incident response', frequency: 'Ad Hoc' })
  };
  const happy = await prepareProcessCaptureRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId,
    scenarioPath: loaded.path,
    input: inputs.happy,
    createdAt
  });
  const pressure = await prepareProcessCaptureRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.pressure',
    scenarioPath: loaded.path,
    input: inputs.pressure,
    createdAt
  });
  const taskSpawn = await prepareProcessCaptureRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.task-spawn',
    scenarioPath: loaded.path,
    input: inputs.taskSpawn,
    createdAt
  });
  const duplicate = await prepareProcessCaptureRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.duplicate',
    scenarioPath: loaded.path,
    input: inputs.duplicate,
    createdAt
  });
  const happyFields = privateFields(happy);
  const pressureFields = privateFields(pressure);
  const taskFields = privateFields(taskSpawn);
  const happyPolicy = happy.snapshot.entries.find((entry) => entry.id === 'context.process-capture.policy');
  const happySchema = happy.snapshot.entries.find((entry) => entry.id === 'context.process-capture.schema');
  const happyCandidates = happy.snapshot.entries.find((entry) => entry.id === 'context.process-capture.candidates');
  const happyRoles = happy.snapshot.entries.find((entry) => entry.id === 'context.process-capture.roles');
  const happyService = happy.snapshot.entries.find((entry) => entry.id === 'context.process-capture.service');
  const serialized = JSON.stringify({
    envelopes: [happy.envelope, pressure.envelope, taskSpawn.envelope, duplicate.envelope],
    previews: [happy.preview, pressure.preview, taskSpawn.preview, duplicate.preview]
  });
  const privateValues = Object.values(inputs).flatMap((input) => [
    input.name,
    input.purpose,
    ...(input.triggers || []),
    ...(input.stepObjectives || []),
    ...(input.workItems || []),
    ...(input.exceptionHandling || []),
    ...(input.postRunSummaryFields || [])
  ]).filter(Boolean);
  const facts = {
    outcomes: {
      'process-policy.grounded': Boolean(happyPolicy),
      'process-schema.grounded': Boolean(happySchema),
      'process-relations.resolved': exactArray(happyFields.get('processLogicOwnerUris'), ['soter-fixture://process/role/security-lead'])
        && exactArray(happyFields.get('relatedServiceUris'), ['soter-fixture://process/service/security-operations'])
        && exactArray(happyFields.get('relatedRoleUris'), ['soter-fixture://process/role/security-lead']),
      'process-body.shaped': ['## Purpose', '## Trigger', '## Roles', '## Initialization', '## Steps', '## Post Run Summary Report']
        .every((heading) => happyFields.get('body').includes(heading)),
      'process-create.reviewed-or-held': happy.preview.proposedChanges.length === 1
        && pressure.preview.proposedChanges.length === 1
        && taskSpawn.preview.proposedChanges.length === 1
        && duplicate.preview.proposedChanges.length === 0,
      'writes-held-for-separate-authority': [happy, pressure, taskSpawn, duplicate].every(noAuthority)
    },
    invariants: {
      'private-values-excluded-from-inspection': privateValues.every((value) => !serialized.includes(value)),
      'options-never-invented': pressureFields.get('frequency') === 'Bi-Weekly'
        && exactArray(pressureFields.get('category'), ['Operations — Finance'])
        && exactArray(pressureFields.get('tags'), ['Treasury']),
      'relations-never-fabricated': [
        ...happyFields.get('processLogicOwnerUris'),
        ...happyFields.get('relatedServiceUris'),
        ...happyFields.get('relatedRoleUris')
      ].every((value) => value.startsWith('soter-fixture://process/')),
      'definition-work-items-never-create-tasks': row(taskSpawn).flags.includes('PROCESS_TASK_SPAWN_DECLINED')
        && taskFields.get('taskSpawnDisposition') === 'declined-definition-work-items-are-not-tasks'
        && taskSpawn.preview.collections.every((collection) => collection.rows.every((item) => {
          return item.actions.every((action) => !action.capability.startsWith('crm.records.'));
        })),
      'deduplicate-before-create': row(duplicate).flags.includes('PROCESS_DUPLICATE_CANDIDATE_OBSERVED')
        && row(duplicate).actions[0].state === 'held',
      'no-write-or-approval-during-preparation': [happy, pressure, taskSpawn, duplicate].every(noAuthority)
    },
    evidence: {
      'exact-lock': [happy, pressure, taskSpawn, duplicate].every((execution) => {
        return execution.envelope.configurationLock.fingerprint === fingerprintLock(lock)
          && execution.envelope.graphFingerprint === lock.graphFingerprint;
      }),
      'policy-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(happyPolicy?.value?.definitionFingerprint || ''),
      'schema-observation-fingerprint': /^sha256:[a-f0-9]{64}$/.test(happySchema?.value?.schema?.fingerprint || ''),
      'duplicate-query-fingerprint': /^sha256:[a-f0-9]{64}$/.test(happyCandidates?.value?.providerOutputFingerprint || ''),
      'relation-query-fingerprints': [happyRoles, happyService].every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry?.value?.providerOutputFingerprint || '')),
      'private-values-sanitized': privateValues.every((value) => !serialized.includes(value)),
      'source-cases-exactly-fingerprinted': sourceCaseArtifacts.length === 3
        && sourceCaseArtifacts.every((artifact) => /^sha256:[a-f0-9]{64}$/.test(artifact.fingerprint))
    }
  };
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: happy.envelope,
    facts,
    artifacts: [
      { role: 'context-snapshot', id: happy.snapshot.id, fingerprint: fingerprintJson(happy.snapshot) },
      { role: 'process-capture-preview', fingerprint: happy.preview.fingerprint },
      { role: 'option-alias-preview', fingerprint: pressure.preview.fingerprint },
      { role: 'task-boundary-preview', fingerprint: taskSpawn.preview.fingerprint },
      { role: 'duplicate-preview', fingerprint: duplicate.preview.fingerprint }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: happy.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    sourceCaseArtifacts,
    assessment,
    evaluatorId: 'automation.process-capture.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return {
    ...happy,
    scenario: loaded.scenario,
    assessment,
    scenarioEvidence,
    variants: { pressure, taskSpawn, duplicate }
  };
}
