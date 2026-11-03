# Pi compatibility

CyberOS embeds Pi as an in-process SDK inside the systemd worker. Pi JSONL is the
conversation truth; SQLite owns durable scheduling, approvals, event
projection, and UI queries.

| Contract | Supported value |
| --- | --- |
| Pi package | `@earendil-works/pi-coding-agent` |
| Supported Pi version | `1.4.0` (exactly pinned) |
| Pi MCP version | `1.4.0` in both Agent and API workspaces |
| Runtime | Node.js 22.19.0+ native process |
| Session ownership | One worker-hosted `AgentSession` per CyberOS session |

## SDK construction

CyberOS calls `createAgentSession()` with an explicit `cwd`, `agentDir`,
`ModelRuntime`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`,
tool allowlist, and no custom direct file tools. Existing sessions reopen their
persisted JSONL with `SessionManager.open()`; new sessions use
`SessionManager.create()`.

The host depends on these `AgentSession` methods and properties:

- `prompt`, `steer`, `followUp`, `abort`, and `waitForIdle`
- `compact`, `setModel`, `setThinkingLevel`, and `getSessionStats`
- `subscribe`, `bindExtensions`, `dispose`, `sessionId`, `sessionFile`,
  `isIdle`, and `isStreaming`

`session.dispose()` is the terminal cleanup operation. CyberOS unsubscribes first,
aborts an active run, then disposes the session. Extensions must treat
`session_shutdown` as idempotent and release session-scoped resources there.

## Event projection

The host consumes Pi session events and projects these stable CyberOS event types:

- `turn_start`, `turn_end`, and `agent_end`
- `message_start`, `message_update`, and `message_end`
- `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`
- `compaction_start`, `compaction_end`, `model_change`, and
  `thinking_level_change`

Every projected event uses schema version 1 plus `sessionId`, `jobId`, `runId`,
`sequence`, `source`, and `sourceId`. `(session_id, source, source_id)` is the
idempotency key. Final assistant messages are separately projected to
`agent.message` for transcript hydration.

`agent_provider_sessions.projection_cursor` advances only after a persisted Pi
entry has been projected. Reopening a session replays entries after that cursor;
stable entry and tool source ids make replay idempotent if a worker stopped
between JSONL persistence, SQLite projection, and cursor advancement.

When upgrading Pi, verify the `message_update` payload still exposes
`assistantMessageEvent`, tool completion still exposes `toolCallId`,
`toolName`, `result`, and `isError`, and model-change entries still expose a
stable entry id.

## Model runtime and sessions

One `ModelRuntime` is cached per persisted settings generation. A new CyberOS
session binds to the current generation. A restored session retains its saved
provider, model, and generation; credentials from a newer generation are not
silently borrowed. Explicit `set_model` is the only operation that rebinds an
existing session to the current generation.

## MCP and tools

MCP is loaded through static extension factories for codemode, tool search,
the internal `cyberos` server, and explicitly configured third-party servers. Direct and deferred tool names are
allowlisted. CyberOS does not create Pi's local bash tool and `bash` must never be
present in the active tool list. Shell execution is available only through the
approval-gated `cyberos.shell.run` capability; disabling MCP removes shell access.

CyberOS exposes file, photo, and system capabilities only through the internal
`cyberos` MCP server. Disabling MCP removes those tools instead of enabling a
direct-tool fallback.

MCP `structuredContent` may be any JSON value, including arrays and `null`.
Approval detection only accepts an object with a run id and
`data.state = "waiting_approval"`; unrelated structured results are not approvals.

Codemode keeps `models: false` and the upstream limit of two live workers per
worker process. At capacity, scripts queue for at most 60 seconds or their own
deadline, whichever is sooner. Cancelling a queued script must prevent execution.
`PI_CODEMODE_MAX_WORKERS` is an explicit administrator override, not a default
CyberOS concurrency increase.

Pi 1.4 counts session startup as busy, including `before_agent_start` handlers.
Those handlers now discriminate user and custom messages with `messageType`.
CyberOS has no custom handler to migrate, but abort/steer/follow-up startup races
remain part of the worker compatibility tests.

Compaction summaries use the model's output limit. `compaction.reserveTokens`
controls when compaction starts, not the summary output limit. No classifier,
image-model, new provider, or telemetry integration is enabled by this upgrade.

## Resource policy

`DefaultResourceLoader` is configured with `noExtensions: true`; only bundled
extension factories can execute. Project skills, prompt templates, and context
files are disabled until the CyberOS session is explicitly trusted. User and
project npm/binary extensions remain disabled even for trusted sessions.
Resource loader failures are projected as sanitized `resource_error` events.

## Packaging requirements

The Debian build must include the exact Pi package and its transitive
runtime files under the bundled workspace `node_modules`. No runtime npm
discovery or installation is allowed. The compiled entry must retain the
static MCP/codemode/tool-search imports used by `packages/agent`.
The compatibility test resolves installed manifests from each consuming
workspace and compares their actual installation paths with the lockfile;
it does not assume npm always hoists the SDK to a particular directory.
The 1.4 lockfile installs the SDK under root `node_modules`, including its
nested dependencies. Debian assembly relocates that complete SDK directory to
the existing packaged workspace path and preserves the root SDK symlink. This
avoids a symlink-to-directory transition when upgrading an installed 1.1 SDK.
Debian assembly runs `scripts/verify-pi-runtime.mjs` against the staged tree to
check all Pi versions, shared API/worker MCP resolution, and execute codemode
through its lazy executor, worker and QuickJS WASM. The installed check can be
repeated with `node /usr/lib/cyberos/scripts/verify-pi-runtime.mjs`.

Pi 1.1 and 1.4 both use session format 3. A checked-in JSONL fixture generated
with 1.1 verifies restoration without changing entry ids or public projection
identities. No CyberOS database migration is required for this upgrade.

## Upgrade checklist

1. Change the exact SDK and MCP versions in `packages/agent/package.json` and
   `packages/api/package.json`, then regenerate `package-lock.json`.
2. Update the supported version in this document.
3. Run the Pi compatibility contract test and the agent event/tool tests.
4. Verify session reopen, extension shutdown, MCP registration, resource trust,
   image-only messages, compaction, and command queue behavior.
5. Run `make ci`, then build and inspect the Debian package, including its Pi
   executor, QuickJS WASM, and nested runtime dependencies.
6. Use the package upgrade procedure for dependency changes. Save the previous
   package and state, quiesce writers, install the new package, and verify the
   API/worker, persisted JSONL sessions, capability approvals, and service
   restart stability before restoring scheduled tasks. A component swap is not
   a supported way to upgrade Pi.
