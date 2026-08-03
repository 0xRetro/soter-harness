import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareDriveFilingRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.filing-a-drive-artifact';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'filing-a-drive-artifact.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Drive Filing fixture execution requires the exact preparation scenario.');
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function reviewFields(derivedReview, kind) {
  const item = derivedReview.items.find((candidate) => candidate.kind === kind);
  if (!item) throw new Error('Drive Filing derived review omitted ' + kind + '.');
  return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
}

function row(execution, id) {
  const match = execution.preview.collections[0]?.rows.find((candidate) => candidate.id === id);
  if (!match) throw new Error('Drive Filing preview omitted ' + id + '.');
  return match;
}

function noPreparationAuthority(execution) {
  return execution.envelope.lifecycleState === 'paused'
    && execution.envelope.approvals.length === 0
    && execution.envelope.effects.every((effect) => {
      return !effect.declaredEffects.includes('write')
        && !effect.declaredEffects.includes('destructive')
        && !effect.declaredEffects.includes('dispatch');
    });
}

function factsFor({ lock, happy, ambiguous, urgent, inputs }) {
  const happyPlacement = row(happy, 'row.drive-filing.placement');
  const happyIndex = row(happy, 'row.drive-filing.document-index');
  const ambiguousPlacement = row(ambiguous, 'row.drive-filing.placement');
  const ambiguousIndex = row(ambiguous, 'row.drive-filing.document-index');
  const urgentPlacement = row(urgent, 'row.drive-filing.placement');
  const urgentIndex = row(urgent, 'row.drive-filing.document-index');
  const happyStorage = reviewFields(happy.derivedReview, 'storage-placement');
  const happyDocument = reviewFields(happy.derivedReview, 'document-index-create');
  const ambiguousStorage = reviewFields(ambiguous.derivedReview, 'storage-placement');
  const urgentStorage = reviewFields(urgent.derivedReview, 'storage-placement');
  const happyArtifact = happy.snapshot.entries.find((entry) => {
    return entry.id === 'context.drive-filing.artifact';
  });
  const happyRegistry = happy.snapshot.entries.find((entry) => {
    return entry.id === 'context.drive-filing.registry';
  });
  const happySchema = happy.snapshot.entries.find((entry) => {
    return entry.id === 'context.drive-filing.document-schema';
  });
  const happyDuplicates = happy.snapshot.entries.find((entry) => {
    return entry.id === 'context.drive-filing.document-candidates';
  });
  if (!happyArtifact || !happyRegistry || !happySchema || !happyDuplicates) {
    throw new Error('Drive Filing scenario omitted a required grounded observation.');
  }

  const serializedSanitized = JSON.stringify({
    envelopes: [happy.envelope, ambiguous.envelope, urgent.envelope],
    previews: [happy.preview, ambiguous.preview, urgent.preview]
  });
  const privateValuesSanitized = Object.values(inputs).flatMap((input) => [
    input.artifactUri,
    input.subjectKey,
    input.placementReason,
    input.description,
    ...(input.alternativeSubjectKeys || [])
  ]).filter(Boolean).every((value) => !serializedSanitized.includes(value));

  const happyPlacementAction = happyPlacement.actions[0];
  const happyIndexAction = happyIndex.actions[0];
  const happyPlacementChange = happy.preview.proposedChanges.find((change) => {
    return change.id === happyPlacementAction.id;
  });
  const happyIndexChange = happy.preview.proposedChanges.find((change) => {
    return change.id === happyIndexAction.id;
  });
  const happyComplete = happy.preview.proposedChanges.length === 2
    && happyPlacementAction.state === 'proposed'
    && happyPlacementAction.capability === 'storage.shortcuts.create'
    && happyPlacementAction.effect === 'write'
    && happyPlacementAction.changeFingerprint === fingerprintJson(happyPlacementChange)
    && happyIndexAction.state === 'proposed'
    && happyIndexAction.capability === 'documents.records.create'
    && happyIndexAction.effect === 'write'
    && happyIndexAction.changeFingerprint === fingerprintJson(happyIndexChange)
    && happyPlacement.privateDetailFingerprint === happyPlacementChange.afterFingerprint
    && happyIndex.privateDetailFingerprint === happyIndexChange.afterFingerprint;
  const ambiguousFlags = ambiguousPlacement.flags;
  const urgentFlags = urgentPlacement.flags;
  const allHeld = [ambiguous, urgent].every((execution) => {
    return execution.preview.proposedChanges.length === 0
      && execution.preview.collections[0].rows.every((candidate) => {
        return candidate.actions.every((action) => action.state !== 'proposed');
      });
  });
  const noAuthority = [happy, ambiguous, urgent].every(noPreparationAuthority);

  return {
    outcomes: {
      'storage-policy.grounded': happyRegistry.value.registry.policy.movesHumanOnly === true
        && happyRegistry.value.registry.policy.renameAllowed === false
        && happyRegistry.value.registry.policy.deleteAllowed === false,
      'artifact-metadata.grounded': happyArtifact.value.artifact.uri === inputs.happy.artifactUri
        && !Object.hasOwn(happyArtifact.value.artifact, 'content')
        && !Object.hasOwn(happyArtifact.value.artifact, 'body'),
      'registered-home.selected-or-inbox': happyStorage.get('destinationKey') === 'home.research'
        && ambiguousStorage.get('destinationKey') === 'home.inbox'
        && ambiguousFlags.includes('DRIVE_HOME_PROVISIONAL_INBOX'),
      'external-artifact.shortcut-form': happyComplete
        && happyStorage.get('form') === 'shortcut',
      'existing-artifact.human-move-only': urgentPlacement.actions[0].kind === 'storage-move'
        && urgentPlacement.actions[0].state === 'handoff'
        && urgentPlacement.actions[0].capability === null
        && urgentFlags.includes('DRIVE_EXISTING_ARTIFACT_REQUIRES_HUMAN_MOVE')
        && urgentStorage.get('form') === 'human-move'
        && urgentStorage.get('humanMoveInstruction').length === 1
        && urgentStorage.get('humanMoveInstruction')[0]
          .includes('Do not copy, rename, or delete it.'),
      'document-index.complete-or-held': happyComplete
        && exactArray(happyDocument.get('documentType'), ['Research'])
        && exactArray(happyDocument.get('categories'), ['Research'])
        && ambiguousIndex.actions[0].state === 'held'
        && urgentIndex.actions[0].state === 'held',
      'writes-held-for-separate-authority': noAuthority
    },
    invariants: {
      'retention-remains-human-owned': [happy, ambiguous, urgent].every((execution) => {
        return execution.envelope.effects.every((effect) => {
          return !['storage.files.delete', 'storage.files.trash'].includes(effect.capability);
        });
      }),
      'folders-never-invented': happyStorage.get('destinationKey') === 'home.research'
        && ambiguousStorage.get('destinationKey') === 'home.inbox'
        && ambiguousFlags.includes('DRIVE_HOME_PROVISIONAL_INBOX'),
      'copy-never-simulates-move': urgentPlacement.actions[0].capability === null
        && urgent.preview.proposedChanges.length === 0,
      'move-rename-delete-never-automated': [happy, ambiguous, urgent].every((execution) => {
        return execution.envelope.effects.every((effect) => {
          return !/(move|rename|delete|trash)/.test(effect.capability);
        });
      }),
      'index-requirement-not-silently-dropped': urgentFlags.includes(
        'DRIVE_REQUIRED_INDEX_SKIP_REQUESTED'
      ) && urgentIndex.actions[0].state === 'held',
      'relations-and-options-never-invented': exactArray(
        happyDocument.get('ownerIds'),
        ['provider-person.maya']
      ) && exactArray(
        happyDocument.get('organizationUris'),
        ['soter-fixture://crm/organization/acme']
      ) && happySchema.value.schema.fields.some((field) => {
        return field.id === 'documentType' && field.options.includes('Research');
      }),
      'artifact-content-never-loaded': [happy, ambiguous, urgent].every((execution) => {
        const entry = execution.snapshot.entries.find((candidate) => {
          return candidate.id === 'context.drive-filing.artifact';
        });
        return entry && !Object.hasOwn(entry.value.artifact, 'content')
          && !Object.hasOwn(entry.value.artifact, 'body');
      }),
      'no-write-or-approval-during-preparation': noAuthority && allHeld
        && happy.preview.proposedChanges.length === 2
    },
    evidence: {
      'exact-lock': [happy, ambiguous, urgent].every((execution) => {
        return execution.envelope.configurationLock.fingerprint === fingerprintLock(lock)
          && execution.envelope.graphFingerprint === lock.graphFingerprint;
      }),
      'storage-registry-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        happyRegistry.value.registry.fingerprint
      ),
      'artifact-metadata-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        happyArtifact.value.artifact.fingerprint
      ),
      'document-schema-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        happySchema.value.schema.fingerprint
      ),
      'duplicate-query-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        happyDuplicates.value.providerOutputFingerprint
      ) && happyDuplicates.value.candidateCount === 0,
      'private-values-sanitized': privateValuesSanitized
    }
  };
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
    && checks.every((item) => item.state === 'passed')
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

