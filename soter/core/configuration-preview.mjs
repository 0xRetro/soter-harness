import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson, repoRelativePath } from './lib/canonical-json.mjs';
import {
  evaluateConfigurationDocument,
  fingerprintLock,
  resolveConfiguration
} from './resolve.mjs';

const CONTRACT = 'soter://contracts/configuration-preview/v1';
const VERSION = '1.0.0';
const EFFECTS = ['read', 'disclosure', 'write', 'dispatch', 'destructive'];
const EFFECT_MODES = ['allow', 'confirm', 'prohibit'];
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function walkJson(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJson(target);
    return entry.isFile() && entry.name.endsWith('.json') ? [target] : [];
  }).sort(compareText);
}

function configurationPath(root, name) {
  const matches = walkJson(path.join(root, 'soter', 'configurations'))
    .filter((file) => {
      try {
        const value = readJson(file);
        return value.$contract === 'soter://contracts/configuration/v1' && value.name === name;
      } catch {
        return false;
      }
    });
  if (matches.length !== 1) {
    throw new Error('Expected one configuration named ' + name + '; found ' + matches.length + '.');
  }
  return matches[0];
}

function hostAdapters(root) {
  return walkJson(path.join(root, 'soter', 'hosts')).map((file) => ({ file, value: readJson(file) }))
    .filter((entry) => entry.value.$contract === 'soter://contracts/host-adapter/v1');
}

function packManifests(root) {
  return walkJson(path.join(root, 'soter', 'packs')).map((file) => readJson(file))
    .filter((value) => value.$contract === 'soter://contracts/pack/v1');
}

function diagnostic(code, subject, message, remediation) {
  return { code, severity: 'error', subject, message, remediation };
}

function hasErrors(diagnostics) {
  return diagnostics.some((item) => item.severity === 'error');
}

function normalizeDraft(draft = {}) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new TypeError('Configuration preview draft must be an object.');
  }
  const keys = Object.keys(draft);
  if (keys.some((key) => !['hostAdapter', 'effectPolicies', 'addPacks'].includes(key))) {
    throw new TypeError('Configuration preview accepts only hostAdapter, effectPolicies, and addPacks.');
  }
  if (draft.hostAdapter !== undefined
    && (typeof draft.hostAdapter !== 'string' || !/^host\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(draft.hostAdapter))) {
    throw new TypeError('Configuration preview hostAdapter is invalid.');
  }
  const effectPolicies = draft.effectPolicies || {};
  if (!effectPolicies || typeof effectPolicies !== 'object' || Array.isArray(effectPolicies)) {
    throw new TypeError('Configuration preview effectPolicies must be an object.');
  }
  for (const [effect, mode] of Object.entries(effectPolicies)) {
    if (!EFFECTS.includes(effect) || !EFFECT_MODES.includes(mode)) {
      throw new TypeError('Configuration preview effect policy is invalid: ' + effect + '.');
    }
  }
  const addPacks = draft.addPacks || [];
  if (!Array.isArray(addPacks) || addPacks.some((id) => typeof id !== 'string'
    || !/^(kernel|core|context|automation|integration)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id))
    || new Set(addPacks).size !== addPacks.length) {
    throw new TypeError('Configuration preview addPacks must contain unique pack IDs.');
  }
  return {
    hostAdapter: draft.hostAdapter || null,
    effectPolicies: { ...effectPolicies },
    addPacks: [...addPacks].sort(compareText)
  };
}

