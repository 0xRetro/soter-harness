#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fingerprintFile,
  fingerprintJson,
  readJson,
  writeJson
} from '../core/lib/canonical-json.mjs';
import {
  workflowGuideContentFingerprintMatches
} from './workflow-guides.mjs';

const BASELINE_BRANCH = 'soter-harness-v1';
const BASELINE_COMMIT = 'c54a50a48db18b70e7e2519ca81b75ad1fc6ce66';
const CONTRACT = 'soter://contracts/legacy-inventory/v2';
const INVENTORY_PATH = 'soter/migrations/legacy-inventory.json';
const LIMITATIONS = [
  'Mapped means one or more target responsibilities are identified; it does not establish target parity, readiness, verification, health, or retirement safety.',
  'A source artifact remains canonical for every retained binding until applicable evidence proves that exact responsibility migrated or retired and every configured dependency on that fallback is removed.'
];
const RETIREMENT = 'Prove target parity or record the intentional behavior change, remove every configured legacy dependency, attach current evidence, and verify rollback before deleting this fallback.';
const EVIDENCE_LEVELS = ['static', 'graph', 'fixture', 'agent', 'contained', 'canary', 'monitored'];
const scriptFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptFile), '..', '..');
const SKIP_EVIDENCE_CONTENT = Symbol('skip-evidence-content');

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portable(relative) {
  return relative.split(path.sep).join('/');
}

function walkLegacy(root) {
  const legacyRoot = path.join(root, '.claude');
  const files = [];
  if (!fs.existsSync(legacyRoot)) return files;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = portable(path.relative(root, absolute));
      if (relative === '.claude/worktrees' || relative.startsWith('.claude/worktrees/')) continue;
      if (entry.isSymbolicLink()) throw new Error('Legacy inventory rejects symlinks: ' + relative);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ absolute, relative });
      else throw new Error('Legacy inventory accepts regular files only: ' + relative);
    }
  };
  visit(legacyRoot);
  return files.sort((left, right) => compareCodepoint(left.relative, right.relative));
}

export function fingerprintLegacySource(root, sourcePath) {
  const resolvedRoot = path.resolve(root);
  const sourceFile = path.resolve(resolvedRoot, sourcePath);
  const confined = path.relative(resolvedRoot, sourceFile);
  if (!confined || confined === '..' || confined.startsWith('..' + path.sep)
    || path.isAbsolute(confined)) {
    throw new Error('Legacy source path escapes the repository: ' + sourcePath);
  }
  if (fs.existsSync(sourceFile)) {
    const stat = fs.lstatSync(sourceFile);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Legacy source must be one regular non-symlink file: ' + sourcePath);
    }
    return fingerprintFile(sourceFile);
  }
  const inventoryFile = path.join(resolvedRoot, INVENTORY_PATH);
  if (!fs.existsSync(inventoryFile)) {
    throw new Error('Missing legacy source has no governed inventory: ' + sourcePath);
  }
  const inventory = readJson(inventoryFile);
  const matches = inventory.items?.filter((item) => item.sourcePath === sourcePath) || [];
  if (matches.length !== 1
    || matches[0].sourcePresence !== 'removed'
    || !['migrated', 'retired'].includes(matches[0].state)
    || !/^sha256:[a-f0-9]{64}$/.test(matches[0].sourceFingerprint || '')
    || matches[0].targets.some((target) => {
      return !['migrated', 'retired'].includes(target.state)
        || target.fallback !== 'removed'
        || !target.evidence?.length;
    })) {
    throw new Error('Missing legacy source has no exact governed migration tombstone: '
      + sourcePath);
  }
  return matches[0].sourceFingerprint;
}

const implemented = new Map([
  ['capturing-a-process', ['automation.process-capture', 'soter/packs/automation.process-capture/pack.json']],
  ['capturing-a-feature', ['automation.feature-capture', 'soter/packs/automation.feature-capture/pack.json']],
  ['capturing-a-task', ['automation.task-capture', 'soter/packs/automation.task-capture/pack.json']],
  ['capturing-an-org', ['automation.organization-capture', 'soter/packs/automation.organization-capture/pack.json']],
  ['defining-a-feature', ['automation.feature-definition', 'soter/packs/automation.feature-definition/pack.json']],
  ['processing-a-meeting', ['automation.meeting-intake', 'soter/packs/automation.meeting-intake/pack.json']],
  ['processing-email', ['automation.email-triage', 'soter/packs/automation.email-triage/pack.json']],
  ['ingesting-slack-channels', ['automation.slack-channel-ingestion', 'soter/packs/automation.slack-channel-ingestion/pack.json']],
  ['reviewing-a-repo', ['automation.repository-review', 'soter/packs/automation.repository-review/pack.json']],
  ['red-teaming-a-process', ['automation.process-red-team', 'soter/packs/automation.process-red-team/pack.json']],
  ['updating-project-status', ['automation.project-pulse', 'soter/packs/automation.project-pulse/pack.json']]
]);

