import { useState } from 'react';
import type {
  BundleInspection,
  BundleInspectionResult,
  DistributionInspectionError,
  DistributionLegalBoundary,
  DistributionTrustBoundary,
  PackReleaseInspection,
  PackReleaseInspectionResult
} from '../types';
import { StateMark } from './StateMark';

const adapterUnavailable: DistributionInspectionError = {
  code: 'DISTRIBUTION_ADAPTER_UNAVAILABLE',
  message: 'The local distribution inspection adapter is unavailable.'
};

export function DistributionView() {
  const [release, setRelease] = useState<PackReleaseInspection | null>(null);
  const [bundle, setBundle] = useState<BundleInspection | null>(null);
  const [releaseError, setReleaseError] = useState<DistributionInspectionError | null>(null);
  const [bundleError, setBundleError] = useState<DistributionInspectionError | null>(null);
  const [busy, setBusy] = useState<'release' | 'bundle' | null>(null);

  const inspectRelease = async () => {
    setBusy('release');
    setRelease(null);
    setReleaseError(null);
    const result = await window.soterStudio.inspectLocalPackRelease()
      .catch((): PackReleaseInspectionResult => ({ ok: false, error: adapterUnavailable }));
    if (result.ok) setRelease(result.inspection);
    else setReleaseError(result.error);
    setBusy(null);
  };

  const inspectBundle = async () => {
    setBusy('bundle');
    setBundle(null);
    setBundleError(null);
    const result = await window.soterStudio.inspectLocalBundle()
      .catch((): BundleInspectionResult => ({ ok: false, error: adapterUnavailable }));
    if (result.ok) setBundle(result.inspection);
    else setBundleError(result.error);
    setBusy(null);
  };

  return (
    <div className="distribution-view">
      <header className="distribution-intro">
        <div>
          <span className="eyebrow">Distribution evidence · local inspection</span>
          <h1>Sealed release index</h1>
          <p>Verify canonical pack capsules and resolve transparent bundles without turning inspection into installation, trust, or publication authority. The persistent rail remains current-workspace proof; artifact-scoped claims stop inside each ledger below.</p>
        </div>
        <div className="distribution-mode-stamp" aria-label="Distribution inspection boundary">
          <span>Mode</span>
          <strong>Read only</strong>
          <small>Local files · no network</small>
        </div>
      </header>

      <section className="distribution-acquisition" aria-label="Local distribution inspection controls">
        <article>
          <span className="distribution-index">01</span>
          <div>
            <span className="eyebrow">Pack capsule</span>
            <strong>Verify one exact release</strong>
            <p>The operating-system picker keeps the selected path in Electron main. Studio receives only the closed sanitized inspection.</p>
          </div>
          <button type="button" onClick={inspectRelease} disabled={busy !== null}>{busy === 'release' ? 'Verifying…' : 'Inspect local capsule'}</button>
        </article>
        <article>
          <span className="distribution-index">02</span>
          <div>
            <span className="eyebrow">Transparent bundle</span>
            <strong>Resolve against a chosen local catalog</strong>
            <p>Choose one bundle and zero or more local capsules. Missing or incompatible references remain visible blockers.</p>
          </div>
          <button type="button" onClick={inspectBundle} disabled={busy !== null}>{busy === 'bundle' ? 'Resolving…' : 'Inspect local bundle'}</button>
        </article>
      </section>

      {(releaseError || bundleError) && (
        <section className="distribution-errors" aria-label="Distribution inspection errors">
          {releaseError && <DistributionError artifact="Pack release" error={releaseError} />}
          {bundleError && <DistributionError artifact="Bundle" error={bundleError} />}
        </section>
      )}

      {!release && !bundle ? <DistributionEmpty /> : (
        <div className="distribution-ledgers">
          {release && <ReleaseLedger inspection={release} onClear={() => { setRelease(null); setReleaseError(null); }} />}
          {bundle && <BundleLedger inspection={bundle} onClear={() => { setBundle(null); setBundleError(null); }} />}
        </div>
      )}

      <footer className="distribution-footer-boundary">
        <span aria-hidden="true">◇</span>
        <div><strong>Inspection stops here.</strong><p>No build, fetch, install, configure, realize, sign, trust, publish, redistribute, marketplace, or auto-update operation is exposed.</p></div>
        <code>authority:none</code>
      </footer>
    </div>
  );
}

