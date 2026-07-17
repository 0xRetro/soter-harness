import type { ConnectedApprovalReviewMaterial, OperatorInspection, PreparedWorkReviewError } from '../types';

interface ConnectedApprovalReviewProps {
  inspection: OperatorInspection;
  material: ConnectedApprovalReviewMaterial | null;
  error: PreparedWorkReviewError | null;
}

export function ConnectedApprovalReview({ inspection, material, error }: ConnectedApprovalReviewProps) {
  if (error) {
    return <ReviewUnavailable code={error.code} message={error.message} />;
  }
  if (!material) {
    return (
      <section className="approval-review-folio approval-review-loading" aria-label="Private exact-batch approval review" aria-live="polite">
        <span className="eyebrow">Selected-activity private folio</span>
        <strong>Loading exact-batch review…</strong>
        <p>Values remain suppressed until the selected request and its immutable bindings are validated.</p>
      </section>
    );
  }
  if (!reviewBoundToInspection(inspection, material)) {
    return (
      <ReviewUnavailable
        code="CONNECTED_APPROVAL_REVIEW_MATERIAL_BINDING_INVALID"
        message="Private approval review material does not match this selected activity."
      />
    );
  }

  return (
    <section className="approval-review-folio" aria-label="Private exact-batch approval review">
      <header className="approval-review-heading">
        <div>
          <span className="eyebrow">Selected-activity private folio</span>
          <h3>Exact operation review</h3>
          <p>{material.request.reason}</p>
        </div>
        <div className={`approval-review-completeness completeness-${material.completeness.state}`}>
          <span>Review fact</span>
          <strong>{material.completeness.state}</strong>
          <small>{material.operations.length} ordered operation{material.operations.length === 1 ? '' : 's'}</small>
        </div>
      </header>

      <div className="approval-review-bindings" aria-label="Exact private review bindings">
        <Binding label="Request" value={material.request.fingerprint} />
        <Binding label="Run" value={material.run.fingerprint} />
        <Binding label="Lock" value={material.configuration.lockFingerprint} />
        <Binding label="Graph" value={material.configuration.graphFingerprint} />
        <Binding label="Change set · document" value={material.changeSet.documentFingerprint} />
        <Binding label="Change set · scope" value={material.changeSet.scopeFingerprint} />
        <Binding label="Batch · document" value={material.batch.documentFingerprint} />
        <Binding label="Batch · scope" value={material.batch.scopeFingerprint} />
      </div>

      {material.completeness.reasonCodes.length > 0 && (
        <div className="approval-review-reasons" role="note">
          <span>Incomplete review facts</span>
          {material.completeness.reasonCodes.map((code) => <code key={code}>{code}</code>)}
        </div>
      )}

      <ol className="approval-operation-list">
        {material.operations.map((operation) => (
          <li key={operation.id}>
            <header>
              <span className="approval-operation-index">{String(operation.sequence).padStart(2, '0')}</span>
              <div>
                <code>{operation.capability}</code>
                <strong>{operation.subject.type} · {operation.subject.id || 'new portable resource'}</strong>
                <p>{operation.reason}</p>
              </div>
              <span className="approval-operation-effect">{material.effects.join(' + ')}</span>
            </header>

            <div className="approval-operation-values">
              <ReviewValuePanel
                label="Before"
                state={operation.before.state}
                value={operation.before.state === 'provided' ? operation.before.reviewValue : null}
                reason={operation.before.reasonCode}
                fingerprint={operation.before.fingerprint}
              />
              <ReviewValuePanel
                label="Proposed"
                state="provided"
                value={operation.after.reviewValue}
                fingerprint={operation.after.fingerprint}
              />
              <ReviewValuePanel
                label="Precondition"
                state="provided"
                value={operation.precondition.reviewValue}
                fingerprint={operation.precondition.fingerprint}
              />
            </div>

            <div className="approval-operation-evidence">
              <div><span>Authority</span><code>{operation.authority}</code></div>
              <div><span>Verification</span><code>{operation.verification.kind}</code><small>{operation.verification.contentFingerprint ? 'content bound' : 'content unavailable'}</small></div>
              <div><span>Recovery</span><code>{operation.recovery.mode}</code><small>{operation.recovery.reason}</small></div>
            </div>

            <footer>
              <Binding label="Operation" value={operation.operationFingerprint} />
              <Binding label="Compiled batch op" value={operation.batchOperationFingerprint} />
              <Binding label="Source change op" value={operation.changeSetOperationFingerprint} />
              <Binding label="Input" value={operation.inputFingerprint} />
            </footer>
          </li>
        ))}
      </ol>

      <footer className="approval-review-boundary">
        <span aria-hidden="true">⊣</span>
        <div>
          <strong>Private review ends here</strong>
          <p>This selected-activity projection carries no approval, continuation, retry, host-request, or provider-operation authority. Canonical confirmation remains a separate request-ID operation.</p>
        </div>
        <code>{material.fingerprint}</code>
      </footer>
    </section>
  );
}

