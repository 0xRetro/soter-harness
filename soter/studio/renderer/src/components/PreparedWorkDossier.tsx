import type { OperatorInputField, PreparedWork, PreparedWorkDerivedReviewMaterial, PreparedWorkReviewError, PreparedWorkReviewMaterial } from '../types';
import { PreparedReviewCollections } from './PreparedReviewCollections';
import { StateMark } from './StateMark';

const containedStages = ['draft', 'preparing', 'needs-input', 'ready-for-review'] as const;
const acquisitionStages = ['draft', 'preparing', 'needs-input', 'ready-for-acquisition'] as const;

export function PreparedWorkDossier({
  work,
  reviewMaterial,
  reviewError,
  derivedReviewMaterial,
  derivedReviewError,
  inputFields
}: {
  work: PreparedWork;
  reviewMaterial: PreparedWorkReviewMaterial | null;
  reviewError: PreparedWorkReviewError | null;
  derivedReviewMaterial: PreparedWorkDerivedReviewMaterial | null;
  derivedReviewError: PreparedWorkReviewError | null;
  inputFields: OperatorInputField[];
}) {
  const connectedAcquisition = work.preparationMode === 'connected-acquisition';
  const stages = connectedAcquisition ? acquisitionStages : containedStages;
  const visited = new Set(work.history.map((item) => item.state));
  const inputById = new Map(inputFields.map((field) => [field.id, field]));
  const reviewBound = Boolean(reviewMaterial
    && reviewMaterial.workId === work.id
    && reviewMaterial.preparedWorkFingerprint === work.fingerprint
    && reviewMaterial.checkpointId === work.checkpoint.id
    && reviewMaterial.checkpointFingerprint === work.checkpoint.fingerprint
    && reviewMaterial.automation.id === work.automation.id
    && reviewMaterial.automation.version === work.automation.version
    && reviewMaterial.configuration.name === work.configuration.name
    && reviewMaterial.configuration.lockFingerprint === work.configuration.lockFingerprint
    && reviewMaterial.inputContractFingerprint === work.inputSummary.inputContractFingerprint);
  return (
    <section className="preparation-dossier" aria-label="Prepared work dossier">
      <header className="dossier-header">
        <div><span className="eyebrow">{connectedAcquisition ? 'Private acquisition staging receipt' : 'Private preparation receipt'}</span><strong>{work.id}</strong><code>{work.fingerprint}</code></div>
        <StateMark state={work.state} />
      </header>

      <ol className="preparation-spine" aria-label="Preparation lifecycle">
        {stages.map((stage, index) => {
          const active = work.state === stage;
          const observed = visited.has(stage);
          return <li key={stage} className={active ? 'current' : observed ? 'observed' : 'unobserved'} aria-current={active ? 'step' : undefined}>
            <span>{String(index + 1).padStart(2, '0')}</span><strong>{stage === 'ready-for-acquisition' ? 'staged for acquisition' : stage.replaceAll('-', ' ')}</strong><small>{active ? work.resume.reasonCode : observed ? 'observed' : 'not reached'}</small>
          </li>;
        })}
      </ol>

      {connectedAcquisition && (
        <section className="dossier-acquisition-boundary" aria-label="Connected acquisition staging boundary">
          <span aria-hidden="true">↧</span>
          <div>
            <span className="eyebrow">Staged input + lock</span>
            <strong>No connected acquisition has run</strong>
            <p>This receipt binds exact private input and the current private-active lock. It contains no provider call, acquired context, approval, continuation request, readiness, or execution authority.</p>
            <code>mode:connected-acquisition · state:ready-for-acquisition · authority:none</code>
          </div>
        </section>
      )}

      <section className="dossier-binding" aria-label="Exact preparation binding">
        <DossierHeading index="A" title="Exact binding" note={`${connectedAcquisition ? 'Staged input receipt' : 'Contained review receipt'} · one configuration, lock, graph, and private checkpoint · ${work.configuration.applicability}`} />
        <div className="dossier-fingerprint-grid">
          <Fingerprint label="Configuration" value={work.configuration.name} />
          <Fingerprint label="Applicability" value={work.configuration.applicability} />
          <Fingerprint label="Lock" value={work.configuration.lockFingerprint} />
          <Fingerprint label="Graph" value={work.configuration.graphFingerprint} />
          <Fingerprint label="Checkpoint" value={work.checkpoint.fingerprint} />
        </div>
      </section>

      <section className="dossier-inputs" aria-label="Sanitized input summary">
        <DossierHeading index="B" title="Sanitized input summary" note="Private values are structurally absent" />
        <div className="dossier-input-list">
          {work.inputSummary.fields.map((field) => (
            <article key={field.id}>
              <div><strong>{field.id}</strong><small>{field.exposure}</small></div>
              <span>{field.state}</span>
              <code>{field.exposure === 'identifier' ? displayValue(field.value) : field.fingerprint ? 'fingerprinted · raw absent' : 'omitted'}</code>
            </article>
          ))}
        </div>
      </section>

      {(reviewMaterial || reviewError) && (
        <section className="dossier-private-review" aria-label="Private local review material">
          <header>
            <div><span className="eyebrow">Private local review</span><strong>Exact values for this prepared work</strong><small>Separate trusted Core read · excluded from inspection and evidence</small></div>
            <div className="dossier-private-seal"><span>Local</span><strong>{reviewError ? 'unavailable' : reviewBound ? reviewMaterial!.applicability : 'invalid'}</strong></div>
          </header>
          {reviewError ? <div className="dossier-private-unavailable" role="alert">
            <span>Private values withheld</span>
            <strong>{reviewError.code}</strong>
            <p>{reviewError.message}</p>
            <small>The sanitized prepared-work receipt remains available. Inspect and repair the private local state before review.</small>
          </div> : reviewBound ? <div className="dossier-private-fields">
            {reviewMaterial!.fields.map((field) => (
              <article key={field.id}>
                <div><strong>{inputById.get(field.id)?.label || readableField(field.id)}</strong><code>{inputById.get(field.id)?.type || 'declared input'} · {field.exposure}</code></div>
                <span>{field.state}</span>
                <p>{field.state === 'provided' ? displayReviewValue(field.reviewValue) : 'Not provided'}</p>
                <code title={field.fingerprint || 'unavailable'}>{field.fingerprint ? shorten(field.fingerprint) : 'no fingerprint'}</code>
              </article>
            ))}
          </div> : <p className="dossier-private-invalid" role="alert">Review material does not match this exact work checkpoint. No value is displayed.</p>}
          <footer><strong>No authority</strong><span>This local review surface cannot approve, continue, execute, or establish readiness.</span></footer>
        </section>
      )}

      {work.readiness.blockers.length > 0 && (
        <section className="dossier-blockers" aria-label="Preparation blockers">
          <DossierHeading index="!" title="Input required" note="No context reads were attempted" />
          {work.readiness.blockers.map((blocker) => (
            <article key={`${blocker.reasonCode}:${blocker.fieldId || 'general'}`}>
              <StateMark state="failed" compact /><div><strong>{blocker.reasonCode}</strong><p>{blocker.message}</p><small>{blocker.remediation}</small></div>
            </article>
          ))}
        </section>
      )}

      {work.contextPlan.length > 0 && (
        <section className="dossier-context" aria-label="Contained context acquisition plan">
          <DossierHeading index="C" title="Contained context acquisition" note={`${work.capabilities.completedPrefix.length}/${work.capabilities.steps.length} exact reads completed`} />
          <ol>
            {work.contextPlan.map((step) => (
              <li key={step.id}>
                <span>{String(step.sequence).padStart(2, '0')}</span>
                <div><strong>{step.label}</strong><code>{step.capability} · {step.authority}</code><small>{step.limitation}</small></div>
                <StateMark state={step.state} compact />
              </li>
            ))}
          </ol>
        </section>
      )}

      {work.outcomes.length > 0 && (
        <section className="dossier-outcomes" aria-label="Preparation outcome ledger">
          <DossierHeading index="D" title="Outcome boundary" note="Supported facts stay separate from work that still requires judgment" />
          <div>
            {work.outcomes.map((outcome) => (
              <article key={outcome.id}>
                <StateMark state={outcome.state} compact />
                <div><strong>{outcome.label}</strong><p>{outcome.limitation}</p><code>{outcome.basis.join(' · ') || 'basis unavailable'}</code></div>
              </article>
            ))}
          </div>
        </section>
      )}

      {work.effects.length > 0 && (
        <section className="dossier-effects" aria-label="Preparation effect boundary">
          <DossierHeading index="E" title="Effect boundary" note="Observed containment and declared policy remain separate from execution authority" />
          <div>
            {work.effects.map((effect) => (
              <article key={`${effect.effect}:${effect.mode}`}>
                <div><strong>{effect.effect}</strong><code>{effect.mode}</code></div>
                <StateMark state={effect.state} compact />
                <p>{effect.reason}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {work.preview.facts.length > 0 && (
        <section className="dossier-preview" aria-label={`${previewTitle(work.preview.kind)} preview`}>
          <DossierHeading index="F" title={`${previewTitle(work.preview.kind)} preview`} note="Normalized facts with exact evidence basis" />
          <div className="dossier-fact-grid">
            {work.preview.facts.map((fact) => (
              <article key={fact.id}>
                <span>{fact.label}</span><strong>{displayValue(fact.value)}</strong><StateMark state={fact.state} compact /><small>{fact.basisIds.join(' · ') || 'basis unavailable'}</small>
              </article>
            ))}
          </div>
          {work.preview.contradictions.length > 0 && <div className="dossier-contradictions">
            <span className="eyebrow">Contradictions</span>
            {work.preview.contradictions.map((item) => <article key={item.id}><strong>{item.claim}</strong><code>{item.basisIds.join(' · ')}</code></article>)}
          </div>}
        </section>
      )}

      <PreparedReviewCollections
        work={work}
        material={derivedReviewMaterial}
        error={derivedReviewError}
      />

      {work.preview.proposedChanges.length > 0 && (
        <section className="dossier-changes" aria-label="Proposed change fingerprints">
          <DossierHeading index="G" title="Proposed change ledger" note="Review only · no approval request exists" />
          {work.preview.proposedChanges.map((change) => (
            <article key={change.id}>
              <div><strong>{change.recordId}</strong><code>{change.effect}</code></div>
              <Fingerprint label="Before" value={change.beforeFingerprint} />
              <Fingerprint label="After" value={change.afterFingerprint} />
            </article>
          ))}
        </section>
      )}

      <section className="dossier-boundary" aria-label="Preparation stop boundary">
        <span aria-hidden="true">⊣</span>
        <div><span className="eyebrow">Stop boundary</span><strong>{work.approval.state.replaceAll('-', ' ')}</strong><p>{work.approval.reason}</p><code>{work.resume.permittedNextAction} · display guidance only</code></div>
      </section>

      <footer className="dossier-footer">
        <div><span>Evidence attached</span><strong>{work.evidence.length}</strong></div>
        <div><span>Canonical writes</span><strong>{work.privacy.canonicalArtifactsWritten ? 'yes' : 'none'}</strong></div>
        <div><span>External writes</span><strong>{work.privacy.externalWritesPerformed ? 'yes' : 'none'}</strong></div>
      </footer>
    </section>
  );
}

function DossierHeading({ index, title, note }: { index: string; title: string; note: string }) {
  return <header className="dossier-section-heading"><span>{index}</span><div><strong>{title}</strong><small>{note}</small></div></header>;
}

export function previewTitle(kind: string) {
  const subject = kind.replace(/-(review|status|preview)$/, '');
  return subject.split('-').filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') || 'Prepared Review';
}

function Fingerprint({ label, value }: { label: string; value: string | null }) {
  return <div className="dossier-fingerprint"><span>{label}</span><code title={value || 'unavailable'}>{value ? shorten(value) : 'unavailable'}</code></div>;
}

function shorten(value: string) {
  return value.startsWith('sha256:') ? value.slice(0, 15) + '…' + value.slice(-7) : value;
}

function displayValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === '') return 'unavailable';
  return String(value);
}

function displayReviewValue(value: string | boolean | undefined) {
  if (value === undefined || value === '') return 'Unavailable';
  return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
}

function readableField(value: string) {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('-', ' ').replace(/^./, (character) => character.toUpperCase());
}
