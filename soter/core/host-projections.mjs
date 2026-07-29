import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  fingerprintWorkflowEvaluatedSubject,
  inspectWorkflowEvaluationRunSet,
  workflowGuideContentFingerprintMatches,
  workflowLegacySourceProjection
} from '../kernel/workflow-guides.mjs';
import { workflowEvidenceBasisForHost } from '../kernel/workflow-evidence-bases.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import {
  fingerprintPath,
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath,
  sha256
} from './lib/canonical-json.mjs';

export const HOST_PROJECTION_GENERATOR_ID = 'core.host-projection-generator';
export const HOST_PROJECTION_GENERATOR_VERSION = '2.1.0';

const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CONTEXT_KEYS = new Map([
  ['configuration-id', 'CONFIGURATION_ID'],
  ['host-id', 'HOST_ID'],
  ['pack-ids', 'PACK_IDS'],
  ['capability-ids', 'CAPABILITY_IDS'],
  ['workflow-guide-ids', 'WORKFLOW_GUIDE_IDS'],
  ['effect-policy-modes', 'EFFECT_POLICY_MODES'],
  ['provider-requirements', 'PROVIDER_REQUIREMENTS'],
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

function providerRequirements(root, adapter, packIds) {
  const selected = new Set(packIds);
  const providersRoot = resolveRepoPath(root, 'soter/providers');
  const requirements = [];
  if (fs.existsSync(providersRoot)) {
    for (const entry of fs.readdirSync(providersRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const provider = readJson(path.join(providersRoot, entry.name));
      if (provider.$contract !== 'soter://contracts/capability-provider/v1'
        || !selected.has(provider.pack)
        || provider.runtime?.engine !== 'mcp') continue;
      const route = adapter.mcpServers.find((server) => server.id === provider.runtime.server);
      if (!route) {
        fail(
          'HOST_PROJECTION_PROVIDER_REQUIREMENT_UNAVAILABLE',
          'Selected connected provider has no declared route on the selected host.'
        );
      }
      requirements.push({
        pack: assertIdentifier(provider.pack, 'Provider pack id'),
        server: assertIdentifier(route.id, 'Provider server id'),
        delivery: assertIdentifier(route.delivery, 'Provider delivery'),
        state: assertIdentifier(route.state, 'Provider route state')
      });
    }
  }
  requirements.sort((left, right) => compareText(left.pack, right.pack));
  return requirements.length
    ? requirements.map((item) => '- `' + item.pack + '` requires `' + item.server
      + '` via `' + item.delivery + '` (`' + item.state
      + '`); discovery and authentication must be proven separately.').join('\n')
    : '- No connected provider route is selected.';
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

function renderContext({ root, adapter, configurationId, hostId, packIds, capabilityIds }) {
  return {
    CONFIGURATION_ID: assertIdentifier(configurationId, 'Configuration id'),
    HOST_ID: assertIdentifier(hostId, 'Host id'),
    PACK_IDS: list(packIds, 'Pack ids'),
    CAPABILITY_IDS: list(capabilityIds, 'Capability ids'),
    PROVIDER_REQUIREMENTS: providerRequirements(root, adapter, packIds),
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
    sections.push('- Guide state: `' + guide.status.state + '`; behavior parity: `' + guide.status.behaviorParity + '`; delivery: `' + guide.status.delivery + '`.');
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
      version: HOST_PROJECTION_GENERATOR_VERSION
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

function exactWorkflowSources(definition, guide, evaluations, code) {
  try {
    return workflowLegacySourceProjection({ definition, guide, evaluations });
  } catch (error) {
    fail(code, 'Workflow source tombstones are partial, duplicated, or inconsistent.');
  }
}

function sourceArtifactProjection(artifacts) {
  return artifacts.filter((artifact) => artifact.role === 'migration-source')
    .map(({ path: sourcePath, fingerprint }) => ({ path: sourcePath, fingerprint }))
    .sort((left, right) => compareText(left.path, right.path));
}

function expectedSourceArtifacts(sources) {
  return sources.map(({ path: sourcePath, fingerprint }) => ({ path: sourcePath, fingerprint }));
}

function normalizedEvidenceReferences(references) {
  return [...(references || [])].map((reference) => ({
    host: reference.host,
    path: reference.path,
    fingerprint: reference.fingerprint
  })).sort((left, right) => {
    return compareText(
      left.host + '\0' + left.path + '\0' + left.fingerprint,
      right.host + '\0' + right.path + '\0' + right.fingerprint
    );
  });
}

function exactHistoricalReferences(definitionReferences, guideReferences) {
  const hosts = (guideReferences || []).map((reference) => reference.host).sort(compareText);
  return guideReferences?.length === 2
    && new Set(guideReferences.map((reference) => reference.host)).size === 2
    && new Set(guideReferences.map((reference) => reference.path)).size === 2
    && new Set(guideReferences.map((reference) => reference.fingerprint)).size === 2
    && fingerprintJson(hosts) === fingerprintJson(['claude', 'codex'])
    && fingerprintJson(normalizedEvidenceReferences(definitionReferences))
      === fingerprintJson(normalizedEvidenceReferences(guideReferences));
}

function isExactInstant(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function historicalEvidenceChronologyIsValid(evidence) {
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

function readExactEvidence(root, evidencePath, schemaPath, code) {
  const evidenceFile = resolveRepoPath(root, evidencePath);
  let stat;
  try {
    stat = fs.lstatSync(evidenceFile);
  } catch {
    fail(code, 'Workflow evidence is unavailable, linked, or unsafe.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o644)) {
    fail(code, 'Workflow evidence is unavailable, linked, or unsafe.');
  }
  const evidence = readJson(evidenceFile);
  const schema = readJson(resolveRepoPath(root, schemaPath));
  if (validateJsonSchema(evidence, schema).length || containsCredentialMaterial(evidence)) {
    fail(code, 'Workflow evidence does not satisfy its closed contract.');
  }
  return evidence;
}

function assertActiveGuideEvidence({ root, guide, guidePath, definition, evaluations }) {
  if (guide.status.state !== 'active') return;
  if (guide.workflow?.id !== definition.id
    || guide.workflow?.version !== definition.version
    || evaluations.workflow !== definition.id
    || evaluations.version !== definition.version
    || !exactHistoricalReferences(
      definition.lifecycle?.activation?.evidence,
      guide.status.evidence
    )) {
    fail(
      'HOST_PROJECTION_WORKFLOW_GUIDE_EVIDENCE_INVALID',
      'Active workflow definition and guide do not bind the exact Codex and Claude receipt set.'
    );
  }
  const evaluatedSubjectFingerprint = fingerprintWorkflowEvaluatedSubject({
    guide,
    definition,
    evaluations
  });
  const sources = exactWorkflowSources(
    definition,
    guide,
    evaluations,
    'HOST_PROJECTION_WORKFLOW_GUIDE_EVIDENCE_INVALID'
  );
  for (const reference of guide.status.evidence) {
    const evidence = readExactEvidence(
      root,
      reference.path,
      'soter/contracts/development-agent-migration-evidence.schema.json',
      'HOST_PROJECTION_WORKFLOW_GUIDE_EVIDENCE_INVALID'
    );
    const unsignedEvidence = structuredClone(evidence);
    delete unsignedEvidence.evidenceFingerprint;
    const expectedArtifacts = [
      ...sources.map((source, index) => ({
        id: 'artifact.migration-source.' + String(index + 1),
        role: 'migration-source',
        subjectId: definition.id,
        path: source.path,
        fingerprint: source.fingerprint
      })),
      {
        id: 'artifact.migration-target',
        role: 'migration-target',
        subjectId: guide.id,
        path: guidePath,
        fingerprint: evaluatedSubjectFingerprint
      },
      {
        id: 'artifact.development-request',
        role: 'development-request',
        subjectId: evidence.request?.id,
        fingerprint: evidence.request?.fingerprint
      },
      {
        id: 'artifact.development-result',
        role: 'development-result',
        subjectId: evidence.result?.id,
        fingerprint: evidence.result?.fingerprint
      },
      {
        id: 'artifact.host-observation',
        role: 'host-observation',
        subjectId: evidence.sourceObservation?.id,
        fingerprint: evidence.sourceObservation?.fingerprint
      },
      {
        id: 'artifact.evaluation-set',
        role: 'evaluation-set',
        subjectId: evaluations.id,
        fingerprint: evidence.evaluationSet?.fingerprint
      },
      {
        id: 'artifact.candidate-projection',
        role: 'candidate-projection',
        subjectId: guide.id,
        fingerprint: evidence.evaluatedSubject?.candidateProjectionFingerprint
      }
    ];
    const runSet = inspectWorkflowEvaluationRunSet({
      definition,
      evaluations,
      runs: evidence.runs
    });
    if (reference.fingerprint !== fingerprintJson(evidence)
      || evidence.$contract !== 'soter://contracts/development-agent-migration-evidence/v1'
      || evidence.evidenceFingerprint !== fingerprintJson(unsignedEvidence)
      || evidence.host?.id !== reference.host
      || evidence.host?.adapter !== 'host.' + reference.host
      || evidence.host?.projectionDefinitionId !== 'host-projection.' + reference.host
      || evidence.host?.observer?.id !== 'development-host-observer.' + reference.host
      || evidence.workflow?.id !== guide.workflow.id
      || evidence.workflow?.version !== guide.workflow.version
      || evidence.evaluationSet?.id !== evaluations.id
      || evidence.evaluationSet?.version !== evaluations.version
      || evidence.evaluatedSubject?.kind !== 'workflow-guide'
      || evidence.evaluatedSubject?.id !== guide.id
      || evidence.evaluatedSubject?.version !== definition.version
      || evidence.evaluatedSubject?.fingerprint !== evaluatedSubjectFingerprint
      || evidence.applicability?.evaluatedSubjectFingerprint !== evaluatedSubjectFingerprint
      || evidence.applicability?.candidate?.candidateProjectionFingerprint
        !== evidence.evaluatedSubject?.candidateProjectionFingerprint
      || evidence.host?.candidateProjectionFingerprint
        !== evidence.evaluatedSubject?.candidateProjectionFingerprint
      || evidence.conclusion?.state !== 'passed'
      || runSet.coverageComplete !== true
      || runSet.verdictsConsistent !== true
      || runSet.inputBoundaryPreserved !== true
      || runSet.guidedPassed !== true
      || evidence.conclusion?.guidedRunsPassed !== runSet.guidedPassed
      || evidence.conclusion?.prohibitedOutcomesObserved !== runSet.prohibitedOutcomesObserved
      || evidence.conclusion?.externalEffectsObserved !== false
      || evidence.applicability?.kind !== 'historical-candidate-only'
      || evidence.authority?.grantsActivation !== false
      || evidence.authority?.grantsFallbackRemoval !== false
      || evidence.workspace?.pre?.rootIdentityFingerprint
        !== evidence.workspace?.post?.rootIdentityFingerprint
      || evidence.workspace?.pre?.policyFingerprint
        !== evidence.workspace?.post?.policyFingerprint
      || evidence.workspace?.pre?.settingsFingerprint
        !== evidence.workspace?.post?.settingsFingerprint
      || historicalEvidenceChronologyIsValid(evidence) !== true
      || new Set((evidence.artifacts || []).map((artifact) => artifact.id)).size
        !== (evidence.artifacts || []).length
      || fingerprintJson(evidence.artifacts || []) !== fingerprintJson(expectedArtifacts)) {
      fail('HOST_PROJECTION_WORKFLOW_GUIDE_EVIDENCE_INVALID', 'Active workflow guide lacks one exact historical no-authority host observation receipt.');
    }
  }
}

export function workflowFinalEvidencePaths({ guide, definition }) {
  if (guide.status.state !== 'active') return;
  const workflowId = guide.workflow?.id;
  if (typeof workflowId !== 'string' || !workflowId.startsWith('automation.')) {
    fail('HOST_PROJECTION_WORKFLOW_GUIDE_MIGRATION_INVALID', 'Active workflow guide has no portable workflow identity for final evidence.');
  }
  const workflowSlug = workflowId.slice('automation.'.length);
  assertIdentifier(workflowSlug, 'Workflow evidence slug');
  const hosts = definition.lifecycle?.development?.supportedHosts;
  if (!Array.isArray(hosts)
    || fingerprintJson([...hosts].sort(compareText)) !== fingerprintJson(['claude', 'codex'])) {
    fail('HOST_PROJECTION_WORKFLOW_GUIDE_MIGRATION_INVALID', 'Active workflow final evidence must cover the exact supported Codex and Claude hosts.');
  }
  return [...hosts].sort(compareText).map((host) => {
    return 'soter/evidence/development/evidence.development-activation.'
      + host + '.' + workflowSlug + '.json';
  });
}

export function assertWorkflowFinalEvidencePathIdentity({ guide, evidencePath, evidence }) {
  const match = /^soter\/evidence\/development\/evidence[.]development-activation[.](codex|claude)[.]([a-z0-9]+(?:[.-][a-z0-9]+)*)[.]json$/.exec(
    evidencePath
  );
  const workflowId = guide.workflow?.id;
  const workflowSlug = typeof workflowId === 'string' && workflowId.startsWith('automation.')
    ? workflowId.slice('automation.'.length)
    : null;
  const expectedHost = match?.[1] || null;
  if (!match
    || match[2] !== workflowSlug
    || evidence?.id !== 'evidence.development-activation.' + expectedHost + '.' + workflowSlug
    || evidence?.host?.id !== expectedHost
    || evidence?.subject?.id !== workflowId) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_INVALID',
      'Final migration evidence identity does not match its exact deterministic host and workflow path.'
    );
  }
  return expectedHost;
}

function exactLockEvidenceFacts(lock) {
  return {
    configurationLockFingerprint: fingerprintJson(lock),
    graphFingerprint: lock.graphFingerprint,
    dependencies: lock.packs.map((pack) => ({
      id: pack.id,
      version: pack.version,
      fingerprint: pack.manifestFingerprint
    })),
    host: {
      id: lock.host.id,
      adapter: lock.host.adapter,
      version: lock.host.version,
      manifestFingerprint: lock.host.manifestFingerprint
    },
    integrations: lock.packs.filter((pack) => pack.layer === 'integration').map((pack) => ({
      id: pack.id,
      version: pack.version,
      manifestFingerprint: pack.manifestFingerprint,
      evidenceMaturity: pack.evidenceMaturity
    })),
    authorities: lock.authorities.map((authority) => ({
      id: authority.id,
      role: authority.role,
      subject: authority.subject,
      declarationFingerprint: authority.declarationFingerprint
    }))
  };
}

function assertWorkflowEvidenceBasisLock(root, evidence, basisLock) {
  const schema = readJson(resolveRepoPath(root, 'soter/contracts/lock.schema.json'));
  const unsigned = structuredClone(basisLock);
  delete unsigned.graphFingerprint;
  const basisPacks = Array.isArray(basisLock?.packs)
    ? basisLock.packs.filter((pack) => pack.id === evidence?.subject?.id)
    : [];
  if (validateJsonSchema(basisLock, schema).length
    || basisLock.graphFingerprint !== fingerprintJson(unsigned)
    || basisPacks.length !== 1
    || basisPacks[0].version !== evidence?.subject?.version
    || basisLock.host?.id !== evidence?.host?.id) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_BASIS_INVALID',
      'Final migration evidence basis lock is malformed or does not select its exact host and workflow.'
    );
  }
  const expected = exactLockEvidenceFacts(basisLock);
  const observed = Object.fromEntries(Object.keys(expected).map((key) => [key, evidence[key]]));
  if (fingerprintJson(observed) !== fingerprintJson(expected)) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_BASIS_INVALID',
      'Final migration evidence does not reproduce its immutable exact evidence-basis lock.'
    );
  }
  return basisLock;
}

function readWorkflowEvidenceBasisLock(root, host) {
  const basis = workflowEvidenceBasisForHost(host);
  if (!basis) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_BASIS_INVALID',
      'Final migration evidence names a host without a deterministic evidence-basis lock.'
    );
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const file = resolveRepoPath(resolvedRoot, basis.path);
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()
      || before.nlink !== 1
      || fs.realpathSync(file) !== file
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o644)) {
      throw new Error('unsafe evidence-basis lock');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || after.nlink !== 1) {
      throw new Error('evidence-basis lock changed while read');
    }
    const lock = JSON.parse(bytes.toString('utf8'));
    const canonical = Buffer.from(JSON.stringify(lock, null, 2) + '\n', 'utf8');
    if (!bytes.equals(canonical)
      || lock.configuration?.name !== basis.configuration
      || lock.host?.id !== basis.host
      || lock.host?.adapter !== basis.adapter) {
      throw new Error('noncanonical evidence-basis lock');
    }
    return lock;
  } catch {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_BASIS_INVALID',
      'Final migration evidence basis lock is unavailable, unsafe, or malformed.'
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function currentWorkflowPackProjection(root, workflowPack) {
  const schema = readJson(resolveRepoPath(root, 'soter/contracts/pack.schema.json'));
  if (validateJsonSchema(workflowPack, schema).length) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Current workflow pack does not satisfy its governed contract.'
    );
  }
  return {
    id: workflowPack.id,
    version: workflowPack.version,
    manifestFingerprint: fingerprintJson(workflowPack),
    artifacts: workflowPack.artifacts.map((artifact) => ({
      path: artifact.path,
      role: artifact.role,
      fingerprint: fingerprintPath(resolveRepoPath(root, artifact.path))
    })).sort((left, right) => compareText(left.path, right.path))
  };
}

