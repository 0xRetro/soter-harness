import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PreparedConnectedPlan,
  PreparedConnectedPlanResult,
  PreparedReviewBatch,
  PreparedReviewBatchCreateResult,
  PreparedReviewBatchMaterial,
  PreparedReviewBatchMaterialResult,
  PreparedReviewRow,
  PreparedWork,
  PreparedWorkDerivedReviewMaterial,
  PreparedWorkReviewError
} from '../types';
import { ReviewCollectionLedger } from './ReviewCollectionLedger';
import { StateMark } from './StateMark';

interface PreparedReviewCollectionsProps {
  work: PreparedWork;
  material: PreparedWorkDerivedReviewMaterial | null;
  error: PreparedWorkReviewError | null;
}

export function PreparedReviewCollections({ work, material, error }: PreparedReviewCollectionsProps) {
  const proposedActions = useMemo(() => work.preview.collections.flatMap((collection) => (
    collection.rows.flatMap((row) => row.actions.filter((action) => action.state === 'proposed'))
  )), [work.preview.collections]);
  const heldReasonCodes = useMemo(() => [...new Set(work.preview.collections.flatMap((collection) => (
    collection.rows.flatMap((row) => row.actions
      .filter((action) => action.state === 'held')
      .map((action) => action.reasonCode))
  )))].sort(), [work.preview.collections]);
  const [selectedActionIds, setSelectedActionIds] = useState<string[]>([]);
  const [batch, setBatch] = useState<PreparedReviewBatch | null>(null);
  const [batchMaterial, setBatchMaterial] = useState<PreparedReviewBatchMaterial | null>(null);
  const [batchError, setBatchError] = useState<PreparedWorkReviewError | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [connectedPlan, setConnectedPlan] = useState<PreparedConnectedPlan | null>(null);
  const [connectedPlanError, setConnectedPlanError] = useState<PreparedWorkReviewError | null>(null);
  const [connectedPlanBusy, setConnectedPlanBusy] = useState(false);
  const requestEpoch = useRef(0);

  useEffect(() => {
    requestEpoch.current += 1;
    setSelectedActionIds([]);
    setBatch(null);
    setBatchMaterial(null);
    setBatchError(null);
    setBatchBusy(false);
    setConnectedPlan(null);
    setConnectedPlanError(null);
    setConnectedPlanBusy(false);
  }, [work.id, work.fingerprint, work.preview.privateReview.contentFingerprint]);

  if (work.preview.collections.length === 0) return null;
  const coverageComplete = work.preview.collections.every((collection) => collection.coverage.complete);
  const materialBound = material ? derivedReviewBound(work, material) : false;
  const batchBound = batch ? reviewBatchBound(work, batch) : false;
  const selectedMaterialBound = batch && batchMaterial
    ? reviewBatchMaterialBound(work, batch, batchMaterial)
    : false;
  const connectedPlanBound = batch && connectedPlan
    ? preparedConnectedPlanBound(work, batch, connectedPlan)
    : false;

  function endSelection() {
    requestEpoch.current += 1;
    setSelectedActionIds([]);
    setBatch(null);
    setBatchMaterial(null);
    setBatchError(null);
    setBatchBusy(false);
    setConnectedPlan(null);
    setConnectedPlanError(null);
    setConnectedPlanBusy(false);
  }

  function toggleAction(actionId: string) {
    requestEpoch.current += 1;
    setBatch(null);
    setBatchMaterial(null);
    setBatchError(null);
    setConnectedPlan(null);
    setConnectedPlanError(null);
    setConnectedPlanBusy(false);
    setSelectedActionIds((current) => current.includes(actionId)
      ? current.filter((id) => id !== actionId)
      : [...current, actionId]);
  }

  async function createReviewBatch() {
    if (selectedActionIds.length === 0 || batchBusy) return;
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    setBatchBusy(true);
    setBatch(null);
    setBatchMaterial(null);
    setBatchError(null);
    setConnectedPlan(null);
    setConnectedPlanError(null);
    setConnectedPlanBusy(false);
    const created = await window.soterStudio.createPreparedReviewBatch({
      workId: work.id,
      actionIds: [...selectedActionIds]
    }).catch((): PreparedReviewBatchCreateResult => ({
      ok: false,
      error: {
        code: 'PREPARED_REVIEW_BATCH_ADAPTER_UNAVAILABLE',
        message: 'The exact review-only selection is unavailable for this prepared work.'
      }
    }));
    if (requestEpoch.current !== epoch) return;
    if (!created.ok) {
      setBatchError(created.error);
      setBatchBusy(false);
      return;
    }
    setBatch(created.batch);
    setSelectedActionIds(created.batch.actions.map((action) => action.id));
    const privateReview = await window.soterStudio.getPreparedReviewBatchMaterial({
      batchId: created.batch.id
    }).catch((): PreparedReviewBatchMaterialResult => ({
      ok: false,
      error: {
        code: 'PREPARED_REVIEW_BATCH_MATERIAL_ADAPTER_UNAVAILABLE',
        message: 'Private selected-batch review material is unavailable.'
      }
    }));
    if (requestEpoch.current !== epoch) return;
    setBatchMaterial(privateReview.ok ? privateReview.material : null);
    setBatchError(privateReview.ok ? null : privateReview.error);
    setBatchBusy(false);
  }

  async function compileConnectedCandidate() {
    if (!batch || !batchMaterial || !selectedMaterialBound || connectedPlanBusy
      || batchMaterial.configuration.applicability !== 'current') return;
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    setConnectedPlanBusy(true);
    setConnectedPlan(null);
    setConnectedPlanError(null);
    const created = await window.soterStudio.createPreparedConnectedPlan({ batchId: batch.id })
      .catch((): PreparedConnectedPlanResult => ({
        ok: false,
        error: {
          code: 'PREPARED_CONNECTED_PLAN_ADAPTER_UNAVAILABLE',
          message: 'The private compiled candidate is unavailable for this review batch.'
        }
      }));
    if (requestEpoch.current !== epoch) return;
    if (!created.ok) {
      setConnectedPlanError(created.error);
      setConnectedPlanBusy(false);
      return;
    }
    const inspected = await window.soterStudio.getPreparedConnectedPlan({ planId: created.plan.id })
      .catch((): PreparedConnectedPlanResult => ({
        ok: false,
        error: {
          code: 'PREPARED_CONNECTED_PLAN_ADAPTER_UNAVAILABLE',
          message: 'Private compiled candidate material is unavailable.'
        }
      }));
    if (requestEpoch.current !== epoch) return;
    setConnectedPlan(inspected.ok ? inspected.plan : null);
    setConnectedPlanError(inspected.ok ? null : inspected.error);
    setConnectedPlanBusy(false);
  }

  return (
    <section className="review-manifest" aria-label="Prepared review collections">
      <header className="review-manifest-header">
        <div>
          <span className="eyebrow">Sanitized review manifest</span>
          <strong>{work.preview.collections.length} exact collections</strong>
          <small>Codes, counts, actions, and fingerprints only · no mailbox identity or content</small>
        </div>
        <StateMark state={coverageComplete ? 'passed' : 'failed'} />
      </header>
      {!coverageComplete && <div className="review-coverage-blocker" role="alert"><strong>Coverage incomplete</strong><span>No proposed batch is available until every collection reports complete coverage.</span></div>}
      {proposedActions.length === 0 && heldReasonCodes.length > 0 && (
        <div className="review-coverage-blocker" aria-label="Held review boundary">
          <strong>No selectable actions</strong>
          <span>{heldReasonCodes.join(' · ')}</span>
        </div>
      )}

      {proposedActions.length > 0 && (
        <section className="review-batch-selector" aria-label="Review-only action selection">
          <header>
            <div><span className="eyebrow">Exact review selection</span><strong>{selectedActionIds.length} of {proposedActions.length} proposed actions selected</strong><small>Only proposed action IDs cross the trusted boundary. Core restores canonical prepared order.</small></div>
            <div className="review-batch-count" aria-label={`${selectedActionIds.length} actions selected`}><strong>{String(selectedActionIds.length).padStart(2, '0')}</strong><span>selected</span></div>
          </header>
          <div className="review-batch-controls">
            <button type="button" className="secondary" disabled={selectedActionIds.length === 0 || batchBusy} onClick={endSelection}>Clear selection</button>
            <button type="button" disabled={!coverageComplete || selectedActionIds.length === 0 || batchBusy} onClick={createReviewBatch}>
              {batchBusy ? 'Opening exact private review…' : `Create review-only batch (${selectedActionIds.length})`}
            </button>
          </div>
          <p>Creates one immutable local review selection. It creates no approval request, provider call, continuation, or execution authority.</p>
        </section>
      )}

      <ReviewCollectionLedger
        collections={work.preview.collections}
        privateItemCount={(collectionId, row) => materialBound
          ? privateItemsFor(material!, collectionId, row).length
          : 0}
        selectedActionIds={selectedActionIds}
        selectionDisabled={batchBusy}
        onToggleAction={toggleAction}
      />

      {(batch || batchMaterial || batchError) && (
        <SelectedBatchFolio
          work={work}
          batch={batch}
          material={batchMaterial}
          error={batchError}
          batchBound={batchBound}
          materialBound={selectedMaterialBound}
          connectedPlan={connectedPlan}
          connectedPlanError={connectedPlanError}
          connectedPlanBusy={connectedPlanBusy}
          connectedPlanBound={connectedPlanBound}
          onCompileConnectedPlan={compileConnectedCandidate}
          onClose={endSelection}
        />
      )}

      <section className="derived-review-folio" aria-label="Selected private derived review">
        <header>
          <div><span className="eyebrow">Selected-work private folio</span><strong>Normalized review detail</strong><small>Separate Core read · exact public/private join · never inspection or evidence</small></div>
          <div className="dossier-private-seal"><span>Authority</span><strong>none</strong></div>
        </header>
        {error ? (
          <div className="dossier-private-unavailable" role="alert">
            <span>Private derived values withheld</span><strong>{error.code}</strong><p>{error.message}</p>
          </div>
        ) : material && !materialBound ? (
          <p className="dossier-private-invalid" role="alert">Private derived review does not bind this exact receipt, checkpoint, contract, and content seal. No value is displayed.</p>
        ) : work.preview.privateReview.state === 'available' && !material ? (
          <p className="derived-review-loading" role="status">Loading the selected private folio…</p>
        ) : materialBound ? (
          <>
            <div className="derived-review-seals">
              <Fingerprint label="Content" value={material!.contentFingerprint} />
              <Fingerprint label="Contract" value={material!.reviewContractFingerprint} />
              <Fingerprint label="Material" value={material!.fingerprint} />
            </div>
            <div className="derived-review-items">
              {material!.items.map((item) => (
                <details key={item.id} className="review-private-detail">
                  <summary>Open {readable(item.kind)} detail <span>{item.sources.length} exact {item.sources.length === 1 ? 'source' : 'sources'}</span></summary>
                  <article>
                    <header><strong>{readable(item.kind)}</strong><code title={item.fingerprint}>{shorten(item.fingerprint)}</code></header>
                    <code>{item.sources[0].collectionId} / {item.sources[0].rowId}</code>
                    <dl>
                      {item.fields.map((field) => (
                        <div key={field.id}><dt>{field.label}</dt><dd>{displayReviewValue(field.reviewValue)}</dd></div>
                      ))}
                    </dl>
                  </article>
                </details>
              ))}
            </div>
          </>
        ) : (
          <p className="derived-review-loading">This prepared review declares no private derived companion.</p>
        )}
        <footer><strong>No authority</strong><span>This selected-work folio cannot approve, continue, execute, write, send, or establish provider readiness. Review-only selection remains a separate Core operation.</span></footer>
      </section>
    </section>
  );
}

