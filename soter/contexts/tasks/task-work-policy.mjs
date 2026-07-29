import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';

const POLICY_CONTRACT = 'soter://contexts/tasks/task-work-policy/v1';

export function loadTaskWorkPolicyDefinition(root) {
  const schema = readJson(path.join(
    root,
    'soter',
    'contracts',
    'task-work-policy.schema.json'
  ));
  const definition = readJson(path.join(
    root,
    'soter',
    'contexts',
    'tasks',
    'task-work.policy.json'
  ));
  const failures = validateJsonSchema(definition, schema);
  if (definition.$contract !== POLICY_CONTRACT || failures.length) {
    throw new Error(
      'Task work policy definition does not satisfy its Context contract'
        + (failures.length
          ? ': ' + failures.slice(0, 5).map((item) => {
            return item.path + ' ' + item.message;
          }).join('; ')
          : '.')
    );
  }
  return definition;
}

export function taskWorkPolicyFields(definition) {
  return {
    name: definition.name,
    createRequiresConfirmation: definition.createRequiresConfirmation,
    duplicateCandidateLimit: definition.duplicateCandidateLimit,
    duplicateKeyFields: structuredClone(definition.duplicateKeyFields),
    defaultStatus: definition.defaultStatus,
    allowedContexts: structuredClone(definition.allowedContexts),
    projectRequired: definition.projectRequired,
    assigneePolicy: definition.assigneePolicy
  };
}

export function assertTaskWorkPolicySelection(output, definition, {
  requireProjectedRules = false
} = {}) {
  const records = (output?.records || []).filter((record) => {
    return record.type === 'task-work-policy';
  });
  if (records.length !== 1 || output.records.length !== 1) {
    throw new Error('Task work requires one exact normalized policy-selection record.');
  }
  const record = records[0];
  const expectedFields = taskWorkPolicyFields(definition);
  const expectedSelection = { name: definition.name };
  const expected = requireProjectedRules ? expectedFields : expectedSelection;
  if (fingerprintJson(record.fields) !== fingerprintJson(expected)) {
    throw new Error(
      requireProjectedRules
        ? 'Task work policy projection does not match the exact governed Context definition.'
        : 'Task work policy selection does not identify the exact governed Context definition.'
    );
  }
  return {
    record,
    fields: expectedFields,
    definitionFingerprint: fingerprintJson(definition)
  };
}
