import path from 'node:path';

import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { validateJsonSchema } from '../../kernel/verify.mjs';

const POLICY_CONTRACT = 'soter://contexts/process/process-capture-policy/v1';

function nonEmpty(value, label, maximum = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(label + ' must be non-empty bounded text.');
  }
  return value.trim();
}

function singleLine(value, label, maximum = 1000) {
  const text = nonEmpty(value, label, maximum);
  if (/[\r\n]/.test(text)) throw new Error(label + ' must remain one bounded line.');
  return text;
}

function plainInline(value, label, maximum = 1000) {
  const text = singleLine(value, label, maximum);
  if (/[|`]/.test(text)) {
    throw new Error(label + ' must not contain Markdown table or code delimiters.');
  }
  return text;
}

function markdownBlock(value, label, maximum = 10000) {
  return nonEmpty(value, label, maximum)
    .replace(/\r\n?/g, '\n')
    .replace(/^(#{1,6})(?=\s|$)/gm, '\\$1');
}

function exactLength(values, count, label) {
  if (!Array.isArray(values) || values.length !== count) {
    throw new Error(label + ' must contain exactly ' + count + ' entries.');
  }
  return values;
}

function aliasMap(rows) {
  return new Map(rows.map((row) => [row.input.toLocaleLowerCase('en'), row.value]));
}

export function loadProcessCapturePolicy(root) {
  const schema = readJson(path.join(root, 'soter', 'contracts', 'process-capture-policy.schema.json'));
  const policy = readJson(path.join(root, 'soter', 'contexts', 'process', 'process-capture.policy.json'));
  const failures = validateJsonSchema(policy, schema);
  if (policy.$contract !== POLICY_CONTRACT || failures.length) {
    throw new Error('Process capture policy does not satisfy its Context contract'
      + (failures.length
        ? ': ' + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
        : '.'));
  }
  if (!policy.statusLifecycle.includes(policy.defaultStatus)) {
    throw new Error('Process capture default status is outside its declared lifecycle.');
  }
  return policy;
}

export function assertProcessCapturePolicySelection(output, policy) {
  const records = (output?.records || []).filter((record) => record.type === 'process-capture-policy');
  if (records.length !== 1 || output.records.length !== 1) {
    throw new Error('Process capture requires one exact normalized policy-selection record.');
  }
  if (fingerprintJson(records[0].fields) !== fingerprintJson({ name: policy.name })) {
    throw new Error('Process policy selection does not identify the exact governed Context definition.');
  }
  return { record: records[0], definitionFingerprint: fingerprintJson(policy) };
}

export function assertProcessSchema(output, policy) {
  const schema = output?.schema;
  if (!schema
    || schema.recordType !== 'process'
    || schema.fingerprint !== fingerprintJson({ recordType: schema.recordType, fields: schema.fields })) {
    throw new Error('Process schema identity or fingerprint is invalid.');
  }
  const byId = new Map(schema.fields.map((field) => [field.id, field]));
  const required = ['name', 'status', 'frequency', 'category', 'tags', 'processOs', 'priority',
    'processLogicOwnerUris', 'relatedServiceUris', 'relatedRoleUris'];
  if (byId.size !== schema.fields.length || required.some((id) => !byId.get(id)?.writable)) {
    throw new Error('Process schema does not expose every required portable field.');
  }
  if (!policy.statusLifecycle.every((value) => byId.get('status').options?.includes(value))
    || !policy.processOsLifecycle.every((value) => byId.get('processOs').options?.includes(value))) {
    throw new Error('Process lifecycle or adoption options drifted from the governed Context policy.');
  }
  return { schema, byId };
}

export function exactCurrentProcessOption(value, field, aliases = []) {
  if (value === undefined || value === null || value === '') return null;
  if (!field || !Array.isArray(field.options)) return null;
  const normalized = String(value).trim().toLocaleLowerCase('en');
  const canonical = aliasMap(aliases).get(normalized) || String(value).trim();
  const matches = field.options.filter((option) => {
    return option.toLocaleLowerCase('en') === canonical.toLocaleLowerCase('en');
  });
  return matches.length === 1 ? matches[0] : null;
}

export function buildCapturedProcessBody({
  policy,
  name,
  purpose,
  triggerKinds,
  triggers,
  frequency,
  stepRoles,
  stepCapabilities,
  stepObjectives,
  workItems,
  exceptionHandling = [],
  postRunSummaryFields,
  processLogicOwner
}) {
  const count = stepObjectives?.length || 0;
  if (!Number.isInteger(count) || count < 1 || count > policy.maximumSteps) {
    throw new Error('Process steps must contain 1 through ' + policy.maximumSteps + ' entries.');
  }
  exactLength(stepRoles, count, 'Process step roles');
  exactLength(stepCapabilities, count, 'Process step capabilities');
  exactLength(workItems, count, 'Process work-items');
  exactLength(triggerKinds, triggers?.length || 0, 'Process trigger kinds');
  if (!Array.isArray(triggers) || triggers.length < 1) {
    throw new Error('Process triggers must contain at least one objective condition.');
  }
  const normalizedKinds = triggerKinds.map((kind) => singleLine(kind, 'Process trigger kind', 50));
  if (normalizedKinds.some((kind) => !policy.triggerKinds.includes(kind))) {
    throw new Error('Process trigger kind is outside the governed vocabulary.');
  }
  if (!Array.isArray(postRunSummaryFields) || postRunSummaryFields.length < 1) {
    throw new Error('Process post-run summary must declare at least one field.');
  }
  const roleRows = [];
  const seenRoles = new Set();
  for (let index = 0; index < count; index += 1) {
    const role = plainInline(stepRoles[index], 'Process step role');
    const capability = plainInline(stepCapabilities[index], 'Process step capability');
    const key = role + '\u0000' + capability;
    if (!seenRoles.has(key)) {
      seenRoles.add(key);
      roleRows.push('| ' + role + ' | **' + capability + '** — Own the steps that exercise this capability. |');
    }
  }
  const triggerLines = triggers.map((trigger, index) => {
    return '- `' + normalizedKinds[index] + '` — ' + singleLine(trigger, 'Process trigger');
  });
  const steps = stepObjectives.map((objective, index) => {
    const role = plainInline(stepRoles[index], 'Process step role');
    const capability = plainInline(stepCapabilities[index], 'Process step capability');
    const workItem = singleLine(workItems[index], 'Process work-item');
    return '### Step ' + String(index + 1) + ' — (' + role + ') '
      + singleLine(objective, 'Process step objective') + '\n\n'
      + 'The ' + role + ' completes this bounded objective before handing the run to the next role.\n\n'
      + '- [ ] **' + workItem + '**\n'
      + '  `' + capability + '` Complete this work-item from the declared inputs and retain its output or proof on the process run.';
  });
  const closingStep = '### Step ' + String(count + 1) + ' — ('
    + plainInline(processLogicOwner, 'Process logic owner') + ') Close the process run\n\n'
    + 'The process logic owner records the observed outcome without changing the process definition.\n\n'
    + '- [ ] **Record the post-run summary and close the run.**\n'
    + '  `Process` Fill every declared summary field, link retained proof, set the final run state, and record completion.';
  const exceptions = exceptionHandling.length
    ? exceptionHandling.map((item, index) => '- **E' + String(index + 1) + '** — '
      + singleLine(item, 'Process exception')).join('\n')
    : '- **E1** — Stop the run, preserve observed state, and route the exception for operator review rather than guessing.';
  return '# ' + singleLine(name, 'Process name', 200) + '\n\n'
    + '## Purpose\n\n' + markdownBlock(purpose, 'Process purpose', 5000) + '\n\n'
    + '## Trigger\n\n' + triggerLines.join('\n') + '\n\n'
    + '## Cadence\n\n' + singleLine(frequency, 'Process cadence', 100) + '\n\n'
    + '## Roles\n\n| Role | Responsibility |\n|---|---|\n' + roleRows.join('\n') + '\n\n'
    + '## Initialization\n\n- [ ] **Create the process run.**\n'
    + '  `Process` Create one run entry for this process, bind every declared role, retain the exact inputs, start time, and initial state.\n\n'
    + '## Steps\n\n' + [...steps, closingStep].join('\n\n') + '\n\n'
    + '## Exception Handling\n\n' + exceptions + '\n\n'
    + '## Post Run Summary Report\n\n'
    + postRunSummaryFields.map((field) => '- ' + singleLine(field, 'Post-run summary field')).join('\n')
    + '\n';
}