const definitionOnly = new Set([
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
]);

function plannedPath(lane, sourcePath) {
  const suffix = sourcePath.slice('.claude/'.length).replace(/[^A-Za-z0-9._+/-]/g, '-');
  return `soter/planned/${lane}/${suffix}`;
}

function responsibilityFor(targetId) {
  const layer = targetId.split('.')[0];
  return {
    kernel: 'Kernel governance and mechanical enforcement responsibility.',
    core: 'Core runtime, transaction, and evidence responsibility.',
    context: 'Portable domain meaning and authority responsibility.',
    automation: 'Outcome orchestration and review responsibility.',
    integration: 'Provider transport and translation responsibility.',
    host: 'Host-specific projection and delivery responsibility.',
    configuration: 'User-selected authority, binding, and policy responsibility.'
  }[layer] || 'Explicit target responsibility for this legacy behavior.';
}

function roleFor(sourcePath) {
  if (sourcePath.startsWith('.claude/evals/')) return sourcePath.endsWith('.md') ? 'evaluation' : 'fixture';
  if (sourcePath.startsWith('.claude/skills/')) return sourcePath.endsWith('.json') ? 'fixture' : 'skill';
  if (sourcePath.startsWith('.claude/systems/')) return 'system';
  if (sourcePath.startsWith('.claude/standards/')) return 'standard';
  if (sourcePath.startsWith('.claude/templates/')) return 'template';
  if (sourcePath.startsWith('.claude/rules/')) return 'rule';
  if (sourcePath.startsWith('.claude/scripts/') || sourcePath.startsWith('.claude/agents/')) return 'runtime-tool';
  if (sourcePath === '.claude/LEXICON.md' || sourcePath === '.claude/RUBRIC.md' || sourcePath === '.claude/evals/README.md') return 'guide';
  return 'host-config';
}

function scenarioForSource(root, targetId, sourcePath) {
  const slice = targetId.slice('automation.'.length);
  const directory = path.join(root, 'soter', 'scenarios', slice);
  if (!fs.existsSync(directory)) return null;
  const matches = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(directory, entry.name))
    .filter((file) => readJson(file).sourceCases?.includes(sourcePath));
  if (matches.length > 1) {
    throw new Error('Legacy evaluation maps to more than one target scenario: ' + sourcePath);
  }
  return matches.length ? portable(path.relative(root, matches[0])) : null;
}

