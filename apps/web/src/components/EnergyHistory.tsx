import { useEffect, useState } from "react";
import { api } from "../api";
import { cached } from "../hooks";

type EnergyDay = { day: string; kwh: number; cost?: number; php: number };
type RegionalSettings = { timezone?: string; currency_symbol?: string };
const todayInZone = (tz?: string) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};
const daysBefore = (day: string, n: number) => new Date(Date.parse(day + "T00:00:00Z") - n * 86400_000).toISOString().slice(0, 10);

export default function EnergyHistory({ unitId }: { unitId: number }) {
  const initialTz = cached<RegionalSettings>("/settings")?.timezone;
  const [sym, setSym] = useState(() => cached<RegionalSettings>("/settings")?.currency_symbol ?? "$");
  const [to, setTo] = useState(() => todayInZone(initialTz));
  const [from, setFrom] = useState(() => daysBefore(todayInZone(initialTz), 29));
  const [rows, setRows] = useState<EnergyDay[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let on = true;
    api<RegionalSettings>("/settings").then(s => {
      if (!on) return;
      if (s.currency_symbol) setSym(s.currency_symbol);
      if (s.timezone) {
        const t = todayInZone(s.timezone);
        setTo(t);
        setFrom(daysBefore(t, 29));
      }
    }).catch(() => {});
    return () => { on = false; };
  }, []);

  useEffect(() => {
    let on = true;
    setLoading(true); setErr("");
    api<EnergyDay[]>(`/energy?unitId=${unitId}&from=${from}&to=${to}`)
      .then(r => { if (on) setRows(Array.isArray(r) ? r : []); })
      .catch(e => { if (on) setErr(e.message); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [unitId, from, to]);

  const total = rows.reduce((a, r) => a + r.kwh, 0);
  const cost = rows.reduce((a, r) => a + (r.cost ?? r.php), 0);
  const csv = `/api/energy?unitId=${unitId}&from=${from}&to=${to}&format=csv`;

  return (
    <section className="card" aria-labelledby="energy-h" style={{ marginTop: 14 }}>
      <div className="svc-top"><h4 id="energy-h">Daily energy</h4><div className="spacer" />
        <a className="btn sm" href={csv} download={`energy-${unitId}-${from}-${to}.csv`}>Export CSV</a>
      </div>
      <div className="chips" style={{ marginBottom: 10 }}>
        <label htmlFor="efrom">From</label><input id="efrom" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} style={{ width: "auto" }} />
        <label htmlFor="eto">To</label><input id="eto" type="date" value={to} min={from} onChange={e => setTo(e.target.value)} style={{ width: "auto" }} />
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      {loading && <div className="muted" role="status">Loading energy history</div>}
      {!loading && rows.length === 0 && <div className="muted">No energy data in this range.</div>}
      {rows.length > 0 && <>
        <div className="strip"><span>Days <b>{rows.length}</b></span><span>Total <b>{total.toFixed(3)} kWh</b></span><span>Cost <b>{sym}{cost.toFixed(2)}</b></span></div>
        <div className="scroll" role="region" aria-label="Daily energy" tabIndex={0}>
          <table className="rtable"><thead><tr><th>Day</th><th>kWh</th><th>Cost</th></tr></thead>
            <tbody>{[...rows].reverse().map(r => <tr key={r.day}><td data-label="Day">{r.day}</td><td data-label="kWh">{r.kwh.toFixed(3)}</td><td data-label="Cost">{sym}{(r.cost ?? r.php).toFixed(2)}</td></tr>)}</tbody>
          </table>
        </div>
      </>}
    </section>
  );
}