function DistributionEmpty() {
  return (
    <section className="distribution-empty" aria-label="Empty distribution evidence ledger">
      <div className="distribution-seal" aria-hidden="true"><i /><i /><span>∅</span></div>
      <div>
        <span className="eyebrow">No artifact selected</span>
        <h2>The ledger begins with local bytes, not a catalog promise.</h2>
        <p>Choose a capsule or bundle above. Nothing is discovered, uploaded, persisted, installed, or added to workspace proof.</p>
      </div>
      <ul>
        <li><span>Paths</span><strong>withheld</strong></li>
        <li><span>Network</span><strong>unused</strong></li>
        <li><span>Authority</span><strong>none</strong></li>
      </ul>
    </section>
  );
}

function DistributionError({ artifact, error }: { artifact: string; error: DistributionInspectionError }) {
  return (
    <article>
      <span className="distribution-error-mark" aria-hidden="true">×</span>
      <div><span>{artifact} inspection did not complete</span><strong>{error.message}</strong></div>
      <code>{error.code}</code>
    </article>
  );
}

function ReleaseLedger({ inspection, onClear }: { inspection: PackReleaseInspection; onClear: () => void }) {
  const release = inspection.release;
  return (
    <article className="distribution-ledger release-ledger" aria-label={`Pack release ${release.id}`}>
      <header className="distribution-ledger-header">
        <div>
          <span className="eyebrow">Pack release · {release.layer}</span>
          <h2>{release.id}</h2>
          <p>{release.summary}</p>
        </div>
        <div className="distribution-ledger-status">
          <StateMark state={inspection.integrity.state} compact />
          <span>v{release.version} · {release.releaseStage}</span>
          <button type="button" onClick={onClear}>Clear release</button>
        </div>
      </header>

      <section className="distribution-measure-strip" aria-label="Release identity">
        <Measure label="Capsule digest" value={release.capsuleDigest} accent />
        <Measure label="Manifest" value={release.manifestFingerprint} />
        <Measure label="Source input" value={release.sourceInputFingerprint} />
        <Measure label="Created" value={release.createdAt} />
      </section>

      <section className="distribution-verification-pair">
        <article>
          <span className="eyebrow">Exact byte integrity</span>
          <div><strong>Canonical capsule verified</strong><StateMark state={inspection.integrity.state} compact /></div>
          <code>{inspection.integrity.reasonCode}</code>
          <FingerprintLine label="Inventory" value={inspection.integrity.inventoryFingerprint} />
        </article>
        <article className="source-comparison">
          <span className="eyebrow">Source comparison</span>
          <div><strong>{humanize(inspection.sourceComparison.state)}</strong><StateMark state={inspection.sourceComparison.state} compact /></div>
          <code>{inspection.sourceComparison.reasonCode}</code>
          <p>Local-file inspection does not receive a source root. Exact source equivalence is therefore not evaluated.</p>
        </article>
      </section>

      <section className="distribution-section inventory-section">
        <SectionHeading title="Sanitized inventory" note={`${inspection.inventory.length} exact entries · content omitted`} />
        <div className="distribution-table distribution-inventory-table" role="table" aria-label="Release inventory">
          <div className="distribution-table-head" role="row"><span role="columnheader">Path</span><span role="columnheader">Role</span><span role="columnheader">Mode</span><span role="columnheader">Bytes</span><span role="columnheader">Fingerprint</span></div>
          {inspection.inventory.map((entry) => (
            <div role="row" key={entry.path}><strong role="cell">{entry.path}</strong><span role="cell">{entry.role}</span><code role="cell">{entry.mode}</code><code role="cell">{entry.bytes}</code><code role="cell" title={entry.contentFingerprint}>{entry.contentFingerprint}</code></div>
          ))}
        </div>
      </section>

      <ConstraintLedger constraints={inspection.constraints} />

      <section className="distribution-section provenance-section">
        <SectionHeading title="Fingerprint-only provenance" note={inspection.provenance.reproducibilityClaim} />
        <div className="distribution-provenance-grid">
          <Measure label="Source kind" value={inspection.provenance.kind} />
          <Measure label="Revision" value={inspection.provenance.revision || 'unavailable'} />
          <Measure label="Exact input" value={inspection.provenance.exactInputState} />
          <Measure label="Remote locator" value={inspection.provenance.remoteLocatorFingerprint || 'unavailable'} />
          <Measure label="Package intent" value={packageIntentSummary(inspection.packageIntent)} />
          <Measure label="Input fingerprint" value={inspection.provenance.inputFingerprint} />
        </div>
      </section>

      <EvidenceReferences inspection={inspection} />
      <DistributionStopline
        bytesState={inspection.claims.localReleaseBytes}
        referenceState={inspection.claims.dependencyResolution}
        claims={inspection.claims}
        legal={inspection.legal}
        trust={inspection.trust}
        authority={inspection.authority}
        limitations={inspection.limitations}
        fingerprint={inspection.inspectionFingerprint}
      />
    </article>
  );
}