function ReviewUnavailable({ code, message }: { code: string; message: string }) {
  return (
    <section className="approval-review-folio approval-review-unavailable" aria-label="Private exact-batch approval review" role="status">
      <span className="eyebrow">Selected-activity private folio</span>
      <strong>Private values suppressed</strong>
      <p>{message}</p>
      <code>{code}</code>
      <small>The sanitized activity remains visible. This review state grants no authority and does not change canonical confirmability.</small>
    </section>
  );
}

function ReviewValuePanel({ label, state, value, reason, fingerprint }: {
  label: string;
  state: 'provided' | 'unavailable' | 'not-required' | 'absent-required';
  value: Record<string, unknown> | null;
  reason?: string;
  fingerprint: string | null;
}) {
  return (
    <section className={`approval-review-value value-${state}`} aria-label={`${label} review value`}>
      <header><span>{label}</span><code>{state}</code></header>
      {value ? (
        <dl>{Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => (
          <div key={key}><dt>{readable(key)}</dt><dd>{formatReviewValue(item)}</dd></div>
        ))}</dl>
      ) : (
        <p>{state === 'absent-required'
          ? 'Exact absence is required for deduplication.'
          : state === 'not-required'
            ? 'This operation does not require a prior value; none is represented.'
            : 'Source context is unavailable; no value is represented.'}</p>
      )}
      {reason && <small>{reason}</small>}
      <code className="approval-value-fingerprint">{fingerprint || 'fingerprint unavailable'}</code>
    </section>
  );
}

function Binding({ label, value }: { label: string; value: string }) {
  return <div className="approval-review-binding"><span>{label}</span><code title={value}>{value}</code></div>;
}

function reviewBoundToInspection(inspection: OperatorInspection, material: ConnectedApprovalReviewMaterial) {
  const materialEffects = [...material.effects].sort().join('|');
  const inspectionEffects = [...inspection.scope.effects].sort().join('|');
  return material.request.id === inspection.approval.request.id
    && material.request.fingerprint === inspection.approval.request.fingerprint
    && material.configuration.path === inspection.configuration.path
    && material.configuration.lockPath === inspection.configuration.lockPath
    && material.configuration.lockFingerprint === inspection.configuration.lockFingerprint
    && material.configuration.graphFingerprint === inspection.configuration.graphFingerprint
    && material.configuration.host === inspection.configuration.host
    && material.configuration.applicability.state === inspection.configuration.applicability.state
    && material.run.id === inspection.activity.runId
    && material.changeSet.id === inspection.scope.changeSet.id
    && material.changeSet.documentFingerprint === inspection.scope.changeSet.fingerprint
    && material.batch.id === inspection.scope.batch.id
    && material.batch.documentFingerprint === inspection.scope.batch.fingerprint
    && materialEffects === inspectionEffects;
}

function formatReviewValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(formatReviewValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function readable(value: string) {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll(/[-_.]/g, ' ');
}
