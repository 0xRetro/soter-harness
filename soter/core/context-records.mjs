import fs from 'node:fs';
import path from 'node:path';

import {
  contextRecordInputErrors,
  contextRecordOutputErrors
} from '../kernel/verify.mjs';
import { readJson } from './lib/canonical-json.mjs';

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
    'Portable CRM input'
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
    'Portable CRM output'
  );
}