function SelectedBatchFolio({
  work,
  batch,
  material,
  error,
  batchBound,
  materialBound,
  connectedPlan,
  connectedPlanError,
  connectedPlanBusy,
  connectedPlanBound,
  onCompileConnectedPlan,
  onClose
}: {
  work: PreparedWork;
  batch: PreparedReviewBatch | null;
  material: PreparedReviewBatchMaterial | null;
  error: PreparedWorkReviewError | null;
  batchBound: boolean;
  materialBound: boolean;
  connectedPlan: PreparedConnectedPlan | null;
  connectedPlanError: PreparedWorkReviewError | null;
  connectedPlanBusy: boolean;
  connectedPlanBound: boolean;
  onCompileConnectedPlan: () => void;
  onClose: () => void;
}) {
  return (
    <section className="selected-batch-folio" aria-label="Selected review batch private folio">
      <header>
        <div><span className="eyebrow">Selected-batch private folio</span><strong>{batch?.id || 'Review material unavailable'}</strong><small>Immutable review-only selection · canonical order · selected batch only</small></div>
        <div className="dossier-private-seal"><span>Authority</span><strong>none</strong></div>
      </header>
      {error ? (
        <div className="dossier-private-unavailable" role="alert">
          <span>Selected private values withheld</span><strong>{error.code}</strong><p>{error.message}</p>
        </div>
      ) : batch && !batchBound ? (
        <p className="dossier-private-invalid" role="alert">The review batch does not bind this exact prepared work. No private value is displayed.</p>
      ) : material && !materialBound ? (
        <p className="dossier-private-invalid" role="alert">Private selected-batch material does not bind the exact batch, work, source rows, and selected fingerprints. No private value is displayed.</p>
      ) : batch && material && materialBound ? (
        <>
          <div className="selected-batch-summary">
            <Fingerprint label="Batch" value={batch.fingerprint} />
            <Fingerprint label="Scope" value={batch.scope.fingerprint} />
            <div><span>Selection</span><strong>{batch.scope.selectedActionCount} / {batch.scope.availableActionCount}</strong><small>{batch.scope.partial ? 'partial exact subset' : 'complete proposed set'}</small></div>
            <div><span>Applicability</span><strong>{material.configuration.applicability}</strong><small>{work.configuration.name} · {work.configuration.host}</small></div>
          </div>
          <ol className="selected-batch-actions" aria-label="Core ordered selected actions">
            {material.actions.map((action) => (
              <li key={action.selection.id}>
                <header><span>{String(action.selection.sequence).padStart(2, '0')}</span><div><strong>{readable(action.selection.kind)}</strong><code>{action.selection.effect} · {action.selection.capability}</code></div><StateMark state="review-only" compact /></header>
                <div className="selected-batch-values">
                  {action.context && <PrivateBatchItem label="Current context" item={action.context} />}
                  <PrivateBatchItem label="Proposed value" item={action.proposed} />
                </div>
                <footer><code>{action.selection.source.collectionId} / {action.selection.source.rowId}</code><code title={action.selection.changeFingerprint}>{shorten(action.selection.changeFingerprint)}</code></footer>
              </li>
            ))}
          </ol>
          <div className="selected-batch-blockers" aria-label="Review batch blockers">
            {batch.blockers.map((blocker) => <code key={blocker}>{blocker}</code>)}
          </div>
          <section className="connected-candidate-boundary" aria-label="Compiled candidate boundary">
            <div>
              <span className="eyebrow">Optional private projection</span>
              <strong>Compile the selected review into a blocked candidate</strong>
              <small>Core resolves the Automation compiler, provider binding, authority, arguments, and read-only verification plan. It creates no executable transaction.</small>
            </div>
            {!connectedPlan && !connectedPlanError && (
              <button
                type="button"
                disabled={connectedPlanBusy || material.configuration.applicability !== 'current'}
                onClick={onCompileConnectedPlan}
              >
                {connectedPlanBusy ? 'Compiling private candidate…' : 'Compile review-only candidate'}
              </button>
            )}
          </section>
          {connectedPlanError ? (
            <div className="connected-candidate-unavailable" role="alert">
              <span>Compiled private values withheld</span><strong>{connectedPlanError.code}</strong><p>{connectedPlanError.message}</p>
            </div>
          ) : connectedPlan && !connectedPlanBound ? (
            <p className="connected-candidate-invalid" role="alert">The compiled candidate does not bind this exact review batch, work, lock, and source action set. No private provider argument is displayed.</p>
          ) : connectedPlan && connectedPlanBound ? (
            <CompiledCandidateLedger plan={connectedPlan} />
          ) : connectedPlanBusy ? (
            <p className="connected-candidate-loading" role="status">Loading the selected compiled candidate…</p>
          ) : null}
        </>
      ) : (
        <p className="derived-review-loading" role="status">Loading exact selected-batch material…</p>
      )}
      <footer><div><strong>No authority</strong><span>Review-only selection cannot approve, confirm, continue, retry, execute, write, or send.</span></div><button type="button" onClick={onClose}>End batch review</button></footer>
    </section>
  );
}