function mappingFor(root, sourcePath) {
  if (sourcePath === '.claude/.mcp.json') {
    return ['existing', 'host.claude', 'soter/hosts/claude/projection.json', 'Retains the exact v1 MCP declaration identity as a migration tombstone; the governed Claude host projection owns generated MCP configuration and no checked-in legacy host file is runtime authority after completion.'];
  }
  if (sourcePath === '.claude/.claude-plugin/plugin.json') {
    return ['existing', 'host.claude', 'soter/hosts/claude/adapter.json', 'Maps legacy Claude packaging metadata to the governed Claude host adapter without claiming packaging or launch parity.'];
  }
  if (sourcePath === '.claude/scripts/check.mjs') {
    return ['existing', 'kernel.soter', 'soter/kernel/verify.mjs', 'Maps legacy static enforcement to the Kernel verifier while preserving the v1 checker until every legacy rule has equivalent or intentionally changed coverage.'];
  }
  if (sourcePath === '.claude/systems/email.md') {
    return ['existing', 'context.email', 'soter/packs/context.email/pack.json', 'Maps portable mailbox meaning to Context Email while legacy connected delivery remains canonical.'];
  }
  if (sourcePath === '.claude/systems/crm.md') {
    return ['existing', 'context.crm', 'soter/packs/context.crm/pack.json', 'Maps portable CRM meaning to Context CRM while legacy connected delivery remains canonical.'];
  }
  if (sourcePath === '.claude/skills/processing-email/inbox-window.fixture.json') {
    return ['existing', 'integration.gmail', 'soter/fixtures/providers/gmail/inbox-window.json', 'Maps the contained legacy mailbox oracle to the normalized Gmail provider fixture without including live mailbox data.'];
  }
  if (sourcePath === '.claude/skills/pushing-to-notion/targets.md') {
    return ['existing', 'context.crm', 'soter/contexts/crm/records.model.json', 'Maps the CRM portion of mixed target knowledge to portable CRM meaning while other Context, Configuration, and Integration responsibilities remain independently classified.'];
  }
  if (sourcePath === '.claude/skills/pushing-to-notion/SKILL.md') {
    return ['existing', 'integration.notion', 'soter/packs/integration.notion/pack.json', 'Maps provider translation responsibility to Integration Notion without claiming complete legacy write parity.'];
  }
  if (sourcePath === '.claude/standards/shaping-a-policy-standard.md') {
    return ['existing', 'context.policy', 'soter/contexts/policy/standard.model.json', 'Maps portable policy-standard identity, ordered shape, coverage, lifecycle, and change control to Policy Context without claiming authoring runtime parity.'];
  }
  if (sourcePath === '.claude/standards/writing-records-to-notion.md') {
    return ['existing', 'integration.notion', 'soter/packs/integration.notion/pack.json', 'Maps provider-specific Notion translation and effect responsibility to Integration while the complete shared write spine remains a retained multi-target migration.'];
  }

  const evalMatch = sourcePath.match(/^\.claude\/evals\/([^/]+)\/(.+)$/);
  if (evalMatch) {
    const workflow = evalMatch[1];
    if (implemented.has(workflow)) {
      const [targetId] = implemented.get(workflow);
      const scenarioPath = scenarioForSource(root, targetId, sourcePath);
      if (scenarioPath) {
        return ['existing', targetId, scenarioPath, 'Maps this legacy case to its exact implemented vertical-slice scenario; individual case parity remains not evaluated.'];
      }
      return ['planned', targetId, plannedPath(targetId, sourcePath), 'Assigns this legacy case to the implemented Automation but keeps its target scenario planned because no exact source-case mapping exists yet.'];
    }
    if (definitionOnly.has(workflow)) {
      return [
        'existing',
        `automation.${workflow}`,
        `soter/automations/${workflow}/evaluations.json`,
        'Maps this legacy case to one exact normalized behavior expectation while runtime parity and behavior authority remain explicitly unavailable.'
      ];
    }
    return ['planned', `automation.${workflow}`, plannedPath(`automation.${workflow}`, sourcePath), 'Assigns this legacy evaluation to its future provider-neutral Automation slice without claiming that the scenario exists or passes.'];
  }

  const skillMatch = sourcePath.match(/^\.claude\/skills\/([^/]+)\/(.+)$/);
  if (skillMatch) {
    const workflow = skillMatch[1];
    if (implemented.has(workflow)) {
      const [targetId, targetPath] = implemented.get(workflow);
      return ['existing', targetId, targetPath, 'Maps this legacy workflow to an implemented provider-neutral Automation pack while legacy delivery remains canonical until parity is proven.'];
    }
    if (definitionOnly.has(workflow)) {
      return [
        'existing',
        `automation.${workflow}`,
        `soter/automations/${workflow}/guide.json`,
        'Maps this legacy workflow to one exact source-bound candidate guide while the legacy procedure remains canonical, host delivery is preview-only, and runtime authority is unavailable.'
      ];
    }
    return ['planned', `automation.${workflow}`, plannedPath(`automation.${workflow}`, sourcePath), 'Assigns this legacy workflow to a future provider-neutral Automation pack without claiming implementation, parity, or retirement safety.'];
  }

  const systemMatch = sourcePath.match(/^\.claude\/systems\/([^/]+)\.md$/);
  if (systemMatch) {
    const system = systemMatch[1];
    const existingSystems = new Map([
      ['calendar', ['context.calendar', 'soter/contexts/calendar/records.model.json']],
      ['docs', ['context.docs', 'soter/contexts/docs/records.model.json']],
      ['lexicon', ['kernel.soter', 'soter/kernel/development-governance.json']],
      ['onchain', ['context.onchain', 'soter/contexts/onchain/records.model.json']],
      ['platform', ['host.claude', 'soter/hosts/claude/adapter.json']],
      ['policy', ['context.policy', 'soter/contexts/policy/standard.model.json']],
      ['project-management', ['context.crm', 'soter/contexts/crm/records.model.json']],
      ['publishing', ['automation.pushing-to-notion', 'soter/automations/pushing-to-notion/definition.json']],
      ['resources', ['context.resources', 'soter/contexts/resources/records.model.json']],
      ['schema-audit', ['automation.auditing-a-schema-doc', 'soter/automations/auditing-a-schema-doc/definition.json']],
      ['sky', ['context.sky', 'soter/contexts/sky/records.model.json']]
    ]);
    if (existingSystems.has(system)) {
      const [targetId, targetPath] = existingSystems.get(system);
      return ['existing', targetId, targetPath, 'Maps this legacy system to its exact current provider-neutral owner while retaining the source until full responsibility parity or an intentional change is evidenced.'];
    }
    const kernelSystems = new Set(['authoring', 'enforcement', 'eval', 'governance', 'lexicon', 'platform', 'policy', 'resources', 'schema-audit', 'standards', 'template']);
    const targetId = kernelSystems.has(system) ? 'kernel.soter' : `context.${system}`;
    return ['planned', targetId, plannedPath(targetId, sourcePath), 'Assigns the legacy system meaning to an explicit target responsibility; no target implementation or authority switch is claimed.'];
  }

  if (sourcePath.startsWith('.claude/hooks/') || sourcePath === '.claude/settings.json') {
    return ['existing', 'host.claude', 'soter/hosts/claude/adapter.json', 'Maps legacy Claude-only runtime configuration to the governed host adapter while current deterministic realization deliberately does not adopt it.'];
  }
  if (sourcePath === '.claude/rules/parallel-sessions.md') {
    return ['existing', 'configuration.harness-development-catalog', 'soter/configurations/harness-development-catalog.config.json', 'Maps user-selected repository development policy to the exact governed configuration while Kernel owns the settings shape and hosts own delivery.'];
  }
  if (sourcePath === '.claude/LEXICON.md') {
    return ['existing', 'kernel.soter', 'soter/kernel/development-governance.json', 'Maps artifact vocabulary governance to Kernel while each domain vocabulary family remains independently owned by its Context, Automation, or Integration target.'];
  }

  return ['planned', 'kernel.soter', plannedPath('kernel.soter', sourcePath), 'Assigns this legacy governance or authoring artifact to the Kernel migration lane without claiming target parity or retirement safety.'];
}

