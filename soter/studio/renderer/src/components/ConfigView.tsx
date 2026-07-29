import { useEffect, useMemo, useState } from 'react';
import type { Configuration, ConfigurationPreview, EffectMode, InspectionSnapshot } from '../types';
import { ConfigurationTransactionDesk } from './ConfigurationTransactionDesk';
import { HostRealizationDesk } from './HostRealizationDesk';
import { StateMark } from './StateMark';

const effectOrder = ['read', 'disclosure', 'write', 'dispatch', 'destructive'] as const;

export function ConfigView({ snapshot, configuration }: {
  snapshot: InspectionSnapshot;
  configuration: Configuration;
}) {
  const currentHostAdapter = snapshot.catalog.find((item) => item.kind === 'host' && item.selected)?.id;
  const initialPolicies = useMemo(() => Object.fromEntries(configuration.effectPolicies.map((policy) => [policy.effect, policy.mode])) as Record<(typeof effectOrder)[number], EffectMode>, [configuration]);
  const [hostAdapter, setHostAdapter] = useState(currentHostAdapter || '');
  const [policies, setPolicies] = useState(initialPolicies);
  const [addPacks, setAddPacks] = useState<string[]>([]);
  const [preview, setPreview] = useState<ConfigurationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    window.soterStudio.previewConfiguration({
      name: configuration.name,
      configurationBasis: configuration.configurationBasis,
      draft: {
        hostAdapter,
        effectPolicies: policies,
        addPacks
      }
    }).then((next) => {
      if (!active) return;
      setPreview(next);
      setError(null);
    }).catch((reason) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [configuration.name, configuration.configurationBasis, hostAdapter, policies, addPacks]);

  const reset = () => {
    setHostAdapter(currentHostAdapter || '');
    setPolicies(initialPolicies);
    setAddPacks([]);
  };

  if (!preview && loading) return <div className="config-loading"><span className="eyebrow">Configuration preview</span><p>Resolving the exact candidate graph…</p></div>;
  if (!preview || error) return <div className="config-loading"><span className="eyebrow">Configuration preview failed</span><p>{error || 'No preview was returned.'}</p></div>;

  const changedRows = preview.changes.filter((item) => item.state === 'changed');
  const selectedPacks = preview.options.packs.filter((pack) => pack.selected);
  const availablePacks = preview.options.packs.filter((pack) => !pack.selected);

  return (
    <div className="config-view">
      <header className="view-intro config-intro">
        <div>
          <span className="eyebrow">Configure intent · preview only</span>
          <h1>{configuration.name}</h1>
          <code className="detail-identifier">{preview.configuration.sourcePath}</code>
        </div>
        <div className="config-intro-state">
          <StateMark state={preview.draft.valid ? preview.draft.changed ? 'changed' : 'current' : 'invalid'} />
          <span>Nothing is written</span>
        </div>
      </header>

      <section className="config-comparison" aria-label="Current and draft lock comparison">
        <div className="config-side current-side">
          <span className="eyebrow">Current exact lock</span>
          <strong>{preview.configuration.host}</strong>
          <code>{preview.configuration.lockFingerprint}</code>
          <small>{preview.configuration.graphFingerprint}</small>
        </div>
        <div className={`config-delta config-delta-${preview.evidenceImpact.state}`} aria-label={`${changedRows.length} changed fields`}>
          <span>{changedRows.length}</span>
          <i aria-hidden="true">→</i>
          <small>{changedRows.length === 1 ? 'change' : 'changes'}</small>
        </div>
        <div className="config-side draft-side">
          <span className="eyebrow">Candidate lock</span>
          <strong>{preview.draft.host}</strong>
          <code>{preview.draft.lockFingerprint || 'not resolved'}</code>
          <small>{preview.draft.graphFingerprint || 'draft diagnostics block resolution'}</small>
        </div>
      </section>

      <div className="config-workbench">
        <section className="config-controls-sheet">
          <div className="sheet-heading">
            <div><span className="eyebrow">Draft controls</span><h2>Host and effect boundary</h2></div>
            <button onClick={reset} disabled={!preview.draft.changed}>Reset draft</button>
          </div>
          <label className="config-host-control">
            <span>Host projection</span>
            <select aria-label="Host projection" value={hostAdapter} onChange={(event) => setHostAdapter(event.target.value)}>
              {preview.options.hosts.map((host) => (
                <option key={host.adapter} value={host.adapter} disabled={!host.compatible}>
                  {host.adapter} · v{host.version}{host.compatible ? '' : ' · incompatible'}
                </option>
              ))}
            </select>
            <small>Changing host changes its adapter fingerprint and projected files.</small>
          </label>
          <div className="config-policy-controls">
            {effectOrder.map((effect) => {
              const current = configuration.effectPolicies.find((policy) => policy.effect === effect)!;
              return (
                <label key={effect}>
                  <span><strong>{effect}</strong><small>current · {current.mode}</small></span>
                  <select aria-label={`${effect} effect policy`} value={policies[effect]} onChange={(event) => setPolicies((value) => ({ ...value, [effect]: event.target.value as EffectMode }))}>
                    {preview.options.effectModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                  </select>
                </label>
              );
            })}
          </div>
          {loading && <div className="config-measuring" role="status">Recalculating exact impact…</div>}
        </section>

        <section className="config-impact-sheet">
          <div className="sheet-heading">
            <div><span className="eyebrow">Exact diff</span><h2>Changed configuration fields</h2></div>
            <code>{changedRows.length}/{preview.changes.length}</code>
          </div>
          <div className="config-diff-header"><span>Field</span><span>Current</span><span>Candidate</span></div>
          {preview.changes.map((change) => (
            <article className={`config-diff-row ${change.state}`} key={`${change.category}:${change.subject}`}>
              <div><code>{change.subject}</code><small>{change.impact}</small></div>
              <strong>{change.before}</strong>
              <strong>{change.after}</strong>
            </article>
          ))}
        </section>
      </div>

      <section className="config-pack-register">
        <div className="sheet-heading">
          <div><span className="eyebrow">Resolved selection</span><h2>Packs in this configuration</h2></div>
          <code>{selectedPacks.length} selected · {availablePacks.length} available</code>
        </div>
        <div className="config-pack-grid">
          {selectedPacks.map((pack) => (
            <article key={pack.id}>
              <span className="pack-layer">{pack.layer}{pack.base ? ' · base' : ' · selected'}</span>
              <strong>{pack.id}</strong>
              <code>v{pack.version}</code>
              <small>{pack.effects.length ? pack.effects.join(' · ') : 'no declared effects'}</small>
            </article>
          ))}
        </div>
        {availablePacks.length > 0 && (
          <div className="config-option-ledger" aria-label="Available optional packs">
            <div className="config-option-heading">
              <span className="eyebrow">Available systems</span>
              <p>Previewing a selection changes only the in-memory candidate lock.</p>
            </div>
            {availablePacks.map((pack) => {
              const added = addPacks.includes(pack.id);
              return (
                <article className={added ? 'is-added' : ''} key={pack.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={added}
                      disabled={!pack.selectable}
                      onChange={(event) => setAddPacks((value) => event.target.checked
                        ? [...value, pack.id].sort()
                        : value.filter((id) => id !== pack.id))}
                    />
                    <span className="pack-choice-mark" aria-hidden="true" />
                    <span>
                      <strong>{pack.id}</strong>
                      <small>{pack.summary}</small>
                    </span>
                  </label>
                  <div className="pack-option-facts">
                    <span><b>{pack.scenarioCount}</b> declared scenarios</span>
                    <span><b>{pack.requiredCapabilities.length}</b> capabilities</span>
                    <span><b>{pack.effects.length}</b> effects</span>
                  </div>
                  <div className="pack-option-requires">
                    {pack.requiredCapabilities.map((capability) => <code key={capability}>{capability}</code>)}
                  </div>
                  <StateMark state={added ? 'changed' : 'available'} compact />
                </article>
              );
            })}
          </div>
        )}
        {!availablePacks.length && <p className="config-no-options">Every catalog pack is already selected.</p>}
      </section>

      <section className={`config-evidence-impact impact-${preview.evidenceImpact.state}`}>
        <div>
          <span className="eyebrow">Evidence applicability</span>
          <h2>{preview.evidenceImpact.state}</h2>
          <p>{preview.evidenceImpact.reason}</p>
        </div>
        <StateMark state={preview.evidenceImpact.state} />
        <div className="config-apply-boundary">
          <span className="eyebrow">Preview boundary</span>
          <strong>Separate transaction</strong>
          <p>{preview.apply.reason}</p>
        </div>
      </section>

      {preview.diagnostics.length > 0 && (
        <section className="config-diagnostics">
          {preview.diagnostics.map((item) => (
            <article key={`${item.code}:${item.subject}`}>
              <code>{item.code}</code><strong>{item.subject}</strong><p>{item.message}</p><small>{item.remediation}</small>
            </article>
          ))}
        </section>
      )}

      <ConfigurationTransactionDesk configuration={configuration} />
      <HostRealizationDesk configuration={configuration} />
    </div>
  );
}
