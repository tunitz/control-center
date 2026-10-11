import { useMemo, type MouseEvent } from "react";
import { renderMarkdown } from "../../chat/markdown";
import { copyText } from "../../clipboard";

/** Assistant text as sanitised markdown. Copy buttons are delegated so the HTML stays plain. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as Element).closest?.("[data-copy]") as HTMLButtonElement | null;
    if (!btn) return;
    const code = btn.closest(".codeblk")?.querySelector("code")?.textContent ?? "";
    void copyText(code).then(ok => {
      btn.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
  };
  return <div className="body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
