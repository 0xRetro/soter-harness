#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRecordCapability } from './record-capabilities.mjs';
import { inspectTrackedConfigurationTemplates } from './configuration-template-portability.mjs';
import {
  workflowGuideContentFingerprintMatches
} from './workflow-guides.mjs';
import {
  fingerprintPrivateContainedBasis,
  fingerprintPrivateContainedLockProjection
} from './private-contained-evidence.mjs';

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

// Directory listings are cached per (mtime, inode) for the life of the process.
// One scan enumerates the same tree many times over. Creating or removing an
// entry changes the directory mtime, so a selftest that adds or deletes a file
// still observes its own change.
const directoryEntries = new Map();

function listDirectory(dir) {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return null;
  }
  const identity = stat.mtimeMs + ':' + stat.ino;
  const cached = directoryEntries.get(dir);
  if (cached && cached.identity === identity) return cached.entries;
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
  directoryEntries.set(dir, { identity, entries });
  return entries;
}

function walkFiles(dir, predicate) {
  const found = [];
  const entries = listDirectory(dir);
  if (entries === null) return found;
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.directory) found.push(...walkFiles(file, predicate));
    else if (predicate(file)) found.push(file);
  }
  return found;
}

// Parsed documents are cached per (mtime, size, inode) for the life of the
// process, for the same reason directory listings are. A selftest that
// deliberately rewrites a file still invalidates its own entry because the
// stat identity changes.
const parsedDocuments = new Map();

