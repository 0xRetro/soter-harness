import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';

const POLICY_CONTRACT = 'soter://contexts/projects/project-capture-policy/v1';

export function loadProjectCapturePolicyDefinition(root) {
  const schema = readJson(path.join(
    root,
    'soter',
    'contracts',
    'project-capture-policy.schema.json'
  ));
  const definition = readJson(path.join(
    root,
    'soter',
    'contexts',
    'projects',
    'project-capture.policy.json'
  ));
  const failures = validateJsonSchema(definition, schema);
  if (definition.$contract !== POLICY_CONTRACT || failures.length) {
    throw new Error(
      'Project Capture policy definition does not satisfy its Context contract'
        + (failures.length
          ? ': ' + failures.slice(0, 5).map((item) => {
            return item.path + ' ' + item.message;
          }).join('; ')
          : '.')
    );
  }
  return definition;
}

export function projectCapturePolicyFields(definition) {
  return {
    name: definition.name,
    createRequiresConfirmation: definition.createRequiresConfirmation,
    duplicateCandidateLimit: definition.duplicateCandidateLimit,
    duplicateKeyFields: structuredClone(definition.duplicateKeyFields),
    defaultStatus: definition.defaultStatus,
    allowedTypes: structuredClone(definition.allowedTypes),
    allowedStatuses: structuredClone(definition.allowedStatuses),
    projectTypePolicy: definition.projectTypePolicy,
    namingRule: definition.namingRule,
    organizationPolicy: definition.organizationPolicy,
    managerPolicy: definition.managerPolicy,
    clientContactPolicy: definition.clientContactPolicy,
    creationProfiles: structuredClone(definition.creationProfiles),
    bodyFormat: definition.bodyFormat,
    requiredBodySections: structuredClone(definition.requiredBodySections),
    milestoneSyntaxVersion: definition.milestoneSyntaxVersion,
    workItemSyntaxVersion: definition.workItemSyntaxVersion,
    granularityRequiresOperatorDecision: definition.granularityRequiresOperatorDecision,
    thirdPartyOrganizationRequiresOperatorDecision:
      definition.thirdPartyOrganizationRequiresOperatorDecision
  };
}

export function projectCreationProfileFields(profile) {
  return {
    name: profile.name,
    profileId: profile.id,
    allowedProjectTypes: structuredClone(profile.allowedProjectTypes),
    bodyFormat: profile.bodyFormat,
    requiredBodySections: structuredClone(profile.requiredBodySections),
    milestoneSyntaxVersion: profile.milestoneSyntaxVersion,
    workItemSyntaxVersion: profile.workItemSyntaxVersion
  };
}

export function assertProjectCreationProfileSelection(output, definition, selectedProfileId) {
  const records = output?.records;
  if (!Array.isArray(records)
    || records.length !== definition.creationProfiles.length
    || records.some((record) => record?.type !== 'project-creation-profile')
    || new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error(
      'Project Capture requires the complete exact set of normalized Project creation profiles.'
    );
  }
  const expectedById = new Map(definition.creationProfiles.map((profile) => [
    profile.id,
    projectCreationProfileFields(profile)
  ]));
  const selected = [];
  const observedIds = new Set();
  for (const record of records) {
    const profileId = record.fields?.profileId;
    const expected = expectedById.get(profileId);
    if (!expected
      || observedIds.has(profileId)
      || fingerprintJson(record.fields) !== fingerprintJson(expected)) {
      throw new Error(
        'Project Capture creation-profile projection does not match the exact governed Context definitions.'
      );
    }
    observedIds.add(profileId);
    if (profileId === selectedProfileId) selected.push(record);
  }
  if (observedIds.size !== expectedById.size || selected.length !== 1) {
    throw new Error('Project Capture requires one exact selected governed creation profile.');
  }
  const profile = definition.creationProfiles.find((item) => item.id === selectedProfileId);
  return {
    record: selected[0],
    profile: structuredClone(profile),
    fields: projectCreationProfileFields(profile),
    definitionFingerprint: fingerprintJson(profile)
  };
}

export function assertProjectCapturePolicySelection(output, definition, {
  requireProjectedRules = false
} = {}) {
  const records = (output?.records || []).filter((record) => {
    return record.type === 'project-capture-policy';
  });
  if (records.length !== 1 || output.records.length !== 1) {
    throw new Error('Project Capture requires one exact normalized policy-selection record.');
  }
  const record = records[0];
  const expectedFields = projectCapturePolicyFields(definition);
  const expectedSelection = { name: definition.name };
  const expected = requireProjectedRules ? expectedFields : expectedSelection;
  if (fingerprintJson(record.fields) !== fingerprintJson(expected)) {
    throw new Error(
      requireProjectedRules
        ? 'Project Capture policy projection does not match the exact governed Context definition.'
        : 'Project Capture policy selection does not identify the exact governed Context definition.'
    );
  }
  return {
    record,
    fields: expectedFields,
    definitionFingerprint: fingerprintJson(definition)
  };
}
