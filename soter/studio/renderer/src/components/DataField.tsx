export function DataField({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`data-field${accent ? ' data-field-accent' : ''}`}>
      <span>{label}</span>
      <code title={value}>{value}</code>
    </div>
  );
}
