# Code Review Results

- Scope: `29489fd29e1a2a3551845a4adad802e35b8a5e3f` to working tree, 547 tracked files plus 7 manually reviewed untracked implementation files
- Intent: move all Rust sources to `crates/`, all TypeScript workspaces to `packages/`, remove the source `apps/` directory, add Nix packaging/NixOS deployment, and update documentation
- Mode: autofix
- Reviewers: correctness, testing, maintainability, project-standards, agent-native, learnings, security, API-contract, reliability, adversarial, kieran-typescript

## Applied Fixes

- Replaced the shared writable `/zos` and `/run/zos` mount namespace with service-specific paths and restored a bounded capability set for root hostd.
- Aligned Nix services with the native units: terminal home/shell, systemd ordering and mount requirements, notify/watchdog modes, resource limits, Bluetooth session bus, VOD groups, and host-access runtime state.
- Made Docker, libvirt, and Bluetooth activation additive. A disabled ZOS integration no longer forces an independently managed NixOS service off.
- Added `services.zos.nginx.openFirewall`, defaulting to `false`, and updated the deployment sample to opt in explicitly.
- Made share and Docker daemon mutation controls fail closed until the API affirmatively reports write capability.
- Extended the NixOS VM test with terminal identity, service write-boundary, and hostd capability assertions.

## Coverage

- `make ci` passed: protocol drift, typecheck, Astro validation, Rust/TypeScript/docs tests, lint/clippy, production workspaces, Rust release binaries, and documentation build.
- Documentation Playwright smoke passed: 2 tests.
- `nix flake check --no-build --all-systems` passed in the isolated Nix container after the final module fixes.
- The real `checks.x86_64-linux.workspace-layout` Nix derivation passed earlier in this migration.
- No `docs/solutions/` directory exists, so there were no institutional solution documents to apply.
- Agent parity is preserved: declarative host mutations are rejected through the same API/hostd boundaries used by UI, CLI, and MCP callers; read-only status remains available.

## Residual Risk

The complete Nix package closure and NixOS VM derivation were not built locally. Native `x86_64-linux` and `aarch64-linux` CI are still the authoritative check for `better-sqlite3`, Rust binaries, systemd activation, and VM assertions.

## Verdict

Ready for native Linux Nix CI. No confidence-qualified actionable findings remain.
