import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import {
  fingerprintJson,
  importGovernedModule,
  readGovernedJson
} from './lib/canonical-json.mjs';
import { loadExactPreparedAutomationAcquisition } from './prepared-work.mjs';
import {
  getExactDurableContextSnapshot,
  getExactDurableHostExecution,
  recoverDurableOperationPlanReadExecution
} from './service.mjs';

function acquisitionError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function exactArguments(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(label + ' accepts only its exact declared arguments.');
  }
  return value;
}

function assertIdentifier(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(label + ' is invalid.');
  }
  return value;
}

function exactAutomationId(value) {
  return assertIdentifier(
    value,
    /^automation\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/,
    'Automation id'
  );
}

function exactWorkId(value) {
  return assertIdentifier(
    value,
    /^work\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/,
    'Prepared-work id'
  );
}

function exactCheckpointId(value) {
  return assertIdentifier(
    value,
    /^checkpoint\.plan\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/,
    'Operation-plan checkpoint id'
  );
}

export function assertDeclaredAutomationAcquisitionPlanIdentity(options) {
  exactArguments(
    options,
    new Set(['automationId', 'workId', 'planId']),
    'Connected-acquisition plan identity'
  );
  const automationId = exactAutomationId(options.automationId);
  const workId = exactWorkId(options.workId);
  const automationSlug = automationId.slice('automation.'.length);
  const workPrefix = 'work.' + automationSlug + '.';
  if (!workId.startsWith(workPrefix)) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_BINDING_INVALID',
      'Connected-acquisition prepared-work identity does not belong to the requested Automation.'
    );
  }
  const expectedPlanId = 'plan.' + automationSlug + '.connected-acquisition.'
    + workId.slice(workPrefix.length);
  if (options.planId !== expectedPlanId) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_CHECKPOINT_INVALID',
      'Connected-acquisition checkpoint plan identity does not match the exact requested Automation and prepared work.'
    );
  }
  return expectedPlanId;
}

async function loadDeclaredAcquisition({
  root,
  workId,
  automationId,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const exactAutomation = exactAutomationId(automationId);
  const exactWork = exactWorkId(workId);
  const exact = loadExactPreparedAutomationAcquisition({
    root: resolvedRoot,
    workId: exactWork,
    automationId: exactAutomation,
    expectedHost
  });
  let implementation;
  try {
    implementation = await importGovernedModule(
      resolvedRoot,
      exact.acquisition.module
    );
  } catch (error) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_DECLARATION_INVALID',
      'Connected-acquisition module could not be loaded from its exact governed declaration.',
      error
    );
  }
  const declaredExports = [
    exact.acquisition.prepareExport,
    exact.acquisition.finalizeExport,
    exact.acquisition.inspectExport,
    exact.acquisition.privateInspectExport
  ].filter(Boolean);
  if (new Set(declaredExports).size !== declaredExports.length
    || declaredExports.some((name) => typeof implementation[name] !== 'function')) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_DECLARATION_INVALID',
      'Connected-acquisition exports must be distinct callable exports of the exact declared module.'
    );
  }
  const publicInspectionPair = Boolean(exact.acquisition.inspectExport)
    === Boolean(exact.acquisition.inspectSchema);
  const privateInspectionPair = Boolean(exact.acquisition.privateInspectExport)
    === Boolean(exact.acquisition.privateInspectSchema);
  if (!publicInspectionPair || !privateInspectionPair
    || (exact.acquisition.privateInspectExport && !exact.acquisition.inspectExport)) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_DECLARATION_INVALID',
      'Connected-acquisition inspectors require exact paired public and private closed schema declarations.'
    );
  }
  return {
    root: resolvedRoot,
    workId: exactWork,
    automationId: exactAutomation,
    exact,
    implementation
  };
}

