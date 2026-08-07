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
    code: 'HOST_CALL_SCHEMA_INVALID',
    message: 'The exact host operation data did not satisfy its governed schema.',
    diagnosticFingerprint: fingerprintJson({
      subject: kind,
      failures: failures.slice(0, 5).map((item) => ({
        path: item.path,
        message: item.message
      }))
    })
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

function paginationDeclaration(provider, capability) {
  const pagination = provider.runtime.pagination;
  return pagination?.capabilities?.includes(capability) ? pagination : null;
}

function pageCallId(baseCallId, sequence) {
  return sequence === 1 ? baseCallId : baseCallId + '.page-' + sequence;
}

function pageProgress(pages) {
  return pages.reduce((value, item) => ({
    observedCountBefore: value.observedCountBefore + item.page.observedCount,
    includedCountBefore: value.includedCountBefore + item.page.includedCount,
    excludedCountBefore: value.excludedCountBefore + item.page.excludedCount
  }), {
    observedCountBefore: 0,
    includedCountBefore: 0,
    excludedCountBefore: 0
  });
}

function assertPaginatedTransitionAt(call, at) {
  const observedAt = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  const createdAt = Date.parse(call.createdAt);
  if (!Number.isFinite(observedAt)
    || new Date(observedAt).toISOString() !== at
    || !Number.isFinite(createdAt)
    || observedAt < createdAt) {
    throw new Error(
      'Paginated host call transition time must be a valid canonical ISO instant at or after the current call creation time.'
    );
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function priorNormalizedPages(pages) {
  return deepFreeze(structuredClone(pages.map((item) => ({
    sequence: item.sequence,
    page: item.page,
    pageFingerprint: item.pageFingerprint
  }))));
}

function physicalPageRequestFingerprint({
  transport,
  argumentsFingerprint,
  sequence,
  maximumPages,
  priorPages
}) {
  return fingerprintJson({
    transport,
    argumentsFingerprint,
    sequence,
    maximumPages,
    priorPageReceiptFingerprints: priorPages.map((item) => fingerprintJson(item))
  });
}

function currentPageRequestFingerprint(call) {
  const priorPages = call.pagination.pages.filter((item) => {
    return item.sequence < call.pagination.currentPage;
  });
  return physicalPageRequestFingerprint({
    transport: call.transport,
    argumentsFingerprint: call.argumentsFingerprint,
    sequence: call.pagination.currentPage,
    maximumPages: call.pagination.maximumPages,
    priorPages
  });
}

function normalizedKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function containsCursorField(value) {
  if (Array.isArray(value)) return value.some(containsCursorField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    return ['cursor', 'nextcursor'].includes(normalizedKey(key)) || containsCursorField(child);
  });
}

function assertNormalizedPage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('Paginated provider completion must return one page object.'), {
      kind: 'validation'
    });
  }
  const keys = Object.keys(value).sort();
  const expected = [
    'data',
    'excludedCount',
    'includedCount',
    'observedCount',
    'observedIdentityFingerprints'
  ].sort();
  if (fingerprintJson(keys) !== fingerprintJson(expected)
    || !Number.isInteger(value.observedCount) || value.observedCount < 0
    || !Number.isInteger(value.includedCount) || value.includedCount < 0
    || !Number.isInteger(value.excludedCount) || value.excludedCount < 0
    || value.observedCount !== value.includedCount + value.excludedCount
    || !Array.isArray(value.observedIdentityFingerprints)
    || value.observedIdentityFingerprints.length !== value.observedCount
    || new Set(value.observedIdentityFingerprints).size !== value.observedIdentityFingerprints.length
    || value.observedIdentityFingerprints.some((item) => {
      return typeof item !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item);
    })
    || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)
    || containsCursorField(value.data)) {
    throw Object.assign(
      new Error('Paginated provider completion returned an invalid normalized page.'),
      { kind: 'validation' }
    );
  }
  return value;
}

