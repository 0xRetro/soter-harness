#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson } from '../core/lib/canonical-json.mjs';
import { resolveConfiguration } from '../core/resolve.mjs';
import { contextVocabularySemanticErrors, validateJsonSchema } from './verify.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), '..', '..');

function load(relativePath) {
  return readJson(path.join(root, relativePath));
}

function fieldIds(model) {
  return model.recordTypes.flatMap((recordType) => {
    return recordType.fields.map((field) => field.id);
  });
}

const policy = load('soter/contexts/policy/standard.model.json');
assert.deepEqual(policy.sectionOrder, [
  'definition',
  'scope',
  'classifications',
  'rules',
  'lifecycle-and-states',
  'fields',
  'linked-processes',
  'change-control',
  'change-log'
]);
assert.deepEqual(policy.classification.requiredFacts, [
  'requirement',
  'classifies',
  'proven-by',
  'values'
]);
assert.deepEqual(policy.rules.families, ['data', 'operating', 'determination']);
assert.equal(policy.currentState.proposalDisposition, 'confirm-or-drop');
assert.equal(policy.privacy.credentialsIncluded, false);
assert.equal(policy.privacy.privateInstancesIncluded, false);
assert.equal(policy.privacy.rawProviderResponsesIncluded, false);

const contextModels = new Map([
  ['context.calendar', load('soter/contexts/calendar/records.model.json')],
  ['context.communications', load('soter/contexts/communications/semantics.model.json')],
  ['context.communications.collaboration', load('soter/contexts/communications/collaboration/records.model.json')],
  ['context.crm', load('soter/contexts/crm/records.model.json')],
  ['context.docs', load('soter/contexts/docs/records.model.json')],
  ['context.meetings', load('soter/contexts/meetings/records.model.json')],
  ['context.onchain', load('soter/contexts/onchain/records.model.json')],
  ['context.policy', policy],
  ['context.product', load('soter/contexts/product/records.model.json')],
  ['context.projects', load('soter/contexts/projects/records.model.json')],
  ['context.resources', load('soter/contexts/resources/records.model.json')],
  ['context.sky', load('soter/contexts/sky/records.model.json')],
  ['context.tasks', load('soter/contexts/tasks/records.model.json')]
]);

for (const [packId, model] of contextModels) {
  const pack = load(`soter/packs/${packId}/pack.json`);
  assert.equal(pack.layer, 'context', `${packId} must remain Context-owned`);
  assert.deepEqual(pack.capabilities, { requires: [], provides: [] });
  assert.deepEqual(pack.effects, []);
  assert(pack.authorities.length > 0, `${packId} must declare its semantic authority subjects`);
  assert(pack.authorities.every((authority) => {
    return ['definition', 'instance'].includes(authority.role)
      && authority.subject === model.subject
      && authority.required === true;
  }), `${packId} may declare only its own required definition or instance authorities`);
  assert.equal(model.pack, packId);
}

const calendarFields = fieldIds(contextModels.get('context.calendar'));
assert(calendarFields.includes('timeSourceEventId'));
assert(!calendarFields.some((id) => /sync|provider|write/i.test(id)));

const docsFields = fieldIds(contextModels.get('context.docs'));
for (const required of [
  'audiences',
  'relatedProjectUris',
  'relatedTaskUris',
  'relatedOpportunityUris'
]) {
  assert(docsFields.includes(required), `Docs Context is missing ${required}`);
}

const onchain = contextModels.get('context.onchain');
const onchainFields = fieldIds(onchain).map((value) => value.toLowerCase());
for (const forbidden of ['privatekey', 'seed', 'secret', 'credential', 'signingmaterial']) {
  assert(!onchainFields.some((value) => value.replace(/[^a-z0-9]/g, '').includes(forbidden)));
}
assert(onchain.limitations.some((value) => value.includes('no signing')));

const resources = contextModels.get('context.resources');
const resourceFields = fieldIds(resources).map((value) => value.toLowerCase());
for (const forbidden of ['credential', 'token', 'password', 'secret', 'onetimecode']) {
  assert(!resourceFields.some((value) => value.replace(/[^a-z0-9]/g, '').includes(forbidden)));
}
assert(resources.limitations.some((value) => value.includes('Credential values')));

