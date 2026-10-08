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

function toData(points: Sample[], series: Series[]): uPlot.AlignedData {
  return [points.map(p => p.ts as number), ...series.map(s => points.map(p => (p[s.key] == null ? null : (p[s.key] as number) * (s.scale ?? 1))))];
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
        { stroke: mut, grid: { stroke: line, width: 1 }, ticks: { show: false, stroke: line, width: 1 }, size: 46, values: (_u, v) => v.map(x => (x >= 100 ? x.toFixed(0) : +x.toFixed(1)) + unit) },
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
    }, toData(p0, s0), el);
    plotRef.current = plot;
    const ro = new ResizeObserver(() => plot.setSize({ width: w(), height: 190 }));
    ro.observe(el);
    return () => { ro.disconnect(); plot.destroy(); plotRef.current = null; };
  }, [syncKey, unit, theme]);

  // data updates on poll: push into the existing plot, no destroy/recreate
  useEffect(() => {
    plotRef.current?.setData(toData(points, latest.current.series));
  }, [points]);

  return <div ref={ref} className="chart" role="img" aria-label={series.map(s => s.label).join(", ") + " chart"} />;
}
