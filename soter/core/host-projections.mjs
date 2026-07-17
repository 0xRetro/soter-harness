import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath,
  sha256
} from './lib/canonical-json.mjs';

export const HOST_PROJECTION_GENERATOR_ID = 'core.host-projection-generator';
export const HOST_PROJECTION_GENERATOR_VERSION = '1.0.0';

const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CONTEXT_KEYS = new Map([
  ['configuration-id', 'CONFIGURATION_ID'],
  ['host-id', 'HOST_ID'],
  ['pack-ids', 'PACK_IDS'],
  ['capability-ids', 'CAPABILITY_IDS']
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail('HOST_PROJECTION_RENDER_CONTEXT_INVALID', label + ' is not a portable identifier.');
  }
  return value;
}

export function normalizeProjectionPath(value) {
  if (typeof value !== 'string' || !value.length || value.includes('\\')
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value === '.' || value === '..' || value.startsWith('../') || value.includes('/../')) {
    fail('HOST_PROJECTION_PATH_INVALID', 'Host projection paths must be normalized relative paths.');
  }
  return value;
}

function normalizeTemplate(text, finalNewline) {
  let normalized = String(text).replace(/\r\n?/g, '\n');
  if (finalNewline) normalized = normalized.replace(/\n*$/u, '') + '\n';
  return normalized;
}

function list(ids, label) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    fail('HOST_PROJECTION_RENDER_CONTEXT_INVALID', label + ' must be an identifier list.');
  }
  const sorted = [...new Set(ids.map((id) => assertIdentifier(id, label)))].sort(compareText);
  return sorted.length ? sorted.map((id) => '- `' + id + '`').join('\n') : '- None declared.';
}

function renderContext({ configurationId, hostId, packIds, capabilityIds }) {
  return {
    CONFIGURATION_ID: assertIdentifier(configurationId, 'Configuration id'),
    HOST_ID: assertIdentifier(hostId, 'Host id'),
    PACK_IDS: list(packIds, 'Pack ids'),
    CAPABILITY_IDS: list(capabilityIds, 'Capability ids')
  };
}

function renderTemplate(template, allowedContext, values) {
  const allowed = new Set(allowedContext.map((key) => CONTEXT_KEYS.get(key)));
  let saw = false;
  const rendered = template.replace(/{{([A-Z_]+)}}/g, (_match, token) => {
    saw = true;
    if (!allowed.has(token) || !Object.prototype.hasOwnProperty.call(values, token)) {
      fail('HOST_PROJECTION_TEMPLATE_INVALID', 'Host projection template uses an undeclared render token.');
    }
    return values[token];
  });
  if (rendered.includes('{{') || rendered.includes('}}')) {
    fail('HOST_PROJECTION_TEMPLATE_INVALID', 'Host projection template contains an unresolved token.');
  }
  if (!saw && allowedContext.length) {
    fail('HOST_PROJECTION_TEMPLATE_INVALID', 'Host projection template declares render context but uses no token.');
  }
  return rendered;
}