function parseJson(file, out) {
  try {
    const stat = fs.statSync(file);
    const identity = stat.mtimeMs + ':' + stat.size + ':' + stat.ino;
    const cached = parsedDocuments.get(file);
    if (cached && cached.identity === identity) return cached.value;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsedDocuments.set(file, { identity, value });
    return value;
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

function schemaObjectsAreClosed(value) {
  if (Array.isArray(value)) return value.every(schemaObjectsAreClosed);
  if (!value || typeof value !== 'object') return true;
  if (value.type === 'object' && value.additionalProperties !== false) return false;
  return Object.values(value).every(schemaObjectsAreClosed);
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
        const acquisitionExports = [
          acquisition.prepareExport,
          acquisition.finalizeExport,
          acquisition.inspectExport,
          acquisition.privateInspectExport
        ].filter(Boolean);
        if (new Set(acquisitionExports).size !== acquisitionExports.length) {
          out.push(violation(
            entry.file,
            'SOTER_ACQUISITION_EXPORT_IDENTITY',
            'connected-acquisition prepare, finalize, and inspection exports must be distinct',
            'Core dispatches only the exact operation named by the current governed pack',
            'give every declared connected-acquisition operation one distinct module export'
          ));
        }
        if (acquisition.privateInspectExport && !acquisition.inspectExport) {
          out.push(violation(
            entry.file,
            'SOTER_ACQUISITION_INSPECTION_BOUNDARY',
            'private selected-work inspection requires a paired sanitized inspection export',
            'private review must supplement rather than replace the ordinary sanitized projection',
            'declare the sanitized inspectExport or remove privateInspectExport'
          ));
        }
        for (const [kind, exportKey, schemaKey] of [
          ['sanitized', 'inspectExport', 'inspectSchema'],
          ['private selected-work', 'privateInspectExport', 'privateInspectSchema']
        ]) {
          const exportName = acquisition[exportKey];
          const schemaPath = acquisition[schemaKey];
          if (Boolean(exportName) !== Boolean(schemaPath)) {
            out.push(violation(
              entry.file,
              'SOTER_ACQUISITION_INSPECTION_SCHEMA_BINDING',
              kind + ' acquisition inspector does not declare one exact paired schema',
              'generic Core dispatch can enforce a pack-owned projection only when its export and closed schema are paired',
              'declare both ' + exportKey + ' and ' + schemaKey + ' or remove both'
            ));
            continue;
          }
          if (!schemaPath) continue;
          const schemaArtifact = entry.doc.artifacts.find((artifact) => {
            return artifact.path === schemaPath && artifact.role === 'definition';
          });
          const schemaFile = path.resolve(root, schemaPath);
          let schema = null;
          try {
            schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
          } catch {
            schema = null;
          }
          if (!schemaArtifact || !schema || typeof schema.$id !== 'string'
            || schema.type !== 'object' || schema.additionalProperties !== false
            || !schemaObjectsAreClosed(schema)) {
            out.push(violation(
              entry.file,
              'SOTER_ACQUISITION_INSPECTION_SCHEMA',
              kind + ' acquisition inspection schema is absent, unowned, malformed, or open: '
                + schemaPath,
              'pack-owned inspection must be mechanically closed before generic Core can return it',
              'declare one valid definition artifact whose every object sets additionalProperties false'
            ));
          }
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
          'choose compatible versions or prepare an explicit upgrade'
        ));
      }
    }
  }
  detectDependencyCycles(packs, out);
  checkActiveWorkflows(
    root,
    workflowDefinitions,
    workflowEvaluationSets,
    workflowGuides,
    packs,
    documentsByPath,
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
    checkScenario(root, scenario, packs, capabilities, configs, out);
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

function checkActiveWorkflows(
  root,
  workflowDefinitions,
  workflowEvaluationSets,
  workflowGuides,
  packs,
  documentsByPath,
  out
) {
  const evaluationOwners = new Map();
  const guideOwners = new Map();

  for (const [id, entry] of workflowDefinitions) {
    const slug = id.slice('automation.'.length);
    const definitionPath = 'soter/automations/' + slug + '/definition.json';
    const evaluationPath = 'soter/automations/' + slug + '/evaluations.json';
    const guidePath = 'soter/automations/' + slug + '/guide.json';
    const expectedDefinitionFile = path.resolve(root, definitionPath);
    const pack = packs.get(id);
    const evaluationEntry = workflowEvaluationSets.get(entry.doc.evaluationSet.id);
    const guideId = 'workflow-guide.' + slug;
    const guideEntry = workflowGuides.get(guideId);

    if (path.resolve(entry.file) !== expectedDefinitionFile) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_DEFINITION_PATH',
        'active workflow is not stored at ' + definitionPath,
        'one canonical Automation path keeps workflow discovery independent of host projections',
        'move the definition to its canonical workflow directory'
      ));
    }
    if (!pack) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_PACK',
        'active workflow has no exact Automation pack ' + id,
        'workflow ownership and distribution require one declared pack',
        'add the matching Automation pack or remove the unowned workflow'
      ));
      continue;
    }

    const expectedArtifacts = [
      { path: definitionPath, role: 'definition' },
      { path: evaluationPath, role: 'evaluation' },
      { path: guidePath, role: 'definition' }
    ];
    for (const expectedArtifact of expectedArtifacts) {
      const owners = pack.doc.artifacts.filter((artifact) => {
        return artifact.path === expectedArtifact.path && artifact.role === expectedArtifact.role;
      });
      if (owners.length !== 1) {
        out.push(violation(
          pack.file,
          'SOTER_WORKFLOW_ARTIFACT',
          'active workflow pack must own exactly one ' + expectedArtifact.role
            + ' artifact at ' + expectedArtifact.path,
          'undeclared or duplicate workflow artifacts can drift outside one exact pack graph',
          'declare the exact path once with the ' + expectedArtifact.role + ' role'
        ));
      }
    }

    if (!evaluationEntry
      || path.resolve(evaluationEntry.file) !== path.resolve(root, evaluationPath)
      || entry.doc.evaluationSet.path !== evaluationPath
      || evaluationEntry.doc.workflow !== id
      || evaluationEntry.doc.version !== entry.doc.version) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_EVALUATION_BINDING',
        'workflow definition does not bind one exact matching evaluation set',
        'behavior expectations must version and move with the workflow definition they constrain',
        'align the evaluation path, id, workflow id, and version'
      ));
    } else {
      const owners = evaluationOwners.get(evaluationEntry.doc.id) || [];
      owners.push(id);
      evaluationOwners.set(evaluationEntry.doc.id, owners);
    }

    if (!guideEntry) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_GUIDE_BINDING',
        'active workflow has no exact provider-neutral guide ' + guideId,
        'host delivery requires one canonical guide owned by the workflow pack',
        'add the exact guide or remove the incomplete workflow selection'
      ));
      continue;
    }
    const guideOwnerIds = guideOwners.get(guideId) || [];
    guideOwnerIds.push(id);
    guideOwners.set(guideId, guideOwnerIds);

    if (path.resolve(guideEntry.file) !== path.resolve(root, guidePath)
      || guideEntry.doc.workflow.id !== id
      || guideEntry.doc.workflow.version !== entry.doc.version
      || guideEntry.doc.workflow.definitionPath !== definitionPath
      || guideEntry.doc.workflow.definitionFingerprint !== fingerprintJson(entry.doc)
      || guideEntry.doc.workflow.evaluationSetPath !== evaluationPath
      || !evaluationEntry
      || guideEntry.doc.workflow.evaluationSetFingerprint !== fingerprintJson(evaluationEntry.doc)
      || guideEntry.doc.skill.name !== slug
      || entry.doc.guide.id !== guideId
      || entry.doc.guide.path !== guidePath) {
      out.push(violation(
        guideEntry.file,
        'SOTER_WORKFLOW_GUIDE_BINDING',
        'workflow guide does not bind the exact definition, evaluation set, version, path, and skill identity',
        'procedural guidance must move with the exact workflow behavior it explains',
        'align every workflow, evaluation, guide, version, path, and canonical JSON fingerprint'
      ));
    }

    if (!workflowGuideContentFingerprintMatches(guideEntry.doc)) {
      out.push(violation(
        guideEntry.file,
        'SOTER_WORKFLOW_GUIDE_CONTENT_FINGERPRINT',
        'workflow guide content fingerprint does not seal its provider-neutral semantics',
        'host projections require deterministic reviewable guide content',
        'recompute contentFingerprint with contentFingerprint and status excluded'
      ));
    }

    const development = entry.doc.lifecycle.development;
    const settings = documentsByPath.get(path.resolve(root, development.workspacePolicy.path));
    const lifecycleAligned = entry.doc.lifecycle.state === 'active-host-guided'
      && entry.doc.lifecycle.reasonCode === 'WORKFLOW_HOST_GUIDANCE_ACTIVE'
      && entry.doc.lifecycle.delivery === 'host-skill'
      && guideEntry.doc.status.state === 'active'
      && guideEntry.doc.status.delivery === 'host-skill'
      && evaluationEntry?.doc.lifecycle.state === 'active-host-guided'
      && development.requestContract.id === 'soter://contracts/development-request/v1'
      && development.requestContract.path === 'soter/contracts/development-request.schema.json'
      && development.resultContract.id === 'soter://contracts/development-result/v1'
      && development.resultContract.path === 'soter/contracts/development-result.schema.json'
      && development.workspacePolicy.path === 'soter/kernel/development-workspace.settings.json'
      && development.workspacePolicy.fingerprint === fingerprintJson(settings?.doc)
      && deepEqual([...development.supportedHosts].sort(), ['claude', 'codex'])
      && evaluationEntry.doc.evaluationPolicy.requestContract.id === development.requestContract.id
      && evaluationEntry.doc.evaluationPolicy.resultContract.id === development.resultContract.id
      && deepEqual([...evaluationEntry.doc.evaluationPolicy.supportedHosts].sort(), ['claude', 'codex']);
    if (!lifecycleAligned) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_LIFECYCLE_BINDING',
        'workflow definition, guide, evaluation, or development contract binding disagrees',
        'host delivery and behavior evidence require one present-tense closed lifecycle',
        'align the active lifecycle, selected hosts, workspace policy, and request/result contracts'
      ));
    }

    const procedureIdentity = entry.doc.procedure.map(({ id: stepId, sequence }) => ({
      id: stepId,
      sequence
    }));
    const guideIdentity = guideEntry.doc.stepDetails.map(({ id: stepId, sequence }) => ({
      id: stepId,
      sequence
    }));
    const expectedProcedureSequence = procedureIdentity.map((_item, index) => index + 1);
    if (new Set(procedureIdentity.map((item) => item.id)).size !== procedureIdentity.length
      || !deepEqual(procedureIdentity.map((item) => item.sequence), expectedProcedureSequence)
      || !deepEqual(guideIdentity, procedureIdentity)
      || new Set(guideEntry.doc.gotchas.map((item) => item.id)).size !== guideEntry.doc.gotchas.length
      || new Set(guideEntry.doc.references.map((item) => item.id)).size !== guideEntry.doc.references.length) {
      out.push(violation(
        guideEntry.file,
        'SOTER_WORKFLOW_GUIDE_PROCEDURE',
        'workflow steps, guide steps, gotchas, or references are duplicated or misaligned',
        'stable ordered identities are required for deterministic host projection and review',
        'use unique contiguous workflow steps and unique guide gotcha and reference identities'
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
        'SOTER_WORKFLOW_GUIDE_AUTHORITY',
        'host-guided workflow pack declares runtime, effect, authority, maturity, or executable-scenario semantics',
        'procedural guidance cannot grant execution or effect authority',
        'remove runtime declarations and keep effects request-scoped through Core'
      ));
    }
  }

  for (const [id, entry] of workflowEvaluationSets) {
    const owners = evaluationOwners.get(id) || [];
    const owner = workflowDefinitions.get(entry.doc.workflow);
    const caseIds = entry.doc.cases.map((item) => item.id);
    const sequence = entry.doc.cases.map((item) => item.sequence);
    const expectedSequence = entry.doc.cases.map((_item, index) => index + 1);
    const kinds = new Set(entry.doc.cases.map((item) => item.kind));
    if (owners.length !== 1) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_EVALUATION_OWNER',
        'workflow evaluation set has ' + owners.length + ' exact workflow owners',
        'unowned or shared behavior expectations create ambiguous Automation authority',
        'bind the evaluation set from exactly one matching workflow definition'
      ));
    }
    if (new Set(caseIds).size !== caseIds.length
      || !deepEqual(sequence, expectedSequence)
      || !kinds.has('happy-path')
      || !kinds.has('pressure')
      || !kinds.has('invariant')
      || entry.doc.cases.length < 3
      || entry.doc.evaluationPolicy.freshWorkerPerCase !== true
      || entry.doc.evaluationPolicy.expectationsWithheld !== true
      || entry.doc.evaluationPolicy.baselineRequired !== true
      || !owner) {
      out.push(violation(
        entry.file,
        'SOTER_WORKFLOW_EVALUATION_COVERAGE',
        'active evaluation set lacks unique contiguous cases, happy-path, pressure, invariant, fresh-worker, withheld-expectation, or baseline coverage',
        'behavior claims require observable normal and adversarial evidence rather than schema validity or self-report',
        'restore the missing case kinds and exact evaluation policy'
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
    const selectedHost = hosts.get(entry.doc.host.adapter);
    if (entry.doc.configuration.hostSelection.id !== entry.doc.host.id
      || !selectedHost
      || selectedHost.doc.host !== entry.doc.host.id
      || selectedHost.doc.version !== entry.doc.host.version
      || fingerprintJson(selectedHost.doc) !== entry.doc.host.manifestFingerprint) {
      out.push(violation(
        entry.file,
        'SOTER_LOCK_HOST_SELECTION',
        'lock host selection, adapter identity, version, or manifest fingerprint disagree',
        'a portable configuration must bind one exact reproducible host realization',
        'resolve the configuration again for the intended compatible host'
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
      const fieldBindingScopeCount
        = privateContainedBasis.substitutions.notionFieldBindingScopeCount;
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
            : optionEntryCount < optionScopeCount)
          || fieldBindingScopeCount < 1)) {
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
  configured,
  selected,
  packs,
  providerMappings
) {
  const requiredScopes = new Set();
  const unavailableFields = new Set((configured?.fieldBindings || [])
    .filter((binding) => binding?.state === 'unavailable')
    .map((binding) => [
      binding.mapping,
      binding.recordType,
      binding.field
    ].join('|')));
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
          const scope = [
            records[0].mapping.id,
            records[0].record.id,
            field.portable
          ].join('|');
          if (!unavailableFields.has(scope)) requiredScopes.add(scope);
        }
      }
    }
  }
  return requiredScopes;
}

