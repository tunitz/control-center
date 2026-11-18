/** Copy text. navigator.clipboard only exists on HTTPS/localhost, so a LAN http:// dashboard (e.g. an iPhone) needs the execCommand fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  Object.assign(el.style, { position: "fixed", top: "0", left: "0", opacity: "0", fontSize: "16px" }); // 16px stops iOS zooming
  // A modal <dialog> makes the rest of the document inert: a textarea appended to
  // <body> cannot be focused or selected there, so execCommand('copy') fails.
  const host = document.querySelector("dialog[open]") ?? document.body;
  host.appendChild(el);
  let ok = false;
  try {
    el.focus();
    el.select();
    el.setSelectionRange(0, text.length); // iOS ignores select() alone
    ok = document.execCommand("copy");
  } catch { ok = false; }
  host.removeChild(el);
  return ok;
}
