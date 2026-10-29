import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { validateArchiveEntries } from "@cyberos/storage-tools";
import { validateMcpEndpoint } from "@cyberos/shared/mcp-network";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_SKILL_FILES = 2_048;
const MAX_GIT_BYTES = 96 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;
const NESTED_ARCHIVE_PATTERN = /\.(?:zip|rar|7z|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/iu;

export interface PreparedAgentSkill {
  directory: string;
  name: string;
  description: string;
  version: string | null;
  digest: string;
  diagnostics: string[];
  resolvedCommit: string | null;
}

export interface InspectedProjectSkill {
  name: string;
  description: string;
  path: string;
  valid: boolean;
  diagnostics: string[];
}

export async function createAgentSkillStagingRoot(piAgentStateDir: string): Promise<string> {
  const root = path.join(piAgentStateDir, ".staging", randomUUID());
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

export async function prepareZipAgentSkill(sourcePath: string, stagingRoot: string): Promise<PreparedAgentSkill> {
  const source = await stat(sourcePath);
  if (!source.isFile()) throw new Error("Skill ZIP source must be a regular file");
  if (source.size > MAX_ARCHIVE_BYTES) throw new Error("Skill ZIP exceeds the 32 MiB limit");
  if (!sourcePath.toLowerCase().endsWith(".zip")) throw new Error("Skill import requires a ZIP file");

  const entries = (await runCommand("unzip", ["-Z1", sourcePath])).stdout.split(/\r?\n/u).filter(Boolean);
  validateArchiveEntries(entries);
  if (entries.length > MAX_SKILL_FILES) throw new Error("Skill ZIP contains too many entries");
  const listing = await runCommand("unzip", ["-l", sourcePath]);
  if (zipExpandedBytes(listing.stdout) > MAX_EXPANDED_BYTES) {
    throw new Error("Expanded Skill ZIP exceeds the 64 MiB limit");
  }
  const metadataListing = await runCommand("unzip", ["-Z", "-l", sourcePath]);
  validateZipEntryTypes(metadataListing.stdout, entries.length);

  const extracted = path.join(stagingRoot, "extracted");
  await mkdir(extracted, { recursive: false, mode: 0o700 });
  await runCommand("unzip", ["-q", "-n", sourcePath, "-d", extracted]);
  await validateSkillTree(extracted);
  return await prepareSkillFromTree(extracted, stagingRoot, null);
}

export async function prepareGitAgentSkill(input: {
  url: string;
  ref?: string | null;
  subdirectory?: string | null;
  stagingRoot: string;
}): Promise<PreparedAgentSkill> {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(input.url);
  } catch {
    throw new Error("Skill Git source must be a public HTTPS repository");
  }
  if (
    sourceUrl.protocol !== "https:"
    || sourceUrl.username
    || sourceUrl.password
    || sourceUrl.search
    || sourceUrl.hash
  ) {
    throw new Error("Skill Git source must be a public HTTPS repository without credentials or query parameters");
  }
  const endpoint = await validateMcpEndpoint(input.url, false);
  if (endpoint.url.protocol !== "https:" || endpoint.addressClasses.some((value) => value !== "public")) {
    throw new Error("Skill Git source must be a public HTTPS repository");
  }
  if (!endpoint.url.pathname || endpoint.url.pathname === "/") throw new Error("Skill Git repository path is required");
  const ref = input.ref?.trim() || "HEAD";
  if (ref.length > 256 || ref.startsWith("-") || /[\r\n\0]/u.test(ref)) throw new Error("Skill Git ref is invalid");
  const subdirectory = normalizeGitSubdirectory(input.subdirectory);
  const repository = path.join(input.stagingRoot, "repository");
  await mkdir(repository, { recursive: false, mode: 0o700 });
  await runGit(["init", "--quiet", repository]);
  await runGit(["-C", repository, "remote", "add", "origin", endpoint.url.toString()]);
  const pinnedAddress = endpoint.addresses[0]!;
  const resolveValue = `+${endpoint.url.hostname}:${endpoint.url.port || "443"}:${pinnedAddress.includes(":") ? `[${pinnedAddress}]` : pinnedAddress}`;
  const networkOptions = [
    "-c", "protocol.file.allow=never",
    "-c", "http.followRedirects=false",
    "-c", `http.curloptResolve=${resolveValue}`
  ];
  await runGit([
    ...networkOptions,
    "-C", repository,
    "fetch", "--quiet", "--depth=1", "--filter=blob:none", "origin", ref
  ]);
  const repositorySize = await treeSize(path.join(repository, ".git"), MAX_GIT_BYTES);
  if (repositorySize > MAX_GIT_BYTES) throw new Error("Skill Git metadata exceeds the size limit");
  const tree = await runGit([
    ...networkOptions,
    "-C", repository,
    "ls-tree", "-r", "-z", "FETCH_HEAD", "--",
    ...(subdirectory ? [subdirectory] : [])
  ]);
  validateGitTreeListing(tree.stdout);
  if (subdirectory) {
    await runGit(["-C", repository, "sparse-checkout", "init", "--cone"]);
    await runGit(["-C", repository, "sparse-checkout", "set", "--", subdirectory]);
  }
  await runGit([...networkOptions, "-C", repository, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  const resolvedCommit = (await runGit(["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const checkoutMetadataSize = await treeSize(path.join(repository, ".git"), MAX_GIT_BYTES);
  if (checkoutMetadataSize > MAX_GIT_BYTES) throw new Error("Skill Git metadata exceeds the size limit");
  const sourceRoot = subdirectory ? path.join(repository, subdirectory) : repository;
  const sourceMetadata = await lstat(sourceRoot).catch(() => null);
  if (!sourceMetadata?.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("Skill Git subdirectory does not exist or is unsafe");
  }
  await validateSkillTree(sourceRoot, new Set([".git"]));
  return await prepareSkillFromTree(sourceRoot, input.stagingRoot, resolvedCommit);
}

export async function installPreparedAgentSkill(
  skillsDir: string,
  skillId: string,
  preparedDirectory: string,
  persist: () => void
): Promise<void> {
  await mkdir(skillsDir, { recursive: true, mode: 0o700 });
  const destination = path.join(skillsDir, skillId);
  const backup = path.join(skillsDir, `.replace-${skillId}-${randomUUID()}`);
  const existing = await lstat(destination).catch(() => null);
  if (existing) await rename(destination, backup);
  try {
    await rename(preparedDirectory, destination);
    persist();
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    if (existing) await rename(backup, destination);
    throw error;
  }
}

export async function removeInstalledAgentSkill(
  skillsDir: string,
  skillId: string,
  persist: () => void
): Promise<void> {
  const destination = path.join(skillsDir, skillId);
  const removed = path.join(skillsDir, `.delete-${skillId}-${randomUUID()}`);
  const existing = await lstat(destination).catch(() => null);
  if (existing) await rename(destination, removed);
  try {
    persist();
    await rm(removed, { recursive: true, force: true });
  } catch (error) {
    if (existing) await rename(removed, destination);
    throw error;
  }
}

export async function inspectProjectAgentSkills(projectSkillsDir: string): Promise<InspectedProjectSkill[]> {
  const root = await lstat(projectSkillsDir).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) return [];
  const skillFiles = await findSkillFiles(projectSkillsDir);
  return await Promise.all(skillFiles.map(async (skillFile) => {
    try {
      const manifest = await readSkillManifest(skillFile);
      return {
        name: manifest.name,
        description: manifest.description,
        path: path.relative(path.dirname(projectSkillsDir), skillFile).split(path.sep).join("/"),
        valid: true,
        diagnostics: []
      };
    } catch (error) {
      return {
        name: path.basename(path.dirname(skillFile)),
        description: "",
        path: path.relative(path.dirname(projectSkillsDir), skillFile).split(path.sep).join("/"),
        valid: false,
        diagnostics: [error instanceof Error ? error.message : String(error)]
      };
    }
  }));
}

async function prepareSkillFromTree(
  sourceRoot: string,
  stagingRoot: string,
  resolvedCommit: string | null
): Promise<PreparedAgentSkill> {
  const skillFiles = await findSkillFiles(sourceRoot);
  if (skillFiles.length !== 1) throw new Error("A managed Skill source must contain exactly one SKILL.md");
  const skillRoot = path.dirname(skillFiles[0]!);
  const manifest = await readSkillManifest(skillFiles[0]!);
  const prepared = path.join(stagingRoot, "prepared");
  await cp(skillRoot, prepared, {
    recursive: true,
    errorOnExist: true,
    filter: (candidate) => path.basename(candidate) !== ".git"
  });
  await validateSkillTree(prepared);
  return {
    directory: prepared,
    ...manifest,
    digest: await digestTree(prepared),
    diagnostics: [],
    resolvedCommit
  };
}

async function readSkillManifest(skillFile: string): Promise<{
  name: string;
  description: string;
  version: string | null;
}> {
  const raw = await readFile(skillFile, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("SKILL.md exceeds the 1 MiB limit");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match) throw new Error("SKILL.md requires YAML frontmatter");
  const frontmatter = parse(match[1]!) as unknown;
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error("SKILL.md frontmatter must be an object");
  }
  const record = frontmatter as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const version = typeof record.version === "string" && record.version.trim() ? record.version.trim() : null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(name) || name.includes("--")) {
    throw new Error("Skill name must use lowercase letters, numbers, and single hyphens");
  }
  if (!description || description.length > 1_024) throw new Error("Skill description must contain between 1 and 1024 characters");
  if (version && version.length > 128) throw new Error("Skill version cannot exceed 128 characters");
  return { name, description, version };
}

async function findSkillFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  let entriesVisited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    entriesVisited += entries.length;
    if (entriesVisited > MAX_SKILL_FILES) throw new Error("Skill source contains too many entries");
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      found.push(path.join(current, "SKILL.md"));
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Skill sources cannot contain symbolic links");
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
  return found;
}

export function validateGitTreeListing(listing: string): void {
  let files = 0;
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40,64})\t([\s\S]+)$/u.exec(entry);
    if (!match) throw new Error("Skill Git tree metadata could not be validated");
    const [, mode, type] = match;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error("Skill Git tree cannot contain links, submodules, or special files");
    }
    files += 1;
    if (files > MAX_SKILL_FILES) throw new Error("Skill Git tree contains too many files");
  }
}