function immediatePatchSuccessor(current, historical) {
  const currentParts = /^([0-9]+)[.]([0-9]+)[.]([0-9]+)$/.exec(current || '');
  const historicalParts = /^([0-9]+)[.]([0-9]+)[.]([0-9]+)$/.exec(historical || '');
  if (!currentParts || !historicalParts) return false;
  return currentParts[1] === historicalParts[1]
    && currentParts[2] === historicalParts[2]
    && BigInt(currentParts[3]) === BigInt(historicalParts[3]) + 1n;
}

function assertCurrentHostProjectionMatchesHistoricalBasis({
  root,
  adapter,
  basisLock
}) {
  const loaded = loadHostProjectionDefinition({ root, adapter });
  if (basisLock.host?.id !== adapter.host
    || basisLock.host?.adapter !== adapter.id
    || basisLock.host?.projectionDefinition?.id !== loaded.definition.id) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Current host projection does not share the immutable historical host identity.'
    );
  }
  if (fingerprintJson(adapter) === basisLock.host.manifestFingerprint
    && loaded.definitionFingerprint === basisLock.host.projectionDefinition.fingerprint) {
    return loaded;
  }
  if (adapter.host === 'codex'
    && immediatePatchSuccessor(adapter.version, basisLock.host.version)
    && loaded.definition.version === basisLock.host.projectionDefinition.version
    && loaded.definitionFingerprint === basisLock.host.projectionDefinition.fingerprint) {
    const notionServers = adapter.mcpServers.filter((server) => server.id === 'notion');
    const queryMappings = notionServers.length === 1
      ? notionServers[0].toolMappings.filter((mapping) => {
        return mapping.logical === 'query_data_sources';
      })
      : [];
    if (queryMappings.length === 1
      && queryMappings[0].native === 'mcp__codex_apps__notion_query_data_sources'
      && queryMappings[0].responseProfile === 'notion.codex.connector.v1') {
      const reconstructedAdapter = structuredClone(adapter);
      reconstructedAdapter.version = basisLock.host.version;
      reconstructedAdapter.mcpServers = reconstructedAdapter.mcpServers.map((server) => {
        if (server.id !== 'notion') return server;
        return {
          ...server,
          toolMappings: server.toolMappings.map((mapping) => {
            if (mapping.logical !== 'query_data_sources') return mapping;
            return {
              ...mapping,
              native: 'mcp__codex_apps__notion_notion_query_data_sources'
            };
          })
        };
      });
      if (fingerprintJson(reconstructedAdapter) === basisLock.host.manifestFingerprint) {
        return loaded;
      }
    }
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Current Codex adapter differs from the immutable historical basis beyond the exact Notion query-tool correction.'
    );
  }
  if (!immediatePatchSuccessor(adapter.version, basisLock.host.version)
    || !immediatePatchSuccessor(
      loaded.definition.version,
      basisLock.host.projectionDefinition.version
    )) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Current host projection is neither the historical identity nor one exact patch-level path correction.'
    );
  }
  const historicalStaticById = new Map(
    basisLock.projections.map((projection) => [projection.id, projection])
  );
  const relocated = [];
  for (const output of loaded.definition.outputs) {
    const historical = historicalStaticById.get(output.id);
    const template = projectionTemplate({
      root,
      host: loaded.definition.host,
      templatePath: output.template,
      finalNewline: output.finalNewline
    });
    if (!historical
      || historical.role !== output.role
      || historical.mode !== output.mode
      || historical.templatePath !== output.template
      || historical.templateFingerprint !== sha256(Buffer.from(template, 'utf8'))) {
      fail(
        'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
        'Current static host output metadata differs from the immutable historical evidence basis.'
      );
    }
    if (historical.path !== output.path) {
      relocated.push({ output, historical, template });
    }
  }
  if (relocated.length !== 1
    || relocated[0].output.role !== 'tools'
    || relocated[0].output.id !== 'output.' + adapter.host + '.tools'
    || fingerprintJson(relocated[0].output.renderContext) !== fingerprintJson(['host-id'])) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Current host projection change is not the one exact host-only tools-path relocation.'
    );
  }
  const moved = relocated[0];
  const content = normalizeTemplate(
    renderTemplate(moved.template, moved.output.renderContext, { HOST_ID: adapter.host }),
    moved.output.finalNewline
  );
  const contentFingerprint = sha256(Buffer.from(content, 'utf8'));
  if (moved.historical.contentFingerprint !== contentFingerprint
    || moved.historical.fingerprint !== fingerprintJson({
      contentFingerprint,
      mode: moved.output.mode
    })) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Relocated host tools output does not preserve the exact historical bytes and mode.'
    );
  }
  const reconstructedDefinition = structuredClone(loaded.definition);
  reconstructedDefinition.version = basisLock.host.projectionDefinition.version;
  reconstructedDefinition.outputs = reconstructedDefinition.outputs.map((output) => ({
    ...output,
    path: historicalStaticById.get(output.id).path
  }));
  if (fingerprintJson(reconstructedDefinition)
    !== basisLock.host.projectionDefinition.fingerprint) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Current host projection definition contains changes beyond the exact tools-path correction.'
    );
  }
  const currentDefinitionByPath = new Map(loaded.definition.outputs.map((output) => [
    output.path + '\0' + output.role,
    output
  ]));
  const reconstructedAdapter = structuredClone(adapter);
  reconstructedAdapter.version = basisLock.host.version;
  reconstructedAdapter.projectionDefinition.version
    = basisLock.host.projectionDefinition.version;
  reconstructedAdapter.projections = reconstructedAdapter.projections.map((projection) => {
    const definitionOutput = currentDefinitionByPath.get(
      projection.path + '\0' + projection.role
    );
    const historical = definitionOutput
      ? historicalStaticById.get(definitionOutput.id)
      : null;
    if (!historical) {
      fail(
        'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
        'Current adapter projection cannot be mapped to its immutable historical output.'
      );
    }
    return { ...projection, path: historical.path };
  });
  reconstructedAdapter.mcpServers = reconstructedAdapter.mcpServers.map((server) => {
    if (server.configurationPath !== moved.output.path) return server;
    return { ...server, configurationPath: moved.historical.path };
  });
  if (fingerprintJson(reconstructedAdapter) !== basisLock.host.manifestFingerprint) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Current host adapter contains changes beyond the exact tools-path correction.'
    );
  }
  return loaded;
}