function normalizedOutputCoverage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const base = {
    complete: value.complete,
    cursorExhausted: value.cursorExhausted,
    pagesRead: value.pagesRead,
    observedCount: value.observedCount
  };
  if (Object.hasOwn(value, 'includedCount') && Object.hasOwn(value, 'excludedCount')) {
    return {
      ...base,
      includedCount: value.includedCount,
      excludedCount: value.excludedCount
    };
  }
  if (Object.hasOwn(value, 'includedHumanCount')
    && Object.hasOwn(value, 'excludedBotCount')) {
    return {
      ...base,
      includedCount: value.includedHumanCount,
      excludedCount: value.excludedBotCount
    };
  }
  if (Object.hasOwn(value, 'includedCount')
    && Number.isInteger(value.observedCount)
    && Number.isInteger(value.includedCount)) {
    return {
      ...base,
      includedCount: value.includedCount,
      excludedCount: value.observedCount - value.includedCount
    };
  }
  return null;
}

function assertContinuation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('Paginated provider completion omitted continuation state.'), {
      kind: 'validation'
    });
  }
  const keys = Object.keys(value).sort();
  if (value.state === 'exhausted') {
    if (fingerprintJson(keys) !== fingerprintJson(['state'])) {
      throw Object.assign(new Error('Exhausted pagination cannot retain a cursor.'), {
        kind: 'validation'
      });
    }
    return { state: 'exhausted', cursor: null };
  }
  if (value.state !== 'more'
    || fingerprintJson(keys) !== fingerprintJson(['cursor', 'state'].sort())
    || typeof value.cursor !== 'string' || !value.cursor.trim()
    || value.cursor.length > 8192) {
    throw Object.assign(new Error('Continued pagination requires one bounded opaque cursor.'), {
      kind: 'validation'
    });
  }
  return { state: 'more', cursor: value.cursor };
}

function assertPaginationSemantics(call) {
  const pagination = call.pagination;
  if (!pagination) return;
  if (pagination.baseCallId !== pageCallId(pagination.baseCallId, 1)
    || pagination.pages.length > pagination.maximumPages) {
    throw new Error('Host tool pagination metadata is invalid.');
  }
  const identities = new Set();
  for (let index = 0; index < pagination.pages.length; index += 1) {
    const receipt = pagination.pages[index];
    if (receipt.sequence !== index + 1
      || receipt.callId !== pageCallId(pagination.baseCallId, receipt.sequence)
      || receipt.pageFingerprint !== fingerprintJson(receipt.page)
      || receipt.page.observedCount
        !== receipt.page.includedCount + receipt.page.excludedCount
      || receipt.page.observedIdentityFingerprints.length !== receipt.page.observedCount
      || (receipt.continuationState === 'more') !== Boolean(receipt.nextCursorFingerprint)
      || (index === 0) !== (receipt.inputCursorFingerprint === null)
      || (index > 0
        && receipt.inputCursorFingerprint !== pagination.pages[index - 1].nextCursorFingerprint)) {
      throw new Error('Host tool page receipt does not preserve exact sequence and coverage.');
    }
    if (receipt.requestFingerprint !== physicalPageRequestFingerprint({
        transport: receipt.transport,
        argumentsFingerprint: receipt.argumentsFingerprint,
        sequence: receipt.sequence,
        maximumPages: pagination.maximumPages,
        priorPages: pagination.pages.slice(0, index)
      })) {
      throw new Error('Host tool page receipt does not match its exact physical request.');
    }
    if (receipt.transport.protocol !== 'mcp'
      || receipt.transport.server !== call.transport.server
      || !receipt.transport.operation
      || !receipt.transport.tool
      || !receipt.transport.responseProfile) {
      throw new Error('Host tool page receipt does not preserve its exact provider transport.');
    }
    for (const identity of receipt.page.observedIdentityFingerprints) {
      if (identities.has(identity)) {
        throw new Error('Host tool pagination contains a duplicate observed identity.');
      }
      identities.add(identity);
    }
  }
  const expectedPage = call.state === 'completed'
    ? pagination.pages.length
    : pagination.pages.length + 1;
  if (pagination.currentPage !== expectedPage
    || call.id !== pageCallId(pagination.baseCallId, pagination.currentPage)) {
    throw new Error('Host tool call does not identify the exact current pagination page.');
  }
  if (pagination.currentRequestFingerprint !== currentPageRequestFingerprint(call)) {
    throw new Error('Host tool call does not match its exact current physical page request.');
  }
  if (call.state === 'requested') {
    if (!call.arguments
      || call.argumentsFingerprint !== fingerprintJson(call.arguments)
      || pagination.failedRequestFingerprint
      || pagination.pages.some((page) => page.continuationState !== 'more')) {
      throw new Error('Requested pagination cannot follow an exhausted page.');
    }
  } else if (call.state === 'completed') {
    if (!pagination.pages.length
      || pagination.pages.at(-1).continuationState !== 'exhausted'
      || call.arguments !== null
      || pagination.failedRequestFingerprint) {
      throw new Error('Completed pagination does not end in an exhausted minimized call.');
    }
  } else if (call.state === 'failed') {
    if (call.arguments !== null || !pagination.failedRequestFingerprint) {
      throw new Error('Failed pagination did not minimize its exact physical request.');
    }
  }
}

