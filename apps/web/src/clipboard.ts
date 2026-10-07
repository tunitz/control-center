/** Copy text. navigator.clipboard only exists on HTTPS/localhost, so a LAN http:// dashboard (e.g. an iPhone) needs the execCommand fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  Object.assign(el.style, { position: "fixed", top: "0", left: "0", opacity: "0", fontSize: "16px" }); // 16px stops iOS zooming
  document.body.appendChild(el);
  let ok = false;
  try {
    el.focus();
    el.select();
    el.setSelectionRange(0, text.length); // iOS ignores select() alone
    ok = document.execCommand("copy");
  } catch { ok = false; }
  document.body.removeChild(el);
  return ok;
}
