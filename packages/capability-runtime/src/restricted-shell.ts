import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CapabilityError, type JsonValue } from "@zos/capabilities";
import { getNasRoot, getRootReadiness } from "@zos/db";
import { resolveSafeExistingPath } from "@zos/nas-tools";
import type { NasRootRecord } from "@zos/shared";
import type { CapabilityDomainAdapter, PreparedCapabilityAction } from "./adapters.js";

const execFileAsync = promisify(execFile);
const COMMANDS = ["git", "rg", "find", "ls", "stat", "du", "df", "file", "sha256sum"] as const;
type RestrictedCommand = typeof COMMANDS[number];
const OUTPUT_LIMIT = 64 * 1024;

interface RestrictedShellPayload {
  rootId: string;
  command: RestrictedCommand;
  args: string[];
  cwd: string;
  timeoutMs: number;
  revision: string;
}

export function createRestrictedShellAdapter(): CapabilityDomainAdapter {
  return {
    availability: ({ config }) => config.mcp?.shellEnabled === true
      ? { available: true }
      : { available: false, reason: "Restricted shell is disabled by host configuration" },
    prepare: async (request, context) => {
      const parsed = await validateRequest(request, context.db, context.config.mcp?.shellEnabled === true);
      return {
        summary: `Run ${parsed.command} in ${parsed.cwd}`,
        target: { rootId: parsed.rootId, cwd: parsed.cwd },
        changes: { command: parsed.command, args: parsed.args, timeoutMs: parsed.timeoutMs },
        revision: parsed.revision,
        privatePayload: parsed as unknown as JsonValue
      };
    },
    revalidate: async (prepared, context) => {
      const payload = shellPayload(prepared);
      const current = await validateRequest(payload as unknown as JsonValue, context.db, context.config.mcp?.shellEnabled === true);
      if (current.revision !== payload.revision) {
        throw new CapabilityError("CONFLICT", "Shell working directory changed after approval was requested");
      }
    },
    execute: async (prepared, context) => {
      const payload = shellPayload(prepared);
      const root = requireReadyRoot(context.db, payload.rootId);
      const safe = await safeDirectory(root, payload.cwd);
      const invocation = commandInvocation(payload.command, payload.args);
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      let truncated = false;
      try {
        const result = await execFileAsync(invocation.command, invocation.args, {
          cwd: safe.realPath,
          timeout: payload.timeoutMs,
          maxBuffer: OUTPUT_LIMIT,
          encoding: "utf8",
          env: restrictedEnvironment(safe.realPath)
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number; killed?: boolean };
        if (failure.code === "ENOENT") {
          throw new CapabilityError("NOT_READY", `${payload.command} executable is unavailable`, { retryable: true });
        }
        if (failure.killed) throw new CapabilityError("RATE_LIMITED", "Restricted command exceeded its time limit", { retryable: true });
        stdout = typeof failure.stdout === "string" ? failure.stdout : "";
        stderr = typeof failure.stderr === "string" ? failure.stderr : "";
        truncated = Buffer.byteLength(stdout, "utf8") >= OUTPUT_LIMIT || Buffer.byteLength(stderr, "utf8") >= OUTPUT_LIMIT;
        exitCode = typeof failure.code === "number" ? failure.code : 1;
      }
      return {
        data: {
          command: payload.command,
          cwd: payload.cwd,
          exitCode,
          stdout: truncateUtf8(stdout, OUTPUT_LIMIT),
          stderr: truncateUtf8(stderr, OUTPUT_LIMIT),
          truncated
        }
      };
    }
  };
}

async function validateRequest(value: JsonValue, db: Parameters<typeof getNasRoot>[0], enabled: boolean): Promise<RestrictedShellPayload> {
  if (!enabled) throw new CapabilityError("NOT_READY", "Restricted shell is disabled by host configuration", { retryable: true });
  if (!isRecord(value)) throw new CapabilityError("INVALID_ARGUMENT", "Shell request must be an object");
  const allowedKeys = new Set(["rootId", "command", "args", "cwd", "timeoutMs", "revision"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new CapabilityError("INVALID_ARGUMENT", "Shell request contains unsupported fields");
  const rootId = requiredString(value.rootId, "rootId");
  const command = requiredString(value.command, "command");
  if (!COMMANDS.includes(command as RestrictedCommand)) throw new CapabilityError("INVALID_ARGUMENT", "Command is not in the read-only profile");
  const args = parseArgs(value.args);
  validateArguments(command as RestrictedCommand, args);
  const cwd = optionalString(value.cwd) ?? ".";
  const timeoutMs = boundedInteger(value.timeoutMs, 5_000, 100, 30_000);
  const root = requireReadyRoot(db, rootId);
  const safe = await safeDirectory(root, cwd);
  await validateExistingPathArguments(root, safe.realPath, command as RestrictedCommand, args);
  await requireExecutable(command as RestrictedCommand);
  const metadata = await stat(safe.realPath);
  const revision = createHash("sha256").update(JSON.stringify({
    rootId,
    command,
    args,
    cwd: safe.relativePath,
    ino: metadata.ino,
    mtimeMs: metadata.mtimeMs
  })).digest("base64url");
  return { rootId, command: command as RestrictedCommand, args, cwd: safe.relativePath, timeoutMs, revision };
}

function validateArguments(command: RestrictedCommand, args: string[]): void {
  for (const argument of args) {
    if (
      argument.includes("\0") || argument.includes("\n") || argument.includes("\r") ||
      /[|<>`]/u.test(argument) || argument.includes("$(") || argument.includes("${") ||
      path.isAbsolute(argument) || path.win32.isAbsolute(argument) ||
      argument.split(/[\\/]/u).some((segment) => segment === "..") ||
      /(?:^|=)(?:\/|[A-Za-z]:[\\/])/u.test(argument)
    ) {
      throw new CapabilityError("INVALID_ARGUMENT", "Shell arguments must not contain expansion, redirection, or escaping paths");
    }
  }
  if (command === "git") validateGit(args);
  if (command === "rg") denyOptions(args, ["--pre", "--pre-glob", "--follow", "-L", "--search-zip"]);
  if (command === "find") denyFind(args);
  if (command === "file") denyOptions(args, ["-L", "--dereference", "-f", "--files-from"]);
  if (command === "stat") denyOptions(args, ["-L", "--dereference"]);
  if (command === "du") denyOptions(args, ["-L", "-H", "--dereference", "--dereference-args", "--files0-from"]);
  if (command === "ls") denyOptions(args, ["-L", "--dereference", "--hyperlink"]);
  if (command === "sha256sum") denyOptions(args, ["-c", "--check"]);
}

function validateGit(args: string[]): void {
  const forbidden = [
    "-c", "--config-env", "--exec-path", "--git-dir", "--work-tree", "--namespace",
    "--global", "--system", "--local", "--file", "--blob", "--ext-diff", "--no-index",
    "--output", "--paginate"
  ];
  denyOptions(args, forbidden);
  const subcommand = args.find((argument) => !argument.startsWith("-"));
  if (!subcommand || !new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "grep"]).has(subcommand)) {
    throw new CapabilityError("INVALID_ARGUMENT", "Git command is not in the read-only profile");
  }
  if (subcommand === "branch" && args.some((argument) => ["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--edit-description", "--set-upstream-to", "--unset-upstream"].includes(argument))) {
    throw new CapabilityError("INVALID_ARGUMENT", "Git branch mutations are not allowed");
  }
  if (args.some((argument) => (
    argument === "--textconv" ||
    argument.startsWith("-O") ||
    argument === "--open-files-in-pager" ||
    argument.startsWith("--open-files-in-pager=") ||
    argument === "--show-toplevel" ||
    argument === "--show-superproject-working-tree" ||
    argument === "--git-path" ||
    argument.startsWith("--git-path=") ||
    argument === "--path-format" ||
    argument === "--path-format=absolute"
  ))) {
    throw new CapabilityError("INVALID_ARGUMENT", "Git option is not allowed by the read-only profile");
  }
}

function denyFind(args: string[]): void {
  denyOptions(args, ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls", "-L", "-H"]);
  if (args.some((argument) => argument === ";" || argument === "+")) {
    throw new CapabilityError("INVALID_ARGUMENT", "Find execution actions are not allowed");
  }
}

function denyOptions(args: string[], denied: string[]): void {
  if (args.some((argument) => denied.some((option) => argument === option || argument.startsWith(`${option}=`)))) {
    throw new CapabilityError("INVALID_ARGUMENT", "Command option is not allowed by the read-only profile");
  }
}

async function validateExistingPathArguments(root: NasRootRecord, cwd: string, command: RestrictedCommand, args: string[]): Promise<void> {
  let positionalIndex = 0;
  for (const argument of args) {
    if (argument.startsWith("-")) continue;
    positionalIndex += 1;
    if ((command === "git" && positionalIndex === 1) || (command === "rg" && positionalIndex === 1)) continue;
    if (command === "find" && ["true", "false"].includes(argument)) continue;
    const absolute = path.resolve(cwd, argument);
    try {
      await access(absolute);
    } catch {
      continue;
    }
    const relative = path.relative(root.path, absolute);
    const safe = await resolveSafeExistingPath(root.path, relative);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || path.resolve(safe.absolutePath) !== path.resolve(safe.realPath)) {
      throw new CapabilityError("INVALID_ARGUMENT", "Symbolic link command arguments are not supported");
    }
  }
}

function commandInvocation(command: RestrictedCommand, args: string[]): { command: string; args: string[] } {
  if (command === "git") {
    return {
      command,
      args: [
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.pager=cat",
        "-c", "pager.branch=false",
        "-c", "pager.diff=false",
        "-c", "pager.log=false",
        "-c", "diff.external=",
        "--no-optional-locks",
        ...args
      ]
    };
  }
  if (command === "find") return { command, args: [".", ...args] };
  if (command === "df" && args.length === 0) return { command, args: ["."] };
  return { command, args };
}

function shellPayload(prepared: PreparedCapabilityAction): RestrictedShellPayload {
  if (!isRecord(prepared.privatePayload)) throw new CapabilityError("INTERNAL", "Stored shell payload is invalid");
  const value = prepared.privatePayload;
  const rootId = requiredString(value.rootId, "rootId");
  const command = requiredString(value.command, "command");
  const cwd = requiredString(value.cwd, "cwd");
  const revision = requiredString(value.revision, "revision");
  if (!COMMANDS.includes(command as RestrictedCommand)) throw new CapabilityError("INTERNAL", "Stored shell command is invalid");
  return {
    rootId,
    command: command as RestrictedCommand,
    args: parseArgs(value.args),
    cwd,
    timeoutMs: boundedInteger(value.timeoutMs, 5_000, 100, 30_000),
    revision
  };
}

function requireReadyRoot(db: Parameters<typeof getNasRoot>[0], rootId: string): NasRootRecord {
  const root = getNasRoot(db, rootId);
  if (!root || !root.enabled) throw new CapabilityError("INVALID_ARGUMENT", "NAS root not found");
  if (root.mountPolicy === "required" && getRootReadiness(db, root.id)?.status !== "ready") {
    throw new CapabilityError("NOT_READY", "NAS root is not ready", { retryable: true });
  }
  return root;
}

async function safeDirectory(root: NasRootRecord, requestedPath: string) {
  try {
    const safe = await resolveSafeExistingPath(root.path, requestedPath);
    const metadata = await lstat(safe.absolutePath);
    if (!metadata.isDirectory()) throw new CapabilityError("INVALID_ARGUMENT", "Shell cwd must be a directory");
    if (metadata.isSymbolicLink() || path.resolve(safe.absolutePath) !== path.resolve(safe.realPath)) {
      throw new CapabilityError("INVALID_ARGUMENT", "Symbolic link working directories are not supported");
    }
    return safe;
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("INVALID_ARGUMENT", "Shell cwd is invalid or unavailable", { cause: error });
  }
}

async function requireExecutable(command: RestrictedCommand): Promise<void> {
  for (const directory of ["/usr/local/bin", "/usr/bin", "/bin"]) {
    try {
      await access(path.join(directory, command));
      return;
    } catch {
      // Try the next fixed executable directory.
    }
  }
  throw new CapabilityError("NOT_READY", `${command} executable is unavailable`, { retryable: true });
}

function restrictedEnvironment(cwd: string): NodeJS.ProcessEnv {
  return {
    HOME: cwd,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: "/tmp",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function truncateUtf8(value: string, bytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.byteLength <= bytes ? value : buffer.subarray(0, bytes).toString("utf8");
}

function parseArgs(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== "string" || item.length > 4096)) {
    throw new CapabilityError("INVALID_ARGUMENT", "args must be a bounded string array");
  }
  return value as string[];
}

function requiredString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CapabilityError("INVALID_ARGUMENT", `${field} is required`);
  return value.trim();
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedInteger(value: JsonValue | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CapabilityError("INVALID_ARGUMENT", `timeoutMs must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
