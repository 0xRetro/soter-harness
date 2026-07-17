import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { assertContextRecordInput, assertContextRecordOutput } from './context-records.mjs';
import { fingerprintJson, readJson, resolveRepoPath } from './lib/canonical-json.mjs';

const ERROR_KINDS = new Set([
  'authentication',
  'authorization',
  'validation',
  'conflict',
  'rate-limit',
  'unavailable',
  'retryable',
  'not-found',
  'unknown'
]);

export function listProviderDeclarations(root) {
  const directory = path.join(root, 'soter', 'providers');
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson(path.join(directory, name)))
    .filter((doc) => doc.$contract === 'soter://contracts/capability-provider/v1');
}

function findProvider(root, providerPack, capability, containment) {
  const matches = listProviderDeclarations(root).filter((provider) => {
    return provider.pack === providerPack
      && provider.containment === containment
      && provider.capabilities.some((item) => item.id === capability);
  });
  if (matches.length !== 1) {
    throw new Error(
      'Expected one ' + containment + ' implementation for '
        + providerPack + '/' + capability + '; found ' + matches.length + '.'
    );
  }
  return matches[0];
}

export function createFixtureRuntimeState(root) {
  const state = {};
  for (const provider of listProviderDeclarations(root).filter((item) => item.containment === 'fixture')) {
    if (provider.fixtures.length) {
      state[provider.id] = structuredClone(readJson(resolveRepoPath(root, provider.fixtures[0])));
    }
  }
  return state;
}

export function evaluateEffectPolicy(lock, effects, approvedEffects = []) {
  const approved = new Set(approvedEffects);
  return effects.map((effect) => {
    const policy = lock.effectPolicies[effect];
    let decision = 'blocked';
    if (policy.mode === 'allow') decision = 'allowed';
    if (policy.mode === 'confirm' && approved.has(effect)) decision = 'confirmed';
    return {
      effect,
      mode: policy.mode,
      decision,
      reason: policy.reason
    };
  });
}

function normalizedError(error, fallbackKind = 'unknown') {
  const kind = ERROR_KINDS.has(error?.kind) ? error.kind : fallbackKind;
  return {
    kind,
    message: error?.message || String(error)
  };
}

function schemaFailure(kind, failures) {
  return {
    kind: 'validation',
    message: kind + ' does not satisfy the capability schema: '
      + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
  };
}

export async function invokeCapability({
  root,
  lock,
  capability,
  authority,
  containment,
  input,
  effectId,
  at,
  approvedEffects = [],
  runtimeState = null
}) {
  const binding = lock.bindings.find((item) => item.capability === capability);
  if (!binding) throw new Error('No resolved binding for ' + capability + '.');
  if (!binding.authorities.includes(authority)) {
    throw new Error(authority + ' is outside the resolved authority set for ' + capability + '.');
  }
  const authorityDeclaration = lock.authorities.find((item) => item.id === authority);
  if (!authorityDeclaration) throw new Error('Unknown resolved authority ' + authority + '.');

  const provider = findProvider(root, binding.providerPack, capability, containment);
  if (!provider.authorities.some((item) => {
    return item.role === authorityDeclaration.role && item.subject === authorityDeclaration.subject;
  })) {
    throw new Error(provider.id + ' does not support authority ' + authority + '.');
  }
  const capabilityContract = readJson(path.join(root, 'soter', 'capabilities', capability + '.json'));
  const decisions = evaluateEffectPolicy(lock, capabilityContract.effects, approvedEffects);
  const base = {
    id: effectId,
    capability,
    capabilityVersion: capabilityContract.version,
    providerPack: provider.pack,
    providerImplementation: provider.id,
    providerVersion: provider.version,
    containment,
    authority,
    startedAt: at,
    completedAt: at,
    declaredEffects: capabilityContract.effects,
    policyDecisions: decisions,
    inputFingerprint: fingerprintJson(input)
  };
  if (decisions.some((item) => item.decision === 'blocked')) {
    return {
      invocation: {
        ...base,
        state: 'blocked',
        outputFingerprint: null,
        error: {
          kind: 'authorization',
          message: 'Effect policy blocked ' + capability + ' before provider invocation.'
        }
      },
      output: null
    };
  }

  const inputFailures = validateJsonSchema(input, capabilityContract.inputSchema);
  if (inputFailures.length) {
    return {
      invocation: {
        ...base,
        state: 'failed',
        outputFingerprint: null,
        error: schemaFailure('Capability input', inputFailures)
      },
      output: null
    };
  }
  try {
    assertContextRecordInput(root, capability, input, {
      packIds: lock.packs.filter((pack) => pack.layer === 'context').map((pack) => pack.id)
    });
  } catch (error) {
    return {
      invocation: {
        ...base,
        state: 'failed',
        outputFingerprint: null,
        error: normalizedError(error, 'validation')
      },
      output: null
    };
  }

  try {
    const modulePath = resolveRepoPath(root, provider.runtime.module);
    const implementation = await import(pathToFileURL(modulePath).href);
    const invoke = implementation[provider.runtime.export];
    if (typeof invoke !== 'function') {
      throw Object.assign(new Error('Provider export is not a function: ' + provider.runtime.export), {
        kind: 'validation'
      });
    }
    const output = await invoke({
      capability,
      input,
      authority,
      fixtures: provider.fixtures.map((fixture) => resolveRepoPath(root, fixture)),
      state: runtimeState?.[provider.id] || null,
      at
    });
    const outputFailures = validateJsonSchema(output, capabilityContract.outputSchema);
    if (outputFailures.length) {
      return {
        invocation: {
          ...base,
          state: 'failed',
          outputFingerprint: fingerprintJson(output),
          error: schemaFailure('Provider output', outputFailures)
        },
        output: null
      };
    }
    assertContextRecordOutput(root, capability, output, {
      packIds: lock.packs.filter((pack) => pack.layer === 'context').map((pack) => pack.id)
    });
    return {
      invocation: {
        ...base,
        state: 'passed',
        outputFingerprint: fingerprintJson(output),
        error: null
      },
      output
    };
  } catch (error) {
    return {
      invocation: {
        ...base,
        state: 'failed',
        outputFingerprint: null,
        error: normalizedError(error)
      },
      output: null
    };
  }
}
