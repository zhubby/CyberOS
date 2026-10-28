# Agent Instructions

These instructions apply to the whole repository. `CLAUDE.md` contains the
short Claude-specific handoff; this file is the project source of truth.

## Project And Runtime

CyberOS is a mixed TypeScript/Rust monorepo for a single-user Linux NAS appliance.
It is deployed as native processes and systemd units, not as a Docker
container. TypeScript workspaces live only under `packages/`; Rust workspace
members live only under `crates/`. The repository has no source `apps/`
directory. Installed paths such as `/usr/lib/cyberos/apps` and the managed Compose
root `/cyberos/apps` are runtime paths and must not be renamed as part of
source-layout work.

- `packages/web`: React/Vite web UI.
- `packages/api`: Fastify API, WebSocket/SSE endpoints, and production static files.
- `packages/worker`: agent job worker.
- `packages/ops`, `packages/backup`: one-shot operations and restic jobs.
- `packages/db`, `packages/nas-tools`, `packages/agent`, `packages/shared`:
  persistence, path-safe filesystem operations, agent routing, and shared
  configuration/types.
- `crates/indexer`, `crates/monitor`, `crates/alerter`, `crates/photostaff`,
  `crates/downloader`: NAS indexing, monitoring, alerts, media, and downloads.
- `crates/hostd`, `crates/host-accessd`, `crates/termux`,
  `crates/bluetoothd`, `crates/vod-player`: host integration processes.
- `nix`: reproducible packages, the NixOS module, and its VM test.
- `docs`: Astro/Starlight documentation site and Playwright smoke tests.
- `scripts`: build metadata, version policy, and release preparation.
- `packaging`: Debian rules, systemd units, Nginx config, host installer, and
  appliance rootfs builder.
- `.github/workflows/package-release.yml`: CI quality, package, browser smoke,
  and tagged release workflow.

Node.js 22 (the documented minimum is 22.12+) and npm are required for local
development and CI. Production packages support Debian-family `amd64` and
`arm64`; native modules such as `better-sqlite3` and Rust daemons must be built
for the target architecture. The flake provides pinned Node.js/Rust development
shells on Linux and macOS plus Linux packages for `x86_64` and `aarch64`.

## Working Tree And Scope

- Run `git status --short` before editing. Preserve existing user changes,
  including changes in files that are not part of the request.
- Keep edits scoped to the requested behavior and follow local patterns before
  introducing abstractions or dependencies.
- Do not rewrite history, reset files, or run destructive commands unless the
  user explicitly asks.
- Do not commit or push unless asked. Never add generated output such as
  `node_modules`, `dist`, coverage, logs, `.cyberos` build artifacts, or
  `docs/.astro`/`docs/test-results`.
- Keep TypeScript strict; do not weaken compiler settings or use `any` to hide
  type errors.

## Install And Development

Install both workspace and documentation dependencies from the repository root:

```bash
npm ci
npm --prefix docs ci
# convenience target (root npm install + docs npm ci):
make install
```

With Nix installed, `nix develop` provides the pinned Node.js and Rust tools;
run `npm ci` and `npm --prefix docs ci` inside the shell when working outside a
Nix package build.

Use an isolated development data directory so local processes cannot read or
mutate production NAS paths:

```bash
mkdir -p .cyberos/dev-root/data/primary
CYBEROS_ENVIRONMENT=development \
CYBEROS_ROOT="$PWD/.cyberos/dev-root" \
CYBEROS_NAS_ROOTS="dev:Development NAS:$PWD/.cyberos/dev-root/data/primary" \
CYBEROS_ENABLE_LOCAL_AGENT_FALLBACK=1 \
npm run dev
```

`npm run dev` starts the API, worker, and web Vite server. The indexer and Ops
tasks are intentionally separate processes:

```bash
npm run index                 # one index pass
npm run health                # one health evaluation
npm run maintenance           # one maintenance pass
npm run docs:dev              # documentation site on 127.0.0.1:4321
```

The default development endpoints are Web `127.0.0.1:5173`, API
`127.0.0.1:3010`, and docs `127.0.0.1:4321/docs/`.

## Verification And Tests

Run the narrowest useful check while iterating, then the full gate before
handing off substantive changes:

