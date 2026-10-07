export function Gauge({ label, value, sub, color }: { label: string; value: number | null; sub?: string; color: string }) {
  const r = 34, c = 2 * Math.PI * r, v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="gauge" role="img" aria-label={`${label} ${value == null ? "no data" : value.toFixed(0) + " percent"}`}>
      <svg viewBox="0 0 84 84"><circle className="bg" cx="42" cy="42" r={r} fill="none" strokeWidth="8" />
        <circle className="fg" cx="42" cy="42" r={r} fill="none" stroke={color} strokeWidth="8" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} style={{ filter: `drop-shadow(0 0 5px ${color}88)` }} />
        <text className="n" x="42" y="47" textAnchor="middle">{value == null ? "—" : v.toFixed(0) + "%"}</text></svg>
      <div className="t">{label}{sub ? ` · ${sub}` : ""}</div>
    </div>
  );
}