function assertCurrentWorkflowDeliveryMatchesHistoricalBasis({
  root,
  adapter,
  guide,
  definition,
  evaluations,
  effectPolicies,
  basisLock
}) {
  const loaded = assertCurrentHostProjectionMatchesHistoricalBasis({
    root,
    adapter,
    basisLock
  });
  if (basisLock.host?.id !== adapter.host
    || basisLock.host?.adapter !== adapter.id
    || basisLock.host?.projectionDefinition?.id !== loaded.definition.id) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Current workflow delivery does not share the exact historical host and projection identity.'
    );
  }
  const actualBody = renderWorkflowGuideBody({
    guide,
    definition,
    effectPolicies
  });
  const evaluatedBody = renderWorkflowGuideBody({
    guide,
    definition,
    effectPolicies,
    includeLifecycle: false
  });
  const currentDelivery = [];
  const evaluatedOutputs = [];
  for (const collection of loaded.definition.collections) {
    for (const output of collection.outputs) {
      const template = projectionTemplate({
        root,
        host: loaded.definition.host,
        templatePath: output.template,
        finalNewline: output.finalNewline
      });
      const actualContent = normalizeTemplate(
        renderGuideTemplate({
          format: output.format,
          template,
          guide,
          body: actualBody
        }),
        output.finalNewline
      );
      const current = candidateOutput({
        id: 'output.' + adapter.host + '.workflow-guide.' + guide.skill.name + '.' + output.id,
        outputPath: collection.pathPrefix + guide.skill.name + '/' + output.relativePath,
        role: collection.role,
        mode: output.mode,
        templatePath: output.template,
        template,
        content: actualContent
      });
      delete current.content;
      currentDelivery.push(current);
      const evaluatedContent = normalizeTemplate(
        renderGuideTemplate({
          format: output.format,
          template,
          guide,
          body: evaluatedBody
        }),
        output.finalNewline
      );
      evaluatedOutputs.push({
        format: output.format,
        relativePath: output.relativePath,
        mode: output.mode,
        templatePath: output.template,
        templateFingerprint: sha256(Buffer.from(template, 'utf8')),
        contentFingerprint: sha256(Buffer.from(evaluatedContent, 'utf8'))
      });
    }
  }
  currentDelivery.sort((left, right) => compareText(left.path, right.path));
  const prefix = 'output.' + adapter.host + '.workflow-guide.' + guide.skill.name + '.';
  const historicalDelivery = basisLock.projections.filter((projection) => {
    return projection.id.startsWith(prefix);
  }).sort((left, right) => compareText(left.path, right.path));
  if (fingerprintJson(currentDelivery) !== fingerprintJson(historicalDelivery)) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Current workflow skill bytes, paths, modes, or templates differ from the immutable historical evidence basis.'
    );
  }
  evaluatedOutputs.sort((left, right) => compareText(left.relativePath, right.relativePath));
  return fingerprintJson({
    contract: 'soter://subjects/workflow-host-instructions/v1',
    host: basisLock.host.id,
    generator: {
      id: basisLock.host.projectionGenerator.id,
      version: basisLock.host.projectionGenerator.version
    },
    projectionDefinition: {
      id: basisLock.host.projectionDefinition.id,
      version: basisLock.host.projectionDefinition.version,
      fingerprint: basisLock.host.projectionDefinition.fingerprint
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
    effectModes: effectPolicyModes(basisLock.effectPolicies),
    outputs: evaluatedOutputs
  });
}

