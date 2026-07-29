import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';

const POLICY_CONTRACT = 'soter://contexts/crm/contact-capture-policy/v1';

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function loadContactCapturePolicyDefinition(root) {
  const schema = readJson(path.join(
    root,
    'soter',
    'contracts',
    'contact-capture-policy.schema.json'
  ));
  const definition = readJson(path.join(
    root,
    'soter',
    'contexts',
    'crm',
    'contact-capture.policy.json'
  ));
  const failures = validateJsonSchema(definition, schema);
  if (definition.$contract !== POLICY_CONTRACT || failures.length) {
    throw new Error(
      'Contact Capture policy definition does not satisfy its Context contract'
        + (failures.length
          ? ': ' + failures.slice(0, 5).map((item) => {
            return item.path + ' ' + item.message;
          }).join('; ')
          : '.')
    );
  }
  return definition;
}

export function assertContactCapturePolicySelection(output, definition) {
  const records = (output?.records || []).filter((record) => {
    return record.type === 'contact-capture-policy';
  });
  if (records.length !== 1 || output.records.length !== 1) {
    throw new Error('Contact Capture requires one exact normalized policy-selection record.');
  }
  const record = records[0];
  if (fingerprintJson(record.fields) !== fingerprintJson({ name: definition.name })) {
    throw new Error(
      'Contact Capture policy selection does not identify the exact governed Context definition.'
    );
  }
  return {
    record,
    fields: structuredClone(definition),
    definitionFingerprint: fingerprintJson(definition)
  };
}

function exactCurrentOption(value, options) {
  const normalized = String(value).trim().toLocaleLowerCase('en');
  const matches = options.filter((option) => {
    return option.toLocaleLowerCase('en') === normalized;
  });
  return matches.length === 1 ? matches[0] : null;
}

function exactScalar(input, id, options, issues) {
  if (!input[id]) return null;
  const value = exactCurrentOption(input[id], options);
  if (value === null) issues.push('CONTACT_' + id.toLocaleUpperCase('en') + '_NOT_IN_CURRENT_SCHEMA');
  return value;
}

function exactList(input, id, options, issues) {
  const requested = input[id] || [];
  const matched = requested.map((value) => exactCurrentOption(value, options));
  if (matched.some((value) => value === null)) {
    issues.push('CONTACT_' + id.toLocaleUpperCase('en') + '_NOT_IN_CURRENT_SCHEMA');
  }
  return [...new Set(matched.filter(Boolean))].sort(compareText);
}

export function selectContactOptions({ input, schema }) {
  const issues = [];
  return {
    role: exactScalar(input, 'role', schema.roleOptions, issues),
    status: exactScalar(input, 'status', schema.statusOptions, issues),
    disposition: exactScalar(input, 'disposition', schema.dispositionOptions, issues),
    authority: exactList(input, 'authority', schema.authorityOptions, issues),
    tags: exactList(input, 'tags', schema.tagOptions, issues),
    issues: [...new Set(issues)].sort(compareText)
  };
}

export function normalizeContactEmail(value) {
  if (!value) return null;
  const normalized = value.trim().toLocaleLowerCase('en');
  if (normalized.length > 320
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    || /[\r\n]/.test(normalized)) {
    throw new Error('Contact email must be one bounded valid email address.');
  }
  return normalized;
}

export function normalizeContactText(value, label, maximum = 500) {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n]/.test(normalized)) {
    throw new Error('Contact ' + label + ' must be one bounded plain-text value.');
  }
  return normalized;
}

export function contactDuplicateFilters(input, policy) {
  const filters = [];
  const email = normalizeContactEmail(input.email);
  if (email) filters.push({ email });
  filters.push({ name: normalizeContactText(input.name, 'name', 200) });
  const expectedKeys = policy.duplicateKeyFields.filter((key) => {
    return key !== 'email' || Boolean(email);
  });
  if (fingerprintJson(filters.map((filter) => Object.keys(filter)[0]))
    !== fingerprintJson(expectedKeys)) {
    throw new Error('Contact duplicate filters drifted from the governed key order.');
  }
  return filters;
}
