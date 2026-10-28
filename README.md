<p align="center">
  <img src="packages/web/public/cyberos-icon.svg" alt="CyberOS logo" width="96" height="96">
</p>

<h1 align="center">CyberOS</h1>

<p align="center">
  A local-first Linux NAS appliance with a web workspace, approval-gated AI operations, search, and host management.
</p>

CyberOS is a single-user control plane for a personal Linux NAS. It combines a responsive file workspace with an AI agent, keeps state in a local SQLite database, and runs as a set of native `systemd` services instead of inside containers.

The project combines a strict TypeScript npm-workspaces application with Rust storage daemons. Its production target is Node.js 22 and Rust 1.95 on Debian-based systems, with a React/Vite frontend and a Fastify API.

## Project status

CyberOS 2.0.0 is a clean-install release. It does not import earlier product data, configuration, backups, users, paths, or service state. The file and photo workspaces, agent job pipeline, approvals, indexing, Docker controls, share configuration, Debian packaging, and scheduled maintenance paths are implemented.

The following surfaces are intentionally limited today:

- Virtual machine management supports libvirt/QEMU host discovery and approval-gated lifecycle operations when the optional runtime is installed.
- Network inspection remains available on every supported backend; NetworkManager Wi-Fi/hotspot changes and approved storage-pool operations are applied through `cyberos-hostd` when their host dependencies are available.
- OCR is opt-in per storage pool and is limited to scanned PDFs with insufficient embedded text.
- Local restic backup is opt-in; after explicit repository initialization, daily/weekly services perform encrypted snapshots and staging-only restore.

## What is implemented

### File workspace

- Browse multiple configured storage pools with breadcrumb navigation and Git status indicators.
- Search the SQLite FTS index with a filesystem name-search fallback.
- Incrementally refresh the index from file size and modification time without following symbolic links.
- Preview text, source code, Markdown, CSV/TSV, images, audio, video, and PDF files.
- Transcode unsupported browser video containers to a local MP4 cache with FFmpeg.
- Edit bounded text files with modification-time conflict detection.
- Upload files and folders, including drag-and-drop batches with progress and cancellation.
- Extract ZIP, TAR, TAR.GZ, GZIP, and RAR archives with traversal, symlink, entry-count, and expanded-size checks.
- Propose folder creation, rename, move, copy, and trash operations for explicit approval.
- Review operation history, restore quarantined files, and roll back supported operations.

### AI workspace

- Persistent chat sessions scoped to a storage pool, with independent workspace navigation state.
- A database-backed job queue processed by a separate worker.
- Pi agent integration with OpenAI, Anthropic, and compatible custom base URLs.
- Streaming job and tool activity over Server-Sent Events.
- Per-tool policy controls for `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`.
- Approval records for dangerous Pi tool calls before execution.

### Photos library

- Bind one directory on a mounted storage pool and index common images, videos, and RAW camera files recursively.
- Build a chronological EXIF-first media timeline with cached WebP thumbnails and previews, plus in-panel video playback.
- Upload with SHA-256 duplicate detection, view metadata, download originals or ZIP selections, and request approval-gated batch move/trash operations.
- Run resumable immediate and periodic scans in the non-root internal Rust `photos` daemon, with worker heartbeats, bounded media tools, and journaled derivative publication.

### Host management

- Read-only CPU, memory, process, runtime, storage, SMART, RAID, mount, and network reporting.
- A local PTY terminal over WebSocket using a separately configured non-root host user (the API remains `cyberos`).
- Optional Docker Engine and Compose discovery, metrics, logs, lifecycle actions, direct container/volume/network creation, and one-time approved console sessions.
- Approval-gated SMB, WebDAV, FTP, NFS, and DLNA share configuration through the privileged Rust `cyberos-hostd` daemon.
- English and Simplified Chinese UI, a unified dark HUD theme, preview limits, and editor font settings.

### Native services

- Debian package definitions for `amd64` and `arm64` release artifacts.
- Hardened `systemd` units for the API, Rust monitor/alerter, worker, indexer, one-shot operations, and `cyberos-hostd`.
- Timers for daily/weekly restic backups, health evaluation every 15 minutes, and maintenance at 04:30; the resident indexer reconciles internally every 30 minutes.