function assertCurrentWorkflowLockSelection({
  root,
  guide,
  adapter,
  effectPolicies,
  currentLock,
  workflowPack
}) {
  const expectedPack = currentWorkflowPackProjection(root, workflowPack);
  if (expectedPack.id !== guide.workflow.id
    || expectedPack.version !== guide.workflow.version) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Current workflow pack identity or version differs from the evaluated workflow subject.'
    );
  }
  if (currentLock === null) return expectedPack;
  const selected = Array.isArray(currentLock?.packs)
    ? currentLock.packs.filter((pack) => pack.id === expectedPack.id)
    : [];
  const selectedProjection = selected.length === 1 ? {
    id: selected[0].id,
    version: selected[0].version,
    manifestFingerprint: selected[0].manifestFingerprint,
    artifacts: selected[0].artifacts
  } : null;
  if (selected.length !== 1
    || fingerprintJson(selectedProjection) !== fingerprintJson(expectedPack)
    || currentLock.host?.id !== adapter.host
    || currentLock.host?.adapter !== adapter.id
    || currentLock.host?.version !== adapter.version
    || currentLock.host?.manifestFingerprint !== fingerprintJson(adapter)
    || fingerprintJson(currentLock.effectPolicies) !== fingerprintJson(effectPolicies)) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_CURRENT_LOCK_INVALID',
      'Current lock does not select the exact current workflow pack, host adapter, and effect policy used for applicability.'
    );
  }
  return expectedPack;
}

