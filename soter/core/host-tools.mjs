import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { evaluateEffectPolicy, listProviderDeclarations } from './capabilities.mjs';
import { assertContextRecordInput, assertContextRecordOutput } from './context-records.mjs';
import {
  assertMcpRuntime,
  containsCredentialMaterial,
  loadProviderMappings,
  loadProviderModule,
  normalizedError,
  resolveHostTool
} from './host-runtime.mjs';
import { fingerprintJson, readJson } from './lib/canonical-json.mjs';
import { fingerprintLock } from './resolve.mjs';

function schemaFailure(kind, failures) {
  return {
    kind: 'validation',
    message: kind + ' does not satisfy its schema: '
      + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
  };
}

function capabilityContract(root, capability) {
  return readJson(path.join(root, 'soter', 'capabilities', capability + '.json'));
}

function selectedProvider(root, lock, capability, containment, implementation) {
  const binding = lock.bindings.find((item) => item.capability === capability);
  if (!binding) throw new Error('No resolved binding for ' + capability + '.');
  const matches = listProviderDeclarations(root).filter((provider) => {
    return provider.pack === binding.providerPack
      && provider.containment === containment
      && (!implementation || provider.id === implementation)
      && provider.capabilities.some((item) => {
        return item.id === capability && item.version === binding.capabilityVersion;
      });
  });
  if (matches.length !== 1) {
    throw new Error(
      'Expected one ' + containment + ' MCP implementation for '
        + binding.providerPack + '/' + capability + '; found ' + matches.length + '.'
    );
  }
  return { binding, provider: matches[0] };
}

function assertAuthority(lock, binding, provider, authority) {
  if (!binding.authorities.includes(authority)) {
    throw new Error(authority + ' is outside the resolved authority set for ' + binding.capability + '.');
  }
  const declaration = lock.authorities.find((item) => item.id === authority);
  if (!declaration) throw new Error('Unknown resolved authority ' + authority + '.');
  if (!provider.authorities.some((item) => {
    return item.role === declaration.role && item.subject === declaration.subject;
  })) {
    throw new Error(provider.id + ' does not support authority ' + authority + '.');
  }
  return declaration;
}