function candidateConfiguration(current, adapters, packs, draft, diagnostics) {
  const candidate = clone(current);
  if (draft.hostAdapter) {
    const adapter = adapters.find((entry) => entry.value.id === draft.hostAdapter)?.value;
    if (!adapter) {
      diagnostics.push(diagnostic(
        'SOTER_CONFIGURATION_PREVIEW_HOST',
        draft.hostAdapter,
        'The requested host adapter is not declared in this workspace.',
        'Choose one of the declared compatible host adapters.'
      ));
    } else {
      candidate.host = {
        id: adapter.host,
        adapter: adapter.id,
        version: adapter.version,
        reason: 'Preview the same selected Soter systems through the ' + adapter.host + ' host projection.'
      };
    }
  }
  for (const [effect, mode] of Object.entries(draft.effectPolicies)) {
    candidate.effectPolicies[effect] = {
      ...candidate.effectPolicies[effect],
      mode
    };
  }
  const selected = new Set([candidate.base.kernel, candidate.base.core, ...candidate.packs.map((item) => item.id)]);
  const addWithDependencies = (id, source, reason, trail = []) => {
    if (selected.has(id)) return;
    const pack = packs.find((item) => item.id === id);
    if (!pack) {
      diagnostics.push(diagnostic(
        'SOTER_CONFIGURATION_PREVIEW_PACK',
        id,
        'The requested pack is not declared in this workspace.',
        'Choose one of the available catalog packs.'
      ));
      return;
    }
    if (trail.includes(id)) {
      diagnostics.push(diagnostic(
        'SOTER_CONFIGURATION_PREVIEW_PACK_CYCLE',
        id,
        'The requested pack has a cyclic dependency path.',
        'Repair the pack dependency graph before selecting this pack.'
      ));
      return;
    }
    for (const dependency of pack.dependencies.filter((item) => !item.optional)) {
      addWithDependencies(
        dependency.pack,
        'dependency',
        id + ' requires ' + dependency.pack + ' at ' + dependency.version + '.',
        [...trail, id]
      );
    }
    if (selected.has(id)) return;
    candidate.packs.push({ id, source, reason });
    selected.add(id);
  };
  for (const id of draft.addPacks) {
    addWithDependencies(
      id,
      'user',
      'Preview selection of the optional ' + id + ' system for this configuration.'
    );
  }
  return candidate;
}

function appendCandidateDiagnostics(root, verification, diagnostics) {
  for (const violation of verification.violations) {
    diagnostics.push({
      code: 'SOTER_CONFIGURATION_PREVIEW_' + violation.code.replace(/^SOTER_/, ''),
      severity: violation.level === 'warn' ? 'warning' : 'error',
      subject: repoRelativePath(root, violation.file),
      message: violation.what,
      remediation: violation.fix
    });
  }
}

function changeRows(current, candidate) {
  const rows = [{
    category: 'host',
    subject: 'host.adapter',
    state: current.host.adapter === candidate.host.adapter ? 'unchanged' : 'changed',
    before: current.host.adapter,
    after: candidate.host.adapter,
    impact: current.host.adapter === candidate.host.adapter
      ? 'The active host projection is unchanged.'
      : 'Host projections and exact-lock evidence must be re-established.'
  }];
  for (const effect of EFFECTS) {
    const before = current.effectPolicies[effect].mode;
    const after = candidate.effectPolicies[effect].mode;
    rows.push({
      category: 'effect-policy',
      subject: effect,
      state: before === after ? 'unchanged' : 'changed',
      before,
      after,
      impact: before === after
        ? 'No policy change.'
        : 'The ' + effect + ' effect moves from ' + before + ' to ' + after + '; a new exact lock is required.'
    });
  }
  const currentPacks = new Set(current.packs.map((item) => item.id));
  for (const selection of candidate.packs.filter((item) => !currentPacks.has(item.id))) {
    rows.push({
      category: 'pack',
      subject: selection.id,
      state: 'changed',
      before: 'not selected',
      after: 'selected',
      impact: 'Adds the pack, its required dependencies, and its exact artifact fingerprints to the candidate lock.'
    });
  }
  return rows;
}