export function loadHostProjectionDefinition({ root, adapter }) {
  const resolvedRoot = path.resolve(root);
  if (!adapter?.projectionDefinition?.path) {
    fail('HOST_PROJECTION_DEFINITION_MISSING', 'Host adapter has no projection definition path.');
  }
  const definitionFile = resolveRepoPath(resolvedRoot, adapter.projectionDefinition.path);
  if (!fs.existsSync(definitionFile) || !fs.statSync(definitionFile).isFile()) {
    fail('HOST_PROJECTION_DEFINITION_MISSING', 'Host projection definition is unavailable.');
  }
  const definition = readJson(definitionFile);
  const schema = readJson(resolveRepoPath(
    resolvedRoot,
    'soter/contracts/host-projection-definition.schema.json'
  ));
  if (validateJsonSchema(definition, schema).length) {
    fail('HOST_PROJECTION_DEFINITION_INVALID', 'Host projection definition does not satisfy its contract.');
  }
  if (definition.host !== adapter.host
    || definition.id !== adapter.projectionDefinition.id
    || definition.version !== adapter.projectionDefinition.version
    || definition.generator.id !== HOST_PROJECTION_GENERATOR_ID
    || definition.generator.version !== HOST_PROJECTION_GENERATOR_VERSION) {
    fail('HOST_PROJECTION_DEFINITION_BINDING_INVALID', 'Host adapter and projection definition disagree.');
  }
  const adapterRows = adapter.projections.map(({ path: outputPath, role }) => ({
    path: normalizeProjectionPath(outputPath),
    role
  })).sort((left, right) => compareText(left.path, right.path));
  const definitionRows = definition.outputs.map(({ path: outputPath, role }) => ({
    path: normalizeProjectionPath(outputPath),
    role
  })).sort((left, right) => compareText(left.path, right.path));
  if (fingerprintJson(adapterRows) !== fingerprintJson(definitionRows)) {
    fail('HOST_PROJECTION_DEFINITION_BINDING_INVALID', 'Host adapter projections do not match the owned definition outputs.');
  }
  const ids = new Set();
  const paths = new Set();
  for (const output of definition.outputs) {
    if (ids.has(output.id) || paths.has(output.path)) {
      fail('HOST_PROJECTION_DEFINITION_INVALID', 'Host projection output identifiers and paths must be unique.');
    }
    ids.add(output.id);
    paths.add(output.path);
    if (!output.template.startsWith('soter/hosts/' + definition.host + '/templates/')) {
      fail('HOST_PROJECTION_DEFINITION_INVALID', 'Host projection template is owned by another host definition.');
    }
    if (!output.renderContext.every((key) => definition.renderContext.includes(key))) {
      fail('HOST_PROJECTION_DEFINITION_INVALID', 'Output render context exceeds the definition render context.');
    }
  }
  return {
    definition,
    definitionFile,
    definitionPath: repoRelativePath(resolvedRoot, definitionFile),
    definitionFingerprint: fingerprintJson(definition)
  };
}

export function renderHostProjectionCandidates({
  root,
  adapter,
  configurationId,
  packIds,
  capabilityIds
}) {
  const resolvedRoot = path.resolve(root);
  const loaded = loadHostProjectionDefinition({ root: resolvedRoot, adapter });
  const values = renderContext({
    configurationId,
    hostId: adapter.host,
    packIds,
    capabilityIds
  });
  const outputs = loaded.definition.outputs.map((output) => {
    const templateFile = resolveRepoPath(resolvedRoot, output.template);
    if (!fs.existsSync(templateFile) || !fs.statSync(templateFile).isFile()) {
      fail('HOST_PROJECTION_TEMPLATE_MISSING', 'Host projection template is unavailable.');
    }
    const canonicalRoot = fs.realpathSync(resolvedRoot);
    if (fs.lstatSync(templateFile).isSymbolicLink()
      || !fs.realpathSync(templateFile).startsWith(canonicalRoot + path.sep)) {
      fail('HOST_PROJECTION_TEMPLATE_INVALID', 'Host projection template cannot traverse a symbolic link.');
    }
    const template = normalizeTemplate(fs.readFileSync(templateFile, 'utf8'), output.finalNewline);
    if (containsCredentialMaterial(template)) {
      fail('HOST_PROJECTION_CREDENTIAL_REJECTED', 'Host projection template contains credential-like material.');
    }
    const content = normalizeTemplate(
      renderTemplate(template, output.renderContext, values),
      output.finalNewline
    );
    if (containsCredentialMaterial(content)) {
      fail('HOST_PROJECTION_CREDENTIAL_REJECTED', 'Rendered host projection contains credential-like material.');
    }
    const mode = output.mode;
    const contentFingerprint = sha256(Buffer.from(content, 'utf8'));
    return {
      id: output.id,
      path: normalizeProjectionPath(output.path),
      role: output.role,
      mode,
      templatePath: output.template,
      templateFingerprint: sha256(Buffer.from(template, 'utf8')),
      content,
      contentFingerprint,
      fingerprint: fingerprintJson({ contentFingerprint, mode })
    };
  }).sort((left, right) => compareText(left.path, right.path));
  return {
    host: adapter.host,
    definition: {
      id: loaded.definition.id,
      version: loaded.definition.version,
      path: loaded.definitionPath,
      fingerprint: loaded.definitionFingerprint
    },
    generator: {
      id: HOST_PROJECTION_GENERATOR_ID,
      version: HOST_PROJECTION_GENERATOR_VERSION
    },
    outputs,
    projectionFingerprint: fingerprintJson(outputs.map((output) => ({
      id: output.id,
      path: output.path,
      role: output.role,
      mode: output.mode,
      templatePath: output.templatePath,
      templateFingerprint: output.templateFingerprint,
      contentFingerprint: output.contentFingerprint,
      fingerprint: output.fingerprint
    })))
  };
}
