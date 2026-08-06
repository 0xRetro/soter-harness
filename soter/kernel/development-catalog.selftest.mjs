#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintJson, readJson } from '../core/lib/canonical-json.mjs';
import {
  renderHostProjectionCandidates,
  renderWorkflowGuidePreviewCandidates
} from '../core/host-projections.mjs';
import { resolveConfiguration } from '../core/resolve.mjs';
import { verifySoter } from './verify.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), '..', '..');
const configPath = 'soter/configurations/harness-development-catalog.config.json';
const expected = [
  'auditing-a-schema-doc',
  'authoring-a-policy-standard',
  'forge',
  'promoting-pieces',
  'reviewing-forge-output',
  'running-evals',
  'validating-resources'
];
const privateSourceSentinels = [
  '39cd79b5-de38-81e7-81fd-d4b44354e1d6',
  "title 'Kernel seal'",
  'Leadership demo in 20 minutes',
  'Standup is in two minutes'
];

const verification = verifySoter(root);
assert.deepEqual(verification.violations, [], 'development catalog graph must remain valid');

const lock = resolveConfiguration({ root, configPath });
const selected = lock.packs
  .filter((pack) => pack.id.startsWith('automation.'))
  .map((pack) => pack.id.slice('automation.'.length))
  .sort();
assert.deepEqual(selected, expected, 'catalog must select the exact active workflow set');

assert.deepEqual(
  Object.fromEntries(Object.entries(lock.effectPolicies).map(([effect, policy]) => {
    return [effect, policy.mode];
  })),
  {
    read: 'allow',
    disclosure: 'prohibit',
    write: 'allow',
    dispatch: 'allow',
    destructive: 'prohibit'
  },
  'catalog must expose only the exact request-scoped local development effects'
);

const codexAdapter = readJson(path.join(root, 'soter/hosts/codex/adapter.json'));
const claudeAdapter = readJson(path.join(root, 'soter/hosts/claude/adapter.json'));
const projectionInput = {
  root,
  configurationId: lock.configuration.name,
  packIds: lock.packs.map((pack) => pack.id),
  capabilityIds: lock.capabilities.map((capability) => capability.id),
  effectPolicies: lock.effectPolicies
};
const activeCodexProjection = renderHostProjectionCandidates({
  ...projectionInput,
  adapter: codexAdapter
});
const activeClaudeProjection = renderHostProjectionCandidates({
  ...projectionInput,
  adapter: claudeAdapter
});
assert.equal(
  activeCodexProjection.outputs.filter((output) => output.role === 'skills').length,
  expected.length * 2,
  'every active guide must enter the Codex host candidate exactly once per output'
);
assert.equal(
  activeClaudeProjection.outputs.filter((output) => output.role === 'skills').length,
  expected.length,
  'every active guide must enter the Claude host candidate exactly once'
);

const codexPreview = renderWorkflowGuidePreviewCandidates({
  ...projectionInput,
  adapter: codexAdapter
});
const claudePreview = renderWorkflowGuidePreviewCandidates({
  ...projectionInput,
  adapter: claudeAdapter
});
assert.equal(codexPreview.previewOnly, true);
assert.deepEqual(codexPreview.authority, { execution: 'none', effect: 'none', approval: 'none' });
assert.equal(codexPreview.workflowGuides.length, expected.length);
assert.equal(codexPreview.outputs.length, expected.length * 2);
assert.equal(claudePreview.workflowGuides.length, expected.length);
assert.equal(claudePreview.outputs.length, expected.length);
assert.deepEqual(
  codexPreview,
  renderWorkflowGuidePreviewCandidates({ ...projectionInput, adapter: codexAdapter }),
  'Codex guide projection must be deterministic'
);

for (const slug of expected) {
  const codexSkill = codexPreview.outputs.find((output) => {
    return output.path === `.agents/skills/${slug}/SKILL.md`;
  });
  const codexMetadata = codexPreview.outputs.find((output) => {
    return output.path === `.agents/skills/${slug}/agents/openai.yaml`;
  });
  const claudeSkill = claudePreview.outputs.find((output) => {
    return output.path === `.claude/skills/${slug}/SKILL.md`;
  });
  assert(codexSkill && codexMetadata && claudeSkill, `${slug} must project through both hosts`);
  assert(codexSkill.content.startsWith(`---\nname: ${slug}\ndescription: `));
  assert(codexSkill.content.includes('This file is procedural guidance only.'));
  assert(codexSkill.content.includes('Guide state: `active`'));
  assert(codexMetadata.content.includes('allow_implicit_invocation: false'));
  assert(!claudeSkill.content.includes('disable-model-invocation:'));
  assert(claudeSkill.content.includes('soter_create_development_request'));
  assert(claudeSkill.content.includes('soter_record_development_result'));
  assert(claudeSkill.content.includes('grants no provider'));
  for (const sentinel of privateSourceSentinels) {
    assert(!codexSkill.content.includes(sentinel) && !claudeSkill.content.includes(sentinel));
  }

  const automationId = `automation.${slug}`;
  const definitionPath = `soter/automations/${slug}/definition.json`;
  const evaluationsPath = `soter/automations/${slug}/evaluations.json`;
  const guidePath = `soter/automations/${slug}/guide.json`;
  const definition = readJson(path.join(root, definitionPath));
  const evaluations = readJson(path.join(root, evaluationsPath));
  const guide = readJson(path.join(root, guidePath));
  const pack = readJson(path.join(root, `soter/packs/${automationId}/pack.json`));

  assert.equal(definition.id, automationId);
  assert.equal(definition.lifecycle.state, 'active-host-guided');
  assert.equal(definition.lifecycle.delivery, 'host-skill');
  assert.equal(evaluations.workflow, automationId);
  assert.equal(evaluations.lifecycle.state, 'active-host-guided');
  assert(evaluations.cases.length >= 3, `${slug} must retain at least three cases`);
  assert(evaluations.cases.some((item) => item.kind === 'happy-path'));
  assert(evaluations.cases.some((item) => item.kind === 'pressure'));
  assert(evaluations.cases.every((item) => item.prohibitedOutcomes.length > 0));
  assert.equal(guide.workflow.definitionFingerprint, fingerprintJson(definition));
  assert.equal(guide.workflow.evaluationSetFingerprint, fingerprintJson(evaluations));
  assert.equal(guide.status.state, 'active');
  assert.equal(guide.status.delivery, 'host-skill');
  assert.equal(guide.authority.executionAuthority, 'none');
  assert.equal(guide.authority.effectAuthority, 'none');
  assert.deepEqual(
    guide.stepDetails.map(({ id, sequence }) => ({ id, sequence })),
    definition.procedure.map(({ id, sequence }) => ({ id, sequence })),
    `${slug} guide steps must exactly cover its procedure`
  );
  assert.equal(pack.artifacts.filter((artifact) => {
    return artifact.path === guidePath && artifact.role === 'definition';
  }).length, 1, `${slug} pack must own its guide`);
  assert.deepEqual(pack.effects, []);
  assert.deepEqual(pack.authorities, []);
}

const onePackPreview = renderWorkflowGuidePreviewCandidates({
  ...projectionInput,
  adapter: codexAdapter,
  packIds: ['automation.forge']
});
assert.deepEqual(onePackPreview.workflowGuides.map((guide) => guide.id), ['workflow-guide.forge']);
assert.equal(onePackPreview.outputs.length, 2);

process.stdout.write(
  'Harness Development Catalog selftest passed: seven exact active workflows, deterministic Codex and Claude projections, request-scoped effects, behavior cases, and private-source exclusion passed.\n'
);
