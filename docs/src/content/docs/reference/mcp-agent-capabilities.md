---
title: MCP and agent capabilities
description: Pair MCP clients, expose ZOS capabilities safely, and operate durable approval-gated runs.
type: reference
status: current
audience: [developer, operator]
sourceOfTruth:
  - packages/capabilities/src/registry.ts
  - packages/capability-runtime/src/orchestrator.ts
  - packages/mcp/src/server.ts
  - packages/mcp-cli/src/index.ts
  - packages/api/src/server.ts
  - packages/api/src/routes/settings.ts
  - packages/api/src/lib/agent-mcp-settings.ts
  - packages/worker/src/processor.ts
  - packaging/scripts/zos-mcp
---

ZOS exposes its agent capability registry as stateless Streamable HTTP at
`/mcp`. The API process remains bound to loopback. The normal LAN HTTP listener
returns `404` for `/mcp`; external MCP access uses a separate TLS listener.

## Enablement

The relevant configuration flags are:

```toml
[mcp]
enabled = true
pi_enabled = false
external_enabled = false
shell_enabled = false
```

Keep `external_enabled` and `shell_enabled` disabled until their prerequisites
are configured. `enabled` remains the host-level gate. `pi_enabled` is the
bootstrap default used only until an Agent MCP preference is saved in SQLite.

The normal enablement path is **Settings > Agents > Use ZOS MCP**. Enabling the
switch creates or repairs the protected `Built-in Pi` identity, writes its
token with mode `0600`, and applies to newly claimed Agent jobs without a
service restart. Disabling the switch stops MCP injection but preserves the
paired credential so it can be enabled again without rotation.

## Pair a client

`zos-mcp` is root-only. Tokens contain 256 bits of random material, are printed
once, and are stored in SQLite only as SHA-256 digests.

```bash
sudo zos-mcp client create \
  --name "Studio Agent" \
  --kind lan \
  --scopes zos:catalog:read,zos:files:read,zos:files:propose,zos:runs:read

sudo zos-mcp client list
sudo zos-mcp client rotate CLIENT_ID
sudo zos-mcp client revoke CLIENT_ID
```

Read scopes use `zos:<domain>:read`; mutation proposal scopes use
`zos:<domain>:propose`. Shell and power use the separate
`zos:admin:shell` and `zos:admin:power` scopes. Tool discovery is filtered by
scope and every invocation checks scope again.

For recovery or headless setup, create the protected Pi identity with the CLI.
The command writes its token to the configured file with mode `0600`:

```bash
sudo zos-mcp client create --name "Built-in Pi" --kind pi
```

After manual pairing, enable Agent MCP in the Web UI. A fully headless setup may
instead set `pi_enabled = true` and restart `zos-api.service` and the worker
services. Set `legacy_pi_tools_enabled = true` only for temporary rollback.

## LAN TLS

Create at least one LAN client, then generate a private CA and the dedicated
Nginx listener:

```bash
sudo zos-mcp tls init --hostname zos.local --port 8443
```

The command prints the HTTPS MCP URL, CA certificate path, and SHA-256 CA
fingerprint. Install the CA certificate in the client trust store, enable
`external_enabled`, and restart `zos-api.service`. The TLS listener proxies only
`/mcp` and `/mcp-transfer/`; it does not expose the loopback REST API.

To use an existing certificate instead of the ZOS private CA, provide a
hostname-matching certificate and private key. `--ca` is optional for a
publicly trusted chain and controls whether a CA path/fingerprint is returned:

```bash
sudo zos-mcp tls init --hostname nas.example.lan --port 8443 \
  --cert /root/tls/fullchain.pem --key /root/tls/privkey.pem \
  --ca /root/tls/ca.pem
```

## Runs and approval

For the protected Pi identity, file list, stat, read, and search follow the
Agent capability policy. `auto` returns a bounded structured result;
`approve` and `confirm` create an immutable durable run in
`waiting_approval`; `disabled` removes the capability. File resource links are
available to Pi only when read access is `auto`, so they cannot bypass a read
approval. Pi file mutations always create an immutable approval proposal.

Only capability requests linked to a Pi Agent job appear in the first-party
Web UI. Workspace REST operations and non-Pi MCP clients do not create
approval state. The approval card shows the client, capability, target, risk,
revision, expiry, and a bounded secret-redacted action preview. MCP has no
approval tool. Approval rechecks the Agent policy, client, scope, NAS
readiness, path, and proposal revision before executing once.

Clients can inspect the same run through `zos.runs.get`, `zos.runs.list`, and
`zos.runs.wait`. `zos.runs.cancel` is an owner-scoped safety control: it only
cancels an interruptible run owned by the same client and does not create
another approval loop. The MCP 2.3.1 SDK
keeps Tasks as wire types without a server runtime, and the 2026 protocol era
does not advertise the older Tasks surface. ZOS therefore uses the durable run
tools as the interoperable projection for both supported protocol eras.

Large files are returned as 60-second, one-time `/mcp-transfer/` links bound to
the paired client. LAN links are HTTPS and require the same bearer token.

## Operational checks

```bash
sudo systemctl restart zos-api.service zos-worker@1.service
sudo journalctl -u zos-api.service -u zos-worker@1.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/health
```

Never place bearer tokens, Wi-Fi keys, registry passwords, SMTP credentials or
model API keys in tool input, logs, or chat transcripts. Credential-bearing
changes must be completed in the first-party UI.