## Architecture

```mermaid
flowchart LR
  Browser["React / Vite web UI"]
  API["Fastify API"]
  DB[("SQLite WAL + FTS5")]
  Metrics[("Metrics SQLite raw / 1m / 1h")]
  Worker["Agent worker"]
  PhotoWorker["Photos worker (photos)"]
  Agent["Pi agent runtime"]
  Indexer["Filesystem indexer"]
  Ops["Ops health / maintenance"]
  Monitor["Host and CyberOS monitor"]
  Alerter["Alert evaluator and mail outbox"]
  Tools["Path-safe storage tools"]
  Roots[("Configured storage pools")]
  Host["Linux, PTY, Docker socket"]
  Hostd["Rust host integration daemon"]

  Browser -->|REST| API
  API -->|SSE events| Browser
  Browser <-->|WebSocket terminal / console| API
  API <--> DB
  API --> Metrics
  Worker <--> DB
  Worker --> Agent
  PhotoWorker <--> DB
  PhotoWorker --> Roots
  Agent --> Tools
  API --> Tools
  Tools <--> Roots
  Indexer --> Roots
  Indexer --> DB
  Ops --> DB
  Monitor --> Metrics
  Monitor --> DB
  Monitor --> Host
  Alerter --> Metrics
  Alerter <--> DB
  API --> Host
  API -->|Terminal Protocol v1 over Unix socket| Terminal[terminal daemon]
  Terminal -->|PTY as cyberos user| Host
  API -->|JSONL Unix socket| Hostd
  Hostd --> Host
```

The main runtime components are:

| Component | Responsibility |
| --- | --- |
| `packages/web` | React 19 workspace UI, previews, settings, activity, and management panels. |
| `packages/api` | REST API, SSE event feed, WebSocket terminals, static production UI, and approved operation execution. |
| `packages/worker` | Claims queued jobs, runs agent turns, persists events, and pauses work for approvals. |
| `crates/photos` | Rust media worker with resumable scans, metadata extraction, and journaled image derivatives. |
| `crates/indexer` | Walks storage pools, hashes files, extracts bounded text, and maintains the FTS index. |
| `packages/ops` | Runs one-shot health evaluation and safe maintenance with persisted lifecycle history. |
| `crates/monitor` | Rust metrics collector: collection, rollups, retention, and metrics database capacity protection. |
| `crates/alerter` | Rust alert engine: rule evaluation, incidents, escalation, health synchronization, and mail delivery. |
| `crates/monitoring-contracts` | Shared Rust metric catalog, schema version, and sampling cadence contract. |
| `crates/hostd` | Rust host integration daemon for approved shares, storage, Docker daemon, and NetworkManager changes. |
| `crates/terminal` | Rust terminal daemon for native PTYs and persistent tmux sessions under the non-root `cyberos` account. |
| `packages/agent` | Pi SDK integration, storage-pool-scoped tools, session persistence, and tool policy enforcement. |
| `packages/db` | SQLite connection, migrations, repositories, job queue, approvals, operations, and FTS queries. |
| `packages/monitoring` | Language-neutral metric contracts plus TypeScript read-only metrics queries. |
| `packages/storage-tools` | Storage-pool-relative path validation, symlink escape protection, file reads, metadata, and mutations. |
| `packages/shared` | Configuration loading and shared domain/API types. |

### Agent and approval flow

1. The browser creates a session message through the API.
2. The API stores the message and a queued job in SQLite.
3. The worker claims the job and starts a Pi agent turn scoped to the selected storage pool.
4. Agent and tool events are appended to SQLite and streamed to the browser over SSE.
5. A policy-gated tool call or proposed mutation creates a pending approval and pauses execution.
6. The API applies or rejects the operation after the user acts, then records the outcome for audit and rollback.

File operations proposed through the workspace or agent, Pi tool calls, Docker lifecycle/Compose operations, and share-service changes use this approval path. Docker resource creation from the management panel executes after final confirmation and is recorded in operation history; direct UI uploads, text saves, and archive extraction are also path-checked and recorded.

## Security model

CyberOS currently assumes a trusted, single-user appliance. It has no multi-user authentication boundary and binds the API to `127.0.0.1` by default. Do not expose it directly to an untrusted network.