function exactCheckpointBinding({
  root,
  exact,
  checkpointId,
  expectedHost,
  requireCompleted = false
}) {
  const exactCheckpoint = exactCheckpointId(checkpointId);
  let execution;
  try {
    execution = getExactDurableHostExecution({
      root,
      checkpointId: exactCheckpoint,
      expectedHost
    });
  } catch (error) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_CHECKPOINT_INVALID',
      'Connected-acquisition checkpoint is unavailable or invalid.',
      error
    );
  }
  const { checkpoint, run } = execution;
  const expectedPlanId = assertDeclaredAutomationAcquisitionPlanIdentity({
    automationId: exact.work.automation.id,
    workId: exact.work.id,
    planId: checkpoint.plan?.id
  });
  const bound = checkpoint.id === exactCheckpoint
    && checkpoint.kind === 'operation-plan'
    && checkpoint.plan?.id === expectedPlanId
    && checkpoint.plan?.runId === exact.run.id
    && checkpoint.run?.id === exact.run.id
    && run?.id === exact.run.id
    && run.automation?.id === exact.work.automation.id
    && run.automation?.version === exact.work.automation.version
    && checkpoint.configurationLock?.path === exact.lockPath
    && checkpoint.configurationLock?.fingerprint
      === exact.work.configuration.lockFingerprint
    && checkpoint.graphFingerprint === exact.work.configuration.graphFingerprint
    && checkpoint.host?.id === exact.work.configuration.host
    && (!requireCompleted || checkpoint.state === 'completed');
  if (!bound) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_CHECKPOINT_INVALID',
      requireCompleted
        ? 'Connected acquisition requires one exact completed operation plan checkpoint bound to the requested prepared work, Automation, lock, graph, run, and host.'
        : 'Connected acquisition requires one exact operation-plan checkpoint bound to the requested prepared work, Automation, lock, graph, run, and host.'
    );
  }
  return execution;
}

function exactObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      label + ' did not return one exact object.'
    );
  }
  return value;
}

function assertClosedInspectionSchemaNode(value, at = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClosedInspectionSchemaNode(
      item,
      at + '[' + index + ']'
    ));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'object' && value.additionalProperties !== false) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_DECLARATION_INVALID',
      'Connected-acquisition inspection schemas must close every declared object.'
    );
  }
  for (const [key, child] of Object.entries(value)) {
    assertClosedInspectionSchemaNode(child, at + '.' + key);
  }
}

function declaredInspectionSchema(root, acquisition, privateSelectedWork) {
  const schemaPath = privateSelectedWork
    ? acquisition.privateInspectSchema
    : acquisition.inspectSchema;
  if (!schemaPath) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_INSPECTION_UNAVAILABLE',
      privateSelectedWork
        ? 'Automation does not declare a private selected-work acquisition inspection schema.'
        : 'Automation does not declare a sanitized acquisition inspection schema.'
    );
  }
  let schema;
  try {
    schema = readGovernedJson(root, schemaPath);
    if (typeof schema?.$id !== 'string' || schema.type !== 'object'
      || schema.additionalProperties !== false) {
      throw new Error('Inspection schema is not one exact closed object schema.');
    }
    assertClosedInspectionSchemaNode(schema);
  } catch (error) {
    if (error?.code === 'PREPARED_ACQUISITION_DECLARATION_INVALID') throw error;
    throw acquisitionError(
      'PREPARED_ACQUISITION_DECLARATION_INVALID',
      'Connected-acquisition inspection schema is unavailable or invalid.',
      error
    );
  }
  return schema;
}

function selfFingerprint(value) {
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function normalizedKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const FORBIDDEN_INSPECTION_KEYS = new Set([
  'absolutepath',
  'checkpointpath',
  'consumerroot',
  'filepath',
  'localpath',
  'providerenvelope',
  'rawproviderresponse',
  'rawproviderresponses',
  'repositoryroot',
  'rootpath',
  'runpath',
  'snapshotpath',
  'sourcepath',
  'privatestatepath',
  'privatestatepaths',
  'targetpath',
  'workspacepath'
]);

function containsForbiddenInspectionKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenInspectionKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    return FORBIDDEN_INSPECTION_KEYS.has(normalizedKey(key))
      || containsForbiddenInspectionKey(child);
  });
}

