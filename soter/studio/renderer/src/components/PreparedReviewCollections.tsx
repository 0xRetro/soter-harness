import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PreparedReviewRow,
  PreparedWork,
  PreparedWorkDerivedReviewMaterial,
  PreparedWorkReviewError,
  ReviewOnlyCandidatePreview,
  ReviewOnlyCandidatePreviewResult,
  ReviewOnlyCandidateSelection,
  ReviewOnlyCandidateSelectionCreateResult,
  ReviewOnlyCandidateSelectionMaterial,
  ReviewOnlyCandidateSelectionMaterialResult
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
  const [candidateSelection, setCandidateSelection] = useState<ReviewOnlyCandidateSelection | null>(null);
  const [candidateSelectionMaterial, setCandidateSelectionMaterial] = useState<ReviewOnlyCandidateSelectionMaterial | null>(null);
  const [candidateSelectionError, setCandidateSelectionError] = useState<PreparedWorkReviewError | null>(null);
  const [candidateSelectionBusy, setCandidateSelectionBusy] = useState(false);
  const [candidatePreview, setCandidatePreview] = useState<ReviewOnlyCandidatePreview | null>(null);
  const [candidatePreviewError, setCandidatePreviewError] = useState<PreparedWorkReviewError | null>(null);
  const [candidatePreviewBusy, setCandidatePreviewBusy] = useState(false);
  const requestEpoch = useRef(0);

  useEffect(() => {
    requestEpoch.current += 1;
    setSelectedActionIds([]);
    setCandidateSelection(null);
    setCandidateSelectionMaterial(null);
    setCandidateSelectionError(null);
    setCandidateSelectionBusy(false);
    setCandidatePreview(null);
    setCandidatePreviewError(null);
    setCandidatePreviewBusy(false);
  }, [work.id, work.fingerprint, work.preview.privateReview.contentFingerprint]);

  if (work.preview.collections.length === 0) return null;
  const coverageComplete = work.preview.collections.every((collection) => collection.coverage.complete);
  const materialBound = material ? derivedReviewBound(work, material) : false;
  const candidateSelectionBound = candidateSelection ? reviewOnlyCandidateSelectionBound(work, candidateSelection) : false;
  const selectedMaterialBound = candidateSelection && candidateSelectionMaterial
    ? reviewOnlyCandidateSelectionMaterialBound(work, candidateSelection, candidateSelectionMaterial)
    : false;
  const candidatePreviewBound = candidateSelection && candidatePreview
    ? reviewOnlyCandidatePreviewBound(work, candidateSelection, candidatePreview)
    : false;

  function endSelection() {
    requestEpoch.current += 1;
    setSelectedActionIds([]);
    setCandidateSelection(null);
    setCandidateSelectionMaterial(null);
    setCandidateSelectionError(null);
    setCandidateSelectionBusy(false);
    setCandidatePreview(null);
    setCandidatePreviewError(null);
    setCandidatePreviewBusy(false);
  }

  function toggleAction(actionId: string) {
    requestEpoch.current += 1;
    setCandidateSelection(null);
    setCandidateSelectionMaterial(null);
    setCandidateSelectionError(null);
    setCandidatePreview(null);
    setCandidatePreviewError(null);
    setCandidatePreviewBusy(false);
    setSelectedActionIds((current) => current.includes(actionId)
      ? current.filter((id) => id !== actionId)
      : [...current, actionId]);
  }

  async function createCandidateSelection() {
    if (selectedActionIds.length === 0 || candidateSelectionBusy) return;
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    setCandidateSelectionBusy(true);
    setCandidateSelection(null);
    setCandidateSelectionMaterial(null);
    setCandidateSelectionError(null);
    setCandidatePreview(null);
    setCandidatePreviewError(null);
    setCandidatePreviewBusy(false);
    const created = await window.soterStudio.createReviewOnlyCandidateSelection({
      workId: work.id,
      actionIds: [...selectedActionIds]
    }).catch((): ReviewOnlyCandidateSelectionCreateResult => ({
      ok: false,
      error: {
        code: 'REVIEW_ONLY_CANDIDATE_SELECTION_ADAPTER_UNAVAILABLE',
        message: 'The exact review-only selection is unavailable for this prepared work.'
      }
    }));
    if (requestEpoch.current !== epoch) return;
    if (!created.ok) {
      setCandidateSelectionError(created.error);
      setCandidateSelectionBusy(false);
      return;
    }
    setCandidateSelection(created.selection);
    setSelectedActionIds(created.selection.actions.map((action) => action.id));
    const privateReview = await window.soterStudio.getReviewOnlyCandidateSelectionMaterial({
      selectionId: created.selection.id
    }).catch((): ReviewOnlyCandidateSelectionMaterialResult => ({
      ok: false,
      error: {
        code: 'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_ADAPTER_UNAVAILABLE',
        message: 'Private review-only candidate selection material is unavailable.'
      }
    }));
    if (requestEpoch.current !== epoch) return;
    setCandidateSelectionMaterial(privateReview.ok ? privateReview.material : null);
    setCandidateSelectionError(privateReview.ok ? null : privateReview.error);
    setCandidateSelectionBusy(false);
  }

  async function createCandidatePreview() {
    if (!candidateSelection || !candidateSelectionMaterial || !selectedMaterialBound || candidatePreviewBusy
      || candidateSelectionMaterial.configuration.applicability !== 'current') return;
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    setCandidatePreviewBusy(true);
    setCandidatePreview(null);
    setCandidatePreviewError(null);
    const created = await window.soterStudio.createReviewOnlyCandidatePreview({ selectionId: candidateSelection.id })
      .catch((): ReviewOnlyCandidatePreviewResult => ({
        ok: false,
        error: {
          code: 'REVIEW_ONLY_CANDIDATE_PREVIEW_ADAPTER_UNAVAILABLE',
          message: 'The private review-only candidate preview is unavailable for this selection.'
        }
      }));
    if (requestEpoch.current !== epoch) return;
    if (!created.ok) {
      setCandidatePreviewError(created.error);
      setCandidatePreviewBusy(false);
      return;
    }
    const inspected = await window.soterStudio.getReviewOnlyCandidatePreview({ candidatePreviewId: created.preview.id })
      .catch((): ReviewOnlyCandidatePreviewResult => ({
        ok: false,
        error: {
          code: 'REVIEW_ONLY_CANDIDATE_PREVIEW_ADAPTER_UNAVAILABLE',
          message: 'Private review-only candidate preview material is unavailable.'
        }
      }));
    if (requestEpoch.current !== epoch) return;
    setCandidatePreview(inspected.ok ? inspected.preview : null);
    setCandidatePreviewError(inspected.ok ? null : inspected.error);
    setCandidatePreviewBusy(false);
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
      {!coverageComplete && <div className="review-coverage-blocker" role="alert"><strong>Coverage incomplete</strong><span>No review-only candidate selection is available until every collection reports complete coverage.</span></div>}
      {proposedActions.length === 0 && heldReasonCodes.length > 0 && (
        <div className="review-coverage-blocker" aria-label="Held review boundary">
          <strong>No selectable actions</strong>
          <span>{heldReasonCodes.join(' · ')}</span>
        </div>
      )}

      {proposedActions.length > 0 && (
        <section className="candidate-selection-selector" aria-label="Review-only candidate action selection">
          <header>
            <div><span className="eyebrow">Exact review selection</span><strong>{selectedActionIds.length} of {proposedActions.length} proposed actions selected</strong><small>Only proposed action IDs cross the trusted boundary. Core restores canonical prepared order.</small></div>
            <div className="candidate-selection-count" aria-label={`${selectedActionIds.length} actions selected`}><strong>{String(selectedActionIds.length).padStart(2, '0')}</strong><span>selected</span></div>
          </header>
          <div className="candidate-selection-controls">
            <button type="button" className="secondary" disabled={selectedActionIds.length === 0 || candidateSelectionBusy} onClick={endSelection}>Clear selection</button>
            <button type="button" disabled={!coverageComplete || selectedActionIds.length === 0 || candidateSelectionBusy} onClick={createCandidateSelection}>
              {candidateSelectionBusy ? 'Opening exact private review…' : `Create review-only candidate selection (${selectedActionIds.length})`}
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
        selectionDisabled={candidateSelectionBusy}
        onToggleAction={toggleAction}
      />

      {(candidateSelection || candidateSelectionMaterial || candidateSelectionError) && (
        <SelectedCandidateSelectionFolio
          work={work}
          selection={candidateSelection}
          material={candidateSelectionMaterial}
          error={candidateSelectionError}
          selectionBound={candidateSelectionBound}
          materialBound={selectedMaterialBound}
          candidatePreview={candidatePreview}
          candidatePreviewError={candidatePreviewError}
          candidatePreviewBusy={candidatePreviewBusy}
          candidatePreviewBound={candidatePreviewBound}
          onCreateCandidatePreview={createCandidatePreview}
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

function SelectedCandidateSelectionFolio({
  work,
  selection,
  material,
  error,
  selectionBound,
  materialBound,
  candidatePreview,
  candidatePreviewError,
  candidatePreviewBusy,
  candidatePreviewBound,
  onCreateCandidatePreview,
  onClose
}: {
  work: PreparedWork;
  selection: ReviewOnlyCandidateSelection | null;
  material: ReviewOnlyCandidateSelectionMaterial | null;
  error: PreparedWorkReviewError | null;
  selectionBound: boolean;
  materialBound: boolean;
  candidatePreview: ReviewOnlyCandidatePreview | null;
  candidatePreviewError: PreparedWorkReviewError | null;
  candidatePreviewBusy: boolean;
  candidatePreviewBound: boolean;
  onCreateCandidatePreview: () => void;
  onClose: () => void;
}) {
  return (
    <section className="candidate-selection-folio" aria-label="Review-only candidate selection private folio">
      <header>
        <div><span className="eyebrow">Candidate-selection private folio</span><strong>{selection?.id || 'Review material unavailable'}</strong><small>Immutable review-only selection · canonical order · selected selection only</small></div>
        <div className="dossier-private-seal"><span>Authority</span><strong>none</strong></div>
      </header>
      {error ? (
        <div className="dossier-private-unavailable" role="alert">
          <span>Selected private values withheld</span><strong>{error.code}</strong><p>{error.message}</p>
        </div>
      ) : selection && !selectionBound ? (
        <p className="dossier-private-invalid" role="alert">The review-only candidate selection does not bind this exact prepared work. No private value is displayed.</p>
      ) : material && !materialBound ? (
        <p className="dossier-private-invalid" role="alert">Private candidate-selection material does not bind the exact selection, work, source rows, and selected fingerprints. No private value is displayed.</p>
      ) : selection && material && materialBound ? (
        <>
          <div className="candidate-selection-summary">
            <Fingerprint label="Selection" value={selection.fingerprint} />
            <Fingerprint label="Scope" value={selection.scope.fingerprint} />
            <div><span>Selection</span><strong>{selection.scope.selectedActionCount} / {selection.scope.availableActionCount}</strong><small>{selection.scope.partial ? 'partial exact subset' : 'complete proposed set'}</small></div>
            <div><span>Applicability</span><strong>{material.configuration.applicability}</strong><small>{work.configuration.name} · {work.configuration.host}</small></div>
          </div>
          <ol className="candidate-selection-actions" aria-label="Core ordered selected actions">
            {material.actions.map((action) => (
              <li key={action.selection.id}>
                <header><span>{String(action.selection.sequence).padStart(2, '0')}</span><div><strong>{readable(action.selection.kind)}</strong><code>{action.selection.effect} · {action.selection.capability}</code></div><StateMark state="review-only" compact /></header>
                <div className="candidate-selection-values">
                  {action.context && <PrivateCandidateItem label="Current context" item={action.context} />}
                  <PrivateCandidateItem label="Proposed value" item={action.proposed} />
                </div>
                <footer><code>{action.selection.source.collectionId} / {action.selection.source.rowId}</code><code title={action.selection.changeFingerprint}>{shorten(action.selection.changeFingerprint)}</code></footer>
              </li>
            ))}
          </ol>
          <div className="candidate-selection-blockers" aria-label="Review-only candidate selection blockers">
            {selection.blockers.map((blocker) => <code key={blocker}>{blocker}</code>)}
          </div>
          <section className="connected-candidate-boundary" aria-label="Review-only candidate preview boundary">
            <div>
              <span className="eyebrow">Optional private projection</span>
              <strong>Compile the selected review into a blocked candidate</strong>
              <small>Core resolves the Automation compiler, provider binding, authority, arguments, and read-only verification plan. It creates no executable transaction.</small>
            </div>
            {!candidatePreview && !candidatePreviewError && (
              <button
                type="button"
                disabled={candidatePreviewBusy || material.configuration.applicability !== 'current'}
                onClick={onCreateCandidatePreview}
              >
                {candidatePreviewBusy ? 'Compiling private candidate preview…' : 'Create review-only candidate preview'}
              </button>
            )}
          </section>
          {candidatePreviewError ? (
            <div className="connected-candidate-unavailable" role="alert">
              <span>Candidate preview private values withheld</span><strong>{candidatePreviewError.code}</strong><p>{candidatePreviewError.message}</p>
            </div>
          ) : candidatePreview && !candidatePreviewBound ? (
            <p className="connected-candidate-invalid" role="alert">The candidate preview does not bind this exact review-only selection, work, lock, and source action set. No private provider argument is displayed.</p>
          ) : candidatePreview && candidatePreviewBound ? (
            <CandidatePreviewLedger preview={candidatePreview} />
          ) : candidatePreviewBusy ? (
            <p className="connected-candidate-loading" role="status">Loading the selected candidate preview…</p>
          ) : null}
        </>
      ) : (
        <p className="derived-review-loading" role="status">Loading exact candidate-selection material…</p>
      )}
      <footer><div><strong>No authority</strong><span>Review-only selection cannot approve, confirm, continue, retry, execute, write, or send.</span></div><button type="button" onClick={onClose}>End candidate review</button></footer>
    </section>
  );
}

function CandidatePreviewLedger({ preview }: { preview: ReviewOnlyCandidatePreview }) {
  return (
    <section className="candidate-preview-ledger" aria-label="Selected review-only candidate preview private ledger">
      <header>
        <div><span className="eyebrow">Selected-preview private ledger</span><strong>Candidate preview</strong><small>Core projection · private arguments · selected preview only</small></div>
        <div className="candidate-preview-status"><StateMark state="blocked" compact /><span>Executable</span><strong>no</strong><span>Authority</span><strong>none</strong></div>
      </header>
      <div className="candidate-preview-summary">
        <Fingerprint label="Preview" value={preview.fingerprint} />
        <Fingerprint label="Compiler" value={preview.compiler.moduleFingerprint} />
        <div><span>Compiler module</span><strong>{preview.compiler.module}</strong><small>{preview.compiler.compileExport} · {preview.compiler.evaluateExport}</small></div>
        <div><span>Applicability</span><strong>{preview.configuration.applicability}</strong><small>{preview.configuration.name} · {preview.configuration.host}</small></div>
      </div>
      <ol className="candidate-preview-operations" aria-label="Review-only candidate preview operations">
        {preview.operations.map((operation) => (
          <li key={operation.id}>
            <header><span>{String(operation.sequence).padStart(2, '0')}</span><div><strong>{readable(operation.capability)}</strong><code>{operation.effect} · {operation.authority}</code></div><StateMark state="blocked" compact /></header>
            <div className="candidate-preview-operation-grid">
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
      <div className="candidate-preview-blockers" aria-label="Review-only candidate preview blockers">
        {preview.blockers.map((blocker) => <code key={blocker}>{blocker}</code>)}
      </div>
      <footer><strong>Blocked review only</strong><span>This candidate cannot approve, confirm, continue, retry, reconcile, execute, write, draft, label, or send.</span></footer>
    </section>
  );
}

function PrivateCandidateItem({
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

function reviewOnlyCandidateSelectionBound(work: PreparedWork, selection: ReviewOnlyCandidateSelection) {
  const privateReview = work.preview.privateReview;
  return privateReview.state === 'available'
    && selection.work.id === work.id
    && selection.work.fingerprint === work.fingerprint
    && selection.work.checkpointId === work.checkpoint.id
    && selection.work.checkpointFingerprint === work.checkpoint.fingerprint
    && selection.work.automationId === work.automation.id
    && selection.work.automationVersion === work.automation.version
    && selection.configuration.name === work.configuration.name
    && selection.configuration.path === work.configuration.path
    && selection.configuration.lockPath === work.configuration.lockPath
    && selection.configuration.lockFingerprint === work.configuration.lockFingerprint
    && selection.configuration.graphFingerprint === work.configuration.graphFingerprint
    && selection.configuration.host === work.configuration.host
    && selection.preview.kind === work.preview.kind
    && selection.preview.fingerprint === work.preview.fingerprint
    && selection.preview.privateReviewKind === privateReview.kind
    && selection.preview.privateReviewContentFingerprint === privateReview.contentFingerprint
    && selection.state === 'review-only'
    && selection.privacy.authority === 'none';
}

function reviewOnlyCandidateSelectionMaterialBound(work: PreparedWork, selection: ReviewOnlyCandidateSelection, material: ReviewOnlyCandidateSelectionMaterial) {
  if (!reviewOnlyCandidateSelectionBound(work, selection)
    || material.selection.id !== selection.id
    || material.selection.fingerprint !== selection.fingerprint
    || material.selection.createdAt !== selection.createdAt
    || material.selection.state !== selection.state
    || material.work.id !== work.id
    || material.work.fingerprint !== work.fingerprint
    || material.work.checkpointId !== work.checkpoint.id
    || material.work.checkpointFingerprint !== work.checkpoint.fingerprint
    || material.work.automationId !== work.automation.id
    || material.configuration.name !== selection.configuration.name
    || material.configuration.path !== selection.configuration.path
    || material.configuration.lockPath !== selection.configuration.lockPath
    || material.configuration.lockFingerprint !== selection.configuration.lockFingerprint
    || material.configuration.graphFingerprint !== selection.configuration.graphFingerprint
    || material.configuration.host !== selection.configuration.host
    || JSON.stringify(material.scope) !== JSON.stringify(selection.scope)
    || JSON.stringify(material.effects) !== JSON.stringify(selection.effects)
    || JSON.stringify(material.blockers) !== JSON.stringify(selection.blockers)
    || material.actions.length !== selection.actions.length
    || material.privacy.authority !== 'none') return false;

  return material.actions.every((action, index) => {
    const selectedAction = selection.actions[index];
    const sourceMatches = (item: PreparedWorkDerivedReviewMaterial['items'][number]) => item.sources.some((source) => (
      source.collectionId === selectedAction.source.collectionId
      && source.rowId === selectedAction.source.rowId
      && source.rowFingerprint === selectedAction.source.rowFingerprint
    ));
    return JSON.stringify(action.selection) === JSON.stringify(selectedAction)
      && action.proposed.fingerprint === selectedAction.proposedValueFingerprint
      && sourceMatches(action.proposed)
      && (selectedAction.contextValueFingerprint === null
        ? action.context === null
        : action.context?.fingerprint === selectedAction.contextValueFingerprint && sourceMatches(action.context));
  });
}

function reviewOnlyCandidatePreviewBound(work: PreparedWork, selection: ReviewOnlyCandidateSelection, preview: ReviewOnlyCandidatePreview) {
  const selectedActions = new Set(selection.actions.map((action) => action.id));
  return reviewOnlyCandidateSelectionBound(work, selection)
    && preview.source.selectionId === selection.id
    && preview.source.selectionFingerprint === selection.fingerprint
    && preview.source.workId === work.id
    && preview.source.workFingerprint === work.fingerprint
    && preview.source.checkpointId === work.checkpoint.id
    && preview.source.checkpointFingerprint === work.checkpoint.fingerprint
    && preview.source.automationId === work.automation.id
    && preview.source.automationVersion === work.automation.version
    && preview.configuration.name === selection.configuration.name
    && preview.configuration.path === selection.configuration.path
    && preview.configuration.lockPath === selection.configuration.lockPath
    && preview.configuration.lockFingerprint === selection.configuration.lockFingerprint
    && preview.configuration.graphFingerprint === selection.configuration.graphFingerprint
    && preview.configuration.host === selection.configuration.host
    && preview.state === 'blocked-review-only'
    && preview.executable === false
    && preview.operations.length > 0
    && preview.operations.every((operation, index) => operation.sequence === index + 1 && selectedActions.has(operation.sourceActionId))
    && preview.privacy.scope === 'private-local-review-only-candidate-preview'
    && preview.privacy.authority === 'none'
    && preview.privacy.projection === 'review-only-candidate-preview-only'
    && preview.privacy.privateValuesIncluded === true
    && preview.privacy.providerArgumentsIncluded === true
    && preview.privacy.rawProviderResponsesIncluded === false
    && preview.privacy.credentialValuesIncluded === false
    && preview.privacy.workspaceInspectionIncluded === false
    && preview.privacy.evidenceIncluded === false
    && preview.privacy.canonicalArtifactsIncluded === false
    && preview.privacy.approvalAuthorityIncluded === false
    && preview.privacy.continuationAuthorityIncluded === false
    && preview.privacy.executionAuthorityIncluded === false
    && preview.privacy.retryAuthorityIncluded === false;
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