- Every NAS file path is resolved relative to a selected storage pool; absolute paths, traversal, and unsafe symlink escapes are rejected.
- File-oriented agent tools use storage-pool-scoped CyberOS wrappers. The `bash` tool is a real service-account shell, is always approval-gated, and is not a filesystem sandbox.
- Write-capable Pi tools default to approval or disabled policies, configurable from the UI.
- Approved file changes are audited. Trash uses a CyberOS-managed quarantine area and is not permanently deleted during maintenance.
- Docker management is disabled by default. Access to `/var/run/docker.sock` is effectively root-equivalent.
- The local terminal is a real interactive login shell running through Rust `crates/terminal` as the non-root `cyberos` user. The API service also runs as `cyberos`; `NoNewPrivileges` and an empty capability set prevent terminal `sudo` escalation.
- Privileged host changes are isolated in Rust `crates/hostd`, which accepts versioned JSONL requests over an authenticated Unix socket and only performs allowlisted operations.

Storage pools are discovered from real directories directly below `/cyberos/data` (or the development `CYBEROS_ROOT/data`). There is no implicit pool or host-filesystem fallback.

## Requirements

For application development:

- Node.js 22 or newer
- npm (the version bundled with Node.js 22 is supported)
- Rust 1.95.0 (pinned by `rust-toolchain.toml`)
- A compiler toolchain supported by the native `better-sqlite3` dependency when a prebuilt binary is unavailable

Optional host tools enable additional features:

| Feature | Host dependencies |
| --- | --- |
| Git status | `git` |
| Video thumbnails and playback | `ffmpeg` |
| RAW photo thumbnails and previews | `libraw-bin` (`dcraw_emu`) |
| HEIC/HEIF photos | `libheif-examples` (`heif-convert`) |
| Archive extraction | `gzip`, `unzip`, `tar`, `bsdtar`, or `unrar` as appropriate |
| Storage and network inspection | `ip`, `lsblk`, `findmnt`, `mdadm`, `smartctl` |
| Share management | Samba, Apache WebDAV, vsftpd, NFS server, MiniDLNA, and the packaged `cyberos-hostd` daemon |
| Docker management | Docker Engine socket access and the Docker CLI for Compose actions; enable explicitly on an appliance |
| Virtual machines | `libvirt-daemon-system`, `libvirt-clients`, `qemu-system-arm` and `qemu-efi-aarch64` (arm64) or `qemu-system-x86` (amd64), `qemu-utils`, `virtinst`, and `ipxe-qemu` |

## Local development

Install dependencies, create an isolated development storage pool, and export the configuration read by the Node.js processes:

```bash
npm install
mkdir -p .cyberos/dev-root/data/pool-1
export CYBEROS_ROOT="$PWD/.cyberos/dev-root"
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite proxies `/api`, `/health`, and WebSocket traffic to the API at `127.0.0.1:3010`.

`npm run dev` starts the API, agent worker, internal Rust `photos`, Rust downloader, Rust VOD player, and web UI. The Rust services use the API-owned TypeScript migrations and wait for their required schema versions before claiming work. The indexer and one-shot operations remain explicit during development:

```bash
npm run index
npm run health
npm run maintenance
```

The Starlight documentation site is built separately with `npm run docs:build` and is served by the production API at `http://127.0.0.1:3010/docs/` when its static output is present. Use `npm run docs:dev` for the standalone documentation development server.

The packaged Rust `cyberos-indexer.service` is resident: filesystem events and mutation queues normally make changes searchable within seconds, while a full reconciliation runs every 30 minutes. Run `npm run index` for a one-shot development refresh. A failed extraction retains its last successful body, and an incomplete traversal never removes stale entries that could not be verified.

Inspect the latest run for every storage pool, or one pool, through the read-only status endpoint:

```bash
curl http://127.0.0.1:3010/api/indexer/status
curl "http://127.0.0.1:3010/api/indexer/status?storagePoolId=dev"
```

Status responses include scan metrics and storage-pool-relative failures plus daemon heartbeat, watcher, durable queue, and schema rebuild state. Symbolic links are always skipped. Text, PDF, DOCX, XLSX, PPTX and explicitly enabled per-pool PDF OCR extraction feed the FTS5 search index.

