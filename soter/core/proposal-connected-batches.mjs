import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { getExactDurableAutomationProposal } from './automation-proposals.mjs';
import { compileAutomationConnectedSelection } from './connected-compilers.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import { fingerprintJson, readJson } from './lib/canonical-json.mjs';
import { changeSetScopeFingerprint } from './transaction.mjs';

const CHANGE_SET_CONTRACT = 'soter://contracts/connected-change-set/v2';
const BATCH_CONTRACT = 'soter://contracts/connected-operation-batch/v2';

function codedError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function validate(root, value, schemaPath, label, code) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw codedError(
      code,
      label + ' does not satisfy its contract: '
        + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function batchFingerprint(batch) {
  const unsigned = structuredClone(batch);
  delete unsigned.batchFingerprint;
  return fingerprintJson(unsigned);
}

function proposedActionBindings(proposal) {
  const changes = new Map(proposal.review.proposedChanges.map((change) => [change.id, change]));
  const bindings = [];
  for (const collection of proposal.review.collections) {
    if (!collection.coverage.complete) {
      throw codedError(
        'PROPOSAL_CONNECTED_BATCH_SELECTION_INVALID',
        'Incomplete proposal review coverage cannot produce a connected batch.'
      );
    }
    for (const row of collection.rows) {
      for (const action of row.actions) {
        if (action.state !== 'proposed') continue;
        const change = changes.get(action.id);
        if (!change || action.capability === null || action.effect !== 'write'
          || action.changeFingerprint === null
          || action.changeFingerprint !== fingerprintJson(change)
          || change.effect !== action.capability
          || change.afterFingerprint === null) {
          throw codedError(
            'PROPOSAL_CONNECTED_BATCH_BINDING_INVALID',
            'Proposal actions do not bind one exact fingerprint-only write change.'
          );
        }
        bindings.push({ collection, row, action, change });
      }
    }
  }
  return bindings;
}

function selectedAction(binding, index) {
  return {
    id: binding.action.id,
    sequence: index + 1,
    kind: binding.action.kind,
    reasonCode: binding.action.reasonCode,
    capability: binding.action.capability,
    effect: binding.action.effect,
    source: {
      collectionId: binding.collection.id,
      rowId: binding.row.id,
      rowFingerprint: binding.row.fingerprint
    },
    subjectFingerprint: binding.row.subject.fingerprint,
    sourceActionFingerprint: fingerprintJson(binding.action),
    changeFingerprint: binding.action.changeFingerprint,
    contextValueFingerprint: binding.row.privateDetailFingerprint,
    proposedValueFingerprint: binding.change.afterFingerprint
  };
}

function itemMatchesSelection(item, selection) {
  return item?.sources?.some((source) => {
    return source.collectionId === selection.source.collectionId
      && source.rowId === selection.source.rowId
      && source.rowFingerprint === selection.source.rowFingerprint;
  });
}

function selectionMaterial(batch, exact, actions) {
  const items = new Map(exact.material.items.map((item) => [item.fingerprint, item]));
  const materialActions = actions.map((selection) => {
    const proposed = items.get(selection.proposedValueFingerprint);
    const context = selection.contextValueFingerprint === null
      ? null
      : items.get(selection.contextValueFingerprint);
    if (!itemMatchesSelection(proposed, selection)
      || (context && !itemMatchesSelection(context, selection))) {
      throw codedError(
        'PROPOSAL_CONNECTED_BATCH_BINDING_INVALID',
        'Selected proposal values do not bind their exact sanitized row and action.'
      );
    }
    return {
      selection: structuredClone(selection),
      context: context ? structuredClone(context) : null,
      proposed: structuredClone(proposed)
    };
  });
  if (containsCredentialMaterial(materialActions)) {
    throw codedError(
      'PROPOSAL_CONNECTED_BATCH_CREDENTIAL_REJECTED',
      'Selected proposal material cannot contain credential values.'
    );
  }
  return {
    batch: { id: batch.id, fingerprint: batch.fingerprint },
    actions: materialActions
  };
}

function selectionDocument(exact, batchId, selected) {
  const actions = selected.map(selectedAction);
  const fingerprint = fingerprintJson({
    proposalId: exact.proposal.id,
    proposalFingerprint: exact.proposal.proposalFingerprint,
    batchId,
    actions
  });
  return {
    id: batchId,
    fingerprint,
    automationId: exact.proposal.automation.id,
    actions
  };
}

function initialTransaction() {
  return {
    checkpointFingerprint: fingerprintJson(null),
    state: 'not-started',
    rollbackState: 'not-available',
    restoredFingerprint: null
  };
}

function initialVerification() {
  return {
    state: 'unknown',
    effectId: null,
    criteria: [],
    observedFingerprint: null
  };
}

function exactChangeSet({ exact, selected, operations, id, createdAt }) {
  const basis = {
    kind: 'automation-proposal',
    proposal: {
      id: exact.proposal.id,
      fingerprint: exact.proposal.proposalFingerprint
    },
    decision: {
      id: exact.proposal.decision.id,
      fingerprint: exact.proposal.decision.fingerprint
    },
    automation: structuredClone(exact.proposal.automation),
    actionIds: selected.actions.map((action) => action.id),
    selectionFingerprint: selected.fingerprint
  };
  const changeSet = {
    $contract: CHANGE_SET_CONTRACT,
    contractVersion: '2.0.0',
    id,
    runId: exact.proposal.runId,
    createdAt,
    configurationLockFingerprint: exact.proposal.configurationLockFingerprint,
    basis,
    state: 'proposed',
    scopeFingerprint: fingerprintJson(null),
    operations: operations.map((operation) => ({
      id: operation.id,
      sequence: operation.sequence,
      sourceActionId: operation.sourceActionId,
      capability: operation.capability,
      authority: operation.authority,
      reason: 'Apply the exact selected ' + operation.capability + ' proposal after confirmation.',
      input: structuredClone(operation.input),
      inputFingerprint: operation.inputFingerprint,
      state: 'pending',
      effectId: null,
      outputFingerprint: null,
      error: null
    })),
    approvalId: null,
    transaction: initialTransaction(),
    verification: initialVerification()
  };
  changeSet.scopeFingerprint = changeSetScopeFingerprint(changeSet);
  return changeSet;
}

function exactBatch({ exact, changeSet, compiled, id, createdAt }) {
  const batch = {
    $contract: BATCH_CONTRACT,
    contractVersion: '2.0.0',
    id,
    runId: exact.proposal.runId,
    createdAt,
    configurationLockFingerprint: exact.proposal.configurationLockFingerprint,
    changeSet: {
      id: changeSet.id,
      scopeFingerprint: changeSet.scopeFingerprint
    },
    automation: structuredClone(exact.proposal.automation),
    compiler: structuredClone(compiled.compiler),
    profile: 'verified-write-sequence',
    state: 'proposed',
    executable: true,
    blockers: [],
    operations: structuredClone(compiled.operations),
    batchFingerprint: fingerprintJson(null)
  };
  batch.batchFingerprint = batchFingerprint(batch);
  return batch;
}

export function assertProposalConnectedBatch({ root, batch, changeSet }) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    changeSet,
    'soter/contracts/connected-change-set-v2.schema.json',
    'Connected change set',
    'PROPOSAL_CONNECTED_BATCH_MALFORMED'
  );
  validate(
    resolvedRoot,
    batch,
    'soter/contracts/connected-operation-batch-v2.schema.json',
    'Connected operation batch',
    'PROPOSAL_CONNECTED_BATCH_MALFORMED'
  );
  const actionIds = changeSet.basis.actionIds;
  const operationsMatch = batch.operations.length === changeSet.operations.length
    && batch.operations.every((operation, index) => {
      const source = changeSet.operations[index];
      return source
        && operation.id === source.id
        && operation.sequence === source.sequence
        && operation.sourceActionId === source.sourceActionId
        && operation.capability === source.capability
        && operation.authority === source.authority
        && operation.inputFingerprint === source.inputFingerprint
        && fingerprintJson(operation.input) === fingerprintJson(source.input);
    });
  if (changeSet.$contract !== CHANGE_SET_CONTRACT
    || batch.$contract !== BATCH_CONTRACT
    || batch.batchFingerprint !== batchFingerprint(batch)
    || changeSet.scopeFingerprint !== changeSetScopeFingerprint(changeSet)
    || batch.runId !== changeSet.runId
    || batch.configurationLockFingerprint !== changeSet.configurationLockFingerprint
    || batch.changeSet.id !== changeSet.id
    || batch.changeSet.scopeFingerprint !== changeSet.scopeFingerprint
    || batch.automation.id !== changeSet.basis.automation.id
    || batch.automation.version !== changeSet.basis.automation.version
    || batch.profile !== 'verified-write-sequence'
    || !batch.executable || batch.state !== 'proposed' || batch.blockers.length
    || new Set(actionIds).size !== actionIds.length
    || new Set(batch.operations.map((operation) => operation.id)).size
      !== batch.operations.length
    || batch.operations.length !== actionIds.length
    || new Set(batch.operations.map((operation) => operation.sourceActionId)).size
      !== actionIds.length
    || actionIds.some((id) => !batch.operations.some((operation) => {
      return operation.sourceActionId === id;
    }))
    || !operationsMatch) {
    throw codedError(
      'PROPOSAL_CONNECTED_BATCH_BINDING_INVALID',
      'Connected change set and batch do not preserve one exact proposal selection and operation sequence.'
    );
  }
  return { batch, changeSet };
}

