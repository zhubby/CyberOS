{
  description = "ZOS NAS appliance packages and NixOS module";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ self, nixpkgs, rust-overlay }:
    let
      inherit (nixpkgs) lib;
      linuxSystems = [ "x86_64-linux" "aarch64-linux" ];
      developmentSystems = linuxSystems ++ [ "x86_64-darwin" "aarch64-darwin" ];
      forSystems = systems: function: lib.genAttrs systems (system: function system);
      pkgsFor = system: import nixpkgs {
        inherit system;
        overlays = [ rust-overlay.overlays.default ];
      };
      packageSet = system: import ./nix/packages.nix {
        pkgs = pkgsFor system;
        src = self;
        revision = self.rev or null;
        sourceDateEpoch = self.lastModified or 1;
      };
    in {
      packages = forSystems linuxSystems (system:
        let packages = packageSet system;
        in {
          default = packages.zos;
          zos = packages.zos;
          zos-rust = packages.zos-rust;
          zos-node = packages.zos-node;
          zos-docs = packages.zos-docs;
        });

      devShells = forSystems developmentSystems (system:
        let
          pkgs = pkgsFor system;
          rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_22
              rustToolchain
              pkg-config
              python3
              gnumake
              git
            ] ++ lib.optionals stdenv.hostPlatform.isLinux [
              acl
              sqlite
            ];
            ZOS_ENVIRONMENT = "development";
            ZOS_ENABLE_LOCAL_AGENT_FALLBACK = "1";
          };
        });

      checks = forSystems linuxSystems (system:
        let
          pkgs = pkgsFor system;
          packages = packageSet system;
        in {
          inherit (packages) zos-rust zos-node zos-docs;
          workspace-layout = pkgs.runCommand "zos-workspace-layout" { } ''
            cp -R ${self} source
            chmod -R u+w source
            cd source
            test ! -e apps
            grep -F 'members = ["crates/*"]' Cargo.toml
            grep -F '"packages/*"' package.json
            touch $out
          '';
        } // lib.optionalAttrs (system == "x86_64-linux") {
          nixos-module = import ./nix/tests/nixos-module.nix { inherit pkgs self; };
        });

      nixosModules.zos = import ./nix/module.nix { inherit self; };
      nixosModules.default = self.nixosModules.zos;
    };
}
