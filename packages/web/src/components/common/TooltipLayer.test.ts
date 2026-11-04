import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { readStylesheet } from "../../styles/test-utils.js";

async function sourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) return sourceFiles(url);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [url] : [];
  }));
  return files.flat();
}

describe("shared HUD tooltip coverage", () => {
  it("does not leave browser-native title tooltips on Web or TV elements", async () => {
    const files = await sourceFiles(new URL("../../", import.meta.url));
    const violations: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(fileURLToPath(file), await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node: ts.Node) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(source);
          if (/^[a-z]/u.test(tag)) {
            for (const attribute of node.attributes.properties) {
              if (ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "title") {
                violations.push(`${fileURLToPath(file)}:${source.getLineAndCharacterOfPosition(attribute.getStart(source)).line + 1}`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(violations).toEqual([]);
  });

  it("mounts the shared tooltip layer and styling in both application entries", async () => {
    const [web, tv, webStyles, tvStyles, docs, docsStyles] = await Promise.all([
      readFile(new URL("../../main.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../tv/main.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../styles.css", import.meta.url), "utf8"),
      readStylesheet(new URL("../../tv/tv.css", import.meta.url)),
      readFile(new URL("../../../../../docs/src/components/Head.astro", import.meta.url), "utf8"),
      readFile(new URL("../../../../../docs/src/styles/custom.css", import.meta.url), "utf8")
    ]);
    expect(web).toContain("<TooltipLayer />");
    expect(tv).toContain("<TooltipLayer />");
    expect(webStyles).toContain('"./styles/tooltip.css"');
    expect(tvStyles).toContain(".hud-tooltip");
    expect(docs).toContain("mountTooltipLayer();");
    expect(docsStyles).toContain('"../../../packages/web/src/styles/tooltip.css"');
  });
});