Configure an OpenAI or Anthropic provider, model, and API key in **Settings > Model Providers** before starting an AI turn. Provider secrets are stored in the local SQLite database; API reads only report whether a key is configured.

The backend reads process environment variables directly; `.env.example` is a reference file and is not automatically loaded by the Node.js services.

## Configuration

Production services read TOML from the fixed path `/cyberos/config/config.toml`. Development can override the location with `CYBEROS_CONFIG`. See [`config.example.toml`](config.example.toml) and [`packaging/etc/config.toml`](packaging/etc/config.toml) for the supported baseline.

A minimal configuration is:

```toml
root_dir = "/cyberos"
environment = "production"

[api]
host = "127.0.0.1"
port = 3010
allowed_origins = []

[worker]
poll_ms = 750
concurrency = 2

[docker]
enabled = false
socket_path = "/var/run/docker.sock"
compose_command = "docker"
operation_timeout_ms = 120000
console_shells = ["/bin/sh", "/bin/bash"]

[hostd]
socket_path = "/run/cyberos/hostd.sock"

[shares]
enabled = false
account_username = "cyberos-share"

```

Environment variables override the corresponding TOML values. The most useful development overrides are `CYBEROS_ROOT`, `CYBEROS_API_HOST`, `CYBEROS_API_PORT`, `CYBEROS_ALLOWED_ORIGINS`, and the `CYBEROS_DOCKER_*` variables documented in [`.env.example`](.env.example). `CYBEROS_DATA_DIR` and `CYBEROS_DATABASE_PATH` are intentionally unsupported because state is derived from the single CyberOS root.

## Build and verification

### P0 operations

Production mode requires loopback API binding, the exact root `/cyberos`, and mounted storage pools as direct children of `/cyberos/data`. The indexer records progress, failures and readiness in the main SQLite database. The monitor writes host and CyberOS time series only to `/cyberos/state/metrics.sqlite`; the alerter reads those metrics and stores configuration, incidents, and its mail outbox in `cyberos.sqlite`. Inspect the system with `/api/indexer/status`, `/api/system/storage`, `/api/system/health`, `/api/monitoring/overview`, and `/api/monitoring/alerts/summary`.

Local restic backup is opt-in. Configure a repository and protected password file, run `backup validate`, then explicitly run `backup init`. Daily and weekly timers never initialize repositories implicitly. Restore always writes to isolated staging and never promotes over an active storage pool.

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

CyberOS uses one SemVer across the root manifest, application and package workspaces, Cargo crates, docs, and Debian package. Prepare a release from a clean worktree with:

```bash
npm run release -- patch --note "Describe the operator-visible change"
```

Use `minor` or `major` when appropriate. The command only updates version sources and the Debian changelog; it does not commit, tag, push, or publish. Review and commit the resulting diff, create the matching `v<version>` tag separately, and use `npm run version:check` to validate consistency. Runtime, configuration, script, and packaging changes require a monotonic version bump relative to the comparison base; documentation, tests, and CI-only changes may share the next product release.

Every build writes `.cyberos/build-info.json` with the product version, commit SHA, tag or branch, build time, build source, and dirty state. The API exposes the public subset at `/api/system/build-info`, and the web UI shows it under Settings > Version. Debian packages install the immutable metadata at `/usr/lib/cyberos/build-info.json`.

The equivalent Make targets are available through `make check` and `make ci`. The production API serves `packages/web/dist` when it is present, so a source build can be run with the API and worker in separate shells:

```bash
npm run start -w @cyberos/api
npm run start -w @cyberos/worker
```

## Debian package

On a Debian or Ubuntu build host with Node.js 22, `build-essential`, `debhelper`, `dpkg-dev`, `fakeroot`, and `rsync` installed:

```bash
make deb
```

Package artifacts are written under `.cyberos/`. The package installs the built applications under `/usr/lib/cyberos`, configuration under `/cyberos/config`, persistent state under `/cyberos/state`, and the service units under `/lib/systemd/system`.

Tagged releases publish `amd64` and `arm64` Debian artifacts with checksums through GitHub Actions.

### Install on a Raspberry Pi OS or Debian host