export async function runContainedDriveFilingScenario({
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
      artifactUri: 'soter-fixture://storage/artifact/external-research',
      retentionDecision: 'keep',
      subjectKey: 'research',
      placementReason: 'The memo is retained research material for the analysis library.',
      alternativeSubjectKeys: ['prime'],
      frozenSnapshot: false,
      owner: 'self',
      organization: 'soter-fixture://crm/organization/acme',
      documentType: 'Research',
      description: 'External research memo retained for the current analysis program.',
      skipIndexRequested: false
    },
    ambiguous: {
      artifactUri: 'soter-fixture://storage/artifact/ambiguous-root',
      retentionDecision: 'keep',
      placementReason: 'No defensible registered subject home is known yet.',
      alternativeSubjectKeys: [],
      frozenSnapshot: false,
      description: 'Operating numbers awaiting a human filing and indexing decision.',
      skipIndexRequested: false
    },
    urgent: {
      artifactUri: 'soter-fixture://storage/artifact/urgent-shortcut',
      retentionDecision: 'keep',
      subjectKey: 'prime',
      placementReason: 'The existing shortcut belongs with the Prime workstream.',
      alternativeSubjectKeys: [],
      frozenSnapshot: false,
      owner: 'self',
      organization: 'soter-fixture://crm/organization/acme',
      documentType: 'Reference',
      description: 'Existing Prime pipeline shortcut requiring a human move and index review.',
      skipIndexRequested: true
    }
  };
  const happy = await prepareDriveFilingRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId,
    scenarioPath: loaded.path,
    input: inputs.happy,
    createdAt
  });
  const ambiguous = await prepareDriveFilingRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.ambiguous',
    scenarioPath: loaded.path,
    input: inputs.ambiguous,
    createdAt
  });
  const urgent = await prepareDriveFilingRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId: workId + '.urgent',
    scenarioPath: loaded.path,
    input: inputs.urgent,
    createdAt
  });
  const facts = factsFor({
    lock,
    happy,
    ambiguous,
    urgent,
    inputs
  });
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: happy.envelope,
    facts,
    artifacts: [
      { role: 'context-snapshot', id: happy.snapshot.id, fingerprint: fingerprintJson(happy.snapshot) },
      { role: 'drive-filing-preview', fingerprint: happy.preview.fingerprint },
      { role: 'ambiguous-home-preview', fingerprint: ambiguous.preview.fingerprint },
      { role: 'urgent-human-move-preview', fingerprint: urgent.preview.fingerprint }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: happy.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    assessment,
    evaluatorId: 'automation.filing-a-drive-artifact.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return {
    ...happy,
    scenario: loaded.scenario,
    assessment,
    scenarioEvidence,
    variants: { ambiguous, urgent }
  };
}
