import type { OperatorInputField } from '../types';

export function OperatorInputControl({ field, value, onChange }: {
  field: OperatorInputField;
  value: string | boolean | string[] | undefined;
  onChange: (value: string | boolean | string[]) => void;
}) {
  const inputId = `operator-input-${field.id}`;
  const descriptionId = `${inputId}-description`;
  const contractId = `${inputId}-contract`;
  const describedBy = `${descriptionId} ${contractId}`;

  return (
    <div className={`operator-field field-${field.type} exposure-${field.exposure}`}>
      <label className="operator-field-label" htmlFor={inputId}>
        <strong>{field.label}</strong>
        <em>{field.required ? 'required' : 'optional'} · {field.exposure}</em>
      </label>
      <p id={descriptionId}>{field.description}</p>
      {field.type === 'enum' ? (
        <select id={inputId} aria-label={field.label} aria-describedby={describedBy} value={String(value || '')} required={field.required} onChange={(event) => onChange(event.target.value)}>
          <option value="">Select</option>
          {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : field.type === 'boolean' ? (
        <input
          id={inputId}
          aria-label={field.label}
          aria-describedby={describedBy}
          type="checkbox"
          required={field.required}
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
      ) : field.type === 'string-list' ? (
        <textarea
          id={inputId}
          aria-label={field.label}
          aria-describedby={describedBy}
          value={Array.isArray(value) ? value.join('\n') : ''}
          required={field.required}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean))}
        />
      ) : field.type === 'string' && field.exposure === 'private' ? (
        <textarea
          id={inputId}
          aria-label={field.label}
          aria-describedby={describedBy}
          value={String(value || '')}
          required={field.required}
          minLength={field.constraints?.minLength}
          maxLength={field.constraints?.maxLength}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={inputId}
          aria-label={field.label}
          aria-describedby={describedBy}
          type={field.type === 'date' ? 'date' : 'text'}
          inputMode={field.type === 'uri' ? 'url' : undefined}
          value={String(value || '')}
          required={field.required}
          minLength={field.constraints?.minLength}
          maxLength={field.constraints?.maxLength}
          pattern={field.constraints?.pattern}
          autoComplete="off"
          spellCheck={field.type === 'string' && field.exposure !== 'identifier'}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <div className="operator-field-contract" id={contractId}>
        <code>{field.type}</code>
        {field.reference && <span>subject <code>{field.reference.subject}</code> · authority <code>{field.reference.authorityRole}</code></span>}
        {field.constraints?.minLength !== undefined && <span>minimum {field.constraints.minLength} characters</span>}
        {field.constraints?.maxLength !== undefined && <span>maximum {field.constraints.maxLength} characters</span>}
        {field.constraints?.pattern && <span>contract pattern declared · Core validates</span>}
        {field.type === 'string-list' && <span>{field.constraints?.minItems || 0}–{field.constraints?.maxItems || 'bounded'} unique values · one per line</span>}
        {field.exposure === 'private' && <span className="operator-private-field">Private value · submitted only to local Core preparation · never returned in inspection</span>}
      </div>
      {field.examples?.length ? (
        <div className="operator-examples"><span>Examples</span>{field.examples.map((example) => (
          <button type="button" key={JSON.stringify(example)} aria-label={`Use ${Array.isArray(example) ? example.join(', ') : example} for ${field.label}`} onClick={() => onChange(example)}>{Array.isArray(example) ? example.join(' · ') : example}</button>
        ))}</div>
      ) : null}
    </div>
  );
}
