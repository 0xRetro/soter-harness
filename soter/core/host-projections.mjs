import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintWorkflowEvaluatedSubject,
  workflowGuideContentFingerprintMatches
} from '../kernel/workflow-guides.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath,
  sha256
} from './lib/canonical-json.mjs';

export const HOST_PROJECTION_GENERATOR_ID = 'core.host-projection-generator';
export const HOST_PROJECTION_GENERATOR_VERSION = '2.2.0';
const HOST_PROJECTION_GENERATOR_VERSIONS = new Set(['2.1.0', '2.2.0']);

const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CONTEXT_KEYS = new Map([
  ['configuration-id', 'CONFIGURATION_ID'],
  ['host-id', 'HOST_ID'],
  ['pack-ids', 'PACK_IDS'],
  ['capability-ids', 'CAPABILITY_IDS'],
  ['workflow-guide-ids', 'WORKFLOW_GUIDE_IDS'],
  ['effect-policy-modes', 'EFFECT_POLICY_MODES'],
  ['provider-requirements', 'PROVIDER_REQUIREMENTS'],
  ['provider-endpoint-blocks', 'PROVIDER_ENDPOINT_BLOCKS'],
  ['development-guards', 'DEVELOPMENT_GUARDS']
]);
const EFFECTS = ['read', 'disclosure', 'write', 'dispatch', 'destructive'];
const EFFECT_MODES = new Set(['allow', 'confirm', 'prohibit']);
const GUIDE_FORMAT_HOSTS = new Map([
  ['codex-skill-v1', 'codex'],
  ['codex-openai-yaml-v1', 'codex'],
  ['claude-skill-v1', 'claude']
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
  const folded = value.toLowerCase();
  if (folded === '.git' || folded.startsWith('.git/')
    || folded === '.soter/state' || folded.startsWith('.soter/state/')) {
    fail('HOST_PROJECTION_PATH_INVALID', 'Host projection paths cannot target protected local namespaces.');
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

function mcpProviderInventory(root) {
  const providersRoot = resolveRepoPath(root, 'soter/providers');
  if (!fs.existsSync(providersRoot)) return [];
  const providers = [];
  const ids = new Set();
  for (const entry of fs.readdirSync(providersRoot, { withFileTypes: true }).sort((left, right) => {
    return compareText(left.name, right.name);
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const provider = readJson(path.join(providersRoot, entry.name));
    if (provider.$contract !== 'soter://contracts/capability-provider/v1'
      || provider.runtime?.engine !== 'mcp') continue;
    const endpointProvisioning = provider.runtime.endpointProvisioning || null;
    if (endpointProvisioning !== null
      && (endpointProvisioning.target !== 'host-project-config'
        || endpointProvisioning.state !== 'required'
        || Object.keys(endpointProvisioning).length !== 2)) {
      fail(
        'HOST_PROJECTION_PROVIDER_ENDPOINT_DECLARATION_INVALID',
        'MCP provider endpoint provisioning must use the exact closed requirement.'
      );
    }
    const row = {
      id: assertIdentifier(provider.id, 'Provider id'),
      pack: assertIdentifier(provider.pack, 'Provider pack id'),
      server: assertIdentifier(provider.runtime.server, 'Provider server id'),
      endpointProvisioning
    };
    if (ids.has(row.id)) {
      fail('HOST_PROJECTION_PROVIDER_REQUIREMENT_AMBIGUOUS', 'MCP provider identity is duplicated.');
    }
    ids.add(row.id);
    providers.push(row);
  }
  return providers.sort((left, right) => compareText(left.id, right.id));
}

function selectedMcpProviders(root, adapter, packIds) {
  const selected = new Set(packIds);
  const providers = [];
  const servers = new Set();
  for (const provider of mcpProviderInventory(root)) {
    if (!selected.has(provider.pack)) continue;
    const route = adapter.mcpServers.find((server) => server.id === provider.server);
    if (!route) {
      fail(
        'HOST_PROJECTION_PROVIDER_REQUIREMENT_UNAVAILABLE',
        'Selected connected provider has no declared route on the selected host.'
      );
    }
    if (servers.has(provider.server)) {
      fail(
        'HOST_PROJECTION_PROVIDER_REQUIREMENT_AMBIGUOUS',
        'Selected connected providers ambiguously share one host server route.'
      );
    }
    servers.add(provider.server);
    providers.push({
      ...provider,
      delivery: assertIdentifier(route.delivery, 'Provider delivery'),
      state: assertIdentifier(route.state, 'Provider route state')
    });
  }
  return providers.sort((left, right) => compareText(left.id, right.id));
}

function providerRequirements(providers) {
  return providers.length
    ? providers.map((item) => '- `' + item.pack + '` requires `' + item.server
      + '` via `' + item.delivery + '` (`' + item.state
      + '`); discovery and authentication must be proven separately.').join('\n')
    : '- No connected provider route is selected.';
}

function providerEndpointBlocks({ root, adapter, blocks, selectedProviders }) {
  if (!Array.isArray(blocks)) {
    fail('HOST_PROJECTION_PROVIDER_ENDPOINT_INVALID', 'Provider endpoint blocks must be a closed list.');
  }
  const inventory = new Map(mcpProviderInventory(root).map((provider) => [provider.id, provider]));
  const selected = new Set(selectedProviders.map((provider) => provider.id));
  const ids = new Set();
  const providers = new Set();
  const servers = new Set();
  const rendered = [];
  for (const block of blocks) {
    const id = assertIdentifier(block.id, 'Provider endpoint block id');
    const providerId = assertIdentifier(block.provider, 'Provider endpoint provider id');
    const server = assertIdentifier(block.server, 'Provider endpoint server id');
    const provider = inventory.get(providerId);
    const route = adapter.mcpServers.find((item) => item.id === server);
    if (!provider || provider.server !== server || !route) {
      fail(
        'HOST_PROJECTION_PROVIDER_ENDPOINT_BINDING_INVALID',
        'Provider endpoint block does not match an exact MCP provider and host route.'
      );
    }
    if (provider.endpointProvisioning?.target !== 'host-project-config'
      || provider.endpointProvisioning?.state !== 'required') {
      fail(
        'HOST_PROJECTION_PROVIDER_ENDPOINT_UNDECLARED',
        'Provider endpoint block has no matching provider-owned provisioning requirement.'
      );
    }
    if (ids.has(id) || providers.has(providerId) || servers.has(server)) {
      fail(
        'HOST_PROJECTION_PROVIDER_ENDPOINT_AMBIGUOUS',
        'Provider endpoint block identity, provider, and server must be unique.'
      );
    }
    ids.add(id);
    providers.add(providerId);
    servers.add(server);
    if (block.selection !== 'selected-mcp-provider'
      || block.encoding !== 'utf-8' || block.newline !== 'lf'
      || block.finalNewline !== true
      || normalizeTemplate(block.content, true) !== block.content) {
      fail(
        'HOST_PROJECTION_PROVIDER_ENDPOINT_INVALID',
        'Provider endpoint block does not satisfy its deterministic rendering policy.'
      );
    }
    const content = renderClosedTemplate(block.content, { SERVER_ID: server });
    if (containsCredentialMaterial(content)) {
      fail(
        'HOST_PROJECTION_CREDENTIAL_REJECTED',
        'Provider endpoint block contains credential-like material.'
      );
    }
    if (selected.has(providerId)) rendered.push({ id, content });
  }
  for (const provider of selectedProviders) {
    if (provider.endpointProvisioning?.target === 'host-project-config'
      && provider.endpointProvisioning?.state === 'required'
      && !providers.has(provider.id)) {
      fail(
        'HOST_PROJECTION_PROVIDER_ENDPOINT_REQUIRED',
        'Selected provider requires one exact host project-config endpoint block.'
      );
    }
  }
  return rendered
    .sort((left, right) => compareText(left.id, right.id))
    .map((item) => item.content)
    .join('\n');
}

function developmentGuards(root) {
  const governance = readJson(resolveRepoPath(root, 'soter/kernel/development-governance.json'));
  const requirements = governance.qualityRequirements;
  if (!Array.isArray(requirements) || !requirements.length) {
    fail('HOST_PROJECTION_DEVELOPMENT_GUARDS_INVALID', 'Development governance has no quality requirements.');
  }
  return [...requirements]
    .sort((left, right) => compareText(left.id, right.id))
    .map((item) => '- `' + assertIdentifier(item.id, 'Development guard id') + '` (`'
      + assertIdentifier(item.enforcement, 'Development guard enforcement') + '`): '
      + item.requirement)
    .join('\n');
}

function renderContext({
  root,
  adapter,
  configurationId,
  hostId,
  packIds,
  capabilityIds,
  providerEndpointBlockDefinitions
}) {
  const selectedProviders = selectedMcpProviders(root, adapter, packIds);
  return {
    CONFIGURATION_ID: assertIdentifier(configurationId, 'Configuration id'),
    HOST_ID: assertIdentifier(hostId, 'Host id'),
    PACK_IDS: list(packIds, 'Pack ids'),
    CAPABILITY_IDS: list(capabilityIds, 'Capability ids'),
    PROVIDER_REQUIREMENTS: providerRequirements(selectedProviders),
    PROVIDER_ENDPOINT_BLOCKS: providerEndpointBlocks({
      root,
      adapter,
      blocks: providerEndpointBlockDefinitions,
      selectedProviders
    }),
    DEVELOPMENT_GUARDS: developmentGuards(root)
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

function projectionTemplate({ root, host, templatePath, finalNewline }) {
  if (!templatePath.startsWith('soter/hosts/' + host + '/templates/')) {
    fail('HOST_PROJECTION_DEFINITION_INVALID', 'Host projection template is owned by another host definition.');
  }
  const templateFile = resolveRepoPath(root, templatePath);
  if (!fs.existsSync(templateFile) || !fs.statSync(templateFile).isFile()) {
    fail('HOST_PROJECTION_TEMPLATE_MISSING', 'Host projection template is unavailable.');
  }
  const canonicalRoot = fs.realpathSync(root);
  if (fs.lstatSync(templateFile).isSymbolicLink()
    || !fs.realpathSync(templateFile).startsWith(canonicalRoot + path.sep)) {
    fail('HOST_PROJECTION_TEMPLATE_INVALID', 'Host projection template cannot traverse a symbolic link.');
  }
  const template = normalizeTemplate(fs.readFileSync(templateFile, 'utf8'), finalNewline);
  if (containsCredentialMaterial(template)) {
    fail('HOST_PROJECTION_CREDENTIAL_REJECTED', 'Host projection template contains credential-like material.');
  }
  return template;
}

function renderClosedTemplate(template, values) {
  const expected = new Set(Object.keys(values));
  const observed = new Set();
  const rendered = template.replace(/{{([A-Z_]+)}}/g, (_match, token) => {
    if (!expected.has(token)) {
      fail('HOST_PROJECTION_TEMPLATE_INVALID', 'Workflow guide template uses an undeclared token.');
    }
    observed.add(token);
    return values[token];
  });
  if (rendered.includes('{{') || rendered.includes('}}')
    || observed.size !== expected.size) {
    fail('HOST_PROJECTION_TEMPLATE_INVALID', 'Workflow guide template has missing or unresolved tokens.');
  }
  return rendered;
}

function markdownList(values, empty = 'None declared.') {
  return values.length ? values.map((value) => '- ' + value).join('\n') : '- ' + empty;
}

function effectPolicyModes(effectPolicies) {
  if (!effectPolicies || typeof effectPolicies !== 'object' || Array.isArray(effectPolicies)) {
    fail('HOST_PROJECTION_EFFECT_POLICY_INVALID', 'Workflow guide projection requires exact resolved effect policies.');
  }
  const modes = {};
  for (const effect of EFFECTS) {
    const mode = effectPolicies[effect]?.mode;
    if (!EFFECT_MODES.has(mode)) {
      fail('HOST_PROJECTION_EFFECT_POLICY_INVALID', 'Workflow guide projection received an invalid effect policy mode.');
    }
    modes[effect] = mode;
  }
  return modes;
}

function renderWorkflowGuideBody({ guide, definition, effectPolicies, includeLifecycle = true }) {
  const modes = effectPolicyModes(effectPolicies);
  const definitionSteps = new Map(definition.procedure.map((step) => [step.id, step]));
  const sections = [
    '# ' + guide.skill.displayName,
    '',
    '## Purpose',
    '',
    definition.intent.goal,
    '',
    'Use when:',
    markdownList(definition.intent.useWhen),
    '',
    'Do not use when:',
    markdownList(definition.intent.excludeWhen),
    '',
    '## Authority boundary',
    '',
    '- This file is procedural guidance only.',
    '- It grants no execution, effect, approval, continuation, readiness, verification, or health authority.',
    '- Every operation remains subject to the exact current configuration, capability binding, authority, effect policy, approval, single-use start, checkpoint, and verification boundary.'
  ];
  if (includeLifecycle) {
    sections.push('- Guide state: `' + guide.status.state + '`; delivery: `' + guide.status.delivery + '`.');
  }
  sections.push(
    '',
    'Current resolved effect modes:',
    ...EFFECTS.map((effect) => '- `' + effect + '`: `' + modes[effect] + '`'),
    '',
    '## Procedure',
    ''
  );
  for (const step of guide.stepDetails) {
    const definitionStep = definitionSteps.get(step.id);
    if (!definitionStep || definitionStep.sequence !== step.sequence) {
      fail('HOST_PROJECTION_WORKFLOW_GUIDE_INVALID', 'Workflow guide step identity does not match its definition.');
    }
    sections.push('### ' + step.sequence + '. ' + step.id);
    sections.push('');
    sections.push('Outcome: ' + definitionStep.outcome);
    sections.push('');
    sections.push('Instructions:');
    sections.push(markdownList(step.instructions));
    sections.push('');
    sections.push('Flexible choices:');
    sections.push(markdownList(step.flexibility));
    sections.push('');
    sections.push('Stop when:');
    sections.push(markdownList(step.stopConditions));
    sections.push('');
  }
  sections.push('## Safeguards', '');
  sections.push(markdownList(definition.safeguards));
  sections.push('', '## Verification', '');
  sections.push(markdownList(guide.verification));
  sections.push('', '## Gotchas', '');
  for (const item of guide.gotchas) {
    sections.push('- **' + item.id + '** (`' + item.kind + '`): ' + item.summary
      + ' Countermeasure: ' + item.countermeasure);
  }
  sections.push('', '## References', '');
  sections.push(markdownList(guide.references.map((item) => {
    return '`' + item.id + '` (' + item.kind + '): ' + item.label + ' — `' + item.target + '`';
  })));
  sections.push('', '## Limitations', '');
  sections.push(markdownList(guide.limitations));
  return sections.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function renderWorkflowGuideEvaluatedInstructions({
  root,
  adapter,
  guide,
  definition,
  evaluations,
  effectPolicies
}) {
  const resolvedRoot = path.resolve(root);
  const loaded = loadHostProjectionDefinition({ root: resolvedRoot, adapter });
  const body = renderWorkflowGuideBody({
    guide,
    definition,
    effectPolicies,
    includeLifecycle: false
  });
  const outputs = [];
  const materials = [];
  for (const collection of loaded.definition.collections) {
    for (const output of collection.outputs) {
      const template = projectionTemplate({
        root: resolvedRoot,
        host: loaded.definition.host,
        templatePath: output.template,
        finalNewline: output.finalNewline
      });
      const content = normalizeTemplate(
        renderGuideTemplate({ format: output.format, template, guide, body }),
        output.finalNewline
      );
      const metadata = {
        format: output.format,
        relativePath: output.relativePath,
        mode: output.mode,
        templatePath: output.template,
        templateFingerprint: sha256(Buffer.from(template, 'utf8')),
        contentFingerprint: sha256(Buffer.from(content, 'utf8'))
      };
      outputs.push(metadata);
      materials.push({ ...metadata, content });
    }
  }
  outputs.sort((left, right) => compareText(left.relativePath, right.relativePath));
  materials.sort((left, right) => compareText(left.relativePath, right.relativePath));
  const projection = {
    contract: 'soter://subjects/workflow-host-instructions/v1',
    host: adapter.host,
    generator: {
      id: HOST_PROJECTION_GENERATOR_ID,
      version: loaded.definition.generator.version
    },
    projectionDefinition: {
      id: loaded.definition.id,
      version: loaded.definition.version,
      fingerprint: loaded.definitionFingerprint
    },
    workflow: {
      id: definition.id,
      version: definition.version,
      evaluatedSubjectFingerprint: fingerprintWorkflowEvaluatedSubject({
        definition,
        guide,
        evaluations
      })
    },
    effectModes: effectPolicyModes(effectPolicies),
    outputs
  };
  return {
    ...projection,
    // Exact bytes are returned only to the trusted local evaluator. They are
    // deliberately excluded from the projection fingerprint and every
    // request/result/inspection contract, all of which retain fingerprints.
    materials,
    fingerprint: fingerprintJson(projection)
  };
}


function loadSelectedWorkflowGuides({ root, packIds, includeCandidates = false }) {
  const guideSchema = readJson(resolveRepoPath(root, 'soter/contracts/workflow-guide.schema.json'));
  const definitionSchema = readJson(resolveRepoPath(root, 'soter/contracts/workflow-definition.schema.json'));
  const evaluationSchema = readJson(resolveRepoPath(root, 'soter/contracts/workflow-evaluation-set.schema.json'));
  const guides = [];
  const guideIds = new Set();
  const skillNames = new Set();
  for (const packId of [...new Set(packIds)].sort(compareText)) {
    assertIdentifier(packId, 'Pack id');
    const packFile = resolveRepoPath(root, 'soter/packs/' + packId + '/pack.json');
    if (!fs.existsSync(packFile) || !fs.statSync(packFile).isFile()
      || fs.lstatSync(packFile).isSymbolicLink()) {
      fail('HOST_PROJECTION_WORKFLOW_GUIDE_INVALID', 'Selected pack manifest is unavailable or unsafe.');
    }
    const pack = readJson(packFile);
    if (pack.id !== packId) {
      fail('HOST_PROJECTION_WORKFLOW_GUIDE_INVALID', 'Selected pack manifest identity is invalid.');
    }
    for (const artifact of pack.artifacts || []) {
      if (artifact.role !== 'definition' || !artifact.path.endsWith('/guide.json')) continue;
      const guideFile = resolveRepoPath(root, artifact.path);
      if (!fs.existsSync(guideFile) || !fs.statSync(guideFile).isFile()
        || fs.lstatSync(guideFile).isSymbolicLink()) {
        fail('HOST_PROJECTION_WORKFLOW_GUIDE_INVALID', 'Selected workflow guide is unavailable or unsafe.');
      }
      const guide = readJson(guideFile);
      const definitionFile = resolveRepoPath(root, guide.workflow.definitionPath);
      const evaluationsFile = resolveRepoPath(root, guide.workflow.evaluationSetPath);
      if (!fs.existsSync(definitionFile) || !fs.existsSync(evaluationsFile)
        || fs.lstatSync(definitionFile).isSymbolicLink()
        || fs.lstatSync(evaluationsFile).isSymbolicLink()) {
        fail('HOST_PROJECTION_WORKFLOW_GUIDE_INVALID', 'Selected workflow bindings are unavailable or unsafe.');
      }
      const definition = readJson(definitionFile);
      const evaluations = readJson(evaluationsFile);
      if (validateJsonSchema(guide, guideSchema).length
        || validateJsonSchema(definition, definitionSchema).length
        || validateJsonSchema(evaluations, evaluationSchema).length
        || !workflowGuideContentFingerprintMatches(guide)
        || guide.workflow.id !== pack.id
        || guide.workflow.version !== pack.version
        || guide.workflow.definitionFingerprint !== fingerprintJson(definition)
        || guide.workflow.evaluationSetFingerprint !== fingerprintJson(evaluations)) {
        fail('HOST_PROJECTION_WORKFLOW_GUIDE_INVALID', 'Selected workflow guide does not satisfy its exact current contract binding.');
      }
      if (guide.status.state !== 'active') {
        if (includeCandidates) continue;
        continue;
      }
      if (definition.$contract !== 'soter://contracts/workflow-definition/v2'
        || definition.lifecycle.state !== 'active-host-guided'
        || definition.id !== guide.workflow.id
        || definition.version !== guide.workflow.version
        || definition.guide.id !== guide.id
        || definition.guide.path !== artifact.path
        || definition.evaluationSet.id !== evaluations.id
        || definition.evaluationSet.path !== guide.workflow.evaluationSetPath
        || evaluations.$contract !== 'soter://contracts/workflow-evaluation-set/v2'
        || evaluations.lifecycle.state !== 'active-host-guided'
        || evaluations.workflow !== definition.id
        || evaluations.version !== definition.version) {
        fail('HOST_PROJECTION_WORKFLOW_GUIDE_LIFECYCLE_INVALID', 'Selected workflow guide lifecycle and bindings are inconsistent.');
      }
      if (guideIds.has(guide.id) || skillNames.has(guide.skill.name)) {
        fail('HOST_PROJECTION_WORKFLOW_GUIDE_INVALID', 'Selected workflow guide or skill identity is duplicated.');
      }
      guideIds.add(guide.id);
      skillNames.add(guide.skill.name);
      guides.push({ guide, definition, evaluations, guidePath: artifact.path });
    }
  }
  return guides.sort((left, right) => compareText(left.guide.skill.name, right.guide.skill.name));
}
function renderGuideTemplate({ format, template, guide, body }) {
  if (format === 'codex-skill-v1' || format === 'claude-skill-v1') {
    return renderClosedTemplate(template, {
      SKILL_NAME: guide.skill.name,
      SKILL_DESCRIPTION_YAML: JSON.stringify(guide.skill.description),
      GUIDE_BODY: body
    });
  }
  if (format === 'codex-openai-yaml-v1') {
    return renderClosedTemplate(template, {
      DISPLAY_NAME_YAML: JSON.stringify(guide.skill.displayName),
      SHORT_DESCRIPTION_YAML: JSON.stringify(guide.skill.shortDescription),
      DEFAULT_PROMPT_YAML: JSON.stringify(guide.skill.defaultPrompt)
    });
  }
  fail('HOST_PROJECTION_DEFINITION_INVALID', 'Workflow guide output format is unsupported.');
}

function candidateOutput({ id, outputPath, role, mode, templatePath, template, content }) {
  if (containsCredentialMaterial(content)) {
    fail('HOST_PROJECTION_CREDENTIAL_REJECTED', 'Rendered host projection contains credential-like material.');
  }
  const contentFingerprint = sha256(Buffer.from(content, 'utf8'));
  return {
    id,
    path: normalizeProjectionPath(outputPath),
    role,
    mode,
    templatePath,
    templateFingerprint: sha256(Buffer.from(template, 'utf8')),
    content,
    contentFingerprint,
    fingerprint: fingerprintJson({ contentFingerprint, mode })
  };
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
    || !HOST_PROJECTION_GENERATOR_VERSIONS.has(definition.generator.version)
    || (definition.providerEndpointBlocks?.length
      && definition.generator.version !== HOST_PROJECTION_GENERATOR_VERSION)) {
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
  const adapterCollections = adapter.projectionCollections.map((collection) => ({
    id: collection.id,
    role: collection.role,
    pathPrefix: normalizeProjectionPath(collection.pathPrefix),
    sourceContract: collection.sourceContract,
    selection: collection.selection
  })).sort((left, right) => compareText(left.id, right.id));
  const definitionCollections = definition.collections.map((collection) => ({
    id: collection.id,
    role: collection.role,
    pathPrefix: normalizeProjectionPath(collection.pathPrefix),
    sourceContract: collection.sourceContract,
    selection: collection.selection
  })).sort((left, right) => compareText(left.id, right.id));
  if (fingerprintJson(adapterCollections) !== fingerprintJson(definitionCollections)) {
    fail('HOST_PROJECTION_DEFINITION_BINDING_INVALID', 'Host adapter projection collections do not match the owned definition collections.');
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
  const collectionIds = new Set();
  const collectionPrefixes = new Set();
  for (const collection of definition.collections) {
    normalizeProjectionPath(collection.pathPrefix);
    if (collectionIds.has(collection.id) || collectionPrefixes.has(collection.pathPrefix)) {
      fail('HOST_PROJECTION_DEFINITION_INVALID', 'Host projection collection identifiers and path prefixes must be unique.');
    }
    collectionIds.add(collection.id);
    collectionPrefixes.add(collection.pathPrefix);
    if ([...paths].some((outputPath) => outputPath.startsWith(collection.pathPrefix))) {
      fail('HOST_PROJECTION_DEFINITION_INVALID', 'Static output collides with a dynamic collection path prefix.');
    }
    const outputIds = new Set();
    const relativePaths = new Set();
    for (const output of collection.outputs) {
      normalizeProjectionPath(output.relativePath);
      if (outputIds.has(output.id) || relativePaths.has(output.relativePath)) {
        fail('HOST_PROJECTION_DEFINITION_INVALID', 'Workflow guide collection output identifiers and paths must be unique.');
      }
      outputIds.add(output.id);
      relativePaths.add(output.relativePath);
      if (!output.template.startsWith('soter/hosts/' + definition.host + '/templates/')
        || GUIDE_FORMAT_HOSTS.get(output.format) !== definition.host) {
        fail('HOST_PROJECTION_DEFINITION_INVALID', 'Workflow guide output template or format belongs to another host.');
      }
    }
  }
  return {
    definition,
    definitionFile,
    definitionPath: repoRelativePath(resolvedRoot, definitionFile),
    definitionFingerprint: fingerprintJson(definition)
  };
}

function renderHostProjectionCandidatesInternal({
  root,
  adapter,
  configurationId,
  packIds,
  capabilityIds,
  effectPolicies,
  includeCandidates
}) {
  const resolvedRoot = path.resolve(root);
  const loaded = loadHostProjectionDefinition({ root: resolvedRoot, adapter });
  const values = renderContext({
    root: resolvedRoot,
    adapter,
    configurationId,
    hostId: adapter.host,
    packIds,
    capabilityIds,
    providerEndpointBlockDefinitions: loaded.definition.providerEndpointBlocks || []
  });
  const outputs = loaded.definition.outputs.map((output) => {
    const template = projectionTemplate({
      root: resolvedRoot,
      host: loaded.definition.host,
      templatePath: output.template,
      finalNewline: output.finalNewline
    });
    const content = normalizeTemplate(
      renderTemplate(template, output.renderContext, values),
      output.finalNewline
    );
    return candidateOutput({
      id: output.id,
      outputPath: output.path,
      role: output.role,
      mode: output.mode,
      templatePath: output.template,
      template,
      content,
    });
  });
  const guides = loadSelectedWorkflowGuides({
    root: resolvedRoot,
    packIds,
    includeCandidates
  });
  for (const collection of loaded.definition.collections) {
    for (const { guide, definition } of guides) {
      const body = renderWorkflowGuideBody({ guide, definition, effectPolicies });
      for (const output of collection.outputs) {
        const template = projectionTemplate({
          root: resolvedRoot,
          host: loaded.definition.host,
          templatePath: output.template,
          finalNewline: output.finalNewline
        });
        const content = normalizeTemplate(
          renderGuideTemplate({ format: output.format, template, guide, body }),
          output.finalNewline
        );
        outputs.push(candidateOutput({
          id: 'output.' + adapter.host + '.workflow-guide.' + guide.skill.name + '.' + output.id,
          outputPath: collection.pathPrefix + guide.skill.name + '/' + output.relativePath,
          role: collection.role,
          mode: output.mode,
          templatePath: output.template,
          template,
          content
        }));
      }
    }
  }
  outputs.sort((left, right) => compareText(left.path, right.path));
  const outputIds = new Set();
  const outputPaths = new Set();
  for (const output of outputs) {
    if (outputIds.has(output.id) || outputPaths.has(output.path)) {
      fail('HOST_PROJECTION_DEFINITION_INVALID', 'Rendered host output identities and paths must be unique.');
    }
    outputIds.add(output.id);
    outputPaths.add(output.path);
  }
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
      version: loaded.definition.generator.version
    },
    workflowGuides: guides.map(({ guide }) => ({
      id: guide.id,
      state: guide.status.state,
      fingerprint: fingerprintJson(guide)
    })),
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

export function renderHostProjectionCandidates(options) {
  return renderHostProjectionCandidatesInternal({
    ...options,
    includeCandidates: false
  });
}
export function renderWorkflowGuidePreviewCandidates(options) {
  const rendered = renderHostProjectionCandidatesInternal({
    ...options,
    includeCandidates: true
  });
  return {
    host: rendered.host,
    definition: rendered.definition,
    generator: rendered.generator,
    workflowGuides: rendered.workflowGuides,
    outputs: rendered.outputs.filter((output) => output.role === 'skills'),
    authority: {
      execution: 'none',
      effect: 'none',
      approval: 'none'
    },
    previewOnly: true
  };
}