function defaultMetadata(root, sourcePath) {
  const [status, id, targetPath, why] = mappingFor(root, sourcePath);
  return {
    sourceRole: roleFor(sourcePath),
    targets: [{
      status,
      id,
      path: targetPath,
      responsibility: responsibilityFor(id),
      state: 'mapped',
      canonicalAuthority: 'legacy',
      fallback: 'retained',
      parity: 'not-evaluated',
      evidence: []
    }],
    why,
    retirementCriteria: RETIREMENT
  };
}

function normalizeTargets(metadata) {
  if (Array.isArray(metadata.targets)) {
    return metadata.targets.map((target) => structuredClone(target));
  }
  if (!metadata.target) {
    throw new Error('Legacy inventory item has no target responsibility.');
  }
  return [{
    ...structuredClone(metadata.target),
    responsibility: responsibilityFor(metadata.target.id),
    state: metadata.state,
    canonicalAuthority: metadata.canonicalAuthority,
    fallback: metadata.fallback,
    parity: metadata.parity,
    evidence: structuredClone(metadata.evidence || [])
  }];
}

function aggregateState(targets) {
  const states = targets.map((target) => target.state);
  if (states.every((state) => state === 'retired')) return 'retired';
  if (states.every((state) => ['migrated', 'retired'].includes(state))
    && states.includes('migrated')) return 'migrated';
  if (states.some((state) => state !== 'mapped')) return 'bridged';
  return 'mapped';
}

function normalizedItem(entry, sourcePath, sequence, metadata) {
  const targets = normalizeTargets(metadata)
    .sort((left, right) => compareCodepoint(left.id, right.id)
      || compareCodepoint(left.path, right.path));
  return {
    sequence,
    sourcePath,
    sourceFingerprint: entry ? fingerprintFile(entry.absolute) : metadata.sourceFingerprint,
    sourcePresence: entry ? 'present' : 'removed',
    sourceRole: metadata.sourceRole,
    state: aggregateState(targets),
    targets,
    why: metadata.why,
    retirementCriteria: metadata.retirementCriteria
  };
}