function CompiledCandidateLedger({ plan }: { plan: PreparedConnectedPlan }) {
  return (
    <section className="compiled-candidate-ledger" aria-label="Selected compiled candidate private ledger">
      <header>
        <div><span className="eyebrow">Selected-plan private ledger</span><strong>Compiled candidate</strong><small>Core projection · private arguments · selected plan only</small></div>
        <div className="compiled-candidate-status"><StateMark state="blocked" compact /><span>Executable</span><strong>no</strong><span>Authority</span><strong>none</strong></div>
      </header>
      <div className="compiled-candidate-summary">
        <Fingerprint label="Plan" value={plan.fingerprint} />
        <Fingerprint label="Compiler" value={plan.compiler.moduleFingerprint} />
        <div><span>Compiler module</span><strong>{plan.compiler.module}</strong><small>{plan.compiler.compileExport} · {plan.compiler.evaluateExport}</small></div>
        <div><span>Applicability</span><strong>{plan.configuration.applicability}</strong><small>{plan.configuration.name} · {plan.configuration.host}</small></div>
      </div>
      <ol className="compiled-candidate-operations" aria-label="Compiled candidate operations">
        {plan.operations.map((operation) => (
          <li key={operation.id}>
            <header><span>{String(operation.sequence).padStart(2, '0')}</span><div><strong>{readable(operation.capability)}</strong><code>{operation.effect} · {operation.authority}</code></div><StateMark state="blocked" compact /></header>
            <div className="compiled-candidate-operation-grid">
              <section>
                <span>Resolved provider boundary</span>
                <dl>
                  <div><dt>Pack</dt><dd>{operation.provider.pack}</dd></div>
                  <div><dt>Connected implementation</dt><dd>{operation.provider.connectedImplementation || 'not declared'}</dd></div>
                  <div><dt>Source action</dt><dd>{operation.sourceActionId}</dd></div>
                </dl>
              </section>
              <section>
                <span>Private provider arguments</span>
                <dl>{Object.entries(operation.input).map(([key, value]) => <div key={key}><dt>{readable(key)}</dt><dd>{displayPlanValue(value)}</dd></div>)}</dl>
              </section>
              <section>
                <span>Read-only verification candidate</span>
                <dl>
                  <div><dt>Capability</dt><dd>{operation.verification.capability}</dd></div>
                  <div><dt>Provider</dt><dd>{operation.verification.provider.pack} · {operation.verification.provider.connectedImplementation || 'not declared'}</dd></div>
                  <div><dt>Expectation</dt><dd>{operation.verification.expectation.kind}</dd></div>
                </dl>
              </section>
              <section>
                <span>Ambiguity and recovery</span>
                <dl>
                  <div><dt>Retry</dt><dd>{operation.ambiguity.retry}</dd></div>
                  <div><dt>Unresolved</dt><dd>{operation.ambiguity.unresolvedState}</dd></div>
                  <div><dt>Reason</dt><dd>{operation.ambiguity.reasonCode}</dd></div>
                  <div><dt>Recovery</dt><dd>{operation.recovery.mode} · {operation.recovery.reasonCode}</dd></div>
                </dl>
              </section>
            </div>
            <footer><code>{operation.id}</code><code title={operation.inputFingerprint}>{shorten(operation.inputFingerprint)}</code></footer>
          </li>
        ))}
      </ol>
      <div className="compiled-candidate-blockers" aria-label="Compiled candidate blockers">
        {plan.blockers.map((blocker) => <code key={blocker}>{blocker}</code>)}
      </div>
      <footer><strong>Blocked review only</strong><span>This candidate cannot approve, confirm, continue, retry, reconcile, execute, write, draft, label, or send.</span></footer>
    </section>
  );
}