function assertInspectionProjection({
  root,
  exact,
  projection,
  schema,
  privateSelectedWork
}) {
  const label = privateSelectedWork
    ? 'Private selected-work acquisition inspection'
    : 'Sanitized acquisition inspection';
  const failures = validateJsonSchema(projection, schema);
  if (failures.length) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      label + ' does not satisfy its exact pack-declared closed schema.'
    );
  }
  if (typeof projection.fingerprint !== 'string'
    || projection.fingerprint !== selfFingerprint(projection)
    || projection.work?.id !== exact.work.id
    || projection.work?.fingerprint !== exact.work.fingerprint
    || projection.configuration?.lockFingerprint
      !== exact.work.configuration.lockFingerprint
    || projection.configuration?.graphFingerprint
      !== exact.work.configuration.graphFingerprint
    || projection.configuration?.host !== exact.work.configuration.host) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      label + ' does not bind the exact prepared work, configuration, lock, graph, host, and contents.'
    );
  }
  const authority = projection.authority;
  if (authority?.state !== 'none'
    || authority.approvalIncluded !== false
    || authority.continuationIncluded !== false
    || authority.providerWriteIncluded !== false
    || authority.retryAuthorityIncluded !== false) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      label + ' must preserve the provider-neutral no-authority boundary.'
    );
  }
  const privacy = projection.privacy;
  const commonPrivacy = privacy?.rawProviderResponsesIncluded === false
    && privacy.workspaceInspectionIncluded === false;
  const scopePrivacy = privateSelectedWork
    ? privacy?.scope === 'private-local-selected-work'
      && privacy?.projection === 'explicit-selected-work-only'
      && privacy?.evidenceIncluded === false
      && privacy?.canonicalArtifactsIncluded === false
    : privacy?.privateValuesIncluded === false;
  const serialized = JSON.stringify(projection);
  if (!commonPrivacy || !scopePrivacy
    || containsCredentialMaterial(projection)
    || containsForbiddenInspectionKey(projection)
    || serialized.includes(path.resolve(root))
    || serialized.includes('.soter/state')) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      label + ' exceeded its exact privacy boundary.'
    );
  }
  return projection;
}

function exactFinalizationProjection({
  root,
  exact,
  checkpointId,
  expectedHost,
  finalized
}) {
  const projection = exactObject(
    finalized,
    'Connected-acquisition finalize export'
  );
  const expectedKeys = [
    'checkpoint',
    'checkpointPath',
    'run',
    'runPath',
    'snapshot',
    'snapshotPath'
  ];
  if (fingerprintJson(Object.keys(projection).sort())
    !== fingerprintJson(expectedKeys)) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      'Connected-acquisition finalize export did not return one exact durable Context commit projection.'
    );
  }
  if (!projection.snapshot || typeof projection.snapshot.id !== 'string') {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      'Connected-acquisition finalize export did not return one exact durable Context snapshot.'
    );
  }
  let durableSnapshot;
  try {
    durableSnapshot = getExactDurableContextSnapshot({
      root,
      lockPath: exact.lockPath,
      snapshotId: projection.snapshot.id,
      expectedHost
    });
  } catch (error) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      'Connected-acquisition finalize export did not identify one exact durable Context snapshot.',
      error
    );
  }
  const execution = exactCheckpointBinding({
    root,
    exact,
    checkpointId,
    expectedHost,
    requireCompleted: true
  });
  const exactBinding = projection.checkpoint?.id === checkpointId
    && projection.snapshot.runId === exact.run.id
    && projection.run?.id === exact.run.id
    && durableSnapshot.snapshot.runId === exact.run.id
    && fingerprintJson(projection.snapshot)
      === fingerprintJson(durableSnapshot.snapshot)
    && projection.snapshotPath === durableSnapshot.snapshotPath
    && fingerprintJson(projection.run) === fingerprintJson(durableSnapshot.run)
    && projection.runPath === durableSnapshot.runPath
    && fingerprintJson(projection.checkpoint)
      === fingerprintJson(execution.checkpoint)
    && projection.checkpointPath === execution.checkpointPath
    && fingerprintJson(projection.run) === fingerprintJson(execution.run)
    && projection.runPath === execution.runPath;
  if (!exactBinding) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      'Connected-acquisition finalize export did not match the exact durable snapshot, run, checkpoint, paths, Automation, prepared work, lock, graph, and host.'
    );
  }
  return {
    checkpoint: execution.checkpoint,
    checkpointPath: execution.checkpointPath,
    snapshot: durableSnapshot.snapshot,
    snapshotPath: durableSnapshot.snapshotPath,
    run: durableSnapshot.run,
    runPath: durableSnapshot.runPath
  };
}

