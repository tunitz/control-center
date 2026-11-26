import { useEffect, useRef } from "react";
import uPlot from "uplot";
import type { Sample } from "../api";
import { cssVar, useThemeTick, withAlpha } from "../lib/themeColors";

/** `color` is a theme token ('--s1', 'var(--s1)') or a literal CSS color; tokens are resolved when the plot is built. */
export type Series = { key: string; label: string; color: string; scale?: number; fill?: boolean };

/** Resolves a token name or var(--token) to its current computed value. Literal colors pass through. */
function resolveColor(c: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(c.trim());
  if (m) return cssVar(m[1], c);
  if (c.startsWith("--")) return cssVar(c, c);
  return c;
}

/** Split series at real time gaps so an outage is not drawn as a continuous line. */
function toData(points: Sample[], series: Series[], maxGapS = 600): uPlot.AlignedData {
  const ts: number[] = [];
  const values = series.map(() => [] as (number | null)[]);
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && (points[i].ts as number) - (points[i - 1].ts as number) > maxGapS) {
      ts.push((points[i - 1].ts as number) + 1);
      series.forEach((_, j) => values[j].push(null));
    }
    ts.push(points[i].ts as number);
    series.forEach((s, j) => {
      const v = points[i][s.key];
      values[j].push(v == null ? null : (v as number) * (s.scale ?? 1));
    });
  }
  return [ts, ...values];
}

export function Chart({ points, series, unit, syncKey, max }: { points: Sample[]; series: Series[]; unit: string; syncKey: string; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // latest props for callbacks that must not retrigger plot creation
  const latest = useRef({ points, series, max });
  latest.current = { points, series, max };
  // a theme switch changes every resolved color, so the plot is rebuilt with the new tokens
  const theme = useThemeTick();

  // create per mount; re-created when the sync group, unit or theme changes
  useEffect(() => {
    const el = ref.current!;
    const w = () => el.clientWidth || 400;
    const { points: p0, series: s0 } = latest.current;
    const mut = cssVar("--mut", "currentColor"), line = cssVar("--line", "currentColor");
    const resolved = s0.map(s => ({ ...s, color: resolveColor(s.color) }));
    const plot = new uPlot({
      width: w(), height: 190, cursor: { sync: { key: syncKey } }, legend: { show: false },
      scales: { x: { time: true }, y: { range: (_u, _min, mx) => [0, Math.max(latest.current.max ?? 0, mx * 1.15 || 1)] } },
      axes: [
        { stroke: mut, grid: { stroke: line, width: 1 }, ticks: { show: false, stroke: line, width: 1 } },
        { stroke: mut, grid: { stroke: line, width: 1 }, ticks: { show: false, stroke: line, width: 1 }, size: 46 + Math.max(0, unit.length - 2) * 7, values: (_u, v) => v.map(x => (x >= 100 ? x.toFixed(0) : +x.toFixed(1)) + unit) },
      ],
      series: [{}, ...resolved.map(s => ({
        label: s.label,
        stroke: s.color,
        width: 2,
        spanGaps: false,
        points: { show: false },
        fill: s.fill === false ? undefined : (u: uPlot) => {
          const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
          g.addColorStop(0, withAlpha(s.color, 0.22));
          g.addColorStop(1, withAlpha(s.color, 0));
          return g;
        },
      }))],
    }, toData(p0, s0, s0[0]?.key === "cpu_mhz" ? 60 : 3600), el);

    plotRef.current = plot;
    const ro = new ResizeObserver(() => plot.setSize({ width: w(), height: 190 }));
    ro.observe(el);
    return () => { ro.disconnect(); plot.destroy(); plotRef.current = null; };
  }, [syncKey, unit, theme]);

  // data updates on poll: push into the existing plot, no destroy/recreate
  useEffect(() => {
    plotRef.current?.setData(toData(points, latest.current.series, series[0]?.key === "cpu_mhz" ? 60 : 3600));
  }, [points]);

  const summary = series.map(s => {
    const vals = points.map(p => p[s.key]).filter((v): v is number => v != null);
    if (!vals.length) return `${s.label}: no data`;
    return `${s.label}: min ${Math.min(...vals).toFixed(1)}, max ${Math.max(...vals).toFixed(1)}, ${vals.length} points`;
  }).join("; ");
  return <div ref={ref} className="chart" role="img" aria-label={`${series.map(s => s.label).join(", ")} chart. ${summary}`} />;
}
