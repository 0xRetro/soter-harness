import fs from 'node:fs';
import path from 'node:path';

import {
  contextRecordInputErrors,
  contextRecordOutputErrors
} from '../kernel/verify.mjs';
import { fingerprintJson, readJson } from './lib/canonical-json.mjs';

function walkJson(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJson(target);
    return entry.name.endsWith('.json') ? [target] : [];
  });
}

export function listContextRecordModels(root) {
  return walkJson(path.join(root, 'soter', 'contexts'))
    .sort()
    .map((file) => readJson(file))
    .filter((document) => {
      return document.$contract === 'soter://contracts/context-record-model/v1';
    });
}

function assertValid(failures, label) {
  if (!failures.length) return true;
  const error = new Error(label + ' does not satisfy its Context record model: '
    + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; '));
  error.kind = 'validation';
  throw error;
}

function selectedModels(root, options) {
  const models = listContextRecordModels(root);
  if (!options.packIds) return models;
  const selected = new Set(options.packIds);
  return models.filter((model) => selected.has(model.pack));
}

function validationOptions(options) {
  return options.modelId ? { modelId: options.modelId } : {};
}

export function assertContextRecordInput(root, capability, input, options = {}) {
  return assertValid(
    contextRecordInputErrors(
      selectedModels(root, options),
      capability,
      input,
      validationOptions(options)
    ),
    'Portable record input'
  );
}

export function assertContextRecordOutput(root, capability, output, options = {}) {
  return assertValid(
    contextRecordOutputErrors(
      selectedModels(root, options),
      capability,
      output,
      validationOptions(options)
    ),
    'Portable record output'
  );
}

export function exactRequestedContextRecord(output, {
  recordType,
  requestedId
}) {
  if (typeof recordType !== 'string' || !recordType
    || typeof requestedId !== 'string' || !requestedId
    || !Array.isArray(output?.records)) {
    const error = new Error(
      'Exact portable record selection requires one record type, one requested identity, and a records output.'
    );
    error.kind = 'validation';
    throw error;
  }
  const matches = output.records.filter((record) => record?.type === recordType);
  if (output.records.length !== 1 || matches.length !== 1) {
    const error = new Error(
      'Exact portable record selection did not return exactly one record of the requested type.'
    );
    error.kind = 'validation';
    throw error;
  }
  const record = matches[0];
  if (typeof record.id !== 'string' || !record.id
    || record.identityBinding?.state !== 'exact-request'
    || record.identityBinding.requestedIdFingerprint !== fingerprintJson(requestedId)) {
    const error = new Error(
      'Exact portable record selection is not bound to the requested identity.'
    );
    error.kind = 'validation';
    throw error;
  }
  return record;
}