function PrivateBatchItem({
  label,
  item
}: {
  label: string;
  item: PreparedWorkDerivedReviewMaterial['items'][number];
}) {
  return (
    <article>
      <header><span>{label}</span><strong>{readable(item.kind)}</strong><code title={item.fingerprint}>{shorten(item.fingerprint)}</code></header>
      <dl>
        {item.fields.map((field) => <div key={field.id}><dt>{field.label}</dt><dd>{displayReviewValue(field.reviewValue)}</dd></div>)}
      </dl>
    </article>
  );
}

function reviewBatchBound(work: PreparedWork, batch: PreparedReviewBatch) {
  const privateReview = work.preview.privateReview;
  return privateReview.state === 'available'
    && batch.work.id === work.id
    && batch.work.fingerprint === work.fingerprint
    && batch.work.checkpointId === work.checkpoint.id
    && batch.work.checkpointFingerprint === work.checkpoint.fingerprint
    && batch.work.automationId === work.automation.id
    && batch.work.automationVersion === work.automation.version
    && batch.configuration.name === work.configuration.name
    && batch.configuration.path === work.configuration.path
    && batch.configuration.lockPath === work.configuration.lockPath
    && batch.configuration.lockFingerprint === work.configuration.lockFingerprint
    && batch.configuration.graphFingerprint === work.configuration.graphFingerprint
    && batch.configuration.host === work.configuration.host
    && batch.preview.kind === work.preview.kind
    && batch.preview.fingerprint === work.preview.fingerprint
    && batch.preview.privateReviewKind === privateReview.kind
    && batch.preview.privateReviewContentFingerprint === privateReview.contentFingerprint
    && batch.state === 'review-only'
    && batch.privacy.authority === 'none';
}