function configuredFieldBindingRequirementScopes(
  configurationEntry,
  settingsDefinition,
  configured,
  selected,
  packs,
  providerMappings
) {
  const requiredScopes = new Map();
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
            .map((record) => ({ mapping, record }));
        });
        if (records.length !== 1) continue;
        const target = configured?.targets?.[records[0].record.target];
        if (typeof target !== 'string' || !target.startsWith('collection://')) {
          continue;
        }
        for (const field of records[0].record.fields) {
          const scope = [
            records[0].mapping.doc.id,
            records[0].record.id,
            field.portable
          ].join('|');
          const existing = requiredScopes.get(scope) || {
            mapping: records[0].mapping,
            record: records[0].record,
            field,
            capabilities: new Set()
          };
          existing.capabilities.add(requirement.capability);
          requiredScopes.set(scope, existing);
        }
      }
    }
  }
  return requiredScopes;
}

function checkConfiguredFieldBindings(
  configurationEntry,
  settingsDefinition,
  configured,
  selected,
  packs,
  contextModels,
  providerMappings,
  out
) {
  const requiredScopes = configuredFieldBindingRequirementScopes(
    configurationEntry,
    settingsDefinition,
    configured,
    selected,
    packs,
    providerMappings
  );
  const declarations = configured?.fieldBindings;
  const connectedTargets = Object.values(configured?.targets || {}).some((target) => {
    return typeof target === 'string' && target.startsWith('collection://');
  });
  if (declarations === undefined) {
    if (connectedTargets && requiredScopes.size > 0) {
      out.push(violation(
        configurationEntry.file,
        'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
        'settings.' + settingsDefinition.doc.pack
          + ' omits private provider field bindings for selected connected Automation records',
        'connected provider targets cannot assume workspace property names or optional property availability',
        'configure every selected record field as exactly mapped or explicitly unavailable'
      ));
    }
    return;
  }
  if (!Array.isArray(declarations)) return;
  const scopes = new Set();
  const providerFields = new Map();
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
    const contextModel = mapping
      ? contextModels.get(mapping.doc.contextModel)
      : null;
    const records = mapping?.doc.recordTypes?.filter((record) => {
      return record.id === declaration.recordType;
    }) || [];
    const fields = records.flatMap((record) => {
      return record.fields.filter((field) => field.portable === declaration.field);
    });
    const contextRecords = contextModel?.doc.recordTypes?.filter((record) => {
      return record.id === declaration.recordType;
    }) || [];
    const contextFields = contextRecords.flatMap((record) => {
      return record.fields.filter((field) => field.id === declaration.field);
    });
    const target = records.length === 1
      ? configured?.targets?.[records[0].target]
      : null;
    if (!mapping
      || mapping.doc.settingsDefinition !== settingsDefinition.doc.id
      || !selected.has(mapping.doc.pack)
      || !contextModel
      || !selected.has(contextModel.doc.pack)
      || records.length !== 1
      || fields.length !== 1
      || contextRecords.length !== 1
      || contextFields.length !== 1
      || typeof target !== 'string'
      || !target.startsWith('collection://')) {
      out.push(violation(
        configurationEntry.file,
        'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
        'settings.' + settingsDefinition.doc.pack
          + ' field-binding scope does not resolve one selected portable provider field: '
          + scope,
        'private provider field bindings must bind one selected Integration field and its Context meaning',
        'select the owning Context and mapping or correct the record and portable field identity'
      ));
    }
    if (scopes.has(scope)) {
      out.push(violation(
        configurationEntry.file,
        'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
        'settings.' + settingsDefinition.doc.pack
          + ' contains a duplicate provider field-binding scope: ' + scope,
        'one portable provider field must resolve through one private binding state',
        'remove the duplicate field-binding scope'
      ));
    }
    scopes.add(scope);
    if (declaration.state === 'mapped') {
      const recordScope = [declaration.mapping, declaration.recordType].join('|');
      if (!providerFields.has(recordScope)) providerFields.set(recordScope, new Set());
      if (providerFields.get(recordScope).has(declaration.provider)) {
        out.push(violation(
          configurationEntry.file,
          'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
          'settings.' + settingsDefinition.doc.pack
            + ' maps multiple portable fields to one provider property: '
            + recordScope + '|' + declaration.provider,
          'one provider property cannot normalize into multiple portable meanings in the same record',
          'map each portable field to one unique provider property'
        ));
      }
      providerFields.get(recordScope).add(declaration.provider);
    }
    const createBound = records[0]?.capabilities?.some((capability) => {
      return parseRecordCapability(capability)?.operation === 'create'
        && configurationEntry.doc.bindings.some((binding) => {
          return binding.capability === capability
            && binding.providerPack === mapping?.doc.pack;
        });
    });
    if (declaration.state === 'unavailable'
      && requiredScopes.has(scope)
      && contextFields[0]?.nullable === false) {
      out.push(violation(
        configurationEntry.file,
        'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
        'settings.' + settingsDefinition.doc.pack
          + ' marks a selected Context-non-nullable field unavailable: ' + scope,
        'a selected connected read cannot normalize a record whose required identity or value is structurally absent',
        'map the required provider property or remove the Automation record requirement'
      ));
    } else if (declaration.state === 'unavailable'
      && contextFields[0]?.requiredOnCreate
      && createBound) {
      out.push(violation(
        configurationEntry.file,
        'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
        'settings.' + settingsDefinition.doc.pack
          + ' marks a Context-required create field unavailable: ' + scope,
        'a selected create route must preserve every Context-required create value',
        'map the required provider property or remove the create binding'
      ));
    }
  }
  if (declarations.length > 0) {
    for (const scope of requiredScopes.keys()) {
      if (scopes.has(scope)) continue;
      out.push(violation(
        configurationEntry.file,
        'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
        'settings.' + settingsDefinition.doc.pack
          + ' omits a required connected Automation field-binding scope: ' + scope,
        'every selected connected record field must be explicitly mapped or unavailable',
        'add the complete field-binding scope before activating the private target'
      ));
    }
  }
}

