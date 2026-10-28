import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import console from "node:console";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const checkedInDirectory = path.join(root, "packages/shared/src/generated");
const expectedFiles = ["hostd.ts", "terminal.ts", "vod-player.ts"];
const check = process.argv.includes("--check");
const temporaryRoot = check ? await mkdtemp(path.join(os.tmpdir(), "cyberos-protocol-")) : null;
const outputDirectory = temporaryRoot ?? checkedInDirectory;

try {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  for (const packageName of ["cyberos-vod-player", "cyberos-terminald", "cyberos-hostd"]) {
    const result = spawnSync(
      "cargo",
      ["test", "--locked", "-p", packageName, "export_protocol_bindings", "--", "--ignored"],
      {
        cwd: root,
        env: {
          ...process.env,
          TS_RS_EXPORT_DIR: outputDirectory,
          TS_RS_IMPORT_EXTENSION: "js",
          TS_RS_LARGE_INT: "number"
        },
        stdio: "inherit"
      }
    );
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }

  if (process.exitCode) process.exit(process.exitCode);
  const generatedFiles = (await readdir(outputDirectory)).sort();
  const unexpectedFiles = generatedFiles.filter((file) => !expectedFiles.includes(file));
  const missingFiles = expectedFiles.filter((file) => !generatedFiles.includes(file));
  if (unexpectedFiles.length || missingFiles.length) {
    throw new Error([
      missingFiles.length ? `Missing generated bindings: ${missingFiles.join(", ")}` : "",
      unexpectedFiles.length ? `Unexpected generated bindings: ${unexpectedFiles.join(", ")}` : ""
    ].filter(Boolean).join("\n"));
  }

  if (check) {
    const checkedInFiles = (await readdir(checkedInDirectory)).sort();
    const missingCheckedInFiles = expectedFiles.filter((file) => !checkedInFiles.includes(file));
    const unexpectedCheckedInFiles = checkedInFiles.filter((file) => !expectedFiles.includes(file));
    if (missingCheckedInFiles.length || unexpectedCheckedInFiles.length) {
      throw new Error([
        missingCheckedInFiles.length
          ? `Missing checked-in protocol bindings: ${missingCheckedInFiles.join(", ")}`
          : "",
        unexpectedCheckedInFiles.length
          ? `Unexpected checked-in protocol bindings: ${unexpectedCheckedInFiles.join(", ")}`
          : ""
      ].filter(Boolean).join("\n"));
    }
    const changed = [];
    for (const file of expectedFiles) {
      const [generated, checkedIn] = await Promise.all([
        readFile(path.join(outputDirectory, file)),
        readFile(path.join(checkedInDirectory, file))
      ]);
      if (!generated.equals(checkedIn)) changed.push(file);
    }
    if (changed.length) {
      throw new Error(`Protocol bindings are out of date: ${changed.join(", ")}. Run npm run protocol:generate.`);
    }
    console.log("Protocol bindings are up to date.");
  } else {
    console.log(`Generated protocol bindings in ${path.relative(root, outputDirectory)}.`);
  }
} finally {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}
