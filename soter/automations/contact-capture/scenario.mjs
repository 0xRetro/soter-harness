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
import { prepareContactCaptureRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.contact-capture';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'contact-capture.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error(
      'Contact Capture fixture execution requires the exact preparation scenario.'
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

function factsFor({ lock, input, envelope, snapshot, preview, derivedReview, sourceCaseArtifacts }) {
  const policyEntry = snapshot.entries.find((entry) => {
    return entry.id === 'context.contact-capture.policy';
  });
  const schemaEntry = snapshot.entries.find((entry) => {
    return entry.id === 'context.contact-capture.schema';
  });
  const duplicateEntry = snapshot.entries.find((entry) => {
    return entry.id === 'context.contact-capture.duplicates';
  });
  const organizationEntry = snapshot.entries.find((entry) => {
    return entry.id === 'context.contact-capture.organization';
  });
  if (!policyEntry || !schemaEntry || !duplicateEntry || !organizationEntry) {
    throw new Error(
      'Contact Capture scenario requires exact policy, schema, duplicate, and organization observations.'
    );
  }
  const values = privateFields(derivedReview);
  const schemaFields = new Map(schemaEntry.value.schema.fields.map((field) => [field.id, field]));
  const role = values.get('role');
  const disposition = values.get('disposition');
  const authority = values.get('authority');
  const tags = values.get('tags');
  const organizationUris = values.get('organizationUris');
  const duplicateSearchValues = values.get('duplicateSearchValues');
  const serializedSanitized = JSON.stringify({ envelope, snapshot, preview });
  const privateSentinels = [
    input.name,
    input.email,
    input.organizationName,
    input.role,
    input.disposition,
    input.telegram,
    input.source
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
  const sourceCasesFingerprinted = sourceCaseArtifacts.length === 3
    && sourceCaseArtifacts.every((artifact) => {
      return artifact.role === 'source-case'
        && /^sha256:[a-f0-9]{64}$/.test(artifact.fingerprint);
    });
  const flags = row?.flags || [];
  const noDuplicates = duplicateEntry.value.candidateCount === 0
    && duplicateEntry.value.candidateIds.length === 0;
  const organizationResolved = exactArray(
    organizationUris,
    ['soter-fixture://crm/organization/acme']
  ) && organizationEntry.value.candidateCount === 1;
  const exactOptions = role.length === 0
    && disposition.length === 0
    && exactArray(authority, ['Technical Buyer'])
    && exactArray(tags, ['Priority', 'Prospect'])
    && flags.includes('CONTACT_ROLE_NOT_IN_CURRENT_SCHEMA')
    && flags.includes('CONTACT_DISPOSITION_NOT_IN_CURRENT_SCHEMA')
    && schemaFields.get('role')?.options.includes('Engineering')
    && !schemaFields.get('role')?.options.includes(input.role)
    && schemaFields.get('disposition')?.options.includes('Champion')
    && !schemaFields.get('disposition')?.options.includes(input.disposition);

  return {
    outcomes: {
      'contact-policy.grounded': policyEntry.value.records?.length === 1
        && policyEntry.value.records[0].type === 'contact-capture-policy'
        && policyEntry.value.records[0].fields.name === 'Contacts',
      'contact-schema.grounded': schemaEntry.value.schema.recordType === 'person'
        && /^sha256:[a-f0-9]{64}$/.test(schemaEntry.value.schema.fingerprint)
        && ['role', 'status', 'disposition', 'authority', 'tags'].every((id) => {
          return Array.isArray(schemaFields.get(id)?.options)
            && schemaFields.get(id).options.length > 0;
        }),
      'contact-options.grounded': exactOptions,
      'contact-organization.resolved': organizationResolved,
      'contact-duplicates.cleared': noDuplicates
        && exactArray(duplicateSearchValues, [
          'email:jane@acmedesign.example',
          'name:Jane Rivera'
        ]),
      'contact-create.previewed': preview.kind === 'contact-capture-preview'
        && preview.proposedChanges.length === 1
        && action?.kind === 'contact-create'
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
      'supportive-never-promoted-to-champion': disposition.length === 0
        && flags.includes('CONTACT_DISPOSITION_NOT_IN_CURRENT_SCHEMA'),
      'organization-id-never-fabricated': organizationResolved,
      'deduplicate-before-create': noDuplicates
        && envelope.effects[2]?.capability === 'crm.records.read',
      'no-write-or-approval-during-preparation': boundaryHeld
    },
    evidence: {
      'exact-lock': envelope.configurationLock.fingerprint === fingerprintLock(lock)
        && envelope.graphFingerprint === lock.graphFingerprint,
      'policy-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(policyEntry.valueFingerprint),
      'schema-observation-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        schemaEntry.value.schema.fingerprint
      ),
      'duplicate-query-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        duplicateEntry.value.providerOutputFingerprint
      ),
      'organization-query-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        organizationEntry.value.providerOutputFingerprint
      ),
      'private-values-sanitized': privateValuesSanitized,
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

export async function runContainedContactCaptureScenario({
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
    name: 'Jane Rivera',
    email: 'jane@acmedesign.example',
    organizationName: 'Acme Design',
    role: 'VP of Engineering',
    disposition: 'supportive',
    authority: ['Technical Buyer'],
    tags: ['Prospect', 'Priority'],
    telegram: '@jrivera',
    source: 'Introduced during the Nebula working session.'
  };
  const execution = await prepareContactCaptureRun({
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
    derivedReview: execution.derivedReview,
    sourceCaseArtifacts
  });
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: execution.envelope,
    facts,
    artifacts: [
      { role: 'context-snapshot', id: execution.snapshot.id, fingerprint: fingerprintJson(execution.snapshot) },
      { role: 'contact-create-preview', fingerprint: execution.preview.fingerprint }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: execution.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    sourceCaseArtifacts,
    assessment,
    evaluatorId: 'automation.contact-capture.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return { ...execution, scenario: loaded.scenario, assessment, scenarioEvidence };
}