function sanitizedFinalizationReceipt(exact, finalized) {
  const value = {
    kind: 'connected-acquisition-finalization-receipt',
    version: '1.0.0',
    automation: {
      id: exact.work.automation.id,
      version: exact.work.automation.version
    },
    work: {
      id: exact.work.id,
      fingerprint: exact.work.fingerprint
    },
    configuration: {
      name: exact.work.configuration.name,
      lockFingerprint: exact.work.configuration.lockFingerprint,
      graphFingerprint: exact.work.configuration.graphFingerprint,
      host: exact.work.configuration.host
    },
    checkpoint: {
      id: finalized.checkpoint.id,
      fingerprint: finalized.checkpoint.checkpointFingerprint,
      state: finalized.checkpoint.state
    },
    snapshot: {
      id: finalized.snapshot.id,
      fingerprint: fingerprintJson(finalized.snapshot)
    },
    run: {
      id: finalized.run.id,
      fingerprint: fingerprintJson(finalized.run),
      lifecycleState: finalized.run.lifecycleState
    },
    authority: {
      state: 'none',
      approvalIncluded: false,
      continuationIncluded: false,
      retryAuthorityIncluded: false,
      providerCallAuthorityIncluded: false,
      providerWriteAuthorityIncluded: false
    },
    privacy: {
      scope: 'sanitized',
      snapshotValuesIncluded: false,
      providerResponsesIncluded: false,
      privateStatePathsIncluded: false
    }
  };
  return {
    ...value,
    receiptFingerprint: fingerprintJson(value)
  };
}

export async function assertDeclaredAutomationAcquisitionFinalization(options) {
  exactArguments(
    options,
    new Set([
      'root',
      'workId',
      'automationId',
      'checkpointId',
      'expectedHost',
      'finalized'
    ]),
    'Connected-acquisition finalization projection'
  );
  const {
    root,
    workId,
    automationId,
    checkpointId,
    expectedHost,
    finalized
  } = options;
  const declared = await loadDeclaredAcquisition({
    root,
    workId,
    automationId,
    expectedHost
  });
  return exactFinalizationProjection({
    root: declared.root,
    exact: declared.exact,
    checkpointId,
    expectedHost,
    finalized
  });
}

export async function prepareDeclaredAutomationAcquisition(options) {
  exactArguments(
    options,
    new Set(['root', 'workId', 'automationId', 'at', 'expectedHost']),
    'Connected-acquisition preparation'
  );
  const { root, workId, automationId, at, expectedHost } = options;
  const declared = await loadDeclaredAcquisition({
    root,
    workId,
    automationId,
    expectedHost
  });
  let prepared;
  try {
    prepared = exactObject(await declared.implementation[
      declared.exact.acquisition.prepareExport
    ]({
      root: declared.root,
      workId: declared.workId,
      at,
      expectedHost
    }), 'Connected-acquisition prepare export');
  } catch (error) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      'Connected-acquisition prepare export failed before Core could verify its exact checkpoint.',
      error
    );
  }
  const checkpointId = prepared.checkpoint?.id;
  if (typeof checkpointId !== 'string') {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      'Connected-acquisition prepare export did not return one durable operation-plan checkpoint.'
    );
  }
  const execution = exactCheckpointBinding({
    root: declared.root,
    exact: declared.exact,
    checkpointId,
    expectedHost
  });
  if (fingerprintJson(prepared) !== fingerprintJson(execution)) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      'Connected-acquisition prepare export did not return the exact durable Core projection.'
    );
  }
  return execution;
}

