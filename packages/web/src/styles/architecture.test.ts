import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

async function cssFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => {
    const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? cssFiles(file) : entry.name.endsWith(".css") ? [file] : [];
  }))).flat();
}

async function cascade(file: URL, ancestors: string[] = []): Promise<postcss.Root[]> {
  if (ancestors.includes(file.href)) throw new Error(`CSS import cycle: ${fileURLToPath(file)}`);
  const root = postcss.parse(await readFile(file, "utf8"), { from: fileURLToPath(file) });
  const result: postcss.Root[] = [root];
  for (const node of root.nodes) {
    if (node.type !== "atrule" || node.name !== "import") continue;
    const target = node.params.match(/^["']([^"']+)["']/)?.[1];
    const imported = target === "@cyberos/shared/hud-tokens.css"
      ? new URL("../../../shared/src/hud-tokens.css", import.meta.url)
      : target?.startsWith(".") ? new URL(target, file) : null;
    if (imported) result.push(...await cascade(imported, [...ancestors, file.href]));
  }
  return result;
}

describe("stylesheet architecture", () => {
  it("keeps each stylesheet below the 800 line review limit", async () => {
    const files = [...await cssFiles(new URL("./", import.meta.url)), ...await cssFiles(new URL("../tv/", import.meta.url))];
    const oversized: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, "utf8")).trimEnd().split("\n").length;
      if (lines > 800) oversized.push(`${fileURLToPath(file)}: ${lines}`);
    }
    expect(oversized).toEqual([]);
  });

  for (const entry of ["../styles.css", "../tv/tv.css"]) {
    it(`resolves every required token in ${entry} without import cycles`, async () => {
      const roots = await cascade(new URL(entry, import.meta.url));
      const defined = new Set<string>();
      // Values set by React according to actual data, rather than global theme tokens.
      const dynamic = new Set(["--skeleton-columns", "--management-resource-value", "--playback-slider-fill"]);
      roots.forEach(root => root.walkDecls(declaration => {
        if (declaration.prop.startsWith("--")) defined.add(declaration.prop);
      }));
      const missing: string[] = [];
      roots.forEach(root => root.walkDecls(declaration => {
        for (const [, token] of declaration.value.matchAll(/var\((--[\w-]+)\s*\)/g)) {
          if (token && !defined.has(token) && !dynamic.has(token)) missing.push(`${declaration.source?.input.file}:${declaration.source?.start?.line} ${token}`);
        }
      }));
      expect(missing).toEqual([]);
    });
  }
});