async function validateSkillTree(root: string, ignoredNames: ReadonlySet<string> = new Set()): Promise<void> {
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error("Skill sources cannot contain symbolic links");
    if (metadata.isFile()) {
      files += 1;
      bytes += metadata.size;
      if (NESTED_ARCHIVE_PATTERN.test(current)) throw new Error("Nested archives are not allowed in managed Skills");
      if (files > MAX_SKILL_FILES) throw new Error("Skill contains too many files");
      if (bytes > MAX_EXPANDED_BYTES) throw new Error("Skill exceeds the expanded size limit");
      continue;
    }
    if (!metadata.isDirectory()) throw new Error("Skill sources cannot contain device or special files");
    const children = (await readdir(current)).filter((name) => !ignoredNames.has(name));
    pending.push(...children.map((name) => path.join(current, name)));
  }
}

async function digestTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  for (const file of files.toSorted()) {
    hash.update(path.relative(root, file).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function treeSize(root: string, stopAfter: number): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0 && total <= stopAfter) {
    const current = pending.pop()!;
    const metadata = await lstat(current);
    if (metadata.isFile()) total += metadata.size;
    else if (metadata.isDirectory()) pending.push(...(await readdir(current)).map((name) => path.join(current, name)));
  }
  return total;
}

function normalizeGitSubdirectory(value: string | null | undefined): string | null {
  const normalized = value?.trim().replaceAll("\\", "/").replace(/^\.\//u, "") || null;
  if (!normalized) return null;
  if (path.posix.isAbsolute(normalized) || normalized.includes("\0") || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("Skill Git subdirectory must stay inside the repository");
  }
  return normalized;
}

function zipExpandedBytes(listing: string): number {
  return listing.split(/\r?\n/u).reduce((total, line) => {
    const match = /^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+/u.exec(line);
    return total + (match ? Number(match[1]) : 0);
  }, 0);
}

function validateZipEntryTypes(listing: string, expectedEntries: number): void {
  const modes = listing.split(/\r?\n/u)
    .map((line) => /^([bcdlps-]).{9}\s/u.exec(line)?.[1])
    .filter((mode): mode is string => Boolean(mode));
  if (modes.length !== expectedEntries) {
    throw new Error("Skill ZIP entry metadata could not be validated");
  }
  if (modes.some((mode) => mode !== "-" && mode !== "d")) {
    throw new Error("Skill ZIP cannot contain links, devices, sockets, or other special files");
  }
}

async function runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await runCommand("git", args, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_LFS_SKIP_SMUDGE: "1"
  });
}

async function runCommand(
  command: string,
  args: string[],
  extraEnvironment: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      env: { PATH: process.env.PATH, LANG: "C", ...extraEnvironment }
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { stderr?: string; code?: string };
    if (failure.code === "ENOENT") throw new Error(`${command} is not installed`);
    throw new Error(failure.stderr?.trim() || failure.message || `${command} failed`);
  }
}