```bash
npm run typecheck             # tsc plus Astro docs check
npm run lint                  # ESLint over the repository
npm test                      # Vitest plus docs metadata/content tests
npm run build                 # build metadata, all workspaces, and docs

make check                    # typecheck + lint + test
make ci                       # make check + build
```

The root Vitest config runs tests under `packages/**`, `packaging/**`, and
`scripts/**` in a Node environment with a threaded pool. Cargo tests cover
`crates/**`.
The test suite includes API contracts, path/traversal safety, database/schema,
worker/indexer/operations behavior, web components, packaging declarations, and
build/version scripts. Add focused tests for behavior changes; preserve the
wire shapes of `/api/files/meta` and `/api/files/text` with tests when touching
file routes.

Documentation browser smoke is a separate check and is not included in
`npm test` or `make ci`:

```bash
npm run docs:build
npm --prefix docs exec -- playwright install --with-deps chromium  # once per host/CI image
npm run docs:browser
```

The smoke suite serves the built `docs/dist` and checks navigation/search,
Mermaid rendering, and a 404 for unknown documentation routes. Frontend,
packaging, or build-configuration changes require `npm run build`; UI changes
should also receive a browser check when practical.

Before a release or package build, run `npm run version:check`. The GitHub
workflow runs on pull requests, pushes to `main`, and `v*` tags. Its quality
job uses Node 22 and runs version check, typecheck, lint, test, and build. The
package job then builds and validates one `.deb`, `.changes`, and `.buildinfo`
artifact for each of `amd64` and `arm64`. The docs-browser job separately
installs Chromium and runs the Playwright smoke suite. Tagged releases also
require the tag to be reachable from `main` and to match the Debian changelog.
The Nix CI matrix additionally runs `nix flake check` on native
`x86_64-linux` and `aarch64-linux` runners; the NixOS VM test runs on x86_64.

## Deployment And Packaging

### Debian package

Build on the target architecture when possible. `build-deb.sh` copies the
checkout to `.cyberos/deb-build`, runs the Debian rules (fresh root/docs npm
installs, full build, and `npm test`), and writes package artifacts under
`.cyberos/`:

```bash
CYBEROS_NPM_REGISTRY=https://registry.npmmirror.com \
  ./packaging/scripts/build-deb.sh
# or: make deb
```

The package contains compiled app/docs assets, bundled workspace `node_modules`,
build metadata, `/cyberos/config` defaults, and systemd units. It does not start
services during `dpkg` installation; the host installer performs first boot
and service activation.

### Host installer

`packaging/scripts/install.sh` is a host-mutating operation. It must run as
root on Debian-family `amd64`/`arm64`. The terminal identity is always `cyberos`:

```bash
sudo CYBEROS_NAS_ROOT_PATH=/cyberos/data/primary \
  ./packaging/scripts/install.sh
```

The script can install/verify Node.js 22, configure and back up known APT
sources under `/cyberos/system-backups/apt`, build/install the current checkout,
initialize `/cyberos/config/config.toml` and `/cyberos/state`, and configure
Nginx. `CYBEROS_ENABLE_NGINX` defaults to `1`; Docker and VM support default to
`0` and can be enabled explicitly with `CYBEROS_ENABLE_DOCKER=1` and
`CYBEROS_ENABLE_VM=1`. Review `CYBEROS_APT_*`, `CYBEROS_NODE_*`, and
`CYBEROS_NPM_REGISTRY` before using internal or domestic mirrors.

After installation, core services are enabled and started; maintenance,
health, and backup timers are enabled but do not all
run immediately. Nginx proxies the loopback API (`127.0.0.1:3010`) and serves
the LAN entrypoint (default port 80).

### Appliance rootfs

`packaging/appliance/build-image.sh` creates a systemd rootfs tarball, not a
flashable SD/eMMC image. It requires `node`, `mmdebstrap`, `systemd-nspawn`,
`tar`, `curl`, and `sha256sum`, and consumes a previously built `.deb`:

```bash
CYBEROS_DEB="$PWD/.cyberos/cyberos_<version>_arm64.deb" \
CYBEROS_IMAGE_OUT="$PWD/.cyberos/appliance" \
CYBEROS_TARGET_ARCH=arm64 \
  ./packaging/appliance/build-image.sh
# or: make appliance (when the default .deb path is present)
```

