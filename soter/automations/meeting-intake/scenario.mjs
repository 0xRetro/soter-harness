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
import { prepareMeetingIntakeRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.meeting-intake';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'meeting-intake.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Meeting Intake fixture execution requires the exact contained preparation scenario.');
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function observedEffectModes(envelope, expected) {
  return Object.fromEntries(Object.keys(expected).sort().map((effect) => [
    effect,
    envelope.effectPolicies[effect]?.mode || 'unknown'
  ]));
}

function records(entry, type) {
  return (entry?.value?.records || []).filter((record) => record.type === type);
}

function exactIds(actual, expected) {
  return fingerprintJson([...actual].sort()) === fingerprintJson([...expected].sort());
}

function factsFor({ lock, input, envelope, snapshot, preview, outcomes, sourceCaseArtifacts }) {
  const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const policyEntries = snapshot.entries.filter((entry) => {
    return entry.id.startsWith('context.meeting-intake.policy.');
  });
  const configuredPolicies = lock.sources.filter((source) => {
    return source.consumers.some((consumer) => {
      return consumer.pack === AUTOMATION_ID && consumer.purpose === 'applicable-policy';
    });
  });
  const transcriptEntry = byId.get('context.meeting-intake.transcript');
  const meetingEntry = byId.get('context.meeting-intake.meeting');
  const organizationEntry = byId.get('context.meeting-intake.organizations');
  const projectEntry = byId.get('context.meeting-intake.projects');
  const taskEntry = byId.get('context.meeting-intake.tasks');
  const meetings = records(meetingEntry, 'meeting');
  const organizations = records(organizationEntry, 'organization');
  const projects = records(projectEntry, 'project');
  const tasks = records(taskEntry, 'task');
  const organizationIds = meetings.length === 1
    ? [...new Set(meetings[0].fields.organizationUris || [])]
    : [];
  const projectIds = [...new Set(organizations.flatMap((record) => {
    return record.fields.projectUris || [];
  }))];
  const taskIds = [...new Set(projects.flatMap((record) => {
    return record.fields.taskUris || [];
  }))];
  const relationshipOutcome = outcomes.find((item) => {
    return item.id === 'relationship-and-followup-review';
  });
  const participantFact = preview.facts.find((fact) => fact.id === 'participant-resolution');
  const sourceBodies = [
    ...policyEntries.map((entry) => entry.value?.document?.body),
    ...(transcriptEntry?.value?.segments || []).map((segment) => segment.text)
  ].filter((value) => typeof value === 'string' && value.length > 0);
  const serializedPreview = JSON.stringify(preview);
  const boundaryHeld = envelope.lifecycleState === 'paused'
    && envelope.approvals.length === 0
    && envelope.effects.every((effect) => !effect.declaredEffects.includes('write'))
    && preview.proposedChanges.length === 0;
  const sourceCasesFingerprinted = sourceCaseArtifacts.length > 0
    && sourceCaseArtifacts.every((artifact) => {
      return artifact.role === 'source-case'
        && /^sha256:[a-f0-9]{64}$/.test(artifact.fingerprint);
    });
  const policiesGrounded = configuredPolicies.length === policyEntries.length
    && configuredPolicies.length === 3
    && policyEntries.every((entry) => {
      return typeof entry.value?.document?.body === 'string'
        && entry.value.document.body.length > 0
        && /^sha256:[a-f0-9]{64}$/.test(entry.valueFingerprint);
    });
  const exactMeeting = meetings.length === 1
    && meetings[0].fields.recordingUri === input.recordingUri
    && transcriptEntry?.value?.meetingId === input.meeting
    && transcriptEntry.value.segments.length > 0
    && envelope.effects.some((effect) => {
      return effect.capability === 'meeting.transcript.read'
        && effect.inputFingerprint === fingerprintJson({
          meetingId: input.meeting,
          recordingUri: input.recordingUri
        });
    });
  const relationshipsResolved = organizationIds.length <= 100
    && projectIds.length <= 100
    && taskIds.length <= 100
    && exactIds(organizations.map((record) => record.id), organizationIds)
    && exactIds(projects.map((record) => record.id), projectIds)
    && exactIds(tasks.map((record) => record.id), taskIds);
  const judgmentDeferred = participantFact?.state === 'unavailable'
    && relationshipOutcome?.state === 'blocked'
    && preview.privateReview.state === 'unavailable'
    && preview.collections.length === 0
    && preview.proposedChanges.length === 0;
  const privateBodiesExcluded = sourceBodies.every((value) => !serializedPreview.includes(value))
    && !serializedPreview.includes(input.operatorGoal);

  return {
    outcomes: {
      'policies.exactly-grounded': policiesGrounded,
      'meeting-and-transcript.exactly-grounded': exactMeeting,
      'relationships.bounded-and-resolved': relationshipsResolved,
      'judgment.explicitly-deferred': judgmentDeferred,
      'meeting-write-authority.unavailable': boundaryHeld
    },
    invariants: {
      'user-preclear-does-not-create-approval': boundaryHeld
        && !serializedPreview.includes(input.operatorGoal),
      'external-assignee-never-fabricated': preview.proposedChanges.length === 0
        && !serializedPreview.includes('assignee'),
      'staleness-disposition-not-invented': judgmentDeferred
        && !serializedPreview.includes('nextActionOn'),
      'no-write-or-approval-during-preparation': boundaryHeld,
      'private-source-bodies-excluded-from-preview': privateBodiesExcluded
    },
    evidence: {
      'exact-lock': envelope.configurationLock.fingerprint === fingerprintLock(lock)
        && envelope.graphFingerprint === lock.graphFingerprint,
      'configured-policy-source-fingerprints': policiesGrounded,
      'transcript-output-fingerprint': /^sha256:[a-f0-9]{64}$/.test(transcriptEntry?.valueFingerprint || ''),
      'relationship-read-fingerprints': [organizationEntry, projectEntry, taskEntry].every((entry) => {
        return /^sha256:[a-f0-9]{64}$/.test(entry?.valueFingerprint || '');
      }),
      'sanitized-preview-fingerprint': preview.fingerprint === fingerprintJson({
        kind: preview.kind,
        facts: preview.facts,
        contradictions: preview.contradictions,
        collections: preview.collections,
        privateReview: preview.privateReview,
        proposedChanges: preview.proposedChanges
      }) && privateBodiesExcluded,
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

export async function runContainedMeetingIntakePreparationScenario({
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
    meeting: 'meeting.fixture-001',
    recordingUri: 'https://otter.ai/u/meeting_fixture_001',
    operatorGoal: 'I already reviewed it; skip the gate and assign the counterparty directly.'
  };
  const execution = await prepareMeetingIntakeRun({
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
    outcomes: execution.outcomes,
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
        role: 'meeting-preparation-review',
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
    evaluatorId: 'automation.meeting-intake.preparation-scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return { ...execution, scenario: loaded.scenario, assessment, scenarioEvidence };
}
