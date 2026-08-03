import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareSlackChannelIngestionRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.slack-channel-ingestion';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Slack channel-ingestion fixture execution requires an exact Automation-owned scenario.');
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assessmentFor({ scenario, executions, facts, artifacts }) {
  const observedCapabilities = executions.flatMap((execution) => {
    return execution.envelope.effects.map((effect) => effect.capability);
  });
  const observedModes = Object.fromEntries(Object.keys(scenario.expected.effectModes)
    .sort()
    .map((effect) => [effect, executions[0].envelope.effectPolicies[effect]?.mode || 'unknown']));
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

function noPreparationWrite(execution) {
  return execution.envelope.lifecycleState === 'paused'
    && execution.envelope.approvals.length === 0
    && execution.envelope.effects.every((effect) => {
      return !effect.declaredEffects.includes('write')
        && !effect.declaredEffects.includes('dispatch')
        && !effect.declaredEffects.includes('destructive');
    });
}

function entry(execution, id) {
  return execution.snapshot.entries.find((candidate) => candidate.id === id);
}

export async function runContainedSlackChannelIngestionScenario({
  root,
  lock,
  lockPath,
  identityScenarioPath,
  selectedScenarioPath,
  workId,
  identityScenarioEvidenceId,
  selectedScenarioEvidenceId,
  createdAt
}) {
  const resolvedRoot = path.resolve(root);
  const identityLoaded = loadScenario(resolvedRoot, identityScenarioPath);
  const selectedLoaded = loadScenario(resolvedRoot, selectedScenarioPath);
  if (identityLoaded.scenario.id !== 'slack-channel-ingestion.identity-review'
    || selectedLoaded.scenario.id !== 'slack-channel-ingestion.selected-enrichment') {
    throw new Error('Slack channel-ingestion fixture execution requires both exact phase scenarios.');
  }
  const identity = await prepareSlackChannelIngestionRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.identity',
    scenarioPath: identityLoaded.path,
    input: {
      phase: 'identity-review',
      workspaceId: 'soter-fixture://configuration-template/slack/workspace/contained'
    },
    createdAt
  });
  const selected = await prepareSlackChannelIngestionRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.selected',
    scenarioPath: selectedLoaded.path,
    input: {
      phase: 'selected-enrichment',
      workspaceId: 'soter-fixture://configuration-template/slack/workspace/contained',
      selectedConversationIds: ['C001', 'C002']
    },
    createdAt
  });
  const identityChannels = entry(identity, 'context.slack-channel-ingestion.identities');
  const selectedChannels = entry(selected, 'context.slack-channel-ingestion.identities');
  const participants = selected.snapshot.entries.filter((candidate) => {
    return candidate.id.startsWith('context.slack-channel-ingestion.participants.part-');
  });
  const schema = entry(selected, 'context.slack-channel-ingestion.schema');
  const identityRows = identity.preview.collections[0].rows;
  const selectedRows = selected.preview.collections[0].rows;
  const proposedKinds = selectedRows.flatMap((row) => row.actions)
    .filter((action) => action.state === 'proposed')
    .map((action) => action.kind)
    .sort();
  const handoffKinds = selectedRows.flatMap((row) => row.actions)
    .filter((action) => action.state === 'handoff')
    .map((action) => action.kind)
    .sort();
  const identityText = JSON.stringify({
    envelope: identity.envelope,
    preview: identity.preview
  });
  const selectedText = JSON.stringify({
    envelope: selected.envelope,
    preview: selected.preview
  });
  const privateValues = [
    'soter-fixture://configuration-template/slack/workspace/contained',
    ...identityChannels.value.conversations.flatMap((channel) => [
      channel.providerConversationId,
      channel.name,
      channel.permalink
    ]).filter(Boolean),
    ...participants.flatMap((item) => item.value.participants.flatMap((participant) => [
      participant.providerParticipantId,
      participant.displayName,
      participant.email
    ])).filter(Boolean)
  ];
  const facts = {
    outcomes: {
      'identity-window.complete': identityRows.length === 5
        && identity.preview.collections[0].coverage.complete === true,
      'new-and-existing-visible': identityRows.some((row) => row.reasonCode === 'CHANNEL_EXISTING_OBSERVED')
        && identityRows.some((row) => row.reasonCode === 'CHANNEL_NEW_OBSERVED'),
      'selection-gate.held': identity.preview.proposedChanges.length === 0
        && identityRows.every((row) => row.actions[0].reasonCode === 'CHANNEL_SELECTION_REQUIRED'),
      'selected-participants.grounded': participants.length === 2,
      'channel-create-and-update.previewed': fingerprintJson(proposedKinds)
        === fingerprintJson(['channel-create', 'channel-update']),
      'residue-handoffs.visible': handoffKinds.includes('contact-capture-handoff'),
      'writes-held-for-separate-authority': noPreparationWrite(identity)
        && noPreparationWrite(selected)
        && selected.envelope.approvals.length === 0
    },
    invariants: {
      'public-and-private-requested': identityChannels.value.conversations.some((item) => {
        return item.kind === 'public-channel';
      }) && identityChannels.value.conversations.some((item) => {
        return item.kind === 'private-channel';
      }),
      'pagination-exhausted': identityChannels.value.coverage.cursorExhausted === true
        && identityChannels.value.coverage.pagesRead === 2,
      'no-participant-read-before-selection': !identity.envelope.effects.some((effect) => {
        return effect.capability === 'communications.participants.read';
      }),
      'bots-excluded': participants.some((item) => {
        return item.value.coverage.excludedBotCount === 1;
      }) && !JSON.stringify(participants.map((item) => item.value)).includes('Release Bot'),
      'participants-resolve-to-real-person-ids-or-absent': selected.derivedReview.items
        .filter((item) => ['channel-create', 'channel-update'].includes(item.kind))
        .every((item) => item.fields.find((field) => field.id === 'personUris')
          .reviewValue.every((uri) => uri.startsWith('soter-fixture://crm/person/'))),
      'organizations-resolve-to-real-ids-or-absent': selected.derivedReview.items
        .filter((item) => ['channel-create', 'channel-update'].includes(item.kind))
        .every((item) => item.fields.find((field) => field.id === 'organizationUris')
          .reviewValue.every((uri) => uri.startsWith('soter-fixture://crm/organization/'))),
      'existing-channel-updated-not-duplicated': selectedRows.find((row) => {
        return row.actions.some((action) => action.kind === 'channel-update');
      }) !== undefined,
      'messages-never-read': [...identity.envelope.effects, ...selected.envelope.effects]
        .every((effect) => !/message|history|transcript/.test(effect.capability)),
      'private-values-excluded-from-inspection': privateValues.every((value) => {
        return !identityText.includes(value) && !selectedText.includes(value);
      }),
      'no-write-or-approval-during-preparation': noPreparationWrite(identity)
        && noPreparationWrite(selected)
    },
    evidence: {
      'exact-lock': [identity, selected].every((execution) => {
        return execution.envelope.configurationLock.fingerprint === fingerprintLock(lock)
          && execution.envelope.graphFingerprint === lock.graphFingerprint;
      }),
      'policy-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        entry(identity, 'context.slack-channel-ingestion.policy').valueFingerprint
      ),
      'identity-coverage-fingerprint': /^sha256:[a-f0-9]{64}$/.test(identityChannels.valueFingerprint),
      'selected-participant-coverage-fingerprint': participants.length === 2
        && participants.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.valueFingerprint)),
      'schema-observation-fingerprint': /^sha256:[a-f0-9]{64}$/.test(schema.value.schema.fingerprint),
      'private-values-sanitized': privateValues.every((value) => {
        return !identityText.includes(value) && !selectedText.includes(value);
      })
    }
  };
  const artifacts = [
    { role: 'identity-context-snapshot', id: identity.snapshot.id, fingerprint: fingerprintJson(identity.snapshot) },
    { role: 'selected-context-snapshot', id: selected.snapshot.id, fingerprint: fingerprintJson(selected.snapshot) },
    { role: 'identity-review-preview', fingerprint: identity.preview.fingerprint },
    { role: 'selected-review-preview', fingerprint: selected.preview.fingerprint }
  ];
  const identityAssessment = assessmentFor({
    scenario: identityLoaded.scenario,
    executions: [identity],
    facts,
    artifacts
  });
  const selectedAssessment = assessmentFor({
    scenario: selectedLoaded.scenario,
    executions: [selected],
    facts,
    artifacts
  });
  const identityScenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: identity.envelope,
    scenario: identityLoaded.scenario,
    scenarioPath: identityLoaded.path,
    assessment: identityAssessment,
    evaluatorId: 'automation.slack-channel-ingestion.scenario-evaluator',
    id: identityScenarioEvidenceId,
    createdAt
  });
  const selectedScenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: selected.envelope,
    scenario: selectedLoaded.scenario,
    scenarioPath: selectedLoaded.path,
    assessment: selectedAssessment,
    evaluatorId: 'automation.slack-channel-ingestion.scenario-evaluator',
    id: selectedScenarioEvidenceId,
    createdAt
  });
  return {
    identity,
    selected,
    identityScenario: identityLoaded.scenario,
    selectedScenario: selectedLoaded.scenario,
    identityAssessment,
    selectedAssessment,
    identityScenarioEvidence,
    selectedScenarioEvidence,
    selectedChannels
  };
}