Defaults are Debian bookworm, `arm64`, and `.cyberos/appliance`. The output is
`.cyberos/appliance/cyberos-rootfs-<arch>.tar`; board-specific boot, network,
mount, and first-boot configuration remain outside this script. Docker, VM,
and backup are disabled by the generated first-boot defaults and must be
enabled/configured deliberately.

### NixOS module

`flake.nix` exports `nixosModules.default` and packages for `x86_64-linux` and
`aarch64-linux`. The module creates the `cyberos` account, `/cyberos` state layout,
native systemd services/timers, and an optional Nginx proxy. Non-secret TOML
may be rendered from `services.cyberos.settings`; use
`services.cyberos.configFile` for secret-bearing configuration so secrets do not
enter the Nix store.

The module always sets `CYBEROS_HOST_MUTATION_POLICY=declarative`. Inspection stays
available, but share, storage-pool, NetworkManager, and Docker daemon
configuration writes return HTTP 501 and hostd protocol error `unsupported`.
Declare those host resources through NixOS. This policy does not make `/cyberos`
or NAS files immutable and does not disable approved application/file actions.
See `docs/src/content/docs/operations/nixos.md` for configuration and rollback
details.

### Post-deploy checks and operations

Use service status and journald, not only a single liveness request:

```bash
sudo systemctl --failed
sudo systemctl is-active cyberos-api.service cyberos-worker@1.service \
  cyberos-termux.service cyberos-hostd.service
sudo systemctl list-timers 'cyberos-*'
sudo journalctl -u cyberos-api.service -u cyberos-worker@1.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/health
curl -fsS http://127.0.0.1:3010/api/roots/readiness
curl -fsS http://127.0.0.1:3010/api/system/health
```

`/health` is API liveness only; it does not prove NAS mounts, indexing, or
backup readiness. Oneshot units normally return to `inactive (dead)` after
success, so inspect their exit code and journal. Manually run a task with its
service, for example `sudo systemctl start cyberos-indexer.service`, rather
than invoking a timer directly. After changing units or configuration, run
`sudo systemctl daemon-reload` and restart affected resident services.

For upgrades, stop the indexer and all maintenance/health/backup timers,
save the current `.deb`, `/cyberos/config`, `/cyberos/state` and SQLite state,
install the new package, and re-run the API, readiness, index, health, and
backup acceptance checks before re-enabling timers. Database migrations have no
general reverse migration; a downgrade may require restoring a matching state
backup as well as the old package.

CyberOS 2.0 supports clean installation only. Do not discover, import, or
translate databases, configuration, paths, users, backups, or service state
from earlier products. The CM5 deployment workflow accepts only an existing
CyberOS installation created with the current `/cyberos` layout.

## Safety Boundaries

- Keep all NAS reads/writes inside configured NAS roots. Preserve traversal,
  symlink, mount-readiness, and path normalization protections.
- Mutating file operations and agent actions remain approval-gated. Do not add
  a bypass or broaden the local fallback without explicit product direction.
- Keep API response contracts stable unless an API change is explicitly
  requested and tested.
- SQLite is shared by API, worker, indexer, Ops, and backup; avoid
  concurrent ad-hoc writers and consider migration/backfill safety for schema
  changes.
- Production API binds to loopback. Use the packaged Nginx proxy for LAN access;
  do not expose the unauthenticated local-only API directly to the internet.
- Keep systemd hardening and service identities intact. `hostd` is the
  constrained root helper; other runtime services should remain non-root.

## Frontend And UI

Match the existing dark, dense, utility-focused UI. Reuse local components,
CSS variables, and `lucide-react` icons. Keep layouts stable across desktop and
mobile, avoid text overlap, keep user-facing copy short and operational, and
verify preview/file-browser changes in a browser when practical.

The normative frontend design language is documented in
`docs/src/content/docs/reference/frontend-design.md`. Read and follow it before
making UI changes. Update that document when intentionally changing shared
visual tokens, layout breakpoints, interaction semantics, or responsive
information architecture; do not introduce page-local design rules that
contradict it.

## Git

Stage only files relevant to the request. Do not commit generated output.
Commit, tag, push, or create a release only when the user explicitly asks.
