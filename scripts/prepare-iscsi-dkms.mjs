#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Build-time only: every upstream byte is checked before assembling a DKMS source package. */
export async function prepareIscsiDkms({ manifest, outputDirectory, sourceDirectory }) {
  if (!/^6\.18\.\d+$/u.test(manifest.version) || manifest.repository !== "gregkh/linux"
    || !/^[0-9a-f]{40}$/u.test(manifest.commit) || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error("Invalid pinned Linux source manifest");
  }
  for (const entry of manifest.files) {
    if (!/^(?:drivers\/target\/(?:iscsi\/)?[A-Za-z0-9_.-]+|include\/target\/(?:iscsi\/)?[A-Za-z0-9_.-]+|COPYING|LICENSES\/preferred\/GPL-2\.0)$/u.test(entry.path)
      || !/^[0-9a-f]{64}$/u.test(entry.sha256)) throw new Error("Invalid Linux source path or checksum");
  }
  await mkdir(path.dirname(outputDirectory), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(outputDirectory), ".lio-source-"));
  try {
    let index = 0;
    const results = await Promise.allSettled(Array.from({ length: 4 }, async () => {
      while (index < manifest.files.length) {
        const entry = manifest.files[index++];
        let bytes;
        if (sourceDirectory) {
          bytes = await readFile(path.join(sourceDirectory, entry.path));
        } else {
          const url = `https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/${entry.path}`;
          let lastError;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(30_000) });
              if (!response.ok) throw new Error(`Linux source download failed: HTTP ${response.status}`);
              bytes = Buffer.from(await response.arrayBuffer());
              break;
            } catch (error) { lastError = error; }
          }
          if (!bytes) throw lastError;
        }
        if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
          throw new Error(`Linux source checksum mismatch: ${entry.path}`);
        }
        const destination = path.join(staging, entry.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
      }
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    const makefile = path.join(staging, "drivers/target/Makefile");
    await writeFile(makefile, `${await readFile(makefile, "utf8")}\n# CyberOS external-module build: use the matching bundled target headers.\nsubdir-ccflags-y := -I$(abspath $(src)/../../include)\n`);
    const config = await readFile(path.join(root, "packaging/debian/cyberos.dkms"), "utf8");
    await writeFile(path.join(staging, "dkms.conf"), config.replaceAll("#MODULE_VERSION#", manifest.version));
    await writeFile(path.join(staging, "SOURCE.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(outputDirectory, { recursive: true, force: true });
    await rename(staging, outputDirectory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(await readFile(path.join(root, "packaging/iscsi-kernel-source.json"), "utf8"));
  await prepareIscsiDkms({ manifest,
    outputDirectory: path.join(root, ".cyberos/dkms", `cyberos-lio-${manifest.version}`),
    sourceDirectory: process.env.CYBEROS_LIO_SOURCE_DIR
  });
  process.stdout.write(`Prepared verified Linux ${manifest.version} iSCSI DKMS sources.\n`);
}