export async function createProposalConnectedBatch({
  root,
  lockPath,
  proposalId,
  actionIds,
  changeSetId,
  batchId,
  createdAt = new Date().toISOString(),
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const exact = getExactDurableAutomationProposal({
    root: resolvedRoot,
    lockPath,
    proposalId,
    expectedHost
  });
  if (exact.material.applicability !== 'current') {
    throw codedError(
      'PROPOSAL_CONNECTED_BATCH_STALE',
      'Stale proposal material cannot create a connected batch.'
    );
  }
  if (!Array.isArray(actionIds) || actionIds.length < 1 || actionIds.length > 100
    || actionIds.some((id) => typeof id !== 'string' || !id)
    || new Set(actionIds).size !== actionIds.length) {
    throw codedError(
      'PROPOSAL_CONNECTED_BATCH_SELECTION_INVALID',
      'Connected batch selection requires unique exact proposed action IDs.'
    );
  }
  const available = proposedActionBindings(exact.proposal);
  const requested = new Set(actionIds);
  const selectedBindings = available.filter((binding) => requested.has(binding.action.id));
  if (selectedBindings.length !== requested.size) {
    throw codedError(
      'PROPOSAL_CONNECTED_BATCH_SELECTION_INVALID',
      'Connected batch selection contains an unavailable, held, prohibited, or handoff action.'
    );
  }
  const selected = selectionDocument(exact, batchId, selectedBindings);
  const material = selectionMaterial(selected, exact, selected.actions);
  const compiled = await compileAutomationConnectedSelection({
    root: resolvedRoot,
    lock: exact.lock,
    automationId: exact.proposal.automation.id,
    batch: selected,
    material
  });
  if (compiled.operations.some((operation) => {
    return !operation.provider.connectedImplementation || !operation.provider.version
      || !operation.verification.provider.connectedImplementation
      || !operation.verification.provider.version
      || (operation.precondition.kind === 'expectation'
        && (!operation.precondition.provider.connectedImplementation
          || !operation.precondition.provider.version));
  })) {
    throw codedError(
      'PROPOSAL_CONNECTED_BATCH_PROVIDER_UNAVAILABLE',
      'Connected batch requires exact connected write, precondition, and verification providers.'
    );
  }
  const changeSet = exactChangeSet({
    exact,
    selected,
    operations: compiled.operations,
    id: changeSetId,
    createdAt
  });
  const batch = exactBatch({ exact, changeSet, compiled, id: batchId, createdAt });
  assertProposalConnectedBatch({ root: resolvedRoot, batch, changeSet });
  return {
    changeSet,
    batch,
    selection: {
      availableActionCount: available.length,
      selectedActionCount: selected.actions.length,
      partial: selected.actions.length !== available.length,
      actionIds: selected.actions.map((action) => action.id),
      fingerprint: selected.fingerprint
    },
    authority: {
      state: 'none',
      reasonCode: 'CONNECTED_BATCH_PREVIEW_ONLY',
      permittedNextAction: 'request-exact-approval'
    },
    providerCallsExecuted: 0,
    externalWritesPerformed: 0
  };
}

export async function assertExactProposalConnectedBatch({
  root,
  lockPath,
  batch,
  changeSet,
  expectedHost
}) {
  assertProposalConnectedBatch({ root, batch, changeSet });
  const expected = await createProposalConnectedBatch({
    root,
    lockPath,
    proposalId: changeSet.basis.proposal.id,
    actionIds: changeSet.basis.actionIds,
    changeSetId: changeSet.id,
    batchId: batch.id,
    createdAt: batch.createdAt,
    expectedHost
  });
  if (fingerprintJson(expected.batch) !== fingerprintJson(batch)
    || fingerprintJson(expected.changeSet) !== fingerprintJson(changeSet)) {
    throw codedError(
      'PROPOSAL_CONNECTED_BATCH_BINDING_INVALID',
      'Connected batch does not match the exact current proposal, private material, compiler, and lock.'
    );
  }
  return { batch, changeSet };
}