For an `arm64` CM5 (or an `amd64` Debian host), run the host installer from a checkout as root:

```bash
sudo packaging/scripts/install.sh
```

The installer checks the Debian architecture, switches Debian and Raspberry Pi APT entries to domestic mirrors, installs Node.js 22 from the verified Aliyun Node.js release mirror when needed, installs the pinned Rust 1.95.0 toolchain through rustup, and configures npm to use `https://registry.npmmirror.com`. It then builds the package on the target host and initializes first-boot configuration only for a new installation. Building on the target keeps the Rust daemons, `better-sqlite3`, and OCR helpers compatible with the board. It starts the CyberOS API, monitor, alerter, worker, hostd, terminal, downloader, indexer, and an Nginx reverse proxy on port 80 by default; maintenance, health, and backup timers remain scheduled tasks. The API remains loopback-only and Nginx is the LAN entry point.

The mirror defaults can be overridden for a private mirror or restored to another mirror with `CYBEROS_APT_MIRROR`, `CYBEROS_APT_SECURITY_MIRROR`, `CYBEROS_RPI_MIRROR`, `CYBEROS_NODE_MIRROR`, `CYBEROS_NODE_VERSION`, and `CYBEROS_NPM_REGISTRY`. The installer only rewrites known Debian/Raspberry Pi URIs, saves original source files under `/cyberos/system-backups/apt`, preserves `signed-by`, suites, components, and unrelated sources, and disables any NodeSource entry after switching to the domestic Node.js binary distribution. To restore an original source, copy its backup from `/cyberos/system-backups/apt` back to `/etc/apt/sources.list.d` (or uncomment the marked NodeSource line) before running the installer again with an explicit `CYBEROS_NODE_MIRROR`.

The installer also normalizes the host locale to `C.UTF-8` by default and stops OpenSSH from accepting invalid wildcard `LC_*` values from clients, such as `LC_CTYPE=UTF-8`. Original locale and SSH configuration files are saved under `/cyberos/system-backups`; override the default with `CYBEROS_LOCALE` when a generated locale is available.

Set `CYBEROS_NGINX_PORT` to choose another listener port, or set `CYBEROS_ENABLE_NGINX=0` to keep the API loopback-only and skip Nginx installation.

Docker and VM runtimes are opt-in because Docker socket access is root-equivalent. Enable both during installation with `CYBEROS_ENABLE_DOCKER=1 CYBEROS_ENABLE_VM=1`; the installer installs the Docker engine, CLI, Compose plugin, and matching QEMU/libvirt packages, writes the feature flags, refreshes API access to the `docker`, `libvirt`, and `kvm` groups, grants the CyberOS service account the non-interactive libvirt polkit action, starts the runtime services, and autostarts the standard libvirt `default` NAT network when it is available.

Optional integrations are listed as Debian `Suggests` rather than hard dependencies. The package includes the required `ffmpeg` and `libraw-bin` media tools; install other host tools you need (for example `git`, `restic`, Samba, or NFS) separately. The core package does not enable optional services implicitly.

## Repository layout

```text
crates/
  alerter/         Alert evaluation and mail delivery
  bluetoothd/      Non-root Bluetooth media and transfer service
  downloader/      HTTP download worker
  host-accessd/    Restricted Docker host-observation proxy
  hostd/           Privileged host integration daemon
  indexer/         NAS scanner and SQLite FTS indexer
  monitor/         Host and CyberOS metrics collector
  photos/      Photo and video indexing worker
  terminald/        PTY daemon with tmux-backed terminal persistence
  vod-player/      HDMI/DRM playback daemon
packages/
  api/            Fastify API and host adapters
  agent/          Pi runtime and policy-gated tools
  backup/         Restic validate, backup, check, and staging restore CLI
  db/             SQLite schema and repositories
  mcp*/            MCP server, CLI, capability registry, and runtime
  storage-tools/    Path-safe storage-pool operations
  ops/            One-shot health evaluation and maintenance
  shared/         Configuration and shared types
  web/            React/Vite user interface
  worker/         Agent job processor
packaging/
  debian/         Debian package metadata
  systemd/        Runtime services and timers
docs/             Starlight technical, architecture, and operations documentation
```

## License

Licensed under the [Apache License 2.0](LICENSE).
