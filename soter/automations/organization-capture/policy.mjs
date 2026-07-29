import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';

const POLICY_CONTRACT = 'soter://contexts/crm/organization-capture-policy/v1';

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function loadOrganizationCapturePolicyDefinition(root) {
  const schema = readJson(path.join(
    root,
    'soter',
    'contracts',
    'organization-capture-policy.schema.json'
  ));
  const definition = readJson(path.join(
    root,
    'soter',
    'contexts',
    'crm',
    'organization-capture.policy.json'
  ));
  const failures = validateJsonSchema(definition, schema);
  if (definition.$contract !== POLICY_CONTRACT || failures.length) {
    throw new Error(
      'Organization Capture policy definition does not satisfy its Context contract'
        + (failures.length
          ? ': ' + failures.slice(0, 5).map((item) => {
            return item.path + ' ' + item.message;
          }).join('; ')
          : '.')
    );
  }
  for (const key of ['typeRules', 'tagRules']) {
    const values = definition[key].map((rule) => rule.value);
    if (new Set(values).size !== values.length) {
      throw new Error('Organization Capture ' + key + ' must map each value exactly once.');
    }
    for (const rule of definition[key]) {
      const terms = rule.terms.map((term) => term.toLocaleLowerCase('en'));
      if (new Set(terms).size !== terms.length) {
        throw new Error('Organization Capture ' + key + ' contains duplicate normalized terms.');
      }
    }
  }
  return definition;
}

export function assertOrganizationCapturePolicySelection(output, definition) {
  const records = (output?.records || []).filter((record) => {
    return record.type === 'organization-capture-policy';
  });
  if (records.length !== 1 || output.records.length !== 1) {
    throw new Error('Organization Capture requires one exact normalized policy-selection record.');
  }
  const record = records[0];
  if (fingerprintJson(record.fields) !== fingerprintJson({ name: definition.name })) {
    throw new Error(
      'Organization Capture policy selection does not identify the exact governed Context definition.'
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

function termPresent(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i').test(text);
}

function governedMatches(text, rules) {
  return rules.filter((rule) => rule.terms.some((term) => termPresent(text, term)));
}

export function classifyOrganization({ input, policy, typeOptions, tagOptions }) {
  const issues = [];
  const prose = [input.name, input.description].join(' ');
  const explicitType = input.organizationType
    ? exactCurrentOption(input.organizationType, typeOptions)
    : null;
  if (input.organizationType && explicitType === null) {
    issues.push('ORG_TYPE_NOT_IN_CURRENT_SCHEMA');
  }
  const typeMatches = governedMatches(prose, policy.typeRules)
    .map((rule) => exactCurrentOption(rule.value, typeOptions));
  if (typeMatches.some((value) => value === null)) {
    issues.push('ORG_TYPE_POLICY_SCHEMA_DRIFT');
  }
  const uniqueTypes = [...new Set(typeMatches.filter(Boolean))];
  if (!explicitType && uniqueTypes.length === 0) issues.push('ORG_TYPE_UNRESOLVED');
  if (!explicitType && uniqueTypes.length > 1) issues.push('ORG_TYPE_AMBIGUOUS');
  if (explicitType && uniqueTypes.length && !uniqueTypes.includes(explicitType)) {
    issues.push('ORG_TYPE_CONTRADICTS_GOVERNED_CLASSIFICATION');
  }
  const organizationType = explicitType || (uniqueTypes.length === 1 ? uniqueTypes[0] : null);

  const requestedTags = input.tags || [];
  const exactRequestedTags = requestedTags.map((tag) => exactCurrentOption(tag, tagOptions));
  if (exactRequestedTags.some((value) => value === null)) {
    issues.push('ORG_TAG_NOT_IN_CURRENT_SCHEMA');
  }
  const detectedRules = governedMatches(prose, policy.tagRules);
  const detectedTags = detectedRules.map((rule) => exactCurrentOption(rule.value, tagOptions));
  if (detectedTags.some((value) => value === null)) {
    issues.push('ORG_SECTOR_TAG_UNAVAILABLE');
  }
  const tags = [...new Set([...exactRequestedTags, ...detectedTags].filter(Boolean))]
    .sort(compareText);
  return {
    organizationType,
    tags,
    detectedSectorCount: detectedRules.length,
    issues: [...new Set(issues)].sort(compareText)
  };
}

export function normalizeOrganizationWebsite(value) {
  if (!value) return null;
  const source = /^https?:\/\//i.test(value.trim()) ? value.trim() : 'https://' + value.trim();
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error('Organization website must be a valid HTTP or HTTPS domain or URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new Error('Organization website must be one credential-free HTTP or HTTPS resource without query or fragment data.');
  }
  url.protocol = 'https:';
  if (url.pathname === '/') url.pathname = '';
  return url.toString().replace(/\/$/, '');
}

export function normalizeOrganizationTwitter(value) {
  if (!value) return null;
  const source = value.trim();
  if (/^@[A-Za-z0-9_]{1,15}$/.test(source)) {
    return 'https://twitter.com/' + source.slice(1);
  }
  const url = normalizeOrganizationWebsite(source);
  const parsed = new URL(url);
  if (!['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'].includes(parsed.hostname)
    || !/^\/[A-Za-z0-9_]{1,15}$/.test(parsed.pathname)) {
    throw new Error('Organization Twitter must be one handle or exact twitter.com or x.com profile URL.');
  }
  return 'https://twitter.com' + parsed.pathname;
}

export function organizationDuplicateNames(input, policy) {
  const names = [input.name, ...(input.aliases || [])];
  const suffixPattern = new RegExp(
    '\\s+(?:' + policy.aliasSuffixes.map((value) => {
      return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('|') + ')$',
    'i'
  );
  const stripped = input.name.replace(suffixPattern, '').trim();
  if (stripped && stripped !== input.name) names.push(stripped);
  names.push(input.name.replace(/[^A-Za-z0-9]+/g, ''));
  const unique = [];
  const seen = new Set();
  for (const name of names) {
    const trimmed = name.trim();
    const key = trimmed.toLocaleLowerCase('en');
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  if (unique.length > policy.maximumAliases) {
    throw new Error('Organization alias set exceeds the governed duplicate-search bound.');
  }
  return unique;
}
