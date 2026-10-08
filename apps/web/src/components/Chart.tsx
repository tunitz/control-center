import { useEffect, useRef } from "react";
import uPlot from "uplot";
import type { Sample } from "../api";

export type Series = { key: string; label: string; color: string; scale?: number; fill?: boolean };

function toData(points: Sample[], series: Series[]): uPlot.AlignedData {
  return [points.map(p => p.ts as number), ...series.map(s => points.map(p => (p[s.key] == null ? null : (p[s.key] as number) * (s.scale ?? 1))))];
}

export function Chart({ points, series, unit, syncKey, max }: { points: Sample[]; series: Series[]; unit: string; syncKey: string; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // latest props for callbacks that must not retrigger plot creation
  const latest = useRef({ points, series, max });
  latest.current = { points, series, max };

  // create once per mount (re-created only if the sync group or unit changes)
  useEffect(() => {
    const el = ref.current!;
    const w = () => el.clientWidth || 400;
    const { points: p0, series: s0 } = latest.current;
    const plot = new uPlot({
      width: w(), height: 190, cursor: { sync: { key: syncKey } }, legend: { show: false },
      scales: { x: { time: true }, y: { range: (_u, _min, mx) => [0, Math.max(latest.current.max ?? 0, mx * 1.15 || 1)] } },
      axes: [{ stroke: "#9aa3c7", grid: { stroke: "#ffffff0d" }, ticks: { show: false } }, { stroke: "#9aa3c7", grid: { stroke: "#ffffff0d" }, ticks: { show: false }, size: 46, values: (_u, v) => v.map(x => (x >= 100 ? x.toFixed(0) : +x.toFixed(1)) + unit) }],
      series: [{}, ...s0.map(s => ({ label: s.label, stroke: s.color, width: 2, fill: s.fill === false ? undefined : s.color + "22", spanGaps: false, points: { show: false } }))],
    }, toData(p0, s0), el);
    plotRef.current = plot;
    const ro = new ResizeObserver(() => plot.setSize({ width: w(), height: 190 }));
    ro.observe(el);
    return () => { ro.disconnect(); plot.destroy(); plotRef.current = null; };
  }, [syncKey, unit]);

  // data updates on poll: push into the existing plot, no destroy/recreate
  useEffect(() => {
    plotRef.current?.setData(toData(points, latest.current.series));
  }, [points]);

  return <div ref={ref} className="chart" role="img" aria-label={series.map(s => s.label).join(", ") + " chart"} />;
}
