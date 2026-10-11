import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";

// Core build with a short language list only (bundle budget).
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Highlights code for a known language; unknown languages come back as escaped plain text. */
export function highlightCode(code: string, lang: string): { html: string; lang: string | null } {
  const name = lang.trim().toLowerCase();
  if (name && hljs.getLanguage(name)) {
    const canonical = hljs.getLanguage(name)!.name?.toLowerCase().replace(/\s+/g, "") ?? name;
    try {
      const r = hljs.highlight(code, { language: name, ignoreIllegals: true });
      return { html: r.value, lang: canonical === "typescript" ? "typescript" : name };
    } catch { /* fall through */ }
  }
  return { html: escapeHtml(code), lang: null };
}