function reviewBatchMaterialBound(work: PreparedWork, batch: PreparedReviewBatch, material: PreparedReviewBatchMaterial) {
  if (!reviewBatchBound(work, batch)
    || material.batch.id !== batch.id
    || material.batch.fingerprint !== batch.fingerprint
    || material.batch.createdAt !== batch.createdAt
    || material.batch.state !== batch.state
    || material.work.id !== work.id
    || material.work.fingerprint !== work.fingerprint
    || material.work.checkpointId !== work.checkpoint.id
    || material.work.checkpointFingerprint !== work.checkpoint.fingerprint
    || material.work.automationId !== work.automation.id
    || material.configuration.name !== batch.configuration.name
    || material.configuration.path !== batch.configuration.path
    || material.configuration.lockPath !== batch.configuration.lockPath
    || material.configuration.lockFingerprint !== batch.configuration.lockFingerprint
    || material.configuration.graphFingerprint !== batch.configuration.graphFingerprint
    || material.configuration.host !== batch.configuration.host
    || JSON.stringify(material.scope) !== JSON.stringify(batch.scope)
    || JSON.stringify(material.effects) !== JSON.stringify(batch.effects)
    || JSON.stringify(material.blockers) !== JSON.stringify(batch.blockers)
    || material.actions.length !== batch.actions.length
    || material.privacy.authority !== 'none') return false;

  return material.actions.every((action, index) => {
    const selection = batch.actions[index];
    const sourceMatches = (item: PreparedWorkDerivedReviewMaterial['items'][number]) => item.sources.some((source) => (
      source.collectionId === selection.source.collectionId
      && source.rowId === selection.source.rowId
      && source.rowFingerprint === selection.source.rowFingerprint
    ));
    return JSON.stringify(action.selection) === JSON.stringify(selection)
      && action.proposed.fingerprint === selection.proposedValueFingerprint
      && sourceMatches(action.proposed)
      && (selection.contextValueFingerprint === null
        ? action.context === null
        : action.context?.fingerprint === selection.contextValueFingerprint && sourceMatches(action.context));
  });
}