function BundleLedger({ inspection, onClear }: { inspection: BundleInspection; onClear: () => void }) {
  const bundle = inspection.bundle;
  return (
    <article className="distribution-ledger bundle-ledger" aria-label={`Bundle ${bundle.id}`}>
      <header className="distribution-ledger-header">
        <div>
          <span className="eyebrow">Transparent bundle · {bundle.target.hosts.join(' + ')}</span>
          <h2>{bundle.id}</h2>
          <p>{bundle.summary}</p>
        </div>
        <div className="distribution-ledger-status">
          <StateMark state={inspection.resolution.state === 'resolved' ? 'passed' : 'failed'} compact />
          <span>v{bundle.version} · {inspection.resolution.state}</span>
          <button type="button" onClick={onClear}>Clear bundle</button>
        </div>
      </header>

      <section className="distribution-measure-strip" aria-label="Bundle identity">
        <Measure label="Bundle digest" value={bundle.digest} accent />
        <Measure label="Catalog" value={inspection.resolution.catalogFingerprint} />
        <Measure label="Resolution" value={inspection.resolution.resolutionFingerprint} />
        <Measure label="Target" value={`${bundle.target.baseContract} · ${bundle.target.hosts.join(', ')}`} />
      </section>

      <section className={`bundle-resolution-band ${inspection.resolution.state}`}>
        <div><span className="eyebrow">Deterministic resolution</span><strong>{inspection.resolution.state}</strong><code>{inspection.resolution.reasonCode}</code></div>
        <StateMark state={inspection.resolution.state === 'resolved' ? 'passed' : 'failed'} />
      </section>

      {inspection.resolution.blockers.length > 0 && (
        <section className="distribution-section bundle-blockers">
          <SectionHeading title="Resolution blockers" note={`${inspection.resolution.blockers.length} stable finding${inspection.resolution.blockers.length === 1 ? '' : 's'}`} />
          {inspection.resolution.blockers.map((blocker, index) => (
            <article key={`${blocker.code}:${blocker.referenceId}:${index}`}><code>{blocker.code}</code><strong>{blocker.pack}</strong><p>{blocker.summary}</p></article>
          ))}
        </section>
      )}

      <section className="distribution-section bundle-references">
        <SectionHeading title="Reference resolution" note={`${inspection.references.length} declared references`} />
        {inspection.references.map((reference) => (
          <details key={reference.id} open={reference.state === 'blocked'}>
            <summary>
              <span><code>{reference.id}</code><strong>{reference.pack}</strong></span>
              <span>{reference.selection.kind} · {reference.selection.version}</span>
              <StateMark state={reference.state === 'selected' ? 'passed' : 'failed'} compact />
            </summary>
            <div>
              <p>{reference.reason}</p>
              {reference.selectedRelease ? (
                <div className="selected-release-card"><strong>{reference.selectedRelease.pack} v{reference.selectedRelease.version}</strong><code>{reference.selectedRelease.capsuleDigest}</code><span>{reference.selectedRelease.releaseStage} · {reference.selectedRelease.evidenceMaturity}</span></div>
              ) : <p className="distribution-unavailable">No local release was selected for this reference.</p>}
              {reference.compatibilityLimitations.map((limitation) => <small key={limitation}>{limitation}</small>)}
            </div>
          </details>
        ))}
      </section>

      <BundleAggregate inspection={inspection} />
      <DistributionStopline
        bytesState={inspection.claims.localBundleBytes}
        referenceState={inspection.claims.referencedReleaseBytes}
        claims={inspection.claims}
        legal={inspection.legal}
        trust={inspection.trust}
        authority={inspection.authority}
        limitations={inspection.limitations}
        fingerprint={inspection.inspectionFingerprint}
      />
    </article>
  );
}

