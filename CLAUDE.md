# Claude Code Instructions

Follow [AGENTS.md](./AGENTS.md) for repository-wide architecture, safety, test,
and deployment rules. Treat it as the source of truth when this file is less
specific.

## Operating Loop

- Start with `git status --short` and inspect the relevant source, tests, and
  packaging files before editing. Preserve user changes and do not reset or
  rewrite history.
- Keep changes small and use existing workspace patterns. Do not add generated
  files, dependencies, commits, or pushes unless explicitly requested.
- For TypeScript, keep strict types and fix the underlying error instead of
  weakening compiler settings.
- Keep responses concise and implementation-oriented.

## Required Verification

Use focused tests during implementation, then run the full checks appropriate
to the change:

```bash
npm run typecheck   # TypeScript plus Astro docs check
npm run lint
npm test            # Vitest plus documentation metadata tests
npm run build       # required for frontend, docs, packaging, or build changes
```

`make check` is the typecheck/lint/test gate; `make ci` adds the full build.
The root Vitest suite covers packages, packaging, and build scripts; Cargo
tests cover the Rust crates.
Documentation browser smoke is separate and requires a built docs site plus
Chromium:

```bash
npm run docs:build
npm --prefix docs exec -- playwright install --with-deps chromium
npm run docs:browser
```

Run `npm run version:check` before release or package work. The CI workflow
also validates the version policy, runs quality checks, builds Debian artifacts
for both `amd64` and `arm64`, and runs the docs Playwright smoke job.

## Deployment Notes

- Build Debian packages with `packaging/scripts/build-deb.sh` or `make deb`;
  build native modules on the target architecture and keep `.deb`, `.changes`,
  and `.buildinfo` artifacts.
- `packaging/scripts/install.sh` mutates a Debian host. It requires root and
  `amd64`/`arm64`; the terminal always runs as the internal `cyberos` user. Review
  mirror settings before it changes APT sources. Nginx defaults on; Docker and
  VM support default off.
- `packaging/appliance/build-image.sh` consumes an already built `.deb` and
  emits a systemd rootfs tarball, not a bootable board image. It requires
  `mmdebstrap` and `systemd-nspawn`; pass `CYBEROS_DEB` explicitly when the
  artifact is not at the default path.
- `flake.nix` exports Linux packages, development shells, and a NixOS module.
  NixOS runs with `CYBEROS_HOST_MUTATION_POLICY=declarative`; host configuration
  writes are rejected and must be expressed through NixOS options.
- After installation, check the resident services, timers, and journald. Verify
  `/health`, `/api/roots/readiness`, and `/api/system/health`; liveness alone is
  not NAS or backup readiness. Oneshot jobs normally become `inactive (dead)`
  after success, so inspect their exit status and journal.
- CyberOS 2.0 is clean-install only. Do not add discovery, import, aliases, or
  recovery paths for earlier products. The CM5 workflow accepts only the
  current `/cyberos` layout. Future CyberOS database migrations do not have a
  generic downgrade path.

## Safety And UI Reminders

Preserve NAS root/path traversal and unsafe-symlink protections, approval gates
for mutations, and the wire shapes of `/api/files/meta` and `/api/files/text`.
Keep the production API on loopback and use the packaged Nginx proxy for LAN
access. For frontend changes, reuse existing components, CSS variables, and
`lucide-react` icons; keep the dense utility layout responsive and check a
browser when a visual or preview flow changes.
