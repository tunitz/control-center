export function Gauge({ label, value, sub, color }: { label: string; value: number | null; sub?: string; color: string }) {
  const r = 34, c = 2 * Math.PI * r, v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="gauge" role="img" aria-label={`${label} ${value == null ? "no data" : value.toFixed(0) + " percent"}`}>
      <svg viewBox="0 0 84 84"><circle className="bg" cx="42" cy="42" r={r} fill="none" strokeWidth="8" style={{ stroke: "var(--track)" }} />
        <circle className="fg" cx="42" cy="42" r={r} fill="none" style={{ stroke: color }} strokeWidth="12" opacity=".25" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} aria-hidden="true" />
        <circle className="fg" cx="42" cy="42" r={r} fill="none" style={{ stroke: color }} strokeWidth="8" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} />
        <text className="n" x="42" y="47" textAnchor="middle" style={{ fill: "var(--text)" }}>{value == null ? "—" : v.toFixed(0) + "%"}</text></svg>
      <div className="t" style={{ color: "var(--mut)" }}>{label}{sub ? ` · ${sub}` : ""}</div>
    </div>
  );
}
