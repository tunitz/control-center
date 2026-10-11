import type { Approval } from "./types";

/** What a resolved approval shows on its one collapsed row: the status chip and a one-line preview of the command. */
export function approvalSummary(a: Approval): { cls: string; label: string; preview: string } {
  const preview = (a.command ?? "").split("\n").map(l => l.trim()).find(l => l !== "") ?? "";
  if (a.status === "approved") return { cls: "stat-ok", label: "Approved", preview };
  if (a.status === "denied") return { cls: "stat-err", label: "Denied", preview };
  return { cls: "stat-off", label: "Not answered", preview };
}
