import { Marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { highlightCode, escapeHtml } from "./highlight";

const SAFE_PROTOCOLS = /^(https?:|mailto:)/i;

function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const h = href.trim();
  return SAFE_PROTOCOLS.test(h) ? h : null;
}

/** Renderer: everything that could carry script or remote content is either escaped or turned into a link. */
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(this: any, token: { text: string }) {
      // Raw HTML from the model is never emitted as markup.
      return escapeHtml(token.text);
    },
    link(this: any, token: Tokens.Link) {
      const inner = this.parser.parseInline(token.tokens);
      const href = safeHref(token.href);
      if (!href) return inner;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${inner}</a>`;
    },
    image(this: any, token: Tokens.Image) {
      // Remote images are links, never <img> (no tracking pixels).
      const label = escapeHtml(token.text || "image");
      const href = safeHref(token.href);
      if (!href) return label;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">[image: ${label}]</a>`;
    },
    code(this: any, token: Tokens.Code) {
      const { html } = highlightCode(token.text, token.lang ?? "");
      const label = escapeHtml((token.lang ?? "").trim() || "text");
      return `<div class="codeblk"><div class="codeblk-h"><span>${label}</span><button type="button" class="copy" data-copy>Copy</button></div><pre><code class="hljs">${html}</code></pre></div>\n`;
    },
    table(this: any, token: Tokens.Table) {
      const cell = (c: Tokens.TableCell, tag: string) => {
        const align = c.align ? ` style="text-align:${c.align}"` : "";
        return `<${tag}${align}>${this.parser.parseInline(c.tokens)}</${tag}>`;
      };
      const head = token.header.map(c => cell(c, "th")).join("");
      const rows = token.rows.map(r => `<tr>${r.map(c => cell(c, "td")).join("")}</tr>`).join("");
      return `<div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
    },
  },
});

/** Markdown to HTML with the renderer's own guarantees, before DOMPurify. Pure, so it is unit-testable. */
export function renderMarkdownRaw(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

let hooked = false;
function ensureHooks() {
  if (hooked || !DOMPurify.isSupported) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", node => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer noopener");
    }
  });
}

/** Final HTML for the browser: renderer output run through DOMPurify (second layer). */
export function renderMarkdown(text: string): string {
  const raw = renderMarkdownRaw(text);
  ensureHooks();
  if (!DOMPurify.isSupported) return escapeHtml(text);
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "img", "form", "input", "object", "embed"],
    ADD_ATTR: ["data-copy"],
  });
}
