#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRecordCapability } from './record-capabilities.mjs';
import { inspectTrackedConfigurationTemplates } from './configuration-template-portability.mjs';
import {
  fingerprintWorkflowEvaluatedSubject,
  fingerprintWorkflowGuideContent,
  inspectWorkflowEvaluationRunSet,
  workflowEvaluationRunPlan,
  workflowGuideContentFingerprintMatches,
  workflowLegacySourceProjection
} from './workflow-guides.mjs';
import {
  fingerprintPrivateContainedBasis,
  fingerprintPrivateContainedLockProjection
} from './private-contained-evidence.mjs';
import { workflowEvidenceBasisForPath } from './workflow-evidence-bases.mjs';

const CONTRACT_VERSION = '1.0.0';
const EFFECTS = ['read', 'disclosure', 'write', 'dispatch', 'destructive'];
const ERROR_KINDS = [
  'authentication',
  'authorization',
  'validation',
  'conflict',
  'rate-limit',
  'unavailable',
  'retryable',
  'not-found',
  'unknown'
];
const VERIFICATION_LEVELS = ['static', 'graph', 'fixture', 'agent', 'contained', 'canary', 'monitored'];
const RUNTIME_ARTIFACT_CONTRACTS = new Set([
  'soter://contracts/lock/v1',
  'soter://contracts/run-envelope/v1',
  'soter://contracts/evidence/v2',
  'soter://contracts/doctor-result/v1',
  'soter://contracts/provider-probe/v2',
  'soter://contracts/provider-probe-attempt/v1',
  'soter://contracts/provider-probe-plan-checkpoint/v1',
  'soter://contracts/host-tool-call/v1',
  'soter://contracts/host-call-checkpoint/v1',
  'soter://contracts/context-snapshot/v1',
  'soter://contracts/automation-decision/v1',
  'soter://contracts/approval/v2',
  'soter://contracts/connected-transaction-checkpoint/v2'
]);
const SECRET_RE = /\b(secret_[A-Za-z0-9]{32,}|ntn_[A-Za-z0-9]{32,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36})\b/;
const ZERO_WIDTH_RE = /[​‌‍⁠﻿]/;

const scriptFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptFile), '..', '..');

function violation(file, code, what, why, fix, level = 'error') {
  return { file, code, what, why, fix, level };
}

function walkFiles(dir, predicate) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(file, predicate));
    else if (predicate(file)) found.push(file);
  }
  return found;
}

function parseJson(file, out) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    out.push(violation(
      file,
      'SOTER_JSON',
      'invalid JSON: ' + error.message,
      'contracts cannot be resolved or reproduced when their serialized form is ambiguous',
      'repair the JSON and rerun the target verifier'
    ));
    return null;
  }
}

function deepEqual(a, b) {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function fingerprintJson(value) {
  return 'sha256:' + crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function isExactInstant(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function historicalWorkflowEvidenceChronologyIsValid(evidence) {
  const instants = [
    evidence.createdAt,
    evidence.sourceObservation?.observedAt,
    evidence.request?.createdAt,
    evidence.result?.createdAt,
    evidence.result?.completedAt,
    ...((evidence.runs || []).flatMap((run) => [run.startedAt, run.completedAt]))
  ];
  if (instants.some((instant) => !isExactInstant(instant))) return false;
  const requestAt = Date.parse(evidence.request.createdAt);
  const resultCreatedAt = Date.parse(evidence.result.createdAt);
  const resultCompletedAt = Date.parse(evidence.result.completedAt);
  const observedAt = Date.parse(evidence.sourceObservation.observedAt);
  const evidenceAt = Date.parse(evidence.createdAt);
  return resultCreatedAt >= requestAt
    && resultCompletedAt >= resultCreatedAt
    && observedAt >= resultCompletedAt
    && evidenceAt === observedAt
    && !evidence.runs.some((run) => {
      const startedAt = Date.parse(run.startedAt);
      const completedAt = Date.parse(run.completedAt);
      return startedAt < requestAt
        || completedAt < startedAt
        || completedAt > resultCompletedAt;
    });
}

function historicalWorkflowEvidenceWorkspaceIsStable(evidence) {
  const pre = evidence.workspace?.pre;
  const post = evidence.workspace?.post;
  return pre && post && [
    'rootIdentityFingerprint',
    'policyFingerprint',
    'settingsFingerprint'
  ].every((field) => pre[field] === post[field]);
}

function fingerprintFile(file) {
  return 'sha256:' + crypto.createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

function resolveRegularRepositoryFile(root, requestedPath) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const candidate = path.resolve(root, requestedPath);
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep)
    || path.isAbsolute(relative) || !fs.existsSync(candidate)) {
    return null;
  }
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  const real = fs.realpathSync(candidate);
  const realRelative = path.relative(resolvedRoot, real);
  if (!realRelative || realRelative === '..' || realRelative.startsWith('..' + path.sep)
    || path.isAbsolute(realRelative)) {
    return null;
  }
  return candidate;
}

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function resolvePointer(rootSchema, ref) {
  if (!ref.startsWith('#/')) return null;
  let value = rootSchema;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || !Object.prototype.hasOwnProperty.call(value, key)) return null;
    value = value[key];
  }
  return value;
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment',
  'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'type', 'const', 'enum', 'allOf', 'oneOf', 'if', 'then', 'else',
  'properties', 'propertyNames', 'required', 'additionalProperties', 'items', 'prefixItems',
  'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'minProperties', 'maxProperties'
]);

function schemaDefinitionErrors(schema, rootSchema = schema, at = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return [{ path: at, message: 'schema node must be an object' }];
  }
  const errors = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      errors.push({
        path: at + '.' + key,
        message: 'schema keyword is not supported by the Soter validator'
      });
    }
  }
  for (const key of ['$schema', '$id', '$ref', '$comment', 'title', 'description']) {
    if (schema[key] !== undefined && typeof schema[key] !== 'string') {
      errors.push({ path: at + '.' + key, message: 'must be a string' });
    }
  }
  for (const key of ['deprecated', 'readOnly', 'writeOnly', 'uniqueItems']) {
    if (schema[key] !== undefined && typeof schema[key] !== 'boolean') {
      errors.push({ path: at + '.' + key, message: 'must be a boolean' });
    }
  }
  if (schema.examples !== undefined && !Array.isArray(schema.examples)) {
    errors.push({ path: at + '.examples', message: 'must be an array' });
  }
  const allowedTypes = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => typeof type !== 'string' || !allowedTypes.has(type))
      || new Set(types).size !== types.length) {
      errors.push({ path: at + '.type', message: 'must name one or more unique supported JSON types' });
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) {
    errors.push({ path: at + '.enum', message: 'must be a non-empty array' });
  }
  if (schema.required !== undefined
    && (!Array.isArray(schema.required)
      || schema.required.some((name) => typeof name !== 'string')
      || new Set(schema.required).size !== schema.required.length)) {
    errors.push({ path: at + '.required', message: 'must be an array of unique property names' });
  }
  for (const key of [
    'minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties'
  ]) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) {
      errors.push({ path: at + '.' + key, message: 'must be a non-negative integer' });
    }
  }
  for (const [minimumKey, maximumKey] of [
    ['minItems', 'maxItems'],
    ['minLength', 'maxLength'],
    ['minProperties', 'maxProperties']
  ]) {
    if (Number.isInteger(schema[minimumKey]) && Number.isInteger(schema[maximumKey])
      && schema[minimumKey] > schema[maximumKey]) {
      errors.push({ path: at, message: minimumKey + ' cannot exceed ' + maximumKey });
    }
  }
  for (const key of ['minimum', 'maximum']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) {
      errors.push({ path: at + '.' + key, message: 'must be a finite number' });
    }
  }
  if (Number.isFinite(schema.minimum) && Number.isFinite(schema.maximum)
    && schema.minimum > schema.maximum) {
    errors.push({ path: at, message: 'minimum cannot exceed maximum' });
  }
  if (schema.$ref !== undefined
    && (typeof schema.$ref !== 'string' || !resolvePointer(rootSchema, schema.$ref))) {
    errors.push({ path: at + '.$ref', message: 'must be a resolvable local JSON pointer' });
  }
  if ((schema.then !== undefined || schema.else !== undefined) && schema.if === undefined) {
    errors.push({ path: at, message: 'then or else requires an if schema' });
  }
  if (schema.if !== undefined && schema.then === undefined && schema.else === undefined) {
    errors.push({ path: at + '.if', message: 'must have a then or else branch to enforce a condition' });
  }
  if (schema.pattern !== undefined && typeof schema.pattern !== 'string') {
    errors.push({ path: at + '.pattern', message: 'must be a string' });
  } else if (schema.pattern) {
    try {
      new RegExp(schema.pattern);
    } catch (error) {
      errors.push({ path: at + '.pattern', message: 'schema contains invalid pattern: ' + error.message });
    }
  }
  for (const key of ['properties', '$defs']) {
    const entries = schema[key];
    if (entries !== undefined && (!entries || typeof entries !== 'object' || Array.isArray(entries))) {
      errors.push({ path: at + '.' + key, message: 'must be an object of schema nodes' });
      continue;
    }
    for (const [name, child] of Object.entries(entries || {})) {
      errors.push(...schemaDefinitionErrors(child, rootSchema, at + '.' + key + '.' + name));
    }
  }
  for (const key of ['items', 'if', 'then', 'else']) {
    if (schema[key] !== undefined) {
      errors.push(...schemaDefinitionErrors(schema[key], rootSchema, at + '.' + key));
    }
  }
  if (schema.propertyNames !== undefined) {
    errors.push(...schemaDefinitionErrors(
      schema.propertyNames,
      rootSchema,
      at + '.propertyNames'
    ));
  }
  if (schema.prefixItems !== undefined) {
    if (!Array.isArray(schema.prefixItems)) {
      errors.push({ path: at + '.prefixItems', message: 'must be an array of schema nodes' });
    } else {
      for (const [index, child] of schema.prefixItems.entries()) {
        errors.push(...schemaDefinitionErrors(child, rootSchema, at + '.prefixItems[' + index + ']'));
      }
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    errors.push(...schemaDefinitionErrors(
      schema.additionalProperties,
      rootSchema,
      at + '.additionalProperties'
    ));
  }
  for (const key of ['allOf', 'oneOf']) {
    if (schema[key] !== undefined && (!Array.isArray(schema[key]) || !schema[key].length)) {
      errors.push({ path: at + '.' + key, message: 'must be a non-empty array of schema nodes' });
      continue;
    }
    for (const [index, child] of (schema[key] || []).entries()) {
      errors.push(...schemaDefinitionErrors(child, rootSchema, at + '.' + key + '[' + index + ']'));
    }
  }
  return errors;
}

function schemaErrors(value, schema, rootSchema = schema, at = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') {
    return [{ path: at, message: 'schema node is not an object' }];
  }

  if (schema.$ref) {
    const target = resolvePointer(rootSchema, schema.$ref);
    if (!target) return [{ path: at, message: 'unresolved schema reference ' + schema.$ref }];
    errors.push(...schemaErrors(value, target, rootSchema, at));
  }

  if (schema.allOf) {
    for (const branch of schema.allOf) {
      errors.push(...schemaErrors(value, branch, rootSchema, at));
    }
  }
  if (schema.oneOf) {
    const outcomes = schema.oneOf.map((branch) => {
      return schemaErrors(value, branch, rootSchema, at);
    });
    const matches = outcomes.filter((outcome) => outcome.length === 0).length;
    if (matches !== 1) {
      errors.push({ path: at, message: 'must match exactly one oneOf branch; matched ' + matches });
    }
  }
  if (schema.if) {
    const conditionMatches = schemaErrors(value, schema.if, rootSchema, at).length === 0;
    const branch = conditionMatches ? schema.then : schema.else;
    if (branch) errors.push(...schemaErrors(value, branch, rootSchema, at));
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !deepEqual(value, schema.const)) {
    errors.push({ path: at, message: 'must equal ' + JSON.stringify(schema.const) });
  }
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push({ path: at, message: 'must be one of ' + schema.enum.map((item) => JSON.stringify(item)).join(', ') });
  }

  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = jsonType(value);
    const typeMatches = expected.includes(actual)
      || (actual === 'integer' && expected.includes('number'));
    if (!typeMatches) {
      errors.push({ path: at, message: 'must have type ' + expected.join(' or ') + ', got ' + actual });
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path: at, message: 'must contain at least ' + schema.minLength + ' characters' });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path: at, message: 'must contain at most ' + schema.maxLength + ' characters' });
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push({ path: at, message: 'must match pattern ' + schema.pattern });
        }
      } catch (error) {
        errors.push({ path: at, message: 'schema contains invalid pattern: ' + error.message });
      }
    }
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path: at, message: 'must be at least ' + schema.minimum });
  }
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) {
    errors.push({ path: at, message: 'must be at most ' + schema.maximum });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path: at, message: 'must contain at least ' + schema.minItems + ' items' });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path: at, message: 'must contain at most ' + schema.maxItems + ' items' });
    }
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(canonicalize(item)));
      if (new Set(serialized).size !== serialized.length) {
        errors.push({ path: at, message: 'must not contain duplicate items' });
      }
    }
    if (schema.items) {
      const itemStart = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
      value.slice(itemStart).forEach((item, relativeIndex) => {
        const index = itemStart + relativeIndex;
        errors.push(...schemaErrors(item, schema.items, rootSchema, at + '[' + index + ']'));
      });
    }
    if (schema.prefixItems) {
      schema.prefixItems.forEach((itemSchema, index) => {
        if (index < value.length) {
          errors.push(...schemaErrors(value[index], itemSchema, rootSchema, at + '[' + index + ']'));
        }
      });
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const propertyCount = Object.keys(value).length;
    if (schema.minProperties !== undefined && propertyCount < schema.minProperties) {
      errors.push({ path: at, message: 'must contain at least ' + schema.minProperties + ' properties' });
    }
    if (schema.maxProperties !== undefined && propertyCount > schema.maxProperties) {
      errors.push({ path: at, message: 'must contain at most ' + schema.maxProperties + ' properties' });
    }
    const properties = schema.properties || {};
    if (schema.propertyNames) {
      for (const key of Object.keys(value)) {
        errors.push(...schemaErrors(key, schema.propertyNames, rootSchema, at + '.' + key));
      }
    }
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        errors.push({ path: at, message: 'missing required property ' + required });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(...schemaErrors(child, properties[key], rootSchema, at + '.' + key));
      } else if (schema.additionalProperties === false) {
        errors.push({ path: at + '.' + key, message: 'additional property is not allowed' });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...schemaErrors(child, schema.additionalProperties, rootSchema, at + '.' + key));
      }
    }
  }

  return errors;
}

function scanStrings(value, file, out, at = '$') {
  if (typeof value === 'string') {
    if (ZERO_WIDTH_RE.test(value)) {
      out.push(violation(
        file,
        'SOTER_SECURITY',
        at + ' contains a zero-width character',
        'invisible characters can smuggle instructions or corrupt identifiers',
        'remove the invisible character'
      ));
    }
    if (SECRET_RE.test(value)) {
      out.push(violation(
        file,
        'SOTER_SECRET',
        at + ' contains what looks like a real credential',
        'desired configuration may contain secret references but never secret values',
        'remove the value and use a secret-ref identifier'
      ));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanStrings(item, file, out, at + '[' + index + ']'));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      scanStrings(child, file, out, at + '.' + key);
    }
  }
}

function parseVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function satisfies(version, range) {
  const actual = parseVersion(version);
  if (!actual) return false;
  const match = String(range).match(/^(\^|~|>=|<=|>|<)?(\d+\.\d+\.\d+)$/);
  if (!match) return false;
  const operator = match[1] || '=';
  const expected = parseVersion(match[2]);
  const comparison = compareVersion(actual, expected);
  if (operator === '=') return comparison === 0;
  if (operator === '>=') return comparison >= 0;
  if (operator === '<=') return comparison <= 0;
  if (operator === '>') return comparison > 0;
  if (operator === '<') return comparison < 0;
  if (operator === '~') {
    return comparison >= 0 && actual[0] === expected[0] && actual[1] === expected[1];
  }
  if (operator === '^') {
    if (comparison < 0) return false;
    if (expected[0] > 0) return actual[0] === expected[0];
    if (expected[1] > 0) return actual[0] === 0 && actual[1] === expected[1];
    return actual[0] === 0 && actual[1] === 0 && actual[2] === expected[2];
  }
  return false;
}

function detectDependencyCycles(packs, out) {
  const visiting = new Set();
  const visited = new Set();

  function visit(id, trail) {
    if (visiting.has(id)) {
      out.push(violation(
        packs.get(id).file,
        'SOTER_DEPENDENCY_CYCLE',
        'pack dependency cycle: ' + [...trail, id].join(' -> '),
        'a cyclic pack graph cannot be resolved in a stable order',
        'remove or invert one dependency edge'
      ));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const entry = packs.get(id);
    for (const dep of entry?.doc.dependencies || []) {
      if (packs.has(dep.pack)) visit(dep.pack, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of packs.keys()) visit(id, []);
}

function addSchemaViolations(file, failures, out) {
  for (const failure of failures.slice(0, 20)) {
    out.push(violation(
      file,
      'SOTER_SCHEMA',
      failure.path + ' ' + failure.message,
      'machine-readable contracts must have one mechanically enforced shape',
      'change the document to match its declared contract'
    ));
  }
  if (failures.length > 20) {
    out.push(violation(
      file,
      'SOTER_SCHEMA',
      String(failures.length - 20) + ' additional schema violations were omitted',
      'a heavily malformed document obscures the first actionable failures',
      'fix the reported violations and rerun the verifier'
    ));
  }
}

function addSchemaDefinitionViolations(file, failures, out, label = 'contract schema') {
  for (const failure of failures.slice(0, 20)) {
    out.push(violation(
      file,
      'SOTER_SCHEMA_DEFINITION',
      label + ' ' + failure.path + ' ' + failure.message,
      'a declared constraint that Core cannot evaluate would create false validation confidence',
      'use the supported schema vocabulary or extend the validator and its self-tests first'
    ));
  }
  if (failures.length > 20) {
    out.push(violation(
      file,
      'SOTER_SCHEMA_DEFINITION',
      String(failures.length - 20) + ' additional schema-definition violations were omitted',
      'unsupported or malformed schema vocabulary cannot be treated as enforced',
      'fix the reported schema definitions and rerun the verifier'
    ));
  }
}

function collectDocuments(root, out, census, options = {}) {
  const soterRoot = path.join(root, 'soter');
  const schemas = new Map();
  const documents = [];
  const configurationOverrides = new Map((options.configurationOverrides || []).map((entry) => {
    return [path.resolve(entry.path), structuredClone(entry.document)];
  }));

  for (const file of walkFiles(soterRoot, (candidate) => candidate.endsWith('.schema.json'))) {
    const schema = parseJson(file, out);
    if (!schema) continue;
    census.contracts += 1;
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema' || typeof schema.$id !== 'string') {
      out.push(violation(
        file,
        'SOTER_SCHEMA_DEFINITION',
        'contract schema must declare JSON Schema 2020-12 and a stable $id',
        'instances need an unambiguous versioned contract identity',
        'add the draft URI and a stable soter:// contract identifier'
      ));
      continue;
    }
    const definitionFailures = schemaDefinitionErrors(schema);
    if (definitionFailures.length) {
      addSchemaDefinitionViolations(file, definitionFailures, out);
      continue;
    }
    if (schemas.has(schema.$id)) {
      out.push(violation(
        file,
        'SOTER_SCHEMA_DEFINITION',
        'duplicate contract identifier ' + schema.$id,
        'two schemas cannot own the same contract identity',
        'give each versioned schema a unique $id'
      ));
      continue;
    }
    schemas.set(schema.$id, { file, schema });
  }

  const instanceFiles = walkFiles(soterRoot, (candidate) => {
    return candidate.endsWith('.json') && !candidate.endsWith('.schema.json');
  });
  for (const file of instanceFiles) {
    const doc = configurationOverrides.has(path.resolve(file))
      ? configurationOverrides.get(path.resolve(file))
      : parseJson(file, out);
    if (!doc) continue;
    scanStrings(doc, file, out);
    const contractId = doc && doc.$contract;
    if (options.includeRuntimeArtifacts === false && RUNTIME_ARTIFACT_CONTRACTS.has(contractId)) {
      continue;
    }
    if (typeof contractId !== 'string' || !schemas.has(contractId)) {
      out.push(violation(
        file,
        'SOTER_CONTRACT',
        'document does not reference a known $contract',
        'untyped JSON silently bypasses the architecture contracts',
        'set $contract to one of the versioned schema identifiers in soter/contracts'
      ));
      continue;
    }
    const failures = schemaErrors(doc, schemas.get(contractId).schema);
    addSchemaViolations(file, failures, out);
    if (!failures.length) documents.push({ file, doc, contractId });
  }

  return { schemas, documents };
}

export function contextVocabularySemanticErrors(vocabulary) {
  if (!vocabulary || !Array.isArray(vocabulary.entries)) return [];
  const errors = [];
  const ids = new Set();
  const terms = new Set();
  const aliases = new Set();
  const normalizeTerm = (value) => String(value).normalize('NFKC').toLowerCase();
  for (const [index, entry] of vocabulary.entries.entries()) {
    if (entry.sequence !== index + 1) errors.push('sequence');
    if (ids.has(entry.id)) errors.push('duplicate-id');
    ids.add(entry.id);
    const term = normalizeTerm(entry.term);
    if (terms.has(term)) errors.push('duplicate-term');
    terms.add(term);
  }
  for (const entry of vocabulary.entries) {
    for (const aliasValue of entry.aliases || []) {
      const alias = normalizeTerm(aliasValue);
      if (terms.has(alias)) errors.push('alias-is-canonical-term');
      if (aliases.has(alias)) errors.push('duplicate-alias');
      aliases.add(alias);
    }
  }
  return [...new Set(errors)];
}

function checkPackGraph(root, documents, out, census, options = {}) {
  const documentsByPath = new Map(
    documents.map((entry) => [path.resolve(entry.file), entry])
  );
  const packs = new Map();
  const capabilities = new Map();
  const hosts = new Map();
  const hostProjectionDefinitions = new Map();
  const configs = [];
  const scenarios = [];
  const workflowDefinitions = new Map();
  const workflowEvaluationSets = new Map();
  const workflowGuides = new Map();
  const migrations = [];
  const legacyInventories = [];
  const locks = [];
  const runs = new Map();
  const evidence = new Map();
  const doctors = new Map();
  const providers = new Map();
  const packSettings = new Map();
  const contextModels = new Map();
  const contextVocabularies = new Map();
  const providerMappings = new Map();
  const snapshots = new Map();
  const automationDecisions = new Map();
  const providerFixtures = new Map();
  const providerProbes = new Map();
  const hostToolCalls = new Map();
  const approvals = new Map();
  const changeSets = new Map();

  const addUniqueRuntimeArtifact = (entries, entry, kind) => {
    if (entries.has(entry.doc.id)) {
      out.push(violation(
        entry.file,
        'SOTER_' + kind.toUpperCase() + '_DUPLICATE',
        'duplicate ' + kind + ' id ' + entry.doc.id,
        'runtime state and evidence references require globally unique identities',
        'rename or remove the duplicate ' + kind + ' artifact'
      ));
    } else {
      entries.set(entry.doc.id, entry);
    }
  };

  for (const entry of documents) {
    if (entry.contractId === 'soter://contracts/pack/v1') {
      census.packs += 1;
      if (packs.has(entry.doc.id)) {
        out.push(violation(
          entry.file,
          'SOTER_PACK_DUPLICATE',
          'duplicate pack id ' + entry.doc.id,
          'pack selection and dependency resolution require globally unique identities',
          'rename or remove one pack manifest'
        ));
      } else {
        packs.set(entry.doc.id, entry);
      }
    } else if (entry.contractId === 'soter://contracts/capability/v1') {
      census.capabilities += 1;
      if (capabilities.has(entry.doc.id)) {
        out.push(violation(
          entry.file,
          'SOTER_CAPABILITY_DUPLICATE',
          'duplicate capability id ' + entry.doc.id,
          'automations must bind one stable capability contract',
          'version the existing contract or choose a different identity'
        ));
      } else {
        capabilities.set(entry.doc.id, entry);
      }
    } else if (entry.contractId === 'soter://contracts/configuration/v1') {
      census.configurations += 1;
      configs.push(entry);
    } else if (entry.contractId === 'soter://contracts/host-adapter/v2') {
      census.hosts += 1;
      if (hosts.has(entry.doc.id)) {
        out.push(violation(
          entry.file,
          'SOTER_HOST',
          'duplicate host adapter id ' + entry.doc.id,
          'one adapter identity must resolve to one declared projection contract',
          'rename or remove the duplicate adapter'
        ));
      } else {
        hosts.set(entry.doc.id, entry);
      }
    } else if (entry.contractId === 'soter://contracts/host-projection-definition/v2') {
      if (hostProjectionDefinitions.has(entry.doc.id)) {
        out.push(violation(
          entry.file,
          'SOTER_HOST_PROJECTION_DEFINITION',
          'duplicate host projection definition ' + entry.doc.id,
          'one versioned host definition must own one deterministic output set',
          'rename or remove the duplicate definition'
        ));
      } else {
        hostProjectionDefinitions.set(entry.doc.id, entry);
      }
    } else if (entry.contractId === 'soter://contracts/scenario/v1') {
      census.scenarios += 1;
      scenarios.push(entry);
    } else if (entry.contractId === 'soter://contracts/workflow-definition/v2') {
      census.workflowDefinitions += 1;
      addUniqueRuntimeArtifact(workflowDefinitions, entry, 'workflow-definition');
    } else if (entry.contractId === 'soter://contracts/workflow-evaluation-set/v2') {
      census.workflowEvaluationSets += 1;
      addUniqueRuntimeArtifact(workflowEvaluationSets, entry, 'workflow-evaluation-set');
    } else if (entry.contractId === 'soter://contracts/workflow-guide/v2') {
      census.workflowGuides += 1;
      addUniqueRuntimeArtifact(workflowGuides, entry, 'workflow-guide');
    } else if (entry.contractId === 'soter://contracts/migration/v1') {
      census.migrations += 1;
      migrations.push(entry);
    } else if (entry.contractId === 'soter://contracts/legacy-inventory/v2') {
      legacyInventories.push(entry);
    } else if (entry.contractId === 'soter://contracts/lock/v1') {
      census.locks += 1;
      locks.push(entry);
    } else if (entry.contractId === 'soter://contracts/run-envelope/v1') {
      census.runEnvelopes += 1;
      addUniqueRuntimeArtifact(runs, entry, 'run');
    } else if (entry.contractId === 'soter://contracts/evidence/v2') {
      census.evidence += 1;
      addUniqueRuntimeArtifact(evidence, entry, 'evidence');
    } else if (entry.contractId === 'soter://contracts/doctor-result/v1') {
      census.doctorResults += 1;
      addUniqueRuntimeArtifact(doctors, entry, 'doctor');
    } else if (entry.contractId === 'soter://contracts/capability-provider/v1') {
      census.providers += 1;
      addUniqueRuntimeArtifact(providers, entry, 'provider');
    } else if (entry.contractId === 'soter://contracts/pack-settings/v1') {
      census.packSettings += 1;
      addUniqueRuntimeArtifact(packSettings, entry, 'pack-settings');
    } else if (entry.contractId === 'soter://contracts/context-record-model/v1') {
      census.contextModels += 1;
      addUniqueRuntimeArtifact(contextModels, entry, 'context-model');
    } else if (entry.contractId === 'soter://contracts/context-vocabulary/v1') {
      addUniqueRuntimeArtifact(contextVocabularies, entry, 'context-vocabulary');
    } else if (entry.contractId === 'soter://contracts/provider-mapping/v1') {
      census.providerMappings += 1;
      addUniqueRuntimeArtifact(providerMappings, entry, 'provider-mapping');
    } else if (entry.contractId === 'soter://contracts/context-snapshot/v1') {
      census.contextSnapshots += 1;
      addUniqueRuntimeArtifact(snapshots, entry, 'context');
    } else if (entry.contractId === 'soter://contracts/automation-decision/v1') {
      census.automationDecisions += 1;
      addUniqueRuntimeArtifact(automationDecisions, entry, 'automation-decision');
    } else if (entry.contractId === 'soter://contracts/provider-fixture/v1') {
      census.providerFixtures += 1;
      addUniqueRuntimeArtifact(providerFixtures, entry, 'fixture');
    } else if (entry.contractId === 'soter://contracts/provider-probe/v2') {
      census.providerProbes += 1;
      addUniqueRuntimeArtifact(providerProbes, entry, 'probe');
    } else if (entry.contractId === 'soter://contracts/host-tool-call/v1') {
      census.hostToolCalls += 1;
      addUniqueRuntimeArtifact(hostToolCalls, entry, 'toolcall');
    }
  }

  for (const entry of contextVocabularies.values()) {
    const relative = path.relative(root, entry.file).split(path.sep).join('/');
    const owner = packs.get(entry.doc.pack);
    const model = documents.find((candidate) => {
      return [
        'soter://contracts/context-record-model/v1',
        'soter://contracts/policy-standard-model/v1'
      ].includes(candidate.contractId)
        && candidate.doc.pack === entry.doc.pack
        && candidate.doc.subject === entry.doc.subject;
    });
    if (!owner
      || owner.doc.layer !== 'context'
      || owner.doc.version !== entry.doc.version
      || !owner.doc.artifacts.some((artifact) => artifact.path === relative)
      || !owner.doc.authorities.some((authority) => {
        return authority.role === 'definition'
          && authority.subject === entry.doc.subject
          && authority.required === true;
      })
      || !model) {
      out.push(violation(
        entry.file,
        'SOTER_CONTEXT_VOCABULARY_OWNER',
        'Context vocabulary is not owned by its exact Context pack, semantic authority, and semantic model',
        'portable term definitions need one mechanically selected Context owner rather than an inferred prose location',
        'align pack, version, artifact inventory, definition authority, subject, and Context semantic model'
      ));
    }
    for (const semanticError of contextVocabularySemanticErrors(entry.doc)) {
      out.push(violation(
        entry.file,
        'SOTER_CONTEXT_VOCABULARY_' + semanticError.toUpperCase().replaceAll('-', '_'),
        'Context vocabulary violates its deterministic term invariant: ' + semanticError,
        'ambiguous ordering, identities, or aliases would allow projections to disagree while citing the same vocabulary',
        'use contiguous declaration order and globally unique canonical terms, ids, and non-canonical aliases'
      ));
    }
  }

  for (const [id, entry] of packs) {
    const expected = path.join(root, 'soter', 'packs', id, 'pack.json');
    if (path.resolve(entry.file) !== path.resolve(expected)) {
      out.push(violation(
        entry.file,
        'SOTER_PACK_PATH',
        'pack ' + id + ' is not stored at soter/packs/' + id + '/pack.json',
        'a deterministic pack path makes discovery independent of host behavior',
        'move the manifest to its canonical path'
      ));
    }
    if (!id.startsWith(entry.doc.layer + '.')) {
      out.push(violation(
        entry.file,
        'SOTER_LAYER',
        'pack id prefix and layer disagree',
        'layer ownership must be machine-readable without inferring it from prose',
        'align the id prefix with layer ' + entry.doc.layer
      ));
    }
    const maturityFloor = {
      declared: 'static',
      'fixture-proven': 'fixture',
      'contained-proven': 'contained',
      'live-proven': 'canary'
    }[entry.doc.evidenceMaturity];
    if (VERIFICATION_LEVELS.indexOf(entry.doc.verification.maxLevel)
      < VERIFICATION_LEVELS.indexOf(maturityFloor)) {
      out.push(violation(
        entry.file,
        'SOTER_MATURITY',
        entry.doc.evidenceMaturity + ' requires at least ' + maturityFloor + ' verification',
        'maturity labels must be derived from evidence rather than author confidence',
        'lower the maturity claim or attach verification at the required level'
      ));
    }
    for (const requirement of entry.doc.sourceRequirements || []) {
      const capability = entry.doc.capabilities.requires.find((item) => {
        return item.id === requirement.capability && !item.optional;
      });
      if (requirement.minimum > requirement.maximum || !capability) {
        out.push(violation(
          entry.file,
          'SOTER_PACK_SOURCE_REQUIREMENT',
          requirement.minimum > requirement.maximum
            ? 'source requirement minimum exceeds its maximum for ' + requirement.purpose
            : 'source requirement ' + requirement.purpose
              + ' has no matching required capability ' + requirement.capability,
          'a pack source requirement must be satisfiable through its declared capability dependencies',
          'correct the cardinality or add the matching non-optional capability requirement'
        ));
      }
    }
    for (const artifact of entry.doc.artifacts || []) {
      if (!fs.existsSync(path.join(root, artifact.path))) {
        out.push(violation(
          entry.file,
          'SOTER_ARTIFACT',
          'declared artifact does not exist: ' + artifact.path,
          'a pack cannot claim an implementation, definition, or evaluation that is absent',
          'create the artifact or remove the declaration'
        ));
      }
    }
    if (entry.doc.operator) {
      if (entry.doc.layer !== 'automation') {
        out.push(violation(
          entry.file,
          'SOTER_OPERATOR_LAYER',
          'operator input and preparation declarations belong only to Automation packs',
          'operator work semantics and outcomes belong to the Automation responsibility layer',
          'move the operator declaration to an Automation pack'
        ));
      }
      const inputArtifact = entry.doc.artifacts.find((artifact) => artifact.path === entry.doc.operator.input
        && artifact.role === 'definition');
      if (!inputArtifact) {
        out.push(violation(
          entry.file,
          'SOTER_OPERATOR_INPUT_OWNERSHIP',
          'operator input is not a declared definition artifact: ' + entry.doc.operator.input,
          'mechanically rendered inputs must evolve with the Automation pack that declares them',
          'declare the operator input path as a definition artifact of this pack'
        ));
      }
      const inputDocument = documentsByPath.get(path.resolve(root, entry.doc.operator.input));
      if (!inputDocument
        || inputDocument.contractId !== 'soter://contracts/automation-input/v1'
        || inputDocument.doc.automation !== entry.doc.id) {
        out.push(violation(
          entry.file,
          'SOTER_OPERATOR_INPUT_CONTRACT',
          'operator input does not declare the exact Automation pack: ' + entry.doc.operator.input,
          'a pack-generated operator form must be bound to the Automation that interprets it',
          'align the input contract automation id and the owning Automation pack'
        ));
      }
      for (const field of inputDocument?.doc?.fields || []) {
        if (field.type === 'string-list'
          && field.constraints.minItems > field.constraints.maxItems) {
          out.push(violation(
            entry.file,
            'SOTER_OPERATOR_INPUT_LIST_BOUNDS',
            'operator string-list minimum exceeds its maximum for field ' + field.id,
            'a mechanically rendered list input must have one satisfiable bounded cardinality',
            'set minItems less than or equal to maxItems'
          ));
        }
        if (field.type === 'string-list'
          && field.constraints.itemMinLength !== undefined
          && field.constraints.itemMaxLength !== undefined
          && field.constraints.itemMinLength > field.constraints.itemMaxLength) {
          out.push(violation(
            entry.file,
            'SOTER_OPERATOR_INPUT_ITEM_BOUNDS',
            'operator string-list item minimum exceeds its maximum for field ' + field.id,
            'every declared list item must have one satisfiable text-length range',
            'set itemMinLength less than or equal to itemMaxLength'
          ));
        }
      }
      if (entry.doc.operator.preparation) {
        const implementation = entry.doc.artifacts.find((artifact) => {
          return artifact.path === entry.doc.operator.preparation.module
            && artifact.role === 'implementation';
        });
        if (!implementation) {
          out.push(violation(
            entry.file,
            'SOTER_PREPARATION_ADAPTER_OWNERSHIP',
            'prepared-work adapter is not a declared implementation artifact: '
              + entry.doc.operator.preparation.module,
            'Core must not execute an unowned or unfingerprinted Automation preparation module',
            'declare the exact preparation module as an implementation artifact of this pack'
          ));
        }
        const derivedReviewPath = entry.doc.operator.preparation.derivedReviewContract;
        if (derivedReviewPath) {
          const definitionArtifact = entry.doc.artifacts.find((artifact) => {
            return artifact.path === derivedReviewPath && artifact.role === 'definition';
          });
          if (!definitionArtifact) {
            out.push(violation(
              entry.file,
              'SOTER_DERIVED_REVIEW_OWNERSHIP',
              'derived review contract is not a declared definition artifact: ' + derivedReviewPath,
              'private domain review vocabulary must evolve with the Automation that interprets it',
              'declare the exact derived review contract as a definition artifact of this pack'
            ));
          }
          const definitionDocument = documentsByPath.get(path.resolve(root, derivedReviewPath));
          if (!definitionDocument
            || definitionDocument.contractId !== 'soter://contracts/automation-derived-review/v1'
            || definitionDocument.doc.automation !== entry.doc.id) {
            out.push(violation(
              entry.file,
              'SOTER_DERIVED_REVIEW_CONTRACT',
              'derived review contract does not declare the exact Automation pack: '
                + derivedReviewPath,
              'Core may enforce a private review shape only when the owning Automation declares it',
              'align the derived review contract automation id and the owning Automation pack'
            ));
          } else {
            const itemKinds = definitionDocument.doc.items.map((item) => item.kind);
            const duplicateFields = definitionDocument.doc.items.some((item) => {
              return new Set(item.fields.map((field) => field.id)).size !== item.fields.length;
            });
            if (new Set(itemKinds).size !== itemKinds.length || duplicateFields) {
              out.push(violation(
                entry.file,
                'SOTER_DERIVED_REVIEW_IDENTITIES',
                'derived review item kinds and field ids must be unique within their declaration',
                'mechanical private review validation requires one exact declaration per item and field',
                'remove duplicate derived review item kinds or field ids'
              ));
            }
          }
        }
      }
      if (entry.doc.operator.acquisition) {
        const acquisition = entry.doc.operator.acquisition;
        const implementation = entry.doc.artifacts.find((artifact) => {
          return artifact.path === acquisition.module && artifact.role === 'implementation';
        });
        if (!implementation) {
          out.push(violation(
            entry.file,
            'SOTER_ACQUISITION_ADAPTER_OWNERSHIP',
            'connected-acquisition adapter is not a declared implementation artifact: '
              + acquisition.module,
            'Core must not execute an unowned or unfingerprinted Automation acquisition module',
            'declare the exact acquisition module as an implementation artifact of this pack'
          ));
        }
        const recordCoverage = new Set();
        for (const requirement of acquisition.recordRequirements) {
          const capabilityRequirement = entry.doc.capabilities.requires.find((candidate) => {
            return candidate.id === requirement.capability && !candidate.optional;
          });
          if (!capabilityRequirement) {
            out.push(violation(
              entry.file,
              'SOTER_ACQUISITION_CAPABILITY_REQUIREMENT',
              'connected acquisition record requirement has no matching non-optional pack capability: '
                + requirement.capability,
              'an acquisition adapter cannot expand provider access beyond its pack capability contract',
              'add the exact non-optional capability requirement or remove the acquisition record requirement'
            ));
          }
          for (const recordType of requirement.recordTypes) {
            const coverageKey = requirement.capability + '|' + recordType;
            if (recordCoverage.has(coverageKey)) {
              out.push(violation(
                entry.file,
                'SOTER_ACQUISITION_RECORD_REQUIREMENT_DUPLICATE',
                'connected acquisition repeats capability and record type ' + coverageKey,
                'configuration target resolution requires one canonical declaration for each acquired record shape',
                'merge the duplicate record type into one capability record requirement'
              ));
            }
            recordCoverage.add(coverageKey);
          }
        }
      }
      if (entry.doc.operator.connection) {
        const connection = entry.doc.operator.connection;
        const implementation = entry.doc.artifacts.find((artifact) => {
          return artifact.path === connection.module
            && artifact.role === 'implementation';
        });
        if (!implementation) {
          out.push(violation(
            entry.file,
            'SOTER_CONNECTED_COMPILER_OWNERSHIP',
            'connected compiler is not a declared implementation artifact: ' + connection.module,
            'Core must not execute an unowned or unfingerprinted Automation compiler',
            'declare the exact connected compiler module as an implementation artifact of this pack'
          ));
        }
        const recordCoverage = new Set();
        for (const requirement of connection.recordRequirements) {
          const capabilityRequirement = entry.doc.capabilities.requires.find((candidate) => {
            return candidate.id === requirement.capability && !candidate.optional;
          });
          if (!capabilityRequirement) {
            out.push(violation(
              entry.file,
              'SOTER_CONNECTION_CAPABILITY_REQUIREMENT',
              'connected operation record requirement has no matching non-optional pack capability: '
                + requirement.capability,
              'a connected compiler cannot expand provider access beyond its pack capability contract',
              'add the exact non-optional capability requirement or remove the connected record requirement'
            ));
          }
          for (const recordType of requirement.recordTypes) {
            const coverageKey = requirement.capability + '|' + recordType;
            if (recordCoverage.has(coverageKey)) {
              out.push(violation(
                entry.file,
                'SOTER_CONNECTION_RECORD_REQUIREMENT_DUPLICATE',
                'connected operation repeats capability and record type ' + coverageKey,
                'configuration target resolution requires one canonical declaration for each connected record shape',
                'merge the duplicate record type into one capability record requirement'
              ));
            }
            recordCoverage.add(coverageKey);
          }
        }
      }
      if (entry.doc.operator.proposal) {
        const proposal = entry.doc.operator.proposal;
        const implementation = entry.doc.artifacts.find((artifact) => {
          return artifact.path === proposal.module && artifact.role === 'implementation';
        });
        if (!implementation) {
          out.push(violation(
            entry.file,
            'SOTER_PROPOSAL_ADAPTER_OWNERSHIP',
            'proposal adapter is not a declared implementation artifact: ' + proposal.module,
            'Core must not execute an unowned or unfingerprinted Automation proposal module',
            'declare the exact proposal module as an implementation artifact of this pack'
          ));
        }
        for (const [label, artifactPath] of [
          ['proposal schema', proposal.schema],
          ['proposal input schema', proposal.inputSchema],
          ['derived review contract', proposal.derivedReviewContract]
        ]) {
          const definitionArtifact = entry.doc.artifacts.find((artifact) => {
            return artifact.path === artifactPath && artifact.role === 'definition';
          });
          if (!definitionArtifact) {
            out.push(violation(
              entry.file,
              'SOTER_PROPOSAL_DEFINITION_OWNERSHIP',
              label + ' is not a declared definition artifact: ' + artifactPath,
              'private proposal semantics must evolve with the Automation pack that interprets them',
              'declare the exact ' + label + ' as a definition artifact of this pack'
            ));
          }
        }
        const derivedReviewDocument = documentsByPath.get(
          path.resolve(root, proposal.derivedReviewContract)
        );
        if (!derivedReviewDocument
          || derivedReviewDocument.contractId !== 'soter://contracts/automation-derived-review/v1'
          || derivedReviewDocument.doc.automation !== entry.doc.id) {
          out.push(violation(
            entry.file,
            'SOTER_PROPOSAL_DERIVED_REVIEW_CONTRACT',
            'proposal derived review contract does not declare the exact Automation pack: '
              + proposal.derivedReviewContract,
            'Core may validate private proposal material only through the owning Automation declaration',
            'align the proposal derived review contract and the owning Automation pack'
          ));
        }
      }
    }
    for (const scenario of entry.doc.verification?.scenarios || []) {
      if (!fs.existsSync(path.join(root, scenario))) {
        out.push(violation(
          entry.file,
          'SOTER_ARTIFACT',
          'declared verification scenario does not exist: ' + scenario,
          'verification claims require inspectable scenarios',
          'create the scenario or remove the claim'
        ));
      }
    }
    for (const dep of entry.doc.dependencies || []) {
      const target = packs.get(dep.pack);
      if (!target) {
        out.push(violation(
          entry.file,
          'SOTER_DEPENDENCY',
          'dependency pack is missing: ' + dep.pack,
          'unresolved dependencies make pack selection incomplete',
          'add the dependency pack or remove the edge'
        ));
      } else if (!satisfies(target.doc.version, dep.version)) {
        out.push(violation(
          entry.file,
          'SOTER_DEPENDENCY',
          dep.pack + ' version ' + target.doc.version + ' does not satisfy ' + dep.version,
          'the resolved graph must honor every declared compatibility range',
          'choose compatible versions or provide a migration'
        ));
      }
    }
  }
  detectDependencyCycles(packs, out);
  checkDefinitionOnlyWorkflows(
    root,
    workflowDefinitions,
    workflowEvaluationSets,
    workflowGuides,
    legacyInventories,
    packs,
    documentsByPath,
    evidence,
    locks,
    options.includeRuntimeArtifacts !== false,
    out
  );

  for (const [id, entry] of capabilities) {
    const expected = path.join(root, 'soter', 'capabilities', id + '.json');
    if (path.resolve(entry.file) !== path.resolve(expected)) {
      out.push(violation(
        entry.file,
        'SOTER_CAPABILITY_PATH',
        'capability ' + id + ' is not stored at soter/capabilities/' + id + '.json',
        'stable paths keep capability lookup deterministic',
        'move the contract to its canonical path'
      ));
    }
    const errors = new Set(entry.doc.errors || []);
    for (const kind of ERROR_KINDS) {
      if (!errors.has(kind)) {
        out.push(violation(
          entry.file,
          'SOTER_ERROR_MODEL',
          'capability error model omits ' + kind,
          'automations need one normalized failure vocabulary across providers',
          'add the missing normalized error kind'
        ));
      }
    }
    if (!entry.doc.inputSchema?.type || !entry.doc.outputSchema?.type) {
      out.push(violation(
        entry.file,
        'SOTER_IO_SCHEMA',
        'capability inputSchema and outputSchema must each declare a root type',
        'typed capability boundaries cannot be enforced from opaque object placeholders',
        'declare the root JSON type for both input and output'
      ));
    }
    for (const [name, ioSchema] of [
      ['inputSchema', entry.doc.inputSchema],
      ['outputSchema', entry.doc.outputSchema]
    ]) {
      const definitionFailures = schemaDefinitionErrors(ioSchema, ioSchema, '$.' + name);
      if (definitionFailures.length) {
        addSchemaDefinitionViolations(
          entry.file,
          definitionFailures,
          out,
          'capability ' + name
        );
      }
    }
    if (!fs.existsSync(path.join(root, entry.doc.health.fixture))) {
      out.push(violation(
        entry.file,
        'SOTER_ARTIFACT',
        'capability health fixture does not exist: ' + entry.doc.health.fixture,
        'health cannot be checked without a stable contained fixture',
        'create the fixture or correct the path'
      ));
    }
  }

  for (const entry of packs.values()) {
    const unavailableHostIds = new Set();
    for (const compatibleHost of entry.doc.compatibility.hosts) {
      if (!hosts.has('host.' + compatibleHost)) {
        out.push(violation(
          entry.file,
          'SOTER_PACK_HOST_COMPATIBILITY',
          'pack declares an unknown compatible host: ' + compatibleHost,
          'every compatible host claim must resolve to one governed host adapter',
          'remove the host or add its governed adapter before declaring compatibility'
        ));
      }
    }
    for (const unavailable of entry.doc.compatibility.unavailableHosts || []) {
      if (unavailableHostIds.has(unavailable.id)
        || entry.doc.compatibility.hosts.includes(unavailable.id)
        || !hosts.has('host.' + unavailable.id)) {
        out.push(violation(
          entry.file,
          'SOTER_PACK_HOST_COMPATIBILITY',
          'pack host compatibility has a duplicate, crossed, or unknown unavailable host: '
            + unavailable.id,
          'one host cannot be both compatible and unavailable, and every declared host fact must resolve to a governed adapter',
          'declare each known unavailable host once and remove it from compatibility.hosts'
        ));
      }
      unavailableHostIds.add(unavailable.id);
    }
    for (const provided of entry.doc.capabilities?.provides || []) {
      const capability = capabilities.get(provided.id);
      if (entry.doc.layer !== 'integration') {
        out.push(violation(
          entry.file,
          'SOTER_CAPABILITY_OWNER',
          'non-integration pack claims integration capability ' + provided.id,
          'provider implementations belong to the integration layer',
          'move the provision to an integration pack'
        ));
      }
      if (!capability) {
        out.push(violation(
          entry.file,
          'SOTER_CAPABILITY',
          'provided capability has no contract: ' + provided.id,
          'a provider cannot implement an undefined interface',
          'add the capability contract or remove the provision'
        ));
      } else {
        if (provided.version !== capability.doc.version) {
          out.push(violation(
            entry.file,
            'SOTER_CAPABILITY',
            provided.id + ' provision version does not match its contract',
            'bindings must identify the exact interface being implemented',
            'align the provision and capability versions'
          ));
        }
        for (const effect of capability.doc.effects) {
          if (!entry.doc.effects.includes(effect)) {
            out.push(violation(
              entry.file,
              'SOTER_EFFECT',
              'pack omits effect ' + effect + ' required by ' + provided.id,
              'pack-level previews must include every transitive capability effect',
              'add the effect to the pack manifest'
            ));
          }
        }
      }
    }
    for (const required of entry.doc.capabilities?.requires || []) {
      const capability = capabilities.get(required.id);
      if (!capability) {
        out.push(violation(
          entry.file,
          'SOTER_CAPABILITY',
          'required capability has no contract: ' + required.id,
          'an automation cannot request an undefined interface',
          'add the capability contract or remove the requirement'
        ));
      } else if (!satisfies(capability.doc.version, required.version)) {
        out.push(violation(
          entry.file,
          'SOTER_CAPABILITY',
          required.id + ' version ' + capability.doc.version + ' does not satisfy ' + required.version,
          'the capability graph must honor declared compatibility',
          'select a compatible contract or update the requirement'
        ));
      } else {
        for (const effect of capability.doc.effects) {
          if (!entry.doc.effects.includes(effect)) {
            out.push(violation(
              entry.file,
              'SOTER_EFFECT',
              'pack omits transitive effect ' + effect + ' from ' + required.id,
              'users must see every effect before selecting an automation',
              'add the effect to the requiring pack manifest'
            ));
          }
        }
      }
    }
  }

  for (const [id, entry] of hosts) {
    const expected = path.join(root, 'soter', 'hosts', entry.doc.host, 'adapter.json');
    if (path.resolve(entry.file) !== path.resolve(expected)) {
      out.push(violation(
        entry.file,
        'SOTER_HOST_PATH',
        'host adapter ' + id + ' is not stored at soter/hosts/' + entry.doc.host + '/adapter.json',
        'deterministic host paths keep projection ownership discoverable',
        'move the adapter manifest to its canonical path'
      ));
    }
    if (id !== 'host.' + entry.doc.host) {
      out.push(violation(
        entry.file,
        'SOTER_HOST',
        'host adapter id and host name disagree',
        'configuration must identify adapters without host-specific guessing',
        'align id with host.' + entry.doc.host
      ));
    }
    const maturityFloor = {
      declared: 'static',
      'fixture-proven': 'fixture',
      'contained-proven': 'contained',
      'live-proven': 'canary'
    }[entry.doc.evidenceMaturity];
    if (VERIFICATION_LEVELS.indexOf(entry.doc.conformance.maxLevel)
      < VERIFICATION_LEVELS.indexOf(maturityFloor)) {
      out.push(violation(
        entry.file,
        'SOTER_MATURITY',
        entry.doc.evidenceMaturity + ' host adapter requires at least ' + maturityFloor + ' conformance',
        'host support must be derived from behavior evidence rather than file presence',
        'lower the maturity claim or attach conformance at the required level'
      ));
    }
    const definitionEntry = hostProjectionDefinitions.get(entry.doc.projectionDefinition.id);
    if (!definitionEntry) {
      out.push(violation(
        entry.file,
        'SOTER_HOST_PROJECTION_DEFINITION',
        'host adapter references an unavailable projection definition',
        'host output ownership and deterministic bytes require one governed definition',
        'add the referenced definition under soter/hosts/' + entry.doc.host
      ));
    } else {
      const expectedDefinitionPath = path.join(root, 'soter', 'hosts', entry.doc.host, 'projection.json');
      if (path.resolve(definitionEntry.file) !== path.resolve(expectedDefinitionPath)
        || entry.doc.projectionDefinition.path
          !== path.relative(root, definitionEntry.file).split(path.sep).join('/')
        || definitionEntry.doc.host !== entry.doc.host
        || definitionEntry.doc.version !== entry.doc.projectionDefinition.version) {
        out.push(violation(
          entry.file,
          'SOTER_HOST_PROJECTION_DEFINITION',
          'host adapter and projection definition identity, version, path, or host disagree',
          'deterministic realization requires one exact adapter-definition binding',
          'align the adapter reference and canonical host projection definition'
        ));
      }
      const adapterProjectionRows = entry.doc.projections.map((projection) => ({
        path: projection.path,
        role: projection.role
      })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      const definitionProjectionRows = definitionEntry.doc.outputs.map((projection) => ({
        path: projection.path,
        role: projection.role
      })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      if (!deepEqual(adapterProjectionRows, definitionProjectionRows)) {
        out.push(violation(
          entry.file,
          'SOTER_HOST_PROJECTION_DEFINITION',
          'host adapter projections do not equal the projection definition outputs',
          'host mechanisms and generated file ownership cannot disagree',
          'align the adapter projections with the definition output paths and roles'
        ));
      }
      const adapterCollectionRows = entry.doc.projectionCollections.map((collection) => ({
        id: collection.id,
        role: collection.role,
        pathPrefix: collection.pathPrefix,
        sourceContract: collection.sourceContract,
        selection: collection.selection
      })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const definitionCollectionRows = definitionEntry.doc.collections.map((collection) => ({
        id: collection.id,
        role: collection.role,
        pathPrefix: collection.pathPrefix,
        sourceContract: collection.sourceContract,
        selection: collection.selection
      })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      if (!deepEqual(adapterCollectionRows, definitionCollectionRows)) {
        out.push(violation(
          entry.file,
          'SOTER_HOST_PROJECTION_DEFINITION',
          'host adapter projection collections do not equal the projection definition collections',
          'dynamic selected-pack ownership must be identical in the adapter and deterministic definition',
          'align every collection id, role, prefix, source contract, and selection rule'
        ));
      }
      const outputIds = new Set();
      const outputPaths = new Set();
      for (const output of definitionEntry.doc.outputs) {
        if (outputIds.has(output.id) || outputPaths.has(output.path)) {
          out.push(violation(
            definitionEntry.file,
            'SOTER_HOST_PROJECTION_DEFINITION',
            'projection output id or path is duplicated: ' + output.id,
            'one managed path must have one stable owner within a host definition',
            'make output ids and paths unique'
          ));
        }
        outputIds.add(output.id);
        outputPaths.add(output.path);
        if (!output.template.startsWith('soter/hosts/' + entry.doc.host + '/templates/')) {
          out.push(violation(
            definitionEntry.file,
            'SOTER_HOST_PROJECTION_TEMPLATE',
            'projection template belongs to another host: ' + output.template,
            'host definitions must own their canonical template sources explicitly',
            'move the template under soter/hosts/' + entry.doc.host + '/templates'
          ));
        }
        const template = path.resolve(root, output.template);
        if (template !== path.resolve(root)
          && !template.startsWith(path.resolve(root) + path.sep)
          || !fs.existsSync(template)
          || !fs.statSync(template).isFile()) {
          out.push(violation(
            definitionEntry.file,
            'SOTER_HOST_PROJECTION_TEMPLATE',
            'projection template is unavailable: ' + output.template,
            'deterministic output bytes require an inspectable canonical template',
            'add the template under the selected host definition'
          ));
        }
      }
      const collectionIds = new Set();
      const collectionPrefixes = new Set();
      for (const collection of definitionEntry.doc.collections) {
        if (collectionIds.has(collection.id) || collectionPrefixes.has(collection.pathPrefix)
          || [...outputPaths].some((outputPath) => outputPath.startsWith(collection.pathPrefix))) {
          out.push(violation(
            definitionEntry.file,
            'SOTER_HOST_PROJECTION_DEFINITION',
            'projection collection id or prefix is duplicated or collides with a static output: ' + collection.id,
            'one managed path family must have one stable host owner',
            'make collection identities and prefixes unique and disjoint from static outputs'
          ));
        }
        collectionIds.add(collection.id);
        collectionPrefixes.add(collection.pathPrefix);
        const itemIds = new Set();
        const itemPaths = new Set();
        for (const output of collection.outputs) {
          if (itemIds.has(output.id) || itemPaths.has(output.relativePath)
            || !output.template.startsWith('soter/hosts/' + entry.doc.host + '/templates/')) {
            out.push(violation(
              definitionEntry.file,
              'SOTER_HOST_PROJECTION_DEFINITION',
              'workflow guide collection output is duplicated or owned by another host: ' + output.id,
              'deterministic generated skill families require unique local paths and host-owned templates',
              'make collection output ids and relative paths unique and move the template under the selected host'
            ));
          }
          itemIds.add(output.id);
          itemPaths.add(output.relativePath);
          const template = path.resolve(root, output.template);
          if (template !== path.resolve(root)
            && !template.startsWith(path.resolve(root) + path.sep)
            || !fs.existsSync(template)
            || !fs.statSync(template).isFile()) {
            out.push(violation(
              definitionEntry.file,
              'SOTER_HOST_PROJECTION_TEMPLATE',
              'workflow guide projection template is unavailable: ' + output.template,
              'deterministic skill bytes require an inspectable canonical template',
              'add the template under the selected host definition'
            ));
          }
        }
      }
    }
    const projectionPaths = new Set(entry.doc.projections.map((projection) => projection.path));
    const serverIds = new Set();
    for (const server of entry.doc.mcpServers) {
      if (serverIds.has(server.id)) {
        out.push(violation(
          entry.file,
          'SOTER_HOST_MCP',
          'host adapter declares duplicate MCP server ' + server.id,
          'provider routing requires one inspectable delivery path per server identity',
          'remove the duplicate MCP server declaration'
        ));
      }
      serverIds.add(server.id);
      const logicalTools = new Set();
      const nativeTools = new Set();
      for (const mapping of server.toolMappings) {
        if (logicalTools.has(mapping.logical) || nativeTools.has(mapping.native)) {
          out.push(violation(
            entry.file,
            'SOTER_HOST_MCP_TOOL',
            'MCP route ' + server.id + ' has an ambiguous logical or native tool mapping',
            'Core must resolve one provider-neutral operation to one exact host tool in both directions',
            'remove duplicate logical and native tool mapping entries'
          ));
        }
        logicalTools.add(mapping.logical);
        nativeTools.add(mapping.native);
      }
      if (server.state === 'configured') {
        if (!server.configurationPath) {
          out.push(violation(
            entry.file,
            'SOTER_HOST_MCP',
            'configured MCP server has no configuration path: ' + server.id,
            'configured state must identify the exact host projection that realizes it',
            'add configurationPath or lower the server state to declared'
          ));
        } else if (!projectionPaths.has(server.configurationPath)) {
          out.push(violation(
            entry.file,
            'SOTER_HOST_MCP',
            'MCP server configuration is absent from host projections: ' + server.configurationPath,
            'tool delivery cannot be inferred from unowned or missing host files',
            'add the path as a host projection and ensure the file exists'
          ));
        }
      }
    }
    for (const scenario of entry.doc.conformance.scenarios) {
      if (!fs.existsSync(path.join(root, scenario))) {
        out.push(violation(
          entry.file,
          'SOTER_HOST_PROJECTION',
          'declared host conformance scenario does not exist: ' + scenario,
          'host support claims require inspectable behavior scenarios',
          'create the scenario or remove the claim'
        ));
      }
    }
  }

  for (const [id, definitionEntry] of hostProjectionDefinitions) {
    const owners = [...hosts.values()].filter((host) => host.doc.projectionDefinition.id === id);
    if (owners.length !== 1) {
      out.push(violation(
        definitionEntry.file,
        'SOTER_HOST_PROJECTION_DEFINITION',
        'projection definition has ' + owners.length + ' owning host adapters',
        'unowned or multiply owned output definitions create ambiguous file authority',
        'bind the definition from exactly one host adapter'
      ));
    }
  }

  if (legacyInventories.length !== 1) {
    out.push(violation(
      path.join(root, 'soter', 'migrations', 'legacy-inventory.json'),
      'SOTER_MIGRATION_INVENTORY',
      'expected exactly one governed legacy inventory but found ' + legacyInventories.length,
      'migration promotion must reconcile against one complete source classification',
      'restore the single legacy-inventory/v2 document before promoting migration state'
    ));
  }
  const legacyInventory = legacyInventories.length === 1 ? legacyInventories[0] : null;

  checkPackSettings(root, packSettings, packs, out);
  checkContextRecordModels(root, contextModels, packs, out);
  for (const config of configs) {
    checkConfiguration(
      root,
      config,
      packs,
      capabilities,
      hosts,
      packSettings,
      contextModels,
      providerMappings,
      out
    );
  }
  for (const scenario of scenarios) {
    checkScenario(root, scenario, packs, capabilities, configs, legacyInventory, out);
  }
  for (const migration of migrations) {
    checkMigration(
      root,
      migration,
      packs,
      configs,
      legacyInventory,
      options.includeRuntimeArtifacts !== false,
      out
    );
  }

  checkCapabilityProviders(
    root,
    providers,
    providerFixtures,
    providerMappings,
    contextModels,
    packSettings,
    packs,
    capabilities,
    hosts,
    out
  );
  checkRuntimeArtifacts(
    root,
    locks,
    runs,
    evidence,
    doctors,
    snapshots,
    automationDecisions,
    contextModels,
    providers,
    providerProbes,
    hostToolCalls,
    approvals,
    changeSets,
    hosts,
    out
  );

  return {
    packs,
    capabilities,
    hosts,
    configs,
    scenarios,
    workflowDefinitions,
    workflowEvaluationSets,
    workflowGuides,
    migrations,
    locks,
    runs,
    evidence,
    doctors,
    providers,
    packSettings,
    contextModels,
    providerMappings,
    snapshots,
    automationDecisions,
    providerFixtures,
    providerProbes,
    hostToolCalls,
    approvals,
    changeSets
  };
}

function checkContractSchemaOwnership(root, schemas, packs, out) {
  const owners = new Map();
  for (const pack of packs.values()) {
    for (const artifact of pack.doc.artifacts || []) {
      const artifactPath = path.resolve(root, artifact.path);
      const artifactOwners = owners.get(artifactPath) || [];
      artifactOwners.push(pack.doc.id);
      owners.set(artifactPath, artifactOwners);
    }
  }
  for (const entry of schemas.values()) {
    const schemaOwners = owners.get(path.resolve(entry.file)) || [];
    if (schemaOwners.length !== 1) {
      out.push(violation(
        entry.file,
        'SOTER_SCHEMA_OWNERSHIP',
        schemaOwners.length === 0
          ? 'contract schema is not sealed by a governed pack'
          : 'contract schema is owned by multiple governed packs: ' + schemaOwners.join(', '),
        'runtime-used contracts outside one exact pack graph can drift without invalidating releases, locks, or host runtime inspection',
        'declare the schema exactly once as a definition artifact in its governing pack'
      ));
    }
  }
}

function fingerprintWithoutField(document, field) {
  const unsigned = structuredClone(document);
  delete unsigned[field];
  return fingerprintJson(unsigned);
}

function normalizedWorkflowEvidenceReferences(references) {
  return [...(references || [])]
    .map((reference) => ({
      host: reference.host,
      path: reference.path,
      fingerprint: reference.fingerprint
    }))
    .sort((left, right) => {
      const leftKey = left.host + '\0' + left.path + '\0' + left.fingerprint;
      const rightKey = right.host + '\0' + right.path + '\0' + right.fingerprint;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

function artifactRoleMatches(document, role, expected) {
  const matches = (document?.artifacts || []).filter((artifact) => artifact.role === role);
  const expectedRows = Array.isArray(expected) ? expected : [expected];
  return matches.length === expectedRows.length
    && expectedRows.every((row) => matches.filter((artifact) => {
      return Object.entries(row).every(([key, value]) => artifact[key] === value);
    }).length === 1);
}

function inspectActiveWorkflowEvidence({
  root,
  definitionEntry,
  guideEntry,
  evaluationEntry,
  guidePath,
  documentsByPath,
  evidence,
  requireFinalEvidence
}) {
  const findings = [];
  const add = (code, what, why, fix) => findings.push({ code, what, why, fix });
  const definitionReferences = definitionEntry.doc.lifecycle.activation?.evidence || [];
  const guideReferences = guideEntry.doc.status.evidence || [];
  const normalizedDefinitionReferences = normalizedWorkflowEvidenceReferences(definitionReferences);
  const normalizedGuideReferences = normalizedWorkflowEvidenceReferences(guideReferences);
  const guideHosts = guideReferences.map((reference) => reference.host).sort();
  const distinctReferenceShape = guideReferences.length === 2
    && new Set(guideReferences.map((reference) => reference.host)).size === 2
    && new Set(guideReferences.map((reference) => reference.path)).size === 2
    && new Set(guideReferences.map((reference) => reference.fingerprint)).size === 2
    && deepEqual(guideHosts, ['claude', 'codex']);
  if (!distinctReferenceShape
    || !deepEqual(normalizedDefinitionReferences, normalizedGuideReferences)) {
    add(
      'SOTER_WORKFLOW_GUIDE_EVIDENCE_REFERENCE_SET',
      'active workflow definition and guide do not share exactly two distinct historical Codex and Claude receipt references',
      'active documents must bind stable no-authority historical receipts without referencing current final evidence and creating a fingerprint cycle',
      'bind definition activation and guide status to the same two distinct development-agent-migration-evidence/v1 documents'
    );
  }

  const stableSubjectFingerprint = fingerprintWorkflowEvaluatedSubject({
    definition: definitionEntry.doc,
    guide: guideEntry.doc,
    evaluations: evaluationEntry.doc
  });
  let workflowSources = [];
  try {
    workflowSources = workflowLegacySourceProjection({
      definition: definitionEntry.doc,
      guide: guideEntry.doc,
      evaluations: evaluationEntry.doc
    });
  } catch {
    add(
      'SOTER_WORKFLOW_GUIDE_SOURCE_SET',
      'active workflow source tombstones are partial, duplicated, or inconsistent',
      'the evaluated workflow covers one procedural source and every exact evaluation source as one atomic migration basis',
      'preserve every exact source path and fingerprint and move the complete set from present to removed together'
    );
  }
  const historicalSourceArtifacts = workflowSources.map((source) => ({
    subjectId: definitionEntry.doc.id,
    path: source.path,
    fingerprint: source.fingerprint
  }));
  const finalSourceArtifacts = workflowSources.map((source) => ({
    path: source.path,
    fingerprint: source.fingerprint
  }));
  const receiptsByHost = new Map();
  for (const reference of guideReferences) {
    const receiptFile = resolveRegularRepositoryFile(root, reference.path);
    const receiptEntry = receiptFile
      ? documentsByPath.get(path.resolve(receiptFile))
      : null;
    if (!receiptEntry
      || receiptEntry.contractId !== 'soter://contracts/development-agent-migration-evidence/v1'
      || reference.fingerprint !== fingerprintJson(receiptEntry.doc)
      || receiptEntry.doc.evidenceFingerprint
        !== fingerprintWithoutField(receiptEntry.doc, 'evidenceFingerprint')) {
      add(
        'SOTER_WORKFLOW_GUIDE_EVIDENCE',
        'active workflow guide historical receipt is missing, malformed, tampered, or not bound by its exact reference fingerprint',
        'schema-valid activation metadata is not evidence unless the referenced immutable historical receipt is independently intact',
        'restore the exact self-fingerprinted development-agent-migration-evidence/v1 receipt and its full-document reference fingerprint'
      );
      continue;
    }
    const receipt = receiptEntry.doc;
    if (receipt.host.id !== reference.host) {
      add(
        'SOTER_WORKFLOW_GUIDE_EVIDENCE_HOST',
        'historical workflow evidence host does not match its active reference: ' + reference.host,
        'a caller-declared host label cannot substitute a receipt produced by the other evaluated host',
        'bind each Codex or Claude reference to a receipt whose sealed host identity matches exactly'
      );
    }
    const runInspection = inspectWorkflowEvaluationRunSet({
      definition: definitionEntry.doc,
      evaluations: evaluationEntry.doc,
      runs: receipt.runs
    });
    const exactConclusion = deepEqual(receipt.conclusion, {
      state: 'passed',
      behaviorParity: 'passed',
      baselineRole: 'observed-non-gating',
      guidedRunsPassed: true,
      prohibitedOutcomesObserved: runInspection.prohibitedOutcomesObserved,
      externalEffectsObserved: false
    });
    const noAuthority = deepEqual(receipt.authority, {
      kind: 'migration-evidence-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsActivation: false,
      grantsMigration: false,
      grantsPublication: false,
      grantsMerge: false,
      grantsProviderRead: false,
      grantsProviderWrite: false,
      grantsHostRealization: false,
      grantsPromotion: false,
      grantsFallbackRemoval: false
    });
    const exactReceiptBinding = workflowSources.length > 0
      && receipt.result?.state === 'passed'
      && receipt.applicability?.kind === 'historical-candidate-only'
      && receipt.applicability?.evaluatedSubjectFingerprint === stableSubjectFingerprint
      && receipt.workflow?.id === definitionEntry.doc.id
      && receipt.workflow?.version === definitionEntry.doc.version
      && receipt.evaluatedSubject?.id === guideEntry.doc.id
      && receipt.evaluatedSubject?.version === definitionEntry.doc.version
      && receipt.evaluatedSubject?.fingerprint === stableSubjectFingerprint
      && receipt.evaluationSet?.id === evaluationEntry.doc.id
      && receipt.evaluationSet?.version === evaluationEntry.doc.version
      && artifactRoleMatches(receipt, 'migration-source', historicalSourceArtifacts)
      && artifactRoleMatches(receipt, 'migration-target', {
        subjectId: guideEntry.doc.id,
        path: guidePath,
        fingerprint: stableSubjectFingerprint
      })
      && historicalWorkflowEvidenceChronologyIsValid(receipt)
      && historicalWorkflowEvidenceWorkspaceIsStable(receipt)
      && exactConclusion
      && noAuthority;
    if (!exactReceiptBinding) {
      add(
        'SOTER_WORKFLOW_GUIDE_EVIDENCE',
        'historical workflow receipt does not bind the exact tombstoned source, stable evaluated subject, guide target, passed conclusion, and no-authority boundary',
        'historical candidate observations can support migration only when every stable semantic join remains exact after activation',
        'recreate the receipt from the exact development observation rather than editing its workflow, subject, artifacts, conclusion, or authority facts'
      );
    }
    if (runInspection.coverageComplete !== true
      || runInspection.verdictsConsistent !== true
      || runInspection.guidedPassed !== true
      || runInspection.inputBoundaryPreserved !== true) {
      add(
        'SOTER_WORKFLOW_GUIDE_EVIDENCE_COVERAGE',
        'historical workflow receipt does not contain the exact ordered run, case, stimulus, criterion, fresh-worker, verdict, input-boundary, and guided qualification facts',
        'partial, substituted, internally inconsistent, or answer-key-exposed run coverage cannot establish behavior parity for the complete governed evaluation set',
        'evaluate the exact non-gating baseline and every guided case with unique workers, sealed stimuli and criteria, coherent verdicts, and no answer-key access'
      );
    }
    if (receipt.host.id === reference.host && !receiptsByHost.has(reference.host)) {
      receiptsByHost.set(reference.host, { reference, entry: receiptEntry });
    }
  }

  const finalCandidates = [...evidence.values()].filter((entry) => {
    return entry.contractId === 'soter://contracts/evidence/v2'
      && entry.doc.claimFamily === 'migration'
      && entry.doc.subject?.type === 'automation'
      && entry.doc.subject.id === definitionEntry.doc.id
      && entry.doc.subject.version === definitionEntry.doc.version;
  });
  const finalHosts = finalCandidates.map((entry) => entry.doc.host?.id).sort();
  if (requireFinalEvidence
    && (finalCandidates.length !== 2 || !deepEqual(finalHosts, ['claude', 'codex']))) {
    add(
      'SOTER_WORKFLOW_GUIDE_FINAL_EVIDENCE',
      'active workflow does not have exactly one immutable migration evidence/v2 record for each Codex and Claude host',
      'historical receipts are no-authority observations; target activation additionally requires one uniquely discoverable final claim per host and workflow whose current applicability is checked separately',
      'restore exactly one passed agent-or-higher migration evidence/v2 record per host and exact workflow subject'
    );
  }
  const finalEvidencePaths = [];
  if (!requireFinalEvidence) return { findings, finalEvidencePaths };
  for (const host of ['codex', 'claude']) {
    const hostCandidates = finalCandidates.filter((entry) => entry.doc.host?.id === host);
    if (hostCandidates.length !== 1) continue;
    const finalEntry = hostCandidates[0];
    const finalEvidence = finalEntry.doc;
    finalEvidencePaths.push(path.relative(root, finalEntry.file).split(path.sep).join('/'));
    const receiptBinding = receiptsByHost.get(host);
    const level = VERIFICATION_LEVELS.indexOf(finalEvidence.evaluator?.level);
    if (finalEvidence.result !== 'passed'
      || level < VERIFICATION_LEVELS.indexOf('agent')) {
      add(
        'SOTER_WORKFLOW_GUIDE_FINAL_EVIDENCE',
        'final workflow migration evidence is not a passed agent-or-higher result for host ' + host,
        'activation cannot be inferred from static normalization, failed evaluation, or a lower-confidence verifier',
        'record a passed agent-or-higher final migration claim against the exact current lock'
      );
    }
    const exactArtifacts = workflowSources.length > 0
      && receiptBinding
      && artifactRoleMatches(finalEvidence, 'migration-source', finalSourceArtifacts)
      && artifactRoleMatches(finalEvidence, 'migration-target', [{
        path: guidePath,
        fingerprint: guideEntry.doc.contentFingerprint
      }, {
        path: path.relative(root, evaluationEntry.file).split(path.sep).join('/'),
        fingerprint: fingerprintJson(evaluationEntry.doc)
      }])
      && artifactRoleMatches(finalEvidence, 'development-agent-migration-evidence', {
        path: receiptBinding.reference.path,
        fingerprint: fingerprintJson(receiptBinding.entry.doc)
      })
      && artifactRoleMatches(finalEvidence, 'workflow-evaluated-subject', {
        subjectId: guideEntry.doc.id,
        fingerprint: stableSubjectFingerprint
      })
      && artifactRoleMatches(finalEvidence, 'workflow-evaluated-instructions', {
        host,
        subjectId: guideEntry.doc.id,
        fingerprint: receiptBinding.entry.doc.host.evaluatedInstructionFingerprint
      })
      && artifactRoleMatches(finalEvidence, 'workflow-definition', {
        path: path.relative(root, definitionEntry.file).split(path.sep).join('/'),
        fingerprint: fingerprintJson(definitionEntry.doc)
      })
      && artifactRoleMatches(finalEvidence, 'workflow-evaluation-set', {
        path: path.relative(root, evaluationEntry.file).split(path.sep).join('/'),
        fingerprint: fingerprintJson(evaluationEntry.doc)
      });
    if (!exactArtifacts) {
      add(
        'SOTER_WORKFLOW_GUIDE_FINAL_EVIDENCE_BINDING',
        'final workflow migration evidence does not seal the exact historical receipt, source tombstone, stable subject/instructions, and final definition/evaluation artifacts for host ' + host,
        'a final record must join the historical observation to the exact post-migration canonical graph without reusing another host or workflow receipt',
        'regenerate the final evidence from the matching host receipt and exact final workflow documents'
      );
    }
  }
  return { findings, finalEvidencePaths };
}

function inspectRetiredWorkflowEvidence({
  root,
  id,
  definitionEntry,
  guideEntry,
  evaluationEntry,
  guidePath,
  legacyInventories,
  documentsByPath,
  locks,
  requireFinalEvidence
}) {
  let workflowSources = [];
  try {
    workflowSources = workflowLegacySourceProjection({
      definition: definitionEntry.doc,
      guide: guideEntry.doc,
      evaluations: evaluationEntry.doc
    });
  } catch {
    return [{ code: 'SOTER_WORKFLOW_GUIDE_RETIREMENT_INVALID' }];
  }
  const legacySourceFile = resolveRegularRepositoryFile(root, guideEntry.doc.source.legacyPath);
  const exactLegacySourcePresent = legacySourceFile
    && fingerprintFile(legacySourceFile) === guideEntry.doc.source.legacyFingerprint;
  const retiredSourceInvalid = guideEntry.doc.source.presence !== 'removed'
    || definitionEntry.doc.source.presence !== 'removed'
    || Boolean(exactLegacySourcePresent)
    || evaluationEntry.doc.cases.some((item) => item.source.presence !== 'removed');
  const retiredInventoryInvalid = workflowSources.length === 0
    || workflowSources.some((source) => {
      const inventoryItems = legacyInventories.length === 1
        ? legacyInventories[0].doc.items.filter((item) => {
          return item.sourcePath === source.path && item.sourceFingerprint === source.fingerprint;
        })
        : [];
      const targetPath = source.kind === 'workflow-guide'
        ? guidePath
        : guideEntry.doc.workflow.evaluationSetPath;
      const retirementBindings = inventoryItems.length === 1
        ? inventoryItems[0].targets.filter((binding) => {
          return binding.id === id && binding.path === targetPath;
        })
        : [];
      return inventoryItems.length !== 1
        || inventoryItems[0].sourcePresence !== 'removed'
        || !['migrated', 'retired'].includes(inventoryItems[0].state)
        || retirementBindings.length !== 1
        || retirementBindings[0].state !== 'retired'
        || retirementBindings[0].canonicalAuthority !== 'none'
        || retirementBindings[0].fallback !== 'removed'
        || !['intentional-change', 'proven'].includes(retirementBindings[0].parity)
        || !deepEqual(
          [...retirementBindings[0].evidence].sort(),
          guideEntry.doc.status.evidence.map((reference) => reference.path).sort()
        );
    });
  const retirementReferencesAligned = deepEqual(
    guideEntry.doc.status.evidence,
    definitionEntry.doc.lifecycle.retirement.evidence
  );
  let retiredEvidenceInvalid = !retirementReferencesAligned;
  for (const reference of requireFinalEvidence ? guideEntry.doc.status.evidence : []) {
    const normalizedRetirementPath = typeof reference.path === 'string'
      && reference.path.startsWith('soter/fixtures/')
      && !reference.path.includes('\\')
      && !reference.path.includes('//')
      && !reference.path.split('/').some((segment) => segment === '.' || segment === '..')
      && path.normalize(reference.path).split(path.sep).join('/') === reference.path;
    const evidenceFile = resolveRegularRepositoryFile(root, reference.path);
    const evidenceEntry = evidenceFile ? documentsByPath.get(path.resolve(evidenceFile)) : null;
    const exactSource = workflowSources.length > 0
      && artifactRoleMatches(evidenceEntry?.doc, 'migration-source', workflowSources.map((source) => ({
        path: source.path,
        fingerprint: source.fingerprint
      })));
    const exactTargets = artifactRoleMatches(evidenceEntry?.doc, 'migration-target', [{
      path: guidePath,
      fingerprint: guideEntry.doc.contentFingerprint
    }, {
      path: guideEntry.doc.workflow.evaluationSetPath,
      fingerprint: fingerprintJson(evaluationEntry.doc)
    }]);
    const exactLock = evidenceEntry
      ? locks.find((entry) => {
        return fingerprintJson(entry.doc) === evidenceEntry.doc.configurationLockFingerprint;
      })
      : null;
    const exactRetirementFacts = evidenceEntry?.doc.subject?.type === 'pack'
      && evidenceEntry.doc.subject.id === id
      && evidenceEntry.doc.subject.version === definitionEntry.doc.version
      && evidenceEntry.doc.evaluator?.id === 'kernel.legacy-migration-completion'
      && evidenceEntry.doc.evaluator?.level === 'fixture'
      && evidenceEntry.doc.environment?.containment === 'fixture'
      && evidenceEntry.doc.effects?.length === 0
      && evidenceEntry.doc.failures?.length === 0
      && evidenceEntry.doc.outcomes?.some((outcome) => {
        return outcome.id === 'migration-disposition' && outcome.state === 'retired';
      })
      && evidenceEntry.doc.outcomes?.some((outcome) => {
        return outcome.id === 'migration-parity' && outcome.state === 'intentional-change';
      })
      && evidenceEntry.doc.outcomes?.some((outcome) => {
        return outcome.id === 'runtime-authority-absent' && outcome.state === 'passed';
      });
    retiredEvidenceInvalid ||= !normalizedRetirementPath
      || !evidenceEntry
      || evidenceEntry.contractId !== 'soter://contracts/evidence/v2'
      || evidenceEntry.doc.claimFamily !== 'migration'
      || evidenceEntry.doc.result !== 'passed'
      || exactSource !== true
      || exactTargets !== true
      || !exactLock
      || exactLock.doc.configuration?.name !== 'harness-development-catalog'
      || evidenceEntry.doc.graphFingerprint !== exactLock.doc.graphFingerprint
      || exactRetirementFacts !== true;
  }
  return retiredSourceInvalid || retiredInventoryInvalid || retiredEvidenceInvalid
    ? [{ code: 'SOTER_WORKFLOW_GUIDE_RETIREMENT_INVALID' }]
    : [];
}

function checkDefinitionOnlyWorkflows(
  root,
  workflowDefinitions,
  workflowEvaluationSets,
  workflowGuides,
  legacyInventories,
  packs,
  documentsByPath,
  evidence,
  locks,
  requireFinalEvidence,
  out
) {
  const evaluationOwners = new Map();
  const guideOwners = new Map();

  for (const [id, entry] of workflowDefinitions) {
    const slug = id.slice('automation.'.length);
    const expectedDefinitionPath = path.join(
      root,
      'soter',
      'automations',
      slug,
      'definition.json'
    );
    if (path.resolve(entry.file) !== path.resolve(expectedDefinitionPath)) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_DEFINITION_PATH',
        'definition-only workflow is not stored at soter/automations/' + slug + '/definition.json',
        'one canonical path keeps workflow discovery independent of host projections and legacy layout',
        'move the workflow definition to its canonical Automation path'
      ));
    }

    const pack = packs.get(id);
    if (!pack || pack.doc.layer !== 'automation' || pack.doc.version !== entry.doc.version) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_DEFINITION_OWNER',
        'definition-only workflow has no exact matching Automation pack and version',
        'portable outcome definitions must be owned and versioned by one selectable Automation pack',
        'add or align the exact Automation pack manifest'
      ));
      continue;
    }

    const definitionPath = path.relative(root, entry.file).split(path.sep).join('/');
    const definitionArtifact = pack.doc.artifacts.filter((artifact) => {
      return artifact.path === definitionPath && artifact.role === 'definition';
    });
    const evaluationPath = entry.doc.evaluationSet.path;
    const evaluationArtifact = pack.doc.artifacts.filter((artifact) => {
      return artifact.path === evaluationPath && artifact.role === 'evaluation';
    });
    if (definitionArtifact.length !== 1 || evaluationArtifact.length !== 1) {
      out.push(violation(
        pack.file,
        'SOTER_WORKFLOW_DEFINITION_ARTIFACTS',
        'definition-only pack must own exactly one declared definition and its exact evaluation set',
        'a definition or evaluation outside the owning pack can drift without invalidating selection',
        'declare the exact definition and evaluation paths once with their required roles'
      ));
    }

    const evaluationEntry = documentsByPath.get(path.resolve(root, evaluationPath));
    if (!evaluationEntry
      || evaluationEntry.contractId !== 'soter://contracts/workflow-evaluation-set/v2'
      || evaluationEntry.doc.id !== entry.doc.evaluationSet.id
      || evaluationEntry.doc.workflow !== id
      || evaluationEntry.doc.version !== entry.doc.version) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_EVALUATION_BINDING',
        'workflow definition does not bind one exact matching evaluation set',
        'normalized behavior expectations must version and move with the workflow definition they constrain',
        'align the evaluation path, id, workflow id, and version'
      ));
    } else {
      const ownerIds = evaluationOwners.get(evaluationEntry.doc.id) || [];
      ownerIds.push(id);
      evaluationOwners.set(evaluationEntry.doc.id, ownerIds);
    }

    const guideId = 'workflow-guide.' + slug;
    const guideEntry = workflowGuides.get(guideId);
    const guidePath = 'soter/automations/' + slug + '/guide.json';
    if (!guideEntry) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_GUIDE_BINDING',
        'definition-only workflow has no exact provider-neutral workflow guide ' + guideId,
        'a normalized outcome skeleton alone cannot safely replace the procedural legacy guide or project a host skill',
        'add the exact candidate workflow guide and keep legacy procedural authority until behavior parity is evidenced'
      ));
    } else {
      const owners = guideOwners.get(guideId) || [];
      owners.push(id);
      guideOwners.set(guideId, owners);

      const expectedGuideFile = path.join(root, guidePath);
      if (path.resolve(guideEntry.file) !== path.resolve(expectedGuideFile)) {
        out.push(violation(
          guideEntry.file,
          'SOTER_WORKFLOW_GUIDE_PATH',
          'workflow guide is not stored at ' + guidePath,
          'one canonical Automation path keeps procedural guidance independent of host-specific skill layout',
          'move the guide to the canonical workflow directory'
        ));
      }

      const guideArtifacts = pack.doc.artifacts.filter((artifact) => {
        return artifact.path === guidePath && artifact.role === 'definition';
      });
      if (guideArtifacts.length !== 1) {
        out.push(violation(
          pack.file,
          'SOTER_WORKFLOW_GUIDE_ARTIFACT',
          'definition-only pack must own exactly one workflow guide artifact at ' + guidePath,
          'an undeclared or multiply declared guide can drift outside the selected pack graph',
          'declare the exact guide path once with the definition role'
        ));
      }

      if (!workflowGuideContentFingerprintMatches(guideEntry.doc)) {
        out.push(violation(
          guideEntry.file,
          'SOTER_WORKFLOW_GUIDE_CONTENT_FINGERPRINT',
          'workflow guide content fingerprint does not seal its exact provider-neutral semantics',
          'activation evidence must bind stable guide content without becoming self-referential through the guide evidence list',
          'recompute contentFingerprint from the guide with contentFingerprint and status excluded'
        ));
      }

      const exactGuideBinding = guideEntry.doc.id === guideId
        && entry.doc.guide.id === guideId
        && entry.doc.guide.path === guidePath
        && guideEntry.doc.workflow.id === id
        && guideEntry.doc.workflow.version === entry.doc.version
        && guideEntry.doc.workflow.definitionPath === definitionPath
        && guideEntry.doc.workflow.definitionFingerprint === fingerprintJson(entry.doc)
        && guideEntry.doc.workflow.evaluationSetPath === evaluationPath
        && evaluationEntry
        && guideEntry.doc.workflow.evaluationSetFingerprint === fingerprintJson(evaluationEntry.doc)
        && guideEntry.doc.skill.name === slug
        && guideEntry.doc.source.legacyPath === entry.doc.source.legacyPath
        && guideEntry.doc.source.legacyFingerprint === entry.doc.source.legacyFingerprint;
      if (!exactGuideBinding) {
        out.push(violation(
          guideEntry.file,
          'SOTER_WORKFLOW_GUIDE_BINDING',
          'workflow guide does not bind the exact workflow, evaluation set, skill identity, and legacy source fingerprints',
          'procedural detail must version and move with the exact normalized workflow and behavior expectations it explains',
          'align every workflow, evaluation, skill, source path, version, and canonical JSON fingerprint'
        ));
      }

      const definitionLifecycle = entry.doc.lifecycle;
      const evaluationLifecycle = evaluationEntry?.doc.lifecycle;
      const lifecycleAligned = definitionLifecycle.state === 'definition-only'
        ? evaluationLifecycle?.state === 'definition-only'
          && guideEntry.doc.status.state === 'candidate'
        : definitionLifecycle.state === 'active-host-guided'
          ? evaluationLifecycle?.state === 'active-host-guided'
            && evaluationLifecycle.activation === definitionLifecycle.activation.state
            && guideEntry.doc.status.state === definitionLifecycle.activation.state
          : definitionLifecycle.state === 'retired'
            && evaluationLifecycle?.state === 'retired'
            && evaluationLifecycle.retirement === definitionLifecycle.retirement.state
            && guideEntry.doc.status.state === (definitionLifecycle.retirement.state === 'candidate'
              ? 'retirement-candidate'
              : 'retired');
      const developmentBindingsAligned = definitionLifecycle.state !== 'active-host-guided'
        || (definitionLifecycle.development.requestContract.id === 'soter://contracts/development-request/v1'
          && definitionLifecycle.development.requestContract.path === 'soter/contracts/development-request.schema.json'
          && definitionLifecycle.development.resultContract.id === 'soter://contracts/development-result/v1'
          && definitionLifecycle.development.resultContract.path === 'soter/contracts/development-result.schema.json'
          && definitionLifecycle.development.workspacePolicy.path === 'soter/kernel/development-workspace.settings.json'
          && definitionLifecycle.development.workspacePolicy.fingerprint === fingerprintJson(
            documentsByPath.get(path.resolve(root, definitionLifecycle.development.workspacePolicy.path))?.doc
          )
          && deepEqual([...definitionLifecycle.development.supportedHosts].sort(), ['claude', 'codex'])
          && evaluationEntry.doc.evaluationPolicy.requestContract.id === definitionLifecycle.development.requestContract.id
          && evaluationEntry.doc.evaluationPolicy.requestContract.path === definitionLifecycle.development.requestContract.path
          && evaluationEntry.doc.evaluationPolicy.resultContract.id === definitionLifecycle.development.resultContract.id
          && evaluationEntry.doc.evaluationPolicy.resultContract.path === definitionLifecycle.development.resultContract.path
          && deepEqual([...evaluationEntry.doc.evaluationPolicy.supportedHosts].sort(), ['claude', 'codex']));
      if (!lifecycleAligned || !developmentBindingsAligned) {
        out.push(violation(
          entry.file,
          'SOTER_WORKFLOW_LIFECYCLE_BINDING',
          'workflow definition, guide, evaluation lifecycle, or private development contract binding disagrees',
          'host delivery and development evidence must follow one closed lifecycle without manufacturing runtime authority',
          'align definition, guide, evaluation activation or retirement state and exact private development bindings'
        ));
      }
      if (definitionLifecycle.state === 'retired'
        && new Set(definitionLifecycle.replacements.map((replacement) => replacement.id)).size
          !== definitionLifecycle.replacements.length) {
        out.push(violation(
          entry.file,
          'SOTER_WORKFLOW_RETIREMENT_REPLACEMENT_DUPLICATE',
          'retired workflow declares a replacement identity more than once',
          'retirement must expose one deterministic and explainable replacement or unavailable fact per identity',
          'merge duplicate replacement declarations and retain their combined limitations'
        ));
      }

      const legacySourceFile = resolveRegularRepositoryFile(root, guideEntry.doc.source.legacyPath);
      const exactLegacySourcePresent = legacySourceFile
        && fingerprintFile(legacySourceFile) === guideEntry.doc.source.legacyFingerprint;
      if (['candidate', 'retirement-candidate'].includes(guideEntry.doc.status.state)
        && !exactLegacySourcePresent) {
        out.push(violation(
          guideEntry.file,
          'SOTER_WORKFLOW_GUIDE_SOURCE',
          'candidate guide is not bound to one existing exact legacy procedural authority',
          'preview-only guidance cannot be compared honestly when its retained canonical source is missing or changed',
          'restore the exact source or refresh the definition, evaluation, guide, migration evidence, and inventory together'
        ));
      }

      const procedureIdentity = entry.doc.procedure.map((step) => ({
        id: step.id,
        sequence: step.sequence
      }));
      const guideProcedureIdentity = guideEntry.doc.stepDetails.map((step) => ({
        id: step.id,
        sequence: step.sequence
      }));
      const uniqueGotchas = new Set(guideEntry.doc.gotchas.map((item) => item.id));
      const uniqueReferences = new Set(guideEntry.doc.references.map((item) => item.id));
      if (!deepEqual(guideProcedureIdentity, procedureIdentity)
        || uniqueGotchas.size !== guideEntry.doc.gotchas.length
        || uniqueReferences.size !== guideEntry.doc.references.length) {
        out.push(violation(
          guideEntry.file,
          'SOTER_WORKFLOW_GUIDE_PROCEDURE',
          'guide steps do not exactly match workflow step identity and order, or guide gotcha/reference identities are duplicated',
          'stable procedural joins are required for deterministic host projection, review, and evidence binding',
          'align guide step ids and sequence exactly and make every gotcha and reference id unique'
        ));
      }

      if (guideEntry.doc.status.state === 'active') {
        if (guideEntry.doc.source.presence !== 'removed'
          || entry.doc.source.presence !== 'removed'
          || exactLegacySourcePresent
          || evaluationEntry.doc.cases.some((item) => item.source.presence !== 'removed')) {
          out.push(violation(
            guideEntry.file,
            'SOTER_WORKFLOW_GUIDE_ACTIVATION_PROVENANCE',
            'active workflow guidance lacks exact Codex and Claude evidence or retained-source tombstones',
            'host guidance becomes target authority only after both hosts are evaluated and every operational fallback is removed',
            'attach one exact evidence record per host and retain removed-source fingerprints as tombstones'
          ));
        }
        const activeEvidence = inspectActiveWorkflowEvidence({
          root,
          definitionEntry: entry,
          guideEntry,
          evaluationEntry,
          guidePath,
          documentsByPath,
          evidence,
          requireFinalEvidence
        });
        for (const finding of activeEvidence.findings) {
          out.push(violation(
            guideEntry.file,
            finding.code,
            finding.what,
            finding.why,
            finding.fix
          ));
        }
        const expectedParity = guideEntry.doc.status.behaviorParity === 'passed'
          ? 'proven'
          : 'intentional-change';
        let workflowSources = [];
        try {
          workflowSources = workflowLegacySourceProjection({
            definition: entry.doc,
            guide: guideEntry.doc,
            evaluations: evaluationEntry.doc
          });
        } catch {
          // inspectActiveWorkflowEvidence reports the source-set defect above.
        }
        const migrationBasisInvalid = workflowSources.length === 0
          || workflowSources.some((source) => {
            const inventoryItems = legacyInventories.length === 1
              ? legacyInventories[0].doc.items.filter((item) => {
                return item.sourcePath === source.path
                  && item.sourceFingerprint === source.fingerprint;
              })
              : [];
            const targetPath = source.kind === 'workflow-guide'
              ? guidePath
              : guideEntry.doc.workflow.evaluationSetPath;
            const bindings = inventoryItems.length === 1
              ? inventoryItems[0].targets.filter((binding) => {
                return binding.id === id && binding.path === targetPath;
              })
              : [];
            return source.presence !== 'removed'
              || inventoryItems.length !== 1
              || inventoryItems[0].sourcePresence !== 'removed'
              || inventoryItems[0].state !== 'migrated'
              || bindings.length !== 1
              || bindings[0].state !== 'migrated'
              || bindings[0].canonicalAuthority !== 'target'
              || bindings[0].fallback !== 'removed'
              || bindings[0].parity !== expectedParity
              || (requireFinalEvidence && !deepEqual(
                [...bindings[0].evidence].sort(),
                [...activeEvidence.finalEvidencePaths].sort()
              ));
          });
        if (migrationBasisInvalid) {
          out.push(violation(
            guideEntry.file,
            'SOTER_WORKFLOW_GUIDE_MIGRATION',
            'active workflow guide has no exact completed legacy-inventory authority transition',
            'generated host delivery cannot become canonical while the legacy fallback remains present or migration state disagrees',
            'remove the fallback and align exact target authority, parity, and evidence in legacy-inventory/v2 before activation'
          ));
        }
      }

      if (guideEntry.doc.status.state === 'retired') {
        const retirement = inspectRetiredWorkflowEvidence({
          root,
          id,
          definitionEntry: entry,
          guideEntry,
          evaluationEntry,
          guidePath,
          legacyInventories,
          documentsByPath,
          locks,
          requireFinalEvidence
        });
        if (retirement.length) {
          out.push(violation(
            guideEntry.file,
            'SOTER_WORKFLOW_GUIDE_RETIREMENT_INVALID',
            'retired workflow guidance lacks exact tombstone, evidence, or legacy-inventory retirement bindings',
            'retirement must remain inspectable without preserving an operational fallback or assigning replacement authority to the retired workflow',
            'remove the source, retain exact fingerprints, attach passed retirement evidence, and mark the exact inventory binding retired with no authority'
          ));
        }
      }
    }

    const stepIds = entry.doc.procedure.map((step) => step.id);
    const stepSequence = entry.doc.procedure.map((step) => step.sequence);
    const expectedStepSequence = entry.doc.procedure.map((_, index) => index + 1);
    if (new Set(stepIds).size !== stepIds.length
      || !deepEqual(stepSequence, expectedStepSequence)) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_PROCEDURE_IDENTITY',
        'procedure step ids must be unique and sequence must be contiguous in document order',
        'stable ordered steps are required for deterministic review and later runtime decomposition',
        'remove duplicate ids and number the ordered procedure from one without gaps'
      ));
    }

    const forbiddenRuntimeShape = Boolean(pack.doc.operator)
      || pack.doc.capabilities.requires.length > 0
      || pack.doc.capabilities.provides.length > 0
      || pack.doc.authorities.length > 0
      || pack.doc.effects.length > 0
      || pack.doc.releaseStage !== 'experimental'
      || pack.doc.evidenceMaturity !== 'declared'
      || pack.doc.verification.maxLevel !== 'static'
      || pack.doc.verification.scenarios.length > 0;
    if (forbiddenRuntimeShape) {
      out.push(violation(
        pack.file,
        'SOTER_WORKFLOW_DEFINITION_AUTHORITY',
        'definition-only Automation pack declares runtime, effect, authority, maturity, or executable-scenario semantics',
        'preserved intent must not masquerade as an operator runtime, capability binding, effect grant, or verified behavior',
        'remove runtime declarations or promote the workflow through a separate implemented and evidenced slice'
      ));
    }
  }

  for (const [id, entry] of workflowEvaluationSets) {
    const owners = evaluationOwners.get(id) || [];
    if (owners.length !== 1) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_EVALUATION_OWNER',
        'workflow evaluation set has ' + owners.length + ' exact workflow owners',
        'unowned or shared behavior expectations create ambiguous Automation authority',
        'bind the evaluation set from exactly one matching workflow definition'
      ));
    }
    const caseIds = entry.doc.cases.map((item) => item.id);
    const sourcePaths = entry.doc.cases.map((item) => item.source.legacyPath);
    const sequence = entry.doc.cases.map((item) => item.sequence);
    const expectedSequence = entry.doc.cases.map((_, index) => index + 1);
    const owner = workflowDefinitions.get(entry.doc.workflow);
    const kinds = new Set(entry.doc.cases.map((item) => item.kind));
    const sourceLifecycleInvalid = entry.doc.cases.some((item) => {
      const source = resolveRegularRepositoryFile(root, item.source.legacyPath);
      return item.source.presence === 'present'
        ? !source || fingerprintFile(source) !== item.source.legacyFingerprint
        : Boolean(source);
    });
    if (new Set(caseIds).size !== caseIds.length
      || new Set(sourcePaths).size !== sourcePaths.length
      || !deepEqual(sequence, expectedSequence)
      || sourceLifecycleInvalid) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_EVALUATION_IDENTITY',
        'evaluation case ids and source paths must be unique and sequence must be contiguous in document order',
        'normalized cases need stable one-to-one source traceability and deterministic ordering',
        'remove duplicates and number the ordered cases from one without gaps'
      ));
    }
    if (entry.doc.lifecycle.state === 'active-host-guided'
      && (!kinds.has('happy-path') || !kinds.has('pressure') || !kinds.has('invariant')
        || entry.doc.cases.length < 3
        || entry.doc.evaluationPolicy.freshWorkerPerCase !== true
        || entry.doc.evaluationPolicy.expectationsWithheld !== true
        || entry.doc.evaluationPolicy.baselineRequired !== true
        || !owner
        || owner.doc.lifecycle.state !== 'active-host-guided')) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_EVALUATION_COVERAGE',
        'active host-guided evaluation set lacks exact happy-path, pressure, invariant, fresh-worker, withheld-expectation, or baseline coverage',
        'host activation requires observable normal, pressure, and invariant evidence from isolated runs rather than schema validity or self-report',
        'add the missing exact case kinds and preserve fresh workers, withheld expectations, and a baseline arm'
      ));
    }
  }

  for (const [id, entry] of workflowGuides) {
    const owners = guideOwners.get(id) || [];
    if (owners.length !== 1) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_GUIDE_OWNER',
        'workflow guide has ' + owners.length + ' exact workflow owners',
        'unowned or shared procedural guidance creates ambiguous Automation and host-projection authority',
        'bind the guide from exactly one matching workflow definition and Automation pack'
      ));
    }
  }
}

function checkPackSettings(root, packSettings, packs, out) {
  const byPack = new Set();
  for (const entry of packSettings.values()) {
    const pack = packs.get(entry.doc.pack);
    const relative = path.relative(root, entry.file).split(path.sep).join('/');
    if (byPack.has(entry.doc.pack)) {
      out.push(violation(
        entry.file,
        'SOTER_PACK_SETTINGS_DUPLICATE',
        'pack has more than one settings definition: ' + entry.doc.pack,
        'one pack settings key must resolve to one mechanically enforced schema',
        'merge the definitions or version the pack'
      ));
    }
    byPack.add(entry.doc.pack);
    if (!pack
      || pack.doc.version !== entry.doc.version
      || !pack.doc.artifacts.some((artifact) => artifact.path === relative)) {
      out.push(violation(
        entry.file,
        'SOTER_PACK_SETTINGS_OWNER',
        'settings definition is not owned by its exact pack version: ' + entry.doc.pack,
        'user configuration schemas must evolve with the pack that interprets them',
        'align the pack, version, and owned artifact path'
      ));
    }
  }
}

function contextModelDocuments(contextModels) {
  if (contextModels instanceof Map) {
    return [...contextModels.values()].map((entry) => entry.doc || entry);
  }
  return (contextModels || []).map((entry) => entry.doc || entry);
}

function contextRecordMatch(contextModels, recordType, modelId = null, subject = null) {
  const matches = contextModelDocuments(contextModels).flatMap((model) => {
    if (modelId && model.id !== modelId) return [];
    if (subject && model.subject !== subject) return [];
    return model.recordTypes
      .filter((record) => record.id === recordType)
      .map((record) => ({ model, record }));
  });
  return matches;
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const observed = new Date(Date.UTC(year, month - 1, day));
  return observed.getUTCFullYear() === year
    && observed.getUTCMonth() === month - 1
    && observed.getUTCDate() === day;
}

function contextValueMatches(field, value) {
  if (value === null) return field.nullable;
  let matches = false;
  if (field.type === 'string') matches = typeof value === 'string' && value.trim().length > 0;
  if (field.type === 'boolean') matches = typeof value === 'boolean';
  if (field.type === 'number') matches = typeof value === 'number' && Number.isFinite(value);
  if (field.type === 'string-list') {
    matches = Array.isArray(value)
      && value.every((item) => typeof item === 'string' && item.trim().length > 0)
      && new Set(value).size === value.length;
  }
  if (!matches) return false;
  const strings = Array.isArray(value) ? value : [value];
  const uriRequired = field.format === 'resource-uri'
    || field.reference?.identity === 'resource-uri';
  if (uriRequired && strings.some((item) => {
    return !/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(item);
  })) return false;
  if (field.format === 'email' && strings.some((item) => {
    return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item);
  })) return false;
  if (field.format === 'date' && strings.some((item) => !isCalendarDate(item))) return false;
  return true;
}

function contextRecordFieldErrors(record, fields, mode, at) {
  const errors = [];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return [{ path: at, message: 'must be an object of portable context fields' }];
  }
  const definitions = new Map(record.fields.map((field) => [field.id, field]));
  for (const [id, value] of Object.entries(fields)) {
    const field = definitions.get(id);
    if (!field) {
      errors.push({ path: at + '.' + id, message: 'is not declared by the Context record model' });
      continue;
    }
    if (mode === 'update' && !field.mutable) {
      errors.push({ path: at + '.' + id, message: 'is immutable in the Context record model' });
    }
    if (!contextValueMatches(field, value)) {
      const format = field.format || field.reference?.identity || null;
      errors.push({
        path: at + '.' + id,
        message: 'must match portable type ' + field.type
          + (format ? ' with ' + format + ' identity' : '')
          + (field.nullable ? ' or null' : '')
      });
    }
  }
  if (mode === 'create') {
    for (const field of record.fields.filter((item) => item.requiredOnCreate)) {
      if (!Object.hasOwn(fields, field.id) || fields[field.id] === null) {
        errors.push({ path: at + '.' + field.id, message: 'is required on create by Context' });
      }
    }
  }
  return errors;
}

export function contextRecordInputErrors(contextModels, capability, input, options = {}) {
  const descriptor = parseRecordCapability(capability);
  if (!descriptor) return [];
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [{ path: '$', message: 'must be a portable record input object' }];
  }
  if (descriptor.operation === 'schema-read') {
    const matches = contextRecordMatch(
      contextModels,
      input.recordType,
      options.modelId || null,
      descriptor.subject
    );
    if (matches.length !== 1) {
      errors.push({
        path: '$.recordType',
        message: 'must resolve to exactly one selected Context record definition; found '
          + matches.length
      });
    }
    return errors;
  }
  if (descriptor.operation === 'read') {
    const selectedRecords = [];
    const requestedRecordTypes = Array.isArray(input.recordTypes)
      ? input.recordTypes
      : (typeof input.recordType === 'string' ? [input.recordType] : []);
    for (const [index, recordType] of requestedRecordTypes.entries()) {
      const matches = contextRecordMatch(
        contextModels,
        recordType,
        options.modelId || null,
        descriptor.subject
      );
      if (matches.length !== 1) {
        errors.push({
          path: Array.isArray(input.recordTypes)
            ? '$.recordTypes[' + index + ']'
            : '$.recordType',
          message: 'must resolve to exactly one selected Context record definition; found ' + matches.length
        });
      } else {
        selectedRecords.push(matches[0].record);
      }
    }
    const filterSets = [input.filters, ...(input.filtersAny || [])].filter(Boolean);
    for (const [filterIndex, filters] of filterSets.entries()) {
      for (const field of Object.keys(filters)) {
        if (!selectedRecords.every((record) => record.fields.some((item) => item.id === field))) {
          errors.push({
            path: '$.filters[' + filterIndex + '].' + field,
            message: 'must be declared by every selected Context record definition'
          });
        }
      }
    }
    return errors;
  }
  const matches = contextRecordMatch(
    contextModels,
    input.recordType,
    options.modelId || null,
    descriptor.subject
  );
  if (matches.length !== 1) {
    return [{
      path: '$.recordType',
      message: 'must resolve to exactly one selected Context record definition; found ' + matches.length
    }];
  }
  const record = matches[0].record;
  const mode = descriptor.operation;
  const fieldKey = mode === 'create' ? 'fields' : 'patch';
  errors.push(...contextRecordFieldErrors(record, input[fieldKey], mode, '$.' + fieldKey));
  if (mode === 'create') {
    const hasBody = input.body !== undefined && input.body !== null;
    if (record.content.kind === 'none' && hasBody) {
      errors.push({ path: '$.body', message: 'is not supported by the Context record definition' });
    }
    if (record.content.requiredOnCreate && !hasBody) {
      errors.push({ path: '$.body', message: 'is required on create by Context' });
    }
    if (hasBody && (record.content.kind !== 'markdown'
      || typeof input.body !== 'string' || !input.body.trim())) {
      errors.push({ path: '$.body', message: 'must be non-empty ' + record.content.kind + ' content' });
    }
    if (input.deduplicationFilter !== undefined) {
      const filter = input.deduplicationFilter;
      if (!filter || typeof filter !== 'object' || Array.isArray(filter)
        || typeof filter.field !== 'string'
        || !record.deduplicationFields.includes(filter.field)) {
        errors.push({
          path: '$.deduplicationFilter.field',
          message: 'must name a Context-declared deduplication field for ' + record.id
        });
      }
    }
  }
  return errors;
}

export function contextRecordOutputErrors(contextModels, capability, output, options = {}) {
  const descriptor = parseRecordCapability(capability);
  if (!descriptor || !output || typeof output !== 'object') return [];
  if (descriptor.operation === 'schema-read') {
    const schema = output.schema;
    const matches = contextRecordMatch(
      contextModels,
      schema?.recordType,
      options.modelId || null,
      descriptor.subject
    );
    if (matches.length !== 1) {
      return [{
        path: '$.schema.recordType',
        message: 'must resolve to exactly one selected Context record definition; found '
          + matches.length
      }];
    }
    const record = matches[0].record;
    const declared = new Set(record.fields.map((field) => field.id));
    const fields = Array.isArray(schema?.fields) ? schema.fields : [];
    const errors = [];
    if (new Set(fields.map((field) => field?.id)).size !== fields.length) {
      errors.push({ path: '$.schema.fields', message: 'must contain unique portable field ids' });
    }
    for (const [index, field] of fields.entries()) {
      if (!declared.has(field?.id)) {
        errors.push({
          path: '$.schema.fields[' + index + '].id',
          message: 'is not declared by the selected Context record model'
        });
      }
    }
    const unsigned = { recordType: schema?.recordType, fields };
    if (schema?.fingerprint !== fingerprintJson(unsigned)) {
      errors.push({
        path: '$.schema.fingerprint',
        message: 'must bind the exact normalized record type and fields'
      });
    }
    return errors;
  }
  const records = descriptor.operation === 'read'
    ? output.records
    : (output.record ? [output.record] : []);
  const errors = [];
  for (const [index, value] of (records || []).entries()) {
    const at = descriptor.operation === 'read' ? '$.records[' + index + ']' : '$.record';
    const matches = contextRecordMatch(
      contextModels,
      value?.type,
      options.modelId || null,
      descriptor.subject
    );
    if (matches.length !== 1) {
      errors.push({
        path: at + '.type',
        message: 'must resolve to exactly one selected Context record definition; found ' + matches.length
      });
      continue;
    }
    const record = matches[0].record;
    errors.push(...contextRecordFieldErrors(record, value.fields, 'output', at + '.fields'));
    if (value.body !== undefined && value.body !== null
      && (record.content.kind !== 'markdown'
        || typeof value.body !== 'string' || !value.body.trim())) {
      errors.push({ path: at + '.body', message: 'does not match Context content kind ' + record.content.kind });
    }
  }
  return errors;
}

function checkContextRecordModels(root, contextModels, packs, out) {
  for (const entry of contextModels.values()) {
    const pack = packs.get(entry.doc.pack);
    const relative = path.relative(root, entry.file).split(path.sep).join('/');
    if (!pack || pack.doc.layer !== 'context'
      || pack.doc.version !== entry.doc.version
      || !pack.doc.artifacts.some((artifact) => artifact.path === relative)) {
      out.push(violation(
        entry.file,
        'SOTER_CONTEXT_MODEL_OWNER',
        'context record model is not owned by its exact Context pack version: ' + entry.doc.pack,
        'portable domain meaning must have one explicit Context owner',
        'align the model pack, version, artifact path, and Context manifest'
      ));
    }
    const recordIds = new Set();
    for (const record of entry.doc.recordTypes) {
      if (recordIds.has(record.id)) {
        out.push(violation(
          entry.file,
          'SOTER_CONTEXT_MODEL_RECORD',
          'context model declares duplicate record type ' + record.id,
          'portable record identity must resolve to one domain definition',
          'merge or rename the duplicate record definition'
        ));
      }
      recordIds.add(record.id);
      const fields = new Map();
      for (const field of record.fields) {
        if (fields.has(field.id)) {
          out.push(violation(
            entry.file,
            'SOTER_CONTEXT_MODEL_FIELD',
            record.id + ' declares duplicate field ' + field.id,
            'one portable field name must have one meaning and value type',
            'merge or rename the duplicate field definition'
          ));
        }
        fields.set(field.id, field);
        if (field.requiredOnCreate && field.nullable) {
          out.push(violation(
            entry.file,
            'SOTER_CONTEXT_MODEL_FIELD',
            record.id + '.' + field.id + ' is both required and nullable on create',
            'required create semantics must not permit an absent value by another spelling',
            'make the field non-nullable or stop requiring it on create'
          ));
        }
        if (field.reference && !['string', 'string-list'].includes(field.type)) {
          out.push(violation(
            entry.file,
            'SOTER_CONTEXT_MODEL_REFERENCE',
            record.id + '.' + field.id + ' has a non-string reference representation',
            'portable relationship identities must have a stable serializable representation',
            'use string or string-list for the reference field'
          ));
        }
      }
      if (record.content.kind === 'none' && record.content.requiredOnCreate) {
        out.push(violation(
          entry.file,
          'SOTER_CONTEXT_MODEL_CONTENT',
          record.id + ' requires content while declaring content kind none',
          'create requirements must be satisfiable by the declared portable shape',
          'declare a content kind or stop requiring content'
        ));
      }
      for (const fieldId of record.deduplicationFields) {
        const field = fields.get(fieldId);
        if (!field || field.type !== 'string') {
          out.push(violation(
            entry.file,
            'SOTER_CONTEXT_MODEL_DEDUPLICATION',
            record.id + ' deduplication field is absent or not a string: ' + fieldId,
            'portable create preconditions require a stable comparable string value',
            'declare the string field or remove it from deduplicationFields'
          ));
        }
      }
    }
  }
}

function checkCapabilityProviders(
  root,
  providers,
  providerFixtures,
  providerMappings,
  contextModels,
  packSettings,
  packs,
  capabilities,
  hosts,
  out
) {
  const implementations = new Set();
  const fixturesByPath = new Map([...providerFixtures.values()].map((entry) => {
    return [path.relative(root, entry.file).split(path.sep).join('/'), entry];
  }));
  for (const [id, entry] of providers) {
    const expected = path.join(root, 'soter', 'providers', id + '.json');
    if (path.resolve(entry.file) !== path.resolve(expected)) {
      out.push(violation(
        entry.file,
        'SOTER_PROVIDER_PATH',
        'provider ' + id + ' is not stored at soter/providers/' + id + '.json',
        'deterministic provider discovery cannot depend on naming guesses',
        'move the provider declaration to its canonical path'
      ));
    }
    const pack = packs.get(entry.doc.pack);
    if (!pack || pack.doc.layer !== 'integration') {
      out.push(violation(
        entry.file,
        'SOTER_PROVIDER_PACK',
        'provider pack is missing or not an integration pack: ' + entry.doc.pack,
        'capability implementations belong to one explicit integration system',
        'select an existing integration pack as provider owner'
      ));
      continue;
    }
    const packPath = path.relative(root, pack.file).split(path.sep).join('/');
    const ownedPaths = new Set([packPath, ...pack.doc.artifacts.map((artifact) => artifact.path)]);
    const requiredPaths = [
      path.relative(root, entry.file).split(path.sep).join('/'),
      entry.doc.runtime.module,
      ...entry.doc.mappings,
      ...entry.doc.fixtures
    ];
    for (const requiredPath of requiredPaths) {
      if (!ownedPaths.has(requiredPath)) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_OWNERSHIP',
          entry.doc.pack + ' does not declare provider artifact ' + requiredPath,
          'runtime implementations and fixtures need one inspectable pack owner',
          'add the artifact to the provider pack manifest'
        ));
      }
      if (!fs.existsSync(path.join(root, requiredPath))) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_ARTIFACT',
          'provider artifact does not exist: ' + requiredPath,
          'a declared implementation cannot execute or be reproduced without its artifacts',
          'create the artifact or correct the provider declaration'
        ));
      }
    }
    if (entry.doc.runtime.engine === 'node') {
      if (!entry.doc.runtime.export) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_RUNTIME',
          'Node provider does not declare one invocation export',
          'Core cannot dispatch a local provider through an inferred module entry point',
          'set runtime.export to the provider invocation function'
        ));
      }
    } else if (entry.doc.runtime.engine === 'mcp') {
      const missing = [
        'prepareExport',
        'completeExport',
        'server',
        'tools',
        'probeTools',
        'responseProfiles'
      ]
        .filter((field) => !entry.doc.runtime[field]
          || (['tools', 'probeTools', 'responseProfiles'].includes(field)
            && !entry.doc.runtime[field].length));
      const planProbeRuntime = entry.doc.runtime.probePlanExport
        && entry.doc.runtime.probeStepCompleteExport
        && entry.doc.runtime.probeFinalizeExport;
      if (!planProbeRuntime) {
        missing.push('complete provider probe plan export set');
      }
      if (missing.length) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_RUNTIME',
          'MCP provider runtime is missing ' + missing.join(', '),
          'host-dispatched calls require explicit translation entry points, server identity, and tool allowlist',
          'declare the complete MCP runtime boundary'
        ));
      }
      const pagination = entry.doc.runtime.pagination;
      if (pagination) {
        const providedCapabilities = new Set(
          entry.doc.capabilities.map((capability) => capability.id)
        );
        const undeclaredPaginated = pagination.capabilities.filter((capability) => {
          return !providedCapabilities.has(capability);
        });
        if (undeclaredPaginated.length) {
          out.push(violation(
            entry.file,
            'SOTER_PROVIDER_RUNTIME',
            'MCP pagination names capabilities outside the provider declaration: '
              + undeclaredPaginated.join(', '),
            'a provider continuation loop cannot widen the resolved capability boundary',
            'remove the capability or declare its exact supported version on the provider'
          ));
        }
      }
      const undeclaredProbeTools = (entry.doc.runtime.probeTools || [])
        .filter((tool) => !entry.doc.runtime.tools?.includes(tool));
      if (undeclaredProbeTools.length) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_RUNTIME',
          'MCP provider probe tools are outside its capability tool allowlist: '
            + undeclaredProbeTools.join(', '),
          'readiness probes cannot expand the integration transport boundary',
          'add each safe probe tool to runtime.tools or remove it from runtime.probeTools'
        ));
      }
      if (!['connected', 'canary', 'live'].includes(entry.doc.containment)) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_RUNTIME',
          'MCP provider uses non-connected containment ' + entry.doc.containment,
          'fixture and contained execution must not depend on an authenticated external host transport',
          'use a local Node provider for fixtures or classify this implementation as connected or stronger'
        ));
      }
      for (const hostName of pack.doc.compatibility.hosts) {
        const host = hosts.get('host.' + hostName);
        const route = host?.doc.mcpServers.find((server) => server.id === entry.doc.runtime.server);
        if (!route) {
          out.push(violation(
            entry.file,
            'SOTER_PROVIDER_HOST_ROUTE',
            'compatible host ' + hostName + ' has no MCP route for ' + entry.doc.runtime.server,
            'provider portability claims require every compatible host to realize the logical server identity',
            'add the host MCP route or narrow the integration pack compatibility claim'
          ));
        } else {
          const mapped = new Set(route.toolMappings.map((mapping) => mapping.logical));
          const requiredTools = [
            ...new Set([
              ...entry.doc.runtime.tools,
              ...(entry.doc.runtime.probeTools || [])
            ])
          ];
          const missingTools = requiredTools.filter((tool) => !mapped.has(tool));
          if (missingTools.length) {
            out.push(violation(
              entry.file,
              'SOTER_PROVIDER_HOST_TOOL',
              'compatible host ' + hostName + ' does not map logical tools '
                + missingTools.join(', ') + ' for ' + entry.doc.runtime.server,
              'provider-neutral operations must resolve to exact native tool names on every compatible host',
              'add the host tool mappings or narrow the integration pack compatibility claim'
            ));
          }
          const undeclaredProfiles = route.toolMappings.filter((mapping) => {
            return requiredTools.includes(mapping.logical)
              && !entry.doc.runtime.responseProfiles.includes(mapping.responseProfile);
          });
          if (undeclaredProfiles.length) {
            out.push(violation(
              entry.file,
              'SOTER_PROVIDER_HOST_RESPONSE_PROFILE',
              'compatible host ' + hostName + ' maps undeclared response profiles for '
                + undeclaredProfiles.map((mapping) => mapping.logical).join(', '),
              'response normalization must be bound to one provider-declared host shape rather than inferred aliases',
              'map each logical tool to a response profile declared by the selected provider runtime'
            ));
          }
        }
      }
    }
    for (const fixturePath of entry.doc.fixtures) {
      const fixture = fixturesByPath.get(fixturePath);
      if (!fixture || fixture.doc.provider !== id) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_FIXTURE',
          'fixture does not declare provider ownership ' + id + ': ' + fixturePath,
          'contained data must be typed and attributable to the implementation that reads it',
          'use a provider-fixture contract with the matching provider id'
        ));
      }
    }
    for (const provided of entry.doc.capabilities) {
      const key = entry.doc.pack + '|' + entry.doc.containment + '|' + provided.id;
      if (implementations.has(key)) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_DUPLICATE',
          'more than one provider implements ' + key,
          'one containment level must resolve to one implementation per bound pack and capability',
          'remove the duplicate or give it a distinct containment level'
        ));
      }
      implementations.add(key);
      const capability = capabilities.get(provided.id);
      const packProvision = pack.doc.capabilities.provides.find((item) => item.id === provided.id);
      if (!capability || !packProvision
        || capability.doc.version !== provided.version
        || packProvision.version !== provided.version) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_CAPABILITY',
          'provider capability does not match its contract and pack provision: ' + provided.id,
          'runtime dispatch must preserve one exact portable interface version',
          'align the provider, capability contract, and pack provision versions'
        ));
        continue;
      }
      for (const effect of capability.doc.effects) {
        if (!entry.doc.effects.includes(effect) || !pack.doc.effects.includes(effect)) {
          out.push(violation(
            entry.file,
            'SOTER_PROVIDER_EFFECT',
            'provider omits effect ' + effect + ' required by ' + provided.id,
            'effect gates must see the complete transitive capability effect set',
            'declare the effect on both provider and pack'
          ));
        }
      }
    }
  }
  for (const entry of providerMappings.values()) {
    const provider = providers.get(entry.doc.provider);
    const settings = packSettings.get(entry.doc.settingsDefinition);
    const contextModel = entry.doc.contextModel
      ? contextModels.get(entry.doc.contextModel)
      : null;
    const integrationPack = packs.get(entry.doc.pack);
    const relative = path.relative(root, entry.file).split(path.sep).join('/');
    if (!provider
      || provider.doc.pack !== entry.doc.pack
      || provider.doc.version !== entry.doc.version
      || !provider.doc.mappings.includes(relative)) {
      out.push(violation(
        entry.file,
        'SOTER_PROVIDER_MAPPING_OWNER',
        'provider mapping is not owned by its exact declared implementation: ' + entry.doc.provider,
        'provider translation cannot be discovered or versioned when its mapping is detached',
        'align the provider, pack, version, and mappings path'
      ));
    }
    if (!settings || settings.doc.pack !== entry.doc.pack) {
      out.push(violation(
        entry.file,
        'SOTER_PROVIDER_MAPPING_SETTINGS',
        'provider mapping settings definition does not resolve: ' + entry.doc.settingsDefinition,
        'target identities must be validated before provider translation can use them',
        'declare the pack-owned settings definition or correct the reference'
      ));
    }
    const dependsOnContext = integrationPack?.doc.dependencies.some((dependency) => {
      return dependency.pack === contextModel?.doc.pack;
    });
    if (!contextModel || !dependsOnContext) {
      out.push(violation(
        entry.file,
        'SOTER_PROVIDER_MAPPING_CONTEXT',
        !contextModel
          ? 'provider mapping context model does not resolve: ' + entry.doc.contextModel
          : 'integration pack does not declare Context owner ' + contextModel.doc.pack,
        'provider translation must bind to one declared source of portable domain meaning',
        'reference an owned Context model and add its required or capability-optional pack dependency'
      ));
    }
    const providerCapabilities = new Set(provider?.doc.capabilities.map((item) => item.id) || []);
    for (const capability of entry.doc.capabilities) {
      const descriptor = parseRecordCapability(capability);
      if (!providerCapabilities.has(capability)) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_MAPPING_CAPABILITY',
          'mapping declares capability outside its provider: ' + capability,
          'a mapping cannot expand the implementation boundary by assertion',
          'remove the capability or declare it on the provider only after it is implemented'
        ));
      }
      if (!descriptor || descriptor.subject !== contextModel?.doc.subject) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_MAPPING_CONTEXT',
          'mapping capability ' + capability + ' does not belong to Context subject '
            + String(contextModel?.doc.subject),
          'record translation capability scope must have the same portable subject as its Context model',
          'align the capability namespace and Context model subject'
        ));
      }
    }
    const recordTypes = new Set();
    const recordCapabilities = new Set();
    for (const record of entry.doc.recordTypes) {
      const contextRecord = contextModel?.doc.recordTypes.find((item) => item.id === record.id);
      if (recordTypes.has(record.id)) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_MAPPING_RECORD',
          'mapping declares duplicate record type ' + record.id,
          'one portable record type must resolve to one target mapping',
          'merge or rename the duplicate record mapping'
        ));
      }
      recordTypes.add(record.id);
      for (const capability of record.capabilities || []) {
        const descriptor = parseRecordCapability(capability);
        recordCapabilities.add(capability);
        if (!entry.doc.capabilities.includes(capability)) {
          out.push(violation(
            entry.file,
            'SOTER_PROVIDER_MAPPING_CAPABILITY',
            record.id + ' expands mapping capability scope: ' + capability,
            'a record mapping cannot exceed the capability boundary of its mapping document',
            'add the implemented top-level capability or remove it from the record type'
          ));
        }
        if (!descriptor || descriptor.subject !== contextModel?.doc.subject) {
          out.push(violation(
            entry.file,
            'SOTER_PROVIDER_MAPPING_CONTEXT',
            record.id + ' capability ' + capability + ' does not belong to Context subject '
              + String(contextModel?.doc.subject),
            'record-level translation cannot cross portable Context namespaces',
            'use a capability whose record subject matches the bound Context model'
          ));
        }
      }
      if (contextModel && !contextRecord) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_MAPPING_CONTEXT',
          'mapping invents record type outside ' + contextModel.doc.id + ': ' + record.id,
          'Integration translates Context meaning; it cannot define new portable domain records',
          'add the record to its Context owner or remove it from the provider mapping'
        ));
      }
      const portableFields = record.fields.map((field) => field.portable);
      const providerFields = record.fields.map((field) => field.provider);
      if (new Set(portableFields).size !== portableFields.length) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_MAPPING_FIELD',
          'record mapping has duplicate portable fields: ' + record.id,
          'normalization must assign each portable field exactly once',
          'remove the duplicate field mapping'
        ));
      }
      if (new Set(providerFields).size !== providerFields.length) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_MAPPING_FIELD',
          'record mapping has duplicate provider fields: ' + record.id,
          'one provider property cannot normalize into multiple portable meanings in the same record',
          'remove the duplicate provider field mapping or define an explicit composite translation'
        ));
      }
      if (contextRecord) {
        const contextFields = new Map(contextRecord.fields.map((field) => [field.id, field]));
        const mappedContextFields = new Set(record.fields.map((field) => field.portable));
        for (const field of record.fields) {
          const contextField = contextFields.get(field.portable);
          const choiceProviderType = ['select', 'multi_select', 'status']
            .includes(field.providerType);
          if (choiceProviderType && field.valueMapping !== 'configured-bijection') {
            out.push(violation(
              entry.file,
              'SOTER_PROVIDER_MAPPING_VALUE_TRANSLATION',
              record.id + '.' + field.portable
                + ' does not require one configured provider-value bijection',
              'provider choice labels are Integration configuration, not portable Context values',
              'declare valueMapping=configured-bijection and supply exact private optionMappings'
            ));
          } else if (!choiceProviderType && field.valueMapping !== undefined) {
            out.push(violation(
              entry.file,
              'SOTER_PROVIDER_MAPPING_VALUE_TRANSLATION',
              record.id + '.' + field.portable
                + ' declares provider-value translation for a non-choice field',
              'configured option translation is valid only for select, multi_select, and status fields',
              'remove valueMapping or use an exact choice provider type'
            ));
          }
          if (!contextField) {
            out.push(violation(
              entry.file,
              'SOTER_PROVIDER_MAPPING_CONTEXT',
              'mapping invents field outside Context: ' + record.id + '.' + field.portable,
              'provider properties may translate only canonical portable fields',
              'add the field to its Context owner or remove it from the mapping'
            ));
          } else if ((contextField.type === 'string-list') !== (field.decode === 'json')) {
            out.push(violation(
              entry.file,
              'SOTER_PROVIDER_MAPPING_TYPE',
              'mapping decode disagrees with Context type for ' + record.id + '.' + field.portable,
              'normalization must preserve the canonical portable value shape',
              contextField.type === 'string-list'
                ? 'decode the provider value as a JSON string list'
                : 'decode the provider value as a scalar'
            ));
          } else if (record.capabilities?.some((capability) => {
            return parseRecordCapability(capability)?.operation === 'update';
          })
            && (!field.writeOperations || field.writeOperations.includes('update'))
            && !contextField.mutable) {
            out.push(violation(
              entry.file,
              'SOTER_PROVIDER_MAPPING_MUTABILITY',
              record.id + ' exposes immutable Context field for generic updates: ' + field.portable,
              'record-level update scope currently permits every mapped field to reach the translator',
              'remove update scope or add field-level write scoping before mapping the immutable field'
            ));
          }
          for (const operation of field.writeOperations || []) {
            if (!record.capabilities?.some((capability) => {
              return parseRecordCapability(capability)?.operation === operation;
            })) {
              out.push(violation(
                entry.file,
                'SOTER_PROVIDER_MAPPING_WRITE_SCOPE',
                record.id + '.' + field.portable + ' declares unavailable write operation ' + operation,
                'field-level write scope cannot expand the record-level capability boundary',
                'remove the field write operation or add the exact implemented record capability'
              ));
            }
          }
        }
        if (record.capabilities?.some((capability) => {
          return parseRecordCapability(capability)?.operation === 'create';
        })) {
          for (const required of contextRecord.fields.filter((field) => field.requiredOnCreate)) {
            const mappedRequired = record.fields.find((field) => field.portable === required.id);
            if (!mappedContextFields.has(required.id)
              || (mappedRequired.writeOperations
                && !mappedRequired.writeOperations.includes('create'))) {
              out.push(violation(
                entry.file,
                'SOTER_PROVIDER_MAPPING_CREATE',
                record.id + ' cannot represent required create field ' + required.id,
                'a claimed record create route must accept every Context-required create value',
                'map the required field or remove create capability from this record type'
              ));
            }
          }
          if (contextRecord.content.requiredOnCreate && !record.content) {
            out.push(violation(
              entry.file,
              'SOTER_PROVIDER_MAPPING_CREATE',
              record.id + ' cannot represent required Context body content',
              'a claimed record create route must preserve all required Context content',
              'declare the content mapping or remove create capability from this record type'
            ));
          }
        }
        if (record.content && record.content.providerType !== contextRecord.content.kind) {
          out.push(violation(
            entry.file,
            'SOTER_PROVIDER_MAPPING_CONTENT',
            'mapped content kind disagrees with Context for ' + record.id,
            'provider body transport must preserve the canonical content representation',
            'align the provider content mapping with ' + contextRecord.content.kind
          ));
        }
      }
    }
    const unusedTopLevelCapabilities = entry.doc.capabilities.filter((capability) => {
      return !recordCapabilities.has(capability);
    });
    if (unusedTopLevelCapabilities.length) {
      out.push(violation(
        entry.file,
        'SOTER_PROVIDER_MAPPING_CAPABILITY',
        'mapping capability has no record-level implementation: '
          + unusedTopLevelCapabilities.join(', '),
        'top-level capability scope must be the exact union of its record translations',
        'add an honest record-level implementation or remove the top-level capability'
      ));
    }
  }
  for (const fixture of providerFixtures.values()) {
    const provider = providers.get(fixture.doc.provider);
    const fixturePath = path.relative(root, fixture.file).split(path.sep).join('/');
    if (!provider || !provider.doc.fixtures.includes(fixturePath)) {
      out.push(violation(
        fixture.file,
        'SOTER_PROVIDER_FIXTURE',
        'provider fixture is not declared by its provider: ' + fixture.doc.provider,
        'unowned fixture data can silently bypass implementation and pack boundaries',
        'declare the fixture path on its provider implementation'
      ));
    }
    if (Array.isArray(fixture.doc.data?.records)) {
      const readDescriptors = (provider?.doc.capabilities || [])
        .map((capability) => parseRecordCapability(capability.id))
        .filter((descriptor) => descriptor?.operation === 'read');
      const grouped = new Map();
      for (const [index, record] of fixture.doc.data.records.entries()) {
        const matches = readDescriptors.flatMap((descriptor) => {
          return [...contextModels.values()]
            .filter((model) => {
              return model.doc.subject === descriptor.subject
                && model.doc.recordTypes.some((candidate) => candidate.id === record?.type);
            })
            .map((model) => ({ descriptor, model }));
        });
        if (matches.length !== 1) {
          out.push(violation(
            fixture.file,
            'SOTER_PROVIDER_FIXTURE_CONTEXT',
            '$.data.records[' + index + '].type must resolve through exactly one provider '
              + 'record-read capability and Context model; found ' + matches.length,
            'normalized fixture records must have one portable Context meaning and provider scope',
            'align the fixture provider capability and Context record definition'
          ));
          continue;
        }
        const match = matches[0];
        const key = match.descriptor.id + '|' + match.model.doc.id;
        if (!grouped.has(key)) grouped.set(key, { ...match, records: [] });
        grouped.get(key).records.push(record);
      }
      for (const group of grouped.values()) {
        const failures = contextRecordOutputErrors(
          [group.model],
          group.descriptor.id,
          { records: group.records },
          { modelId: group.model.doc.id }
        );
        for (const failure of failures.slice(0, 20)) {
          out.push(violation(
            fixture.file,
            'SOTER_PROVIDER_FIXTURE_CONTEXT',
            failure.path + ' ' + failure.message,
            'normalized fixture records must prove the same portable Context boundary as connected providers',
            'align the fixture record with the required Context model'
          ));
        }
      }
    }
  }
}

function checkRuntimeArtifacts(
  root,
  locks,
  runs,
  evidence,
  doctors,
  snapshots,
  automationDecisions,
  contextModels,
  providers,
  providerProbes,
  hostToolCalls,
  approvals,
  changeSets,
  hosts,
  out
) {
  const lockByFingerprint = new Map();
  const hostToolMappingFor = (lock, server, operation) => {
    if (!lock || !operation) return null;
    const host = hosts.get(lock.doc.host.adapter);
    const route = host?.doc.mcpServers.find((candidate) => candidate.id === server);
    const matches = route?.toolMappings.filter((mapping) => mapping.logical === operation) || [];
    return matches.length === 1 ? matches[0] : null;
  };
  for (const entry of locks) {
    const fingerprint = fingerprintJson(entry.doc);
    lockByFingerprint.set(fingerprint, entry);
    const relativeLockPath = path.relative(root, entry.file).split(path.sep).join('/');
    const historicalWorkflowEvidenceBasis = workflowEvidenceBasisForPath(
      relativeLockPath
    );
    const selectedHost = hosts.get(entry.doc.host.adapter);
    if (entry.doc.configuration.hostSelection.id !== entry.doc.host.id
      || !selectedHost
      || (historicalWorkflowEvidenceBasis
        && (entry.doc.configuration.name !== historicalWorkflowEvidenceBasis.configuration
          || entry.doc.host.id !== historicalWorkflowEvidenceBasis.host
          || entry.doc.host.adapter !== historicalWorkflowEvidenceBasis.adapter))
      || (!historicalWorkflowEvidenceBasis
        && (selectedHost.doc.host !== entry.doc.host.id
          || selectedHost.doc.version !== entry.doc.host.version
          || fingerprintJson(selectedHost.doc) !== entry.doc.host.manifestFingerprint))) {
      out.push(violation(
        entry.file,
        'SOTER_LOCK_HOST_SELECTION',
        historicalWorkflowEvidenceBasis
          ? 'historical workflow evidence-basis lock has no recognized selected host'
          : 'lock host selection, adapter identity, version, or manifest fingerprint disagree',
        historicalWorkflowEvidenceBasis
          ? 'an immutable observation basis preserves its historical adapter bytes, but its host identity must remain governed'
          : 'a portable configuration must still bind one exact reproducible host realization',
        historicalWorkflowEvidenceBasis
          ? 'restore the exact historical basis lock and its governed host identity'
          : 'resolve the configuration again for the intended compatible host'
      ));
    }
    const unsigned = { ...entry.doc };
    delete unsigned.graphFingerprint;
    const expectedGraphFingerprint = fingerprintJson(unsigned);
    if (entry.doc.graphFingerprint !== expectedGraphFingerprint) {
      out.push(violation(
        entry.file,
        'SOTER_LOCK_FINGERPRINT',
        'lock graph fingerprint does not match its resolved contents',
        'a lock cannot establish reproducibility if its own integrity marker is stale',
        'resolve the configuration again and replace dependent runtime artifacts'
      ));
    }
  }

  const requireLock = (entry, fingerprint, kind) => {
    const lock = lockByFingerprint.get(fingerprint);
    if (!lock) {
      out.push(violation(
        entry.file,
        'SOTER_RUNTIME_LINK',
        kind + ' references a configuration lock that is not present: ' + fingerprint,
        'runtime and evidence claims must be traceable to an inspectable exact graph',
        'include the referenced lock or regenerate the ' + kind + ' from a present lock'
      ));
    }
    return lock;
  };

  const requireEvidence = (entry, evidenceId, kind) => {
    if (!evidence.has(evidenceId)) {
      out.push(violation(
        entry.file,
        'SOTER_RUNTIME_LINK',
        kind + ' references evidence that is not present: ' + evidenceId,
        'state transitions and health claims require inspectable supporting evidence',
        'include the evidence record or remove the unsupported reference'
      ));
    }
  };

  for (const entry of runs.values()) {
    const lock = requireLock(entry, entry.doc.configurationLock.fingerprint, 'run envelope');
    if (lock && entry.doc.graphFingerprint !== lock.doc.graphFingerprint) {
      out.push(violation(
        entry.file,
        'SOTER_RUNTIME_LINK',
        'run envelope graph fingerprint disagrees with its configuration lock',
        'a run must execute against the exact graph it names',
        'regenerate the run envelope from the referenced lock'
      ));
    }
    entry.doc.evidenceIds.forEach((id) => requireEvidence(entry, id, 'run envelope'));
  }

  for (const entry of evidence.values()) {
    const privateContainedBasis = entry.doc.privateContainedBasis || null;
    let lock = null;
    if (privateContainedBasis) {
      const basisFingerprint = fingerprintPrivateContainedBasis(privateContainedBasis);
      const privateLockIsTracked = lockByFingerprint.has(
        privateContainedBasis.privateLockFingerprint
      );
      if (entry.doc.configurationLockFingerprint
          !== privateContainedBasis.privateLockFingerprint
        || entry.doc.graphFingerprint !== privateContainedBasis.privateGraphFingerprint
        || privateContainedBasis.privateLockFingerprint
          === privateContainedBasis.trackedTemplateLockFingerprint
        || privateContainedBasis.privateGraphFingerprint
          === privateContainedBasis.trackedTemplateGraphFingerprint
        || privateContainedBasis.basisFingerprint !== basisFingerprint
        || privateLockIsTracked
        || ![
          '.contained-connected-workflow',
          '.contained-connected-review'
        ].some((suffix) => entry.doc.evaluator.id.endsWith(suffix))
        || entry.doc.evaluator.level !== 'fixture'
        || entry.doc.environment.containment !== 'fixture') {
        out.push(violation(
          entry.file,
          'SOTER_PRIVATE_CONTAINED_BASIS',
          'private-contained evidence has an invalid private execution commitment or evaluator boundary',
          'private fixture execution may omit its full lock only when an exact closed derivation preserves the actual private fingerprints and no private lock is tracked',
          'regenerate the evidence through the contained private configuration helper'
        ));
      }
      lock = requireLock(
        entry,
        privateContainedBasis.trackedTemplateLockFingerprint,
        'private-contained evidence template'
      );
      const optionScopeCount
        = privateContainedBasis.substitutions.notionOptionMappingScopeCount;
      const optionEntryCount
        = privateContainedBasis.substitutions.notionOptionMappingEntryCount;
      if (lock
        && (lock.doc.configuration.name !== privateContainedBasis.configurationName
          || lock.doc.configuration.fingerprint
            === privateContainedBasis.privateConfigurationFingerprint
          || lock.doc.graphFingerprint
            !== privateContainedBasis.trackedTemplateGraphFingerprint
          || fingerprintPrivateContainedLockProjection(lock.doc)
            !== privateContainedBasis.applicabilityProjectionFingerprint
          || (optionScopeCount === 0
            ? (optionEntryCount !== 0
              || privateContainedBasis.substitutions.notionOptionMappingScopeFingerprint
                !== fingerprintJson([]))
            : optionEntryCount < optionScopeCount))) {
        out.push(violation(
          entry.file,
          'SOTER_PRIVATE_CONTAINED_APPLICABILITY',
          'private-contained evidence does not match its present portable template lock',
          'a private contained run is portable only when every non-private behavior input is an exact projection of one inspectable tracked lock',
          'regenerate the private realization and evidence from the current tracked template lock'
        ));
      }
    } else {
      lock = requireLock(
        entry,
        entry.doc.configurationLockFingerprint,
        'evidence record'
      );
    }
    if (lock) {
      const lockedPacks = new Map(lock.doc.packs.map((pack) => [pack.id, pack]));
      for (const dependency of entry.doc.dependencies) {
        const pack = lockedPacks.get(dependency.id);
        if (!pack
          || pack.version !== dependency.version
          || pack.manifestFingerprint !== dependency.fingerprint) {
          out.push(violation(
            entry.file,
            'SOTER_EVIDENCE_DEPENDENCY',
            'evidence dependency does not match its configuration lock: ' + dependency.id,
            'evidence is applicable only to the exact versions and artifacts it evaluated',
            'regenerate the evidence against the referenced lock'
          ));
        }
      }
      if (entry.contractId === 'soter://contracts/evidence/v2') {
        const expectedDependencies = lock.doc.packs.map((pack) => ({
          id: pack.id,
          version: pack.version,
          fingerprint: pack.manifestFingerprint
        })).sort((left, right) => left.id.localeCompare(right.id));
        const observedDependencies = [...entry.doc.dependencies]
          .sort((left, right) => left.id.localeCompare(right.id));
        const expectedHost = {
          id: lock.doc.host.id,
          adapter: lock.doc.host.adapter,
          version: lock.doc.host.version,
          manifestFingerprint: lock.doc.host.manifestFingerprint
        };
        const expectedIntegrations = lock.doc.packs.filter((pack) => pack.layer === 'integration')
          .map((pack) => ({
            id: pack.id,
            version: pack.version,
            manifestFingerprint: pack.manifestFingerprint,
            evidenceMaturity: pack.evidenceMaturity
          }))
          .sort((left, right) => left.id.localeCompare(right.id));
        const observedIntegrations = [...entry.doc.integrations]
          .sort((left, right) => left.id.localeCompare(right.id));
        const expectedAuthorities = lock.doc.authorities.map((authority) => ({
          id: authority.id,
          role: authority.role,
          subject: authority.subject,
          declarationFingerprint: authority.declarationFingerprint
        })).sort((left, right) => left.id.localeCompare(right.id));
        const observedAuthorities = [...entry.doc.authorities]
          .sort((left, right) => left.id.localeCompare(right.id));
        const graphApplicable = privateContainedBasis
          ? privateContainedBasis.trackedTemplateGraphFingerprint
            === lock.doc.graphFingerprint
          : entry.doc.graphFingerprint === lock.doc.graphFingerprint;
        if (!graphApplicable
          || !deepEqual(observedDependencies, expectedDependencies)
          || !deepEqual(entry.doc.host, expectedHost)
          || !deepEqual(observedIntegrations, expectedIntegrations)
          || !deepEqual(observedAuthorities, expectedAuthorities)) {
          out.push(violation(
            entry.file,
            'SOTER_EVIDENCE_APPLICABILITY',
            'evidence/v2 does not reproduce the exact graph, complete dependency set, host, integrations, and authorities of its lock',
            'versioned evidence is applicable only when every behavior-relevant locked input is exact',
            'regenerate the evidence from its exact referenced lock rather than copying or editing applicability fields'
          ));
        }
      }
    }
  }

  for (const entry of evidence.values()) {
    if (entry.contractId !== 'soter://contracts/evidence/v2' || !entry.doc.supersedes) continue;
    const prior = evidence.get(entry.doc.supersedes);
    if (!prior
      || prior.contractId !== 'soter://contracts/evidence/v2'
      || prior.doc.claimFamily !== entry.doc.claimFamily
      || !deepEqual(prior.doc.subject, entry.doc.subject)) {
      out.push(violation(
        entry.file,
        'SOTER_EVIDENCE_SUPERSEDES',
        'evidence/v2 supersedes an absent or differently scoped record: ' + entry.doc.supersedes,
        'replacement evidence must preserve an inspectable immutable claim lineage',
        'reference an existing evidence/v2 record for the same claim family and exact subject'
      ));
    }
  }
  for (const entry of evidence.values()) {
    if (entry.contractId !== 'soter://contracts/evidence/v2') continue;
    const seen = new Set([entry.doc.id]);
    let nextId = entry.doc.supersedes;
    while (nextId) {
      if (seen.has(nextId)) {
        out.push(violation(
          entry.file,
          'SOTER_EVIDENCE_SUPERSEDES',
          'evidence/v2 supersession lineage contains a cycle at ' + nextId,
          'cyclic replacement records have no unambiguous active evidence head',
          'replace the cycle with an append-only acyclic supersession chain'
        ));
        break;
      }
      seen.add(nextId);
      const next = evidence.get(nextId);
      nextId = next?.contractId === 'soter://contracts/evidence/v2'
        ? next.doc.supersedes
        : null;
    }
  }

  for (const entry of doctors.values()) {
    const doctorLock = requireLock(entry, entry.doc.configuration.lockFingerprint, 'doctor result');
    entry.doc.evidenceIds.forEach((id) => requireEvidence(entry, id, 'doctor result'));
    entry.doc.checks.flatMap((check) => check.evidenceIds)
      .forEach((id) => requireEvidence(entry, id, 'doctor check'));
    entry.doc.diagnostics.flatMap((item) => item.evidenceIds)
      .forEach((id) => requireEvidence(entry, id, 'doctor diagnostic'));
    for (const id of entry.doc.providerProbeIds) {
      const probe = providerProbes.get(id);
      if (!probe) {
        out.push(violation(
          entry.file,
          'SOTER_RUNTIME_LINK',
          'doctor result references a provider probe that is not present: ' + id,
          'connected readiness must remain traceable to the exact observation that supports it',
          'include the provider probe or remove the unsupported reference'
        ));
      } else if (probe.doc.configuration.lockFingerprint !== entry.doc.configuration.lockFingerprint
        || probe.doc.configuration.name !== entry.doc.configuration.name) {
        out.push(violation(
          entry.file,
          'SOTER_RUNTIME_LINK',
          'doctor result and provider probe reference different configurations: ' + id,
          'a provider observation cannot establish readiness for another resolved graph',
          'regenerate the doctor from probes for the same exact lock'
        ));
      }
    }
    if (entry.doc.level === 'offline' && entry.doc.providerProbeIds.length) {
      out.push(violation(
        entry.file,
        'SOTER_DOCTOR_SCOPE',
        'offline doctor result references connected provider probes',
        'offline diagnostics must remain effect-free and independent of provider state',
        'remove provider probes or classify the result as connected'
      ));
    }
    if (doctorLock && entry.doc.configuration.name !== doctorLock.doc.configuration.name) {
      out.push(violation(
        entry.file,
        'SOTER_RUNTIME_LINK',
        'doctor result configuration name disagrees with its lock',
        'human-readable state labels must identify the same configuration as the exact fingerprint',
        'regenerate the doctor result from the referenced lock'
      ));
    }
  }

  for (const entry of providerProbes.values()) {
    const lock = requireLock(entry, entry.doc.configuration.lockFingerprint, 'provider probe');
    const provider = providers.get(entry.doc.provider.implementation);
    if (!provider
      || provider.doc.pack !== entry.doc.provider.pack
      || provider.doc.version !== entry.doc.provider.version
      || provider.doc.containment !== entry.doc.provider.containment) {
      out.push(violation(
        entry.file,
        'SOTER_PROVIDER_PROBE_LINK',
        'provider probe has no exact declared connected implementation: ' + entry.doc.provider.implementation,
        'connection observations are meaningful only for one inspectable implementation version',
        'declare the exact provider or regenerate the probe from the selected implementation'
      ));
      continue;
    }
    if (lock && lock.doc.configuration.name !== entry.doc.configuration.name) {
      out.push(violation(
        entry.file,
        'SOTER_PROVIDER_PROBE_LINK',
        'provider probe configuration name disagrees with its lock',
        'runtime observations cannot be reused across named configurations by fingerprint alone',
        'regenerate the probe for the referenced configuration'
      ));
    }
    for (const item of entry.doc.capabilities) {
      if (!provider.doc.capabilities.some((capability) => capability.id === item.id)) {
        out.push(violation(
          entry.file,
          'SOTER_PROVIDER_PROBE_CAPABILITY',
          'probe reports a capability the provider does not implement: ' + item.id,
          'readiness checks cannot expand an integration implementation by assertion',
          'remove the check or declare and implement the capability'
        ));
      }
    }
    if (lock) {
      const boundAuthorities = new Set(lock.doc.bindings
        .filter((binding) => binding.providerPack === provider.doc.pack)
        .flatMap((binding) => binding.authorities));
      for (const item of entry.doc.authorities) {
        if (!boundAuthorities.has(item.id)) {
          out.push(violation(
            entry.file,
            'SOTER_PROVIDER_PROBE_AUTHORITY',
            'probe reports an authority outside the resolved provider bindings: ' + item.id,
            'connection checks must stay within the exact user-selected authority scope',
            'remove the authority or resolve it into the provider binding before probing'
          ));
        }
      }
    }
  }

  for (const entry of hostToolCalls.values()) {
    const lock = requireLock(entry, entry.doc.configurationLockFingerprint, 'host tool call');
    const run = runs.get(entry.doc.runId);
    const provider = providers.get(entry.doc.provider.implementation);
    if (!run
      || run.doc.configurationLock.fingerprint !== entry.doc.configurationLockFingerprint
      || run.doc.graphFingerprint !== entry.doc.graphFingerprint) {
      out.push(violation(
        entry.file,
        'SOTER_HOST_TOOL_LINK',
        'host tool call has no exact matching run envelope: ' + entry.doc.runId,
        'external calls must remain attributable to the run and graph that authorized them',
        'include the exact run or regenerate the host tool request'
      ));
    }
    if (!provider
      || provider.doc.pack !== entry.doc.provider.pack
      || provider.doc.version !== entry.doc.provider.version
      || provider.doc.containment !== entry.doc.provider.containment
      || provider.doc.runtime.engine !== 'mcp'
      || provider.doc.runtime.server !== entry.doc.transport.server
      || (entry.doc.transport.operation
        && !provider.doc.runtime.tools.includes(entry.doc.transport.operation))
      || (entry.doc.transport.operation
        && hostToolMappingFor(lock, entry.doc.transport.server, entry.doc.transport.operation)?.native
          !== entry.doc.transport.tool)
      || (entry.doc.transport.operation
        && hostToolMappingFor(lock, entry.doc.transport.server, entry.doc.transport.operation)?.responseProfile
          !== entry.doc.transport.responseProfile)
      || (entry.doc.transport.responseProfile
        && !provider?.doc.runtime.responseProfiles.includes(entry.doc.transport.responseProfile))) {
      out.push(violation(
        entry.file,
        'SOTER_HOST_TOOL_PROVIDER',
        'host tool call has no exact declared MCP provider: ' + entry.doc.provider.implementation,
        'host dispatch must not expand or substitute an integration implementation at runtime',
        'regenerate the request from the exact selected MCP provider declaration'
      ));
    }
    if (lock) {
      const binding = lock.doc.bindings.find((item) => {
        return item.capability === entry.doc.capability.id
          && item.capabilityVersion === entry.doc.capability.version
          && item.providerPack === entry.doc.provider.pack
          && item.authorities.includes(entry.doc.authority);
      });
      if (!binding
        || lock.doc.graphFingerprint !== entry.doc.graphFingerprint
        || lock.doc.host.id !== entry.doc.host.id
        || lock.doc.host.adapter !== entry.doc.host.adapter
        || lock.doc.host.version !== entry.doc.host.version) {
        out.push(violation(
          entry.file,
          'SOTER_HOST_TOOL_SCOPE',
          'host tool call is outside its locked capability, authority, graph, or host scope',
          'portable tool execution must preserve the exact user-selected graph and authority boundary',
          'prepare the request again from the referenced lock'
        ));
      }
    }
    if (entry.doc.arguments !== null
      && entry.doc.argumentsFingerprint !== fingerprintJson(entry.doc.arguments)) {
      out.push(violation(
        entry.file,
        'SOTER_HOST_TOOL_FINGERPRINT',
        'host tool arguments fingerprint is stale',
        'the executed request must be identical to the reviewed and recorded request',
        'regenerate the request or restore the original arguments'
      ));
    }
    const blockedByPolicy = entry.doc.policyDecisions.some((item) => item.decision === 'blocked');
    const requestedShape = entry.doc.transport.operation !== null
      && entry.doc.transport.tool !== null
      && entry.doc.arguments !== null
      && entry.doc.argumentsFingerprint !== null;
    const validLifecycle = (entry.doc.state === 'requested'
        && entry.doc.completedAt === null
        && requestedShape
        && entry.doc.responseFingerprint === null
        && entry.doc.outputFingerprint === null
        && entry.doc.error === null
        && !blockedByPolicy)
      || (entry.doc.state === 'completed'
        && entry.doc.completedAt !== null
        && requestedShape
        && entry.doc.responseFingerprint !== null
        && entry.doc.outputFingerprint !== null
        && entry.doc.error === null
        && !blockedByPolicy)
      || (entry.doc.state === 'failed'
        && entry.doc.completedAt !== null
        && entry.doc.error !== null)
      || (entry.doc.state === 'blocked'
        && entry.doc.completedAt !== null
        && !requestedShape
        && entry.doc.responseFingerprint === null
        && entry.doc.outputFingerprint === null
        && entry.doc.error !== null
        && blockedByPolicy);
    if (!validLifecycle) {
      out.push(violation(
        entry.file,
        'SOTER_HOST_TOOL_STATE',
        'host tool call fields disagree with lifecycle state ' + entry.doc.state,
        'requested, completed, failed, and policy-blocked calls need mechanically distinct evidence',
        'regenerate the call through the Core host-tool state machine'
      ));
    }
  }

  for (const entry of snapshots.values()) {
    const lock = requireLock(entry, entry.doc.configurationLockFingerprint, 'context snapshot');
    const run = runs.get(entry.doc.runId);
    if (!run) {
      out.push(violation(
        entry.file,
        'SOTER_RUNTIME_LINK',
        'context snapshot references a run that is not present: ' + entry.doc.runId,
        'assembled context must remain attributable to the run that requested it',
        'include the run envelope or correct the run identifier'
      ));
    } else {
      if (run.doc.configurationLock.fingerprint !== entry.doc.configurationLockFingerprint
        || run.doc.graphFingerprint !== entry.doc.graphFingerprint) {
        out.push(violation(
          entry.file,
          'SOTER_RUNTIME_LINK',
          'context snapshot lock or graph disagrees with its run envelope',
          'context is applicable only to the exact run graph that assembled it',
          'regenerate the snapshot from the referenced run and lock'
        ));
      }
      const runEffectIds = new Set(run.doc.effects.map((effect) => effect.id));
      for (const effectId of entry.doc.effectIds) {
        if (!runEffectIds.has(effectId)) {
          out.push(violation(
            entry.file,
            'SOTER_RUNTIME_LINK',
            'context snapshot references an absent run effect: ' + effectId,
            'every loaded value must be attributable to the capability effect that produced it',
            'record the effect on the run envelope or remove the unsupported context entry'
          ));
        }
      }
    }
    if (lock && lock.doc.graphFingerprint !== entry.doc.graphFingerprint) {
      out.push(violation(
        entry.file,
        'SOTER_RUNTIME_LINK',
        'context snapshot graph fingerprint disagrees with its lock',
        'context cannot be reused across a different resolved graph',
        'regenerate the context snapshot from the referenced lock'
      ));
    }
    for (const item of entry.doc.entries) {
      const provider = providers.get(item.providerImplementation);
      if (!provider
        || provider.doc.pack !== item.providerPack
        || provider.doc.version !== item.providerVersion
        || !provider.doc.capabilities.some((capability) => capability.id === item.capability)) {
        out.push(violation(
          entry.file,
          'SOTER_CONTEXT_PROVIDER',
          'context entry has no matching provider implementation: ' + item.id,
          'loaded context must identify the exact implementation that produced it',
          'correct the provider reference or regenerate the snapshot'
        ));
      }
      if (item.valueFingerprint !== fingerprintJson(item.value)) {
        out.push(violation(
          entry.file,
          'SOTER_CONTEXT_FINGERPRINT',
          'context value fingerprint is stale: ' + item.id,
          'context integrity must be independently checkable after compaction or resume',
          'regenerate the snapshot from its provider fixture'
        ));
      }
    }
  }

  for (const entry of automationDecisions.values()) {
    const lock = requireLock(
      entry,
      entry.doc.configurationLockFingerprint,
      'automation decision'
    );
    const snapshot = snapshots.get(entry.doc.context.snapshotId);
    const run = runs.get(entry.doc.runId);
    const unsigned = structuredClone(entry.doc);
    delete unsigned.decisionFingerprint;
    if (entry.doc.decisionFingerprint !== fingerprintJson(unsigned)) {
      out.push(violation(
        entry.file,
        'SOTER_AUTOMATION_DECISION_FINGERPRINT',
        'automation decision fingerprint is stale',
        'a proposal must bind the exact durable judgment and grounding artifact',
        'regenerate the decision from the exact bounded context'
      ));
    }
    if (!snapshot
      || snapshot.doc.runId !== entry.doc.runId
      || fingerprintJson(snapshot.doc) !== entry.doc.context.snapshotFingerprint) {
      out.push(violation(
        entry.file,
        'SOTER_AUTOMATION_DECISION_CONTEXT',
        'automation decision does not bind its exact context snapshot',
        'host judgment is reusable only for the exact bounded context it interpreted',
        'include the matching snapshot or regenerate the decision'
      ));
    }
    const selectedAutomation = lock?.doc.packs.filter((pack) => {
      return pack.id === entry.doc.automation.id && pack.layer === 'automation';
    }) || [];
    if (!run
      || run.doc.automation.id !== entry.doc.automation.id
      || run.doc.automation.version !== entry.doc.automation.version
      || selectedAutomation.length !== 1
      || selectedAutomation[0].version !== entry.doc.automation.version
      || !run.doc.outputs.some((output) => {
        return output.id === entry.doc.id
          && output.type === 'automation-decision'
          && output.fingerprint === entry.doc.decisionFingerprint;
      })) {
      out.push(violation(
        entry.file,
        'SOTER_AUTOMATION_DECISION_LINK',
        'automation decision does not match its exact run and selected Automation pack',
        'domain judgment must remain attributable to one run and one versioned Automation owner',
        'regenerate the run and decision together'
      ));
    }
  }

  for (const entry of changeSets.values()) {
    const changeSetLock = requireLock(
      entry,
      entry.doc.configurationLockFingerprint,
      'change set'
    );
    const selectedContextPackIds = new Set(
      (changeSetLock?.doc.packs || [])
        .filter((pack) => pack.layer === 'context')
        .map((pack) => pack.id)
    );
    const selectedContextModels = new Map([...contextModels].filter(([, model]) => {
      return selectedContextPackIds.has(model.doc.pack);
    }));
    const run = runs.get(entry.doc.runId);
    if (entry.doc.basis?.kind === 'automation-decision') {
      const decision = automationDecisions.get(entry.doc.basis.id);
      if (!decision
        || decision.doc.runId !== entry.doc.runId
        || decision.doc.state !== 'ready'
        || decision.doc.decisionFingerprint !== entry.doc.basis.fingerprint
        || decision.doc.context.snapshotId !== entry.doc.basis.contextSnapshotId
        || decision.doc.context.snapshotFingerprint
          !== entry.doc.basis.contextSnapshotFingerprint) {
        out.push(violation(
          entry.file,
          'SOTER_TRANSACTION_DECISION_BASIS',
          'change set does not bind one exact ready Automation decision and context snapshot',
          'review and approval must cover the same grounded judgment that produced the operations',
          'regenerate the change set from the exact ready decision'
        ));
      }
    }
    if (!run) {
      out.push(violation(
        entry.file,
        'SOTER_TRANSACTION_LINK',
        'change set references an absent run: ' + entry.doc.runId,
        'mutation state must remain attributable to its exact run envelope',
        'include the run envelope or correct the run id'
      ));
    } else {
      const effectIds = new Set(run.doc.effects.map((effect) => effect.id));
      for (const operation of entry.doc.operations) {
        if (operation.inputFingerprint !== fingerprintJson(operation.input)) {
          out.push(violation(
            entry.file,
            'SOTER_TRANSACTION_INPUT',
            'change-set operation input fingerprint is stale: ' + operation.id,
            'an approval scope cannot bind an operation whose portable input changed',
            'regenerate the change set and obtain a new approval'
          ));
        }
        const contextFailures = contextRecordInputErrors(
          selectedContextModels,
          operation.capability,
          operation.input
        );
        for (const failure of contextFailures.slice(0, 10)) {
          out.push(violation(
            entry.file,
            'SOTER_TRANSACTION_CONTEXT_MODEL',
            operation.id + ' ' + failure.path + ' ' + failure.message,
            'Automation writes must use portable record meaning owned and typed by Context',
            'align the operation with the selected Context record model'
          ));
        }
        if (operation.effectId && !effectIds.has(operation.effectId)) {
          out.push(violation(
            entry.file,
            'SOTER_TRANSACTION_LINK',
            'change-set operation references an absent run effect: ' + operation.effectId,
            'every attempted mutation must be visible in the durable run envelope',
            'record the invocation or regenerate the transaction artifacts'
          ));
        }
      }
      if (entry.doc.verification.effectId && !effectIds.has(entry.doc.verification.effectId)) {
        out.push(violation(
          entry.file,
          'SOTER_TRANSACTION_LINK',
          'change-set verification references an absent run effect',
          'post-write claims require an inspectable read-after-write invocation',
          'record the verification invocation on the run envelope'
        ));
      }
    }
    const expectedScope = fingerprintJson({
      id: entry.doc.id,
      runId: entry.doc.runId,
      configurationLockFingerprint: entry.doc.configurationLockFingerprint,
      basis: entry.doc.basis || null,
      operations: entry.doc.operations.map((operation) => ({
        id: operation.id,
        capability: operation.capability,
        authority: operation.authority,
        inputFingerprint: operation.inputFingerprint
      }))
    });
    if (entry.doc.scopeFingerprint !== expectedScope) {
      out.push(violation(
        entry.file,
        'SOTER_APPROVAL_SCOPE',
        'change-set scope fingerprint does not match its operations',
        'an approval cannot safely authorize a batch whose scope marker is stale',
        'recompute the change set and obtain a new approval'
      ));
    }
    if (entry.doc.approvalId) {
      const approval = approvals.get(entry.doc.approvalId);
      if (!approval
        || approval.doc.runId !== entry.doc.runId
        || approval.doc.scope.changeSetId !== entry.doc.id
        || approval.doc.scope.fingerprint !== entry.doc.scopeFingerprint) {
        out.push(violation(
          entry.file,
          'SOTER_APPROVAL_SCOPE',
          'change set has no matching exact-scope approval: ' + entry.doc.approvalId,
          'confirmation is valid only for the reviewed operation batch',
          'include the matching approval or return the change set to proposed state'
        ));
      }
    }
  }

  for (const entry of approvals.values()) {
    const changeSet = changeSets.get(entry.doc.scope.changeSetId);
    if (!runs.has(entry.doc.runId) || !changeSet
      || changeSet.doc.runId !== entry.doc.runId
      || changeSet.doc.scopeFingerprint !== entry.doc.scope.fingerprint) {
      out.push(violation(
        entry.file,
        'SOTER_APPROVAL_SCOPE',
        'approval is not linked to its exact run and change-set scope',
        'free-floating approval records could authorize unrelated effects',
        'regenerate the approval from the exact proposed change set'
      ));
    }
  }
}

function configuredOptionMappingRequirementScopes(
  configurationEntry,
  settingsDefinition,
  selected,
  packs,
  providerMappings
) {
  const requiredScopes = new Set();
  for (const packId of selected) {
    const automation = packs.get(packId)?.doc;
    if (automation?.layer !== 'automation') continue;
    const requirements = [
      ...(automation.operator?.acquisition?.recordRequirements || []),
      ...(automation.operator?.connection?.recordRequirements || [])
    ];
    for (const requirement of requirements) {
      const bindings = configurationEntry.doc.bindings.filter((binding) => {
        return binding.capability === requirement.capability;
      });
      if (bindings.length !== 1) continue;
      const matches = [...providerMappings.values()].filter((mapping) => {
        return mapping.doc.pack === bindings[0].providerPack
          && mapping.doc.settingsDefinition === settingsDefinition.doc.id
          && mapping.doc.capabilities.includes(requirement.capability);
      });
      for (const recordType of requirement.recordTypes) {
        const records = matches.flatMap((mapping) => {
          return mapping.doc.recordTypes
            .filter((record) => {
              return record.id === recordType
                && record.capabilities.includes(requirement.capability);
            })
            .map((record) => ({ mapping: mapping.doc, record }));
        });
        if (records.length !== 1) continue;
        for (const field of records[0].record.fields) {
          if (field.valueMapping !== 'configured-bijection') continue;
          requiredScopes.add([
            records[0].mapping.id,
            records[0].record.id,
            field.portable
          ].join('|'));
        }
      }
    }
  }
  return requiredScopes;
}

function checkPackSettingSemanticInvariants(
  configurationEntry,
  settingsDefinition,
  configured,
  selected,
  packs,
  providerMappings,
  out
) {
  for (const invariant of settingsDefinition.doc.semanticInvariants || []) {
    if (invariant !== 'option-mappings-exact-bijection') continue;
    const requiredScopes = configuredOptionMappingRequirementScopes(
      configurationEntry,
      settingsDefinition,
      selected,
      packs,
      providerMappings
    );
    const declarations = configured?.optionMappings;
    if (declarations === undefined) {
      const connectedTargets = Object.values(configured?.targets || {}).some((target) => {
        return typeof target === 'string' && target.startsWith('collection://');
      });
      if (connectedTargets && requiredScopes.size > 0) {
        out.push(violation(
          configurationEntry.file,
          'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
          'settings.' + settingsDefinition.doc.pack
            + ' omits private provider option mappings for selected connected Automation records',
          'connected provider targets cannot assume their choice vocabulary matches portable Context values',
          'configure every required exact-bijection scope before activating the private target'
        ));
      }
      continue;
    }
    if (!Array.isArray(declarations)) continue;
    const scopes = new Set();
    for (const declaration of declarations) {
      if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
        continue;
      }
      const scope = [
        declaration.mapping,
        declaration.recordType,
        declaration.field
      ].join('|');
      const mapping = providerMappings.get(declaration.mapping);
      const records = mapping?.doc.recordTypes?.filter((record) => {
        return record.id === declaration.recordType;
      }) || [];
      const fields = records.flatMap((record) => {
        return record.fields.filter((field) => field.portable === declaration.field);
      });
      if (!mapping
        || mapping.doc.settingsDefinition !== settingsDefinition.doc.id
        || !selected.has(mapping.doc.pack)
        || records.length !== 1
        || fields.length !== 1
        || !['select', 'multi_select', 'status'].includes(fields[0].providerType)
        || fields[0].valueMapping !== 'configured-bijection') {
        out.push(violation(
          configurationEntry.file,
          'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
          'settings.' + settingsDefinition.doc.pack
            + ' option-mapping scope does not resolve one selected configured-bijection field: '
            + scope,
          'private provider-value mappings must bind one exact selected Integration field declaration',
          'select the owning mapping and correct the mapping, record type, or portable field identity'
        ));
      }
      if (scopes.has(scope)) {
        out.push(violation(
          configurationEntry.file,
          'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
          'settings.' + settingsDefinition.doc.pack
            + ' contains a duplicate provider option-mapping scope: ' + scope,
          'one exact portable provider-choice field must resolve through one private mapping scope',
          'merge the duplicate scope into one exact bijection'
        ));
      }
      scopes.add(scope);
      if (!Array.isArray(declaration.entries)) continue;
      const portable = declaration.entries.map((entry) => entry?.portable);
      const provider = declaration.entries.map((entry) => entry?.provider);
      if (new Set(portable).size !== portable.length
        || new Set(provider).size !== provider.length) {
        out.push(violation(
          configurationEntry.file,
          'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
          'settings.' + settingsDefinition.doc.pack
            + ' contains a non-bijective provider option mapping: ' + scope,
          'portable and provider option values must each occur exactly once in an exact bijection',
          'remove the duplicate portable or provider projection'
        ));
      }
    }
    if (declarations.length > 0) {
      for (const scope of requiredScopes) {
        if (scopes.has(scope)) continue;
        out.push(violation(
          configurationEntry.file,
          'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
          'settings.' + settingsDefinition.doc.pack
            + ' omits a required connected Automation option-mapping scope: ' + scope,
          'once private provider option translation is configured, every selected connected record choice must be mapped exactly',
          'add the complete exact-bijection scope or remove the partial private option-mapping set'
        ));
      }
    }
  }
}

function checkConfiguration(
  root,
  entry,
  packs,
  capabilities,
  hosts,
  packSettings,
  contextModels,
  providerMappings,
  out
) {
  const doc = entry.doc;
  const selectedIds = [doc.base.kernel, doc.base.core, ...doc.packs.map((selection) => selection.id)];
  const selected = new Set(selectedIds);
  if (selected.size !== selectedIds.length) {
    out.push(violation(
      entry.file,
      'SOTER_SELECTION',
      'base and selectable pack lists contain a duplicate',
      'one exact desired selection should have one reason and one resolved version per pack',
      'remove the duplicate selection'
    ));
  }

  const kernel = packs.get(doc.base.kernel);
  const core = packs.get(doc.base.core);
  if (!kernel || kernel.doc.layer !== 'kernel') {
    out.push(violation(
      entry.file,
      'SOTER_BASE',
      'configuration kernel base is missing or not a kernel pack',
      'every conforming configuration requires an explicit kernel',
      'select a declared kernel pack'
    ));
  }
  if (!core || core.doc.layer !== 'core') {
    out.push(violation(
      entry.file,
      'SOTER_BASE',
      'configuration core base is missing or not a core pack',
      'every conforming configuration requires an explicit minimum core',
      'select a declared core pack'
    ));
  }

  const hostAdapter = hosts.get(doc.host.adapter);
  if (!hostAdapter) {
    out.push(violation(
      entry.file,
      'SOTER_HOST',
      'configured host adapter does not exist: ' + doc.host.adapter,
      'host projection cannot be inferred from an identifier alone',
      'declare the adapter or select an existing one'
    ));
  } else {
    if (hostAdapter.doc.host !== doc.host.id) {
      out.push(violation(
        entry.file,
        'SOTER_HOST',
        doc.host.adapter + ' targets ' + hostAdapter.doc.host + ', not ' + doc.host.id,
        'the active host and adapter contract must agree',
        'select the matching host adapter'
      ));
    }
    if (hostAdapter.doc.version !== doc.host.version) {
      out.push(violation(
        entry.file,
        'SOTER_HOST',
        'configured adapter version does not match ' + hostAdapter.doc.version,
        'host realization evidence is version-specific',
        'select the declared adapter version or add a compatible manifest'
      ));
    }
  }

  for (const id of selected) {
    const pack = packs.get(id);
    if (!pack) {
      out.push(violation(
        entry.file,
        'SOTER_SELECTION',
        'selected pack does not exist: ' + id,
        'desired configuration cannot resolve an absent pack',
        'add the pack or remove it from the configuration'
      ));
      continue;
    }
    if (!pack.doc.compatibility.hosts.includes(doc.host.id)) {
      out.push(violation(
        entry.file,
        'SOTER_HOST',
        id + ' does not declare compatibility with host ' + doc.host.id,
        'host realization must preserve every selected pack contract',
        'select a compatible host or add proven host support'
      ));
    }
    for (const dep of pack.doc.dependencies) {
      if (!dep.optional && !selected.has(dep.pack)) {
        out.push(violation(
          entry.file,
          'SOTER_SELECTION',
          id + ' requires unselected pack ' + dep.pack,
          'hidden transitive installation violates explicit user selection',
          'add the dependency visibly or remove the dependent pack'
        ));
      }
    }
  }

  for (const settings of packSettings.values()) {
    if (!selected.has(settings.doc.pack)) continue;
    const configured = doc.settings[settings.doc.pack];
    if (configured === undefined) {
      if (settings.doc.required) {
        out.push(violation(
          entry.file,
          'SOTER_PACK_SETTINGS_MISSING',
          'selected pack requires settings: ' + settings.doc.pack,
          'pack behavior cannot depend on defaults or prompt memory that are absent from desired configuration',
          'add settings.' + settings.doc.pack + ' using ' + settings.doc.id
        ));
      }
      continue;
    }
    const failures = schemaErrors(configured, settings.doc.schema);
    for (const failure of failures.slice(0, 20)) {
      out.push(violation(
        entry.file,
        'SOTER_PACK_SETTINGS_SCHEMA',
        'settings.' + settings.doc.pack + ' ' + failure.path + ' ' + failure.message,
        'selected pack settings must satisfy the schema owned by the exact pack version',
        'correct the settings or select a compatible pack version'
      ));
    }
    if (failures.length === 0) {
      checkPackSettingSemanticInvariants(
        entry,
        settings,
        configured,
        selected,
        packs,
        providerMappings,
        out
      );
    }
  }

  const authorities = new Map();
  for (const authority of doc.authorities) {
    if (authorities.has(authority.id)) {
      out.push(violation(
        entry.file,
        'SOTER_AUTHORITY',
        'duplicate authority id ' + authority.id,
        'a run must resolve one explicit source for each authority identity',
        'remove or rename the duplicate'
      ));
    }
    authorities.set(authority.id, authority);
  }
  const secretRefs = new Set(doc.secretRefs.map((secret) => secret.id));

  for (const id of selected) {
    const pack = packs.get(id);
    if (!pack) continue;
    for (const requirement of pack.doc.authorities) {
      if (!requirement.required) continue;
      const matched = doc.authorities.some((authority) => {
        return authority.role === requirement.role && authority.subject === requirement.subject;
      });
      if (!matched) {
        out.push(violation(
          entry.file,
          'SOTER_AUTHORITY',
          id + ' has no ' + requirement.role + ' authority for ' + requirement.subject,
          'definitions, instances, providers, projections, and evidence cannot be inferred from location',
          'declare an authority with the required role and subject'
        ));
      }
    }
  }

  const bindings = new Map();
  for (const binding of doc.bindings) {
    if (bindings.has(binding.capability)) {
      out.push(violation(
        entry.file,
        'SOTER_BINDING',
        'capability has more than one selected binding: ' + binding.capability,
        'a resolved configuration must choose one provider per required capability',
        'remove the duplicate binding'
      ));
      continue;
    }
    bindings.set(binding.capability, binding);
    const provider = packs.get(binding.providerPack);
    if (!selected.has(binding.providerPack) || !provider) {
      out.push(violation(
        entry.file,
        'SOTER_BINDING',
        'binding provider is not selected: ' + binding.providerPack,
        'capabilities cannot resolve through hidden or absent providers',
        'select the provider pack or change the binding'
      ));
    } else if (!provider.doc.capabilities.provides.some((item) => item.id === binding.capability)) {
      out.push(violation(
        entry.file,
        'SOTER_BINDING',
        binding.providerPack + ' does not provide ' + binding.capability,
        'provider choice must satisfy the declared capability contract',
        'choose a provider that advertises this capability'
      ));
    }
    for (const authority of binding.authorities) {
      if (!authorities.has(authority)) {
        out.push(violation(
          entry.file,
          'SOTER_BINDING',
          'binding authority does not exist: ' + authority,
          'a capability call must identify which source or store is authoritative',
          'declare the authority or correct the binding'
        ));
      }
    }
    if (binding.secretRef && !secretRefs.has(binding.secretRef)) {
      out.push(violation(
        entry.file,
        'SOTER_BINDING',
        'binding secret reference does not exist: ' + binding.secretRef,
        'authentication must resolve through a declared secret reference',
        'declare the secret reference without embedding its value'
      ));
    }
    if (!capabilities.has(binding.capability)) {
      out.push(violation(
        entry.file,
        'SOTER_BINDING',
        'binding capability has no contract: ' + binding.capability,
        'configuration cannot bind an undefined interface',
        'add the capability contract or remove the binding'
      ));
    }
    const recordDescriptor = parseRecordCapability(binding.capability);
    if (recordDescriptor) {
      const selectedModels = [...contextModels.values()].filter((model) => {
        return selected.has(model.doc.pack)
          && model.doc.subject === recordDescriptor.subject;
      });
      if (selectedModels.length !== 1) {
        out.push(violation(
          entry.file,
          'SOTER_BINDING_CONTEXT_MODEL',
          'record capability ' + binding.capability + ' resolves to '
            + selectedModels.length + ' selected Context models for '
            + recordDescriptor.subject,
          'a record capability must receive one selected portable meaning authority before provider binding',
          'select exactly one Context pack that owns ' + recordDescriptor.subject
        ));
      }
    }
  }

  for (const automationId of selected) {
    const automation = packs.get(automationId)?.doc;
    if (automation?.layer !== 'automation') continue;
    const connectedTargetPhases = [
      {
        phase: 'acquisition',
        requirements: automation.operator?.acquisition?.recordRequirements || []
      },
      {
        phase: 'connection',
        requirements: automation.operator?.connection?.recordRequirements || []
      }
    ];
    for (const targetPhase of connectedTargetPhases) {
      for (const requirement of targetPhase.requirements) {
        const binding = bindings.get(requirement.capability);
        if (!binding) continue;
        for (const recordType of requirement.recordTypes) {
          const matches = [];
          for (const mapping of providerMappings.values()) {
            if (mapping.doc.pack !== binding.providerPack
              || !mapping.doc.capabilities.includes(requirement.capability)) {
              continue;
            }
            for (const record of mapping.doc.recordTypes) {
              if (record.id === recordType
                && record.capabilities.includes(requirement.capability)) {
                matches.push({
                  mapping: mapping.doc.id,
                  settingsDefinition: mapping.doc.settingsDefinition,
                  target: record.target
                });
              }
            }
          }
          if (matches.length !== 1) {
            out.push(violation(
              entry.file,
              'SOTER_PACK_SETTINGS_REQUIRED_TARGET',
              'automation=' + automationId
                + ' phase=' + targetPhase.phase
                + ' capability=' + requirement.capability
                + ' providerPack=' + binding.providerPack
                + ' record=' + recordType
                + ' target=unresolved mappingMatches=' + matches.length,
              'a connected Automation record phase must resolve one exact provider mapping target before configuration can be accepted',
              'declare one selected provider mapping for the exact capability and record type'
            ));
            continue;
          }
          const { settingsDefinition, target } = matches[0];
          const settingsOwner = packSettings.get(settingsDefinition);
          if (!settingsOwner || settingsOwner.doc.pack !== binding.providerPack) {
            out.push(violation(
              entry.file,
              'SOTER_PACK_SETTINGS_REQUIRED_TARGET',
              'automation=' + automationId
                + ' phase=' + targetPhase.phase
                + ' capability=' + requirement.capability
                + ' providerPack=' + binding.providerPack
                + ' record=' + recordType
                + ' target=' + target
                + ' settingsDefinition=' + settingsDefinition
                + ' is unresolved',
              'a provider-mapped connected target must be governed by the selected provider pack settings definition',
              'declare the mapping settings definition on the bound provider pack'
            ));
            continue;
          }
          const configuredTarget = doc.settings?.[binding.providerPack]?.targets?.[target];
          if (configuredTarget === undefined) {
            out.push(violation(
              entry.file,
              'SOTER_PACK_SETTINGS_REQUIRED_TARGET',
              'automation=' + automationId
                + ' phase=' + targetPhase.phase
                + ' capability=' + requirement.capability
                + ' providerPack=' + binding.providerPack
                + ' record=' + recordType
                + ' target=' + target
                + ' is absent from settings.' + binding.providerPack + '.targets',
              'provider settings must include every exact collection target used by selected connected acquisition or execution, without requiring unrelated collections',
              'add settings.' + binding.providerPack + '.targets.' + target
            ));
          }
        }
      }
    }
  }

  const sourceIds = new Set();
  for (const source of doc.sources || []) {
    if (sourceIds.has(source.id)) {
      out.push(violation(
        entry.file,
        'SOTER_SOURCE',
        'configuration source ID is duplicated: ' + source.id,
        'each portable source must resolve to one exact capability input and authority',
        'remove or rename the duplicate source'
      ));
    }
    sourceIds.add(source.id);
    const binding = bindings.get(source.capability);
    const capability = capabilities.get(source.capability);
    if (!binding) {
      out.push(violation(
        entry.file,
        'SOTER_SOURCE',
        source.id + ' uses an unbound capability: ' + source.capability,
        'a source cannot bypass the user-selected provider binding',
        'bind the capability or remove the source'
      ));
    } else if (!binding.authorities.includes(source.authority)) {
      out.push(violation(
        entry.file,
        'SOTER_SOURCE',
        source.id + ' uses authority ' + source.authority
          + ' outside the selected ' + source.capability + ' binding',
        'source identity must remain inside the exact capability and authority selection',
        'select a bound authority for the source'
      ));
    }
    if (!capability) {
      out.push(violation(
        entry.file,
        'SOTER_SOURCE',
        source.id + ' references an absent capability contract: ' + source.capability,
        'portable source inputs require a machine-readable capability schema',
        'add the capability contract or correct the source'
      ));
    } else {
      const inputFailures = schemaErrors(source.input, capability.doc.inputSchema);
      for (const failure of inputFailures.slice(0, 20)) {
        out.push(violation(
          entry.file,
          'SOTER_SOURCE_INPUT',
          source.id + ' input ' + failure.path + ' ' + failure.message,
          'configured source input must satisfy the exact portable capability contract',
          'correct the source input or select a compatible capability version'
        ));
      }
      if (source.readiness?.mode === 'probe-read') {
        const unsafeEffects = (capability.doc.effects || []).filter((effect) => {
          return effect !== 'read' && effect !== 'disclosure';
        });
        const gatedEffects = (capability.doc.effects || []).filter((effect) => {
          return doc.effectPolicies[effect]?.mode !== 'allow';
        });
        if (unsafeEffects.length || gatedEffects.length) {
          out.push(violation(
            entry.file,
            'SOTER_SOURCE_PROBE',
            source.id + ' requests a readiness read for effects that are not safely allowed',
            'readiness probes cannot perform writes, dispatch, destructive work, or confirmation-gated effects',
            'use runtime-only readiness or choose a read-only capability with allowed effects'
          ));
        }
      }
    }
    const consumerKeys = new Set();
    for (const consumer of source.consumers || []) {
      const key = consumer.pack + '|' + consumer.purpose;
      if (consumerKeys.has(key)) {
        out.push(violation(
          entry.file,
          'SOTER_SOURCE_CONSUMER',
          source.id + ' repeats consumer ' + key,
          'one source-to-pack purpose should have one explicit applicability reason and subject set',
          'merge or remove the duplicate consumer declaration'
        ));
      }
      consumerKeys.add(key);
      if (!selected.has(consumer.pack)) {
        out.push(violation(
          entry.file,
          'SOTER_SOURCE_CONSUMER',
          source.id + ' names an unselected consumer pack: ' + consumer.pack,
          'source wiring cannot activate hidden or unselected behavior',
          'select the consumer pack or remove the source consumer'
        ));
      } else if (!packs.get(consumer.pack)?.doc.capabilities.requires.some((requirement) => {
        return requirement.id === source.capability;
      })) {
        out.push(violation(
          entry.file,
          'SOTER_SOURCE_CONSUMER',
          source.id + ' consumer ' + consumer.pack
            + ' does not require capability ' + source.capability,
          'source wiring must satisfy a capability dependency declared by its consuming pack',
          'declare the pack requirement or remove the source consumer'
        ));
      }
    }
  }

  for (const id of selected) {
    const pack = packs.get(id)?.doc;
    for (const requirement of pack?.sourceRequirements || []) {
      const matches = (doc.sources || []).filter((source) => {
        const authority = authorities.get(source.authority);
        return source.capability === requirement.capability
          && authority?.role === requirement.authorityRole
          && authority.subject === requirement.authoritySubject
          && (source.consumers || []).some((consumer) => {
            return consumer.pack === id && consumer.purpose === requirement.purpose;
          });
      });
      if (requirement.minimum > requirement.maximum
        || matches.length < requirement.minimum
        || matches.length > requirement.maximum) {
        out.push(violation(
          entry.file,
          'SOTER_SOURCE_REQUIREMENT',
          id + ' requires ' + requirement.minimum + ' through ' + requirement.maximum
            + ' ' + requirement.purpose + ' source(s); found ' + matches.length,
          'a selected pack must receive the explicit portable sources declared by its manifest',
          'add or remove matching source consumers, or select a compatible pack version'
        ));
      }
    }
  }

  const requiredCapabilities = new Set();
  for (const id of selected) {
    const pack = packs.get(id);
    if (!pack) continue;
    for (const requirement of pack.doc.capabilities.requires) {
      if (!requirement.optional) requiredCapabilities.add(requirement.id);
    }
  }
  for (const capability of requiredCapabilities) {
    if (!bindings.has(capability)) {
      out.push(violation(
        entry.file,
        'SOTER_BINDING',
        'required capability is unbound: ' + capability,
        'the selected automation is not ready without an explicit provider',
        'add one binding to a selected compatible integration pack'
      ));
    }
  }
  for (const capability of bindings.keys()) {
    if (!requiredCapabilities.has(capability)) {
      out.push(violation(
        entry.file,
        'SOTER_BINDING',
        'configuration binds an unrequested capability: ' + capability,
        'unused bindings create hidden permissions and confusing configuration',
        'remove the binding or select a pack that requires it'
      ));
    }
  }

  const selectedEffects = new Set();
  for (const id of selected) {
    const pack = packs.get(id);
    for (const effect of pack?.doc.effects || []) selectedEffects.add(effect);
  }
  for (const effect of EFFECTS) {
    if (!doc.effectPolicies[effect]) {
      out.push(violation(
        entry.file,
        'SOTER_EFFECT_POLICY',
        'effect policy is missing for ' + effect,
        'every possible effect needs an explicit default',
        'declare allow, confirm, or prohibit with a reason'
      ));
    } else if (selectedEffects.has(effect) && doc.effectPolicies[effect].mode === 'prohibit') {
      out.push(violation(
        entry.file,
        'SOTER_EFFECT_POLICY',
        'selected packs require prohibited effect ' + effect,
        'a configuration cannot be ready while its required behavior is forbidden',
        'remove the pack or choose an appropriate effect policy'
      ));
    }
  }
}

function checkScenario(root, entry, packs, capabilities, configs, legacyInventory, out) {
  const automation = packs.get(entry.doc.automation);
  if (!automation || automation.doc.layer !== 'automation') {
    out.push(violation(
      entry.file,
      'SOTER_SCENARIO',
      'scenario automation does not resolve to an automation pack',
      'behavior evidence must identify the exact contract under test',
      'correct the automation id or add the pack'
    ));
    return;
  }
  const required = new Set(automation.doc.capabilities.requires.map((item) => item.id));
  for (const capability of entry.doc.expected.capabilityOrder) {
    if (!required.has(capability) || !capabilities.has(capability)) {
      out.push(violation(
        entry.file,
        'SOTER_SCENARIO',
        'scenario calls undeclared capability ' + capability,
        'fixtures cannot smuggle provider behavior around the automation contract',
        'declare the capability requirement or correct the scenario'
      ));
    }
  }
  for (const sourceCase of entry.doc.sourceCases) {
    const inventorySource = legacyInventory?.doc.items.find((item) => {
      return item.sourcePath === sourceCase;
    });
    const governedRemoval = inventorySource?.sourcePresence === 'removed'
      && ['migrated', 'retired'].includes(inventorySource.state);
    if (!fs.existsSync(path.join(root, sourceCase)) && !governedRemoval) {
      out.push(violation(
        entry.file,
        'SOTER_MIGRATION_PATH',
        'source evaluation does not exist: ' + sourceCase,
        'migration provenance must remain inspectable until the old case is retired',
        'correct the path or record an explicit retirement'
      ));
    }
  }
  const relevantConfigs = configs.filter((config) => {
    return config.doc.packs.some((selection) => selection.id === entry.doc.automation);
  });
  if (!relevantConfigs.length) {
    out.push(violation(
      entry.file,
      'SOTER_SCENARIO',
      'no desired configuration selects this automation',
      'a scenario without a resolvable configuration cannot prove runtime behavior',
      'add a configuration that selects and binds the automation'
    ));
  }
  for (const config of relevantConfigs) {
    for (const [effect, mode] of Object.entries(entry.doc.expected.effectModes)) {
      if (config.doc.effectPolicies[effect]?.mode !== mode) {
        out.push(violation(
          entry.file,
          'SOTER_SCENARIO',
          'scenario expects ' + effect + '=' + mode + ' but ' + config.doc.name + ' config differs',
          'scenario evidence must be tied to the exact effect policy under test',
          'align the scenario or desired configuration'
        ));
      }
    }
  }
}

function checkMigrationEvidence(root, entry, item, target, validateEvidenceContent, out) {
  const evidencePaths = item.evidence || [];
  const requiresEvidence = ['bridged', 'migrated', 'retired'].includes(item.state);
  if (requiresEvidence && !evidencePaths.length) {
    out.push(violation(
      entry.file,
      'SOTER_MIGRATION_EVIDENCE',
      item.state + ' item has no evidence: ' + item.sourcePath,
      'status words cannot substitute for an exact source, target, and evidence binding',
      'attach a passed evidence/v2 record that fingerprints the exact target'
    ));
    return;
  }
  if (!validateEvidenceContent) return;
  if (!evidencePaths.length || !target) return;
  const targetDoc = parseJson(target, out);
  if (!targetDoc) return;
  const targetFingerprint = targetDoc.$contract === 'soter://contracts/workflow-guide/v2'
    ? targetDoc.contentFingerprint
    : fingerprintJson(targetDoc);
  for (const evidencePath of evidencePaths) {
    const evidenceFile = resolveRegularRepositoryFile(root, evidencePath);
    if (!evidenceFile) {
      out.push(violation(
        entry.file,
        'SOTER_MIGRATION_EVIDENCE',
        'migration evidence does not resolve inside the repository: ' + evidencePath,
        'a bridge cannot rely on missing or path-escaping proof',
        'use one existing repository-relative evidence/v2 path'
      ));
      continue;
    }
    const evidence = parseJson(evidenceFile, out);
    if (!evidence) continue;
    if (evidence.$contract !== 'soter://contracts/evidence/v2' || evidence.result !== 'passed') {
      out.push(violation(
        entry.file,
        'SOTER_MIGRATION_EVIDENCE',
        'migration evidence is not a passed evidence/v2 record: ' + evidencePath,
        'failed, stale, unknown, skipped, or legacy evidence cannot establish a current bridge',
        'supply an exact current passed evidence/v2 record'
      ));
      continue;
    }
    if (['migrated', 'retired'].includes(item.state) && evidence.claimFamily !== 'migration') {
      out.push(violation(
        entry.file,
        'SOTER_MIGRATION_EVIDENCE',
        item.state + ' requires migration-family evidence: ' + evidencePath,
        'behavior evidence can establish a bridge but cannot prove an authority switch or safe retirement',
        'attach explicit migration evidence for parity, dependency removal, and rollback'
      ));
      continue;
    }
    const sourceArtifacts = evidence.artifacts?.filter((artifact) => {
      return ['source-case', 'migration-source'].includes(artifact.role)
        && artifact.path === item.sourcePath;
    }) || [];
    const exactSource = sourceArtifacts.length === 1
      && sourceArtifacts[0].fingerprint === item.sourceFingerprint;
    if (targetDoc.$contract === 'soter://contracts/scenario/v1') {
      const exactSourceDeclaration = targetDoc.sourceCases?.includes(item.sourcePath);
      if (['migrated', 'retired'].includes(item.state)) {
        const migrationTargets = evidence.artifacts?.filter((artifact) => {
          return artifact.role === 'migration-target' && artifact.path === item.targetPath;
        }) || [];
        const exactMigrationTarget = migrationTargets.length === 1
          && migrationTargets[0].fingerprint === targetFingerprint;
        if (!exactSourceDeclaration || !exactSource || !exactMigrationTarget) {
          out.push(violation(
            entry.file,
            'SOTER_MIGRATION_EVIDENCE',
            'scenario completion evidence does not bind the exact source and target: ' + item.sourcePath,
            'an authority switch requires migration-family evidence over the exact tombstoned case and exact current scenario',
            'fingerprint the migration-source and migration-target in explicit completion evidence'
          ));
        }
      } else {
        const level = VERIFICATION_LEVELS.indexOf(evidence.evaluator?.level);
        const targetArtifacts = evidence.artifacts?.filter((artifact) => {
          return artifact.role === 'scenario' && artifact.path === item.targetPath;
        }) || [];
        const exactArtifact = targetArtifacts.length === 1
          && targetArtifacts[0].id === targetDoc.id
          && targetArtifacts[0].fingerprint === targetFingerprint;
        if (!exactSourceDeclaration || !exactSource
          || level < VERIFICATION_LEVELS.indexOf('fixture') || !exactArtifact) {
          out.push(violation(
            entry.file,
            'SOTER_MIGRATION_EVIDENCE',
            'scenario bridge evidence does not bind the exact source and target: ' + item.sourcePath,
            'a passing result for other source bytes, another scenario version, or a lower verification level is not this bridge',
            'fingerprint the current source case and exact target scenario in fixture-or-higher execution evidence'
          ));
        }
      }
      continue;
    }
    const targetArtifacts = evidence.artifacts?.filter((artifact) => {
      return artifact.role === 'migration-target' && artifact.path === item.targetPath;
    }) || [];
    const exactTarget = evidence.claimFamily === 'migration'
      && targetArtifacts.length === 1
      && targetArtifacts[0].fingerprint === targetFingerprint;
    if (!exactSource || !exactTarget) {
      out.push(violation(
        entry.file,
        'SOTER_MIGRATION_EVIDENCE',
        'non-scenario migration evidence does not fingerprint the exact source and target: ' + item.targetPath,
        'a generic passing result cannot establish which legacy bytes moved or were intentionally replaced',
        'attach migration-family evidence with exact source-case and migration-target artifacts'
      ));
    }
  }
}

function checkMigrationInventoryBinding(entry, item, legacyInventory, out) {
  if (!['bridged', 'migrated', 'retired'].includes(item.state)) return;
  const matches = legacyInventory?.doc.items.filter((candidate) => {
    return candidate.sourcePath === item.sourcePath;
  }) || [];
  if (matches.length !== 1) {
    out.push(violation(
      entry.file,
      'SOTER_MIGRATION_INVENTORY',
      'promoted migration item has no unique legacy inventory entry: ' + item.sourcePath,
      'slice-specific migration state cannot diverge from the complete source inventory',
      'classify the exact source once in legacy-inventory.json and reconcile this migration item'
    ));
    return;
  }
  const inventoryItem = matches[0];
  const targetBindings = inventoryItem.targets?.filter((candidate) => {
    return candidate.id === item.targetPack && candidate.path === item.targetPath;
  }) || [];
  if (targetBindings.length !== 1) {
    out.push(violation(
      entry.file,
      'SOTER_MIGRATION_INVENTORY',
      'migration target has no unique legacy inventory binding for ' + item.sourcePath
        + ' -> ' + item.targetPath,
      'a multi-target source needs one independently stateful inventory binding per exact target',
      'add or reconcile the exact target binding in legacy-inventory.json'
    ));
    return;
  }
  const targetBinding = targetBindings[0];
  const migrationBinding = {
    state: item.state,
    sourceFingerprint: item.sourceFingerprint,
    targetId: item.targetPack,
    targetPath: item.targetPath,
    evidence: item.evidence || []
  };
  const inventoryBinding = {
    state: targetBinding.state,
    sourceFingerprint: inventoryItem.sourceFingerprint,
    targetId: targetBinding.id,
    targetPath: targetBinding.path,
    evidence: targetBinding.evidence
  };
  if (!deepEqual(migrationBinding, inventoryBinding)) {
    out.push(violation(
      entry.file,
      'SOTER_MIGRATION_INVENTORY',
      'migration manifest and legacy inventory disagree for ' + item.sourcePath,
      'two state records cannot independently choose source bytes, target ownership, or proof',
      'make the migration item and complete inventory carry the same exact binding'
    ));
  }
}

function checkMigration(root, entry, packs, configurations, legacyInventory, validateEvidenceContent, out) {
  if (!packs.has(entry.doc.slice)) {
    out.push(violation(
      entry.file,
      'SOTER_MIGRATION',
      'migration slice is not a declared pack',
      'every migration needs one inspectable owning system even when the migrated responsibility belongs to Kernel, Core, Context, Integration, or a host',
      'set slice to the declared pack that owns the migration boundary'
    ));
  }
  for (const item of entry.doc.items) {
    const source = resolveRegularRepositoryFile(root, item.sourcePath);
    const target = resolveRegularRepositoryFile(root, item.targetPath);
    const pack = packs.get(item.targetPack);
    const configuration = configurations.find((candidate) => {
      const candidatePath = path.relative(root, candidate.file).split(path.sep).join('/');
      return item.targetPack === 'configuration.' + candidate.doc.name
        && item.targetPath === candidatePath;
    });
    const inventorySource = legacyInventory?.doc.items.find((candidate) => {
      return candidate.sourcePath === item.sourcePath;
    });
    const governedRemoval = inventorySource?.sourcePresence === 'removed'
      && ['migrated', 'retired'].includes(inventorySource.state)
      && ['migrated', 'retired'].includes(item.state);
    const exactSourcePresent = source
      && fingerprintFile(source) === item.sourceFingerprint;
    if (!source && !governedRemoval) {
      out.push(violation(
        entry.file,
        'SOTER_MIGRATION_PATH',
        'migration source is missing, path-escaping, symlinked, or not regular: ' + item.sourcePath,
        'an unavailable or ambiguous source makes migration status unverifiable',
        'restore one repository-confined regular source file or complete an evidenced migration or retirement tombstone'
      ));
    }
    if (exactSourcePresent && inventorySource?.sourcePresence === 'removed') {
      out.push(violation(
        entry.file,
        'SOTER_MIGRATION_SOURCE',
        'legacy inventory declares a removed source that is still present: ' + item.sourcePath,
        'a tombstone and live fallback cannot both describe the current source tree',
        'restore sourcePresence=present or remove the fully migrated or retired source'
      ));
    }
    if (!target) {
      out.push(violation(
        entry.file,
        'SOTER_MIGRATION_PATH',
        'migration target is missing, path-escaping, symlinked, or not regular: ' + item.targetPath,
        'mapped and promoted states require one inspectable governed target',
        'restore one repository-confined regular target or return the item to current state'
      ));
    }
    if (source && inventorySource?.sourcePresence !== 'removed'
      && ['bridged', 'migrated', 'retired'].includes(item.state)
      && !exactSourcePresent) {
      out.push(violation(
        entry.file,
        'SOTER_MIGRATION_SOURCE',
        'migration source fingerprint is stale for ' + item.sourcePath,
        'evidence for earlier legacy bytes cannot establish a bridge for changed behavior',
        'demote the item, review the changed source, rerun its exact evidence, and record the new fingerprint'
      ));
    }
    if (!pack && !configuration) {
      out.push(violation(
        entry.file,
        'SOTER_MIGRATION',
        'migration target owner does not exist: ' + item.targetPack,
        'every target artifact needs one pack or exact named configuration owner',
        'add the owner or correct targetPack'
      ));
    } else if (pack) {
      const packPath = path.relative(root, pack.file);
      const ownedPaths = new Set([packPath, ...pack.doc.artifacts.map((artifact) => artifact.path)]);
      if (!ownedPaths.has(item.targetPath)) {
        out.push(violation(
          entry.file,
          'SOTER_MIGRATION',
          item.targetPath + ' is not owned by ' + item.targetPack,
          'migration cannot land an artifact outside its declared pack boundary',
          'list the artifact on the pack or correct targetPack'
        ));
      }
    }
    checkMigrationInventoryBinding(entry, item, legacyInventory, out);
    checkMigrationEvidence(root, entry, item, target, validateEvidenceContent, out);
  }
}

export function validateJsonSchema(value, schema) {
  return schemaErrors(value, schema);
}

export function verifyConfigurationCandidate(root = defaultRoot, { configPath, configuration } = {}) {
  const resolvedRoot = path.resolve(root);
  const configurationsRoot = path.join(resolvedRoot, 'soter', 'configurations');
  const candidatePath = path.resolve(configPath || '');
  const relative = path.relative(configurationsRoot, candidatePath);
  if (!configPath
    || relative.startsWith('..' + path.sep)
    || path.isAbsolute(relative)
    || !candidatePath.endsWith('.config.json')
    || !fs.existsSync(candidatePath)) {
    throw new TypeError('Configuration candidate must replace one existing soter/configurations/*.config.json file.');
  }
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new TypeError('Configuration candidate must be an object.');
  }
  return verifySoterInternal(resolvedRoot, {
    includeRuntimeArtifacts: false,
    configurationOverrides: [{ path: candidatePath, document: configuration }]
  });
}

export function verifySoter(root = defaultRoot, options = {}) {
  return verifySoterInternal(root, {
    includeRuntimeArtifacts: options.includeRuntimeArtifacts
  });
}

function verifySoterInternal(root = defaultRoot, options = {}) {
  const resolvedRoot = path.resolve(root);
  const out = [];
  const census = {
    contracts: 0,
    packs: 0,
    capabilities: 0,
    hosts: 0,
    configurations: 0,
    scenarios: 0,
    workflowDefinitions: 0,
    workflowEvaluationSets: 0,
    workflowGuides: 0,
    migrations: 0,
    locks: 0,
    runEnvelopes: 0,
    evidence: 0,
    doctorResults: 0,
    providers: 0,
    packSettings: 0,
    contextModels: 0,
    providerMappings: 0,
    contextSnapshots: 0,
    automationDecisions: 0,
    providerFixtures: 0,
    providerProbes: 0,
    hostToolCalls: 0,
    approvals: 0,
    changeSets: 0
  };
  const soterRoot = path.join(resolvedRoot, 'soter');
  if (!fs.existsSync(soterRoot)) {
    out.push(violation(
      soterRoot,
      'SOTER_EMPTY',
      'target implementation directory does not exist',
      'silence is not evidence that the target architecture is valid',
      'create the versioned target contracts or point --root at a Soter repository'
    ));
    return result(resolvedRoot, census, out, null);
  }
  const configurationPortability = inspectTrackedConfigurationTemplates(resolvedRoot);
  for (const item of configurationPortability.violations) {
    out.push(violation(
      path.join(resolvedRoot, item.file),
      item.code,
      `${item.pointer || '/'}: ${item.message}`,
      'checked-in configuration templates are portable selection examples, not private provider authority or runtime state',
      'replace the value with a reserved deterministic fixture identity or move it to the private .soter/state configuration override'
    ));
  }
  const collected = collectDocuments(resolvedRoot, out, census, options);
  const graph = checkPackGraph(resolvedRoot, collected.documents, out, census, options);
  checkContractSchemaOwnership(resolvedRoot, collected.schemas, graph.packs, out);
  if (!census.contracts || !census.packs || !census.configurations) {
    out.push(violation(
      soterRoot,
      'SOTER_EMPTY',
      'scan found no usable contracts, packs, or desired configurations',
      'a vacuous scan cannot establish architecture validity',
      'add the missing target foundation artifacts'
    ));
  }
  return result(resolvedRoot, census, out, graph);
}

function result(root, census, violations, graph) {
  const errors = violations.filter((item) => item.level !== 'warn').length;
  const resolvedConfigurations = [];
  for (const config of graph?.configs || []) {
    const selectionMetadata = new Map(config.doc.packs.map((selection) => [selection.id, selection]));
    const ids = [config.doc.base.kernel, config.doc.base.core, ...selectionMetadata.keys()];
    const authorities = new Map(config.doc.authorities.map((authority) => [authority.id, authority]));
    const hostAdapter = graph.hosts.get(config.doc.host.adapter)?.doc;
    resolvedConfigurations.push({
      name: config.doc.name,
      status: 'declared-static',
      host: {
        ...config.doc.host,
        releaseStage: hostAdapter?.releaseStage || null,
        evidenceMaturity: hostAdapter?.evidenceMaturity || null,
        mechanisms: hostAdapter?.mechanisms || null,
        limitations: hostAdapter?.limitations || []
      },
      selections: ids.map((id) => {
        const pack = graph.packs.get(id)?.doc;
        const selected = selectionMetadata.get(id);
        return {
          id,
          version: pack?.version || null,
          layer: pack?.layer || null,
          releaseStage: pack?.releaseStage || null,
          evidenceMaturity: pack?.evidenceMaturity || null,
          source: selected?.source || 'base',
          reason: selected?.reason || ('Required ' + (pack?.layer || 'base') + ' foundation: ' + (pack?.summary || id))
        };
      }),
      dependencies: ids.flatMap((id) => {
        const pack = graph.packs.get(id)?.doc;
        return (pack?.dependencies || []).map((dependency) => ({
          from: id,
          to: dependency.pack,
          version: dependency.version,
          optional: dependency.optional,
          reason: dependency.reason
        }));
      }),
      bindings: config.doc.bindings.map((binding) => ({
        capability: binding.capability,
        capabilityVersion: graph.capabilities.get(binding.capability)?.doc.version || null,
        effects: graph.capabilities.get(binding.capability)?.doc.effects || [],
        providerPack: binding.providerPack,
        providerVersion: graph.packs.get(binding.providerPack)?.doc.version || null,
        authorities: [...binding.authorities],
        authorityRoles: binding.authorities.map((authority) => ({
          id: authority,
          role: authorities.get(authority)?.role || null
        })),
        secretRef: binding.secretRef || null,
        reason: binding.reason
      })),
      sources: (config.doc.sources || []).map((source) => ({
        ...source,
        capabilityVersion: graph.capabilities.get(source.capability)?.doc.version || null,
        inputFingerprint: source.input && typeof source.input === 'object'
          ? fingerprintJson(source.input)
          : null
      })),
      authorities: config.doc.authorities,
      effectPolicies: config.doc.effectPolicies
    });
  }
  return {
    contractVersion: CONTRACT_VERSION,
    root,
    census,
    health: {
      valid: errors === 0 ? 'passed' : 'failed',
      ready: errors === 0 ? 'unknown' : 'failed',
      verified: 'unknown',
      healthy: 'unknown'
    },
    resolvedConfigurations,
    violations
  };
}

function report(resultValue, json) {
  if (json) {
    console.log(JSON.stringify(resultValue, null, 2));
    return;
  }
  for (const item of resultValue.violations) {
    const tag = item.level === 'warn' ? 'WARN' : 'FAIL';
    console.log('[' + tag + '] ' + item.file);
    console.log('  what: ' + item.what + ' (' + item.code + ')');
    console.log('  why:  ' + item.why);
    console.log('  fix:  ' + item.fix);
  }
  const errors = resultValue.violations.filter((item) => item.level !== 'warn').length;
  const warnings = resultValue.violations.length - errors;
  const c = resultValue.census;
  console.log(
    'Scanned target: ' + c.contracts + ' contracts, ' + c.packs + ' packs, '
      + c.capabilities + ' capabilities, ' + c.hosts + ' hosts, '
      + c.configurations + ' configurations, '
      + c.scenarios + ' scenarios, '
      + c.workflowDefinitions + ' workflow definitions, '
      + c.workflowEvaluationSets + ' workflow evaluation sets, '
      + c.workflowGuides + ' workflow guides, '
      + c.migrations + ' migrations, '
      + c.locks + ' locks, ' + c.runEnvelopes + ' run envelopes, '
      + c.evidence + ' evidence records, ' + c.doctorResults + ' doctor results, '
      + c.providers + ' providers, ' + c.contextSnapshots + ' context snapshots, '
      + c.automationDecisions + ' automation decisions, '
      + c.packSettings + ' pack settings definitions, '
      + c.contextModels + ' context record models, '
      + c.providerMappings + ' provider mappings, '
      + c.providerFixtures + ' provider fixtures, ' + c.providerProbes + ' provider probes, '
      + c.hostToolCalls + ' host tool calls, '
      + c.approvals + ' approvals, '
      + c.changeSets + ' change sets.'
  );
  console.log(
    'Health: valid=' + String(resultValue.health.valid)
      + ', ready=' + String(resultValue.health.ready)
      + ', verified=' + String(resultValue.health.verified)
      + ', healthy=' + resultValue.health.healthy + '.'
  );
  console.log('Soter verifier: ' + errors + ' error(s), ' + warnings + ' warning(s).');
}

function copyMigrationSources(sourceRoot, targetRoot) {
  const migrationDir = path.join(sourceRoot, 'soter', 'migrations');
  for (const file of walkFiles(migrationDir, (candidate) => candidate.endsWith('.json'))) {
    const migration = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const item of migration.items || []) {
      const source = path.join(sourceRoot, item.sourcePath);
      const target = path.join(targetRoot, item.sourcePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(source) && fs.lstatSync(source).isFile()) {
        fs.copyFileSync(source, target);
      }
    }
  }
  const hostDir = path.join(sourceRoot, 'soter', 'hosts');
  for (const file of walkFiles(hostDir, (candidate) => candidate.endsWith('adapter.json'))) {
    const adapter = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const projection of adapter.projections || []) {
      const source = path.join(sourceRoot, projection.path);
      const target = path.join(targetRoot, projection.path);
      if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'selftest host projection\n');
      }
    }
  }
}

function copyExternalPackArtifacts(sourceRoot, targetRoot) {
  const packDir = path.join(sourceRoot, 'soter', 'packs');
  for (const file of walkFiles(packDir, (candidate) => candidate.endsWith('pack.json'))) {
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const artifact of pack.artifacts || []) {
      const source = path.resolve(sourceRoot, artifact.path);
      const relative = path.relative(sourceRoot, source);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
        || relative === 'soter' || relative.startsWith('soter' + path.sep)
        || !fs.existsSync(source)) {
        continue;
      }
      const target = path.resolve(targetRoot, artifact.path);
      const targetRelative = path.relative(targetRoot, target);
      if (targetRelative === '..' || targetRelative.startsWith('..' + path.sep)
        || path.isAbsolute(targetRelative)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.statSync(source).isDirectory()) {
        fs.cpSync(source, target, { recursive: true });
      } else {
        fs.copyFileSync(source, target);
      }
    }
  }
}

function installDefinitionOnlySelftestGraph(root) {
  const workflowId = 'automation.definition-only-selftest';
  const evaluationId = 'evaluation-set.definition-only-selftest';
  const workflowPath = 'soter/automations/definition-only-selftest/definition.json';
  const evaluationPath = 'soter/automations/definition-only-selftest/evaluations.json';
  const guidePath = 'soter/automations/definition-only-selftest/guide.json';
  const packPath = 'soter/packs/automation.definition-only-selftest/pack.json';
  const configPath = 'soter/configurations/definition-only-selftest.config.json';
  const skillPath = '.claude/skills/definition-only-selftest/SKILL.md';
  const casePaths = [
    '.claude/evals/definition-only-selftest/happy-path.md',
    '.claude/evals/definition-only-selftest/invariant-gate.md'
  ];
  const sourceFiles = new Map([
    [skillPath, '# Definition-only self-test source\n\nThis temporary source has no runtime authority.\n'],
    [casePaths[0], '# Happy path\n\nThe normalized definition remains inspectable and authority-free.\n'],
    [casePaths[1], '# Invariant gate\n\nNo runtime operation or external effect is authorized.\n']
  ]);
  for (const [relativePath, content] of sourceFiles) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const workflow = {
    $contract: 'soter://contracts/workflow-definition/v2',
    contractVersion: '2.0.0',
    id: workflowId,
    version: '0.1.0',
    title: 'Definition-only self-test workflow',
    summary: 'Preserves synthetic normalized intent only long enough to exercise definition-only Kernel invariants.',
    ownership: {
      layer: 'automation',
      domain: 'definition-only-selftest',
      legacyLayer: 'skill',
      responsibility: 'outcome-definition'
    },
    lifecycle: {
      state: 'definition-only',
      reasonCode: 'AUTOMATION_RUNTIME_NOT_IMPLEMENTED',
      authority: 'none',
      delivery: 'preview-only',
      developmentRequest: null,
      developmentResult: null,
      permittedNextAction: 'design-runtime-slice'
    },
    intent: {
      goal: 'Retain inspectable workflow intent without exposing runtime or effect authority.',
      useWhen: ['A temporary verifier specimen needs definition-only contract coverage.'],
      excludeWhen: ['Any runtime behavior or provider effect would be required.']
    },
    procedure: [
      {
        id: 'inspect-source',
        sequence: 1,
        outcome: 'Inspect the exact governed legacy source identity.',
        requirements: ['Require one exact fingerprinted source before normalization.'],
        stopConditions: ['Stop when the source identity cannot be verified.']
      },
      {
        id: 'hold-runtime',
        sequence: 2,
        outcome: 'Keep all runtime and effect authority unavailable.',
        requirements: ['Expose no operator, capability, authority, or executable scenario.'],
        stopConditions: ['Stop before any runtime operation or external effect.']
      }
    ],
    safeguards: ['Definition review must never become runtime or effect authority.'],
    evaluationSet: { id: evaluationId, path: evaluationPath },
    guide: { id: 'workflow-guide.definition-only-selftest', path: guidePath },
    potentialEffects: ['read'],
    source: {
      presence: 'present',
      legacyPath: skillPath,
      legacyFingerprint: fingerprintFile(path.join(root, skillPath))
    },
    privacy: {
      rawSourceIncluded: false,
      workspaceSpecificValuesIncluded: false,
      credentialsIncluded: false,
      privateInputsIncluded: false
    },
    limitations: ['This temporary specimen proves definition-only validation and no runtime behavior.']
  };
  const evaluations = {
    $contract: 'soter://contracts/workflow-evaluation-set/v2',
    contractVersion: '2.0.0',
    id: evaluationId,
    workflow: workflowId,
    version: '0.1.0',
    lifecycle: {
      state: 'definition-only',
      reasonCode: 'AUTOMATION_RUNTIME_NOT_IMPLEMENTED',
      authority: 'none',
      permittedNextAction: 'design-runtime-slice'
    },
    cases: casePaths.map((sourcePath, index) => ({
      id: index === 0 ? 'happy-path' : 'invariant-gate',
      sequence: index + 1,
      kind: index === 0 ? 'happy-path' : 'invariant',
      source: {
        presence: 'present',
        legacyPath: sourcePath,
        legacyFingerprint: fingerprintFile(path.join(root, sourcePath))
      },
      stimulus: {
        summary: 'A governed synthetic source is normalized without runtime authority.',
        conditions: ['The exact legacy source remains available for inspection.']
      },
      expectedObservations: ['The normalized definition remains inspectable and authority-free.'],
      prohibitedOutcomes: ['No runtime operation or external effect is authorized.']
    })),
    evaluationPolicy: {
      runner: 'none',
      requestContract: null,
      resultContract: null,
      freshWorkerPerCase: true,
      expectationsWithheld: true,
      baselineRequired: true,
      supportedHosts: [],
      authority: 'none'
    },
    privacy: {
      rawPromptsIncluded: false,
      workspaceSpecificValuesIncluded: false,
      privateInputsIncluded: false,
      rawTranscriptsIncluded: false,
      absolutePathsIncluded: false
    },
    limitations: ['These normalized cases are not executable behavior evidence.']
  };
  const guide = {
    $contract: 'soter://contracts/workflow-guide/v2',
    contractVersion: '2.0.0',
    id: 'workflow-guide.definition-only-selftest',
    workflow: {
      id: workflowId,
      version: workflow.version,
      definitionPath: workflowPath,
      definitionFingerprint: fingerprintJson(workflow),
      evaluationSetPath: evaluationPath,
      evaluationSetFingerprint: fingerprintJson(evaluations)
    },
    skill: {
      name: 'definition-only-selftest',
      description: 'Inspect one synthetic definition-only workflow without granting runtime, effect, or approval authority.',
      invocation: 'explicit-only',
      displayName: 'Definition-only self-test',
      shortDescription: 'Inspect a synthetic authority-free workflow guide.',
      defaultPrompt: 'Use $definition-only-selftest to inspect the synthetic workflow without performing any effect.'
    },
    status: {
      state: 'candidate',
      reasonCode: 'WORKFLOW_GUIDE_PARITY_NOT_EVALUATED',
      proceduralAuthority: 'legacy',
      behaviorParity: 'not-evaluated',
      delivery: 'preview-only',
      evidence: [],
      permittedNextAction: 'evaluate-host-projections'
    },
    authority: {
      kind: 'procedural-guidance',
      executionAuthority: 'none',
      effectAuthority: 'none',
      approvalAuthority: 'none',
      reasonCode: 'WORKFLOW_GUIDE_NO_EXECUTION_AUTHORITY',
      providerTransactionAuthority: 'none'
    },
    stepDetails: workflow.procedure.map((step) => ({
      id: step.id,
      sequence: step.sequence,
      instructions: [step.outcome],
      flexibility: [],
      stopConditions: [...step.stopConditions]
    })),
    verification: ['The synthetic workflow remains inspectable and grants no runtime or external effect authority.'],
    gotchas: [{
      id: 'definition-is-not-runtime',
      kind: 'constraint',
      summary: 'A valid workflow guide can still have no executable runtime or provider authority.',
      countermeasure: 'Keep the candidate preview-only until exact agent-or-higher migration evidence supports activation.'
    }],
    references: [],
    source: {
      presence: 'present',
      legacyPath: skillPath,
      legacyFingerprint: workflow.source.legacyFingerprint,
      normalization: 'behavior-preserving-with-explicit-authority-boundary'
    },
    privacy: {
      rawSourceIncluded: false,
      workspaceSpecificValuesIncluded: false,
      credentialsIncluded: false,
      privateInputsIncluded: false,
      providerResponsesIncluded: false
    },
    limitations: ['This temporary candidate proves guide validation only and grants no runtime behavior.']
  };
  guide.contentFingerprint = fingerprintWorkflowGuideContent(guide);
  const pack = {
    $contract: 'soter://contracts/pack/v1',
    contractVersion: '1.0.0',
    id: workflowId,
    version: '0.1.0',
    layer: 'automation',
    releaseStage: 'experimental',
    evidenceMaturity: 'declared',
    summary: 'Temporary definition-only workflow used by Kernel self-tests.',
    dependencies: [],
    capabilities: { requires: [], provides: [] },
    authorities: [],
    effects: [],
    artifacts: [
      { path: workflowPath, role: 'definition' },
      { path: guidePath, role: 'definition' },
      { path: evaluationPath, role: 'evaluation' }
    ],
    compatibility: { baseContract: '^1.0.0', hosts: ['codex', 'claude'] },
    verification: { maxLevel: 'static', scenarios: [] }
  };
  const config = {
    $contract: 'soter://contracts/configuration/v1',
    contractVersion: '1.0.0',
    name: 'definition-only-selftest',
    base: { kernel: 'kernel.soter', core: 'core.runtime' },
    packs: [{
      id: workflowId,
      source: 'user',
      reason: 'Select the temporary definition-only workflow for verifier coverage.'
    }],
    bindings: [],
    sources: [],
    authorities: [{
      id: 'authority.definition-only-selftest.evidence',
      role: 'evidence',
      subject: 'runtime.runs',
      uri: 'soter-state://runs',
      reason: 'Core retains its required evidence authority without exposing runtime behavior.'
    }],
    effectPolicies: Object.fromEntries(EFFECTS.map((effect) => [effect, {
      mode: 'prohibit',
      reason: 'Definition-only self-test configuration prohibits ' + effect + ' effects.'
    }])),
    secretRefs: [],
    host: {
      id: 'codex',
      adapter: 'host.codex',
      version: '0.3.1',
      reason: 'Keep the temporary definition inspectable through a declared host.'
    },
    settings: {}
  };
  for (const [relativePath, value] of [
    [workflowPath, workflow],
    [evaluationPath, evaluations],
    [guidePath, guide],
    [packPath, pack],
    [configPath, config]
  ]) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  }
  return {
    packFile: path.join(root, packPath),
    workflowFile: path.join(root, workflowPath),
    evaluationFile: path.join(root, evaluationPath),
    guideFile: path.join(root, guidePath)
  };
}

function installActiveWorkflowEvidenceSelftestFixture(root) {
  const workflowId = 'automation.active-evidence-selftest';
  const guidePath = 'soter/automations/active-evidence-selftest/guide.json';
  const definitionPath = 'soter/automations/active-evidence-selftest/definition.json';
  const evaluationPath = 'soter/automations/active-evidence-selftest/evaluations.json';
  const legacyPath = '.claude/skills/active-evidence-selftest/SKILL.md';
  const definition = {
    id: workflowId,
    version: '0.1.0',
    title: 'Active evidence self-test',
    summary: 'Exercise exact historical and final host evidence joins.',
    ownership: {
      layer: 'automation',
      domain: 'active-evidence-selftest',
      legacyLayer: 'skill',
      responsibility: 'outcome-definition'
    },
    lifecycle: {
      state: 'active-host-guided',
      activation: { state: 'active', evidence: [] },
      effectBoundary: {
        localWorkspaceRead: 'request-scoped',
        localWorkspaceWrite: 'request-scoped',
        localCommand: 'request-scoped',
        subagentDispatch: 'request-scoped',
        providerRead: 'separate-authority',
        providerWrite: 'separate-authority',
        publication: 'separate-authority',
        merge: 'separate-authority',
        protectedRootMutation: 'separate-authority',
        hostRealization: 'separate-authority',
        authority: 'development-request-only'
      }
    },
    intent: {
      goal: 'Exercise exact historical and final host evidence joins.',
      useWhen: ['Kernel active evidence joins require focused self-test coverage.'],
      excludeWhen: ['No active workflow evidence is under inspection.']
    },
    procedure: [{
      id: 'inspect-evidence',
      sequence: 1,
      outcome: 'Inspect exact host evidence.',
      requirements: ['Keep historical and final evidence distinct.'],
      stopConditions: ['Stop on any binding mismatch.']
    }],
    safeguards: ['Historical evidence grants no execution or activation authority.'],
    potentialEffects: ['read'],
    source: {
      presence: 'removed',
      legacyPath,
      legacyFingerprint: fingerprintJson({ legacyPath })
    }
  };
  const evaluations = {
    id: 'evaluation-set.active-evidence-selftest',
    workflow: workflowId,
    version: '0.1.0',
    cases: ['happy-path', 'pressure-path', 'invariant-path'].map((id, index) => ({
      id,
      sequence: index + 1,
      kind: index === 0 ? 'happy-path' : index === 1 ? 'pressure' : 'invariant',
      source: {
        presence: 'removed',
        legacyPath: `.claude/evals/active-evidence-selftest/${id}.md`,
        legacyFingerprint: fingerprintJson({ id })
      },
      stimulus: {
        summary: 'Inspect the exact evidence join for ' + id + '.',
        conditions: ['The test uses only sanitized deterministic facts.']
      },
      expectedObservations: ['The exact evidence join remains intact.'],
      prohibitedOutcomes: ['No authority is inferred from the receipt.']
    })),
    evaluationPolicy: {
      baselineCaseId: 'happy-path',
      baselineOutcome: 'observed-not-gating'
    }
  };
  const guide = {
    id: 'workflow-guide.active-evidence-selftest',
    contentFingerprint: fingerprintJson({ guide: 'active-evidence-selftest' }),
    skill: {
      name: 'active-evidence-selftest',
      description: 'Exercise exact historical and final host evidence joins.',
      invocation: 'explicit-only',
      displayName: 'Active evidence self-test',
      shortDescription: 'Inspect exact workflow evidence joins.',
      defaultPrompt: 'Inspect the exact active workflow evidence joins.'
    },
    status: { state: 'active', evidence: [] },
    authority: {
      kind: 'procedural-guidance',
      executionAuthority: 'none',
      effectAuthority: 'none',
      approvalAuthority: 'none',
      providerTransactionAuthority: 'none',
      reasonCode: 'WORKFLOW_GUIDE_NO_EXECUTION_AUTHORITY'
    },
    stepDetails: [{
      id: 'inspect-evidence',
      sequence: 1,
      instructions: ['Inspect the exact evidence joins.'],
      flexibility: [],
      stopConditions: ['Stop on any binding mismatch.']
    }],
    verification: ['Every host evidence join is exact.'],
    gotchas: [],
    references: [],
    source: {
      presence: 'removed',
      legacyPath,
      legacyFingerprint: definition.source.legacyFingerprint,
      normalization: 'behavior-preserving-with-explicit-authority-boundary'
    },
    privacy: {
      rawSourceIncluded: false,
      workspaceSpecificValuesIncluded: false,
      credentialsIncluded: false,
      privateInputsIncluded: false,
      providerResponsesIncluded: false
    },
    limitations: ['The fixture proves Kernel evidence joins only.']
  };
  const stableSubjectFingerprint = fingerprintWorkflowEvaluatedSubject({
    definition,
    guide,
    evaluations
  });
  const workflowSources = workflowLegacySourceProjection({ definition, guide, evaluations });
  const receipts = new Map();
  const receiptEntries = new Map();
  const references = new Map();
  const finalEntries = new Map();
  for (const host of ['codex', 'claude']) {
    const instructionFingerprint = fingerprintJson({ host, instructions: guide.id });
    const runs = workflowEvaluationRunPlan({ definition, evaluations })
      .map(({ criteria, ...planned }, index) => ({
        ...planned,
        startedAt: '2026-07-22T10:02:00.000Z',
        completedAt: '2026-07-22T10:03:00.000Z',
        worker: {
          id: `worker-run.${host}.${index + 1}`,
          workerFingerprint: fingerprintJson({ host, index, kind: 'worker' }),
          dispatchFingerprint: fingerprintJson({ host, index, kind: 'dispatch' }),
          transcriptFingerprint: fingerprintJson({ host, index, kind: 'transcript' }),
          expectationsIncluded: false,
          answerKeyAccess: 'not-observed',
          state: 'passed'
        },
        judgment: {
          id: `judgment.${host}.${index + 1}`,
          verdict: 'passed',
          criteria: criteria.map((criterion) => ({
            ...criterion,
            state: criterion.kind === 'expected' ? 'observed' : 'not-observed',
            evidenceFingerprint: fingerprintJson({
              host,
              run: planned.id,
              criterion: criterion.id
            })
          }))
        }
      }));
    const receipt = {
      $contract: 'soter://contracts/development-agent-migration-evidence/v1',
      evidenceFingerprint: fingerprintJson({ placeholder: host }),
      createdAt: '2026-07-22T11:01:00.000Z',
      sourceObservation: {
        observedAt: '2026-07-22T11:01:00.000Z'
      },
      request: {
        createdAt: '2026-07-22T10:00:00.000Z'
      },
      result: {
        createdAt: '2026-07-22T10:01:00.000Z',
        completedAt: '2026-07-22T11:00:00.000Z',
        state: 'passed'
      },
      applicability: {
        kind: 'historical-candidate-only',
        evaluatedSubjectFingerprint: stableSubjectFingerprint
      },
      workflow: { id: workflowId, version: definition.version },
      evaluatedSubject: {
        id: guide.id,
        version: definition.version,
        fingerprint: stableSubjectFingerprint,
        contentFingerprint: guide.contentFingerprint
      },
      evaluationSet: { id: evaluations.id, version: evaluations.version },
      host: { id: host, evaluatedInstructionFingerprint: instructionFingerprint },
      workspace: {
        pre: {
          rootIdentityFingerprint: fingerprintJson({ host, workspace: 'root' }),
          policyFingerprint: fingerprintJson({ host, workspace: 'policy' }),
          settingsFingerprint: fingerprintJson({ host, workspace: 'settings' })
        },
        post: {
          rootIdentityFingerprint: fingerprintJson({ host, workspace: 'root' }),
          policyFingerprint: fingerprintJson({ host, workspace: 'policy' }),
          settingsFingerprint: fingerprintJson({ host, workspace: 'settings' })
        }
      },
      runs,
      artifacts: [...workflowSources.map((source) => ({
        role: 'migration-source',
        subjectId: workflowId,
        path: source.path,
        fingerprint: source.fingerprint
      })), {
        role: 'migration-target',
        subjectId: guide.id,
        path: guidePath,
        fingerprint: stableSubjectFingerprint
      }],
      conclusion: {
        state: 'passed',
        behaviorParity: 'passed',
        baselineRole: 'observed-non-gating',
        guidedRunsPassed: true,
        prohibitedOutcomesObserved: false,
        externalEffectsObserved: false
      },
      authority: {
        kind: 'migration-evidence-only',
        grantsExecution: false,
        grantsApproval: false,
        grantsActivation: false,
        grantsMigration: false,
        grantsPublication: false,
        grantsMerge: false,
        grantsProviderRead: false,
        grantsProviderWrite: false,
        grantsHostRealization: false,
        grantsPromotion: false,
        grantsFallbackRemoval: false
      }
    };
    receipt.evidenceFingerprint = fingerprintWithoutField(receipt, 'evidenceFingerprint');
    const receiptPath = `soter/evidence/development/active-evidence-selftest.${host}.historical.json`;
    const receiptFile = path.join(root, receiptPath);
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    const receiptEntry = {
      file: receiptFile,
      contractId: receipt.$contract,
      doc: receipt
    };
    const reference = { host, path: receiptPath, fingerprint: fingerprintJson(receipt) };
    receipts.set(host, receipt);
    receiptEntries.set(host, receiptEntry);
    references.set(host, reference);
  }
  definition.lifecycle.activation.evidence = ['codex', 'claude'].map((host) => references.get(host));
  guide.status.evidence = structuredClone(definition.lifecycle.activation.evidence);
  for (const host of ['codex', 'claude']) {
    const receipt = receipts.get(host);
    const reference = references.get(host);
    const finalPath = `soter/evidence/development/active-evidence-selftest.${host}.final.json`;
    const finalEvidence = {
      $contract: 'soter://contracts/evidence/v2',
      claimFamily: 'migration',
      subject: { type: 'automation', id: workflowId, version: definition.version },
      host: { id: host },
      evaluator: { level: 'agent' },
      result: 'passed',
      artifacts: [...workflowSources.map((source) => ({
        role: 'migration-source',
        path: source.path,
        fingerprint: source.fingerprint
      })), {
        role: 'migration-target',
        path: guidePath,
        fingerprint: guide.contentFingerprint
      }, {
        role: 'migration-target',
        path: evaluationPath,
        fingerprint: fingerprintJson(evaluations)
      }, {
        role: 'development-agent-migration-evidence',
        path: reference.path,
        fingerprint: fingerprintJson(receipt)
      }, {
        role: 'workflow-evaluated-subject',
        subjectId: guide.id,
        fingerprint: stableSubjectFingerprint
      }, {
        role: 'workflow-evaluated-instructions',
        host,
        subjectId: guide.id,
        fingerprint: receipt.host.evaluatedInstructionFingerprint
      }, {
        role: 'workflow-definition',
        path: definitionPath,
        fingerprint: fingerprintJson(definition)
      }, {
        role: 'workflow-evaluation-set',
        path: evaluationPath,
        fingerprint: fingerprintJson(evaluations)
      }]
    };
    const finalFile = path.join(root, finalPath);
    fs.writeFileSync(finalFile, JSON.stringify(finalEvidence));
    finalEntries.set(host, {
      file: finalFile,
      contractId: finalEvidence.$contract,
      doc: finalEvidence
    });
  }
  return {
    root,
    definitionEntry: { file: path.join(root, definitionPath), doc: definition },
    guideEntry: { file: path.join(root, guidePath), doc: guide },
    evaluationEntry: { file: path.join(root, evaluationPath), doc: evaluations },
    guidePath,
    receipts,
    receiptEntries,
    references,
    finalEntries,
    documentsByPath: new Map([...receiptEntries.values()].map((entry) => [path.resolve(entry.file), entry])),
    evidence: new Map([...finalEntries].map(([host, entry]) => ['evidence.' + host, entry])),
    requireFinalEvidence: true
  };
}

function refreshActiveWorkflowEvidenceSelftestFixture(fixture, host) {
  const receipt = fixture.receipts.get(host);
  const receiptEntry = fixture.receiptEntries.get(host);
  const reference = fixture.references.get(host);
  receipt.evidenceFingerprint = fingerprintWithoutField(receipt, 'evidenceFingerprint');
  reference.fingerprint = fingerprintJson(receipt);
  receiptEntry.doc = receipt;
  fs.writeFileSync(receiptEntry.file, JSON.stringify(receipt));
  fixture.definitionEntry.doc.lifecycle.activation.evidence = ['codex', 'claude']
    .map((item) => fixture.references.get(item));
  fixture.guideEntry.doc.status.evidence = structuredClone(
    fixture.definitionEntry.doc.lifecycle.activation.evidence
  );
  const finalEntry = fixture.finalEntries.get(host);
  const receiptArtifact = finalEntry.doc.artifacts.find((artifact) => {
    return artifact.role === 'development-agent-migration-evidence';
  });
  receiptArtifact.path = reference.path;
  receiptArtifact.fingerprint = reference.fingerprint;
  for (const entry of fixture.finalEntries.values()) {
    entry.doc.artifacts.find((artifact) => artifact.role === 'workflow-definition').fingerprint
      = fingerprintJson(fixture.definitionEntry.doc);
  }
}

function plantActiveWorkflowBaselineFinding(receipt) {
  const baseline = receipt.runs.find((run) => run.arm === 'baseline');
  baseline.worker.state = 'failed';
  baseline.judgment.verdict = 'blocked';
  baseline.judgment.criteria.find((criterion) => {
    return criterion.kind === 'expected';
  }).state = 'unknown';
  baseline.judgment.criteria.find((criterion) => {
    return criterion.kind === 'prohibited';
  }).state = 'observed';
}

function installRetiredWorkflowEvidenceSelftestFixture(root) {
  const fixture = installActiveWorkflowEvidenceSelftestFixture(root);
  const definition = fixture.definitionEntry.doc;
  const guide = fixture.guideEntry.doc;
  const evaluations = fixture.evaluationEntry.doc;
  const evaluationPath = path.relative(root, fixture.evaluationEntry.file).split(path.sep).join('/');
  const retirementPath = 'soter/fixtures/harness-development-catalog/'
    + 'active-evidence-selftest.intentional-retirement.evidence.json';
  const retirementReference = { path: retirementPath };
  definition.lifecycle = {
    state: 'retired',
    retirement: {
      state: 'complete',
      evidence: [retirementReference]
    }
  };
  guide.workflow = {
    id: definition.id,
    version: definition.version,
    definitionPath: path.relative(root, fixture.definitionEntry.file).split(path.sep).join('/'),
    definitionFingerprint: fingerprintJson(definition),
    evaluationSetPath: evaluationPath,
    evaluationSetFingerprint: fingerprintJson(evaluations)
  };
  guide.status = {
    state: 'retired',
    evidence: [retirementReference]
  };
  const sources = workflowLegacySourceProjection({ definition, guide, evaluations });
  const inventory = {
    items: sources.map((source) => ({
      sourcePath: source.path,
      sourceFingerprint: source.fingerprint,
      sourcePresence: 'removed',
      state: 'retired',
      targets: [{
        id: definition.id,
        path: source.kind === 'workflow-guide' ? fixture.guidePath : evaluationPath,
        state: 'retired',
        canonicalAuthority: 'none',
        fallback: 'removed',
        parity: 'intentional-change',
        evidence: [retirementPath]
      }]
    }))
  };
  const lock = {
    configuration: { name: 'harness-development-catalog' },
    graphFingerprint: fingerprintJson({ graph: 'retirement-selftest' })
  };
  const evidence = {
    $contract: 'soter://contracts/evidence/v2',
    claimFamily: 'migration',
    subject: { type: 'pack', id: definition.id, version: definition.version },
    configurationLockFingerprint: fingerprintJson(lock),
    graphFingerprint: lock.graphFingerprint,
    evaluator: { id: 'kernel.legacy-migration-completion', level: 'fixture' },
    environment: { containment: 'fixture' },
    result: 'passed',
    artifacts: [...sources.map((source) => ({
      role: 'migration-source',
      path: source.path,
      fingerprint: source.fingerprint
    })), {
      role: 'migration-target',
      path: fixture.guidePath,
      fingerprint: guide.contentFingerprint
    }, {
      role: 'migration-target',
      path: evaluationPath,
      fingerprint: fingerprintJson(evaluations)
    }],
    outcomes: [{ id: 'migration-disposition', state: 'retired' }, {
      id: 'migration-parity', state: 'intentional-change'
    }, {
      id: 'runtime-authority-absent', state: 'passed'
    }],
    effects: [],
    failures: []
  };
  const evidenceFile = path.join(root, retirementPath);
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence));
  return {
    root,
    id: definition.id,
    definitionEntry: fixture.definitionEntry,
    guideEntry: fixture.guideEntry,
    evaluationEntry: fixture.evaluationEntry,
    guidePath: fixture.guidePath,
    legacyInventories: [{ doc: inventory }],
    documentsByPath: new Map([[path.resolve(evidenceFile), {
      file: evidenceFile,
      contractId: evidence.$contract,
      doc: evidence
    }]]),
    locks: [{ doc: lock }],
    requireFinalEvidence: true,
    evidence,
    evidenceFile,
    retirementPath
  };
}

function selftest(root) {
  const failures = [];
  const recordCapabilityCases = [
    ['crm.records.read', 'crm', 'crm.records', 'read'],
    ['documents.records.create', 'documents', 'documents.records', 'create'],
    ['product-feature.records.update', 'product-feature', 'product-feature.records', 'update'],
    ['product.schema.read', 'product', 'product.records', 'schema-read']
  ];
  for (const [id, namespace, subject, operation] of recordCapabilityCases) {
    const parsed = parseRecordCapability(id);
    if (parsed?.namespace !== namespace
      || parsed?.subject !== subject
      || parsed?.operation !== operation) {
      failures.push('record capability parser did not preserve ' + id);
    }
  }
  if (['crm.records.delete', 'crm.record.read', 'CRM.records.read', 'records.read']
    .some((id) => parseRecordCapability(id) !== null)) {
    failures.push('record capability parser accepted an unsupported or non-canonical capability');
  }
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'items'],
    properties: {
      mode: { enum: ['safe'] },
      items: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        uniqueItems: true,
        items: { type: 'string' }
      }
    }
  };
  const plantedSchemaErrors = schemaErrors({ mode: 'unsafe', items: ['x', 'x'], extra: true }, schema);
  if (plantedSchemaErrors.length < 3) {
    failures.push('schema validator missed enum, uniqueness, minimum, or additional-property failures');
  }
  if (!schemaErrors({ mode: 'safe', items: ['x', 'y', 'z'] }, schema)
    .some((item) => item.message.includes('at most 2'))) {
    failures.push('schema validator missed maximum-item failure');
  }
  const tupleSchema = {
    type: 'array',
    minItems: 2,
    maxItems: 2,
    prefixItems: [{ const: 'head' }],
    items: { const: 'tail' }
  };
  if (schemaErrors(['head', 'tail'], tupleSchema).length
    || !schemaErrors(['tail', 'tail'], tupleSchema).length
    || !schemaErrors(['head', 'wrong'], tupleSchema).length) {
    failures.push('schema validator did not apply prefixItems before the remaining items schema');
  }
  const enforcementSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'host', 'payload'],
    properties: {
      kind: { enum: ['host', 'fixture'] },
      host: { type: ['string', 'null'] },
      payload: { type: 'object', minProperties: 1 },
      title: { type: 'string', maxLength: 4 },
      objects: { type: 'array', uniqueItems: true, items: { type: 'object' } }
    },
    allOf: [{
      if: { properties: { kind: { const: 'host' } } },
      then: { properties: { host: { type: 'string' } } },
      else: { properties: { host: { type: 'null' } } }
    }]
  };
  const plantedEnforcementErrors = schemaErrors({
    kind: 'host',
    host: null,
    payload: {},
    title: 'too-long',
    objects: [{ left: 1, right: 2 }, { right: 2, left: 1 }]
  }, enforcementSchema);
  if (!plantedEnforcementErrors.some((item) => item.message.includes('type string'))
    || !plantedEnforcementErrors.some((item) => item.message.includes('at least 1 properties'))
    || !plantedEnforcementErrors.some((item) => item.message.includes('at most 4 characters'))
    || !plantedEnforcementErrors.some((item) => item.message.includes('duplicate items'))) {
    failures.push('schema validator missed conditional, property-count, length, or deep-uniqueness failures');
  }
  const referencedSchema = {
    $defs: { shortText: { type: 'string' } },
    $ref: '#/$defs/shortText',
    maxLength: 3
  };
  if (!schemaErrors('four', referencedSchema)
    .some((item) => item.message.includes('at most 3 characters'))) {
    failures.push('schema validator ignored a JSON Schema 2020-12 sibling next to $ref');
  }
  const badDefinitions = schemaDefinitionErrors({
    type: 'string',
    minLength: '1',
    unimplementedConstraint: true
  });
  if (!badDefinitions.some((item) => item.message.includes('not supported'))
    || !badDefinitions.some((item) => item.message.includes('non-negative integer'))) {
    failures.push('schema definition audit accepted an unenforced keyword');
  }
  if (schemaErrors({ right: 2, left: 1 }, { const: { left: 1, right: 2 } }).length) {
    failures.push('schema validator treated JSON object property order as semantic');
  }
  const privateSummarySchema = {
    oneOf: [
      {
        type: 'object', additionalProperties: false, required: ['exposure', 'value'],
        properties: { exposure: { const: 'identifier' }, value: { type: 'string' } }
      },
      {
        allOf: [{ type: 'object', required: ['exposure'] }],
        type: 'object', additionalProperties: false, required: ['exposure'],
        properties: { exposure: { const: 'private' } }
      }
    ]
  };
  if (schemaErrors({ exposure: 'private' }, privateSummarySchema).length
    || !schemaErrors({ exposure: 'private', value: 'forbidden' }, privateSummarySchema).length) {
    failures.push('schema validator did not enforce composed discriminated privacy branches');
  }
  if (!satisfies('0.1.5', '^0.1.0') || satisfies('0.2.0', '^0.1.0') || !satisfies('1.9.0', '^1.2.0')) {
    failures.push('semantic version range checks are incorrect');
  }
  const retirementEvidencePath = 'soter/fixtures/harness-development-catalog/'
    + 'selftest.intentional-retirement.evidence.json';
  for (const schemaPath of [
    'soter/contracts/workflow-definition.schema.json',
    'soter/contracts/workflow-guide.schema.json'
  ]) {
    const workflowSchema = JSON.parse(fs.readFileSync(path.join(root, schemaPath), 'utf8'));
    const referenceSchema = workflowSchema.$defs.retirementEvidenceReference;
    if (schemaErrors({ path: retirementEvidencePath }, referenceSchema, workflowSchema).length) {
      failures.push(schemaPath + ' rejected one path-only retirement evidence reference');
    }
    if (!schemaErrors({
      path: retirementEvidencePath,
      host: 'codex',
      fingerprint: fingerprintJson({ retirement: 'selftest' })
    }, referenceSchema, workflowSchema).length) {
      failures.push(schemaPath + ' accepted host/fingerprint fields on retirement evidence');
    }
  }

  const activeEvidenceTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-active-evidence-'));
  try {
    const validFixture = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'valid')
    );
    const validInspection = inspectActiveWorkflowEvidence(validFixture);
    if (validInspection.findings.length) {
      failures.push('valid active workflow evidence fixture failed: '
        + validInspection.findings.map((item) => item.code).join(', '));
    }

    const baselineFindingFixture = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'baseline-finding')
    );
    const baselineFindingReceipt = baselineFindingFixture.receipts.get('codex');
    plantActiveWorkflowBaselineFinding(baselineFindingReceipt);
    baselineFindingReceipt.conclusion.prohibitedOutcomesObserved = true;
    refreshActiveWorkflowEvidenceSelftestFixture(baselineFindingFixture, 'codex');
    const baselineFindingInspection = inspectActiveWorkflowEvidence(baselineFindingFixture);
    if (baselineFindingInspection.findings.length) {
      failures.push('active workflow evidence rejected a truthful non-gating baseline finding');
    }

    const falseBaselineConclusion = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'false-baseline-conclusion')
    );
    const falseBaselineReceipt = falseBaselineConclusion.receipts.get('codex');
    plantActiveWorkflowBaselineFinding(falseBaselineReceipt);
    refreshActiveWorkflowEvidenceSelftestFixture(falseBaselineConclusion, 'codex');
    const falseBaselineInspection = inspectActiveWorkflowEvidence(falseBaselineConclusion);
    if (!falseBaselineInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_EVIDENCE';
    })) {
      failures.push('active workflow evidence accepted a false all-arm prohibited-outcome conclusion');
    }

    const guidedFindingFixture = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'guided-finding')
    );
    const guidedFindingReceipt = guidedFindingFixture.receipts.get('codex');
    guidedFindingReceipt.runs.find((run) => run.arm === 'guided').worker.state = 'failed';
    refreshActiveWorkflowEvidenceSelftestFixture(guidedFindingFixture, 'codex');
    const guidedFindingInspection = inspectActiveWorkflowEvidence(guidedFindingFixture);
    if (!guidedFindingInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_EVIDENCE'
        || item.code === 'SOTER_WORKFLOW_GUIDE_EVIDENCE_COVERAGE';
    })) {
      failures.push('active workflow evidence accepted a failed guided worker');
    }

    const substitutedStimulusFixture = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'substituted-stimulus')
    );
    substitutedStimulusFixture.receipts.get('codex').runs
      .find((run) => run.arm === 'guided').stimulusFingerprint
      = fingerprintJson({ stimulus: 'substituted' });
    refreshActiveWorkflowEvidenceSelftestFixture(substitutedStimulusFixture, 'codex');
    const substitutedStimulusInspection = inspectActiveWorkflowEvidence(
      substitutedStimulusFixture
    );
    if (!substitutedStimulusInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_EVIDENCE_COVERAGE';
    })) {
      failures.push('active workflow evidence accepted a substituted stimulus fingerprint');
    }

    const substitutedCriterionFixture = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'substituted-criterion')
    );
    substitutedCriterionFixture.receipts.get('codex').runs
      .find((run) => run.arm === 'guided').judgment.criteria[0].id
      = 'substituted.expected.1';
    refreshActiveWorkflowEvidenceSelftestFixture(substitutedCriterionFixture, 'codex');
    const substitutedCriterionInspection = inspectActiveWorkflowEvidence(
      substitutedCriterionFixture
    );
    if (!substitutedCriterionInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_EVIDENCE_COVERAGE';
    })) {
      failures.push('active workflow evidence accepted a substituted judgment criterion');
    }

    const incompleteHistoricalSources = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'incomplete-historical-sources')
    );
    const historicalArtifacts = incompleteHistoricalSources.receipts.get('codex').artifacts;
    historicalArtifacts.splice(historicalArtifacts.findIndex((artifact) => {
      return artifact.role === 'migration-source'
        && artifact.path.includes('/evals/');
    }), 1);
    refreshActiveWorkflowEvidenceSelftestFixture(incompleteHistoricalSources, 'codex');
    const incompleteHistoricalInspection = inspectActiveWorkflowEvidence(incompleteHistoricalSources);
    if (!incompleteHistoricalInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_EVIDENCE';
    })) {
      failures.push('active workflow evidence accepted a partial historical source set');
    }

    const substitutedFinalSource = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'substituted-final-source')
    );
    substitutedFinalSource.finalEntries.get('codex').doc.artifacts.find((artifact) => {
      return artifact.role === 'migration-source' && artifact.path.includes('/evals/');
    }).fingerprint = fingerprintJson({ source: 'substituted' });
    const substitutedFinalInspection = inspectActiveWorkflowEvidence(substitutedFinalSource);
    if (!substitutedFinalInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_FINAL_EVIDENCE_BINDING';
    })) {
      failures.push('active workflow final evidence accepted a substituted evaluation tombstone');
    }

    const substitutedFinalTarget = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'substituted-final-target')
    );
    substitutedFinalTarget.finalEntries.get('codex').doc.artifacts.find((artifact) => {
      return artifact.role === 'migration-target' && artifact.path.endsWith('/evaluations.json');
    }).fingerprint = fingerprintJson({ target: 'substituted' });
    const substitutedFinalTargetInspection = inspectActiveWorkflowEvidence(substitutedFinalTarget);
    if (!substitutedFinalTargetInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_FINAL_EVIDENCE_BINDING';
    })) {
      failures.push('active workflow final evidence accepted a substituted evaluation target');
    }

    const extraFinalTarget = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'extra-final-target')
    );
    extraFinalTarget.finalEntries.get('codex').doc.artifacts.push({
      role: 'migration-target',
      path: 'soter/automations/other/evaluations.json',
      fingerprint: fingerprintJson({ target: 'extra' })
    });
    const extraFinalTargetInspection = inspectActiveWorkflowEvidence(extraFinalTarget);
    if (!extraFinalTargetInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_FINAL_EVIDENCE_BINDING';
    })) {
      failures.push('active workflow final evidence accepted an extra migration target');
    }

    const partialDocumentTombstones = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'partial-document-tombstones')
    );
    partialDocumentTombstones.evaluationEntry.doc.cases[0].source.presence = 'present';
    const partialDocumentInspection = inspectActiveWorkflowEvidence(partialDocumentTombstones);
    if (!partialDocumentInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_SOURCE_SET';
    })) {
      failures.push('active workflow final basis accepted partial document tombstones');
    }
    const staticResolutionInspection = inspectActiveWorkflowEvidence({
      ...validFixture,
      evidence: new Map(),
      requireFinalEvidence: false
    });
    if (staticResolutionInspection.findings.some((item) => {
      return item.code.startsWith('SOTER_WORKFLOW_GUIDE_FINAL_EVIDENCE');
    })) {
      failures.push('static configuration resolution incorrectly required current-lock final evidence');
    }

    const wrongHostFixture = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'wrong-host')
    );
    wrongHostFixture.receipts.get('codex').host.id = 'claude';
    refreshActiveWorkflowEvidenceSelftestFixture(wrongHostFixture, 'codex');
    const wrongHostInspection = inspectActiveWorkflowEvidence(wrongHostFixture);
    if (!wrongHostInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_EVIDENCE_HOST';
    })) {
      failures.push('active workflow evidence accepted a historical receipt from the wrong host');
    }

    const swappedReceiptFixture = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'swapped-receipt')
    );
    const codexReceiptArtifact = swappedReceiptFixture.finalEntries.get('codex').doc.artifacts
      .find((artifact) => artifact.role === 'development-agent-migration-evidence');
    const claudeReference = swappedReceiptFixture.references.get('claude');
    codexReceiptArtifact.path = claudeReference.path;
    codexReceiptArtifact.fingerprint = claudeReference.fingerprint;
    const swappedReceiptInspection = inspectActiveWorkflowEvidence(swappedReceiptFixture);
    if (!swappedReceiptInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_FINAL_EVIDENCE_BINDING';
    })) {
      failures.push('active workflow evidence accepted a final record joined to the other host receipt');
    }

    const incompleteRunsFixture = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'incomplete-runs')
    );
    incompleteRunsFixture.receipts.get('codex').runs.pop();
    refreshActiveWorkflowEvidenceSelftestFixture(incompleteRunsFixture, 'codex');
    const incompleteRunsInspection = inspectActiveWorkflowEvidence(incompleteRunsFixture);
    if (!incompleteRunsInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_EVIDENCE_COVERAGE';
    })) {
      failures.push('active workflow evidence accepted incomplete guided run coverage');
    }

    const impossibleChronologyFixture = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'impossible-chronology')
    );
    impossibleChronologyFixture.receipts.get('codex').runs
      .find((run) => run.arm === 'guided').completedAt = '2026-07-22T10:01:00.000Z';
    refreshActiveWorkflowEvidenceSelftestFixture(impossibleChronologyFixture, 'codex');
    const impossibleChronologyInspection = inspectActiveWorkflowEvidence(
      impossibleChronologyFixture
    );
    if (!impossibleChronologyInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_EVIDENCE';
    })) {
      failures.push('active workflow evidence accepted impossible internal chronology');
    }

    const substitutedWorkspaceFixture = installActiveWorkflowEvidenceSelftestFixture(
      path.join(activeEvidenceTemp, 'substituted-workspace')
    );
    substitutedWorkspaceFixture.receipts.get('codex').workspace.post.rootIdentityFingerprint
      = fingerprintJson({ workspace: 'substituted-root' });
    refreshActiveWorkflowEvidenceSelftestFixture(substitutedWorkspaceFixture, 'codex');
    const substitutedWorkspaceInspection = inspectActiveWorkflowEvidence(
      substitutedWorkspaceFixture
    );
    if (!substitutedWorkspaceInspection.findings.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_EVIDENCE';
    })) {
      failures.push('active workflow evidence accepted a substituted post-run root identity');
    }
  } finally {
    fs.rmSync(activeEvidenceTemp, { recursive: true, force: true });
  }

  const retiredEvidenceTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-retired-evidence-'));
  try {
    const validRetirement = installRetiredWorkflowEvidenceSelftestFixture(
      path.join(retiredEvidenceTemp, 'valid')
    );
    if (inspectRetiredWorkflowEvidence(validRetirement).length) {
      failures.push('valid retired workflow evidence fixture failed');
    }

    const stagedRetirement = installRetiredWorkflowEvidenceSelftestFixture(
      path.join(retiredEvidenceTemp, 'staged')
    );
    stagedRetirement.documentsByPath.clear();
    fs.rmSync(stagedRetirement.evidenceFile);
    if (inspectRetiredWorkflowEvidence({
      ...stagedRetirement,
      requireFinalEvidence: false
    }).length) {
      failures.push('static retirement resolution required not-yet-generated final evidence');
    }
    if (!inspectRetiredWorkflowEvidence(stagedRetirement).length) {
      failures.push('final retirement verification accepted missing evidence');
    }

    const substitutedRetirement = installRetiredWorkflowEvidenceSelftestFixture(
      path.join(retiredEvidenceTemp, 'substituted-source')
    );
    substitutedRetirement.evidence.artifacts.find((artifact) => {
      return artifact.role === 'migration-source' && artifact.path.includes('/evals/');
    }).fingerprint = fingerprintJson({ source: 'substituted' });
    if (!inspectRetiredWorkflowEvidence(substitutedRetirement).length) {
      failures.push('retired workflow evidence accepted a substituted source tombstone');
    }

    const extraTargetRetirement = installRetiredWorkflowEvidenceSelftestFixture(
      path.join(retiredEvidenceTemp, 'extra-target')
    );
    extraTargetRetirement.evidence.artifacts.push({
      role: 'migration-target',
      path: 'soter/automations/other/evaluations.json',
      fingerprint: fingerprintJson({ target: 'extra' })
    });
    if (!inspectRetiredWorkflowEvidence(extraTargetRetirement).length) {
      failures.push('retired workflow evidence accepted an extra migration target');
    }

    const staleLockRetirement = installRetiredWorkflowEvidenceSelftestFixture(
      path.join(retiredEvidenceTemp, 'stale-lock')
    );
    staleLockRetirement.evidence.configurationLockFingerprint = fingerprintJson({ lock: 'stale' });
    if (!inspectRetiredWorkflowEvidence(staleLockRetirement).length) {
      failures.push('retired workflow evidence accepted a stale configuration lock binding');
    }

    const wrongVersionRetirement = installRetiredWorkflowEvidenceSelftestFixture(
      path.join(retiredEvidenceTemp, 'wrong-version')
    );
    wrongVersionRetirement.evidence.subject.version = '9.9.9';
    if (!inspectRetiredWorkflowEvidence(wrongVersionRetirement).length) {
      failures.push('retired workflow evidence accepted another workflow version');
    }

    const substitutedReference = installRetiredWorkflowEvidenceSelftestFixture(
      path.join(retiredEvidenceTemp, 'substituted-reference')
    );
    substitutedReference.definitionEntry.doc.lifecycle.retirement.evidence = [{
      path: 'soter/fixtures/harness-development-catalog/other.intentional-retirement.evidence.json'
    }];
    if (!inspectRetiredWorkflowEvidence(substitutedReference).length) {
      failures.push('retired workflow accepted mismatched definition and guide evidence references');
    }
  } finally {
    fs.rmSync(retiredEvidenceTemp, { recursive: true, force: true });
  }

  const live = verifySoter(root);
  if (live.health.valid !== 'passed') {
    failures.push('repository target fixture is not clean: ' + live.violations.map((item) => item.code).join(', '));
  }
  if (!live.resolvedConfigurations.length
    || live.resolvedConfigurations.some((config) => config.selections.some((selection) => !selection.reason))) {
    failures.push('structured resolution omits configuration or selection reasons');
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-verifier-'));
  try {
    fs.cpSync(path.join(root, 'soter'), path.join(temp, 'soter'), { recursive: true });
    copyExternalPackArtifacts(root, temp);
    copyMigrationSources(root, temp);
    const definitionOnlyFixture = installDefinitionOnlySelftestGraph(temp);
    const clean = verifySoter(temp);
    if (clean.health.valid !== 'passed') {
      failures.push('copied clean fixture failed: ' + clean.violations.map((item) => item.code).join(', '));
    }

    const kernelPackFile = path.join(temp, 'soter', 'packs', 'kernel.soter', 'pack.json');
    const originalKernelPackText = fs.readFileSync(kernelPackFile, 'utf8');
    const schemaOmittingPack = JSON.parse(originalKernelPackText);
    schemaOmittingPack.artifacts = schemaOmittingPack.artifacts.filter((artifact) => {
      return artifact.path !== 'soter/contracts/workspace-inspection.schema.json';
    });
    fs.writeFileSync(kernelPackFile, JSON.stringify(schemaOmittingPack, null, 2) + '\n');
    const unownedSchema = verifySoter(temp);
    if (!unownedSchema.violations.some((item) => item.code === 'SOTER_SCHEMA_OWNERSHIP')) {
      failures.push('planted unowned contract schema was not detected');
    }
    fs.writeFileSync(kernelPackFile, originalKernelPackText);

    const definitionOnlyPackFile = definitionOnlyFixture.packFile;
    const originalDefinitionOnlyPackText = fs.readFileSync(definitionOnlyPackFile, 'utf8');
    const runtimeClaimingDefinitionPack = JSON.parse(originalDefinitionOnlyPackText);
    runtimeClaimingDefinitionPack.operator = {
      input: 'soter/automations/project-pulse/operator-input.json'
    };
    fs.writeFileSync(
      definitionOnlyPackFile,
      JSON.stringify(runtimeClaimingDefinitionPack, null, 2) + '\n'
    );
    const badDefinitionAuthority = verifySoter(temp);
    if (!badDefinitionAuthority.violations.some((item) => {
      return item.code === 'SOTER_WORKFLOW_DEFINITION_AUTHORITY';
    })) {
      failures.push('definition-only workflow accepted a planted operator runtime declaration');
    }
    fs.writeFileSync(definitionOnlyPackFile, originalDefinitionOnlyPackText);

    const definitionOnlyWorkflowFile = definitionOnlyFixture.workflowFile;
    const originalDefinitionOnlyWorkflowText = fs.readFileSync(definitionOnlyWorkflowFile, 'utf8');
    const gappedDefinitionProcedure = JSON.parse(originalDefinitionOnlyWorkflowText);
    gappedDefinitionProcedure.procedure[1].sequence = 3;
    fs.writeFileSync(
      definitionOnlyWorkflowFile,
      JSON.stringify(gappedDefinitionProcedure, null, 2) + '\n'
    );
    const badDefinitionSequence = verifySoter(temp);
    if (!badDefinitionSequence.violations.some((item) => {
      return item.code === 'SOTER_WORKFLOW_PROCEDURE_IDENTITY';
    })) {
      failures.push('definition-only workflow accepted a planted gapped procedure sequence');
    }
    fs.writeFileSync(definitionOnlyWorkflowFile, originalDefinitionOnlyWorkflowText);

    const mismatchedEvaluationBinding = JSON.parse(originalDefinitionOnlyWorkflowText);
    mismatchedEvaluationBinding.evaluationSet.id = 'evaluation-set.missing-workflow';
    fs.writeFileSync(
      definitionOnlyWorkflowFile,
      JSON.stringify(mismatchedEvaluationBinding, null, 2) + '\n'
    );
    const badDefinitionEvaluationBinding = verifySoter(temp);
    if (!badDefinitionEvaluationBinding.violations.some((item) => {
      return item.code === 'SOTER_WORKFLOW_EVALUATION_BINDING';
    })) {
      failures.push('definition-only workflow accepted a planted mismatched evaluation binding');
    }
    fs.writeFileSync(definitionOnlyWorkflowFile, originalDefinitionOnlyWorkflowText);

    const definitionOnlyEvaluationFile = definitionOnlyFixture.evaluationFile;
    const originalDefinitionOnlyEvaluationText = fs.readFileSync(
      definitionOnlyEvaluationFile,
      'utf8'
    );
    const duplicateEvaluationIdentity = JSON.parse(originalDefinitionOnlyEvaluationText);
    duplicateEvaluationIdentity.cases[1].id = duplicateEvaluationIdentity.cases[0].id;
    fs.writeFileSync(
      definitionOnlyEvaluationFile,
      JSON.stringify(duplicateEvaluationIdentity, null, 2) + '\n'
    );
    const badEvaluationIdentity = verifySoter(temp);
    if (!badEvaluationIdentity.violations.some((item) => {
      return item.code === 'SOTER_WORKFLOW_EVALUATION_IDENTITY';
    })) {
      failures.push('definition-only workflow accepted a planted duplicate evaluation identity');
    }
    fs.writeFileSync(definitionOnlyEvaluationFile, originalDefinitionOnlyEvaluationText);

    const definitionOnlyGuideFile = definitionOnlyFixture.guideFile;
    const originalDefinitionOnlyGuideText = fs.readFileSync(definitionOnlyGuideFile, 'utf8');
    const mismatchedGuideBinding = JSON.parse(originalDefinitionOnlyGuideText);
    mismatchedGuideBinding.workflow.definitionFingerprint = 'sha256:' + 'f'.repeat(64);
    fs.writeFileSync(
      definitionOnlyGuideFile,
      JSON.stringify(mismatchedGuideBinding, null, 2) + '\n'
    );
    const badGuideBinding = verifySoter(temp);
    if (!badGuideBinding.violations.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_BINDING';
    })) {
      failures.push('definition-only workflow accepted a planted stale guide binding');
    }
    fs.writeFileSync(definitionOnlyGuideFile, originalDefinitionOnlyGuideText);

    const tamperedGuideContent = JSON.parse(originalDefinitionOnlyGuideText);
    tamperedGuideContent.verification[0] = 'Tampered guide verification statement.';
    fs.writeFileSync(
      definitionOnlyGuideFile,
      JSON.stringify(tamperedGuideContent, null, 2) + '\n'
    );
    const badGuideContent = verifySoter(temp);
    if (!badGuideContent.violations.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_CONTENT_FINGERPRINT';
    })) {
      failures.push('definition-only workflow accepted guide content outside its semantic fingerprint');
    }
    fs.writeFileSync(definitionOnlyGuideFile, originalDefinitionOnlyGuideText);

    const mismatchedGuideProcedure = JSON.parse(originalDefinitionOnlyGuideText);
    mismatchedGuideProcedure.stepDetails[1].id = 'different-valid-step';
    fs.writeFileSync(
      definitionOnlyGuideFile,
      JSON.stringify(mismatchedGuideProcedure, null, 2) + '\n'
    );
    const badGuideProcedure = verifySoter(temp);
    if (!badGuideProcedure.violations.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_PROCEDURE';
    })) {
      failures.push('definition-only workflow accepted a planted guide procedure mismatch');
    }
    fs.writeFileSync(definitionOnlyGuideFile, originalDefinitionOnlyGuideText);

    const unevidencedActiveGuide = JSON.parse(originalDefinitionOnlyGuideText);
    unevidencedActiveGuide.status = {
      state: 'active',
      reasonCode: 'WORKFLOW_GUIDE_ACTIVE',
      proceduralAuthority: 'target',
      behaviorParity: 'passed',
      delivery: 'host-skill',
      evidence: [{
        path: 'soter/evidence/development/missing-workflow-guide-migration.json',
        fingerprint: 'sha256:' + 'e'.repeat(64),
        host: 'codex'
      }, {
        path: 'soter/evidence/development/missing-workflow-guide-migration-claude.json',
        fingerprint: 'sha256:' + 'd'.repeat(64),
        host: 'claude'
      }],
      permittedNextAction: 'invoke-through-selected-host'
    };
    fs.writeFileSync(
      definitionOnlyGuideFile,
      JSON.stringify(unevidencedActiveGuide, null, 2) + '\n'
    );
    const badActiveGuide = verifySoter(temp);
    if (!badActiveGuide.violations.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_EVIDENCE';
    }) || !badActiveGuide.violations.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_MIGRATION';
    }) || badActiveGuide.violations.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_CONTENT_FINGERPRINT';
    })) {
      failures.push('definition-only workflow did not preserve stable guide content while rejecting unevidenced activation');
    }
    fs.writeFileSync(definitionOnlyGuideFile, originalDefinitionOnlyGuideText);

    const guideOmittingPack = JSON.parse(originalDefinitionOnlyPackText);
    guideOmittingPack.artifacts = guideOmittingPack.artifacts.filter((artifact) => {
      return artifact.path !== 'soter/automations/definition-only-selftest/guide.json';
    });
    fs.writeFileSync(
      definitionOnlyPackFile,
      JSON.stringify(guideOmittingPack, null, 2) + '\n'
    );
    const badGuideArtifact = verifySoter(temp);
    if (!badGuideArtifact.violations.some((item) => {
      return item.code === 'SOTER_WORKFLOW_GUIDE_ARTIFACT';
    })) {
      failures.push('definition-only workflow accepted an undeclared workflow guide');
    }
    fs.writeFileSync(definitionOnlyPackFile, originalDefinitionOnlyPackText);

    const candidateConfigFile = path.join(
      temp,
      'soter',
      'configurations',
      'meeting-intake.config.json'
    );
    const candidateConfigText = fs.readFileSync(candidateConfigFile, 'utf8');
    const candidateConfig = JSON.parse(candidateConfigText);
    candidateConfig.host = {
      id: 'claude',
      adapter: 'host.claude',
      version: '0.3.1',
      reason: 'Preview the same selected systems through the declared Claude host projection.'
    };
    const validCandidate = verifyConfigurationCandidate(temp, {
      configPath: candidateConfigFile,
      configuration: candidateConfig
    });
    if (validCandidate.health.valid !== 'passed'
      || fs.readFileSync(candidateConfigFile, 'utf8') !== candidateConfigText) {
      failures.push('in-memory configuration candidate was not validated without mutating its source file');
    }
    const invalidCandidate = structuredClone(candidateConfig);
    invalidCandidate.settings['integration.notion'].unexpected = true;
    const invalidCandidateResult = verifyConfigurationCandidate(temp, {
      configPath: candidateConfigFile,
      configuration: invalidCandidate
    });
    if (!invalidCandidateResult.violations.some((item) => {
      return item.code === 'SOTER_PACK_SETTINGS_SCHEMA';
    }) || fs.readFileSync(candidateConfigFile, 'utf8') !== candidateConfigText) {
      failures.push('in-memory configuration candidate bypassed pack-owned settings or mutated its source file');
    }

    const taskConfigurationFile = path.join(
      temp,
      'soter',
      'configurations',
      'task-capture.config.json'
    );
    const taskConfigurationText = fs.readFileSync(taskConfigurationFile, 'utf8');
    const minimalTaskConfiguration = JSON.parse(taskConfigurationText);
    const allTaskTargets = minimalTaskConfiguration.settings['integration.notion'].targets;
    minimalTaskConfiguration.settings['integration.notion'].targets = Object.fromEntries(
      ['policies', 'projects', 'tasks'].map((target) => [target, allTaskTargets[target]])
    );
    const minimalTaskResult = verifyConfigurationCandidate(temp, {
      configPath: taskConfigurationFile,
      configuration: minimalTaskConfiguration
    });
    if (minimalTaskResult.health.valid !== 'passed') {
      failures.push(
        'Task Capture did not accept only its exact policies/projects/tasks Notion targets: '
          + minimalTaskResult.violations.map((item) => item.code).join(', ')
      );
    }
    for (const target of ['policies', 'projects', 'tasks']) {
      const missingTaskTarget = structuredClone(minimalTaskConfiguration);
      delete missingTaskTarget.settings['integration.notion'].targets[target];
      const missingTaskTargetResult = verifyConfigurationCandidate(temp, {
        configPath: taskConfigurationFile,
        configuration: missingTaskTarget
      });
      if (!missingTaskTargetResult.violations.some((item) => {
        return item.code === 'SOTER_PACK_SETTINGS_REQUIRED_TARGET'
          && item.what.includes('automation=automation.task-capture')
          && item.what.includes('target=' + target);
      })) {
        failures.push('Task Capture accepted missing required Notion target ' + target);
      }
    }

    const slackReviewConfigurationFile = path.join(
      temp,
      'soter',
      'configurations',
      'slack-conversation-review.config.json'
    );
    const slackReviewConfigurationText = fs.readFileSync(
      slackReviewConfigurationFile,
      'utf8'
    );
    const minimalSlackReviewConfiguration = JSON.parse(slackReviewConfigurationText);
    const slackPolicyTarget =
      minimalSlackReviewConfiguration.settings['integration.notion'].targets.policies;
    minimalSlackReviewConfiguration.settings['integration.notion'].targets = {
      policies: slackPolicyTarget
    };
    const minimalSlackReviewResult = verifyConfigurationCandidate(temp, {
      configPath: slackReviewConfigurationFile,
      configuration: minimalSlackReviewConfiguration
    });
    if (minimalSlackReviewResult.health.valid !== 'passed') {
      failures.push(
        'Slack Conversation Review required unrelated Notion channel, CRM, Project, Task, Meeting, or Document targets: '
          + minimalSlackReviewResult.violations.map((item) => item.code).join(', ')
      );
    }

    const taskPackFile = path.join(
      temp,
      'soter',
      'packs',
      'automation.task-capture',
      'pack.json'
    );
    const originalTaskPackText = fs.readFileSync(taskPackFile, 'utf8');
    const unownedTaskAcquisition = JSON.parse(originalTaskPackText);
    unownedTaskAcquisition.operator.acquisition.module =
      unownedTaskAcquisition.operator.input;
    fs.writeFileSync(
      taskPackFile,
      JSON.stringify(unownedTaskAcquisition, null, 2) + '\n'
    );
    const unownedTaskAcquisitionResult = verifyConfigurationCandidate(temp, {
      configPath: taskConfigurationFile,
      configuration: JSON.parse(taskConfigurationText)
    });
    if (!unownedTaskAcquisitionResult.violations.some((item) => {
      return item.code === 'SOTER_ACQUISITION_ADAPTER_OWNERSHIP';
    })) {
      failures.push('Task Capture accepted an unowned connected-acquisition adapter');
    }
    fs.writeFileSync(taskPackFile, originalTaskPackText);

    const optionalTaskAcquisitionCapability = JSON.parse(originalTaskPackText);
    optionalTaskAcquisitionCapability.capabilities.requires
      .find((requirement) => requirement.id === 'tasks.records.read')
      .optional = true;
    fs.writeFileSync(
      taskPackFile,
      JSON.stringify(optionalTaskAcquisitionCapability, null, 2) + '\n'
    );
    const optionalTaskAcquisitionCapabilityResult = verifyConfigurationCandidate(temp, {
      configPath: taskConfigurationFile,
      configuration: JSON.parse(taskConfigurationText)
    });
    if (!optionalTaskAcquisitionCapabilityResult.violations.some((item) => {
      return item.code === 'SOTER_ACQUISITION_CAPABILITY_REQUIREMENT'
        && item.what.includes('tasks.records.read');
    })) {
      failures.push('Task Capture acquisition expanded an optional pack capability');
    }
    fs.writeFileSync(taskPackFile, originalTaskPackText);

    const duplicateTaskAcquisitionCoverage = JSON.parse(originalTaskPackText);
    duplicateTaskAcquisitionCoverage.operator.acquisition.recordRequirements.push({
      capability: 'tasks.records.read',
      recordTypes: ['task']
    });
    fs.writeFileSync(
      taskPackFile,
      JSON.stringify(duplicateTaskAcquisitionCoverage, null, 2) + '\n'
    );
    const duplicateTaskAcquisitionCoverageResult = verifyConfigurationCandidate(temp, {
      configPath: taskConfigurationFile,
      configuration: JSON.parse(taskConfigurationText)
    });
    if (!duplicateTaskAcquisitionCoverageResult.violations.some((item) => {
      return item.code === 'SOTER_ACQUISITION_RECORD_REQUIREMENT_DUPLICATE'
        && item.what.includes('tasks.records.read|task');
    })) {
      failures.push('Task Capture accepted duplicate capability and record acquisition coverage');
    }
    fs.writeFileSync(taskPackFile, originalTaskPackText);

    const unmappedTaskRequirement = JSON.parse(originalTaskPackText);
    unmappedTaskRequirement.operator.acquisition.recordRequirements
      .find((requirement) => requirement.capability === 'tasks.records.read')
      .recordTypes[0] = 'unmapped-task-record';
    fs.writeFileSync(
      taskPackFile,
      JSON.stringify(unmappedTaskRequirement, null, 2) + '\n'
    );
    const unmappedTaskRequirementResult = verifyConfigurationCandidate(temp, {
      configPath: taskConfigurationFile,
      configuration: JSON.parse(taskConfigurationText)
    });
    if (!unmappedTaskRequirementResult.violations.some((item) => {
      return item.code === 'SOTER_PACK_SETTINGS_REQUIRED_TARGET'
        && item.what.includes('automation=automation.task-capture')
        && item.what.includes('capability=tasks.records.read')
        && item.what.includes('record=unmapped-task-record')
        && item.what.includes('target=unresolved')
        && item.what.includes('mappingMatches=0');
    })) {
      failures.push('Task Capture accepted a declared record acquisition with no Notion mapping');
    }
    fs.writeFileSync(taskPackFile, originalTaskPackText);

    const taskMappingFile = path.join(
      temp,
      'soter',
      'integrations',
      'notion',
      'tasks-records.mapping.json'
    );
    const originalTaskMappingText = fs.readFileSync(taskMappingFile, 'utf8');
    const ambiguousTaskMapping = JSON.parse(originalTaskMappingText);
    const duplicateTaskRecord = structuredClone(
      ambiguousTaskMapping.recordTypes.find((record) => record.id === 'task')
    );
    duplicateTaskRecord.target = 'meetings';
    ambiguousTaskMapping.recordTypes.push(duplicateTaskRecord);
    fs.writeFileSync(
      taskMappingFile,
      JSON.stringify(ambiguousTaskMapping, null, 2) + '\n'
    );
    const ambiguousTaskMappingResult = verifyConfigurationCandidate(temp, {
      configPath: taskConfigurationFile,
      configuration: JSON.parse(taskConfigurationText)
    });
    if (!ambiguousTaskMappingResult.violations.some((item) => {
      return item.code === 'SOTER_PACK_SETTINGS_REQUIRED_TARGET'
        && item.what.includes('automation=automation.task-capture')
        && item.what.includes('capability=tasks.records.read')
        && item.what.includes('record=task')
        && item.what.includes('target=unresolved')
        && item.what.includes('mappingMatches=2');
    })) {
      failures.push('Task Capture accepted an ambiguously mapped Notion record acquisition');
    }
    fs.writeFileSync(taskMappingFile, originalTaskMappingText);

    const projectPulsePackFile = path.join(temp, 'soter', 'packs', 'automation.project-pulse', 'pack.json');
    const originalProjectPulsePackText = fs.readFileSync(projectPulsePackFile, 'utf8');
    const unknownCompatibleHost = JSON.parse(originalProjectPulsePackText);
    unknownCompatibleHost.compatibility.hosts.push('unknown-host');
    fs.writeFileSync(
      projectPulsePackFile,
      JSON.stringify(unknownCompatibleHost, null, 2) + '\n'
    );
    const unknownCompatibleHostResult = verifySoter(temp);
    if (!unknownCompatibleHostResult.violations.some((item) => {
      return item.code === 'SOTER_PACK_HOST_COMPATIBILITY'
        && item.what.includes('unknown compatible host: unknown-host');
    })) {
      failures.push('pack compatibility accepted an unknown compatible host');
    }
    fs.writeFileSync(projectPulsePackFile, originalProjectPulsePackText);
    const projectPulseConfigurationFile = path.join(
      temp,
      'soter',
      'configurations',
      'project-pulse.config.json'
    );
    const projectPulseConfigurationText = fs.readFileSync(
      projectPulseConfigurationFile,
      'utf8'
    );
    const projectPulseWithoutExecutionTarget = JSON.parse(projectPulseConfigurationText);
    delete projectPulseWithoutExecutionTarget.settings['integration.notion'].targets.updates;
    const missingProjectPulseExecutionTarget = verifyConfigurationCandidate(temp, {
      configPath: projectPulseConfigurationFile,
      configuration: projectPulseWithoutExecutionTarget
    });
    if (!missingProjectPulseExecutionTarget.violations.some((item) => {
      return item.code === 'SOTER_PACK_SETTINGS_REQUIRED_TARGET'
        && item.what.includes('automation=automation.project-pulse')
        && item.what.includes('phase=connection')
        && item.what.includes('capability=projects.records.create')
        && item.what.includes('record=project-feed-entry')
        && item.what.includes('target=updates');
    })) {
      failures.push('Project Pulse accepted a configuration missing its later status-create target');
    }

    const optionalProjectPulseConnectionCapability = JSON.parse(originalProjectPulsePackText);
    optionalProjectPulseConnectionCapability.capabilities.requires
      .find((requirement) => requirement.id === 'projects.records.create')
      .optional = true;
    fs.writeFileSync(
      projectPulsePackFile,
      JSON.stringify(optionalProjectPulseConnectionCapability, null, 2) + '\n'
    );
    const optionalProjectPulseConnectionResult = verifyConfigurationCandidate(temp, {
      configPath: projectPulseConfigurationFile,
      configuration: JSON.parse(projectPulseConfigurationText)
    });
    if (!optionalProjectPulseConnectionResult.violations.some((item) => {
      return item.code === 'SOTER_CONNECTION_CAPABILITY_REQUIREMENT'
        && item.what.includes('projects.records.create');
    })) {
      failures.push('Project Pulse connected compiler expanded an optional pack capability');
    }
    fs.writeFileSync(projectPulsePackFile, originalProjectPulsePackText);

    const duplicateProjectPulseConnectionCoverage = JSON.parse(
      originalProjectPulsePackText
    );
    duplicateProjectPulseConnectionCoverage.operator.connection.recordRequirements.push({
      capability: 'projects.records.create',
      recordTypes: ['project-feed-entry', 'project']
    });
    fs.writeFileSync(
      projectPulsePackFile,
      JSON.stringify(duplicateProjectPulseConnectionCoverage, null, 2) + '\n'
    );
    const duplicateProjectPulseConnectionResult = verifyConfigurationCandidate(temp, {
      configPath: projectPulseConfigurationFile,
      configuration: JSON.parse(projectPulseConfigurationText)
    });
    if (!duplicateProjectPulseConnectionResult.violations.some((item) => {
      return item.code === 'SOTER_CONNECTION_RECORD_REQUIREMENT_DUPLICATE'
        && item.what.includes('projects.records.create|project-feed-entry');
    })) {
      failures.push('Project Pulse accepted duplicate connected record target coverage');
    }
    fs.writeFileSync(projectPulsePackFile, originalProjectPulsePackText);

    const unownedPreparation = JSON.parse(originalProjectPulsePackText);
    unownedPreparation.operator.preparation.module = unownedPreparation.operator.input;
    fs.writeFileSync(projectPulsePackFile, JSON.stringify(unownedPreparation, null, 2) + '\n');
    const badPreparationOwner = verifySoter(temp);
    if (!badPreparationOwner.violations.some((item) => item.code === 'SOTER_PREPARATION_ADAPTER_OWNERSHIP')) {
      failures.push('planted unowned prepared-work adapter was not detected');
    }
    fs.writeFileSync(projectPulsePackFile, originalProjectPulsePackText);

    const emailPackFile = path.join(
      temp,
      'soter',
      'packs',
      'automation.email-triage',
      'pack.json'
    );
    const originalEmailPackText = fs.readFileSync(emailPackFile, 'utf8');
    const unownedProposal = JSON.parse(originalEmailPackText);
    unownedProposal.operator.proposal.module = unownedProposal.operator.proposal.schema;
    fs.writeFileSync(emailPackFile, JSON.stringify(unownedProposal, null, 2) + '\n');
    const badProposalOwner = verifySoter(temp);
    if (!badProposalOwner.violations.some((item) => {
      return item.code === 'SOTER_PROPOSAL_ADAPTER_OWNERSHIP';
    })) {
      failures.push('planted unowned Automation proposal adapter was not detected');
    }
    fs.writeFileSync(emailPackFile, originalEmailPackText);

    const mismatchedProposalReview = JSON.parse(originalEmailPackText);
    mismatchedProposalReview.operator.proposal.derivedReviewContract
      = mismatchedProposalReview.operator.proposal.schema;
    fs.writeFileSync(emailPackFile, JSON.stringify(mismatchedProposalReview, null, 2) + '\n');
    const badProposalReview = verifySoter(temp);
    if (!badProposalReview.violations.some((item) => {
      return item.code === 'SOTER_PROPOSAL_DERIVED_REVIEW_CONTRACT';
    })) {
      failures.push('planted mismatched Automation proposal review contract was not detected');
    }
    fs.writeFileSync(emailPackFile, originalEmailPackText);

    const projectPulseInputFile = path.join(
      temp,
      'soter',
      'automations',
      'project-pulse',
      'operator-input.json'
    );
    const originalProjectPulseInputText = fs.readFileSync(projectPulseInputFile, 'utf8');
    const mismatchedOperatorInput = JSON.parse(originalProjectPulseInputText);
    mismatchedOperatorInput.automation = 'automation.meeting-intake';
    fs.writeFileSync(projectPulseInputFile, JSON.stringify(mismatchedOperatorInput, null, 2) + '\n');
    const badOperatorInput = verifySoter(temp);
    if (!badOperatorInput.violations.some((item) => item.code === 'SOTER_OPERATOR_INPUT_CONTRACT')) {
      failures.push('planted mismatched Automation operator input was not detected');
    }
    fs.writeFileSync(projectPulseInputFile, originalProjectPulseInputText);

    const decisionFile = path.join(
      temp,
      'soter',
      'fixtures',
      'meeting-intake',
      'schema-conditional-selftest.json'
    );
    const invalidConditionalDecision = {
      $contract: 'soter://contracts/automation-decision/v1',
      contractVersion: '1.0.0',
      id: 'decision.schema-conditional-selftest',
      automation: { id: 'automation.meeting-intake', version: '0.1.0' },
      runId: 'run.schema-conditional-selftest',
      createdAt: '2026-07-15T12:00:00.000Z',
      configurationLockFingerprint: 'sha256:' + '1'.repeat(64),
      graphFingerprint: 'sha256:' + '2'.repeat(64),
      context: {
        snapshotId: 'context.schema-conditional-selftest',
        snapshotFingerprint: 'sha256:' + '3'.repeat(64)
      },
      producer: { kind: 'fixture', id: 'fixture.schema-conditional-selftest', host: null },
      state: 'ready',
      decisionType: 'schema-conditional-selftest',
      payload: { state: 'synthetic' },
      issues: [],
      privacy: {
        scope: 'private',
        redactions: ['Synthetic schema-only private values are not persisted.']
      },
      decisionFingerprint: 'sha256:' + '4'.repeat(64)
    };
    invalidConditionalDecision.producer.kind = 'host';
    fs.writeFileSync(decisionFile, JSON.stringify(invalidConditionalDecision, null, 2) + '\n');
    const badConditionalDecision = verifySoter(temp);
    if (!badConditionalDecision.violations.some((item) => item.code === 'SOTER_SCHEMA')) {
      failures.push('planted automation-decision conditional mismatch was not detected');
    }
    fs.rmSync(decisionFile);

    const decisionSchemaFile = path.join(
      temp,
      'soter',
      'contracts',
      'automation-decision.schema.json'
    );
    const originalDecisionSchemaText = fs.readFileSync(decisionSchemaFile, 'utf8');
    const unsupportedDecisionSchema = JSON.parse(originalDecisionSchemaText);
    unsupportedDecisionSchema.unimplementedConstraint = true;
    fs.writeFileSync(decisionSchemaFile, JSON.stringify(unsupportedDecisionSchema, null, 2) + '\n');
    const badSchemaDefinition = verifySoter(temp);
    if (!badSchemaDefinition.violations.some((item) => item.code === 'SOTER_SCHEMA_DEFINITION')) {
      failures.push('planted unsupported schema keyword was not detected by repository verification');
    }
    fs.writeFileSync(decisionSchemaFile, originalDecisionSchemaText);

    const lockFile = path.join(
      temp,
      'soter',
      'fixtures',
      'meeting-intake',
      'meeting-intake.lock.json'
    );
    const originalLockText = fs.readFileSync(lockFile, 'utf8');
    const badHostLock = JSON.parse(originalLockText);
    badHostLock.configuration.hostSelection.id = 'claude';
    delete badHostLock.graphFingerprint;
    badHostLock.graphFingerprint = fingerprintJson(badHostLock);
    fs.writeFileSync(lockFile, JSON.stringify(badHostLock, null, 2) + '\n');
    const mismatchedHostLock = verifySoter(temp);
    if (!mismatchedHostLock.violations.some((item) => {
      return item.code === 'SOTER_LOCK_HOST_SELECTION';
    })) {
      failures.push('planted lock host-selection mismatch was not detected');
    }
    fs.writeFileSync(lockFile, originalLockText);

    const historicalBasisLockFile = path.join(
      temp,
      'soter',
      'fixtures',
      'harness-development-catalog-final',
      'codex.lock.json'
    );
    const originalHistoricalBasisLockText = fs.readFileSync(historicalBasisLockFile, 'utf8');
    const badHistoricalBasisIdentity = JSON.parse(originalHistoricalBasisLockText);
    badHistoricalBasisIdentity.configuration.name = 'substituted-historical-basis';
    delete badHistoricalBasisIdentity.graphFingerprint;
    badHistoricalBasisIdentity.graphFingerprint = fingerprintJson(badHistoricalBasisIdentity);
    fs.writeFileSync(
      historicalBasisLockFile,
      JSON.stringify(badHistoricalBasisIdentity, null, 2) + '\n'
    );
    const mismatchedHistoricalBasis = verifySoter(temp);
    if (!mismatchedHistoricalBasis.violations.some((item) => {
      return item.code === 'SOTER_LOCK_HOST_SELECTION'
        && path.resolve(item.file) === path.resolve(historicalBasisLockFile);
    })) {
      failures.push('planted historical workflow evidence-basis identity mismatch was not detected');
    }
    fs.writeFileSync(historicalBasisLockFile, originalHistoricalBasisLockText);

    const evidenceFile = path.join(
      temp,
      'soter',
      'fixtures',
      'meeting-intake',
      'resolution.evidence.json'
    );
    const originalEvidenceText = fs.readFileSync(evidenceFile, 'utf8');
    const incompleteEvidence = JSON.parse(originalEvidenceText);
    if (incompleteEvidence.$contract !== 'soter://contracts/evidence/v2') {
      failures.push('generated evidence fixtures did not migrate to evidence/v2');
    } else {
      incompleteEvidence.dependencies = incompleteEvidence.dependencies.slice(1);
      fs.writeFileSync(evidenceFile, JSON.stringify(incompleteEvidence, null, 2) + '\n');
      const badEvidenceApplicability = verifySoter(temp);
      if (!badEvidenceApplicability.violations.some((item) => {
        return item.code === 'SOTER_EVIDENCE_APPLICABILITY';
      })) {
        failures.push('planted incomplete evidence/v2 applicability set was not detected');
      }
      fs.writeFileSync(evidenceFile, originalEvidenceText);
    }

    const privateContainedEvidenceFile = path.join(
      temp,
      'soter',
      'fixtures',
      'task-capture',
      'connected-workflow.evidence.json'
    );
    const originalPrivateContainedEvidenceText = fs.readFileSync(
      privateContainedEvidenceFile,
      'utf8'
    );
    const privateContainedEvidence = JSON.parse(originalPrivateContainedEvidenceText);
    if (!privateContainedEvidence.privateContainedBasis) {
      failures.push('connected workflow evidence omitted its private-contained basis');
    } else {
      const mismatchedPrivateCommitment = structuredClone(privateContainedEvidence);
      mismatchedPrivateCommitment.configurationLockFingerprint
        = 'sha256:' + '9'.repeat(64);
      fs.writeFileSync(
        privateContainedEvidenceFile,
        JSON.stringify(mismatchedPrivateCommitment, null, 2) + '\n'
      );
      const badPrivateCommitment = verifySoter(temp);
      if (!badPrivateCommitment.violations.some((item) => {
        return item.code === 'SOTER_PRIVATE_CONTAINED_BASIS';
      })) {
        failures.push('private-contained evidence accepted a substituted execution lock');
      }

      const missingTemplate = structuredClone(privateContainedEvidence);
      missingTemplate.privateContainedBasis.trackedTemplateLockFingerprint
        = 'sha256:' + '8'.repeat(64);
      missingTemplate.privateContainedBasis.basisFingerprint
        = fingerprintPrivateContainedBasis(missingTemplate.privateContainedBasis);
      fs.writeFileSync(
        privateContainedEvidenceFile,
        JSON.stringify(missingTemplate, null, 2) + '\n'
      );
      const badPrivateTemplate = verifySoter(temp);
      if (!badPrivateTemplate.violations.some((item) => {
        return item.code === 'SOTER_RUNTIME_LINK';
      })) {
        failures.push('private-contained evidence accepted an absent portable template lock');
      }

      const rawPrivateValue = structuredClone(privateContainedEvidence);
      rawPrivateValue.privateContainedBasis.providerTargetValues = [
        'collection://HOSTILE_PRIVATE_TARGET_SENTINEL'
      ];
      fs.writeFileSync(
        privateContainedEvidenceFile,
        JSON.stringify(rawPrivateValue, null, 2) + '\n'
      );
      const badPrivateShape = verifySoter(temp);
      if (!badPrivateShape.violations.some((item) => item.code === 'SOTER_SCHEMA')) {
        failures.push('private-contained evidence schema represented raw provider targets');
      }
      const rawPrivateOptionValue = structuredClone(privateContainedEvidence);
      rawPrivateOptionValue.privateContainedBasis.providerOptionValues = [
        'HOSTILE_PRIVATE_PROVIDER_OPTION_SENTINEL'
      ];
      fs.writeFileSync(
        privateContainedEvidenceFile,
        JSON.stringify(rawPrivateOptionValue, null, 2) + '\n'
      );
      const badPrivateOptionShape = verifySoter(temp);
      if (!badPrivateOptionShape.violations.some((item) => item.code === 'SOTER_SCHEMA')) {
        failures.push(
          'private-contained evidence schema represented raw provider option values'
        );
      }
      fs.writeFileSync(
        privateContainedEvidenceFile,
        originalPrivateContainedEvidenceText
      );
    }

    const missingOrdinaryLock = JSON.parse(originalEvidenceText);
    missingOrdinaryLock.configurationLockFingerprint = 'sha256:' + '7'.repeat(64);
    fs.writeFileSync(evidenceFile, JSON.stringify(missingOrdinaryLock, null, 2) + '\n');
    const badOrdinaryLock = verifySoter(temp);
    if (!badOrdinaryLock.violations.some((item) => item.code === 'SOTER_RUNTIME_LINK')) {
      failures.push('ordinary evidence accepted an absent exact configuration lock');
    }
    fs.writeFileSync(evidenceFile, originalEvidenceText);

    const migrationDirectory = path.join(temp, 'soter', 'migrations');
    let scenarioMigrationFile = null;
    let originalScenarioMigrationText = null;
    let scenarioMigrationItem = null;
    for (const name of fs.readdirSync(migrationDirectory).sort()) {
      if (!name.endsWith('.migration.json')) continue;
      const candidateFile = path.join(migrationDirectory, name);
      const candidateText = fs.readFileSync(candidateFile, 'utf8');
      const candidate = JSON.parse(candidateText);
      const item = candidate.items.find((entry) => {
        return entry.state === 'migrated'
          && entry.targetPath.startsWith('soter/scenarios/');
      });
      if (!item) continue;
      scenarioMigrationFile = candidateFile;
      originalScenarioMigrationText = candidateText;
      scenarioMigrationItem = item;
      break;
    }
    if (!scenarioMigrationItem) {
      failures.push('Migration fixtures did not contain an evidence-backed migrated scenario tombstone');
    } else {
      const mismatchedMigrationEvidence = JSON.parse(originalScenarioMigrationText);
      const mismatchedScenarioItem = mismatchedMigrationEvidence.items.find((item) => {
        return item.sourcePath === scenarioMigrationItem.sourcePath
          && item.targetPath === scenarioMigrationItem.targetPath;
      });
      mismatchedScenarioItem.evidence = ['soter/fixtures/project-pulse/resolution.evidence.json'];
      fs.writeFileSync(
        scenarioMigrationFile,
        JSON.stringify(mismatchedMigrationEvidence, null, 2) + '\n'
      );
      const badMigrationEvidence = verifySoter(temp);
      if (!badMigrationEvidence.violations.some((item) => {
        return item.code === 'SOTER_MIGRATION_EVIDENCE';
      })) {
        failures.push('planted migrated-scenario evidence substitution was not detected');
      }
      fs.writeFileSync(scenarioMigrationFile, originalScenarioMigrationText);

      const scenarioEvidenceFile = path.join(temp, scenarioMigrationItem.evidence[0]);
      const originalScenarioEvidenceText = fs.readFileSync(scenarioEvidenceFile, 'utf8');
      const substitutedScenarioEvidence = JSON.parse(originalScenarioEvidenceText);
      const scenarioSourceArtifact = substitutedScenarioEvidence.artifacts.find((artifact) => {
        return artifact.role === 'migration-source'
          && artifact.path === scenarioMigrationItem.sourcePath;
      });
      if (!scenarioSourceArtifact) {
        failures.push('Migrated scenario evidence omitted its exact legacy source artifact');
      } else {
        scenarioSourceArtifact.fingerprint = 'sha256:' + 'a'.repeat(64);
        fs.writeFileSync(
          scenarioEvidenceFile,
          JSON.stringify(substitutedScenarioEvidence, null, 2) + '\n'
        );
        const badMigrationSourceEvidence = verifySoter(temp);
        if (!badMigrationSourceEvidence.violations.some((item) => {
          return item.code === 'SOTER_MIGRATION_EVIDENCE';
        })) {
          failures.push('planted migrated-scenario source substitution was not detected');
        }
      }
      fs.writeFileSync(scenarioEvidenceFile, originalScenarioEvidenceText);

      const legacyInventoryFile = path.join(
        temp,
        'soter',
        'migrations',
        'legacy-inventory.json'
      );
      const originalLegacyInventoryText = fs.readFileSync(legacyInventoryFile, 'utf8');
      const mismatchedLegacyInventory = JSON.parse(originalLegacyInventoryText);
      const inventoryItem = mismatchedLegacyInventory.items.find((item) => {
        return item.sourcePath === scenarioMigrationItem.sourcePath;
      });
      const inventoryTarget = inventoryItem?.targets.find((target) => {
        return target.id === scenarioMigrationItem.targetPack
          && target.path === scenarioMigrationItem.targetPath;
      });
      if (!inventoryTarget) {
        failures.push('Legacy inventory omitted the migrated scenario target binding');
      } else {
        inventoryTarget.evidence = ['soter/fixtures/project-pulse/resolution.evidence.json'];
        fs.writeFileSync(
          legacyInventoryFile,
          JSON.stringify(mismatchedLegacyInventory, null, 2) + '\n'
        );
        const badMigrationInventory = verifySoter(temp);
        if (!badMigrationInventory.violations.some((item) => {
          return item.code === 'SOTER_MIGRATION_INVENTORY';
        })) {
          failures.push('planted migration and legacy-inventory disagreement was not detected');
        }
      }
      fs.writeFileSync(legacyInventoryFile, originalLegacyInventoryText);

      const repeatedLegacyInventoryTarget = JSON.parse(originalLegacyInventoryText);
      const repeatedInventoryItem = repeatedLegacyInventoryTarget.items.find((item) => {
        return item.sourcePath === scenarioMigrationItem.sourcePath;
      });
      const repeatedBinding = repeatedInventoryItem?.targets.find((target) => {
        return target.id === scenarioMigrationItem.targetPack
          && target.path === scenarioMigrationItem.targetPath;
      });
      if (!repeatedBinding) {
        failures.push('Legacy inventory omitted the migrated binding needed for duplicate detection');
      } else {
        repeatedInventoryItem.targets.push({
          ...structuredClone(repeatedBinding),
          responsibility: repeatedBinding.responsibility + ' Planted duplicate.'
        });
        fs.writeFileSync(
          legacyInventoryFile,
          JSON.stringify(repeatedLegacyInventoryTarget, null, 2) + '\n'
        );
        const duplicateMigrationInventoryTarget = verifySoter(temp);
        if (!duplicateMigrationInventoryTarget.violations.some((item) => {
          return item.code === 'SOTER_MIGRATION_INVENTORY';
        })) {
          failures.push('planted duplicate migrated inventory binding was not detected');
        }
      }
      fs.writeFileSync(legacyInventoryFile, originalLegacyInventoryText);

      const tombstonedSourceFile = path.join(temp, scenarioMigrationItem.sourcePath);
      fs.mkdirSync(path.dirname(tombstonedSourceFile), { recursive: true });
      fs.writeFileSync(
        tombstonedSourceFile,
        'Planted generated output reusing a migrated source path.\n'
      );
      const reusedTombstonedPath = verifySoter(temp);
      if (reusedTombstonedPath.violations.some((item) => {
        return item.code === 'SOTER_MIGRATION_SOURCE';
      })) {
        failures.push('different generated bytes at a tombstoned legacy path were treated as the exact legacy source');
      }
      const plantedFingerprint = fingerprintFile(tombstonedSourceFile);
      const exactLiveMigration = JSON.parse(originalScenarioMigrationText);
      exactLiveMigration.items.find((item) => {
        return item.sourcePath === scenarioMigrationItem.sourcePath
          && item.targetPath === scenarioMigrationItem.targetPath;
      }).sourceFingerprint = plantedFingerprint;
      const exactLiveInventory = JSON.parse(originalLegacyInventoryText);
      exactLiveInventory.items.find((item) => {
        return item.sourcePath === scenarioMigrationItem.sourcePath;
      }).sourceFingerprint = plantedFingerprint;
      fs.writeFileSync(
        scenarioMigrationFile,
        JSON.stringify(exactLiveMigration, null, 2) + '\n'
      );
      fs.writeFileSync(
        legacyInventoryFile,
        JSON.stringify(exactLiveInventory, null, 2) + '\n'
      );
      const exactLiveTombstonedSource = verifySoter(temp);
      if (!exactLiveTombstonedSource.violations.some((item) => {
        return item.code === 'SOTER_MIGRATION_SOURCE';
      })) {
        failures.push('exact legacy source bytes retained beside their governed tombstone were not detected');
      }
      fs.writeFileSync(scenarioMigrationFile, originalScenarioMigrationText);
      fs.writeFileSync(legacyInventoryFile, originalLegacyInventoryText);
      fs.rmSync(tombstonedSourceFile);
    }

    let nonScenarioMigrationItem = null;
    for (const name of fs.readdirSync(migrationDirectory).sort()) {
      if (!name.endsWith('.migration.json')) continue;
      const candidate = JSON.parse(fs.readFileSync(path.join(migrationDirectory, name), 'utf8'));
      nonScenarioMigrationItem = candidate.items.find((item) => {
        return item.state === 'migrated'
          && !item.targetPath.startsWith('soter/scenarios/');
      }) || null;
      if (nonScenarioMigrationItem) break;
    }
    if (!nonScenarioMigrationItem) {
      failures.push('Migration fixtures omitted a finalized non-scenario migration');
    } else {
      const migrationEvidenceFile = path.join(temp, nonScenarioMigrationItem.evidence[0]);
      const originalMigrationEvidenceText = fs.readFileSync(
        migrationEvidenceFile,
        'utf8'
      );
      const mismatchedTargetEvidence = JSON.parse(originalMigrationEvidenceText);
      const migrationTargetArtifact = mismatchedTargetEvidence.artifacts.find((artifact) => {
        return artifact.role === 'migration-target'
          && artifact.path === nonScenarioMigrationItem.targetPath;
      });
      if (!migrationTargetArtifact) {
        failures.push('Non-scenario migration omitted its exact migration target');
      } else {
        migrationTargetArtifact.fingerprint = 'sha256:' + 'b'.repeat(64);
        fs.writeFileSync(
          migrationEvidenceFile,
          JSON.stringify(mismatchedTargetEvidence, null, 2) + '\n'
        );
        const badNonScenarioTarget = verifySoter(temp);
        if (!badNonScenarioTarget.violations.some((item) => {
          return item.code === 'SOTER_MIGRATION_EVIDENCE';
        })) {
          failures.push('planted non-scenario migration-target substitution was not detected');
        }
      }
      fs.writeFileSync(
        migrationEvidenceFile,
        originalMigrationEvidenceText
      );
    }

    const configFile = path.join(temp, 'soter', 'configurations', 'meeting-intake.config.json');
    const originalConfigText = fs.readFileSync(configFile, 'utf8');
    const missingContextAuthority = JSON.parse(originalConfigText);
    missingContextAuthority.bindings.find((binding) => {
      return binding.capability === 'crm.records.read';
    }).capability = 'documents.records.read';
    fs.writeFileSync(configFile, JSON.stringify(missingContextAuthority, null, 2) + '\n');
    const badContextAuthority = verifySoter(temp);
    if (!badContextAuthority.violations.some((item) => {
      return item.code === 'SOTER_BINDING_CONTEXT_MODEL'
        && item.what.includes('documents.records');
    })) {
      failures.push('planted record binding without one selected matching Context model was not detected');
    }
    fs.writeFileSync(configFile, originalConfigText);

    const config = JSON.parse(originalConfigText);
    delete config.settings['integration.notion'].targets.meetings;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    const badPackSettings = verifySoter(temp);
    if (!badPackSettings.violations.some((item) => {
      return item.code === 'SOTER_PACK_SETTINGS_REQUIRED_TARGET'
        && item.what.includes('automation=automation.meeting-intake')
        && item.what.includes('target=meetings');
    })) {
      failures.push('planted missing acquisition-required Notion target was not detected');
    }
    fs.writeFileSync(configFile, originalConfigText);

    const badSourceInput = JSON.parse(originalConfigText);
    delete badSourceInput.sources[0].input.expectedTitle;
    fs.writeFileSync(configFile, JSON.stringify(badSourceInput, null, 2) + '\n');
    const invalidSourceInput = verifySoter(temp);
    if (!invalidSourceInput.violations.some((item) => {
      return item.code === 'SOTER_SOURCE_INPUT';
    })) {
      failures.push('planted invalid portable source input was not detected');
    }
    fs.writeFileSync(configFile, originalConfigText);

    const missingRequiredSources = JSON.parse(originalConfigText);
    missingRequiredSources.sources = [];
    fs.writeFileSync(configFile, JSON.stringify(missingRequiredSources, null, 2) + '\n');
    const invalidSourceRequirement = verifySoter(temp);
    if (!invalidSourceRequirement.violations.some((item) => {
      return item.code === 'SOTER_SOURCE_REQUIREMENT';
    })) {
      failures.push('planted missing pack source requirement was not detected');
    }
    fs.writeFileSync(configFile, originalConfigText);

    const badSourceConsumer = JSON.parse(originalConfigText);
    badSourceConsumer.sources[0].consumers[0].pack = 'context.crm';
    fs.writeFileSync(configFile, JSON.stringify(badSourceConsumer, null, 2) + '\n');
    const invalidSourceConsumer = verifySoter(temp);
    if (!invalidSourceConsumer.violations.some((item) => {
      return item.code === 'SOTER_SOURCE_CONSUMER';
    })) {
      failures.push('planted source consumer without a capability requirement was not detected');
    }
    fs.writeFileSync(configFile, originalConfigText);

    const hostFile = path.join(temp, 'soter', 'hosts', 'codex', 'adapter.json');
    const originalHostText = fs.readFileSync(hostFile, 'utf8');
    const host = JSON.parse(originalHostText);
    const notionRoute = host.mcpServers.find((item) => item.id === 'notion');
    notionRoute.toolMappings = notionRoute.toolMappings.filter((item) => {
      return item.logical !== 'query_data_sources';
    });
    fs.writeFileSync(hostFile, JSON.stringify(host, null, 2) + '\n');
    const badHostTool = verifySoter(temp);
    if (!badHostTool.violations.some((item) => item.code === 'SOTER_PROVIDER_HOST_TOOL')) {
      failures.push('planted missing native host tool mapping was not detected');
    }
    fs.writeFileSync(hostFile, originalHostText);

    const slackConfigFile = path.join(
      temp,
      'soter',
      'configurations',
      'slack-conversation-review.config.json'
    );
    const originalSlackConfigText = fs.readFileSync(slackConfigFile, 'utf8');
    const claudeSlackConfig = JSON.parse(originalSlackConfigText);
    claudeSlackConfig.host = {
      id: 'claude',
      adapter: 'host.claude',
      version: '0.3.1',
      reason: 'Planted unsupported Claude Slack configuration.'
    };
    fs.writeFileSync(
      slackConfigFile,
      JSON.stringify(claudeSlackConfig, null, 2) + '\n'
    );
    const unsupportedClaudeSlack = verifySoter(temp);
    if (!unsupportedClaudeSlack.violations.some((item) => {
      return item.code === 'SOTER_HOST'
        && item.what.includes('integration.slack does not declare compatibility with host claude');
    })) {
      failures.push('planted Claude Slack configuration was not rejected mechanically');
    }
    fs.writeFileSync(slackConfigFile, originalSlackConfigText);

    const unsupportedResponseProfile = JSON.parse(originalHostText);
    unsupportedResponseProfile.mcpServers.find((item) => item.id === 'notion')
      .toolMappings.find((item) => item.logical === 'fetch').responseProfile =
        'notion.undeclared.profile.v1';
    fs.writeFileSync(
      hostFile,
      JSON.stringify(unsupportedResponseProfile, null, 2) + '\n'
    );
    const badHostResponseProfile = verifySoter(temp);
    if (!badHostResponseProfile.violations.some((item) => {
      return item.code === 'SOTER_PROVIDER_HOST_RESPONSE_PROFILE';
    })) {
      failures.push('planted undeclared host response profile was not detected');
    }
    fs.writeFileSync(hostFile, originalHostText);

    const mappingFile = path.join(
      temp,
      'soter',
      'integrations',
      'notion',
      'crm-records.mapping.json'
    );
    const originalMappingText = fs.readFileSync(mappingFile, 'utf8');
    const mapping = JSON.parse(originalMappingText);
    mapping.provider = 'provider.integration.missing';
    fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2) + '\n');
    const badProviderMapping = verifySoter(temp);
    if (!badProviderMapping.violations.some((item) => item.code === 'SOTER_PROVIDER_MAPPING_OWNER')) {
      failures.push('planted detached provider mapping was not detected');
    }
    fs.writeFileSync(mappingFile, originalMappingText);

    const missingChoiceValueMapping = JSON.parse(originalMappingText);
    delete missingChoiceValueMapping.recordTypes
      .find((record) => record.id === 'organization')
      .fields.find((field) => field.portable === 'organizationType')
      .valueMapping;
    fs.writeFileSync(
      mappingFile,
      JSON.stringify(missingChoiceValueMapping, null, 2) + '\n'
    );
    const badMissingChoiceValueMapping = verifySoter(temp);
    if (!badMissingChoiceValueMapping.violations.some((item) => {
      return item.code === 'SOTER_PROVIDER_MAPPING_VALUE_TRANSLATION'
        && item.what.includes('organization.organizationType');
    })) {
      failures.push('planted choice field without configured value mapping was not detected');
    }
    fs.writeFileSync(mappingFile, originalMappingText);

    const nonChoiceValueMapping = JSON.parse(originalMappingText);
    nonChoiceValueMapping.recordTypes
      .find((record) => record.id === 'organization')
      .fields.find((field) => field.portable === 'name')
      .valueMapping = 'configured-bijection';
    fs.writeFileSync(
      mappingFile,
      JSON.stringify(nonChoiceValueMapping, null, 2) + '\n'
    );
    const badNonChoiceValueMapping = verifySoter(temp);
    if (!badNonChoiceValueMapping.violations.some((item) => {
      return item.code === 'SOTER_PROVIDER_MAPPING_VALUE_TRANSLATION'
        && item.what.includes('organization.name');
    })) {
      failures.push('planted configured value mapping on a non-choice field was not detected');
    }
    fs.writeFileSync(mappingFile, originalMappingText);

    const unsupportedValueMapping = JSON.parse(originalMappingText);
    unsupportedValueMapping.recordTypes
      .find((record) => record.id === 'organization')
      .fields.find((field) => field.portable === 'organizationType')
      .valueMapping = 'identity';
    fs.writeFileSync(
      mappingFile,
      JSON.stringify(unsupportedValueMapping, null, 2) + '\n'
    );
    const badUnsupportedValueMapping = verifySoter(temp);
    if (!badUnsupportedValueMapping.violations.some((item) => {
      return item.code === 'SOTER_SCHEMA'
        && item.file.endsWith('crm-records.mapping.json');
    })) {
      failures.push('planted unsupported provider value mapping mode was not rejected by schema');
    }
    fs.writeFileSync(mappingFile, originalMappingText);

    const meetingMappingFile = path.join(
      temp,
      'soter',
      'integrations',
      'notion',
      'meetings-records.mapping.json'
    );
    const originalMeetingMappingText = fs.readFileSync(meetingMappingFile, 'utf8');
    const inventedContextFieldMapping = JSON.parse(originalMeetingMappingText);
    inventedContextFieldMapping.recordTypes
      .find((record) => record.id === 'meeting-summary')
      .fields.push({
        portable: 'inventedProviderMeaning',
        provider: 'Invented',
        providerType: 'text',
        decode: 'scalar'
      });
    fs.writeFileSync(
      meetingMappingFile,
      JSON.stringify(inventedContextFieldMapping, null, 2) + '\n'
    );
    const badContextMapping = verifySoter(temp);
    if (!badContextMapping.violations.some((item) => {
      return item.code === 'SOTER_PROVIDER_MAPPING_CONTEXT';
    })) {
      failures.push('planted Integration field outside the Context model was not detected');
    }
    fs.writeFileSync(meetingMappingFile, originalMeetingMappingText);

    const mismatchedContextNamespace = JSON.parse(originalMappingText);
    mismatchedContextNamespace.contextModel = 'model.context.docs.records';
    fs.writeFileSync(mappingFile, JSON.stringify(mismatchedContextNamespace, null, 2) + '\n');
    const badContextNamespace = verifySoter(temp);
    if (!badContextNamespace.violations.some((item) => {
      return item.code === 'SOTER_PROVIDER_MAPPING_CONTEXT'
        && item.what.includes('does not belong to Context subject documents.records');
    })) {
      failures.push('planted provider mapping capability and Context subject mismatch was not detected');
    }
    fs.writeFileSync(mappingFile, originalMappingText);

    const communicationsMappingFile = path.join(
      temp,
      'soter',
      'integrations',
      'notion',
      'communications-records.mapping.json'
    );
    const originalCommunicationsMappingText = fs.readFileSync(
      communicationsMappingFile,
      'utf8'
    );
    const mutableImmutableFieldMapping = JSON.parse(originalCommunicationsMappingText);
    mutableImmutableFieldMapping.recordTypes
      .find((record) => record.id === 'channel')
      .fields.find((field) => field.portable === 'platform')
      .writeOperations = ['create', 'update'];
    fs.writeFileSync(
      communicationsMappingFile,
      JSON.stringify(mutableImmutableFieldMapping, null, 2) + '\n'
    );
    const badImmutableFieldMapping = verifySoter(temp);
    if (!badImmutableFieldMapping.violations.some((item) => {
      return item.code === 'SOTER_PROVIDER_MAPPING_MUTABILITY'
        && item.what.includes('channel')
        && item.what.includes('platform');
    })) {
      failures.push('planted generic update scope for an immutable Context field was not detected');
    }
    fs.writeFileSync(communicationsMappingFile, originalCommunicationsMappingText);

    const expandedFieldWriteMapping = JSON.parse(originalCommunicationsMappingText);
    expandedFieldWriteMapping.recordTypes
      .find((record) => record.id === 'channel')
      .capabilities = expandedFieldWriteMapping.recordTypes
        .find((record) => record.id === 'channel')
        .capabilities.filter((capability) => capability !== 'communications.records.create');
    fs.writeFileSync(
      communicationsMappingFile,
      JSON.stringify(expandedFieldWriteMapping, null, 2) + '\n'
    );
    const badFieldWriteScopeMapping = verifySoter(temp);
    if (!badFieldWriteScopeMapping.violations.some((item) => {
      return item.code === 'SOTER_PROVIDER_MAPPING_WRITE_SCOPE'
        && item.what.includes('channel.platform')
        && item.what.includes('create');
    })) {
      failures.push('planted field write operation outside record capability scope was not detected');
    }
    fs.writeFileSync(communicationsMappingFile, originalCommunicationsMappingText);

    const legacyProviderMapping = JSON.parse(originalMappingText);
    legacyProviderMapping.$contract = 'soter://contracts/provider-mapping/v3';
    legacyProviderMapping.contractVersion = '3.0.0';
    fs.writeFileSync(mappingFile, JSON.stringify(legacyProviderMapping, null, 2) + '\n');
    const badLegacyProviderMapping = verifySoter(temp);
    if (!badLegacyProviderMapping.violations.some((item) => {
      return item.code === 'SOTER_CONTRACT';
    })) {
      failures.push('planted legacy provider-mapping/v3 contract was not rejected');
    }
    fs.writeFileSync(mappingFile, originalMappingText);

    const providerFixtureFile = path.join(
      temp,
      'soter',
      'fixtures',
      'providers',
      'notion',
      'workspace-records.json'
    );
    const originalProviderFixtureText = fs.readFileSync(providerFixtureFile, 'utf8');
    const invalidPolicyFixture = JSON.parse(originalProviderFixtureText);
    invalidPolicyFixture.data.records
      .find((record) => record.id === 'policy.projects')
      .fields.healthMustBeOperatorJudgment = 'yes';
    fs.writeFileSync(providerFixtureFile, JSON.stringify(invalidPolicyFixture, null, 2) + '\n');
    const badPolicyFixture = verifySoter(temp);
    if (!badPolicyFixture.violations.some((item) => item.code === 'SOTER_PROVIDER_FIXTURE_CONTEXT')) {
      failures.push('planted invalid project-work policy field was not detected');
    }
    const invalidProjectFixture = JSON.parse(originalProviderFixtureText);
    invalidProjectFixture.data.records
      .find((record) => record.type === 'project')
      .fields.taskUris = 'not-a-list';
    fs.writeFileSync(providerFixtureFile, JSON.stringify(invalidProjectFixture, null, 2) + '\n');
    const badProjectFixture = verifySoter(temp);
    if (!badProjectFixture.violations.some((item) => item.code === 'SOTER_PROVIDER_FIXTURE_CONTEXT')) {
      failures.push('planted invalid project task relation list was not detected');
    }
    const invalidDateFixture = JSON.parse(originalProviderFixtureText);
    invalidDateFixture.data.records
      .find((record) => record.id === 'soter-fixture://tasks/task/existing-deck')
      .fields.nextActionOn = '2026-02-30';
    fs.writeFileSync(providerFixtureFile, JSON.stringify(invalidDateFixture, null, 2) + '\n');
    const badDateFixture = verifySoter(temp);
    if (!badDateFixture.violations.some((item) => item.code === 'SOTER_PROVIDER_FIXTURE_CONTEXT')) {
      failures.push('planted impossible task calendar date was not detected');
    }
    fs.writeFileSync(providerFixtureFile, originalProviderFixtureText);

    const documentFixtureFile = path.join(
      temp,
      'soter',
      'fixtures',
      'providers',
      'notion',
      'documents.json'
    );
    const originalDocumentFixtureText = fs.readFileSync(documentFixtureFile, 'utf8');
    const invalidDocumentFixture = JSON.parse(originalDocumentFixtureText);
    invalidDocumentFixture.data.records[0].fields.categories = 'not-a-list';
    fs.writeFileSync(documentFixtureFile, JSON.stringify(invalidDocumentFixture, null, 2) + '\n');
    const badDocumentFixture = verifySoter(temp);
    if (!badDocumentFixture.violations.some((item) => {
      return item.code === 'SOTER_PROVIDER_FIXTURE_CONTEXT';
    })) {
      failures.push('planted invalid Documents record fixture bypassed generic Context validation');
    }
    fs.writeFileSync(documentFixtureFile, originalDocumentFixtureText);

    const restoredConfig = JSON.parse(originalConfigText);
    const badBindingConfig = structuredClone(restoredConfig);
    const configBinding = badBindingConfig.bindings[0];
    configBinding.providerPack = 'integration.missing';
    fs.writeFileSync(configFile, JSON.stringify(badBindingConfig, null, 2) + '\n');
    const badBinding = verifySoter(temp);
    if (!badBinding.violations.some((item) => item.code === 'SOTER_BINDING')) {
      failures.push('planted missing provider binding was not detected');
    }

    badBindingConfig.host.adapter = 'host.missing';
    fs.writeFileSync(configFile, JSON.stringify(badBindingConfig, null, 2) + '\n');
    const badHost = verifySoter(temp);
    if (!badHost.violations.some((item) => item.code === 'SOTER_HOST')) {
      failures.push('planted missing host adapter was not detected');
    }

    fs.writeFileSync(path.join(temp, 'soter', 'capabilities', 'broken.json'), '{ broken');
    const badJson = verifySoter(temp);
    if (!badJson.violations.some((item) => item.code === 'SOTER_JSON')) {
      failures.push('planted malformed JSON was not detected');
    }

    fs.writeFileSync(
      path.join(temp, 'soter', 'capabilities', 'unknown.json'),
      JSON.stringify({ $contract: 'soter://contracts/unknown/v1' }) + '\n'
    );
    const unknownContract = verifySoter(temp);
    if (!unknownContract.violations.some((item) => item.code === 'SOTER_CONTRACT')) {
      failures.push('planted unknown contract was not detected');
    }

    fs.writeFileSync(
      path.join(temp, 'soter', 'capabilities', 'invalid-known.json'),
      JSON.stringify({ $contract: 'soter://contracts/capability/v1' }) + '\n'
    );
    const invalidKnown = verifySoter(temp);
    if (!invalidKnown.violations.some((item) => item.code === 'SOTER_SCHEMA')) {
      failures.push('planted known but malformed contract was not detected');
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  if (failures.length) {
    failures.forEach((failure) => console.error('SELFTEST FAIL: ' + failure));
    return false;
  }
  console.log('SELFTEST PASS: schema vocabulary, composition, conditionals, bounds, deep uniqueness, version, clean graph, definition-only workflow authority and identity, exact active workflow host-evidence joins and run coverage, prepared-work, acquisition, and proposal ownership, acquisition capability and record coverage, pack settings and acquisition-required targets, portable sources, Context record model, provider mapping and configured choice-value translation, native host tool, binding, host, lock host selection, exact evidence applicability, malformed JSON, unknown-contract, and malformed-contract checks fired as expected.');
  return true;
}

const argv = process.argv.slice(2);
const rootIndex = argv.indexOf('--root');
const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : defaultRoot;
const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptFile);

if (isDirect) {
  if (argv.includes('--selftest')) {
    process.exit(selftest(root) ? 0 : 1);
  }
  const verification = verifySoter(root);
  report(verification, argv.includes('--json'));
  process.exit(verification.health.valid === 'passed' ? 0 : 1);
}