function ConstraintLedger({ constraints }: { constraints: PackReleaseInspection['constraints'] }) {
  return (
    <section className="distribution-section constraint-section">
      <SectionHeading title="Declared constraint surface" note="Facts from the enclosed pack manifest" />
      <div className="constraint-quadrants">
        <FactList title="Dependencies" values={constraints.dependencies.map((item) => `${item.pack} ${item.version}${item.optional ? ' · optional' : ''}`)} empty="No dependencies declared" />
        <FactList title="Capabilities required" values={constraints.capabilities.requires.map((item) => `${item.id} ${item.version}`)} empty="No required capabilities" />
        <FactList title="Capabilities provided" values={constraints.capabilities.provides.map((item) => `${item.id} ${item.version}`)} empty="No provided capabilities" />
        <FactList title="Authorities" values={constraints.authorities.map((item) => `${item.role} · ${item.subject}${item.required ? ' · required' : ''}`)} empty="No authorities declared" />
        <FactList title="Effects" values={constraints.effects} empty="No effects declared" />
        <FactList title="Compatibility" values={[`base ${constraints.compatibility.baseContract}`, ...constraints.compatibility.hosts.map((host) => `host ${host}`)]} empty="No compatibility facts" />
      </div>
    </section>
  );
}

function EvidenceReferences({ inspection }: { inspection: PackReleaseInspection }) {
  return (
    <section className="distribution-section evidence-reference-section">
      <SectionHeading title="Referenced evidence" note={`${inspection.evidenceReferences.length} fingerprints · bodies excluded`} />
      {inspection.evidenceReferences.length ? inspection.evidenceReferences.map((evidence) => (
        <article key={evidence.id}><span><strong>{evidence.id}</strong><StateMark state={evidence.result} compact /></span><code>{evidence.fingerprint}</code><small>{evidence.privacyScope} · {evidence.validUntil || 'no expiry asserted'}</small></article>
      )) : <p className="distribution-unavailable">No evidence references were included in this release.</p>}
    </section>
  );
}

function BundleAggregate({ inspection }: { inspection: BundleInspection }) {
  const aggregate = inspection.aggregate;
  return (
    <section className="distribution-section aggregate-section">
      <SectionHeading title="Resolved aggregate" note="Selected release facts only" />
      <div className="constraint-quadrants">
        <FactList title="Packs" values={aggregate.packs} empty="No packs selected" />
        <FactList title="Dependencies" values={aggregate.dependencies.map((item) => `${item.consumer} → ${item.pack} ${item.version}${item.optional ? ' · optional' : ''}`)} empty="No dependency facts" />
        <FactList title="Authorities" values={aggregate.authorities} empty="No authorities selected" />
        <FactList title="Effects" values={aggregate.effects} empty="No effects selected" />
        <FactList title="Compatible hosts" values={aggregate.compatibleHosts} empty="No common compatible host" />
      </div>
    </section>
  );
}