function assertCallContract(root, call) {
  const schema = readJson(path.join(root, 'soter/contracts/host-tool-call.schema.json'));
  const failures = validateJsonSchema(call, schema);
  if (failures.length) {
    throw new Error(
      'Host tool call does not satisfy its contract: '
        + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function terminalCall(base, state, completedAt, error) {
  return {
    ...base,
    completedAt,
    state,
    transport: {
      ...base.transport,
      operation: null,
      tool: null
    },
    arguments: null,
    argumentsFingerprint: null,
    responseFingerprint: null,
    outputFingerprint: null,
    error
  };
}

export async function preflightHostToolBinding({
  root,
  lock,
  capability,
  authority,
  containment = 'connected',
  providerImplementation,
  approvedEffects = []
}) {
  const resolvedRoot = path.resolve(root);
  const { binding, provider } = selectedProvider(
    resolvedRoot,
    lock,
    capability,
    containment,
    providerImplementation
  );
  assertMcpRuntime(provider);
  assertAuthority(lock, binding, provider, authority);
  loadProviderMappings(resolvedRoot, provider);
  const contract = capabilityContract(resolvedRoot, capability);
  const decisions = evaluateEffectPolicy(lock, contract.effects, approvedEffects);
  if (decisions.some((item) => item.decision === 'blocked')) {
    throw Object.assign(
      new Error('Effect policy blocks ' + capability + ' before bound input resolution.'),
      { kind: 'authorization' }
    );
  }
  const implementation = await loadProviderModule(resolvedRoot, provider, null);
  if (typeof implementation[provider.runtime.prepareExport] !== 'function'
    || typeof implementation[provider.runtime.completeExport] !== 'function') {
    throw Object.assign(
      new Error('MCP translator prepare and completion exports must both be functions.'),
      { kind: 'validation' }
    );
  }
  for (const logicalTool of provider.runtime.tools) {
    resolveHostTool(resolvedRoot, lock, provider, logicalTool);
  }
  return {
    capability: { id: capability, version: contract.version },
    provider: {
      pack: provider.pack,
      implementation: provider.id,
      version: provider.version,
      containment: provider.containment
    },
    authority,
    policyDecisions: decisions
  };
}

export async function prepareHostToolCall({
  root,
  lock,
  runId,
  callId,
  capability,
  authority,
  containment = 'connected',
  providerImplementation,
  input,
  at,
  approvedEffects = [],
  translator = null
}) {
  const resolvedRoot = path.resolve(root);
  const { binding, provider } = selectedProvider(
    resolvedRoot,
    lock,
    capability,
    containment,
    providerImplementation
  );
  assertMcpRuntime(provider);
  const authorityDeclaration = assertAuthority(lock, binding, provider, authority);
  const mappings = loadProviderMappings(resolvedRoot, provider);
  const contract = capabilityContract(resolvedRoot, capability);
  const decisions = evaluateEffectPolicy(lock, contract.effects, approvedEffects);
  const base = {
    $contract: 'soter://contracts/host-tool-call/v1',
    contractVersion: '1.0.0',
    id: callId,
    runId,
    createdAt: at,
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
    capability: {
      id: capability,
      version: contract.version
    },
    authority,
    declaredEffects: contract.effects,
    policyDecisions: decisions,
    inputFingerprint: fingerprintJson(input),
    transport: {
      protocol: 'mcp',
      server: provider.runtime.server,
      operation: null,
      tool: null
    },
    secretValuesExcluded: true
  };

  if (decisions.some((item) => item.decision === 'blocked')) {
    const call = terminalCall(base, 'blocked', at, {
      kind: 'authorization',
      message: 'Effect policy blocked ' + capability + ' before a host tool request was emitted.'
    });
    assertCallContract(resolvedRoot, call);
    return { call };
  }

  const inputFailures = validateJsonSchema(input, contract.inputSchema);
  if (inputFailures.length) {
    const call = terminalCall(base, 'failed', at, schemaFailure('Capability input', inputFailures));
    assertCallContract(resolvedRoot, call);
    return { call };
  }

  try {
    assertContextRecordInput(resolvedRoot, capability, input, {
      packIds: lock.packs.filter((pack) => pack.layer === 'context').map((pack) => pack.id)
    });
    const implementation = await loadProviderModule(resolvedRoot, provider, translator);
    const prepare = implementation[provider.runtime.prepareExport];
    if (typeof prepare !== 'function') {
      throw Object.assign(
        new Error('MCP translator prepare export is not a function: ' + provider.runtime.prepareExport),
        { kind: 'validation' }
      );
    }
    const request = await prepare({
      capability,
      input,
      authority,
      authorityDeclaration,
      settings: lock.settings || {},
      mappings,
      at
    });
    if (!request || typeof request.tool !== 'string' || !request.arguments
      || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) {
      throw Object.assign(
        new Error('MCP translator must return { tool, arguments }.'),
        { kind: 'validation' }
      );
    }
    if (!provider.runtime.tools.includes(request.tool)) {
      throw Object.assign(
        new Error('Translator requested undeclared MCP tool ' + request.tool + '.'),
        { kind: 'validation' }
      );
    }
    const hostTool = resolveHostTool(resolvedRoot, lock, provider, request.tool);
    if (containsCredentialMaterial(request.arguments)) {
      throw Object.assign(
        new Error('MCP arguments contain credential-like material; host-managed authentication must stay outside the request.'),
        { kind: 'validation' }
      );
    }
    const call = {
      ...base,
      completedAt: null,
      state: 'requested',
      transport: {
        ...base.transport,
        operation: request.tool,
        tool: hostTool.nativeTool
      },
      arguments: request.arguments,
      argumentsFingerprint: fingerprintJson(request.arguments),
      responseFingerprint: null,
      outputFingerprint: null,
      error: null
    };
    assertCallContract(resolvedRoot, call);
    return { call };
  } catch (error) {
    const call = terminalCall(base, 'failed', at, normalizedError(error, 'validation'));
    assertCallContract(resolvedRoot, call);
    return { call };
  }
}

export async function completeHostToolCall({
  root,
  lock,
  call,
  input,
  response,
  at,
  translator = null
}) {
  const resolvedRoot = path.resolve(root);
  assertCallContract(resolvedRoot, call);
  if (call.state !== 'requested') {
    throw new Error('Only a requested host tool call can be completed.');
  }
  if (call.configurationLockFingerprint !== fingerprintLock(lock)
    || call.graphFingerprint !== lock.graphFingerprint
    || call.inputFingerprint !== fingerprintJson(input)) {
    throw new Error('Host tool response does not match the exact lock, graph, and capability input request.');
  }
  const { provider } = selectedProvider(
    resolvedRoot,
    lock,
    call.capability.id,
    call.provider.containment,
    call.provider.implementation
  );
  assertMcpRuntime(provider);
  const hostTool = resolveHostTool(
    resolvedRoot,
    lock,
    provider,
    call.transport.operation
  );
  if (provider.pack !== call.provider.pack
    || provider.version !== call.provider.version
    || provider.runtime.server !== call.transport.server
    || !provider.runtime.tools.includes(call.transport.operation)
    || hostTool.nativeTool !== call.transport.tool) {
    throw new Error('Host tool response does not match the exact provider request.');
  }
  const contract = capabilityContract(resolvedRoot, call.capability.id);
  const responseFingerprint = fingerprintJson(response);

  try {
    const implementation = await loadProviderModule(resolvedRoot, provider, translator);
    const complete = implementation[provider.runtime.completeExport];
    if (typeof complete !== 'function') {
      throw Object.assign(
        new Error('MCP translator complete export is not a function: ' + provider.runtime.completeExport),
        { kind: 'validation' }
      );
    }
    const output = await complete({
      capability: call.capability.id,
      input,
      authority: call.authority,
      response,
      settings: lock.settings || {},
      mappings: loadProviderMappings(resolvedRoot, provider),
      at
    });
    const outputFailures = validateJsonSchema(output, contract.outputSchema);
    const outputFingerprint = fingerprintJson(output);
    if (outputFailures.length) {
      const completed = {
        ...call,
        completedAt: at,
        state: 'failed',
        responseFingerprint,
        outputFingerprint,
        error: schemaFailure('Normalized capability output', outputFailures)
      };
      assertCallContract(resolvedRoot, completed);
      return { call: completed, output };
    }
    assertContextRecordOutput(resolvedRoot, call.capability.id, output, {
      packIds: lock.packs.filter((pack) => pack.layer === 'context').map((pack) => pack.id)
    });
    const completed = {
      ...call,
      completedAt: at,
      state: 'completed',
      responseFingerprint,
      outputFingerprint,
      error: null
    };
    assertCallContract(resolvedRoot, completed);
    return { call: completed, output };
  } catch (error) {
    const failed = {
      ...call,
      completedAt: at,
      state: 'failed',
      responseFingerprint,
      outputFingerprint: null,
      error: normalizedError(error)
    };
    assertCallContract(resolvedRoot, failed);
    return { call: failed, output: null };
  }
}

export function failHostToolCall({ root, lock, call, error, at }) {
  const resolvedRoot = path.resolve(root);
  assertCallContract(resolvedRoot, call);
  if (call.state !== 'requested') {
    throw new Error('Only a requested host tool call can record a host failure.');
  }
  if (call.configurationLockFingerprint !== fingerprintLock(lock)
    || call.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Host tool failure does not match the exact lock and graph request.');
  }
  const failed = {
    ...call,
    completedAt: at,
    state: 'failed',
    responseFingerprint: null,
    outputFingerprint: null,
    error: normalizedError(error)
  };
  assertCallContract(resolvedRoot, failed);
  return failed;
}
