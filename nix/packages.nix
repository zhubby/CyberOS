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
      in !(lib.elem base [ ".git" ".cyberos" "node_modules" "target" "dist" "test-results" ]);
  };
  revisionEnvironment = lib.optionalAttrs (revision != null) {
    CYBEROS_BUILD_COMMIT_SHA = revision;
  };

  cyberos-rust = rustPlatform.buildRustPackage {
    pname = "cyberos-rust";
    inherit version;
    src = cleanSource;
    cargoLock.lockFile = src + "/Cargo.lock";
    doCheck = true;
    SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
    nativeBuildInputs = [ pkgs.coreutils pkgs.pkg-config ];
    buildInputs = [ pkgs.openssl ];
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/cyberos/bin
      releaseDir=target/release
      if [ ! -x "$releaseDir/cyberos-alerter" ]; then
        for candidate in target/*/release; do
          if [ -x "$candidate/cyberos-alerter" ]; then
            releaseDir="$candidate"
            break
          fi
        done
      fi
      for binary in cyberos-alerter cyberos-bluetoothd cyberos-downloader cyberos-host-accessd cyberos-hostd \
        cyberos-indexer cyberos-monitor cyberos-photostaff cyberos-termux cyberos-tv-gamepad cyberos-vod-player; do
        install -Dm755 "$releaseDir/$binary" "$out/lib/cyberos/bin/$binary"
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

  cyberos-node = pkgs.stdenv.mkDerivation (finalAttrs: {
    pname = "cyberos-node";
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
      CYBEROS_BUILD_SOURCE = "nix";
      CYBEROS_BUILD_DIRTY = "false";
      CYBEROS_BUILD_REPRODUCIBLE = "true";
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
      mkdir -p $out/lib/cyberos/apps $out/lib/cyberos/packages/agent $out/lib/cyberos/scripts $out/bin
      for workspace in api backup mcp-cli ops web worker; do
        mkdir -p "$out/lib/cyberos/apps/$workspace"
        cp -R "packages/$workspace/dist" "$out/lib/cyberos/apps/$workspace/dist"
      done
      cp -R node_modules $out/lib/cyberos/node_modules
      rm -rf $out/lib/cyberos/node_modules/@cyberos
      if [ -d packages/agent/node_modules ]; then
        cp -R packages/agent/node_modules $out/lib/cyberos/packages/agent/node_modules
      fi
      mkdir -p $out/lib/cyberos/node_modules/@earendil-works
      ln -s ../../packages/agent/node_modules/@earendil-works/pi-coding-agent \
        $out/lib/cyberos/node_modules/@earendil-works/pi-coding-agent
      dependencyCheck=$out/lib/cyberos/apps/worker/dist/.dependency-check.mjs
      printf '%s\n' "import.meta.resolve('@earendil-works/pi-coding-agent');" > "$dependencyCheck"
      node "$dependencyCheck"
      rm "$dependencyCheck"
      install -Dm644 package.json package-lock.json .cyberos/build-info.json -t $out/lib/cyberos
      for script in cyberos-tv-mode cyberos-tv-prepare cyberos-tv-weston cyberos-tv-chromium cyberos-tv-cec cyberos-tv-write-status; do
        install -Dm755 "packaging/scripts/$script" "$out/lib/cyberos/scripts/$script"
      done
      makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/cyberos-mcp \
        --add-flags "$out/lib/cyberos/apps/mcp-cli/dist/index.js" \
        --set NODE_PATH "$out/lib/cyberos/node_modules"
      makeWrapper $out/lib/cyberos/scripts/cyberos-tv-mode $out/bin/cyberos-tv-mode \
        --set CYBEROS_HOST_MUTATION_POLICY declarative \
        --prefix PATH : ${lib.makeBinPath [ pkgs.coreutils pkgs.curl pkgs.gnused pkgs.nodejs_22 pkgs.systemd ]}
      runHook postInstall
    '';
  });

  docsNpmDeps = pkgs.importNpmLock {
    npmRoot = cleanSource + "/docs";
  };

  cyberos-docs = pkgs.stdenv.mkDerivation {
    pname = "cyberos-docs";
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
      mkdir -p $out/lib/cyberos/docs
      cp -R docs/dist $out/lib/cyberos/docs/dist
      runHook postInstall
    '';
  };

  cyberos = pkgs.symlinkJoin {
    name = "cyberos-${version}";
    paths = [ cyberos-rust cyberos-node cyberos-docs ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      for command in api worker backup ops; do
        makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/cyberos-$command" \
          --add-flags "$out/lib/cyberos/apps/$command/dist/index.js" \
          --set NODE_PATH "$out/lib/cyberos/node_modules"
      done
    '';
  };
in {
  inherit cyberos cyberos-rust cyberos-node cyberos-docs;
}