function DistributionStopline({ bytesState, referenceState, claims, legal, trust, authority, limitations, fingerprint }: {
  bytesState: string;
  referenceState: string;
  claims: PackReleaseInspection['claims'] | BundleInspection['claims'];
  legal: DistributionLegalBoundary;
  trust: DistributionTrustBoundary;
  authority: PackReleaseInspection['authority'] | BundleInspection['authority'];
  limitations: Array<{ code: string; summary: string }>;
  fingerprint: string;
}) {
  const claimRows = [
    ['Local bytes', bytesState],
    ['Reference resolution', referenceState],
    ['Installed', claims.installed],
    ['Configured', claims.configured],
    ['Ready', claims.ready],
    ['Verified', claims.verified],
    ['Healthy', claims.healthy],
    ['Network', claims.networkAvailability]
  ];
  return (
    <section className="distribution-stopline" aria-label="Distribution claim boundary">
      <header><span className="eyebrow">Truth stopline</span><h3>Byte facts stop before trust and runtime claims.</h3><p>A verified local artifact is not an installed, configured, ready, verified, healthy, signed, licensed, or publishable system.</p></header>
      <div className="distribution-claim-grid">
        {claimRows.map(([label, state]) => <article key={label}><span>{label}</span><strong>{state}</strong><StateMark state={claimTone(state)} compact /></article>)}
      </div>
      <div className="distribution-nonclaims">
        <article><span className="eyebrow">Legal</span><strong>{legal.publisher.state} publisher · {legal.license.state} license</strong><p>Publication, redistribution, marketplace eligibility, and legal sufficiency are {legal.legalSufficiency}.</p></article>
        <article><span className="eyebrow">Trust</span><strong>{trust.state}</strong><p>Signature: {trust.signature}. Artifact selection does not establish trust.</p></article>
        <article><span className="eyebrow">Executable authority</span><strong>none</strong><p>{Object.keys(authority).map(humanize).join(' · ')} are all unavailable.</p></article>
      </div>
      <details className="distribution-limitations">
        <summary>{limitations.length} explicit limitation{limitations.length === 1 ? '' : 's'}</summary>
        {limitations.map((limitation) => <article key={limitation.code}><code>{limitation.code}</code><p>{limitation.summary}</p></article>)}
      </details>
      <footer><span>Inspection fingerprint</span><code>{fingerprint}</code></footer>
    </section>
  );
}

function FactList({ title, values, empty }: { title: string; values: string[]; empty: string }) {
  return <article><span className="eyebrow">{title}</span>{values.length ? <ul>{values.map((value) => <li key={value}><code>{value}</code></li>)}</ul> : <p>{empty}</p>}</article>;
}

function SectionHeading({ title, note }: { title: string; note: string }) {
  return <header className="distribution-section-heading"><h3>{title}</h3><span>{note}</span></header>;
}

function Measure({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className={accent ? 'accent' : ''}><span>{label}</span><code title={value}>{value}</code></div>;
}

function FingerprintLine({ label, value }: { label: string; value: string }) {
  return <p className="distribution-fingerprint-line"><span>{label}</span><code title={value}>{value}</code></p>;
}

function humanize(value: string) {
  return value.replaceAll(/([a-z])([A-Z])/g, '$1 $2').replaceAll('-', ' ');
}

function claimTone(state: string) {
  return state === 'passed' || state === 'resolved' ? 'passed' : state === 'failed' || state === 'blocked' ? 'failed' : 'unknown';
}

function packageIntentSummary(intent: PackReleaseInspection['packageIntent']) {
  if (intent.state === 'present') return `present · private ${intent.private ? 'true' : 'false'} · packaging intent only`;
  if (intent.state === 'absent') return 'absent · no package intent observed';
  return 'unavailable · no private-package claim';
}