export function previewConfiguration({ root = DEFAULT_ROOT, name, draft = {} } = {}) {
  const resolvedRoot = path.resolve(root);
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new TypeError('Configuration preview name is invalid.');
  }
  const normalizedDraft = normalizeDraft(draft);
  const source = configurationPath(resolvedRoot, name);
  const currentConfiguration = readJson(source);
  const currentLock = resolveConfiguration({ root: resolvedRoot, configPath: source });
  const adapters = hostAdapters(resolvedRoot);
  const packs = packManifests(resolvedRoot);
  const diagnostics = [];
  const candidate = candidateConfiguration(currentConfiguration, adapters, packs, normalizedDraft, diagnostics);
  let candidateLock = null;
  if (!hasErrors(diagnostics)) {
    const evaluated = evaluateConfigurationDocument({
      root: resolvedRoot,
      configPath: source,
      configuration: candidate
    });
    appendCandidateDiagnostics(resolvedRoot, evaluated.verification, diagnostics);
    candidateLock = hasErrors(diagnostics) ? null : evaluated.lock;
  }
  const currentFingerprint = fingerprintLock(currentLock);
  const candidateFingerprint = candidateLock ? fingerprintLock(candidateLock) : null;
  const changed = candidateFingerprint !== null && candidateFingerprint !== currentFingerprint;
  const selected = new Set(currentLock.packs.map((pack) => pack.id));
  const base = new Set([currentConfiguration.base.kernel, currentConfiguration.base.core]);

  return {
    $contract: CONTRACT,
    contractVersion: VERSION,
    configuration: {
      name: currentConfiguration.name,
      sourcePath: repoRelativePath(resolvedRoot, source),
      host: currentConfiguration.host.adapter,
      lockFingerprint: currentFingerprint,
      graphFingerprint: currentLock.graphFingerprint
    },
    draft: {
      valid: !hasErrors(diagnostics),
      changed,
      host: candidate.host.adapter,
      addedPacks: candidate.packs.filter((item) => !currentConfiguration.packs.some((current) => current.id === item.id)).map((item) => item.id),
      lockFingerprint: candidateFingerprint,
      graphFingerprint: candidateLock?.graphFingerprint || null
    },
    changes: changeRows(currentConfiguration, candidate),
    options: {
      hosts: adapters.map(({ value }) => ({
        id: value.host,
        adapter: value.id,
        version: value.version,
        current: value.id === currentConfiguration.host.adapter,
        compatible: currentLock.packs.every((pack) => {
          return packs.find((candidatePack) => candidatePack.id === pack.id)?.compatibility.hosts.includes(value.host);
        }),
        limitations: [...value.limitations]
      })).sort((left, right) => compareText(left.adapter, right.adapter)),
      effectModes: [...EFFECT_MODES],
      packs: packs.map((pack) => ({
        id: pack.id,
        version: pack.version,
        layer: pack.layer,
        selected: selected.has(pack.id),
        base: base.has(pack.id),
        selectable: !selected.has(pack.id) && pack.layer === 'automation',
        summary: pack.summary,
        effects: [...pack.effects],
        dependencies: pack.dependencies.filter((item) => !item.optional).map((item) => item.pack).sort(compareText),
        requiredCapabilities: pack.capabilities.requires.filter((item) => !item.optional).map((item) => item.id).sort(compareText),
        scenarioCount: pack.verification.scenarios.length
      })).sort((left, right) => compareText(left.id, right.id))
    },
    evidenceImpact: {
      state: !candidateLock ? 'unknown' : changed ? 'invalidated' : 'preserved',
      reason: !candidateLock
        ? 'The draft cannot produce an exact lock until its diagnostics are repaired.'
        : changed
          ? 'Evidence is bound to the current exact lock; this draft requires new applicable evidence.'
          : 'The candidate resolves to the current exact lock, so evidence applicability is unchanged.'
    },
    diagnostics,
    apply: {
      supported: false,
      reason: 'This minimized preview grants no apply authority; a full exact configuration/v1 candidate must use the separate confirmed configuration transaction.'
    }
  };
}
