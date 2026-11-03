import assert from "node:assert/strict";
import console from "node:console";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { assertMinimumNodeVersion } from "./check-node-version.mjs";

// Run against the assembled package as well as a source installation. Importing
// the SDK alone misses the lazy codemode executor, worker and QuickJS WASM.
assertMinimumNodeVersion(process.versions.node);
const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const workerEntry = pathToFileURL(path.join(root, "apps/worker/dist/index.js"));
const packages = {};
for (const name of ["pi-coding-agent", "pi-mcp", "pi-codemode", "pi-agent-core", "pi-ai", "pi-tui", "pi-telemetry"]) {
  const manifest = findPackageJSON(`@earendil-works/${name}`, workerEntry);
  assert.ok(manifest, `Cannot resolve ${name} from the packaged worker`);
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(metadata.version, "1.4.0", `${name} has an unsupported runtime version`);
  assert.ok(path.relative(root, manifest).split(path.sep)[0] !== "..", `${name} resolves outside the runtime`);
  packages[name] = { manifest, metadata };
}
const apiMcp = findPackageJSON("@earendil-works/pi-mcp", pathToFileURL(path.join(root, "apps/api/dist/index.js")));
assert.equal(apiMcp, packages["pi-mcp"].manifest, "API and worker must share the same MCP runtime");
const sdk = packages["pi-coding-agent"];
const sdkEntry = sdk.metadata.exports["."].import;
const { createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(
  pathToFileURL(path.resolve(path.dirname(sdk.manifest), sdkEntry)).href
);
for (const factory of [createCodemodeExtension, createMcpExtension, createToolSearchExtension]) {
  assert.equal(typeof factory, "function", "A static CyberOS extension factory is missing");
}
const directory = await mkdtemp(path.join(os.tmpdir(), "cyberos-pi-runtime-"));
let session;
try {
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: path.join(directory, "models-store.json"), refreshOnCreate: false });
  modelRuntime.registerProvider("cyberos-package-probe", {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions",
    models: [{ id: "package-probe", name: "Package probe", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }]
  });
  const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "never" });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager, noExtensions: true,
    extensionFactories: [createCodemodeExtension({ mode: "on", models: false })],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true
  });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime,
    model: modelRuntime.getModel("cyberos-package-probe", "package-probe"),
    settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(directory), tools: ["codemode"] }));
  await session.bindExtensions({});
  assert.deepEqual(session.agent.state.tools.map((tool) => tool.name), ["codemode"]);
  const result = await session.agent.state.tools[0].execute("package-probe", {
    code: 'text("cyberos-pi-runtime-ok"); text(typeof models);'
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const output = JSON.stringify(result.content);
  assert.match(output, /cyberos-pi-runtime-ok/u);
  assert.match(output, /undefined/u);
  console.log(JSON.stringify({ version: "1.4.0", node: process.versions.node,
    sdk: path.relative(root, sdk.manifest), mcp: path.relative(root, apiMcp), codemode: "ok", models: false }));
} finally {
  session?.dispose();
  await rm(directory, { recursive: true, force: true });
}
