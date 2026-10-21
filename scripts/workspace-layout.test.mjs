import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("workspace layout", () => {
  it("keeps Rust crates under crates and TypeScript workspaces under packages", async () => {
    await expect(access(path.join(repoRoot, "apps"))).rejects.toMatchObject({ code: "ENOENT" });

    const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    const rootCargo = await readFile(path.join(repoRoot, "Cargo.toml"), "utf8");
    expect(rootPackage.workspaces).toEqual(["packages/*"]);
    expect(rootCargo).toContain('members = ["crates/*"]');

    const crateDirectories = await workspaceDirectories("crates");
    const packageDirectories = await workspaceDirectories("packages");
    await Promise.all(
      crateDirectories.map((name) => access(path.join(repoRoot, "crates", name, "Cargo.toml")))
    );
    await Promise.all(
      packageDirectories.map((name) => access(path.join(repoRoot, "packages", name, "package.json")))
    );

    await Promise.all(
      crateDirectories.map((name) =>
        expect(access(path.join(repoRoot, "crates", name, "package.json"))).rejects.toMatchObject({
          code: "ENOENT"
        })
      )
    );
    await Promise.all(
      packageDirectories.map((name) =>
        expect(access(path.join(repoRoot, "packages", name, "Cargo.toml"))).rejects.toMatchObject({
          code: "ENOENT"
        })
      )
    );
  });
});

async function workspaceDirectories(root) {
  const entries = await readdir(path.join(repoRoot, root), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
