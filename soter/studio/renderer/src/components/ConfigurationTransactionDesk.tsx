import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Configuration,
  ConfigurationChangeInspection,
  ConfigurationChangeReferences,
  ConfigurationChangeResult,
  ConfigurationOnboardingDescription,
  ConfigurationOnboardingInputField,
  ConfigurationOnboardingInputSlot,
  ConfigurationOnboardingProviderMappingScope,
  ConfigurationOnboardingProviderMappingScopeInput,
  ConfigurationOnboardingRecordField,
  ConfigurationOnboardingSlot
} from '../types';
import { StateMark } from './StateMark';

const requestReason = 'Review this exact private configuration activation or update and its fingerprint-only scope.';
const unavailableMessage = 'The local configuration transaction adapter is unavailable.';
const onboardingDescriptionUnavailable = 'The blank typed private onboarding description is unavailable.';
const onboardingPlanUnavailable = 'The exact private onboarding plan is unavailable.';
const configurationCode = /^CONFIGURATION_[A-Z0-9_]+$/;

type PrimitiveDraft = string | number | boolean | string[] | null;

interface FieldDraft {
  included: boolean;
  value: PrimitiveDraft;
}

interface ProviderScopeDraft {
  state: 'mapped' | 'unavailable';
  providerProperty: string;
  options: Array<{ portable: string; provider: string }>;
}

interface SlotDraft {
  included: boolean;
  value: PrimitiveDraft;
  fields: FieldDraft[];
  records: FieldDraft[][];
  scopes: ProviderScopeDraft[];
}

function fingerprint(value: string | null) {
  return value || 'unavailable';
}

function stableConfigurationCode(value: unknown) {
  return typeof value === 'string' && configurationCode.test(value)
    ? value
    : 'CONFIGURATION_ADAPTER_UNAVAILABLE';
}

function stageState(inspection: ConfigurationChangeInspection | null, stage: 'plan' | 'request' | 'confirmation' | 'consumption' | 'checkpoint') {
  if (!inspection) return stage === 'plan' ? 'current' : 'pending';
  if (stage === 'plan') return inspection.configuration.applicability;
  if (stage === 'request') return inspection.request?.state || 'current';
  if (stage === 'confirmation') return inspection.confirmation ? 'confirmed' : inspection.request ? 'current' : 'pending';
  if (stage === 'consumption') return inspection.consumption?.state || (inspection.confirmation ? 'current' : 'pending');
  return inspection.checkpoint?.state || (inspection.consumption ? 'current' : 'pending');
}

