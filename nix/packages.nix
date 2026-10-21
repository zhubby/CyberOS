{ pkgs, src, revision ? null, sourceDateEpoch ? 1 }:

let
  inherit (pkgs) lib;
  version = (lib.importJSON (src + "/package.json")).version;
  rustToolchain = pkgs.rust-bin.fromRustupToolchainFile (src + "/rust-toolchain.toml");
  rustPlatform = pkgs.makeRustPlatform {
    cargo = rustToolchain;
    rustc = rustToolchain;
  };
  cleanSource = lib.cleanSourceWith {
    inherit src;
    filter = path: type:
      let base = baseNameOf path;
      in !(lib.elem base [ ".git" ".zos" "node_modules" "target" "dist" "test-results" ]);
  };
  revisionEnvironment = lib.optionalAttrs (revision != null) {
    ZOS_BUILD_COMMIT_SHA = revision;
  };

  zos-rust = rustPlatform.buildRustPackage {
    pname = "zos-rust";
    inherit version;
    src = cleanSource;
    cargoLock.lockFile = src + "/Cargo.lock";
    doCheck = true;
    nativeBuildInputs = [ pkgs.pkg-config ];
    buildInputs = [ pkgs.openssl ];
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/zos/bin
      releaseDir=target/release
      if [ -n "''${CARGO_BUILD_TARGET:-}" ] && [ -d "target/$CARGO_BUILD_TARGET/release" ]; then
        releaseDir="target/$CARGO_BUILD_TARGET/release"
      fi
      for binary in zos-alerter zos-bluetoothd zos-downloader zos-host-accessd zos-hostd \
        zos-indexer zos-monitor zos-photostaff zos-termux zos-vod-player; do
        install -Dm755 "$releaseDir/$binary" "$out/lib/zos/bin/$binary"
      done
      runHook postInstall
    '';
  };

  rootNodeModules = pkgs.importNpmLock.buildNodeModules {
    npmRoot = cleanSource;
    nodejs = pkgs.nodejs_22;
  };

  zos-node = pkgs.stdenv.mkDerivation (finalAttrs: {
    pname = "zos-node";
    inherit version;
    src = cleanSource;
    npmDeps = rootNodeModules;
    npmRoot = cleanSource;
    nativeBuildInputs = with pkgs; [
      nodejs_22
      importNpmLock.npmConfigHook
      makeWrapper
      pkg-config
      python3
    ];
    buildInputs = [ pkgs.sqlite ];
    env = {
      ZOS_BUILD_SOURCE = "nix";
      ZOS_BUILD_DIRTY = "false";
      ZOS_BUILD_REPRODUCIBLE = "true";
      SOURCE_DATE_EPOCH = toString sourceDateEpoch;
    } // revisionEnvironment;
    buildPhase = ''
      runHook preBuild
      npm run build:metadata
      npm run build --workspaces --if-present
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/zos/apps $out/lib/zos/packages/agent $out/lib/zos/scripts $out/bin
      for workspace in api backup mcp-cli ops web worker; do
        mkdir -p "$out/lib/zos/apps/$workspace"
        cp -R "packages/$workspace/dist" "$out/lib/zos/apps/$workspace/dist"
      done
      cp -R node_modules $out/lib/zos/node_modules
      if [ -d packages/agent/node_modules ]; then
        cp -R packages/agent/node_modules $out/lib/zos/packages/agent/node_modules
      fi
      install -Dm644 package.json package-lock.json .zos/build-info.json -t $out/lib/zos
      for script in zos-tv-mode zos-tv-prepare zos-tv-weston zos-tv-chromium zos-tv-cec zos-tv-write-status; do
        install -Dm755 "packaging/scripts/$script" "$out/lib/zos/scripts/$script"
      done
      makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/zos-mcp \
        --add-flags "$out/lib/zos/apps/mcp-cli/dist/index.js" \
        --set NODE_PATH "$out/lib/zos/node_modules"
      makeWrapper $out/lib/zos/scripts/zos-tv-mode $out/bin/zos-tv-mode \
        --set ZOS_HOST_MUTATION_POLICY declarative \
        --prefix PATH : ${lib.makeBinPath [ pkgs.coreutils pkgs.curl pkgs.gnused pkgs.nodejs_22 pkgs.systemd ]}
      runHook postInstall
    '';
  });

  docsNodeModules = pkgs.importNpmLock.buildNodeModules {
    npmRoot = cleanSource + "/docs";
    nodejs = pkgs.nodejs_22;
  };

  zos-docs = pkgs.stdenv.mkDerivation {
    pname = "zos-docs";
    inherit version;
    src = cleanSource;
    npmDeps = docsNodeModules;
    npmRoot = cleanSource + "/docs";
    nativeBuildInputs = with pkgs; [ nodejs_22 importNpmLock.npmConfigHook ];
    buildPhase = ''
      runHook preBuild
      npm run build
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/zos/docs
      cp -R dist $out/lib/zos/docs/dist
      runHook postInstall
    '';
  };

  zos = pkgs.symlinkJoin {
    name = "zos-${version}";
    paths = [ zos-rust zos-node zos-docs ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      for command in api worker backup ops; do
        makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/zos-$command" \
          --add-flags "$out/lib/zos/apps/$command/dist/index.js" \
          --set NODE_PATH "$out/lib/zos/node_modules"
      done
    '';
  };
in {
  inherit zos zos-rust zos-node zos-docs;
}