export async function recoverDeclaredAutomationAcquisition(options) {
  exactArguments(
    options,
    new Set([
      'root',
      'workId',
      'automationId',
      'checkpointId',
      'checkpointFingerprint',
      'stepId',
      'callId',
      'callFingerprint',
      'at',
      'expectedHost'
    ]),
    'Connected-acquisition read recovery'
  );
  const {
    root,
    workId,
    automationId,
    checkpointId,
    checkpointFingerprint,
    stepId,
    callId,
    callFingerprint,
    at,
    expectedHost
  } = options;
  const declared = await loadDeclaredAcquisition({
    root,
    workId,
    automationId,
    expectedHost
  });
  exactCheckpointBinding({
    root: declared.root,
    exact: declared.exact,
    checkpointId,
    expectedHost
  });
  let recovered;
  try {
    recovered = await recoverDurableOperationPlanReadExecution({
      root: declared.root,
      checkpointId,
      checkpointFingerprint,
      stepId,
      callId,
      callFingerprint,
      at,
      expectedHost
    });
  } catch (error) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_RECOVERY_INVALID',
      'Connected-acquisition read recovery was not eligible under the exact checkpoint and capability contract.',
      error
    );
  }
  const current = exactCheckpointBinding({
    root: declared.root,
    exact: declared.exact,
    checkpointId,
    expectedHost
  });
  const { recovery, idempotent, ...execution } = recovered;
  if (fingerprintJson(execution) !== fingerprintJson(current)) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      'Connected-acquisition recovery did not return the exact durable Core projection.'
    );
  }
  if (!current.currentCall
    || current.currentCall.state !== 'requested'
    || current.currentCall.id !== recovery.replacementCallId) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      'Connected-acquisition recovery did not return its exact pending replacement call.'
    );
  }
  return {
    ...current,
    recovery,
    idempotent
  };
}

export async function finalizeDeclaredAutomationAcquisition(options) {
  exactArguments(
    options,
    new Set(['root', 'workId', 'automationId', 'checkpointId', 'expectedHost']),
    'Connected-acquisition finalization'
  );
  const { root, workId, automationId, checkpointId, expectedHost } = options;
  const declared = await loadDeclaredAcquisition({
    root,
    workId,
    automationId,
    expectedHost
  });
  exactCheckpointBinding({
    root: declared.root,
    exact: declared.exact,
    checkpointId,
    expectedHost,
    requireCompleted: true
  });
  let finalized;
  try {
    finalized = exactObject(await declared.implementation[
      declared.exact.acquisition.finalizeExport
    ]({
      root: declared.root,
      checkpointId,
      expectedHost
    }), 'Connected-acquisition finalize export');
  } catch (error) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      'Connected-acquisition finalize export failed before Core could verify its durable result.',
      error
    );
  }
  const current = loadExactPreparedAutomationAcquisition({
    root: declared.root,
    workId: declared.workId,
    automationId: declared.automationId,
    expectedHost
  });
  const exactFinalized = exactFinalizationProjection({
    root: declared.root,
    exact: current,
    checkpointId,
    expectedHost,
    finalized
  });
  return sanitizedFinalizationReceipt(current, exactFinalized);
}

