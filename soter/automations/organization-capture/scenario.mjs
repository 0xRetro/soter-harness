import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareOrganizationCaptureRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.organization-capture';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'organization-capture.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error(
      'Organization Capture fixture execution requires the exact preparation scenario.'
    );
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function observedEffectModes(envelope, expected) {
  return Object.fromEntries(Object.keys(expected).sort().map((effect) => [
    effect,
    envelope.effectPolicies[effect]?.mode || 'unknown'
  ]));
}

function privateFields(derivedReview) {
  return new Map(derivedReview.items[0].fields.map((field) => [field.id, field.reviewValue]));
}

function factsFor({ lock, input, envelope, snapshot, preview, derivedReview }) {
  const policyEntry = snapshot.entries.find((entry) => {
    return entry.id === 'context.organization-capture.policy';
  });
  const schemaEntry = snapshot.entries.find((entry) => {
    return entry.id === 'context.organization-capture.schema';
  });
  const duplicateEntries = snapshot.entries.filter((entry) => {
    return entry.id.startsWith('context.organization-capture.duplicates.');
  });
  if (!policyEntry || !schemaEntry || duplicateEntries.length !== 3) {
    throw new Error(
      'Organization Capture scenario requires exact policy, schema, and three alias observations.'
    );
  }
  const values = privateFields(derivedReview);
  const typeOptions = schemaEntry.value.schema.fields.find((field) => {
    return field.id === 'organizationType';
  })?.options || [];
  const tagOptions = schemaEntry.value.schema.fields.find((field) => {
    return field.id === 'tags';
  })?.options || [];
  const organizationType = values.get('organizationType');
  const tags = values.get('tags');
  const serializedSanitized = JSON.stringify({ envelope, snapshot, preview });
  const privateSentinels = [
    input.name,
    input.description,
    input.website,
    input.twitter,
    ...input.aliases
  ];
  const privateValuesSanitized = privateSentinels.every((value) => {
    return !serializedSanitized.includes(value);
  });
  const change = preview.proposedChanges[0];
  const row = preview.collections[0]?.rows[0];
  const action = row?.actions[0];
  const boundaryHeld = envelope.lifecycleState === 'paused'
    && envelope.approvals.length === 0
    && envelope.effects.every((effect) => !effect.declaredEffects.includes('write'))
    && preview.proposedChanges.length === 1;
  const noDuplicates = duplicateEntries.every((entry) => {
    return entry.value.candidateCount === 0 && entry.value.candidateIds.length === 0;
  });
  const exactOptions = organizationType.length === 1
    && typeOptions.includes(organizationType[0])
    && tags.every((tag) => tagOptions.includes(tag));
  const proposedFields = {
    name: values.get('name'),
    organizationType: organizationType[0],
    tags,
    website: values.get('website')[0],
    twitter: values.get('twitter')[0]
  };

  return {
    outcomes: {
      'organization-policy.grounded': policyEntry.value.records?.length === 1
        && policyEntry.value.records[0].type === 'organization-capture-policy'
        && policyEntry.value.records[0].fields.name === 'Organizations',
      'organization-schema.grounded': schemaEntry.value.schema.recordType === 'organization'
        && /^sha256:[a-f0-9]{64}$/.test(schemaEntry.value.schema.fingerprint)
        && typeOptions.length > 0
        && tagOptions.length > 0,
      'organization-classification.grounded': organizationType[0] === 'Foundation'
        && exactArray(tags, ['DeFi', 'Priority', 'Prospect']),
      'organization-aliases.deduplicated': exactArray(
        values.get('duplicateSearchNames'),
        ['Nebula Labs', 'Nebula', 'NebulaLabs']
      ) && noDuplicates,
      'organization-create.previewed': preview.kind === 'organization-capture-preview'
        && preview.proposedChanges.length === 1
        && action?.kind === 'organization-create'
        && action?.state === 'proposed'
        && action?.capability === 'crm.records.create'
        && action?.changeFingerprint === fingerprintJson(change)
        && row?.privateDetailFingerprint === change.afterFingerprint
        && change.effect === 'crm.records.create'
        && change.beforeFingerprint === null,
      'writes-held-for-separate-authority': boundaryHeld
    },
    invariants: {
      'private-values-excluded-from-inspection': privateValuesSanitized,
      'options-never-invented': exactOptions,
      'sector-signals-remain-tags': organizationType[0] !== 'DeFi'
        && tags.includes('DeFi'),
      'relations-never-fabricated': !Object.hasOwn(proposedFields, 'projectUris')
        && !Object.hasOwn(proposedFields, 'contactUris'),
      'deduplicate-before-create': noDuplicates
        && envelope.effects.slice(2).every((effect) => {
          return effect.capability === 'crm.records.read';
        }),
      'no-write-or-approval-during-preparation': boundaryHeld
    },
    evidence: {
      'exact-lock': envelope.configurationLock.fingerprint === fingerprintLock(lock)
        && envelope.graphFingerprint === lock.graphFingerprint,
      'policy-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(policyEntry.valueFingerprint),
      'schema-observation-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        schemaEntry.value.schema.fingerprint
      ),
      'duplicate-query-fingerprints': duplicateEntries.every((entry) => {
        return /^sha256:[a-f0-9]{64}$/.test(entry.value.providerOutputFingerprint);
      }),
      'private-values-sanitized': privateValuesSanitized,
      'write-boundary-state': boundaryHeld
        && envelope.effectPolicies.write.mode === 'confirm'
        && envelope.effectPolicies.dispatch.mode === 'prohibit'
    }
  };
}

function assessmentFor({ scenario, envelope, facts, artifacts }) {
  const observedCapabilities = envelope.effects.map((effect) => effect.capability);
  const observedModes = observedEffectModes(envelope, scenario.expected.effectModes);
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

export async function runContainedOrganizationCaptureScenario({
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
    name: 'Nebula Labs',
    description: 'A DeFi foundation building coordination infrastructure.',
    website: 'nebulalabs.io',
    twitter: '@nebulalabs',
    aliases: ['Nebula', 'NebulaLabs'],
    tags: ['Prospect', 'Priority']
  };
  const execution = await prepareOrganizationCaptureRun({
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
    derivedReview: execution.derivedReview
  });
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: execution.envelope,
    facts,
    artifacts: [
      { role: 'context-snapshot', id: execution.snapshot.id, fingerprint: fingerprintJson(execution.snapshot) },
      { role: 'organization-create-preview', fingerprint: execution.preview.fingerprint }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: execution.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    assessment,
    evaluatorId: 'automation.organization-capture.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return { ...execution, scenario: loaded.scenario, assessment, scenarioEvidence };
}
