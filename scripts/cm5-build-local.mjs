import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { COMPONENTS } from "./cm5-runtime.mjs";

const RUST_VERSION = "1.95.0";
const DEFAULT_RUST_IMAGE = `rust:${RUST_VERSION}-bookworm`;

async function defaultRun(command, args, options = {}) {
  console.log(`+ ${command} ${args.map((value) => JSON.stringify(value)).join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit" });
    let stdout = "";
    if (options.capture) child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

async function output(run, command, args) {
  const result = await run(command, args, { capture: true });
  return (typeof result === "string" ? result : result?.stdout ?? "").trim();
}

async function checkArtifact(filePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) throw new Error(`Expected executable build artifact: ${filePath}`);
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(20);
    const { bytesRead } = await handle.read(bytes);
    if (bytesRead !== 20 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 183) {
      throw new Error(`Build artifact must be an arm64 Linux ELF executable: ${filePath}`);
    }
  } finally { await handle.close(); }
}

const buildScript = `
set -euo pipefail
export LC_ALL=C
case "$(rustc --version)" in
  "rustc 1.95.0 "*) ;;
  *) echo "Builder must use Rust 1.95.0" >&2; exit 1 ;;
esac
cargo_args=()
for name in "$@"; do cargo_args+=(-p "cyberos-$name" --bin "cyberos-$name"); done
cargo build --locked --release --target aarch64-unknown-linux-gnu "\${cargo_args[@]}"
for name in "$@"; do
  artifact="/target/aarch64-unknown-linux-gnu/release/cyberos-$name"
  readelf --file-header "$artifact" | grep -Eq 'Machine: +AArch64'
  versions="$(readelf --version-info "$artifact" | grep -oE 'GLIBC_[0-9]+\\.[0-9]+' | sort -Vu || true)"
  highest=none
  if [ -n "$versions" ]; then
    highest="$(printf '%s\\n' "$versions" | tail -n 1)"
    if [ "$(printf '%s\\n' "$highest" GLIBC_2.36 | sort -V | tail -n 1)" != GLIBC_2.36 ]; then
      echo "Unsupported libc requirement $highest in cyberos-$name; expected GLIBC <= 2.36" >&2
      exit 1
    fi
  fi
  file "$artifact"
  printf 'Validated cyberos-%s: AArch64, maximum glibc requirement %s\\n' "$name" "$highest"
  install -m 0755 "$artifact" "/output/cyberos-$name"
done
`;

/** Build native Linux artifacts on this Mac's local Docker engine only. */
export async function buildLocalRust({ repoRoot, names, outputRoot, run = defaultRun, env = process.env }) {
  if (!Array.isArray(names) || !names.length || names.some((name) => !Object.hasOwn(COMPONENTS, name) || COMPONENTS[name].kind !== "rust")) {
    throw new Error("Local Rust builder requires known Rust component names");
  }
  names = [...new Set(names)];
  repoRoot = await realpath(repoRoot);
  outputRoot = path.resolve(outputRoot);
  if ([repoRoot, outputRoot].some((value) => /[,\r\n\0]/u.test(value))) throw new Error("Docker bind mount paths cannot contain commas or newlines");
  if (repoRoot === outputRoot || repoRoot.startsWith(`${outputRoot}${path.sep}`)) throw new Error("Build output must be a dedicated artifact directory");
  const toolchain = await readFile(path.join(repoRoot, "rust-toolchain.toml"), "utf8");
  if (toolchain.match(/channel\s*=\s*"([^"]+)"/u)?.[1] !== RUST_VERSION) throw new Error(`Update the CM5 builder for the repository Rust toolchain; expected ${RUST_VERSION}`);
  const dockerfile = path.join(repoRoot, "scripts/cm5-builder.Dockerfile");
  const dockerfileContents = await readFile(dockerfile);
  const rustImage = env.CYBEROS_CM5_RUST_IMAGE || DEFAULT_RUST_IMAGE;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/u.test(rustImage)) throw new Error("Invalid CYBEROS_CM5_RUST_IMAGE reference");
  const context = await output(run, "docker", ["context", "show"]);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(context)) throw new Error("Cannot determine the current local Docker context");
  const endpoint = JSON.parse(await output(run, "docker", ["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"]));
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///")) throw new Error("CM5 builds require a local Docker context with a Unix socket; remote Docker engines are refused");
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  outputRoot = await realpath(outputRoot);
  // Remove only this invocation's known artifact names. A failed new build
  // must never be mistaken for a successful older cached output.
  for (const name of names) await rm(path.join(outputRoot, `cyberos-${name}`), { force: true });
  const contextArgs = ["--context", context];
  const imageHash = createHash("sha256").update(dockerfileContents).update(rustImage).digest("hex").slice(0, 16);
  const image = `cyberos-cm5-builder:${imageHash}`;
  await run("docker", [...contextArgs, "build", "--platform", "linux/arm64", "--file", dockerfile, "--tag", image,
    "--build-arg", `RUST_IMAGE=${rustImage}`, path.join(repoRoot, "scripts")]);
  const cacheKey = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  await run("docker", [...contextArgs, "run", "--rm", "--platform", "linux/arm64", "--cpus", "4", "--memory", "6g",
    "--mount", `type=bind,src=${repoRoot},dst=/source,readonly`,
    "--mount", `type=bind,src=${outputRoot},dst=/output`,
    "--mount", `type=volume,src=cyberos-cm5-cargo-${cacheKey},dst=/cargo`,
    "--mount", `type=volume,src=cyberos-cm5-target-${cacheKey},dst=/target`,
    "--env", "CARGO_BUILD_JOBS=4", "--workdir", "/source", image,
    "bash", "-c", buildScript, "cyberos-cm5-build", ...names]);
  const artifacts = {};
  for (const name of names) {
    const artifact = path.join(outputRoot, `cyberos-${name}`);
    await checkArtifact(artifact);
    artifacts[name] = artifact;
  }
  return artifacts;
}