function checkPackSettingSemanticInvariants(
  configurationEntry,
  settingsDefinition,
  configured,
  selected,
  packs,
  providerMappings,
  contextModels,
  out
) {
  for (const invariant of settingsDefinition.doc.semanticInvariants || []) {
    if (invariant === 'provider-field-bindings-explicit') {
      checkConfiguredFieldBindings(
        configurationEntry,
        settingsDefinition,
        configured,
        selected,
        packs,
        contextModels,
        providerMappings,
        out
      );
      continue;
    }
    if (invariant !== 'option-mappings-exact-bijection') continue;
    const requiredScopes = configuredOptionMappingRequirementScopes(
      configurationEntry,
      settingsDefinition,
      configured,
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
    const unavailableFieldScopes = new Set((configured?.fieldBindings || [])
      .filter((binding) => binding?.state === 'unavailable')
      .map((binding) => [
        binding.mapping,
        binding.recordType,
        binding.field
      ].join('|')));
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
      if (unavailableFieldScopes.has(scope)) {
        out.push(violation(
          configurationEntry.file,
          'SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT',
          'settings.' + settingsDefinition.doc.pack
            + ' maps provider option values for an explicitly unavailable field: ' + scope,
          'an unavailable provider property cannot also carry an inert or reusable private option vocabulary',
          'remove the option-mapping scope or map the provider field explicitly'
        ));
      }
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
        contextModels,
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

function checkScenario(root, entry, packs, capabilities, configs, out) {
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

    const workflowBase = path.join(temp, 'soter', 'automations', 'running-evals');
    const workflowFile = path.join(workflowBase, 'definition.json');
    const evaluationFile = path.join(workflowBase, 'evaluations.json');
    const guideFile = path.join(workflowBase, 'guide.json');
    const workflowPackFile = path.join(temp, 'soter', 'packs', 'automation.running-evals', 'pack.json');
    const originalWorkflowText = fs.readFileSync(workflowFile, 'utf8');
    const originalEvaluationText = fs.readFileSync(evaluationFile, 'utf8');
    const originalGuideText = fs.readFileSync(guideFile, 'utf8');
    const originalWorkflowPackText = fs.readFileSync(workflowPackFile, 'utf8');

    const runtimeClaimingPack = JSON.parse(originalWorkflowPackText);
    runtimeClaimingPack.operator = { input: 'soter/automations/project-pulse/operator-input.json' };
    fs.writeFileSync(workflowPackFile, JSON.stringify(runtimeClaimingPack, null, 2) + '\n');
    if (!verifySoter(temp).violations.some((item) => item.code === 'SOTER_WORKFLOW_GUIDE_AUTHORITY')) {
      failures.push('host-guided workflow accepted a planted operator runtime declaration');
    }
    fs.writeFileSync(workflowPackFile, originalWorkflowPackText);

    const gappedProcedure = JSON.parse(originalWorkflowText);
    gappedProcedure.procedure[1].sequence += 1;
    fs.writeFileSync(workflowFile, JSON.stringify(gappedProcedure, null, 2) + '\n');
    if (!verifySoter(temp).violations.some((item) => item.code === 'SOTER_WORKFLOW_GUIDE_PROCEDURE')) {
      failures.push('active workflow accepted a gapped procedure sequence');
    }
    fs.writeFileSync(workflowFile, originalWorkflowText);

    const mismatchedEvaluation = JSON.parse(originalWorkflowText);
    mismatchedEvaluation.evaluationSet.id = 'evaluation-set.missing-workflow';
    fs.writeFileSync(workflowFile, JSON.stringify(mismatchedEvaluation, null, 2) + '\n');
    if (!verifySoter(temp).violations.some((item) => item.code === 'SOTER_WORKFLOW_EVALUATION_BINDING')) {
      failures.push('active workflow accepted a mismatched evaluation binding');
    }
    fs.writeFileSync(workflowFile, originalWorkflowText);

    const duplicateEvaluation = JSON.parse(originalEvaluationText);
    duplicateEvaluation.cases[1].id = duplicateEvaluation.cases[0].id;
    fs.writeFileSync(evaluationFile, JSON.stringify(duplicateEvaluation, null, 2) + '\n');
    if (!verifySoter(temp).violations.some((item) => item.code === 'SOTER_WORKFLOW_EVALUATION_COVERAGE')) {
      failures.push('active workflow accepted duplicate evaluation identity');
    }
    fs.writeFileSync(evaluationFile, originalEvaluationText);

    const staleGuide = JSON.parse(originalGuideText);
    staleGuide.workflow.definitionFingerprint = 'sha256:' + 'f'.repeat(64);
    fs.writeFileSync(guideFile, JSON.stringify(staleGuide, null, 2) + '\n');
    if (!verifySoter(temp).violations.some((item) => item.code === 'SOTER_WORKFLOW_GUIDE_BINDING')) {
      failures.push('active workflow accepted a stale guide binding');
    }
    fs.writeFileSync(guideFile, originalGuideText);

    const tamperedGuide = JSON.parse(originalGuideText);
    tamperedGuide.verification[0] = 'Tampered guide verification statement.';
    fs.writeFileSync(guideFile, JSON.stringify(tamperedGuide, null, 2) + '\n');
    if (!verifySoter(temp).violations.some((item) => item.code === 'SOTER_WORKFLOW_GUIDE_CONTENT_FINGERPRINT')) {
      failures.push('active workflow accepted guide content outside its semantic fingerprint');
    }
    fs.writeFileSync(guideFile, originalGuideText);

    const mismatchedGuideProcedure = JSON.parse(originalGuideText);
    mismatchedGuideProcedure.stepDetails[1].id = 'different-valid-step';
    fs.writeFileSync(guideFile, JSON.stringify(mismatchedGuideProcedure, null, 2) + '\n');
    if (!verifySoter(temp).violations.some((item) => item.code === 'SOTER_WORKFLOW_GUIDE_PROCEDURE')) {
      failures.push('active workflow accepted a guide procedure mismatch');
    }
    fs.writeFileSync(guideFile, originalGuideText);

    const guideOmittingPack = JSON.parse(originalWorkflowPackText);
    guideOmittingPack.artifacts = guideOmittingPack.artifacts.filter((artifact) => {
      return artifact.path !== 'soter/automations/running-evals/guide.json';
    });
    fs.writeFileSync(workflowPackFile, JSON.stringify(guideOmittingPack, null, 2) + '\n');
    if (!verifySoter(temp).violations.some((item) => item.code === 'SOTER_WORKFLOW_ARTIFACT')) {
      failures.push('active workflow accepted an undeclared guide artifact');
    }
    fs.writeFileSync(workflowPackFile, originalWorkflowPackText);

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

    const duplicateTaskAcquisitionExport = JSON.parse(originalTaskPackText);
    duplicateTaskAcquisitionExport.operator.acquisition.finalizeExport =
      duplicateTaskAcquisitionExport.operator.acquisition.prepareExport;
    fs.writeFileSync(
      taskPackFile,
      JSON.stringify(duplicateTaskAcquisitionExport, null, 2) + '\n'
    );
    const duplicateTaskAcquisitionExportResult = verifyConfigurationCandidate(temp, {
      configPath: taskConfigurationFile,
      configuration: JSON.parse(taskConfigurationText)
    });
    if (!duplicateTaskAcquisitionExportResult.violations.some((item) => {
      return item.code === 'SOTER_ACQUISITION_EXPORT_IDENTITY';
    })) {
      failures.push('Task Capture accepted duplicate connected-acquisition export identities');
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
      failures.push('generated evidence fixture does not use evidence/v2');
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

    const outdatedProviderMapping = JSON.parse(originalMappingText);
    outdatedProviderMapping.$contract = 'soter://contracts/provider-mapping/v3';
    outdatedProviderMapping.contractVersion = '3.0.0';
    fs.writeFileSync(mappingFile, JSON.stringify(outdatedProviderMapping, null, 2) + '\n');
    const badOutdatedProviderMapping = verifySoter(temp);
    if (!badOutdatedProviderMapping.violations.some((item) => {
      return item.code === 'SOTER_CONTRACT';
    })) {
      failures.push('planted unsupported provider-mapping/v3 contract was not rejected');
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
  console.log('SELFTEST PASS: schema vocabulary, composition, conditionals, bounds, deep uniqueness, version, clean graph, active workflow identity and behavior coverage, prepared-work, acquisition, proposal ownership, pack settings, portable sources, Context models, provider mapping, native host tools, bindings, locks, evidence applicability, malformed JSON, unknown-contract, and malformed-contract checks fired as expected.');
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