export async function assertDeclaredAutomationAcquisitionInspection(options) {
  exactArguments(
    options,
    new Set([
      'root',
      'workId',
      'automationId',
      'checkpointId',
      'expectedHost',
      'privateSelectedWork',
      'projection'
    ]),
    'Connected-acquisition inspection projection'
  );
  const {
    root,
    workId,
    automationId,
    checkpointId,
    expectedHost,
    privateSelectedWork,
    projection
  } = options;
  if (typeof privateSelectedWork !== 'boolean') {
    throw new TypeError(
      'Connected-acquisition inspection projection requires an exact privateSelectedWork boolean.'
    );
  }
  const declared = await loadDeclaredAcquisition({
    root,
    workId,
    automationId,
    expectedHost
  });
  exactCheckpointBinding({
    root: declared.root,
    exact: declared.exact,
    checkpointId,
    expectedHost,
    requireCompleted: true
  });
  const exportName = privateSelectedWork
    ? declared.exact.acquisition.privateInspectExport
    : declared.exact.acquisition.inspectExport;
  if (!exportName) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_INSPECTION_UNAVAILABLE',
      privateSelectedWork
        ? 'Automation does not declare a private selected-work acquisition inspector.'
        : 'Automation does not declare a sanitized acquisition inspector.'
    );
  }
  const schema = declaredInspectionSchema(
    declared.root,
    declared.exact.acquisition,
    privateSelectedWork
  );
  return assertInspectionProjection({
    root: declared.root,
    exact: declared.exact,
    projection: exactObject(
      projection,
      privateSelectedWork
        ? 'Private selected-work acquisition inspection'
        : 'Sanitized acquisition inspection'
    ),
    schema,
    privateSelectedWork
  });
}

async function inspectDeclaredAutomationAcquisition({
  root,
  workId,
  automationId,
  checkpointId,
  expectedHost,
  privateSelectedWork
}) {
  const declared = await loadDeclaredAcquisition({
    root,
    workId,
    automationId,
    expectedHost
  });
  exactCheckpointBinding({
    root: declared.root,
    exact: declared.exact,
    checkpointId,
    expectedHost,
    requireCompleted: true
  });
  const exportName = privateSelectedWork
    ? declared.exact.acquisition.privateInspectExport
    : declared.exact.acquisition.inspectExport;
  if (!exportName) {
    throw acquisitionError(
      'PREPARED_ACQUISITION_INSPECTION_UNAVAILABLE',
      privateSelectedWork
        ? 'Automation does not declare a private selected-work acquisition inspector.'
        : 'Automation does not declare a sanitized acquisition inspector.'
    );
  }
  const schema = declaredInspectionSchema(
    declared.root,
    declared.exact.acquisition,
    privateSelectedWork
  );
  try {
    const projection = exactObject(await declared.implementation[exportName]({
      root: declared.root,
      workId: declared.workId,
      expectedHost
    }), privateSelectedWork
      ? 'Private selected-work acquisition inspector'
      : 'Sanitized acquisition inspector');
    return assertInspectionProjection({
      root: declared.root,
      exact: declared.exact,
      projection,
      schema,
      privateSelectedWork
    });
  } catch (error) {
    if (error?.code === 'PREPARED_ACQUISITION_ADAPTER_INVALID') throw error;
    throw acquisitionError(
      'PREPARED_ACQUISITION_ADAPTER_INVALID',
      privateSelectedWork
        ? 'Private selected-work acquisition inspector failed.'
        : 'Sanitized acquisition inspector failed.',
      error
    );
  }
}

export function inspectDeclaredAutomationAcquisitionPublic(options) {
  exactArguments(
    options,
    new Set(['root', 'workId', 'automationId', 'checkpointId', 'expectedHost']),
    'Sanitized connected-acquisition inspection'
  );
  return inspectDeclaredAutomationAcquisition({
    ...options,
    privateSelectedWork: false
  });
}

export function inspectDeclaredAutomationAcquisitionPrivate(options) {
  exactArguments(
    options,
    new Set(['root', 'workId', 'automationId', 'checkpointId', 'expectedHost']),
    'Private selected-work connected-acquisition inspection'
  );
  return inspectDeclaredAutomationAcquisition({
    ...options,
    privateSelectedWork: true
  });
}