function humanize(value: string) {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim();
  if (!words) return 'Field';
  return words
    .split(/\s+/)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (lower === 'uri') return 'URI';
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

function slotLabel(slot: ConfigurationOnboardingSlot) {
  return humanize(slot.field) + ' — ' + humanize(slot.subject);
}

function scopeLabel(scope: ConfigurationOnboardingProviderMappingScope) {
  return humanize(scope.record.type) + ' · ' + humanize(scope.field.id);
}

function emptyValue(type: ConfigurationOnboardingRecordField['type'] | ConfigurationOnboardingSlot['type']): PrimitiveDraft {
  if (type === 'boolean') return false;
  if (type === 'integer') return null;
  if (type === 'string-list') return [];
  return '';
}

function effectiveCollectionMinimum(constraints: { minItems?: number }) {
  return Math.max(1, constraints.minItems || 0);
}

function effectiveStringMinimum(constraints: { minLength?: number }) {
  return Math.max(1, constraints.minLength || 0);
}

function includedFieldValue(field: ConfigurationOnboardingRecordField): PrimitiveDraft {
  if (field.type === 'string-list') {
    return Array.from({ length: effectiveCollectionMinimum(field.constraints) }, () => '');
  }
  return emptyValue(field.type);
}

function emptyFieldDraft(field: ConfigurationOnboardingRecordField): FieldDraft {
  return {
    included: field.required,
    value: field.required ? includedFieldValue(field) : emptyValue(field.type)
  };
}

function emptyProviderScopeDraft(scope: ConfigurationOnboardingProviderMappingScope): ProviderScopeDraft {
  return {
    state: scope.field.required ? 'mapped' : 'unavailable',
    providerProperty: '',
    options: scope.field.optionMappingRequired ? [{ portable: '', provider: '' }] : []
  };
}

function emptySlotDraft(slot: ConfigurationOnboardingSlot): SlotDraft {
  const minimumRecords = slot.type === 'records'
    ? effectiveCollectionMinimum(slot.constraints)
    : 0;
  return {
    included: slot.required,
    value: slot.type === 'string-list' && slot.required
      ? Array.from({ length: effectiveCollectionMinimum(slot.constraints) }, () => '')
      : emptyValue(slot.type),
    fields: 'fields' in slot ? slot.fields.map(emptyFieldDraft) : [],
    records: slot.type === 'records' && slot.required
      ? Array.from({ length: minimumRecords }, () => slot.fields.map(emptyFieldDraft))
      : [],
    scopes: slot.type === 'provider-mapping-set'
      ? slot.scopes.map(emptyProviderScopeDraft)
      : []
  };
}

function fieldReady(field: ConfigurationOnboardingRecordField, draft: FieldDraft) {
  if (!draft.included) return !field.required;
  if (field.type === 'boolean') return typeof draft.value === 'boolean';
  if (field.type === 'integer') {
    return typeof draft.value === 'number'
      && Number.isSafeInteger(draft.value)
      && draft.value >= field.constraints.minimum
      && draft.value <= field.constraints.maximum;
  }
  if (field.type === 'string-list') {
    if (!Array.isArray(draft.value)) return false;
    const minimum = effectiveCollectionMinimum(field.constraints);
    if (draft.value.length < minimum || draft.value.length > field.constraints.maxItems) return false;
    if (field.constraints.uniqueItems && new Set(draft.value).size !== draft.value.length) return false;
    return draft.value.every((value) => value.length >= effectiveStringMinimum(field.itemConstraints)
      && value.length <= field.itemConstraints.maxLength);
  }
  if (typeof draft.value !== 'string'
    || draft.value.length < ('constraints' in field ? field.constraints.minLength || 1 : 1)
    || draft.value.length > ('constraints' in field ? field.constraints.maxLength : 4096)) {
    return false;
  }
  return field.type !== 'enum' || field.options.includes(draft.value);
}

function scalarSlotReady(slot: Exclude<ConfigurationOnboardingSlot, { type: 'records' | 'group' | 'provider-mapping-set' }>, draft: SlotDraft) {
  return fieldReady({
    id: slot.id,
    field: slot.field,
    required: slot.required,
    type: slot.type,
    ...('constraints' in slot ? { constraints: slot.constraints } : {}),
    ...('itemType' in slot ? { itemType: slot.itemType, itemConstraints: slot.itemConstraints } : {}),
    ...('options' in slot ? { options: slot.options } : {})
  } as ConfigurationOnboardingRecordField, {
    included: draft.included,
    value: draft.value
  });
}

function activeMappingScope(
  scope: ConfigurationOnboardingProviderMappingScope,
  description: ConfigurationOnboardingDescription,
  drafts: SlotDraft[]
) {
  const targetIndex = description.slots.findIndex((slot) => (
    slot.subject === scope.activation.subject && slot.field === scope.activation.target
  ));
  return targetIndex >= 0 && Boolean(drafts[targetIndex]?.included);
}

function providerScopeReady(scope: ConfigurationOnboardingProviderMappingScope, draft: ProviderScopeDraft) {
  if (draft.state === 'unavailable') return !scope.field.required;
  if (!draft.providerProperty) return false;
  if (!scope.field.optionMappingRequired && draft.options.length === 0) return true;
  return draft.options.length > 0
    && draft.options.every((option) => Boolean(option.portable) && Boolean(option.provider));
}

function slotReady(
  slot: ConfigurationOnboardingSlot,
  draft: SlotDraft,
  description: ConfigurationOnboardingDescription,
  drafts: SlotDraft[]
) {
  if (!draft.included) return !slot.required;
  if (slot.type === 'group') {
    return slot.fields.every((field, index) => fieldReady(field, draft.fields[index]));
  }
  if (slot.type === 'records') {
    const minimum = effectiveCollectionMinimum(slot.constraints);
    return draft.records.length >= minimum
      && draft.records.length <= slot.constraints.maxItems
      && draft.records.every((record) => slot.fields.every((field, index) => fieldReady(field, record[index])));
  }
  if (slot.type === 'provider-mapping-set') {
    return slot.scopes.every((scope, index) => (
      !activeMappingScope(scope, description, drafts)
      || providerScopeReady(scope, draft.scopes[index])
    ));
  }
  return scalarSlotReady(slot, draft);
}

function fieldInput(field: ConfigurationOnboardingRecordField, draft: FieldDraft): ConfigurationOnboardingInputField {
  if (!draft.included) return { id: field.id, state: 'omitted' };
  if (field.type === 'boolean') {
    return { id: field.id, state: 'provided', type: 'boolean', value: Boolean(draft.value) };
  }
  if (field.type === 'integer') {
    return { id: field.id, state: 'provided', type: 'integer', value: Number(draft.value) };
  }
  if (field.type === 'string-list') {
    return { id: field.id, state: 'provided', type: 'string-list', value: draft.value as string[] };
  }
  return { id: field.id, state: 'provided', type: field.type, value: String(draft.value) };
}

function slotInput(
  slot: ConfigurationOnboardingSlot,
  draft: SlotDraft,
  description: ConfigurationOnboardingDescription,
  drafts: SlotDraft[]
): ConfigurationOnboardingInputSlot {
  if (!draft.included) return { id: slot.id, state: 'omitted' };
  if (slot.type === 'group') {
    return {
      id: slot.id,
      state: 'provided',
      type: 'group',
      value: { fields: slot.fields.map((field, index) => fieldInput(field, draft.fields[index])) }
    };
  }
  if (slot.type === 'records') {
    return {
      id: slot.id,
      state: 'provided',
      type: 'records',
      value: draft.records.map((record) => ({
        fields: slot.fields.map((field, index) => fieldInput(field, record[index]))
      }))
    };
  }
  if (slot.type === 'provider-mapping-set') {
    const scopes: ConfigurationOnboardingProviderMappingScopeInput[] = [];
    slot.scopes.forEach((scope, index) => {
      if (!activeMappingScope(scope, description, drafts)) return;
      const value = draft.scopes[index];
      if (value.state === 'unavailable') {
        scopes.push({ id: scope.id, scopeFingerprint: scope.scopeFingerprint, state: 'unavailable' });
        return;
      }
      scopes.push({
        id: scope.id,
        scopeFingerprint: scope.scopeFingerprint,
        state: 'mapped',
        providerProperty: value.providerProperty,
        ...(value.options.length ? { options: value.options } : {})
      });
    });
    return {
      id: slot.id,
      state: 'provided',
      type: 'provider-mapping-set',
      value: { mappingSetFingerprint: slot.mappingSetFingerprint, scopes }
    };
  }
  return fieldInput({
    id: slot.id,
    field: slot.field,
    required: slot.required,
    type: slot.type,
    ...('constraints' in slot ? { constraints: slot.constraints } : {}),
    ...('itemType' in slot ? { itemType: slot.itemType, itemConstraints: slot.itemConstraints } : {}),
    ...('options' in slot ? { options: slot.options } : {})
  } as ConfigurationOnboardingRecordField, {
    included: draft.included,
    value: draft.value
  });
}

function OptionalToggle({
  checked,
  label,
  onChange
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="configuration-onboarding-inclusion">
      <input type="checkbox" autoComplete="off" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>Include {label}</span>
    </label>
  );
}

function FieldControl({
  field,
  draft,
  idPrefix,
  context,
  onChange
}: {
  field: ConfigurationOnboardingRecordField;
  draft: FieldDraft;
  idPrefix: string;
  context: string;
  onChange: (draft: FieldDraft) => void;
}) {
  const label = humanize(field.field) + ' — ' + context;
  const reset = (included: boolean) => onChange(included
    ? { included: true, value: includedFieldValue(field) }
    : emptyFieldDraft({ ...field, required: false } as ConfigurationOnboardingRecordField));
  const inputId = idPrefix + '-value';
  return (
    <div className="configuration-onboarding-field">
      {!field.required && <OptionalToggle checked={draft.included} label={label} onChange={reset} />}
      {field.required && <span className="configuration-onboarding-required">Required · {label}</span>}
      {draft.included && field.type === 'boolean' && (
        <label htmlFor={inputId} className="configuration-onboarding-boolean">
          <input id={inputId} type="checkbox" autoComplete="off" checked={Boolean(draft.value)} onChange={(event) => onChange({ ...draft, value: event.target.checked })} />
          <span>{label}</span>
        </label>
      )}
      {draft.included && field.type === 'enum' && (
        <label htmlFor={inputId}><span>{label}</span><select id={inputId} autoComplete="off" value={String(draft.value || '')} onChange={(event) => onChange({ ...draft, value: event.target.value })}><option value="">Select one</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
      )}
      {draft.included && field.type === 'integer' && (
        <label htmlFor={inputId}><span>{label}</span><input id={inputId} type="number" autoComplete="off" min={field.constraints.minimum} max={field.constraints.maximum} value={typeof draft.value === 'number' ? draft.value : ''} onChange={(event) => onChange({ ...draft, value: event.target.value === '' ? null : Number(event.target.value) })} /></label>
      )}
      {draft.included && field.type === 'string-list' && (
        <fieldset className="configuration-onboarding-list">
          <legend>{label}</legend>
          {(draft.value as string[]).map((value, index) => (
            <div key={index}>
              <label htmlFor={idPrefix + '-item-' + index}><span>Item {index + 1}</span><input id={idPrefix + '-item-' + index} type={field.itemType === 'email' ? 'email' : field.itemType === 'date' ? 'date' : 'text'} autoComplete="off" minLength={effectiveStringMinimum(field.itemConstraints)} value={value} onChange={(event) => onChange({ ...draft, value: (draft.value as string[]).map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} /></label>
              <button type="button" disabled={(draft.value as string[]).length <= effectiveCollectionMinimum(field.constraints)} onClick={() => onChange({ ...draft, value: (draft.value as string[]).filter((_item, itemIndex) => itemIndex !== index) })}>Remove item {index + 1}</button>
            </div>
          ))}
          <button type="button" disabled={(draft.value as string[]).length >= field.constraints.maxItems} onClick={() => onChange({ ...draft, value: [...(draft.value as string[]), ''] })}>Add list item</button>
        </fieldset>
      )}
      {draft.included && (field.type === 'string'
        || field.type === 'uri'
        || field.type === 'email'
        || field.type === 'date'
        || field.type === 'date-time') && (
        <label htmlFor={inputId}><span>{label}</span><input id={inputId} type={field.type === 'email' ? 'email' : field.type === 'date' ? 'date' : 'text'} autoComplete="off" inputMode={field.type === 'uri' ? 'url' : undefined} maxLength={field.constraints.maxLength} value={String(draft.value || '')} onChange={(event) => onChange({ ...draft, value: event.target.value })} /></label>
      )}
    </div>
  );
}

export function ConfigurationTransactionDesk({ configuration }: { configuration: Configuration }) {
  const [description, setDescription] = useState<ConfigurationOnboardingDescription | null>(null);
  const [drafts, setDrafts] = useState<SlotDraft[]>([]);
  const [descriptionLoading, setDescriptionLoading] = useState(true);
  const [inspection, setInspection] = useState<ConfigurationChangeInspection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [confirmationAcknowledged, setConfirmationAcknowledged] = useState(false);
  const [applyAcknowledged, setApplyAcknowledged] = useState(false);
  const [references, setReferences] = useState<ConfigurationChangeReferences>({ planId: '' });
  const submitting = useRef(false);
  const descriptionGeneration = useRef(0);

  const loadOnboardingDescription = useCallback(async (preserveError = false) => {
    const generation = ++descriptionGeneration.current;
    setDescription(null);
    setDrafts([]);
    setDescriptionLoading(true);
    if (!preserveError) setError(null);
    try {
      const result = await window.soterStudio.describeConfigurationOnboarding({ name: configuration.name });
      if (generation !== descriptionGeneration.current) return;
      if (!result.ok) {
        setError({ code: stableConfigurationCode(result.error.code), message: onboardingDescriptionUnavailable });
        return;
      }
      setDescription(result.description);
      setDrafts(result.description.slots.map(emptySlotDraft));
    } catch {
      if (generation === descriptionGeneration.current) {
        setError({ code: 'CONFIGURATION_ADAPTER_UNAVAILABLE', message: onboardingDescriptionUnavailable });
      }
    } finally {
      if (generation === descriptionGeneration.current) setDescriptionLoading(false);
    }
  }, [configuration.name]);

  useEffect(() => {
    setInspection(null);
    setError(null);
    setBusy(null);
    setConfirmationAcknowledged(false);
    setApplyAcknowledged(false);
    setReferences({ planId: '' });
    submitting.current = false;
    void loadOnboardingDescription();
    return () => {
      descriptionGeneration.current += 1;
      submitting.current = false;
    };
  }, [configuration.name, loadOnboardingDescription]);

  const allSlotsReady = useMemo(() => Boolean(description)
    && description!.slots.every((slot, index) => slotReady(slot, drafts[index], description!, drafts)), [description, drafts]);

  const updateSlot = (index: number, update: (draft: SlotDraft) => SlotDraft) => {
    setDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? update(draft) : draft));
  };

  const settle = async (label: string, operation: () => Promise<ConfigurationChangeResult>) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(label);
    setError(null);
    try {
      const result = await operation();
      if (!result.ok) {
        setError({ code: stableConfigurationCode(result.error.code), message: result.error.message });
        return;
      }
      setInspection(result.inspection);
      setReferences({
        planId: result.inspection.plan.id,
        requestId: result.inspection.request?.id,
        confirmationId: result.inspection.confirmation?.id,
        checkpointId: result.inspection.checkpoint?.id
      });
    } catch {
      setError({ code: 'CONFIGURATION_ADAPTER_UNAVAILABLE', message: unavailableMessage });
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  };

  const sealOnboardingPlan = async () => {
    if (!description || !allSlotsReady || submitting.current) return;
    submitting.current = true;
    setBusy('plan');
    setError(null);
    try {
      const slots = description.slots.map((slot, index) => slotInput(slot, drafts[index], description, drafts));
      const result = await window.soterStudio.prepareConfigurationOnboarding({
        name: configuration.name,
        descriptionFingerprint: description.descriptionFingerprint,
        slots
      });
      if (!result.ok) {
        const code = stableConfigurationCode(result.error.code);
        setError({ code, message: onboardingPlanUnavailable });
        void loadOnboardingDescription(true);
        return;
      }
      setDrafts([]);
      setDescription(null);
      setInspection(result.inspection);
      setReferences({ planId: result.inspection.plan.id });
    } catch {
      setError({ code: 'CONFIGURATION_ADAPTER_UNAVAILABLE', message: onboardingPlanUnavailable });
      void loadOnboardingDescription(true);
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  };

  const canRequest = inspection?.configuration.applicability === 'current'
    && inspection.request === null
    && inspection.resume.classification === 'safe';
  const canConfirm = inspection?.request?.state === 'awaiting'
    && inspection.confirmation === null
    && inspection.resume.classification === 'safe';
  const canStart = inspection?.confirmation !== null
    && inspection?.consumption === null
    && inspection?.checkpoint === null
    && inspection?.resume.classification === 'safe';
  const canResumeStart = inspection?.confirmation !== null
    && inspection?.consumption?.state === 'reserved'
    && inspection?.resume.classification === 'safe'
    && inspection?.resume.permittedNextAction === 'resume-start'
    && Boolean(inspection?.consumption.checkpointId);
  const canExecute = inspection?.consumption?.state === 'started'
    && inspection?.checkpoint?.state === 'prepared';
  const canRecover = inspection?.checkpoint !== null
    && ['applying', 'verifying', 'rolling-back'].includes(inspection?.checkpoint?.state || '');

  return (
    <section className="configuration-transaction" aria-labelledby="configuration-transaction-title">
      <header className="configuration-transaction-header">
        <div>
          <span className="eyebrow">Configure intent · local transaction</span>
          <h2 id="configuration-transaction-title">Exact lock transfer</h2>
          <p>First-use values stay inside this selected form until Core seals one sanitized plan. Preview controls never become apply authority.</p>
        </div>
        <div className="configuration-boundary-stamps" aria-label="Configuration transaction boundaries">
          <span>Local files only</span><span>No provider calls</span><span>No proof promotion</span>
        </div>
      </header>

      <ol className="configuration-transaction-spine" aria-label="Configuration transaction lifecycle">
        {([
          ['01', 'Plan', 'Typed private slots'],
          ['02', 'Request', 'Expiring window'],
          ['03', 'Confirm', 'Actor decision'],
          ['04', 'Consume', 'One-time start'],
          ['05', 'Checkpoint', 'Apply or recover']
        ] as const).map(([number, label, note], index) => {
          const stage = (['plan', 'request', 'confirmation', 'consumption', 'checkpoint'] as const)[index];
          const state = stageState(inspection, stage);
          return <li key={stage} className={'transaction-stage stage-' + state}><span>{number}</span><strong>{label}</strong><small>{note}</small><code>{state}</code></li>;
        })}
      </ol>

      {!inspection ? (
        <div className="configuration-candidate-workbench">
          <div className="configuration-candidate-editor">
            <div className="configuration-onboarding-heading">
              <div><span>Blank private setup</span><small>Exact ordered fields from the selected portable template</small></div>
              {description && <code>{description.slots.length} slots</code>}
            </div>
            {descriptionLoading && <div className="configuration-onboarding-empty" role="status">Loading blank typed fields…</div>}
            {!descriptionLoading && !description && <div className="configuration-onboarding-empty" role="status">No private fields are mounted. Follow the coded boundary below.</div>}
            {description && (
              <form className="configuration-onboarding-form" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void sealOnboardingPlan(); }}>
                {description.slots.map((slot, slotIndex) => {
                  const draft = drafts[slotIndex];
                  const context = humanize(slot.subject);
                  const prefix = 'configuration-onboarding-' + slotIndex;
                  if (!draft) return null;
                  if (slot.type === 'provider-mapping-set') {
                    const activeScopes = slot.scopes.map((scope, scopeIndex) => ({ scope, scopeIndex }))
                      .filter(({ scope }) => activeMappingScope(scope, description, drafts));
                    return (
                      <fieldset key={slot.id} className="configuration-onboarding-slot configuration-onboarding-mappings">
                        <legend>Portable field mappings</legend>
                        <p>Only scopes activated by included targets are requested. Internal mapping and target identities stay out of labels.</p>
                        {activeScopes.map(({ scope, scopeIndex }, activeIndex) => {
                          const scopeDraft = draft.scopes[scopeIndex];
                          const label = scopeLabel(scope);
                          const scopePrefix = prefix + '-scope-' + activeIndex;
                          return (
                            <fieldset key={scope.id} className="configuration-onboarding-mapping">
                              <legend>{label}</legend>
                              <label htmlFor={scopePrefix + '-state'}><span>Mapping mode — {label}</span><select id={scopePrefix + '-state'} autoComplete="off" value={scopeDraft.state} onChange={(event) => updateSlot(slotIndex, (current) => ({ ...current, scopes: current.scopes.map((item, index) => index === scopeIndex ? { ...item, state: event.target.value as 'mapped' | 'unavailable', providerProperty: '', options: scope.field.optionMappingRequired ? [{ portable: '', provider: '' }] : [] } : item) }))}><option value="mapped">Mapped</option><option value="unavailable" disabled={scope.field.required}>Unavailable</option></select></label>
                              {scopeDraft.state === 'mapped' && (
                                <>
                                  <label htmlFor={scopePrefix + '-property'}><span>Provider property — {label}</span><input id={scopePrefix + '-property'} autoComplete="off" value={scopeDraft.providerProperty} onChange={(event) => updateSlot(slotIndex, (current) => ({ ...current, scopes: current.scopes.map((item, index) => index === scopeIndex ? { ...item, providerProperty: event.target.value } : item) }))} /></label>
                                  {(scope.field.optionMappingRequired || scopeDraft.options.length > 0) && <div className="configuration-onboarding-options">
                                    {scopeDraft.options.map((option, optionIndex) => (
                                      <fieldset key={optionIndex}>
                                        <legend>Option pair {optionIndex + 1} — {label}</legend>
                                        <label htmlFor={scopePrefix + '-portable-' + optionIndex}><span>Portable option</span><input id={scopePrefix + '-portable-' + optionIndex} autoComplete="off" value={option.portable} onChange={(event) => updateSlot(slotIndex, (current) => ({ ...current, scopes: current.scopes.map((item, index) => index === scopeIndex ? { ...item, options: item.options.map((pair, pairIndex) => pairIndex === optionIndex ? { ...pair, portable: event.target.value } : pair) } : item) }))} /></label>
                                        <label htmlFor={scopePrefix + '-provider-' + optionIndex}><span>Provider option</span><input id={scopePrefix + '-provider-' + optionIndex} autoComplete="off" value={option.provider} onChange={(event) => updateSlot(slotIndex, (current) => ({ ...current, scopes: current.scopes.map((item, index) => index === scopeIndex ? { ...item, options: item.options.map((pair, pairIndex) => pairIndex === optionIndex ? { ...pair, provider: event.target.value } : pair) } : item) }))} /></label>
                                        <button type="button" onClick={() => updateSlot(slotIndex, (current) => ({ ...current, scopes: current.scopes.map((item, index) => index === scopeIndex ? { ...item, options: item.options.filter((_pair, pairIndex) => pairIndex !== optionIndex) } : item) }))}>Remove option pair {optionIndex + 1}</button>
                                      </fieldset>
                                    ))}
                                    <button type="button" onClick={() => updateSlot(slotIndex, (current) => ({ ...current, scopes: current.scopes.map((item, index) => index === scopeIndex ? { ...item, options: [...item.options, { portable: '', provider: '' }] } : item) }))}>Add option pair</button>
                                  </div>}
                                </>
                              )}
                            </fieldset>
                          );
                        })}
                        {!activeScopes.length && <p>No portable mapping scope is active until its exact target is included.</p>}
                      </fieldset>
                    );
                  }
                  if (slot.type === 'group') {
                    return (
                      <fieldset key={slot.id} className="configuration-onboarding-slot">
                        <legend>{slotLabel(slot)}</legend>
                        <OptionalToggle checked={draft.included} label={slotLabel(slot)} onChange={(included) => updateSlot(slotIndex, () => included ? { ...emptySlotDraft(slot), included: true } : emptySlotDraft(slot))} />
                        {draft.included && <div className="configuration-onboarding-group">{slot.fields.map((field, fieldIndex) => <FieldControl key={field.id} field={field} draft={draft.fields[fieldIndex]} idPrefix={prefix + '-field-' + fieldIndex} context={humanize(slot.field)} onChange={(value) => updateSlot(slotIndex, (current) => ({ ...current, fields: current.fields.map((item, index) => index === fieldIndex ? value : item) }))} />)}</div>}
                      </fieldset>
                    );
                  }
                  if (slot.type === 'records') {
                    return (
                      <fieldset key={slot.id} className="configuration-onboarding-slot">
                        <legend>{slotLabel(slot)}</legend>
                        {!slot.required && <OptionalToggle checked={draft.included} label={slotLabel(slot)} onChange={(included) => updateSlot(slotIndex, () => {
                          if (!included) return emptySlotDraft(slot);
                          const next = emptySlotDraft(slot);
                          return {
                            ...next,
                            included: true,
                            records: Array.from({ length: effectiveCollectionMinimum(slot.constraints) }, () => slot.fields.map(emptyFieldDraft))
                          };
                        })} />}
                        {draft.included && <div className="configuration-onboarding-records">{draft.records.map((record, recordIndex) => (
                          <fieldset key={recordIndex}>
                            <legend>{humanize(slot.field)} record {recordIndex + 1}</legend>
                            {slot.fields.map((field, fieldIndex) => <FieldControl key={field.id} field={field} draft={record[fieldIndex]} idPrefix={prefix + '-record-' + recordIndex + '-field-' + fieldIndex} context={humanize(slot.field) + ' record ' + (recordIndex + 1)} onChange={(value) => updateSlot(slotIndex, (current) => ({ ...current, records: current.records.map((item, index) => index === recordIndex ? item.map((fieldDraft, draftIndex) => draftIndex === fieldIndex ? value : fieldDraft) : item) }))} />)}
                            <button type="button" disabled={draft.records.length <= effectiveCollectionMinimum(slot.constraints)} onClick={() => updateSlot(slotIndex, (current) => ({ ...current, records: current.records.filter((_item, index) => index !== recordIndex) }))}>Remove record {recordIndex + 1}</button>
                          </fieldset>
                        ))}<button type="button" disabled={draft.records.length >= slot.constraints.maxItems} onClick={() => updateSlot(slotIndex, (current) => ({ ...current, records: [...current.records, slot.fields.map(emptyFieldDraft)] }))}>Add record</button></div>}
                      </fieldset>
                    );
                  }
                  const field = {
                    id: slot.id,
                    field: slot.field,
                    required: slot.required,
                    type: slot.type,
                    ...('constraints' in slot ? { constraints: slot.constraints } : {}),
                    ...('itemType' in slot ? { itemType: slot.itemType, itemConstraints: slot.itemConstraints } : {}),
                    ...('options' in slot ? { options: slot.options } : {})
                  } as ConfigurationOnboardingRecordField;
                  return (
                    <fieldset key={slot.id} className="configuration-onboarding-slot">
                      <legend>{slotLabel(slot)}</legend>
                      <FieldControl field={field} draft={{ included: draft.included, value: draft.value }} idPrefix={prefix} context={context} onChange={(value) => updateSlot(slotIndex, (current) => ({ ...current, included: value.included, value: value.value }))} />
                    </fieldset>
                  );
                })}
                <div className={'configuration-candidate-status ' + (allSlotsReady ? 'is-ready' : 'is-invalid')} role="status"><span aria-hidden="true">{allSlotsReady ? '◆' : '◇'}</span><p>{allSlotsReady ? 'Every required typed field is locally complete. Core still owns exact validation.' : 'Complete every required field and active mapping before sealing.'}</p></div>
                <button className="configuration-primary-action" type="submit" disabled={!allSlotsReady || busy !== null}>{busy === 'plan' ? 'Sealing exact plan…' : 'Seal first-use plan'}</button>
              </form>
            )}
          </div>
          <aside className="configuration-candidate-boundary">
            <span className="eyebrow">Private field boundary</span><h3>One mount, one sealed plan</h3>
            <p>Values remain in this selected form, cross one sender-validated local IPC request, and are removed as soon as Core returns a sanitized plan.</p>
            <dl><div><dt>Description</dt><dd>identifiers, order, constraints, fingerprints</dd></div><div><dt>Private values</dt><dd>active controls and one exact request only</dd></div><div><dt>Full candidate</dt><dd>advanced CLI route, outside this form</dd></div><div><dt>Provider state</dt><dd>never read or changed here</dd></div></dl>
          </aside>
        </div>
      ) : (
        <>
          <div className="configuration-lock-transfer" aria-label="Exact lock fingerprint transfer">
            <div><span>Baseline lock</span><code>{inspection.configuration.baselineLockFingerprint}</code></div><i aria-hidden="true">→</i>
            <div><span>Candidate lock</span><code>{inspection.configuration.candidateLockFingerprint}</code></div><i aria-hidden="true">→</i>
            <div><span>Observed lock</span><code>{fingerprint(inspection.configuration.observedLockFingerprint)}</code></div><StateMark state={inspection.configuration.applicability} compact />
          </div>
          <div className="configuration-transaction-ledger">
            <section className="configuration-scope-ledger" aria-label="Exact configuration scope">
              <header><div><span className="eyebrow">Fingerprint-only scope</span><h3>{inspection.scope.changes.length} changed subjects</h3></div><code>{inspection.scope.fingerprint}</code></header>
              <div className="configuration-scope-header"><span>Category / subject</span><span>State</span><span>Before</span><span>After</span></div>
              {inspection.scope.changes.map((change) => <article key={change.id}><div><small>{change.category}</small><strong>{change.subject}</strong></div><StateMark state={change.state} compact /><div><span>{change.beforeDescriptor || 'unavailable'}</span><code>{fingerprint(change.beforeFingerprint)}</code></div><div><span>{change.afterDescriptor || 'unavailable'}</span><code>{fingerprint(change.afterFingerprint)}</code></div></article>)}
            </section>
            <aside className="configuration-ceremony" aria-label="Configuration transaction actions">
              <header><span className="eyebrow">Ceremony control</span><h3>One boundary at a time</h3></header>
              {!inspection.request && <div className="configuration-ceremony-step"><span>02 · Request</span><p>Create a ten-minute confirmation window for this exact plan.</p><button disabled={!canRequest || busy !== null} onClick={() => void settle('request', () => window.soterStudio.beginConfigurationChangeRequest({ planId: inspection.plan.id, reason: requestReason }))}>{busy === 'request' ? 'Requesting…' : 'Request confirmation'}</button></div>}
              {inspection.request && !inspection.confirmation && <div className="configuration-ceremony-step"><span>03 · Confirm</span><p>Confirmation records the local actor decision. It does not start or write.</p><label><input type="checkbox" checked={confirmationAcknowledged} onChange={(event) => setConfirmationAcknowledged(event.target.checked)} /><span>I reviewed this exact fingerprint-only scope.</span></label><button disabled={!canConfirm || !confirmationAcknowledged || busy !== null} onClick={() => void settle('confirm', () => window.soterStudio.confirmConfigurationChangeRequest({ requestId: inspection.request!.id, confirmed: true }))}>{busy === 'confirm' ? 'Confirming…' : 'Confirm exact request'}</button></div>}
              {inspection.confirmation && inspection.consumption === null && inspection.checkpoint === null && <div className="configuration-ceremony-step"><span>04 · Consume</span><p>Reserve this confirmation once into one deterministic checkpoint. No desired file is changed yet.</p><button disabled={!canStart || busy !== null} onClick={() => void settle('start', () => window.soterStudio.startConfigurationChange({ confirmationId: inspection.confirmation!.id }))}>{busy === 'start' ? 'Starting…' : 'Reserve one-time start'}</button></div>}
              {inspection.confirmation && inspection.consumption?.state === 'reserved' && <div className="configuration-ceremony-step"><span>04 · Resume consume</span><p>Core already reserved this confirmation. Only its exact checkpoint identity may resume the start; no desired file is changed yet.</p><button disabled={!canResumeStart || busy !== null} onClick={() => void settle('resume-start', () => window.soterStudio.startConfigurationChange({ confirmationId: inspection.confirmation!.id, checkpointId: inspection.consumption!.checkpointId }))}>{busy === 'resume-start' ? 'Resuming…' : 'Resume exact reserved start'}</button></div>}
              {inspection.checkpoint && inspection.consumption?.state === 'started' && <div className="configuration-ceremony-step"><span>05 · Checkpoint</span><p>Execution creates or replaces the desired configuration and its private active lock, then resolves and verifies both.</p><label><input type="checkbox" checked={applyAcknowledged} onChange={(event) => setApplyAcknowledged(event.target.checked)} /><span>I understand this changes the local desired configuration.</span></label>{canExecute && <button disabled={!applyAcknowledged || busy !== null} onClick={() => void settle('execute', () => window.soterStudio.executeConfigurationChange({ checkpointId: inspection.checkpoint!.id, confirmed: true }))}>{busy === 'execute' ? 'Applying…' : 'Apply exact checkpoint'}</button>}{canRecover && <button disabled={!applyAcknowledged || busy !== null} onClick={() => void settle('recover', () => window.soterStudio.recoverConfigurationChange({ checkpointId: inspection.checkpoint!.id, confirmed: true }))}>{busy === 'recover' ? 'Recovering…' : 'Recover exact checkpoint'}</button>}{!canExecute && !canRecover && <button disabled>Canonical checkpoint has no executable UI action</button>}</div>}
            </aside>
          </div>
          <div className={'configuration-resume resume-' + inspection.resume.classification}><span className="configuration-resume-mark" aria-hidden="true">{inspection.resume.classification === 'safe' ? '↻' : '!'}</span><div><span className="eyebrow">Core-derived guidance · not authority</span><strong>{inspection.resume.reasonCode}</strong><p>{inspection.resume.reason}</p><code>{inspection.resume.permittedNextAction}</code></div><dl><div><dt>Request</dt><dd>{inspection.request?.state || 'not requested'}</dd></div><div><dt>Confirmation</dt><dd>{inspection.confirmation ? 'recorded · ' + inspection.confirmation.actor : 'not recorded'}</dd></div><div><dt>Consumption</dt><dd>{inspection.consumption?.state || 'not consumed'}</dd></div><div><dt>Checkpoint</dt><dd>{inspection.checkpoint ? inspection.checkpoint.state + ' · ' + inspection.checkpoint.phase : 'not created'}</dd></div></dl></div>
        </>
      )}

      {error && <div className="configuration-transaction-error" role="alert"><code>{error.code}</code><p>{error.message}</p></div>}
      <details className="configuration-existing-transaction">
        <summary>Open an existing exact transaction</summary><p>Paste known private-state identifiers after restart. Studio stores no alternate transaction index.</p>
        <div><label>Plan ID<input value={references.planId} onChange={(event) => setReferences((value) => ({ ...value, planId: event.target.value }))} /></label><label>Request ID<input value={references.requestId || ''} onChange={(event) => setReferences((value) => ({ ...value, requestId: event.target.value || undefined }))} /></label><label>Confirmation ID<input value={references.confirmationId || ''} onChange={(event) => setReferences((value) => ({ ...value, confirmationId: event.target.value || undefined }))} /></label><label>Checkpoint ID<input value={references.checkpointId || ''} onChange={(event) => setReferences((value) => ({ ...value, checkpointId: event.target.value || undefined }))} /></label></div>
        <button disabled={!references.planId || busy !== null} onClick={() => void settle('inspect', () => window.soterStudio.inspectConfigurationChange(references))}>{busy === 'inspect' ? 'Inspecting…' : 'Inspect exact references'}</button>
      </details>
    </section>
  );
}
