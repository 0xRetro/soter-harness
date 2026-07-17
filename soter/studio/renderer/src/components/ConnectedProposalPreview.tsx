import type { ProposalConnectedBatchPreview } from '../types';
import { StateMark } from './StateMark';

export function ConnectedProposalPreview({ preview }: { preview: ProposalConnectedBatchPreview }) {
  return (
    <section className="connected-proposal-preview" aria-label="Exact connected subset preview">
      <header>
        <div>
          <span className="eyebrow">Core-compiled scope · preview only</span>
          <h3>Exact connected subset</h3>
          <p>Canonical order, provider route, precondition, verification, and ambiguity facts. Portable inputs and private review values remain withheld.</p>
        </div>
        <StateMark state={preview.authority.state} compact />
      </header>

      <div className="connected-preview-meter" aria-label="Connected subset coverage">
        <Metric label="Available" value={preview.selection.availableActionCount} />
        <Metric label="Selected" value={preview.selection.selectedActionCount} />
        <Metric label="Subset" value={preview.selection.partial ? 'partial' : 'complete'} />
        <Metric label="Provider calls" value={preview.providerCallsExecuted} />
        <Metric label="External writes" value={preview.externalWritesPerformed} />
      </div>

      <div className="connected-preview-seals" aria-label="Connected subset seals">
        <Seal label="Change set" value={preview.changeSet.scopeFingerprint} />
        <Seal label="Operation batch" value={preview.batch.batchFingerprint} />
        <Seal label="Selection" value={preview.selection.fingerprint} />
        <Seal label="Exact lock" value={preview.changeSet.configurationLockFingerprint} />
      </div>

      <ol className="connected-preview-operations">
        {preview.batch.operations.map((operation) => (
          <li key={operation.id}>
            <span className="connected-preview-index">{String(operation.sequence).padStart(2, '0')}</span>
            <div className="connected-preview-operation-copy">
              <strong>{readable(operation.capability)}</strong>
              <code>{operation.sourceActionId}</code>
              <small>{operation.authority}</small>
            </div>
            <div className="connected-preview-route">
              <span>Connected route</span>
              <strong>{operation.provider.pack}</strong>
              <code>{operation.provider.connectedImplementation} · v{operation.provider.version}</code>
            </div>
            <div className="connected-preview-guard">
              <span>Guard sequence</span>
              <code>{operation.precondition.kind === 'none' ? 'no precondition' : operation.precondition.capability}</code>
              <code>{operation.capability}</code>
              <code>{operation.verification.capability}</code>
            </div>
            <div className="connected-preview-ambiguity">
              <span>Ambiguity</span>
              <code>{operation.ambiguity.reasonCode}</code>
              <small>retry {operation.ambiguity.retry} · {operation.recovery.mode}</small>
            </div>
          </li>
        ))}
      </ol>

      <footer>
        <span aria-hidden="true">⊢</span>
        <div>
          <strong>Compiled scope is not approval</strong>
          <p>Core created no provider call or write. A separate exact request, private review, confirmation, and one-time start remain required.</p>
        </div>
        <code>{preview.authority.reasonCode}</code>
      </footer>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Seal({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><code title={value}>{shorten(value)}</code></div>;
}

function readable(value: string) {
  return value.replaceAll('.', ' ').replaceAll('-', ' ').replace(/^./, (character) => character.toUpperCase());
}

function shorten(value: string) {
  return value.length > 24 ? `${value.slice(0, 15)}…${value.slice(-7)}` : value;
}