function collectFingerprintMatches(value, targetFingerprint, matches) {
  if (typeof value === 'string') {
    if (value.length <= 8192 && fingerprintJson(value) === targetFingerprint) {
      matches.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectFingerprintMatches(child, targetFingerprint, matches);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) {
    collectFingerprintMatches(child, targetFingerprint, matches);
  }
}

function reconstructContinuation(call, input) {
  if (call.pagination.currentPage === 1) return null;
  const cursorFingerprint = call.pagination.pages.at(-1)?.nextCursorFingerprint;
  if (!cursorFingerprint) {
    throw new Error(
      'Paginated read recovery cannot reconstruct a continuation without its sealed fingerprint.'
    );
  }
  const matches = new Set();
  collectFingerprintMatches(input, cursorFingerprint, matches);
  for (const receipt of call.pagination.pages) {
    collectFingerprintMatches(receipt.page.data, cursorFingerprint, matches);
  }
  if (matches.size !== 1) {
    throw new Error(
      'Paginated read recovery could not derive one exact continuation from normalized private state.'
    );
  }
  return {
    cursor: [...matches][0],
    cursorFingerprint
  };
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
  if (call.configuration
    && (call.configuration.lockFingerprint !== call.configurationLockFingerprint
      || call.configuration.graphFingerprint !== call.graphFingerprint)) {
    throw new Error('Host tool call configuration selection does not match its exact lock and graph.');
  }
  assertPaginationSemantics(call);
}

export function assertHostToolCall(root, call) {
  assertCallContract(path.resolve(root), call);
  return call;
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

function minimizedPaginatedFailure(call) {
  if (!call.pagination) return call;
  return {
    ...call,
    arguments: null,
    pagination: {
      ...call.pagination,
      failedRequestFingerprint: fingerprintJson(call)
    }
  };
}

async function translatedMcpRequest({
  root,
  lock,
  provider,
  implementation,
  capability,
  input,
  authority,
  authorityDeclaration,
  mappings,
  at,
  continuation,
  page,
  priorPages
}) {
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
    at,
    continuation,
    page,
    priorPages
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
  const hostTool = resolveHostTool(root, lock, provider, request.tool);
  if (containsCredentialMaterial(request.arguments)) {
    throw Object.assign(
      new Error('MCP arguments contain credential-like material; host-managed authentication must stay outside the request.'),
      { kind: 'validation' }
    );
  }
  return {
    transport: {
      protocol: 'mcp',
      server: provider.runtime.server,
      operation: request.tool,
      tool: hostTool.nativeTool,
      responseProfile: hostTool.responseProfile
    },
    arguments: request.arguments,
    argumentsFingerprint: fingerprintJson(request.arguments)
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
  const pagination = paginationDeclaration(provider, capability);
  if (pagination
    && (typeof implementation[pagination.completePageExport] !== 'function'
      || typeof implementation[pagination.finalizeExport] !== 'function')) {
    throw Object.assign(
      new Error('MCP pagination completion and finalization exports must both be functions.'),
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
    policyDecisions: decisions,
    paginated: Boolean(pagination)
  };
}

export async function prepareHostToolCall({
  root,
  lock,
  configuration = null,
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
  if (configuration
    && (configuration.name !== lock.configuration.name
      || configuration.path !== lock.configuration.path
      || configuration.lockFingerprint !== fingerprintLock(lock)
      || configuration.graphFingerprint !== lock.graphFingerprint)) {
    throw new Error(
      'Host tool call configuration selection does not match the exact selected lock.'
    );
  }
  const base = {
    $contract: 'soter://contracts/host-tool-call/v1',
    contractVersion: '1.0.0',
    id: callId,
    runId,
    createdAt: at,
    ...(configuration ? { configuration: structuredClone(configuration) } : {}),
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
      tool: null,
      responseProfile: null
    },
    secretValuesExcluded: true
  };

  if (decisions.some((item) => item.decision === 'blocked')) {
    const call = terminalCall(
      base,
      'blocked',
      at,
      normalizedError({ kind: 'authorization' })
    );
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
    const pagination = paginationDeclaration(provider, capability);
    if (pagination
      && (typeof implementation[pagination.completePageExport] !== 'function'
        || typeof implementation[pagination.finalizeExport] !== 'function')) {
      throw Object.assign(
        new Error('MCP pagination completion and finalization exports must both be functions.'),
        { kind: 'validation' }
      );
    }
    const request = await translatedMcpRequest({
      root: resolvedRoot,
      lock,
      provider,
      implementation,
      capability,
      input,
      authority,
      authorityDeclaration,
      mappings,
      at,
      continuation: null,
      page: pagination ? {
        sequence: 1,
        maximumPages: pagination.maximumPages,
        ...pageProgress([])
      } : null,
      priorPages: priorNormalizedPages([])
    });
    const call = {
      ...base,
      completedAt: null,
      state: 'requested',
      transport: request.transport,
      arguments: request.arguments,
      argumentsFingerprint: request.argumentsFingerprint,
      responseFingerprint: null,
      outputFingerprint: null,
      error: null,
      ...(pagination ? {
        pagination: {
          baseCallId: callId,
          maximumPages: pagination.maximumPages,
          currentPage: 1,
          pages: [],
          cursorValuesExcluded: true,
          rawProviderResponsesExcluded: true
        }
      } : {})
    };
    if (pagination) {
      call.pagination.currentRequestFingerprint = currentPageRequestFingerprint(call);
    }
    assertCallContract(resolvedRoot, call);
    return { call };
  } catch (error) {
    const call = terminalCall(base, 'failed', at, normalizedError(error, 'validation'));
    assertCallContract(resolvedRoot, call);
    return { call };
  }
}

export async function repreparePaginatedHostToolCall({
  root,
  lock,
  call,
  input,
  at,
  translator = null
}) {
  const resolvedRoot = path.resolve(root);
  assertCallContract(resolvedRoot, call);
  if (call.state !== 'failed'
    || !call.pagination
    || call.arguments !== null
    || !call.pagination.failedRequestFingerprint
    || !['HOST_CALL_RATE_LIMITED', 'HOST_CALL_RETRYABLE_FAILURE'].includes(call.error?.code)
    || call.declaredEffects.some((effect) => !['read', 'disclosure'].includes(effect))
    || call.configurationLockFingerprint !== fingerprintLock(lock)
    || call.graphFingerprint !== lock.graphFingerprint
    || call.inputFingerprint !== fingerprintJson(input)) {
    throw new Error(
      'Paginated read recovery requires one exact minimized failed physical request.'
    );
  }
  const { binding, provider } = selectedProvider(
    resolvedRoot,
    lock,
    call.capability.id,
    call.provider.containment,
    call.provider.implementation
  );
  assertMcpRuntime(provider);
  const paginationDeclarationValue = paginationDeclaration(provider, call.capability.id);
  if (!paginationDeclarationValue
    || paginationDeclarationValue.maximumPages !== call.pagination.maximumPages
    || provider.pack !== call.provider.pack
    || provider.version !== call.provider.version) {
    throw new Error(
      'Paginated read recovery no longer matches its exact provider declaration.'
    );
  }
  const authorityDeclaration = assertAuthority(lock, binding, provider, call.authority);
  const implementation = await loadProviderModule(resolvedRoot, provider, translator);
  const continuation = reconstructContinuation(call, input);
  const request = await translatedMcpRequest({
    root: resolvedRoot,
    lock,
    provider,
    implementation,
    capability: call.capability.id,
    input,
    authority: call.authority,
    authorityDeclaration,
    mappings: loadProviderMappings(resolvedRoot, provider),
    at,
    continuation,
    page: {
      sequence: call.pagination.currentPage,
      maximumPages: call.pagination.maximumPages,
      ...pageProgress(call.pagination.pages)
    },
    priorPages: priorNormalizedPages(call.pagination.pages)
  });
  const nextPagination = structuredClone(call.pagination);
  delete nextPagination.failedRequestFingerprint;
  const requested = {
    ...structuredClone(call),
    createdAt: at,
    completedAt: null,
    state: 'requested',
    transport: request.transport,
    arguments: request.arguments,
    argumentsFingerprint: request.argumentsFingerprint,
    responseFingerprint: null,
    outputFingerprint: null,
    error: null,
    pagination: nextPagination
  };
  if (fingerprintJson(requested.transport) !== fingerprintJson(call.transport)
    || requested.argumentsFingerprint !== call.argumentsFingerprint
    || requested.pagination.currentRequestFingerprint !== currentPageRequestFingerprint(requested)) {
    throw new Error(
      'Paginated read recovery did not reconstruct the exact failed physical request.'
    );
  }
  const reconstructedFailed = {
    ...structuredClone(requested),
    createdAt: call.createdAt,
    completedAt: call.completedAt,
    state: 'failed',
    responseFingerprint: call.responseFingerprint,
    outputFingerprint: null,
    error: structuredClone(call.error)
  };
  if (call.pagination.failedRequestFingerprint !== fingerprintJson(reconstructedFailed)) {
    throw new Error(
      'Paginated read recovery did not match the sealed failed physical request.'
    );
  }
  assertCallContract(resolvedRoot, requested);
  return requested;
}

async function completePaginatedHostToolCall({
  root,
  lock,
  call,
  input,
  response,
  responseFingerprint,
  at,
  translator,
  provider,
  contract
}) {
  try {
    const pagination = paginationDeclaration(provider, call.capability.id);
    if (!pagination
      || pagination.maximumPages !== call.pagination.maximumPages) {
      throw Object.assign(
        new Error('Paginated host call no longer matches its exact provider declaration.'),
        { kind: 'conflict' }
      );
    }
    const implementation = await loadProviderModule(root, provider, translator);
    const completePage = implementation[pagination.completePageExport];
    const finalize = implementation[pagination.finalizeExport];
    if (typeof completePage !== 'function' || typeof finalize !== 'function') {
      throw Object.assign(
        new Error('MCP pagination completion and finalization exports must both be functions.'),
        { kind: 'validation' }
      );
    }
    const completed = await completePage({
      capability: call.capability.id,
      input,
      authority: call.authority,
      responseProfile: call.transport.responseProfile,
      response,
      page: {
        sequence: call.pagination.currentPage,
        maximumPages: call.pagination.maximumPages,
        inputCursorFingerprint: call.pagination.pages.at(-1)?.nextCursorFingerprint || null,
        ...pageProgress(call.pagination.pages)
      },
      priorPages: priorNormalizedPages(call.pagination.pages),
      settings: lock.settings || {},
      mappings: loadProviderMappings(root, provider),
      at
    });
    if (!completed || typeof completed !== 'object' || Array.isArray(completed)
      || fingerprintJson(Object.keys(completed).sort())
        !== fingerprintJson(['continuation', 'page'])) {
      throw Object.assign(
        new Error('Paginated provider completion must return exactly { page, continuation }.'),
        { kind: 'validation' }
      );
    }
    const page = assertNormalizedPage(completed.page);
    const continuation = assertContinuation(completed.continuation);
    if (continuation.state === 'more' && page.observedCount === 0) {
      throw Object.assign(
        new Error('Paginated provider returned an empty page with a continuation.'),
        { kind: 'conflict' }
      );
    }
    const nextCursorFingerprint = continuation.state === 'more'
      ? fingerprintJson(continuation.cursor)
      : null;
    const cursorFingerprints = new Set(call.pagination.pages.flatMap((receipt) => {
      return [receipt.inputCursorFingerprint, receipt.nextCursorFingerprint].filter(Boolean);
    }));
    if (nextCursorFingerprint && cursorFingerprints.has(nextCursorFingerprint)) {
      throw Object.assign(new Error('Paginated provider repeated a continuation cursor.'), {
        kind: 'conflict'
      });
    }
    const observedIdentities = new Set(call.pagination.pages.flatMap((receipt) => {
      return receipt.page.observedIdentityFingerprints;
    }));
    if (page.observedIdentityFingerprints.some((identity) => observedIdentities.has(identity))) {
      throw Object.assign(new Error('Paginated provider repeated an observed record identity.'), {
        kind: 'conflict'
      });
    }
    const receipt = {
      sequence: call.pagination.currentPage,
      callId: call.id,
      transport: structuredClone(call.transport),
      argumentsFingerprint: call.argumentsFingerprint,
      responseFingerprint,
      inputCursorFingerprint: call.pagination.pages.at(-1)?.nextCursorFingerprint || null,
      continuationState: continuation.state,
      nextCursorFingerprint,
      page: structuredClone(page),
      pageFingerprint: fingerprintJson(page),
      requestFingerprint: call.pagination.currentRequestFingerprint
    };
    const pages = [...call.pagination.pages, receipt];
    if (continuation.state === 'more') {
      if (pages.length >= pagination.maximumPages) {
        throw Object.assign(
          new Error('Paginated capability exceeded its exact maximum page count.'),
          { kind: 'validation' }
        );
      }
      const nextSequence = pages.length + 1;
      const { binding } = selectedProvider(
        root,
        lock,
        call.capability.id,
        call.provider.containment,
        call.provider.implementation
      );
      const authorityDeclaration = assertAuthority(lock, binding, provider, call.authority);
      const request = await translatedMcpRequest({
        root,
        lock,
        provider,
        implementation,
        capability: call.capability.id,
        input,
        authority: call.authority,
        authorityDeclaration,
        mappings: loadProviderMappings(root, provider),
        at,
        continuation: {
          cursor: continuation.cursor,
          cursorFingerprint: nextCursorFingerprint
        },
        page: {
          sequence: nextSequence,
          maximumPages: pagination.maximumPages,
          ...pageProgress(pages)
        },
        priorPages: priorNormalizedPages(pages)
      });
      const nextCall = {
        ...call,
        id: pageCallId(call.pagination.baseCallId, nextSequence),
        createdAt: at,
        completedAt: null,
        state: 'requested',
        transport: request.transport,
        arguments: request.arguments,
        argumentsFingerprint: request.argumentsFingerprint,
        responseFingerprint: null,
        outputFingerprint: null,
        error: null,
        pagination: {
          ...call.pagination,
          currentPage: nextSequence,
          pages
        }
      };
      nextCall.pagination.currentRequestFingerprint = currentPageRequestFingerprint(nextCall);
      assertCallContract(root, nextCall);
      return { call: nextCall, output: null, pending: true };
    }

    const totals = pages.reduce((value, item) => ({
      observedCount: value.observedCount + item.page.observedCount,
      includedCount: value.includedCount + item.page.includedCount,
      excludedCount: value.excludedCount + item.page.excludedCount
    }), { observedCount: 0, includedCount: 0, excludedCount: 0 });
    const exactCoverage = {
      complete: true,
      cursorExhausted: true,
      pagesRead: pages.length,
      ...totals
    };
    const output = await finalize({
      capability: call.capability.id,
      input,
      authority: call.authority,
      responseProfile: call.transport.responseProfile,
      pages: priorNormalizedPages(pages),
      coverage: structuredClone(exactCoverage),
      settings: lock.settings || {},
      mappings: loadProviderMappings(root, provider),
      at
    });
    const outputFailures = validateJsonSchema(output, contract.outputSchema);
    if (outputFailures.length) {
      throw Object.assign(
        new Error(schemaFailure('Normalized capability output', outputFailures).message),
        { kind: 'validation' }
      );
    }
    if (output && typeof output === 'object' && Object.hasOwn(output, 'coverage')) {
      const outputCoverage = normalizedOutputCoverage(output.coverage);
      if (!outputCoverage
        || fingerprintJson(outputCoverage) !== fingerprintJson(exactCoverage)) {
        throw Object.assign(
          new Error('Paginated normalized output changed Core-computed exact coverage.'),
          { kind: 'validation' }
        );
      }
    }
    assertContextRecordOutput(root, call.capability.id, output, {
      packIds: lock.packs.filter((pack) => pack.layer === 'context').map((pack) => pack.id)
    });
    const finished = {
      ...call,
      completedAt: at,
      state: 'completed',
      arguments: null,
      responseFingerprint,
      outputFingerprint: fingerprintJson(output),
      error: null,
      pagination: {
        ...call.pagination,
        currentPage: pages.length,
        pages
      }
    };
    assertCallContract(root, finished);
    return { call: finished, output, pending: false };
  } catch (error) {
    const failed = minimizedPaginatedFailure({
      ...call,
      completedAt: at,
      state: 'failed',
      responseFingerprint,
      outputFingerprint: null,
      error: normalizedError(error, 'validation')
    });
    assertCallContract(root, failed);
    return { call: failed, output: null, pending: false };
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
  if (call.pagination) assertPaginatedTransitionAt(call, at);
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
    || hostTool.nativeTool !== call.transport.tool
    || hostTool.responseProfile !== call.transport.responseProfile) {
    throw new Error('Host tool response does not match the exact provider request.');
  }
  const contract = capabilityContract(resolvedRoot, call.capability.id);
  const responseFingerprint = fingerprintJson(response);

  if (call.pagination) {
    return completePaginatedHostToolCall({
      root: resolvedRoot,
      lock,
      call,
      input,
      response,
      responseFingerprint,
      at,
      translator,
      provider,
      contract
    });
  }

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
      responseProfile: call.transport.responseProfile,
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
  if (call.pagination) assertPaginatedTransitionAt(call, at);
  if (call.configurationLockFingerprint !== fingerprintLock(lock)
    || call.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Host tool failure does not match the exact lock and graph request.');
  }
  const failed = minimizedPaginatedFailure({
    ...call,
    completedAt: at,
    state: 'failed',
    responseFingerprint: null,
    outputFingerprint: null,
    error: normalizedError(error)
  });
  assertCallContract(resolvedRoot, failed);
  return failed;
}
