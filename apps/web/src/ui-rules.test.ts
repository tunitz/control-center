import { test, expect } from "bun:test";
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// House rule (tun): no ellipses on buttons, chips or menu items. "Remove unit", not "Remove unit…".
const ELLIPSIS = /…|\.\.\./;
const isControl = (tag: string, attrs: string) => tag === "button" || /\b(btn|chip)\b/.test(attrs);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });
}
/** Visible text inside an element's children: JSX text and string/template literals, never attributes. */
function childText(node: ts.Node, out: string[] = []): string[] {
  if (ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
  else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(node.text);
  if (ts.isJsxAttribute(node)) return out; // attributes are not visible label text
  ts.forEachChild(node, c => childText(c, out));
  return out;
}

test("no ellipsis in any button, chip or menu item label", () => {
  const offenders: string[] = [];
  for (const file of tsxFiles(join(import.meta.dir))) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n)) {
        const tag = n.openingElement.tagName.getText(sf), attrs = n.openingElement.attributes.getText(sf);
        if (isControl(tag, attrs)) {
          const text = n.children.flatMap(c => childText(c)).join(" ");
          if (ELLIPSIS.test(text)) offenders.push(`${file.split("/src/")[1]}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  ${text.trim().slice(0, 60)}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  expect(offenders).toEqual([]);
});
