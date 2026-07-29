import path from 'node:path';

import { exactRequestedContextRecord } from '../../core/context-records.mjs';
import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { fingerprintLegacySource } from '../../kernel/legacy-inventory.mjs';
import { prepareTaskCaptureRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.task-capture';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'task-capture.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Task Capture fixture execution requires the exact contained preparation scenario.');
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function factValue(preview, factId) {
  return preview.facts.find((fact) => fact.id === factId)?.value;
}

function observedEffectModes(envelope, expected) {
  return Object.fromEntries(Object.keys(expected).sort().map((effect) => [
    effect,
    envelope.effectPolicies[effect]?.mode || 'unknown'
  ]));
}

function factsFor({ lock, input, envelope, snapshot, preview, sourceCaseArtifacts }) {
  const policyEntry = snapshot.entries.find((entry) => entry.id === 'context.task-capture.policy');
  const projectEntry = snapshot.entries.find((entry) => entry.id === 'context.task-capture.project');
  const identityEntry = snapshot.entries.find((entry) => entry.id === 'context.task-capture.identity');
  const duplicateEntry = snapshot.entries.find((entry) => entry.id === 'context.task-capture.duplicates');
  if (!policyEntry || !projectEntry || !identityEntry || !duplicateEntry) {
    throw new Error(
      'Task Capture scenario requires exact policy, project, current-user identity, and duplicate context entries.'
    );
  }
  const policyRecords = policyEntry.value.records?.filter((record) => {
    return record.type === 'task-work-policy';
  }) || [];
  const projectRecord = exactRequestedContextRecord(projectEntry.value, {
    recordType: 'project',
    requestedId: input.project
  });
  const change = preview.proposedChanges[0];
  const reviewRow = preview.collections[0]?.rows[0];
  const reviewAction = reviewRow?.actions[0];
  const serializedSanitized = JSON.stringify({ envelope, snapshot, preview });
  const boundaryHeld = envelope.lifecycleState === 'paused'
    && envelope.approvals.length === 0
    && envelope.effects.every((effect) => !effect.declaredEffects.includes('write'))
    && preview.proposedChanges.length === 1;
  const sourceCasesFingerprinted = sourceCaseArtifacts.length > 0
    && sourceCaseArtifacts.every((artifact) => {
      return artifact.role === 'source-case'
        && /^sha256:[a-f0-9]{64}$/.test(artifact.fingerprint);
    });
  const exactProjectResolved = factValue(preview, 'project-identity') === projectRecord.id;
  const titleSanitized = !serializedSanitized.includes(input.title)
    && !serializedSanitized.includes(input.assignee)
    && !serializedSanitized.includes(input.nextActionOn);
  const datePinned = /^\d{4}-\d{2}-\d{2}$/.test(input.nextActionOn)
    && factValue(preview, 'next-action-pinned') === true;

  return {
    outcomes: {
      'task-policy.grounded': policyRecords.length === 1
        && policyRecords[0].fields.createRequiresConfirmation === true
        && policyRecords[0].fields.defaultStatus === 'To Do',
      'project.exactly-resolved': exactProjectResolved,
      'duplicates.bounded': duplicateEntry.value.candidateCount === 0
        && duplicateEntry.value.candidateIds.length === 0
        && factValue(preview, 'duplicate-candidate-count') === 0,
      'task-create.previewed': preview.kind === 'task-capture-preview'
        && preview.proposedChanges.length === 1
        && preview.privateReview.state === 'available'
        && preview.collections.length === 1
        && reviewAction?.kind === 'task-create'
        && reviewAction?.state === 'proposed'
        && reviewAction?.capability === 'tasks.records.create'
        && reviewAction?.changeFingerprint === fingerprintJson(change)
        && reviewRow?.privateDetailFingerprint === change.afterFingerprint
        && change.effect === 'tasks.records.create'
        && change.beforeFingerprint === null
        && /^sha256:[a-f0-9]{64}$/.test(change.afterFingerprint),
      'writes-held-for-separate-authority': boundaryHeld
    },
    invariants: {
      'private-title-excluded-from-inspection': titleSanitized,
      'calendar-date-pinned': datePinned,
      'relations-never-fabricated': exactProjectResolved
        && input.assignee === 'self'
        && identityEntry.value?.identity?.kind === 'current-user'
        && /^provider-person\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(
          identityEntry.value?.identity?.providerPersonId || ''
        )
        && factValue(preview, 'assignee-reference-bound') === true,
      'deduplicate-before-create': envelope.effects.length === 4
        && envelope.effects[3].capability === 'tasks.records.read'
        && duplicateEntry.value.providerOutputFingerprint === envelope.effects[3].outputFingerprint,
      'no-write-or-approval-during-preparation': boundaryHeld
    },
    evidence: {
      'exact-lock': envelope.configurationLock.fingerprint === fingerprintLock(lock)
        && envelope.graphFingerprint === lock.graphFingerprint,
      'policy-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(policyEntry.valueFingerprint),
      'project-read-fingerprint': /^sha256:[a-f0-9]{64}$/.test(projectEntry.valueFingerprint),
      'duplicate-query-fingerprint': /^sha256:[a-f0-9]{64}$/.test(duplicateEntry.valueFingerprint)
        && /^sha256:[a-f0-9]{64}$/.test(duplicateEntry.value.providerOutputFingerprint),
      'private-title-sanitized': titleSanitized,
      'write-boundary-state': boundaryHeld
        && envelope.effectPolicies.write.mode === 'confirm'
        && envelope.effectPolicies.dispatch.mode === 'prohibit',
      'source-cases-exactly-fingerprinted': sourceCasesFingerprinted
    }
  };
}

function assessmentFor({ scenario, envelope, facts, artifacts }) {
  const observedCapabilities = envelope.effects.map((effect) => effect.capability);
  const observedModes = observedEffectModes(envelope, scenario.expected.effectModes);
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
    && checks.every((item) => item.state === 'passed')
    ? 'passed' : 'failed';
  return {
    result,
    capabilityOrder,
    effectModes,
    checks,
    artifacts,
    observationFingerprint: fingerprintJson({ capabilityOrder, effectModes, checks })
  };
}

export async function runContainedTaskCaptureScenario({
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
    title: 'Fix the Notion push retry logic so failed writes do not get lost',
    project: 'soter-fixture://projects/project/launch',
    assignee: 'self',
    nextActionOn: '2026-07-24',
    context: 'Project'
  };
  const execution = await prepareTaskCaptureRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId,
    scenarioPath: loaded.path,
    input,
    createdAt
  });
  const facts = factsFor({
    lock,
    input,
    envelope: execution.envelope,
    snapshot: execution.snapshot,
    preview: execution.preview,
    sourceCaseArtifacts
  });
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
        role: 'task-create-preview',
        fingerprint: execution.preview.fingerprint
      }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: execution.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    sourceCaseArtifacts,
    assessment,
    evaluatorId: 'automation.task-capture.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return { ...execution, scenario: loaded.scenario, assessment, scenarioEvidence };
}
