import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installPreparedAgentSkill,
  prepareGitAgentSkill,
  prepareZipAgentSkill,
  validateGitTreeListing
} from "./agent-skills.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-agent-skills-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("managed Agent Skills", () => {
  it("prepares a bounded ZIP containing one valid Skill", async () => {
    const archive = path.join(tempDir, "skill.zip");
    await writeFile(archive, createZip([{
      name: "ops-review/SKILL.md",
      content: "---\nname: ops-review\ndescription: Review operational changes\nversion: 1.0.0\n---\n\nReview carefully.\n",
      mode: 0o100644
    }]));
    const staging = path.join(tempDir, "staging");
    await mkdir(staging);

    const prepared = await prepareZipAgentSkill(archive, staging);

    expect(prepared).toMatchObject({
      name: "ops-review",
      description: "Review operational changes",
      version: "1.0.0",
      resolvedCommit: null
    });
    expect(prepared.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects symbolic links from ZIP metadata before extraction", async () => {
    const archive = path.join(tempDir, "linked-skill.zip");
    await writeFile(archive, createZip([
      {
        name: "SKILL.md",
        content: "---\nname: linked-skill\ndescription: Unsafe linked Skill\n---\n",
        mode: 0o100644
      },
      { name: "payload", content: "SKILL.md", mode: 0o120777 }
    ]));
    const staging = path.join(tempDir, "staging");
    await mkdir(staging);

    await expect(prepareZipAgentSkill(archive, staging)).rejects.toThrow(/cannot contain links/u);
  });

  it("rejects private, credentialed, and non-HTTPS Git sources", async () => {
    const staging = path.join(tempDir, "staging");
    await mkdir(staging);
    await expect(prepareGitAgentSkill({
      url: "http://192.168.1.20/skill.git",
      stagingRoot: staging
    })).rejects.toThrow(/public HTTPS/u);
    await expect(prepareGitAgentSkill({
      url: "https://user:secret@example.com/skill.git",
      stagingRoot: staging
    })).rejects.toThrow(/credentials/u);
    await expect(prepareGitAgentSkill({
      url: "https://example.com/skill.git?access_token=secret",
      stagingRoot: staging
    })).rejects.toThrow(/query parameters/u);
  });

  it("rejects unsafe or overpopulated Git trees before checkout", () => {
    const blob = (mode: string, name: string) =>
      `${mode} blob ${"a".repeat(40)}\t${name}\0`;

    expect(() => validateGitTreeListing(blob("120000", "linked"))).toThrow(/links/u);
    expect(() => validateGitTreeListing(
      Array.from({ length: 2_049 }, (_, index) => blob("100644", `file-${index}`)).join("")
    )).toThrow(/too many files/u);
  });

  it("restores the previous Skill directory when persistence fails", async () => {
    const skillsDir = path.join(tempDir, "skills");
    const installed = path.join(skillsDir, "skill-id");
    const prepared = path.join(tempDir, "prepared");
    await mkdir(installed, { recursive: true });
    await mkdir(prepared);
    await writeFile(path.join(installed, "SKILL.md"), "old");
    await writeFile(path.join(prepared, "SKILL.md"), "new");

    await expect(installPreparedAgentSkill(skillsDir, "skill-id", prepared, () => {
      throw new Error("database unavailable");
    })).rejects.toThrow(/database unavailable/u);

    await expect(readFile(path.join(installed, "SKILL.md"), "utf8")).resolves.toBe("old");
  });
});

interface ZipEntry {
  name: string;
  content: string;
  mode: number;
}

function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
