import type { DiskMount } from "../lib/disks";
import { freeLine, toneColor, usagePct, usageTone } from "../lib/disks";

/** One row per mount: path, filesystem, usage bar, free space and percent used. */
export function DiskList({ mounts }: { mounts: DiskMount[] }) {
  return (
    <div className="card"><h4>Disk space</h4>
      <div className="disk-list">
        {mounts.map(m => {
          const pct = usagePct(m), tone = toneColor(usageTone(pct));
          return (
            <div key={m.mount} className="disk">
              <div className="disk-head">
                <span className="disk-mount">{m.mount}<span className="disk-fs">{m.fs}</span></span>
                <b className="disk-pct" style={{ color: tone }}>{Math.round(pct)}%</b>
              </div>
              <div className="disk-bar" role="img" aria-label={`${m.mount} ${Math.round(pct)} percent used`}>
                <div className="disk-fill" style={{ width: `${pct}%`, background: tone }} />
              </div>
              <div className="disk-free">{freeLine(m)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
