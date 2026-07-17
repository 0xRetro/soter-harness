import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { listProviderDeclarations } from './capabilities.mjs';
import {
  assertMcpRuntime,
  containsCredentialMaterial,
  loadProviderMappings,
  loadProviderModule,
  normalizedError,
  resolveHostTool
} from './host-runtime.mjs';
import { fingerprintJson, readJson, resolveRepoPath } from './lib/canonical-json.mjs';
import { fingerprintLock } from './resolve.mjs';

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

function assertCallContract(root, call) {
  const schema = readJson(path.join(root, 'soter/contracts/provider-probe-call.schema.json'));
  const failures = validateJsonSchema(call, schema);
  if (failures.length) {
    throw new Error(
      'Provider probe call does not satisfy its contract: '
        + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

export function assertProbeContract(root, probe) {
  const schemaPath = probe?.$contract === 'soter://contracts/provider-probe/v2'
    ? 'soter/contracts/provider-probe-v2.schema.json'
    : 'soter/contracts/provider-probe.schema.json';
  const schema = readJson(path.join(root, schemaPath));
  const failures = validateJsonSchema(probe, schema);
  if (failures.length) {
    throw Object.assign(new Error(
      'Normalized provider probe does not satisfy its contract: '
        + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
    ), { kind: 'validation' });
  }
}

function failedPreparation(base, at, error) {
  return {
    ...base,
    completedAt: at,
    state: 'failed',
    transport: { ...base.transport, operation: null, tool: null },
    arguments: null,
    argumentsFingerprint: null,
    responseFingerprint: null,
    probeFingerprint: null,
    error: normalizedError(error, 'validation')
  };
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

export async function prepareProviderProbeCall({
  root,
  lock,
  providerImplementation,
  callId,
  probeId,
  at,
  validForSeconds = 300,
  translator = null
}) {
  const resolvedRoot = path.resolve(root);
  if (!Number.isInteger(validForSeconds) || validForSeconds < 60 || validForSeconds > 900) {
    throw new Error('Provider probes must be valid for an integer duration from 60 through 900 seconds.');
  }
  const { provider, bindings } = selectedProvider(
    resolvedRoot,
    lock,
    providerImplementation
  );
  assertMcpRuntime(provider);
  const plan = probePlan(resolvedRoot, lock, provider, bindings);
  const base = {
    $contract: 'soter://contracts/provider-probe-call/v1',
    contractVersion: '1.0.0',
    id: callId,
    probeId,
    createdAt: at,
    completedAt: null,
    state: 'requested',
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    host: {
      id: lock.host.id,
      adapter: lock.host.adapter,
      version: lock.host.version
    },
    provider: {
      pack: provider.pack,
      implementation: provider.id,
      version: provider.version,
      containment: provider.containment
    },
    plan,
    validForSeconds,
    transport: {
      protocol: 'mcp',
      server: provider.runtime.server,
      operation: null,
      tool: null
    },
    secretValuesExcluded: true
  };

  try {
    const implementation = await loadProviderModule(resolvedRoot, provider, translator);
    const prepare = implementation[provider.runtime.probePrepareExport];
    if (typeof prepare !== 'function') {
      throw Object.assign(
        new Error('MCP probe prepare export is not a function: ' + provider.runtime.probePrepareExport),
        { kind: 'validation' }
      );
    }
    const request = await prepare({
      plan,
      settings: lock.settings || {},
      mappings: loadProviderMappings(resolvedRoot, provider),
      at
    });
    if (!request || typeof request.tool !== 'string' || !request.arguments
      || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) {
      throw Object.assign(new Error('MCP probe translator must return { tool, arguments }.'), {
        kind: 'validation'
      });
    }
    if (!provider.runtime.probeTools.includes(request.tool)
      || !provider.runtime.tools.includes(request.tool)) {
      throw Object.assign(
        new Error('Probe translator requested undeclared MCP probe tool ' + request.tool + '.'),
        { kind: 'validation' }
      );
    }
    if (containsCredentialMaterial(request.arguments)) {
      throw Object.assign(
        new Error('MCP probe arguments contain credential-like material; authentication belongs to the host.'),
        { kind: 'validation' }
      );
    }
    const hostTool = resolveHostTool(resolvedRoot, lock, provider, request.tool);
    const call = {
      ...base,
      transport: {
        ...base.transport,
        operation: request.tool,
        tool: hostTool.nativeTool
      },
      arguments: request.arguments,
      argumentsFingerprint: fingerprintJson(request.arguments),
      responseFingerprint: null,
      probeFingerprint: null,
      error: null
    };
    assertCallContract(resolvedRoot, call);
    return { call };
  } catch (error) {
    const call = failedPreparation(base, at, error);
    assertCallContract(resolvedRoot, call);
    return { call };
  }
}

export async function completeProviderProbeCall({
  root,
  lock,
  call,
  response,
  at,
  translator = null
}) {
  const resolvedRoot = path.resolve(root);
  assertCallContract(resolvedRoot, call);
  if (call.state !== 'requested') {
    throw new Error('Only a requested provider probe call can accept a host response.');
  }
  if (call.configurationLockFingerprint !== fingerprintLock(lock)
    || call.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Provider probe response does not match the exact lock and graph request.');
  }
  const { provider, bindings } = selectedProvider(
    resolvedRoot,
    lock,
    call.provider.implementation
  );
  assertMcpRuntime(provider);
  const expectedPlan = probePlan(resolvedRoot, lock, provider, bindings);
  const hostTool = resolveHostTool(
    resolvedRoot,
    lock,
    provider,
    call.transport.operation
  );
  if (provider.pack !== call.provider.pack
    || provider.version !== call.provider.version
    || provider.runtime.server !== call.transport.server
    || !provider.runtime.probeTools.includes(call.transport.operation)
    || hostTool.nativeTool !== call.transport.tool
    || fingerprintJson(expectedPlan) !== fingerprintJson(call.plan)) {
    throw new Error('Provider probe response does not match the exact provider and probe plan request.');
  }
  const responseFingerprint = fingerprintJson(response);

  try {
    const implementation = await loadProviderModule(resolvedRoot, provider, translator);
    const complete = implementation[provider.runtime.probeCompleteExport];
    if (typeof complete !== 'function') {
      throw Object.assign(
        new Error('MCP probe complete export is not a function: ' + provider.runtime.probeCompleteExport),
        { kind: 'validation' }
      );
    }
    const observations = await complete({
      response,
      plan: call.plan,
      settings: lock.settings || {},
      mappings: loadProviderMappings(resolvedRoot, provider),
      at
    });
    assertObservationScope(call.plan, observations);
    const probe = {
      $contract: 'soter://contracts/provider-probe/v1',
      contractVersion: '1.0.0',
      id: call.probeId,
      probedAt: at,
      validUntil: validUntil(at, call.validForSeconds),
      configuration: {
        name: lock.configuration.name,
        lockFingerprint: fingerprintLock(lock)
      },
      provider: structuredClone(call.provider),
      credentials: observations.credentials,
      reachability: observations.reachability,
      authorities: observations.authorities,
      capabilities: observations.capabilities,
      secretValuesExcluded: true,
      limitations: observations.limitations
    };
    assertProbeContract(resolvedRoot, probe);
    const completed = {
      ...call,
      completedAt: at,
      state: 'completed',
      responseFingerprint,
      probeFingerprint: fingerprintJson(probe),
      error: null
    };
    assertCallContract(resolvedRoot, completed);
    return { call: completed, probe };
  } catch (error) {
    const failed = {
      ...call,
      completedAt: at,
      state: 'failed',
      responseFingerprint,
      probeFingerprint: null,
      error: normalizedError(error)
    };
    assertCallContract(resolvedRoot, failed);
    return { call: failed, probe: null };
  }
}

export function failProviderProbeCall({ root, lock, call, error, at }) {
  const resolvedRoot = path.resolve(root);
  assertCallContract(resolvedRoot, call);
  if (call.state !== 'requested') {
    throw new Error('Only a requested provider probe call can record a host failure.');
  }
  if (call.configurationLockFingerprint !== fingerprintLock(lock)
    || call.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Provider probe failure does not match the exact lock and graph request.');
  }
  const failed = {
    ...call,
    completedAt: at,
    state: 'failed',
    responseFingerprint: null,
    probeFingerprint: null,
    error: normalizedError(error)
  };
  assertCallContract(resolvedRoot, failed);
  return failed;
}