const sky = contextModels.get('context.sky');
const skyVocabulary = load('soter/contexts/sky/vocabulary.json');
const skyVocabularySchema = load('soter/contracts/context-vocabulary.schema.json');
const governedVocabularies = new Map([
  ['context.calendar', load('soter/contexts/calendar/vocabulary.json')],
  ['context.communications', load('soter/contexts/communications/semantics.vocabulary.json')],
  ['context.communications.collaboration', load('soter/contexts/communications/collaboration/vocabulary.json')],
  ['context.crm', load('soter/contexts/crm/vocabulary.json')],
  ['context.docs', load('soter/contexts/docs/vocabulary.json')],
  ['context.meetings', load('soter/contexts/meetings/vocabulary.json')],
  ['context.onchain', load('soter/contexts/onchain/vocabulary.json')],
  ['context.policy', load('soter/contexts/policy/vocabulary.json')],
  ['context.projects', load('soter/contexts/projects/vocabulary.json')],
  ['context.resources', load('soter/contexts/resources/vocabulary.json')],
  ['context.sky', skyVocabulary],
  ['context.tasks', load('soter/contexts/tasks/vocabulary.json')]
]);
for (const [packId, vocabulary] of governedVocabularies) {
  assert.deepEqual(validateJsonSchema(vocabulary, skyVocabularySchema), []);
  assert.deepEqual(contextVocabularySemanticErrors(vocabulary), []);
  assert.equal(vocabulary.$contract, 'soter://contracts/context-vocabulary/v1');
  assert.equal(vocabulary.pack, packId);
  assert.equal(vocabulary.subject, contextModels.get(packId).subject);
  assert.deepEqual(vocabulary.entries.map((entry) => entry.sequence),
    vocabulary.entries.map((_, index) => index + 1));
  assert.equal(new Set(vocabulary.entries.map((entry) => entry.id)).size,
    vocabulary.entries.length);
  assert.equal(new Set(vocabulary.entries.map((entry) => entry.term)).size,
    vocabulary.entries.length);
  assert(vocabulary.entries.every((entry) => {
    return entry.definition.length > 0 && entry.domain.length > 0;
  }));
  assert.deepEqual(vocabulary.invariants, {
    singleDefinitionSource: true,
    projectionCopiesAreNonCanonical: true,
    providerNeutral: true,
    runtimeAuthority: 'none'
  });
}
assert.deepEqual(governedVocabularies.get('context.calendar').entries.map((entry) => entry.term), [
  'commitment'
]);
assert.deepEqual(governedVocabularies.get('context.crm').entries.map((entry) => entry.term), [
  'org',
  'contact'
]);
const crmVocabulary = governedVocabularies.get('context.crm');
assert.equal(
  crmVocabulary.entries.some((entry) => entry.id === 'channel'),
  false,
  'CRM must not define Channel; collaboration channel meaning belongs to Communications'
);
assert.equal(crmVocabulary.invariants.runtimeAuthority, 'none');
assert.deepEqual(governedVocabularies.get('context.communications').entries.map((entry) => entry.term), [
  'communication scope',
  'conversation container',
  'participant identity',
  'private untrusted communication content',
  'typed cross-context link'
]);
assert.deepEqual(governedVocabularies.get('context.communications.collaboration').entries.map((entry) => entry.term), [
  'collaboration workspace',
  'channel',
  'direct message',
  'thread',
  'message',
  'collaboration participant',
  'channel directory',
  'channel ingestion policy'
]);
assert.deepEqual(governedVocabularies.get('context.meetings').entries.map((entry) => entry.term), [
  'meeting',
  'participant',
  'commitment',
  'meeting summary'
]);
assert.deepEqual(governedVocabularies.get('context.projects').entries.map((entry) => entry.term), [
  'project',
  'milestone',
  'work item',
  'project feed entry',
  'decision',
  'question'
]);
assert.deepEqual(governedVocabularies.get('context.tasks').entries.map((entry) => entry.term), [
  'task',
  'assignee',
  'next action date'
]);
assert.deepEqual(governedVocabularies.get('context.docs').entries.map((entry) => entry.term), [
  'doc',
  'private-workspace doc'
]);
assert.deepEqual(governedVocabularies.get('context.onchain').entries.map((entry) => entry.term), [
  'address'
]);
assert.deepEqual(governedVocabularies.get('context.policy').entries.map((entry) => entry.term), [
  'policy standard',
  'subject',
  'schema doc'
]);
assert.deepEqual(governedVocabularies.get('context.resources').entries.map((entry) => entry.term), [
  'resource'
]);
for (const [term, expected] of [
  ['org', ['context.crm', 'org']],
  ['contact', ['context.crm', 'contact']],
  ['channel', ['context.communications.collaboration', 'channel']],
  ['meeting', ['context.meetings', 'meeting']],
  ['project', ['context.projects', 'project']],
  ['task', ['context.tasks', 'task']],
  ['milestone', ['context.projects', 'milestone']],
  ['update', ['context.projects', 'project-feed-entry']],
  ['policy standard', ['context.policy', 'policy-standard']],
  ['subject', ['context.policy', 'subject']],
  ['schema doc', ['context.policy', 'schema-doc']],
  ['resource', ['context.resources', 'resource']]
]) {
  const [packId, entryId] = expected;
  const matches = [];
  for (const [candidatePack, vocabulary] of governedVocabularies) {
    for (const entry of vocabulary.entries) {
      const terms = [entry.term, ...entry.aliases].map((value) => value.toLowerCase());
      if (terms.includes(term)) matches.push([candidatePack, entry.id]);
    }
  }
  assert(matches.some(([candidatePack, candidateEntry]) => {
    return candidatePack === packId && candidateEntry === entryId;
  }), `${term} must resolve to its exact governed Context vocabulary owner`);
  if (term === 'channel') assert.deepEqual(matches, [expected]);
}
assert.deepEqual(skyVocabulary.entries.map((entry) => entry.term), [
  'Sky ecosystem',
  'Atlas',
  'spell',
  'MSC',
  'star',
  'Prime Agent',
  'NFAT',
  'Distribution Rewards',
  'Integration Boost',
  'Governance Accessibility Rewards',
  'Pioneer Chain Rewards',
  'Admin & Internal Ops',
  'Legal & Compliance',
  'Business Development',
  'Funding & Financials',
  'Settlement & Payments Ops',
  'DeFi Products',
  'Vault Curation',
  'SkyLink Bridge',
  'Agent Systems',
  'Branding Marketing & IP'
]);
const wrongSequenceVocabulary = structuredClone(skyVocabulary);
wrongSequenceVocabulary.entries[1].sequence = 1;
assert(contextVocabularySemanticErrors(wrongSequenceVocabulary).includes('sequence'));
const duplicateIdentityVocabulary = structuredClone(skyVocabulary);
duplicateIdentityVocabulary.entries[1].id = duplicateIdentityVocabulary.entries[0].id;
assert(contextVocabularySemanticErrors(duplicateIdentityVocabulary).includes('duplicate-id'));
const canonicalAliasVocabulary = structuredClone(skyVocabulary);
canonicalAliasVocabulary.entries[0].aliases = ['Atlas'];
assert(contextVocabularySemanticErrors(canonicalAliasVocabulary)
  .includes('alias-is-canonical-term'));
