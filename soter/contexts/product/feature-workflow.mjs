import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';

const POLICY_CONTRACT = 'soter://contexts/product/feature-workflow-policy/v1';

function nonEmpty(value, label, maximum = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(label + ' must be non-empty bounded text.');
  }
  return value.trim();
}

function singleLine(value, label, maximum) {
  const text = nonEmpty(value, label, maximum);
  if (/[\r\n]/.test(text)) {
    throw new Error(label + ' must remain one bounded line.');
  }
  return text;
}

function markdownBlock(value, label, maximum) {
  return nonEmpty(value, label, maximum)
    .replace(/\r\n?/g, '\n')
    .replace(/^(#{1,6})(?=\s|$)/gm, '\\$1');
}

function exactLineOffsets(body, marker) {
  const offsets = [];
  let offset = 0;
  for (const line of body.split('\n')) {
    if (line === marker) offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

function exactHeadingRange(body, heading, nextHeading = null) {
  const marker = '## ' + heading;
  const offsets = exactLineOffsets(body, marker);
  if (offsets.length !== 1) return null;
  const first = offsets[0];
  const contentStart = first + marker.length;
  let contentEnd = body.length;
  if (nextHeading !== null) {
    const nextOffsets = exactLineOffsets(body, '## ' + nextHeading);
    if (nextOffsets.length !== 1 || nextOffsets[0] <= first) return null;
    contentEnd = nextOffsets[0];
  }
  return { first, contentStart, contentEnd };
}

export function loadFeatureWorkflowPolicy(root) {
  const schema = readJson(path.join(root, 'soter', 'contracts', 'feature-workflow-policy.schema.json'));
  const definition = readJson(path.join(
    root,
    'soter',
    'contexts',
    'product',
    'feature-workflow.policy.json'
  ));
  const failures = validateJsonSchema(definition, schema);
  if (definition.$contract !== POLICY_CONTRACT || failures.length) {
    throw new Error('Feature workflow policy does not satisfy its Product Context contract'
      + (failures.length
        ? ': ' + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
        : '.'));
  }
  return definition;
}

export function assertFeatureWorkflowPolicySelection(output, policy) {
  const records = (output?.records || []).filter((record) => {
    return record.type === 'feature-workflow-policy';
  });
  if (records.length !== 1 || output.records.length !== 1) {
    throw new Error('Feature workflow requires one exact normalized policy-selection record.');
  }
  if (fingerprintJson(records[0].fields) !== fingerprintJson({ name: policy.name })) {
    throw new Error('Feature workflow policy selection does not identify the exact governed Product definition.');
  }
  return {
    record: records[0],
    policy,
    definitionFingerprint: fingerprintJson(policy)
  };
}

export function assertFeatureSchema(output, policy) {
  const schema = output?.schema;
  if (!schema
    || schema.recordType !== 'feature'
    || schema.fingerprint !== fingerprintJson({
      recordType: schema.recordType,
      fields: schema.fields
    })) {
    throw new Error('Feature schema identity or fingerprint is invalid.');
  }
  const byId = new Map(schema.fields.map((field) => [field.id, field]));
  if (byId.size !== schema.fields.length
    || ['name', 'description', 'status'].some((id) => !byId.get(id)?.writable)) {
    throw new Error('Feature schema does not expose every required portable core field.');
  }
  const statusOptions = byId.get('status')?.options;
  if (!Array.isArray(statusOptions)
    || !policy.lifecycle.every((value) => statusOptions.includes(value))) {
    throw new Error('Feature schema lifecycle options drifted from the governed Product policy.');
  }
  return { schema, byId };
}

export function exactCurrentFeatureOption(value, field, { optionalField = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (!field) {
    if (optionalField) return null;
    throw new Error('Requested feature option has no current mapped field.');
  }
  if (!Array.isArray(field.options)) {
    throw new Error('Requested feature option field has no current closed option set.');
  }
  const normalized = String(value).trim().toLocaleLowerCase('en');
  const matches = field.options.filter((option) => {
    return option.toLocaleLowerCase('en') === normalized;
  });
  return matches.length === 1 ? matches[0] : null;
}

export function buildCapturedFeatureBody({
  policy,
  name,
  featureType,
  summary,
  sectionTwo,
  currentState,
  relationships,
  openQuestions
}) {
  const heading = policy.bodyTemplate.sectionTwoByType[featureType];
  if (!heading) throw new Error('Feature type has no governed body-template section.');
  const list = (values, checkbox = false) => (values || []).map((value) => {
    const text = singleLine(value, 'Feature body list item', 1000);
    return checkbox ? '- [ ] ' + text : '- ' + text;
  }).join('\n');
  return '# ' + singleLine(name, 'Feature name', 200) + '\n\n'
    + '## Summary\n\n' + markdownBlock(summary, 'Feature summary', 5000) + '\n\n'
    + '## ' + heading + '\n\n' + list(sectionTwo, featureType === 'Feature') + '\n\n'
    + '## Current state in code\n\n' + (currentState ? markdownBlock(currentState, 'Current state', 5000) : '') + '\n\n'
    + '## Relationships\n\n' + list(relationships) + '\n\n'
    + '## Decisions & open questions\n\n' + list(openQuestions) + '\n';
}

export function buildDefinedFeatureBody({
  policy,
  currentBody,
  featureType,
  whatItIs,
  scopeIn,
  scopeOut,
  doneWhen,
  openQuestions
}) {
  const sectionTwo = policy.bodyTemplate.sectionTwoByType[featureType];
  if (!sectionTwo) return { compatible: false, body: null, reasonCode: 'FEATURE_TYPE_UNSUPPORTED' };
  if (typeof currentBody !== 'string' || !currentBody.trim()) {
    return { compatible: false, body: null, reasonCode: 'FEATURE_BODY_EMPTY' };
  }
  const headings = [
    'Summary',
    sectionTwo,
    'Current state in code',
    'Relationships',
    'Decisions & open questions'
  ];
  const ranges = headings.map((heading, index) => {
    return exactHeadingRange(currentBody, heading, headings[index + 1] || null);
  });
  if (ranges.some((range) => range === null)
    || ranges.some((range, index) => index > 0 && range.first <= ranges[index - 1].first)) {
    return {
      compatible: false,
      body: null,
      reasonCode: 'FEATURE_BODY_TEMPLATE_UNSUPPORTED'
    };
  }
  const bullets = (values, checkbox = false) => values.map((value) => {
    const text = singleLine(value, 'Feature definition item', 1000);
    return checkbox ? '- [ ] ' + text : '- ' + text;
  }).join('\n');
  const summaryText = '\n\n' + markdownBlock(whatItIs, 'Feature definition', 5000) + '\n\n';
  const definitionText = '\n\n### In scope\n\n' + bullets(scopeIn)
    + '\n\n### Out of scope\n\n' + bullets(scopeOut)
    + '\n\n### Done when\n\n' + bullets(doneWhen, true) + '\n\n';
  const decisionsText = '\n\n' + bullets(openQuestions || []) + '\n';
  const replacements = [
    { range: ranges[4], value: decisionsText },
    { range: ranges[1], value: definitionText },
    { range: ranges[0], value: summaryText }
  ];
  let body = currentBody;
  for (const replacement of replacements) {
    body = body.slice(0, replacement.range.contentStart)
      + replacement.value
      + body.slice(replacement.range.contentEnd);
  }
  return { compatible: true, body, reasonCode: 'FEATURE_DEFINITION_READY_FOR_REVIEW' };
}