export function assertCurrentWorkflowFinalEvidenceDocument({
  root,
  guide,
  guidePath,
  definition,
  evaluations,
  adapter,
  effectPolicies,
  currentLock = null,
  evidenceBasisLock = null,
  workflowPack = null,
  evidence
}) {
  const artifacts = Array.isArray(evidence?.artifacts) ? evidence.artifacts : [];
  if (evidence?.$contract !== 'soter://contracts/evidence/v2'
    || evidence?.claimFamily !== 'migration'
    || evidence?.result !== 'passed') {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_INVALID',
      'Final workflow migration evidence does not have the required contract, claim, and result.'
    );
  }
  const exactBasisLock = evidenceBasisLock === null
    ? readWorkflowEvidenceBasisLock(root, evidence.host?.id)
    : structuredClone(evidenceBasisLock);
  assertWorkflowEvidenceBasisLock(root, evidence, exactBasisLock);
  let exactWorkflowPack = workflowPack;
  if (exactWorkflowPack === null) {
    try {
      exactWorkflowPack = readJson(resolveRepoPath(
        root,
        'soter/packs/' + guide.workflow.id + '/pack.json'
      ));
    } catch {
      fail(
        'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
        'Current workflow pack is unavailable or malformed.'
      );
    }
  }
  assertCurrentWorkflowLockSelection({
    root,
    guide,
    adapter,
    effectPolicies,
    currentLock,
    workflowPack: exactWorkflowPack
  });
  const sources = exactWorkflowSources(
    definition,
    guide,
    evaluations,
    'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_INVALID'
  );
  const evaluatedSubjectFingerprint = fingerprintWorkflowEvaluatedSubject({
    definition,
    guide,
    evaluations
  });
  const historicalEvaluatedInstructionsFingerprint
    = assertCurrentWorkflowDeliveryMatchesHistoricalBasis({
    root,
    adapter,
    guide,
    definition,
    evaluations,
    effectPolicies,
    basisLock: exactBasisLock
  });
  const historicalReference = guide.status.evidence.filter((reference) => {
    return reference.host === adapter.host;
  });
  const migrationTargets = artifacts.filter((artifact) => artifact.role === 'migration-target')
    .map(({ path: artifactPath, fingerprint }) => ({ path: artifactPath, fingerprint }))
    .sort((left, right) => compareText(left.path, right.path));
  const expectedMigrationTargets = [{
    path: guidePath,
    fingerprint: guide.contentFingerprint
  }, {
    path: guide.workflow.evaluationSetPath,
    fingerprint: fingerprintJson(evaluations)
  }].sort((left, right) => compareText(left.path, right.path));
  const historicalArtifacts = artifacts.filter((artifact) => {
    return artifact.role === 'development-agent-migration-evidence'
      && historicalReference.length === 1
      && artifact.path === historicalReference[0].path
      && artifact.fingerprint === historicalReference[0].fingerprint
      && artifact.host === adapter.host;
  });
  const evaluatedSubjects = artifacts.filter((artifact) => {
    return artifact.role === 'workflow-evaluated-subject'
      && artifact.subjectId === guide.id
      && artifact.fingerprint === evaluatedSubjectFingerprint;
  });
  const instructionArtifacts = artifacts.filter((artifact) => {
    return artifact.role === 'workflow-evaluated-instructions'
      && artifact.subjectId === guide.id
      && artifact.host === adapter.host
      && artifact.fingerprint === historicalEvaluatedInstructionsFingerprint;
  });
  const definitionArtifacts = artifacts.filter((artifact) => {
    return artifact.role === 'workflow-definition'
      && artifact.path === guide.workflow.definitionPath
      && artifact.fingerprint === fingerprintJson(definition);
  });
  const evaluationArtifacts = artifacts.filter((artifact) => {
    return artifact.role === 'workflow-evaluation-set'
      && artifact.path === guide.workflow.evaluationSetPath
      && artifact.fingerprint === fingerprintJson(evaluations);
  });
  if (evidence.subject?.type !== 'automation'
    || evidence.subject?.id !== guide.workflow.id
    || evidence.subject?.version !== guide.workflow.version
    || evidence.host?.id !== adapter.host
    || evidence.host?.adapter !== adapter.id
    || fingerprintJson(sourceArtifactProjection(artifacts))
      !== fingerprintJson(expectedSourceArtifacts(sources))
    || artifacts.length !== sources.length + 7
    || fingerprintJson(migrationTargets) !== fingerprintJson(expectedMigrationTargets)
    || historicalArtifacts.length !== 1
    || evaluatedSubjects.length !== 1
    || instructionArtifacts.length !== 1
    || definitionArtifacts.length !== 1
    || evaluationArtifacts.length !== 1) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_APPLICABILITY_STALE',
      'Final migration evidence is not applicable to the exact historical basis, current workflow documents, and byte-identical current workflow delivery.'
    );
  }
  return evidence;
}

