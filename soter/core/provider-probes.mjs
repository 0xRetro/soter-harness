import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { listProviderDeclarations } from './capabilities.mjs';
import { fingerprintJson, readJson, resolveRepoPath } from './lib/canonical-json.mjs';

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText);
}

export function selectedProvider(root, lock, implementation) {
  const matches = listProviderDeclarations(root).filter((provider) => {
    return provider.id === implementation
      && provider.containment === 'connected'
      && lock.packs.some((pack) => pack.id === provider.pack);
  });
  if (matches.length !== 1) {
    throw new Error(
      'Expected one selected connected provider named ' + implementation
        + '; found ' + matches.length + '.'
    );
  }
  const provider = matches[0];
  const bindings = lock.bindings.filter((binding) => {
    return binding.providerPack === provider.pack
      && provider.capabilities.some((capability) => {
        return capability.id === binding.capability
          && capability.version === binding.capabilityVersion;
      });
  });
  if (!bindings.length) {
    throw new Error(provider.id + ' has no capability binding in the supplied lock.');
  }
  return { provider, bindings };
}

function desiredConfiguration(root, lock) {
  const configuration = readJson(resolveRepoPath(root, lock.configuration.path));
  if (configuration.name !== lock.configuration.name
    || fingerprintJson(configuration) !== lock.configuration.fingerprint) {
    throw new Error('The desired configuration no longer matches the supplied lock.');
  }
  return configuration;
}

export function probePlan(root, lock, provider, bindings) {
  const configuration = desiredConfiguration(root, lock);
  const desiredBindings = configuration.bindings.filter((binding) => {
    return binding.providerPack === provider.pack
      && bindings.some((resolved) => resolved.capability === binding.capability);
  });
  const authorities = uniqueSorted(bindings.flatMap((binding) => binding.authorities));
  for (const authority of authorities) {
    const declaration = lock.authorities.find((item) => item.id === authority);
    if (!declaration || !provider.authorities.some((item) => {
      return item.role === declaration.role && item.subject === declaration.subject;
    })) {
      throw new Error(provider.id + ' does not support bound authority ' + authority + '.');
    }
  }
  return {
    credentialRefs: uniqueSorted(desiredBindings.map((binding) => binding.secretRef).filter(Boolean)),
    authorities,
    capabilities: uniqueSorted(bindings.map((binding) => binding.capability))
  };
}

export function providerProbeSources(lock, bindings) {
  const byCapability = new Map(bindings.map((binding) => [binding.capability, binding]));
  return (lock.sources || []).filter((source) => {
    const binding = byCapability.get(source.capability);
    return source.readiness?.mode === 'probe-read'
      && binding?.authorities.includes(source.authority);
  }).sort((left, right) => left.id.localeCompare(right.id, 'en')).map((source) => ({
    id: source.id,
    capability: source.capability,
    authority: source.authority,
    input: structuredClone(source.input),
    inputFingerprint: source.inputFingerprint
  }));
}

export function assertProbeContract(root, probe) {
  const schema = readJson(path.join(root, 'soter/contracts/provider-probe-v2.schema.json'));
  const failures = validateJsonSchema(probe, schema);
  if (failures.length) {
    throw Object.assign(new Error(
      'Normalized provider probe does not satisfy its contract: '
        + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
    ), { kind: 'validation' });
  }
}

function sameItems(left, right) {
  return JSON.stringify(uniqueSorted(left)) === JSON.stringify(uniqueSorted(right));
}

function exactlyScoped(items, key, expected) {
  if (!Array.isArray(items)) return false;
  const ids = items.map((item) => item?.[key]);
  return ids.length === expected.length
    && new Set(ids).size === ids.length
    && sameItems(ids, expected);
}

export function assertObservationScope(plan, observations) {
  if (!observations || typeof observations !== 'object' || Array.isArray(observations)) {
    throw Object.assign(new Error('Probe translator must return structured observations.'), {
      kind: 'validation'
    });
  }
  if (!exactlyScoped(observations.credentials, 'secretRefId', plan.credentialRefs)
    || !exactlyScoped(observations.authorities, 'id', plan.authorities)
    || !exactlyScoped(observations.capabilities, 'id', plan.capabilities)) {
    throw Object.assign(
      new Error('Probe observations must cover exactly the locked credential, authority, and capability plan.'),
      { kind: 'validation' }
    );
  }
}

export function validUntil(at, seconds) {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) {
    throw Object.assign(new Error('Probe completion time is not a valid timestamp.'), {
      kind: 'validation'
    });
  }
  return new Date(timestamp + seconds * 1000).toISOString();
}
