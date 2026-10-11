import { test, expect } from "bun:test";
import { approvalSummary } from "./approval";

test("a resolved approval gets a status chip that matches how it ended", () => {
  const base = { command: "Run: ls ~/.hermes\n\nTouches ~/.hermes", note: "Protected path", id: "ui-1" };
  expect(approvalSummary({ ...base, status: "approved" })).toMatchObject({ cls: "stat-ok", label: "Approved" });
  expect(approvalSummary({ ...base, status: "denied" })).toMatchObject({ cls: "stat-err", label: "Denied" });
  expect(approvalSummary({ ...base, status: "ended" })).toMatchObject({ cls: "stat-off", label: "Not answered" });
  expect(approvalSummary({ ...base })).toMatchObject({ cls: "stat-off", label: "Not answered" });
});

test("the preview is the command's first non-empty line, and empty when there is no command", () => {
  expect(approvalSummary({ command: "\n  Run: git push\n\nTouches x", note: "n", status: "approved" }).preview).toBe("Run: git push");
  expect(approvalSummary({ command: null, note: "Allow command?", status: "approved" }).preview).toBe("");
});
