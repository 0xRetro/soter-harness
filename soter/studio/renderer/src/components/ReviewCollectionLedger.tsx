import type { PreparedReviewCollection, PreparedReviewRow } from '../types';
import { StateMark } from './StateMark';

export function ReviewCollectionLedger({
  collections,
  privateItemCount,
  selectedActionIds = [],
  selectionDisabled = false,
  selectionPurpose = 'review',
  onToggleAction
}: {
  collections: PreparedReviewCollection[];
  privateItemCount?: (collectionId: string, row: PreparedReviewRow) => number;
  selectedActionIds?: string[];
  selectionDisabled?: boolean;
  selectionPurpose?: string;
  onToggleAction?: (actionId: string) => void;
}) {
  return <>{collections.map((collection) => (
    <article className="review-collection" key={collection.id}>
      <header>
        <div><code>{collection.labelKey}</code><strong>{readable(collection.kind)}</strong></div>
        <div className="review-coverage" aria-label={`${collection.labelKey} coverage`}>
          <CoverageMetric label="Observed" value={collection.coverage.observedCount} />
          <CoverageMetric label="Included" value={collection.coverage.includedCount} />
          <CoverageMetric label="Excluded" value={collection.coverage.excludedCount} />
          <StateMark state={collection.coverage.complete ? 'complete' : 'incomplete'} compact />
        </div>
      </header>
      {collection.coverage.exclusions.length > 0 && (
        <ul className="review-exclusions" aria-label={`${collection.labelKey} exclusions`}>
          {collection.coverage.exclusions.map((exclusion) => (
            <li key={exclusion.reasonCode}><code>{exclusion.reasonCode}</code><strong>{exclusion.count}</strong></li>
          ))}
        </ul>
      )}
      <ol className="review-row-ledger">
        {collection.rows.map((row) => (
          <ReviewRow
            key={row.id}
            row={row}
            collectionId={collection.id}
            privateItemCount={privateItemCount?.(collection.id, row) || 0}
            selectedActionIds={selectedActionIds}
            selectionDisabled={selectionDisabled}
            selectionPurpose={selectionPurpose}
            onToggleAction={onToggleAction}
          />
        ))}
      </ol>
      <footer><span>Collection seal</span><code title={collection.fingerprint}>{shorten(collection.fingerprint)}</code></footer>
    </article>
  ))}</>;
}

function ReviewRow({
  row,
  collectionId,
  privateItemCount,
  selectedActionIds,
  selectionDisabled,
  selectionPurpose,
  onToggleAction
}: {
  row: PreparedReviewRow;
  collectionId: string;
  privateItemCount: number;
  selectedActionIds: string[];
  selectionDisabled: boolean;
  selectionPurpose: string;
  onToggleAction?: (actionId: string) => void;
}) {
  return (
    <li className="review-row">
      <header>
        <span className="review-row-sequence">{String(row.sequence).padStart(2, '0')}</span>
        <div><strong>{readable(row.group)}</strong><code>{row.reasonCode}</code></div>
        <div className="review-row-measures"><span>{row.representedCount} represented</span><span>{row.attention}</span><span>{row.disposition}</span></div>
      </header>
      <div className="review-row-subject"><span>{row.subject.kind}</span><code title={row.subject.fingerprint}>{shorten(row.subject.fingerprint)}</code></div>
      {row.flags.length > 0 && <ul className="review-flags">{row.flags.map((flag) => <li key={flag}>{flag}</li>)}</ul>}
      <div className="review-actions" aria-label={`${row.id} actions`}>
        {row.actions.map((action) => (
          <article key={action.id} className={action.state === 'proposed' && selectedActionIds.includes(action.id) ? 'selected' : ''}>
            <div><strong>{readable(action.kind)}</strong><StateMark state={action.state} compact /></div>
            <code>{action.effect || 'no effect'} · {action.capability || (action.state === 'handoff' ? 'provider-neutral handoff' : 'no bound capability')}</code>
            <small>{action.reasonCode}</small>
            {'changeFingerprint' in action && action.changeFingerprint && <code title={action.changeFingerprint}>{shorten(action.changeFingerprint)}</code>}
            {action.state === 'proposed' && onToggleAction && (
              <label className="review-action-select">
                <input
                  type="checkbox"
                  checked={selectedActionIds.includes(action.id)}
                  disabled={selectionDisabled}
                  onChange={() => onToggleAction(action.id)}
                />
                <span>Select {readable(action.kind)} for {selectionPurpose}</span>
              </label>
            )}
          </article>
        ))}
      </div>
      {privateItemCount > 0 && <div className="review-private-join"><span>Private folio</span><strong>{privateItemCount} exact {privateItemCount === 1 ? 'item' : 'items'} joined</strong></div>}
      <footer><code>{collectionId} / {row.id}</code><code title={row.fingerprint}>{shorten(row.fingerprint)}</code></footer>
    </li>
  );
}

function CoverageMetric({ label, value }: { label: string; value: number }) {
  return <span><small>{label}</small><strong>{value}</strong></span>;
}

function shorten(value: string) {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

function readable(value: string) {
  return value.replaceAll('.', ' ').replaceAll('-', ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());
}