function resolveGovernedPath(root, relative, label) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const absolute = path.resolve(root, relative);
  const confined = path.relative(root, absolute);
  if (!confined || confined === '..' || confined.startsWith('..' + path.sep) || path.isAbsolute(confined)) {
    throw new Error(`Legacy inventory ${label} escapes the repository: ${relative}`);
  }
  if (!fs.existsSync(absolute)) {
    throw new Error(`Legacy inventory ${label} is missing: ${relative}`);
  }
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Legacy inventory ${label} must be a regular non-symlink file: ${relative}`);
  }
  const real = fs.realpathSync(absolute);
  const realConfined = path.relative(resolvedRoot, real);
  if (!realConfined || realConfined === '..' || realConfined.startsWith('..' + path.sep)
    || path.isAbsolute(realConfined)) {
    throw new Error(`Legacy inventory ${label} resolves outside the repository: ${relative}`);
  }
  return absolute;
}

function assertEvidenceBindings(root, item, binding, evidenceOverlay = null) {
  if (!binding.evidence.length) return;
  const targetFile = resolveGovernedPath(root, binding.path, 'target');
  const target = readJson(targetFile);
  if (target.$contract === 'soter://contracts/workflow-guide/v2'
    && !workflowGuideContentFingerprintMatches(target)) {
    throw new Error(`Legacy inventory workflow-guide target content fingerprint is stale: ${binding.path}`);
  }
  const targetFingerprint = target.$contract === 'soter://contracts/workflow-guide/v2'
    ? target.contentFingerprint
    : fingerprintJson(target);
  if (evidenceOverlay === SKIP_EVIDENCE_CONTENT) return;
  for (const reference of binding.evidence) {
    const evidence = evidenceOverlay?.get(reference) || readJson(
      resolveGovernedPath(root, reference, 'evidence')
    );
    if (evidence.$contract !== 'soter://contracts/evidence/v2' || evidence.result !== 'passed') {
      throw new Error(`Legacy inventory evidence must be a passed evidence/v2 record: ${reference}`);
    }
    if (['migrated', 'retired'].includes(binding.state) && evidence.claimFamily !== 'migration') {
      throw new Error(`Legacy inventory ${binding.state} binding requires migration-family evidence: ${item.sourcePath} -> ${binding.path}`);
    }
    const sourceArtifacts = evidence.artifacts?.filter((artifact) => {
      return ['source-case', 'migration-source'].includes(artifact.role)
        && artifact.path === item.sourcePath;
    }) || [];
    const exactSource = sourceArtifacts.length === 1
      && sourceArtifacts[0].fingerprint === item.sourceFingerprint;
    if (target.$contract === 'soter://contracts/scenario/v1') {
      if (!target.sourceCases?.includes(item.sourcePath)) {
        throw new Error(`Legacy inventory target scenario does not cite its exact source case: ${item.sourcePath}`);
      }
      if (['migrated', 'retired'].includes(binding.state)) {
        const migrationTargets = evidence.artifacts?.filter((artifact) => {
          return artifact.role === 'migration-target' && artifact.path === binding.path;
        }) || [];
        const exactMigrationTarget = migrationTargets.length === 1
          && migrationTargets[0].fingerprint === targetFingerprint;
        if (!exactMigrationTarget || !exactSource) {
          throw new Error(`Legacy inventory completion evidence does not bind the exact legacy source and target scenario: ${reference}`);
        }
      } else {
        const level = EVIDENCE_LEVELS.indexOf(evidence.evaluator?.level);
        if (level < EVIDENCE_LEVELS.indexOf('fixture')) {
          throw new Error(`Legacy inventory scenario bridge requires fixture-or-higher evidence: ${reference}`);
        }
        const scenarioArtifacts = evidence.artifacts?.filter((artifact) => {
          return artifact.role === 'scenario' && artifact.path === binding.path;
        }) || [];
        const exactScenario = scenarioArtifacts.length === 1
          && scenarioArtifacts[0].id === target.id
          && scenarioArtifacts[0].fingerprint === targetFingerprint;
        if (!exactScenario || !exactSource) {
          throw new Error(`Legacy inventory evidence does not bind the exact legacy source and target scenario: ${reference}`);
        }
      }
    } else {
      const targetArtifacts = evidence.artifacts?.filter((artifact) => {
        return artifact.role === 'migration-target' && artifact.path === binding.path;
      }) || [];
      const exactTarget = evidence.claimFamily === 'migration'
        && targetArtifacts.length === 1
        && targetArtifacts[0].fingerprint === targetFingerprint;
      if (!exactSource || !exactTarget) {
        throw new Error(`Legacy inventory non-scenario bridge requires exact migration-source and migration-target evidence: ${reference}`);
      }
    }
  }
}

function assertBindingStateSemantics(root, item, binding, evidenceOverlay = null) {
  if (binding.state === 'mapped') {
    if (binding.canonicalAuthority !== 'legacy'
      || binding.fallback !== 'retained'
      || binding.parity !== 'not-evaluated'
      || binding.evidence.length) {
      throw new Error('Mapped inventory binding overstates migration progress: '
        + item.sourcePath + ' -> ' + binding.path);
    }
    return;
  }
  if (binding.state === 'bridged') {
    if (binding.canonicalAuthority !== 'legacy'
      || binding.status !== 'existing'
      || binding.fallback !== 'retained'
      || binding.parity !== 'not-evaluated'
      || !binding.evidence.length) {
      throw new Error('Bridged inventory binding overstates authority or lacks an existing target, retained fallback, or evidence: '
        + item.sourcePath + ' -> ' + binding.path);
    }
    assertEvidenceBindings(root, item, binding, evidenceOverlay);
    return;
  }
  if (binding.state === 'migrated') {
    if (binding.canonicalAuthority !== 'target'
      || binding.status !== 'existing'
      || binding.fallback !== 'removed'
      || !['intentional-change', 'proven'].includes(binding.parity)
      || !binding.evidence.length) {
      throw new Error('Migrated inventory binding lacks target authority, parity, fallback removal, or evidence: '
        + item.sourcePath + ' -> ' + binding.path);
    }
    assertEvidenceBindings(root, item, binding, evidenceOverlay);
    return;
  }
  if (binding.state === 'retired') {
    if (binding.canonicalAuthority !== 'none'
      || binding.status !== 'existing'
      || binding.fallback !== 'removed'
      || !['intentional-change', 'proven'].includes(binding.parity)
      || !binding.evidence.length) {
      throw new Error('Retired inventory binding lacks absence of authority, fallback removal, or evidence: '
        + item.sourcePath + ' -> ' + binding.path);
    }
    assertEvidenceBindings(root, item, binding, evidenceOverlay);
  }
}

function assertStateSemantics(root, item, evidenceOverlay = null) {
  if (!item.targets.length) {
    throw new Error('Legacy inventory item has no target responsibilities: ' + item.sourcePath);
  }
  const keys = item.targets.map((target) => target.id + '\0' + target.path);
  if (new Set(keys).size !== keys.length) {
    throw new Error('Legacy inventory item repeats a target responsibility: ' + item.sourcePath);
  }
  for (const binding of item.targets) {
    assertBindingStateSemantics(root, item, binding, evidenceOverlay);
  }
  const expected = aggregateState(item.targets);
  if (item.state !== expected) {
    throw new Error('Legacy inventory aggregate state does not match its target bindings: '
      + item.sourcePath + ' expected ' + expected + ' but found ' + item.state + '.');
  }
  const expectedPresence = ['migrated', 'retired'].includes(item.state)
    ? 'removed'
    : 'present';
  if (item.sourcePresence !== expectedPresence) {
    throw new Error('Legacy inventory source presence does not match its aggregate state: '
      + item.sourcePath + ' expected ' + expectedPresence + ' but found '
      + item.sourcePresence + '.');
  }
}

function buildInventory(root, current = null, evidenceOverlay = null) {
  const files = walkLegacy(root);
  const byPath = new Map(files.map((entry) => [entry.relative, entry]));
  const prior = new Map((current?.items || []).map((item) => [item.sourcePath, item]));
  if (current) {
    const unclassified = files
      .filter((entry) => !prior.has(entry.relative))
      .map((entry) => entry.relative);
    if (unclassified.length) {
      throw new Error('Legacy inventory requires explicit classification for new paths: '
        + unclassified.join(', '));
    }
  }
  const sourcePaths = current
    ? [...prior.keys()].sort(compareCodepoint)
    : files.map((entry) => entry.relative);
  const items = sourcePaths.map((sourcePath, sequence) => {
    const entry = byPath.get(sourcePath) || null;
    const previous = prior.get(sourcePath);
    const metadata = previous || defaultMetadata(root, sourcePath);
    const item = normalizedItem(entry, sourcePath, sequence, metadata);
    assertStateSemantics(root, item, evidenceOverlay);
    return item;
  });
  const stateCounts = { mapped: 0, bridged: 0, migrated: 0, retired: 0 };
  for (const item of items) stateCounts[item.state] += 1;
  const bindingStateCounts = { mapped: 0, bridged: 0, migrated: 0, retired: 0 };
  for (const item of items) {
    for (const target of item.targets) bindingStateCounts[target.state] += 1;
  }
  const basisEntries = items.map(({ sourcePath, sourceFingerprint }) => ({ sourcePath, sourceFingerprint }));
  const inventory = {
    $contract: CONTRACT,
    contractVersion: '2.0.0',
    id: 'legacy.claude.v1-baseline',
    basis: {
      sourceRoot: '.claude',
      baselineBranch: BASELINE_BRANCH,
      baselineCommit: BASELINE_COMMIT,
      fileCount: items.length,
      treeFingerprint: fingerprintJson(basisEntries)
    },
    stateCounts,
    bindingStateCounts,
    items,
    limitations: LIMITATIONS,
    inventoryFingerprint: null
  };
  inventory.inventoryFingerprint = fingerprintJson(inventory);
  return inventory;
}

export function assertLegacyInventoryCurrent(root = defaultRoot) {
  const file = path.join(root, INVENTORY_PATH);
  if (!fs.existsSync(file)) throw new Error('Legacy inventory is missing.');
  const current = readJson(file);
  const expected = buildInventory(root, current);
  const expectedBytes = JSON.stringify(expected, null, 2) + '\n';
  const actualBytes = fs.readFileSync(file, 'utf8');
  if (actualBytes !== expectedBytes) {
    throw new Error('Legacy inventory is stale or non-deterministic. Run legacy-inventory --update.');
  }
  return expected;
}

/**
 * Validates the exact inventory bytes, complete source set, source
 * fingerprints, target files, target workflow content fingerprints, states,
 * authority, fallback, and evidence references without reading the referenced
 * evidence bodies. A finalization coordinator must separately validate every
 * unfinished binding against its sealed fresh evidence overlay before using
 * this structural basis.
 */
export function assertLegacyInventoryStructureCurrent(root = defaultRoot) {
  const file = path.join(root, INVENTORY_PATH);
  if (!fs.existsSync(file)) throw new Error('Legacy inventory is missing.');
  const current = readJson(file);
  const expected = buildInventory(root, current, SKIP_EVIDENCE_CONTENT);
  const expectedBytes = JSON.stringify(expected, null, 2) + '\n';
  const actualBytes = fs.readFileSync(file, 'utf8');
  if (actualBytes !== expectedBytes) {
    throw new Error('Legacy inventory is stale or non-deterministic. Run legacy-inventory --update.');
  }
  return expected;
}

export function updateLegacyInventory(root = defaultRoot) {
  const file = path.join(root, INVENTORY_PATH);
  const current = fs.existsSync(file) ? readJson(file) : null;
  const next = buildInventory(root, current);
  writeJson(file, next);
  return next;
}

function expectFailure(run, pattern) {
  try {
    run();
  } catch (error) {
    if (pattern.test(String(error.message))) return;
    throw error;
  }
  throw new Error('Expected legacy inventory failure: ' + pattern);
}

export function selftestLegacyInventory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-legacy-inventory-'));
  try {
    const rule = path.join(root, '.claude/rules/example.md');
    fs.mkdirSync(path.dirname(rule), { recursive: true });
    fs.writeFileSync(rule, 'example rule\n');
    const first = updateLegacyInventory(root);
    if (first.basis.fileCount !== 1
      || first.stateCounts.mapped !== 1
      || first.bindingStateCounts.mapped !== 1) {
      throw new Error('Legacy inventory bootstrap did not classify the exact source set.');
    }
    assertLegacyInventoryCurrent(root);

    fs.writeFileSync(rule, 'changed rule\n');
    expectFailure(() => assertLegacyInventoryCurrent(root), /stale or non-deterministic/);
    updateLegacyInventory(root);
    assertLegacyInventoryCurrent(root);

    const added = path.join(root, '.claude/rules/new.md');
    fs.writeFileSync(added, 'new rule\n');
    expectFailure(() => assertLegacyInventoryCurrent(root), /explicit classification for new paths/);
    fs.rmSync(added);

    fs.rmSync(rule);
    expectFailure(
      () => assertLegacyInventoryCurrent(root),
      /source presence does not match its aggregate state/
    );
    fs.writeFileSync(rule, 'changed rule\n');

    const linked = path.join(root, '.claude/rules/linked.md');
    fs.symlinkSync(rule, linked);
    expectFailure(() => assertLegacyInventoryCurrent(root), /rejects symlinks/);
    fs.rmSync(linked);

    const inventoryPath = path.join(root, INVENTORY_PATH);
    const scenarioPath = 'soter/scenarios/example/happy-path.scenario.json';
    const scenarioFile = path.join(root, scenarioPath);
    const scenario = {
      $contract: 'soter://contracts/scenario/v1',
      id: 'example.happy-path',
      sourceCases: ['.claude/rules/example.md']
    };
    fs.mkdirSync(path.dirname(scenarioFile), { recursive: true });
    writeJson(scenarioFile, scenario);
    const evidencePath = 'soter/fixtures/example/happy-path.evidence.json';
    const evidenceFile = path.join(root, evidencePath);
    const evidence = {
      $contract: 'soter://contracts/evidence/v2',
      claimFamily: 'behavior',
      result: 'passed',
      evaluator: { level: 'fixture' },
      artifacts: [{
        role: 'scenario',
        id: scenario.id,
        path: scenarioPath,
        fingerprint: fingerprintJson(scenario)
      }, {
        role: 'source-case',
        path: '.claude/rules/example.md',
        fingerprint: fingerprintFile(rule)
      }]
    };
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
    writeJson(evidenceFile, evidence);
    const bridged = readJson(inventoryPath);
    bridged.items[0].state = 'bridged';
    bridged.items[0].targets = [{
      status: 'existing',
      id: 'automation.example',
      path: scenarioPath,
      responsibility: 'Fixture scenario responsibility for this exact legacy case.',
      state: 'bridged',
      canonicalAuthority: 'legacy',
      fallback: 'retained',
      parity: 'not-evaluated',
      evidence: [evidencePath]
    }, {
      status: 'planned',
      id: 'context.example',
      path: 'soter/planned/context.example/example.md',
      responsibility: 'Portable example meaning that remains explicitly planned.',
      state: 'mapped',
      canonicalAuthority: 'legacy',
      fallback: 'retained',
      parity: 'not-evaluated',
      evidence: []
    }];
    writeJson(inventoryPath, bridged);
    const multiTarget = updateLegacyInventory(root);
    assertLegacyInventoryCurrent(root);
    if (multiTarget.stateCounts.bridged !== 1
      || multiTarget.stateCounts.mapped !== 0
      || multiTarget.bindingStateCounts.bridged !== 1
      || multiTarget.bindingStateCounts.mapped !== 1) {
      throw new Error('Legacy inventory hid an unfinished target binding behind its source aggregate.');
    }

    const validMultiTargetText = fs.readFileSync(inventoryPath, 'utf8');
    const repeatedTarget = readJson(inventoryPath);
    repeatedTarget.items[0].targets.push(structuredClone(repeatedTarget.items[0].targets[0]));
    writeJson(inventoryPath, repeatedTarget);
    expectFailure(() => updateLegacyInventory(root), /repeats a target responsibility/);
    fs.writeFileSync(inventoryPath, validMultiTargetText);

    const singleTarget = readJson(inventoryPath);
    singleTarget.items[0].targets = [singleTarget.items[0].targets[0]];
    writeJson(inventoryPath, singleTarget);
    updateLegacyInventory(root);
    assertLegacyInventoryCurrent(root);

    fs.writeFileSync(rule, 'changed after bridge evidence\n');
    expectFailure(
      () => updateLegacyInventory(root),
      /does not bind the exact legacy source and target scenario/
    );
    fs.writeFileSync(rule, 'changed rule\n');
    assertLegacyInventoryCurrent(root);

    evidence.result = 'failed';
    writeJson(evidenceFile, evidence);
    expectFailure(() => assertLegacyInventoryCurrent(root), /must be a passed evidence\/v2 record/);
    evidence.result = 'passed';
    writeJson(evidenceFile, evidence);

    scenario.sourceCases = ['.claude/rules/different.md'];
    writeJson(scenarioFile, scenario);
    expectFailure(() => assertLegacyInventoryCurrent(root), /does not cite its exact source case/);
    scenario.sourceCases = ['.claude/rules/example.md'];
    writeJson(scenarioFile, scenario);

    const overstated = readJson(inventoryPath);
    overstated.items[0].state = 'migrated';
    overstated.items[0].targets[0].state = 'migrated';
    overstated.items[0].targets[0].canonicalAuthority = 'target';
    overstated.items[0].targets[0].status = 'existing';
    overstated.items[0].targets[0].fallback = 'removed';
    overstated.items[0].targets[0].parity = 'proven';
    writeJson(inventoryPath, overstated);
    expectFailure(() => assertLegacyInventoryCurrent(root), /requires migration-family evidence/);

    evidence.claimFamily = 'migration';
    evidence.artifacts[0].role = 'migration-target';
    evidence.artifacts[1].role = 'migration-source';
    writeJson(evidenceFile, evidence);
    fs.rmSync(rule);
    updateLegacyInventory(root);
    const removed = assertLegacyInventoryCurrent(root);
    if (removed.items[0].state !== 'migrated'
      || removed.items[0].sourcePresence !== 'removed'
      || removed.items[0].sourceFingerprint !== evidence.artifacts.find((artifact) => {
        return artifact.role === 'migration-source';
      }).fingerprint
      || fingerprintLegacySource(root, '.claude/rules/example.md')
        !== removed.items[0].sourceFingerprint) {
      throw new Error('Migrated source tombstone did not preserve exact source identity.');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write('Legacy inventory selftest: completeness, source and binding state totals, content drift, exact multi-target bridge evidence, governed source tombstones, explicit classification, symlink, and state-promotion checks passed.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  const update = process.argv.includes('--update');
  const selftest = process.argv.includes('--selftest');
  try {
    if (selftest) {
      selftestLegacyInventory();
    } else {
      const inventory = update ? updateLegacyInventory(defaultRoot) : assertLegacyInventoryCurrent(defaultRoot);
      process.stdout.write(`Legacy inventory: ${inventory.basis.fileCount} artifacts; source states mapped=${inventory.stateCounts.mapped}, bridged=${inventory.stateCounts.bridged}, migrated=${inventory.stateCounts.migrated}, retired=${inventory.stateCounts.retired}; target bindings mapped=${inventory.bindingStateCounts.mapped}, bridged=${inventory.bindingStateCounts.bridged}, migrated=${inventory.bindingStateCounts.migrated}, retired=${inventory.bindingStateCounts.retired}.\n`);
    }
  } catch (error) {
    process.stderr.write('Legacy inventory: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
