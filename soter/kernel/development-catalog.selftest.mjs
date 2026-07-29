#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  'pushing-to-notion',
  'reviewing-forge-output',
  'running-evals',
  'updating-a-notion-page',
  'validating-resources',
  'writing-adrs'
];
const hostGuided = [
  'auditing-a-schema-doc',
  'authoring-a-policy-standard',
  'forge',
  'promoting-pieces',
  'reviewing-forge-output',
  'running-evals',
  'validating-resources'
];
const retirementCandidates = [
  'pushing-to-notion',
  'updating-a-notion-page',
  'writing-adrs'
];
const privateLegacySentinels = [
  '39cd79b5-de38-81e7-81fd-d4b44354e1d6',
  "title 'Kernel seal'",
  'Leadership demo in 20 minutes',
  'Standup is in two minutes'
];

const verification = verifySoter(root);
assert.equal(
  verification.violations.filter((item) => item.level !== 'warn').length,
  0,
  'development catalog graph must remain valid'
);
assert.equal(
  verification.violations.filter((item) => item.level === 'warn').length,
  0,
  'development catalog graph must remain warning-free'
);

const lock = resolveConfiguration({ root, configPath });
const selected = lock.packs
  .filter((pack) => pack.id.startsWith('automation.'))
  .map((pack) => pack.id.slice('automation.'.length))
  .sort();
assert.deepEqual(selected, expected, 'catalog must select the exact normalized workflow set');

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
  hostGuided.length * 2,
  'final active guides must enter the Codex host realization candidate exactly once per output'
);
assert.equal(
  activeClaudeProjection.outputs.filter((output) => output.role === 'skills').length,
  hostGuided.length,
  'final active guides must enter the Claude host realization candidate exactly once'
);
for (const slug of retirementCandidates) {
  assert(
    !activeCodexProjection.outputs.some((output) => output.path.includes(`/${slug}/`))
      && !activeClaudeProjection.outputs.some((output) => output.path.includes(`/${slug}/`)),
    `${slug} must remain absent from both active host realization candidates`
  );
}
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
assert.equal(codexPreview.workflowGuides.length, hostGuided.length);
assert.equal(codexPreview.outputs.length, hostGuided.length * 2);
assert.equal(claudePreview.workflowGuides.length, hostGuided.length);
assert.equal(claudePreview.outputs.length, hostGuided.length);
assert.deepEqual(
  codexPreview,
  renderWorkflowGuidePreviewCandidates({ ...projectionInput, adapter: codexAdapter }),
  'active Codex guide projection must be byte-deterministic'
);
for (const slug of hostGuided) {
  const codexSkill = codexPreview.outputs.find((output) => {
    return output.path === `.agents/skills/${slug}/SKILL.md`;
  });
  const codexMetadata = codexPreview.outputs.find((output) => {
    return output.path === `.agents/skills/${slug}/agents/openai.yaml`;
  });
  const claudeSkill = claudePreview.outputs.find((output) => {
    return output.path === `.claude/skills/${slug}/SKILL.md`;
  });
  assert(codexSkill && codexMetadata && claudeSkill, `${slug} must project through both host formats`);
  assert(codexSkill.content.startsWith(`---\nname: ${slug}\ndescription: `));
  assert(codexSkill.content.includes('This file is procedural guidance only.'));
  assert(codexSkill.content.includes('Guide state: `active`'));
  assert(codexSkill.content.includes('- `write`: `allow`'));
  assert(codexMetadata.content.includes('allow_implicit_invocation: false'));
  assert(claudeSkill.content.includes('disable-model-invocation: true'));
  assert(!codexSkill.content.includes('.claude/skills/'));
  for (const sentinel of privateLegacySentinels) {
    assert(!codexSkill.content.includes(sentinel) && !claudeSkill.content.includes(sentinel));
  }
}
const onePackPreview = renderWorkflowGuidePreviewCandidates({
  ...projectionInput,
  adapter: codexAdapter,
  packIds: ['automation.forge']
});
assert.deepEqual(onePackPreview.workflowGuides.map((guide) => guide.id), ['workflow-guide.forge']);
assert.equal(onePackPreview.outputs.length, 2, 'preview must project only explicitly selected packs');

const legacyInventory = readJson(path.join(root, 'soter/migrations/legacy-inventory.json'));
function exactRemovedSource(source, label) {
  const item = legacyInventory.items.find((candidate) => {
    return candidate.sourcePath === source.legacyPath;
  });
  assert(item, `${label} must retain one exact inventory tombstone`);
  assert.equal(source.presence, 'removed', `${label} source must be removed`);
  assert.equal(source.legacyFingerprint, item.sourceFingerprint, `${label} fingerprint must remain exact`);
  assert.equal(item.sourcePresence, 'removed', `${label} inventory source must be removed`);
  assert(['migrated', 'retired'].includes(item.state), `${label} inventory state must be final`);
}

