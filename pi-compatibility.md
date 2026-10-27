# Pi compatibility

ZOS embeds Pi as an in-process SDK inside the systemd worker. Pi JSONL is the
conversation truth; SQLite owns durable scheduling, approvals, event
projection, and UI queries.

| Contract | Supported value |
| --- | --- |
| Pi package | `@earendil-works/pi-coding-agent` |
| Supported Pi version | `1.1.0` (exactly pinned) |
| Runtime | Node.js 22.12+ native process |
| Session ownership | One worker-hosted `AgentSession` per ZOS session |

## SDK construction

ZOS calls `createAgentSession()` with an explicit `cwd`, `agentDir`,
`ModelRuntime`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`,
tool allowlist, and custom ZOS file tools. Existing sessions reopen their
persisted JSONL with `SessionManager.open()`; new sessions use
`SessionManager.create()`.

The host depends on these `AgentSession` methods and properties:

- `prompt`, `steer`, `followUp`, `abort`, and `waitForIdle`
- `compact`, `setModel`, `setThinkingLevel`, and `getSessionStats`
- `subscribe`, `bindExtensions`, `dispose`, `sessionId`, `sessionFile`,
  `isIdle`, and `isStreaming`

`session.dispose()` is the terminal cleanup operation. ZOS unsubscribes first,
aborts an active run, then disposes the session. Extensions must treat
`session_shutdown` as idempotent and release session-scoped resources there.

## Event projection

The host consumes Pi session events and projects these stable ZOS event types:

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

One `ModelRuntime` is cached per persisted settings generation. A new ZOS
session binds to the current generation. A restored session retains its saved
provider, model, and generation; credentials from a newer generation are not
silently borrowed. Explicit `set_model` is the only operation that rebinds an
existing session to the current generation.

## MCP and tools

MCP is loaded through static extension factories for codemode, tool search,
and the single internal `zos` server. Direct and deferred tool names are
allowlisted. ZOS does not create Pi's local bash tool and `bash` must never be
present in the active tool list. Shell execution is available only through the
approval-gated `zos.shell.run` capability; disabling MCP removes shell access.

Legacy ZOS file tools, when enabled, are root-scoped implementations using the
NAS safety layer. They do not invoke a command shell.

## Resource policy

`DefaultResourceLoader` is configured with `noExtensions: true`; only bundled
extension factories can execute. Project skills, prompt templates, and context
files are disabled until the ZOS session is explicitly trusted. User and
project npm/binary extensions remain disabled even for trusted sessions.
Resource loader failures are projected as sanitized `resource_error` events.

## Packaging requirements

The Debian and Nix builds must include the exact Pi package and its transitive
runtime files under the bundled workspace `node_modules`. No runtime npm
discovery or installation is allowed. The compiled entry must retain the
static MCP/codemode/tool-search imports used by `packages/agent`.

## Upgrade checklist

1. Change the exact version in `packages/agent/package.json` and regenerate
   `package-lock.json`.
2. Update the supported version in this document.
3. Run the Pi compatibility contract test and the agent event/tool tests.
4. Verify session reopen, extension shutdown, MCP registration, resource trust,
   image-only messages, compaction, and command queue behavior.
5. Run `make ci` and validate a packaged worker restart against a persisted
   JSONL session before release.
