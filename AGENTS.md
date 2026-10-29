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
- `packages/db`, `packages/storage-tools`, `packages/agent`, `packages/shared`:
  persistence, path-safe filesystem operations, agent routing, and shared
  configuration/types.
- `crates/indexer`, `crates/monitor`, `crates/alerter`, `crates/photos`,
  `crates/downloader`: storage indexing, monitoring, alerts, media, and downloads.
- `crates/hostd`, `crates/host-accessd`, `crates/terminald`,
  `crates/bluetoothd`, `crates/vod-player`: host integration processes.
- `docs`: Astro/Starlight documentation site and Playwright smoke tests.
- `scripts`: build metadata, version policy, and release preparation.
- `packaging`: Debian rules, systemd units, Nginx config, and host installer.
- `.github/workflows/package-release.yml`: CI quality, package, browser smoke,
  and tagged release workflow.

Node.js 22 (the documented minimum is 22.12+) and npm are required for local
development and CI. Production packages support Debian-family `amd64` and
`arm64`; native modules such as `better-sqlite3` and Rust daemons must be built
for the target architecture.

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

Use an isolated development data directory so local processes cannot read or
mutate production NAS paths:

```bash
mkdir -p .cyberos/dev-root/data/pool-1
CYBEROS_ENVIRONMENT=development \
CYBEROS_ROOT="$PWD/.cyberos/dev-root" \
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
build metadata, and systemd units. It does not install a product configuration
file or start services during `dpkg` installation; the host installer runs the
state initializer and performs service activation.

### Host installer

`packaging/scripts/install.sh` is a host-mutating operation. It must run as
root on Debian-family `amd64`/`arm64`. The terminal identity is always `cyberos`:

```bash
sudo ./packaging/scripts/install.sh
```

The script can install/verify Node.js 22, configure and back up known APT
sources under `/cyberos/system-backups/apt`, build/install the current checkout,
initialize `/cyberos/state`, and configure Nginx. `CYBEROS_ENABLE_NGINX`
defaults to `1`; Docker and VM runtime dependencies are installed and their
CyberOS management features are enabled from System Settings. Review
`CYBEROS_APT_*`, `CYBEROS_NODE_*`, and
`CYBEROS_NPM_REGISTRY` before using internal or domestic mirrors.

After installation, core services are enabled and started; maintenance,
health, and backup timers are enabled but do not all
run immediately. Nginx proxies the loopback API (`127.0.0.1:3010`) and serves
the LAN entrypoint (default port 80).

### Post-deploy checks and operations

Use service status and journald, not only a single liveness request:

```bash
sudo systemctl --failed
sudo systemctl is-active cyberos-api.service cyberos-worker@1.service \
  cyberos-terminald.service cyberos-hostd.service
sudo systemctl list-timers 'cyberos-*'
sudo journalctl -u cyberos-api.service -u cyberos-worker@1.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/health
curl -fsS http://127.0.0.1:3010/api/system/storage
curl -fsS http://127.0.0.1:3010/api/system/health
```

`/health` is API liveness only; it does not prove NAS mounts, indexing, or
backup readiness. Oneshot units normally return to `inactive (dead)` after
success, so inspect their exit code and journal. Manually run a task with its
service, for example `sudo systemctl start cyberos-indexer.service`, rather
than invoking a timer directly. After changing units, run
`sudo systemctl daemon-reload` and restart affected resident services.

For upgrades, stop the indexer and all maintenance/health/backup timers,
save the current `.deb`, `/cyberos/state` and SQLite state,
install the new package, and re-run the API, readiness, index, health, and
backup acceptance checks before re-enabling timers. Database migrations have no
general reverse migration; a downgrade may require restoring a matching state
backup as well as the old package.

CyberOS 2.0 supports clean installation only. Do not discover, import, or
translate databases, configuration, paths, users, backups, or service state
from earlier products. The CM5 deployment workflow accepts only an existing
CyberOS installation created with the current `/cyberos` layout.

## Safety Boundaries

- Keep all storage reads/writes inside configured storage pools. Preserve traversal,
  symlink, mount-readiness, and path normalization protections.
- Mutating file operations and agent actions remain approval-gated. Do not add
  an approval bypass without explicit product direction.
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