function preparedConnectedPlanBound(work: PreparedWork, batch: PreparedReviewBatch, plan: PreparedConnectedPlan) {
  const selectedActions = new Set(batch.actions.map((action) => action.id));
  return reviewBatchBound(work, batch)
    && plan.source.batchId === batch.id
    && plan.source.batchFingerprint === batch.fingerprint
    && plan.source.workId === work.id
    && plan.source.workFingerprint === work.fingerprint
    && plan.source.checkpointId === work.checkpoint.id
    && plan.source.checkpointFingerprint === work.checkpoint.fingerprint
    && plan.source.automationId === work.automation.id
    && plan.source.automationVersion === work.automation.version
    && plan.configuration.name === batch.configuration.name
    && plan.configuration.path === batch.configuration.path
    && plan.configuration.lockPath === batch.configuration.lockPath
    && plan.configuration.lockFingerprint === batch.configuration.lockFingerprint
    && plan.configuration.graphFingerprint === batch.configuration.graphFingerprint
    && plan.configuration.host === batch.configuration.host
    && plan.state === 'blocked-review-only'
    && plan.executable === false
    && plan.operations.length > 0
    && plan.operations.every((operation, index) => operation.sequence === index + 1 && selectedActions.has(operation.sourceActionId))
    && plan.privacy.scope === 'private-local-prepared-connected-plan'
    && plan.privacy.authority === 'none'
    && plan.privacy.projection === 'selected-plan-only'
    && plan.privacy.privateValuesIncluded === true
    && plan.privacy.providerArgumentsIncluded === true
    && plan.privacy.rawProviderResponsesIncluded === false
    && plan.privacy.credentialValuesIncluded === false
    && plan.privacy.workspaceInspectionIncluded === false
    && plan.privacy.evidenceIncluded === false
    && plan.privacy.canonicalArtifactsIncluded === false
    && plan.privacy.approvalAuthorityIncluded === false
    && plan.privacy.continuationAuthorityIncluded === false
    && plan.privacy.executionAuthorityIncluded === false
    && plan.privacy.retryAuthorityIncluded === false;
}

