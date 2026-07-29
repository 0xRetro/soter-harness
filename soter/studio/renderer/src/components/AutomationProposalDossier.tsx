import type {
  AutomationProposal,
  AutomationProposalMaterial,
  PreparedReviewRow,
  PreparedWorkReviewError,
  ProposalConnectedBatchPreview
} from '../types';
import { ConnectedProposalPreview } from './ConnectedProposalPreview';
import { ReviewCollectionLedger } from './ReviewCollectionLedger';
import { StateMark } from './StateMark';

export function AutomationProposalDossier({
  proposal,
  material,
  error,
  configurationName,
  lockFingerprint,
  selectedActionIds,
  selectionDisabled,
  connectedPreview,
  onToggleAction,
  onClose
}: {
  proposal: AutomationProposal;
  material: AutomationProposalMaterial | null;
  error: PreparedWorkReviewError | null;
  configurationName: string;
  lockFingerprint: string;
  selectedActionIds: string[];
  selectionDisabled: boolean;
  connectedPreview: ProposalConnectedBatchPreview | null;
  onToggleAction: (actionId: string) => void;
  onClose: () => void;
}) {
  const materialBound = material
    ? automationProposalMaterialBound(proposal, material, configurationName, lockFingerprint)
    : false;
  const coverageComplete = proposal.review.collections.every((collection) => collection.coverage.complete);
  const proposedCount = proposal.review.collections.reduce((total, collection) => total
    + collection.rows.reduce((rows, row) => rows
      + row.actions.filter((action) => action.state === 'proposed').length, 0), 0);
  const heldReasonCodes = [...new Set(proposal.review.collections.flatMap((collection) => (
    collection.rows.flatMap((row) => row.actions
      .filter((action) => action.state === 'held')
      .map((action) => action.reasonCode))
  )))].sort();
  const reviewTitle = readable(proposal.review.kind.replace(/-review$/, ''));

  return (
    <article className="automation-proposal-dossier" aria-label={`Selected ${reviewTitle} review-only proposal`}>
      <header className="proposal-dossier-header">
        <div>
          <span className="eyebrow">Selected proposal · private local review</span>
          <h2>{reviewTitle} review proposal</h2>
          <p>One paused Automation decision projected as a sanitized manifest with a separately loaded private folio.</p>
        </div>
        <div className="proposal-dossier-state">
          <StateMark state={proposal.state} compact />
          <button type="button" className="secondary" onClick={onClose}>End selected review</button>
        </div>
      </header>

      <section className="proposal-seal-grid" aria-label="Proposal binding seals">
        <ProposalSeal label="Proposal" value={proposal.id} />
        <ProposalSeal label="Decision" value={proposal.decision.id} />
        <ProposalSeal label="Run" value={proposal.runId} />
        <ProposalSeal label="Exact lock" value={proposal.configurationLockFingerprint} />
      </section>

      <section className="proposal-authority-cut" aria-label="Proposal authority boundary">
        <div><span className="eyebrow">Proposal state</span><strong>{proposal.review.collections.length} collections · {proposedCount} selectable proposed actions</strong><p>Coverage, held reasons, and proposed actions describe review material only.</p></div>
        <div><span>Authority</span><strong>none</strong><code>{proposal.authority.reasonCode}</code></div>
        <div><span>External writes</span><strong>not performed</strong><code>run remains paused</code></div>
      </section>

      <section className="proposal-fact-ledger" aria-label="Sanitized proposal facts">
        <header><div><span className="eyebrow">Sanitized manifest</span><strong>Review facts and contradictions</strong></div><StateMark state={coverageComplete ? 'complete' : 'incomplete'} compact /></header>
        <dl>
          {proposal.review.facts.map((fact) => <div key={fact.id}><dt>{fact.label}</dt><dd><span>{String(fact.value ?? 'unavailable')}</span><StateMark state={fact.state} compact /></dd></div>)}
        </dl>
        {proposal.review.contradictions.length > 0 && <ul>{proposal.review.contradictions.map((contradiction) => <li key={contradiction.id}><code>{contradiction.id}</code><span>{contradiction.claim}</span></li>)}</ul>}
      </section>

      {proposedCount > 0 ? (
        <section className="proposal-selection-instrument" aria-label="Exact proposed action selection">
          <div>
            <span className="eyebrow">Exact subset · sanitized identities only</span>
            <strong>{selectedActionIds.length} of {proposedCount} proposed actions selected</strong>
            <p>Only actions already marked proposed can enter the Core preview. Held, prohibited, none, and handoff rows remain outside the selection control.</p>
          </div>
          <div className="proposal-selection-count" aria-label={`${selectedActionIds.length} selected actions`}>
            <span>{String(selectedActionIds.length).padStart(2, '0')}</span>
            <i aria-hidden="true" />
            <small>exact IDs</small>
          </div>
        </section>
      ) : heldReasonCodes.length > 0 ? (
        <section className="proposal-selection-instrument" aria-label="Held proposal boundary">
          <div>
            <span className="eyebrow">Held review · no selectable action</span>
            <strong>0 proposed actions</strong>
            <p>{heldReasonCodes.join(' · ')}</p>
          </div>
          <div className="proposal-selection-count" aria-label="No selectable actions">
            <span>00</span>
            <i aria-hidden="true" />
            <small>held</small>
          </div>
        </section>
      ) : null}

      <section className="review-manifest proposal-review-manifest" aria-label="Automation proposal review collections">
        <ReviewCollectionLedger
          collections={proposal.review.collections}
          privateItemCount={(collectionId, row) => materialBound
            ? privateItemsFor(material!, collectionId, row).length
            : 0}
          selectedActionIds={selectedActionIds}
          selectionDisabled={selectionDisabled}
          selectionPurpose="exact connected scope"
          onToggleAction={proposedCount > 0 ? onToggleAction : undefined}
        />
      </section>

      {connectedPreview && <ConnectedProposalPreview preview={connectedPreview} />}

      <section className="proposal-private-folio" aria-label="Selected proposal private material">
        <header>
          <div><span className="eyebrow">Privacy cut · selected proposal only</span><strong>Complete normalized review values</strong><small>Loaded through a separate sender-validated read and cleared when this review ends.</small></div>
          <div className="dossier-private-seal"><span>Authority</span><strong>none</strong><code>{material?.authority.reasonCode || 'selected-private read pending'}</code></div>
        </header>
        {error ? (
          <div className="dossier-private-unavailable" role="alert"><span>Private proposal values withheld</span><strong>{error.code}</strong><p>{error.message}</p></div>
        ) : material && !materialBound ? (
          <p className="dossier-private-invalid" role="alert">Private proposal material does not bind this exact proposal, decision, Automation, configuration, review contract, and content seal. No value is displayed.</p>
        ) : proposal.review.privateReview.state === 'available' && !material ? (
          <p className="derived-review-loading" role="status">Loading selected proposal material…</p>
        ) : materialBound ? (
          <>
            <div className="derived-review-seals">
              <ProposalSeal label="Content" value={material!.contentFingerprint} />
              <ProposalSeal label="Review contract" value={material!.reviewContractFingerprint} />
              <ProposalSeal label="Material" value={material!.fingerprint} />
            </div>
            <div className="derived-review-items">
              {material!.items.map((item) => (
                <details key={item.id} className="review-private-detail">
                  <summary>Open {readable(item.kind)} detail <span>{item.sources.length} exact {item.sources.length === 1 ? 'source' : 'sources'}</span></summary>
                  <article>
                    <header><strong>{readable(item.kind)}</strong><code title={item.fingerprint}>{shorten(item.fingerprint)}</code></header>
                    <code>{item.sources.map((source) => `${source.collectionId} / ${source.rowId}`).join(' · ')}</code>
                    <dl>{item.fields.map((field) => <div key={field.id}><dt>{field.label}</dt><dd>{displayReviewValue(field.reviewValue)}</dd></div>)}</dl>
                  </article>
                </details>
              ))}
            </div>
          </>
        ) : <p className="derived-review-loading">This proposal declares no private companion.</p>}
        <footer><strong>No operational authority</strong><span>Reviewing these values cannot approve, confirm, continue, execute, retry, reconcile, write, or send. Exact subset selection remains a separate sanitized Core preview.</span></footer>
      </section>

      <section className="proposal-limitations" aria-label="Proposal limitations">
        <header><span className="eyebrow">Boundary conditions</span><strong>{proposal.limitations.length}</strong></header>
        <ul>{proposal.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        <footer><span>Created</span><time dateTime={proposal.createdAt}>{formatTime(proposal.createdAt)}</time><code>{shorten(proposal.proposalFingerprint)}</code></footer>
      </section>
    </article>
  );
}

export function automationProposalMaterialBound(
  proposal: AutomationProposal,
  material: AutomationProposalMaterial,
  configurationName: string,
  lockFingerprint: string
) {
  const privateReview = proposal.review.privateReview;
  if (privateReview.state !== 'available'
    || material.proposal.id !== proposal.id
    || material.proposal.fingerprint !== proposal.proposalFingerprint
    || material.decision.id !== proposal.decision.id
    || material.decision.fingerprint !== proposal.decision.fingerprint
    || material.automation.id !== proposal.automation.id
    || material.automation.version !== proposal.automation.version
    || material.configuration.name !== configurationName
    || material.configuration.lockFingerprint !== lockFingerprint
    || material.configuration.lockFingerprint !== proposal.configurationLockFingerprint
    || material.configuration.graphFingerprint !== proposal.graphFingerprint
    || material.reviewContractId !== privateReview.contractId
    || material.reviewContractFingerprint !== privateReview.contractFingerprint
    || material.kind !== privateReview.kind
    || material.contentFingerprint !== privateReview.contentFingerprint
    || material.authority.state !== 'none'
    || material.authority.reasonCode !== 'AUTOMATION_PROPOSAL_MATERIAL_REVIEW_ONLY'
    || material.privacy.projection !== 'selected-proposal-only') return false;

  const rows = new Map(proposal.review.collections.flatMap((collection) => collection.rows.map((row) => [
    `${collection.id}:${row.id}:${row.fingerprint}`,
    row
  ])));
  if (material.items.some((item) => item.sources.some((source) => !rows.has(
    `${source.collectionId}:${source.rowId}:${source.rowFingerprint}`
  )))) return false;
  const itemFingerprints = new Set(material.items.map((item) => item.fingerprint));
  if (proposal.review.collections.some((collection) => collection.rows.some((row) => (
    row.privateDetailFingerprint !== null && !itemFingerprints.has(row.privateDetailFingerprint)
  )))) return false;
  return proposal.review.proposedChanges.every((change) => (
    change.afterFingerprint === null || itemFingerprints.has(change.afterFingerprint)
  ));
}

function privateItemsFor(material: AutomationProposalMaterial, collectionId: string, row: PreparedReviewRow) {
  return material.items.filter((item) => item.sources.some((source) => (
    source.collectionId === collectionId
    && source.rowId === row.id
    && source.rowFingerprint === row.fingerprint
  )));
}

function ProposalSeal({ label, value }: { label: string; value: string }) {
  return <div className="proposal-seal"><span>{label}</span><code title={value}>{shorten(value)}</code></div>;
}

function displayReviewValue(value: string | boolean | string[]) {
  if (Array.isArray(value)) return value.join('\n');
  return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
}

function readable(value: string) {
  return value.replaceAll('.', ' ').replaceAll('-', ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());
}

function shorten(value: string) {
  return value.startsWith('sha256:') ? value.slice(0, 15) + '…' + value.slice(-7) : value;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