function assertCurrentHostFinalEvidence({
  root,
  guide,
  guidePath,
  definition,
  evaluations,
  adapter,
  effectPolicies,
  currentLock,
  workflowPack,
  evidencePaths
}) {
  if (guide.status.state !== 'active') return;
  const expectedHosts = definition.lifecycle?.development?.supportedHosts || [];
  const evidenceRecords = evidencePaths.map((evidencePath) => {
    const evidence = readExactEvidence(
      root,
      evidencePath,
      'soter/contracts/evidence-v2.schema.json',
      'HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_INVALID'
    );
    return {
      path: evidencePath,
      expectedHost: assertWorkflowFinalEvidencePathIdentity({ guide, evidencePath, evidence }),
      evidence
    };
  });
  const hosts = evidenceRecords.map(({ expectedHost }) => expectedHost).sort(compareText);
  if (fingerprintJson(hosts) !== fingerprintJson([...expectedHosts].sort(compareText))) {
    fail('HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_INVALID', 'Final migration evidence must cover each supported host exactly once.');
  }
  const matches = evidenceRecords.filter(({ expectedHost }) => expectedHost === adapter.host);
  if (matches.length !== 1) {
    fail('HOST_PROJECTION_WORKFLOW_FINAL_EVIDENCE_INVALID', 'Selected host has no exact final migration evidence record.');
  }
  return assertCurrentWorkflowFinalEvidenceDocument({
    root,
    guide,
    guidePath,
    definition,
    evaluations,
    adapter,
    effectPolicies,
    currentLock,
    workflowPack,
    evidence: matches[0].evidence
  });
}

