import { readFile } from "node:fs/promises";

/** Read the complete cascade so tests do not depend on stylesheet boundaries. */
export async function readStylesheet(file: URL, ancestors: string[] = []): Promise<string> {
  if (ancestors.includes(file.href)) throw new Error(`CSS import cycle: ${file.href}`);
  const source = await readFile(file, "utf8");
  const imports = [...source.matchAll(/@import\s+["']([^"']+)["'];?/g)];
  const children = await Promise.all(imports.map(async ([, target]) => {
    if (!target?.startsWith(".")) return "";
    return readStylesheet(new URL(target, file), [...ancestors, file.href]);
  }));
  return source + "\n" + children.join("\n");
}