for (const slug of expected) {
  const automationId = `automation.${slug}`;
  const definitionPath = `soter/automations/${slug}/definition.json`;
  const evaluationsPath = `soter/automations/${slug}/evaluations.json`;
  const guidePath = `soter/automations/${slug}/guide.json`;
  const definition = readJson(path.join(root, definitionPath));
  const evaluations = readJson(path.join(root, evaluationsPath));
  const guide = readJson(path.join(root, guidePath));
  const pack = readJson(path.join(root, `soter/packs/${automationId}/pack.json`));

  assert.equal(definition.id, automationId);
  const retires = retirementCandidates.includes(slug);
  assert.equal(definition.lifecycle.state, retires ? 'retired' : 'active-host-guided');
  if (retires) {
    assert.equal(definition.lifecycle.retirement.state, 'complete');
    assert.equal(definition.lifecycle.retirement.reasonCode, 'WORKFLOW_RETIRED');
    assert.equal(definition.lifecycle.retirement.proceduralAuthority, 'none');
    assert.equal(definition.lifecycle.retirement.fallback, 'removed');
    assert.equal(definition.lifecycle.retirement.evidence.length, 1);
    assert.equal(definition.lifecycle.retirement.permittedNextAction, 'inspect-replacement');
    assert.equal(definition.lifecycle.developmentRequest, null);
    assert.equal(definition.lifecycle.developmentResult, null);
  } else {
    assert.equal(definition.lifecycle.activation.state, 'active');
    assert.equal(definition.lifecycle.activation.reasonCode, 'WORKFLOW_HOST_GUIDANCE_ACTIVE');
    assert.equal(definition.lifecycle.activation.proceduralAuthority, 'target');
    assert.equal(definition.lifecycle.activation.delivery, 'host-skill');
    assert(['passed', 'intentional-change'].includes(
      definition.lifecycle.activation.behaviorParity
    ));
    assert.deepEqual(
      definition.lifecycle.activation.evidence.map((item) => item.host).sort(),
      ['claude', 'codex']
    );
    assert.equal(
      definition.lifecycle.activation.permittedNextAction,
      'invoke-through-selected-host'
    );
    assert.equal(definition.lifecycle.development.requestContract.id, 'soter://contracts/development-request/v1');
    assert.equal(definition.lifecycle.development.resultContract.id, 'soter://contracts/development-result/v1');
    assert.deepEqual([...definition.lifecycle.development.supportedHosts].sort(), ['claude', 'codex']);
  }
  assert.equal(definition.privacy.rawSourceIncluded, false);
  exactRemovedSource(definition.source, `${slug} definition`);
  assert.equal(evaluations.workflow, automationId);
  assert.equal(evaluations.lifecycle.state, retires ? 'retired' : 'active-host-guided');
  assert.equal(
    retires ? evaluations.lifecycle.retirement : evaluations.lifecycle.activation,
    retires ? 'complete' : 'active'
  );
  assert.equal(evaluations.evaluationPolicy.runner, retires ? 'none' : 'core-development-request');
  assert.equal(evaluations.evaluationPolicy.authority, retires ? 'none' : 'request-bound-evidence-only');
  assert.equal(evaluations.privacy.rawPromptsIncluded, false);
  assert(evaluations.cases.length >= 3, `${slug} must retain at least three normalized cases`);
  for (const item of evaluations.cases) {
    exactRemovedSource(item.source, `${slug}/${item.id}`);
  }
  assert.equal(guide.id, `workflow-guide.${slug}`);
  assert.equal(guide.workflow.id, automationId);
  assert.equal(guide.workflow.version, definition.version);
  assert.equal(guide.workflow.definitionPath, definitionPath);
  assert.equal(guide.workflow.definitionFingerprint, fingerprintJson(definition));
  assert.equal(guide.workflow.evaluationSetPath, evaluationsPath);
  assert.equal(guide.workflow.evaluationSetFingerprint, fingerprintJson(evaluations));
  assert.equal(guide.skill.name, slug);
  assert.equal(guide.skill.invocation, 'explicit-only');
  assert.equal(guide.status.state, retires ? 'retired' : 'active');
  assert.equal(guide.status.proceduralAuthority, retires ? 'none' : 'target');
  assert(
    retires
      ? guide.status.behaviorParity === 'intentional-change'
      : ['passed', 'intentional-change'].includes(guide.status.behaviorParity)
  );
  assert.equal(guide.status.delivery, retires ? 'unavailable' : 'host-skill');
  assert.equal(guide.status.evidence.length, retires ? 1 : 2);
  assert.equal(
    guide.status.permittedNextAction,
    retires ? 'inspect-replacement' : 'invoke-through-selected-host'
  );
  assert.equal(guide.authority.executionAuthority, 'none');
  assert.equal(guide.authority.effectAuthority, 'none');
  assert.equal(guide.authority.approvalAuthority, 'none');
  assert.equal(guide.authority.providerTransactionAuthority, 'none');
  assert.equal(guide.source.legacyPath, definition.source.legacyPath);
  assert.equal(guide.source.legacyFingerprint, definition.source.legacyFingerprint);
  exactRemovedSource(guide.source, `${slug} guide`);
  assert.deepEqual(
    guide.stepDetails.map(({ id, sequence }) => ({ id, sequence })),
    definition.procedure.map(({ id, sequence }) => ({ id, sequence })),
    `${slug} guide steps must exactly cover the normalized procedure`
  );
  assert.equal(new Set(guide.gotchas.map((item) => item.id)).size, guide.gotchas.length);
  assert.equal(new Set(guide.references.map((item) => item.id)).size, guide.references.length);
  assert.equal(
    pack.artifacts.filter((artifact) => {
      return artifact.path === guidePath && artifact.role === 'definition';
    }).length,
    1,
    `${slug} pack must own the exact workflow guide`
  );
  assert.equal(pack.operator, undefined);
  assert.deepEqual(pack.effects, []);
  assert.deepEqual(pack.authorities, []);
  assert.deepEqual(pack.capabilities, { requires: [], provides: [] });

  const sanitized = JSON.stringify({ definition, evaluations, guide });
  for (const sentinel of privateLegacySentinels) {
    assert(!sanitized.includes(sentinel), `${slug} normalized output leaked legacy prompt material`);
  }
}

console.log('Harness Development Catalog selftest: seven exact active host-guided workflows, three completed retirements, deterministic Codex and Claude projections, active-only realization, removed-source tombstones, request-scoped local development effects, and raw-prompt exclusion passed.');