function loadSelectedWorkflowGuides({
  root,
  packIds,
  includeCandidates,
  adapter,
  effectPolicies,
  currentLock,
  evidenceFinalizationWorkflowIds = null
}) {
  const guideSchema = readJson(resolveRepoPath(root, 'soter/contracts/workflow-guide.schema.json'));
  const definitionSchema = readJson(resolveRepoPath(root, 'soter/contracts/workflow-definition.schema.json'));
  const evaluationSchema = readJson(resolveRepoPath(root, 'soter/contracts/workflow-evaluation-set.schema.json'));
  const guides = [];
  const guideIds = new Set();
  const skillNames = new Set();
  for (const packId of [...new Set(packIds)].sort(compareText)) {
    assertIdentifier(packId, 'Pack id');
    const packFile = resolveRepoPath(root, 'soter/packs/' + packId + '/pack.json');
    if (!fs.existsSync(packFile) || !fs.statSync(packFile).isFile()) {
      fail('HOST_PROJECTION_WORKFLOW_GUIDE_INVALID', 'Selected pack manifest is unavailable.');
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
      const definition = readJson(resolveRepoPath(root, guide.workflow.definitionPath));
      const evaluations = readJson(resolveRepoPath(root, guide.workflow.evaluationSetPath));
      if (validateJsonSchema(guide, guideSchema).length
        || validateJsonSchema(definition, definitionSchema).length
        || validateJsonSchema(evaluations, evaluationSchema).length
        || !workflowGuideContentFingerprintMatches(guide)
        || guide.workflow.id !== pack.id
        || guide.source.legacyPath !== definition.source.legacyPath) {
        fail('HOST_PROJECTION_WORKFLOW_GUIDE_INVALID', 'Selected workflow guide does not satisfy its exact contract binding.');
      }
      if (guide.status.state !== 'active' && !(includeCandidates && guide.status.state === 'candidate')) {
        continue;
      }
      const expectedActivation = guide.status.state;
      if (definition.$contract !== 'soter://contracts/workflow-definition/v2'
        || definition.lifecycle.state !== 'active-host-guided'
        || definition.lifecycle.activation.state !== expectedActivation
        || evaluations.$contract !== 'soter://contracts/workflow-evaluation-set/v2'
        || evaluations.lifecycle.state !== 'active-host-guided'
        || evaluations.lifecycle.activation !== expectedActivation) {
        fail('HOST_PROJECTION_WORKFLOW_GUIDE_LIFECYCLE_INVALID', 'Selected workflow guide lifecycle does not match its exact definition and evaluation set.');
      }
      if (guideIds.has(guide.id) || skillNames.has(guide.skill.name)) {
        fail('HOST_PROJECTION_WORKFLOW_GUIDE_INVALID', 'Selected workflow guide or skill identity is duplicated.');
      }
      guideIds.add(guide.id);
      skillNames.add(guide.skill.name);
      if (guide.workflow.definitionFingerprint !== fingerprintJson(definition)
        || guide.workflow.evaluationSetFingerprint !== fingerprintJson(evaluations)) {
        fail('HOST_PROJECTION_WORKFLOW_GUIDE_INVALID', 'Selected workflow guide bindings are stale.');
      }
      assertActiveGuideEvidence({
        root,
        guide,
        guidePath: artifact.path,
        definition,
        evaluations
      });
      const finalEvidencePaths = workflowFinalEvidencePaths({ guide, definition });
      if (!evidenceFinalizationWorkflowIds?.has(guide.workflow.id)) {
        assertCurrentHostFinalEvidence({
          root,
          guide,
          guidePath: artifact.path,
          definition,
          evaluations,
          adapter,
          effectPolicies,
          currentLock,
          workflowPack: pack,
          evidencePaths: finalEvidencePaths
        });
      }
      guides.push({ guide, definition, guidePath: artifact.path });
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
  includeCandidates,
  currentLock = null,
  evidenceFinalizationWorkflowIds = null
}) {
  const resolvedRoot = path.resolve(root);
  const loaded = loadHostProjectionDefinition({ root: resolvedRoot, adapter });
  const values = renderContext({
    root: resolvedRoot,
    adapter,
    configurationId,
    hostId: adapter.host,
    packIds,
    capabilityIds
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
    includeCandidates,
    adapter,
    effectPolicies,
    currentLock,
    evidenceFinalizationWorkflowIds
  });
  if (evidenceFinalizationWorkflowIds !== null) {
    const selected = guides.filter(({ guide }) => guide.status.state === 'active')
      .map(({ guide }) => guide.workflow.id)
      .sort(compareText);
    const expected = [...evidenceFinalizationWorkflowIds].sort(compareText);
    if (fingerprintJson(selected) !== fingerprintJson(expected)) {
      fail(
        'HOST_PROJECTION_WORKFLOW_FINALIZATION_SET_INVALID',
        'Evidence finalization must name every and only active selected host-guided workflow.'
      );
    }
  }
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
      version: HOST_PROJECTION_GENERATOR_VERSION
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

/**
 * Derive deterministic host bytes for one closed all-workflow evidence
 * finalization batch. This skips only the final evidence documents named by
 * the exact active workflow set; historical receipts, tombstones, inventory,
 * schemas, effects, and every other projection invariant remain mandatory.
 * The returned projection grants no realization or runtime authority.
 */
export function renderHostProjectionCandidatesForEvidenceFinalization(options) {
  const workflowIds = options?.workflowIds;
  if (!Array.isArray(workflowIds)
    || workflowIds.length === 0
    || new Set(workflowIds).size !== workflowIds.length
    || workflowIds.some((id) => !/^automation[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id))) {
    fail(
      'HOST_PROJECTION_WORKFLOW_FINALIZATION_SET_INVALID',
      'Evidence finalization requires one non-empty unique workflow identity set.'
    );
  }
  const { workflowIds: _workflowIds, ...rest } = options;
  return renderHostProjectionCandidatesInternal({
    ...rest,
    includeCandidates: false,
    currentLock: null,
    evidenceFinalizationWorkflowIds: new Set(workflowIds)
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