const hostileVocabulary = structuredClone(skyVocabulary);
hostileVocabulary.rawProviderResponse = { private: true };
assert(validateJsonSchema(hostileVocabulary, skyVocabularySchema).length > 0);
const localPathVocabulary = structuredClone(skyVocabulary);
localPathVocabulary.entries[0].sourceUris = ['file:///Users/private/sky.json'];
assert(validateJsonSchema(localPathVocabulary, skyVocabularySchema).length > 0);
assert(sky.limitations.some((value) => {
  return value.includes('governed context.sky vocabulary artifact owns');
}));
for (const packId of [
  'context.calendar',
  'context.crm',
  'context.docs',
  'context.meetings',
  'context.onchain',
  'context.policy',
  'context.projects',
  'context.resources',
  'context.tasks'
]) {
  assert(contextModels.get(packId).limitations.some((value) => {
    return value.includes(`governed ${packId} vocabulary artifact owns`);
  }));
}
assert(contextModels.get('context.communications').limitations.some((value) => {
  return value.includes('A specialization owns the exact scope, container, participant, and lifecycle vocabulary');
}));
assert(contextModels.get('context.communications.collaboration').limitations.some((value) => {
  return value.includes('specializes context.communications');
}));

const claudeAdapter = load('soter/hosts/claude/adapter.json');
const claudeProjection = load('soter/hosts/claude/projection.json');
assert.equal(claudeAdapter.$contract, 'soter://contracts/host-adapter/v2');
assert.equal(claudeProjection.$contract, 'soter://contracts/host-projection-definition/v2');
assert.equal(claudeAdapter.conformance.maxLevel, 'static');
assert.deepEqual(claudeAdapter.conformance.scenarios, []);
assert.deepEqual(claudeAdapter.projectionCollections, [{
  id: 'collection.claude.workflow-guides',
  role: 'skills',
  pathPrefix: '.claude/skills/',
  sourceContract: 'soter://contracts/workflow-guide/v2',
  selection: 'selected-pack-active'
}]);
assert.equal(claudeProjection.collections.length, 1);
assert.equal(claudeProjection.collections[0].id, 'collection.claude.workflow-guides');
assert.equal(claudeProjection.collections[0].selection, 'selected-pack-active');
assert.deepEqual(claudeProjection.outputs.map((output) => output.path), [
  'CLAUDE.md',
  '.mcp.json'
]);
assert.equal(
  claudeAdapter.mcpServers.find((server) => server.id === 'soter')?.configurationPath,
  '.mcp.json'
);
for (const unmanagedPath of [
  '.claude/settings.json',
  '.claude/hooks/hooks.json',
  '.claude/.claude-plugin/plugin.json'
]) {
  assert(!claudeProjection.outputs.some((output) => output.path === unmanagedPath));
}
assert(claudeAdapter.limitations.some((value) => {
  return value.includes('unselected and unmanaged skills remain excluded');
}));
assert(claudeProjection.limitations.some((value) => {
  return value.includes('unselected or unmanaged Claude skills')
    && value.includes('not silently adopted');
}));

