export function Sparkline({ values, color }: { values: (number | null)[]; color: string }) {
  const v = values.filter((x): x is number => x != null);
  if (v.length < 2) return <div className="spark" />;
  const mx = Math.max(...v, 1), W = 300, H = 40;
  const pts = values.map((x, i) => (x == null ? null : `${(i / (values.length - 1)) * W},${H - 3 - (x / mx) * (H - 6)}`)).filter(Boolean).join(" ");
  return <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true"><polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}
