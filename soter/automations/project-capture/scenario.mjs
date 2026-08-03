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
import { prepareProjectCaptureRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.project-capture';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'project-capture.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Project Capture fixture execution requires the exact contained preparation scenario.');
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

function factsFor({
  lock,
  input,
  envelope,
  snapshot,
  preview,
  derivedReview
}) {
  const policyEntry = snapshot.entries.find((entry) => entry.id === 'context.project-capture.policy');
  const profileEntry = snapshot.entries.find((entry) => entry.id === 'context.project-capture.profile');
  const schemaEntry = snapshot.entries.find((entry) => entry.id === 'context.project-capture.schema');
  const organizationEntry = snapshot.entries.find((entry) => entry.id === 'context.project-capture.organization');
  const duplicateEntry = snapshot.entries.find((entry) => entry.id === 'context.project-capture.duplicates');
  if (!policyEntry || !profileEntry || !schemaEntry || !organizationEntry || !duplicateEntry) {
    throw new Error(
      'Project Capture scenario requires exact policy, profile, schema, organization, and duplicate Context entries.'
    );
  }
  const policyRecords = policyEntry.value.records?.filter((record) => {
    return record.type === 'project-capture-policy';
  }) || [];
  const reviewRow = preview.collections[0]?.rows[0];
  const reviewAction = reviewRow?.actions[0];
  const projectItem = derivedReview.items.find((item) => item.kind === 'project-create');
  const privateFields = new Map(projectItem?.fields.map((field) => [field.id, field.reviewValue]));
  const privateBody = privateFields.get('body');
  const privateMilestones = privateFields.get('milestoneLines');
  const privateWorkItems = privateFields.get('workItemLines');
  const serializedSanitized = JSON.stringify({ envelope, snapshot, preview });
  const privateValues = [
    input.name,
    input.organizationShortName,
    input.overview,
    ...input.milestoneTitles,
    ...input.milestoneDescriptions,
    ...input.milestoneOwners,
    ...input.milestoneActions,
    ...input.milestoneDates,
    input.startDate,
    input.targetEndDate
  ];
  const privateMaterialSanitized = privateValues.every((value) => {
    return !serializedSanitized.includes(value);
  });
  const milestoneGrammarExact = typeof privateBody === 'string'
    && Array.isArray(privateMilestones)
    && Array.isArray(privateWorkItems)
    && privateMilestones.length === input.milestoneTitles.length
    && privateWorkItems.length === input.milestoneTitles.length
    && privateMilestones.every((line) => {
      return /^- \[ \] \*\*.+ - \*\*\*.+\*$/.test(line)
        && privateBody.split(line).length === 2;
    })
    && privateWorkItems.every((line) => {
      return /^\t- \[ \] (?:@[0-9]{4}-[0-9]{2}-[0-9]{2} - )?[^,]+ - .+$/.test(line)
        && privateBody.split(line).length === 2;
    });
  const preparationGrantsNoWriteAuthority = envelope.lifecycleState === 'paused'
    && envelope.approvals.length === 0
    && envelope.effects.every((effect) => !effect.declaredEffects.includes('write'));
  const organizationRecord = exactRequestedContextRecord(organizationEntry.value, {
    recordType: 'organization',
    requestedId: input.organization
  });
  const exactOrganizationResolved =
    factValue(preview, 'organization-identity') === organizationRecord.id;
  const datePinned = /^\d{4}-\d{2}-\d{2}$/.test(input.startDate)
    && /^\d{4}-\d{2}-\d{2}$/.test(input.targetEndDate)
    && input.startDate <= input.targetEndDate
    && factValue(preview, 'calendar-range-pinned') === true;

  return {
    outcomes: {
      'project-policy.grounded': policyRecords.length === 1
        && policyRecords[0].fields.name === 'Projects',
      'project-profile.grounded': profileEntry.value.records?.length === 2
        && factValue(preview, 'creation-profile') === input.creationProfile,
      'project-schema.observed': schemaEntry.value.schema?.recordType === 'project'
        && schemaEntry.value.schema.fields.some((field) => {
          return field.id === 'projectType'
            && field.options.includes('Project')
            && field.options.includes('Operations')
            && field.options.includes('Deal');
        }),
      'organization.exactly-resolved': exactOrganizationResolved,
      'duplicates.bounded': duplicateEntry.value.candidateCount === 0
        && duplicateEntry.value.candidateIds.length === 0
        && factValue(preview, 'duplicate-candidate-count') === 0,
      'project-create.candidate-reviewable': preview.kind === 'project-capture-preview'
        && preview.proposedChanges.length === 1
        && preview.privateReview.state === 'available'
        && preview.collections.length === 1
        && reviewAction?.kind === 'project-create'
        && reviewAction?.state === 'proposed'
        && reviewAction?.capability === 'projects.records.create'
        && reviewAction?.effect === 'write'
        && reviewAction?.reasonCode === 'PROJECT_CREATE_READY_FOR_REVIEW'
        && /^sha256:[a-f0-9]{64}$/.test(reviewAction?.changeFingerprint || '')
        && reviewRow?.flags.length === 0
        && /^sha256:[a-f0-9]{64}$/.test(reviewRow?.privateDetailFingerprint || ''),
      'project-create.preparation-grants-no-write-authority': preparationGrantsNoWriteAuthority
    },
    invariants: {
      'private-project-material-excluded-from-inspection': privateMaterialSanitized,
      'calendar-range-pinned': datePinned,
      'project-name-policy-exact': factValue(preview, 'project-name-policy-shaped') === true
        && preview.facts.find((fact) => fact.id === 'project-name-policy-shaped')?.state
          === 'supported',
      'milestone-grammar-exact': milestoneGrammarExact
        && factValue(preview, 'milestone-syntax-version') === 'project-milestone-line/v1'
        && factValue(preview, 'work-item-syntax-version') === 'dated-owner-action-line/v1',
      'relations-never-fabricated': exactOrganizationResolved
        && factValue(preview, 'manager-reference-bound') === 'unavailable'
        && factValue(preview, 'client-contact-state') === 'unavailable'
        && !privateFields.has('managerIds')
        && !privateFields.has('clientContactIds'),
      'deduplicate-before-create': envelope.effects.length === 5
        && envelope.effects[4].capability === 'projects.records.read'
        && duplicateEntry.value.providerOutputFingerprint === envelope.effects[4].outputFingerprint,
      'no-write-or-approval-during-preparation': preparationGrantsNoWriteAuthority
    },
    evidence: {
      'exact-lock': envelope.configurationLock.fingerprint === fingerprintLock(lock)
        && envelope.graphFingerprint === lock.graphFingerprint,
      'policy-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(policyEntry.valueFingerprint),
      'profile-source-fingerprint': /^sha256:[a-f0-9]{64}$/.test(profileEntry.valueFingerprint),
      'schema-read-fingerprint': /^sha256:[a-f0-9]{64}$/.test(schemaEntry.valueFingerprint),
      'organization-read-fingerprint': /^sha256:[a-f0-9]{64}$/.test(organizationEntry.valueFingerprint),
      'duplicate-query-fingerprint': /^sha256:[a-f0-9]{64}$/.test(duplicateEntry.valueFingerprint)
        && /^sha256:[a-f0-9]{64}$/.test(duplicateEntry.value.providerOutputFingerprint),
      'private-project-material-sanitized': privateMaterialSanitized
        && projectItem.fingerprint === reviewRow.privateDetailFingerprint,
      'write-boundary-state': preparationGrantsNoWriteAuthority
        && envelope.effectPolicies.write.mode === 'confirm'
        && envelope.effectPolicies.dispatch.mode === 'prohibit'
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

export async function runContainedProjectCaptureScenario({
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
    name: 'SCENARIO_PRIVATE_SHORT_SENTINEL: Partner launch',
    organizationShortName: 'SCENARIO_PRIVATE_SHORT_SENTINEL',
    organization: 'soter-fixture://crm/organization/acme',
    creationProfile: 'project',
    projectType: 'Project',
    overview: 'Coordinate the evidence-grounded partner launch without inventing owners or completion.',
    milestoneTitles: ['Confirm launch scope', 'Complete delivery review'],
    milestoneDescriptions: [
      'The delivery boundary is explicit and reviewable',
      'The final evidence and limitations are reviewed'
    ],
    milestoneOwners: ['Maya', 'Jonah'],
    milestoneActions: ['Confirm the exact launch scope', 'Review the final delivery evidence'],
    milestoneDates: ['2026-07-28', '2026-08-14'],
    startDate: '2026-07-24',
    targetEndDate: '2026-08-15'
  };
  const execution = await prepareProjectCaptureRun({
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
      {
        role: 'context-snapshot',
        id: execution.snapshot.id,
        fingerprint: fingerprintJson(execution.snapshot)
      },
      {
        role: 'project-create-preview',
        fingerprint: execution.preview.fingerprint
      }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: execution.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    assessment,
    evaluatorId: 'automation.project-capture.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return { ...execution, scenario: loaded.scenario, assessment, scenarioEvidence };
}