const developmentCatalogLock = resolveConfiguration({
  root,
  configPath: 'soter/configurations/harness-development-catalog.config.json'
});
assert.deepEqual(
  Object.fromEntries(Object.entries(developmentCatalogLock.effectPolicies).map(([effect, policyValue]) => {
    return [effect, policyValue.mode];
  })),
  {
    read: 'allow',
    disclosure: 'allow',
    write: 'allow',
    dispatch: 'allow',
    destructive: 'prohibit'
  },
  'development catalog may allow only exact request-scoped worker and selected-host transport effects'
);
assert.equal(
  developmentCatalogLock.capabilities.length,
  0,
  'development effect policies must not create a provider or runtime capability route'
);
assert(developmentCatalogLock.effectPolicies.read.reason.includes('bound contained workspace'));
assert(developmentCatalogLock.effectPolicies.read.reason.includes('no provider-read authority'));
assert(developmentCatalogLock.effectPolicies.disclosure.reason.includes('ambient host transport boundary'));
assert(developmentCatalogLock.effectPolicies.disclosure.reason.includes('no onward or third-party disclosure authority'));
assert(developmentCatalogLock.effectPolicies.write.reason.includes('bound contained worker workspace'));
assert(developmentCatalogLock.effectPolicies.dispatch.reason.includes('separately trusted host executor'));
assert(!developmentCatalogLock.projections.some((output) => output.path.startsWith('.claude/skills/')),
  'development catalog must not realize unselected Claude workflow guides');

const claudeProjectionLock = resolveConfiguration({
  root,
  configPath: 'soter/configurations/claude-host-projection.config.json'
});
for (const policyValue of Object.values(claudeProjectionLock.effectPolicies)) {
  assert.equal(policyValue.mode, 'prohibit', 'static Claude host projection must prohibit every effect');
}
assert(!claudeProjectionLock.projections.some((output) => output.path.startsWith('.claude/skills/')),
  'static Claude host projection must not realize unselected Claude workflow guides');

const developmentConfiguration = load(
  'soter/configurations/harness-development-catalog.config.json'
);
const developmentSettings = load('soter/kernel/development-workspace.settings.json');
assert.equal(developmentSettings.pack, 'kernel.soter');
assert.equal(developmentSettings.required, false);
assert.deepEqual(
  Object.keys(developmentConfiguration.settings['kernel.soter']).sort(),
  developmentSettings.schema.required.slice().sort()
);
assert.equal(
  developmentConfiguration.settings['kernel.soter'].publicationPolicy,
  'explicit-user-authorization'
);
assert.equal(
  developmentConfiguration.settings['kernel.soter'].sessionIsolation,
  'one-session-one-worktree-one-branch'
);


process.stdout.write('Architecture foundations selftest passed: exact policy structure, bounded Context ownership, credential exclusions, governed Context vocabularies, request-scoped development effects, effect-free static host projection, and selected-guide-only Claude projection remain enforced.\n');
