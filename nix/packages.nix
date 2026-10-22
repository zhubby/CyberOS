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
    SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
    nativeBuildInputs = [ pkgs.coreutils pkgs.pkg-config ];
    buildInputs = [ pkgs.openssl ];
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/zos/bin
      releaseDir=target/release
      if [ ! -x "$releaseDir/zos-alerter" ]; then
        for candidate in target/*/release; do
          if [ -x "$candidate/zos-alerter" ]; then
            releaseDir="$candidate"
            break
          fi
        done
      fi
      for binary in zos-alerter zos-bluetoothd zos-downloader zos-host-accessd zos-hostd \
        zos-indexer zos-monitor zos-photostaff zos-termux zos-tv-gamepad zos-vod-player; do
        install -Dm755 "$releaseDir/$binary" "$out/lib/zos/bin/$binary"
      done
      runHook postInstall
    '';
  };

  node22NpmHooks = pkgs.callPackage
    (pkgs.path + "/pkgs/build-support/node/import-npm-lock/hooks")
    { nodejs = pkgs.nodejs_22; };

  rootNpmDeps = pkgs.importNpmLock {
    npmRoot = cleanSource;
  };

  zos-node = pkgs.stdenv.mkDerivation (finalAttrs: {
    pname = "zos-node";
    inherit version;
    src = cleanSource;
    npmDeps = rootNpmDeps;
    npmRoot = ".";
    nativeBuildInputs = with pkgs; [
      nodejs_22
      node22NpmHooks.npmConfigHook
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
      node -e "const Database = require('better-sqlite3'); const database = new Database(':memory:'); database.close();"
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
      rm -rf $out/lib/zos/node_modules/@zos
      if [ -d packages/agent/node_modules ]; then
        cp -R packages/agent/node_modules $out/lib/zos/packages/agent/node_modules
      fi
      mkdir -p $out/lib/zos/node_modules/@earendil-works
      ln -s ../../packages/agent/node_modules/@earendil-works/pi-coding-agent \
        $out/lib/zos/node_modules/@earendil-works/pi-coding-agent
      dependencyCheck=$out/lib/zos/apps/worker/dist/.dependency-check.mjs
      printf '%s\n' "import.meta.resolve('@earendil-works/pi-coding-agent');" > "$dependencyCheck"
      node "$dependencyCheck"
      rm "$dependencyCheck"
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

  docsNpmDeps = pkgs.importNpmLock {
    npmRoot = cleanSource + "/docs";
  };

  zos-docs = pkgs.stdenv.mkDerivation {
    pname = "zos-docs";
    inherit version;
    src = cleanSource;
    npmDeps = docsNpmDeps;
    npmRoot = "docs";
    nativeBuildInputs = with pkgs; [ nodejs_22 importNpmLock.npmConfigHook ];
    buildPhase = ''
      runHook preBuild
      npm --prefix docs run build
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/zos/docs
      cp -R docs/dist $out/lib/zos/docs/dist
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
