# Data and cost

## Sample retention

Incoming JSONL samples are deduplicated on `(unit_id, ts)` and stored in raw and rollup tables. A background purge runs hourly.

| Data | Retention |
|---|---|
| Raw samples (`samples_raw`) | 48 hours |
| 1-minute rollups (`samples_1m`) | 30 days |
| 15-minute rollups (`samples_15m`) | `retention_days` setting (1–90, default 90) |
| Billing energy (`energy_intervals`, `energy_hourly`) | 400 days, independent of telemetry retention |
| Wall readings and measured energy | 400 days |
| Audit log | 365 days |

Rollups are built only from completed buckets, with an overlap so late samples rebuild correctly. When a late sample arrives, the affected rollup buckets are deleted and rewound, and the energy intervals ending at that sample and the following one are recomputed, so replays cannot double-count. The `retention_days` setting never extends the fixed raw and 1-minute windows.

Charts pick a tier by range: `1h` uses raw samples, `6h`/`12h`/`24h` use 1-minute rollups, and `7d`/`30d` use 15-minute rollups. Rollups store per-metric average, min, max, and valid count so a sensor that reports sporadically is not weighted by every row in a bucket.

## Energy estimates (RAPL and GPU)

Each valid interval between two consecutive samples contributes watt-hours:

- CPU energy uses the Intel/AMD RAPL counter delta (`cpu_uj`) when available, converted from microjoules.
- GPU energy uses a counter delta when a source supplies `gpu_uj`; the shipped agent reports `gpu_w` and integrates that instead.
- If a counter delta is unavailable, the corresponding instantaneous watts (`cpu_w`, `gpu_w`) are integrated over the interval instead.
- An interval whose duration is zero, negative, or greater than three times the sampling interval contributes nothing; gaps and clock jumps are never interpolated.

The result is stored per interval in `energy_intervals` and summed into hourly rows. Units without RAPL show CPU power as unavailable. These figures are a CPU+GPU **estimate**, not a wall-power measurement.

## Manila day boundaries

All calendar-day and month accounting uses Asia/Manila time (UTC+8, no daylight saving). A Manila day runs from 16:00 UTC on the previous day to 16:00 UTC on the stated day; a billing month is derived from the same offset. Daily energy history, rate lookups, and maintenance-window weekday/minutes all use this local clock.

## Wall power input

An external meter or script can POST instantaneous watts for a unit:

```bash
curl -X POST http://<this-host>:3030/api/metrics/wall \
  -b <cookie-jar> -H 'x-cc: 1' -H 'content-type: application/json' \
  -d '{"unit_id":1,"watts":245.5}'
```

The request needs an authenticated session cookie plus `x-cc: 1`. `watts` must be 0–100000 and `ts` (when supplied) within five minutes of now. Consecutive readings are integrated with the trapezoidal rule into measured wall energy. Gaps larger than five minutes contribute nothing, and gaps are never interpolated. The latest reading is considered live only for 60 seconds; after that it reads as unknown.

## Cost basis

Cost for the current billing month is the month's energy multiplied by that month's rate:

- **Default:** cost uses the CPU+GPU estimate for every enabled unit. The dashboard reports the basis as `estimated CPU+GPU power`.
- **With `cost_include_wall` enabled:** units that have measured wall energy use that measurement **instead of** their estimate; units without a meter keep the CPU+GPU estimate. The two are never added together. The dashboard and API state the basis as `measured wall where available, CPU+GPU estimate elsewhere` (or the estimate-only wording when no wall data exists).

Each unit in `GET /api/cost` carries its own `basis` and `wall_kwh`, so measured data is never mistaken for an estimate. The response also includes the current `rate`, `total_kwh`, and `total_php`.

Rates are stored per month. A new month copies the previous month's rate on first read (default 10). Only the current month's rate can be edited; attempts to write a past month are rejected.

## CSV export

`GET /api/energy?from=YYYY-MM-DD&to=YYYY-MM-DD` returns daily energy as JSON. Add `format=csv` for a downloadable file:

```text
day,kwh,php
2026-11-01,1.234,12.34
2026-11-02,0.500,5.00
```

The file has a `day,kwh,php` header, one row per Manila day in the inclusive range, CRLF line endings, and RFC-style quoting for any field containing a comma, quote, or newline. Omit `unitId` for the whole fleet or supply it for one unit; monetary values use that day's rate.

Continue with [development](development.md) and [troubleshooting](troubleshooting.md).