function derivedReviewBound(work: PreparedWork, material: PreparedWorkDerivedReviewMaterial) {
  const reference = work.preview.privateReview;
  if (reference.state !== 'available'
    || material.workId !== work.id
    || material.preparedWorkFingerprint !== work.fingerprint
    || material.checkpointId !== work.checkpoint.id
    || material.checkpointFingerprint !== work.checkpoint.fingerprint
    || material.automation.id !== work.automation.id
    || material.automation.version !== work.automation.version
    || material.configuration.name !== work.configuration.name
    || material.configuration.lockFingerprint !== work.configuration.lockFingerprint
    || material.inputContractFingerprint !== work.inputSummary.inputContractFingerprint
    || material.reviewContractId !== reference.contractId
    || material.reviewContractFingerprint !== reference.contractFingerprint
    || material.contentFingerprint !== reference.contentFingerprint
    || material.kind !== reference.kind) return false;

  const rows = work.preview.collections.flatMap((collection) => collection.rows.map((row) => ({ collectionId: collection.id, row })));
  const itemFor = (fingerprint: string, collectionId: string, row: PreparedReviewRow) => material.items.find((item) => {
    return item.fingerprint === fingerprint && item.sources.some((source) => source.collectionId === collectionId
      && source.rowId === row.id && source.rowFingerprint === row.fingerprint);
  });
  if (rows.some(({ collectionId, row }) => row.privateDetailFingerprint
    && !itemFor(row.privateDetailFingerprint, collectionId, row))) return false;
  return work.preview.proposedChanges.every((change) => {
    if (!change.afterFingerprint) return false;
    const binding = rows.find(({ row }) => row.actions.some((action) => action.id === change.id
      && action.state === 'proposed' && action.changeFingerprint));
    return Boolean(binding && itemFor(change.afterFingerprint, binding.collectionId, binding.row));
  });
}

function privateItemsFor(material: PreparedWorkDerivedReviewMaterial, collectionId: string, row: PreparedReviewRow) {
  return material.items.filter((item) => item.sources[0]?.collectionId === collectionId
    && item.sources[0].rowId === row.id
    && item.sources[0].rowFingerprint === row.fingerprint);
}

function Fingerprint({ label, value }: { label: string; value: string }) {
  return <div className="dossier-fingerprint"><span>{label}</span><code title={value}>{shorten(value)}</code></div>;
}

function displayReviewValue(value: string | boolean | string[]) {
  if (Array.isArray(value)) return value.join('\n');
  return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
}

function displayPlanValue(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item)).join('\n');
  if (value && typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value ?? 'unavailable');
}

function readable(value: string) {
  return value.replaceAll('-', ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());
}

function shorten(value: string) {
  return value.startsWith('sha256:') ? value.slice(0, 15) + '…' + value.slice(-7) : value;
}
