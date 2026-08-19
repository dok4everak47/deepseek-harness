{
  description = "DeepSeek Harness development shell (Node + pnpm, Python + uv, Rust).";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };

        nodejs = pkgs.nodejs_22;

        # nixpkgs unstable already ships pnpm 11.x, which matches the
        # "packageManager" pin in package.json. Build it against the slim
        # variant to match the rest of the node package set.
        pnpm = pkgs.pnpm.override { nodejs = pkgs.nodejs-slim_22; };

        # pnpm needs its own store; keep it inside the project so it is easy
        # to wipe and never collides with the user's global store.
        projectPnpmStore = ".pnpm-store";

        commonTools = with pkgs; [
          # Core toolchain
          nodejs
          pnpm
          (python3.withPackages (py: with py; [ pip wheel ]))
          uv

          # Version control / forges
          git
          gh

          # Build essentials used by various scripts
          gnumake
          pkg-config

          # Native (Rust) addon — only meaningfully compiles on Linux, but
          # exposing cargo/rustc on every host lets `cargo check` surface
          # platform-gated errors early.
          cargo
          rustc
          rustfmt
          clippy

          # Day-to-day
          jq
          yq-go
          fd
          ripgrep
          gnused
          gnutar
          unzip
          zip

          # Tests and release scripts shell out to these.
          openssh
          openssl
        ];

        # Linux-only headers/libraries the landlock-run addon links against.
        linuxTools = with pkgs; lib.optionals stdenv.hostPlatform.isLinux [
          stdenv.cc.cc
          linuxHeaders
          libseccomp
        ];

        devShellInputs = commonTools ++ linuxTools;
      in
      {
        devShells = {
          default = pkgs.mkShell {
            name = "deepseek-harness";

            nativeBuildInputs = devShellInputs;
            buildInputs = devShellInputs;

            shellHook = ''
              # --- Outbound proxy for user-space nix + package managers ---
              # The nix *daemon* (which actually fetches cache.nixos.org on
              # multi-user installs) needs its own proxy; see
              # scripts/nix-daemon-proxy.sh. Here we cover `nix` outside the
              # daemon and every other tool that honors http_proxy/https_proxy.
              : "''${NIX_PROXY:=http://127.0.0.1:7890}"
              if [ -n "$NIX_PROXY" ]; then
                export http_proxy="$NIX_PROXY" https_proxy="$NIX_PROXY" all_proxy="$NIX_PROXY"
                export HTTP_PROXY="$NIX_PROXY" HTTPS_PROXY="$NIX_PROXY" ALL_PROXY="$NIX_PROXY"
                : "''${NO_PROXY:=localhost,127.0.0.1,::1,.local}"
                export no_proxy="$NO_PROXY" NO_PROXY="$NO_PROXY"
              fi

              # --- pnpm: project-local store, version pinned by package.json ---
              export PNPM_HOME="$PWD/.pnpm-home"
              export PNPM_STORE_DIR="$PWD/${projectPnpmStore}"
              mkdir -p "$PNPM_HOME" "$PNPM_STORE_DIR"
              case ":$PATH:" in
                *":$PNPM_HOME:"*) ;;
                *) export PATH="$PNPM_HOME:$PATH" ;;
              esac

              # Corepack would also work, but we already ship pnpm from nixpkgs.
              # Still advertise the expected version so ad-hoc tools see it.
              export COREPACK_ENABLE_AUTO_PIN=0

              # --- Python / uv: keep the virtualenv in the repo's tmp/ ---
              export UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv"
              export PIP_DISABLE_PIP_VERSION_CHECK=1

              # --- Repository-specific conveniences ---
              export DSH_NIX_DEV_SHELL=1

              # Make the host's SSH auth socket visible when on Linux so
              # `git push` / `gh` keep working inside the shell.
              if [ -n "$SSH_AUTH_SOCK" ]; then
                export SSH_AUTH_SOCK
              fi

              # Surface workspace bins (dsh, tsx, vitest, ...) once installed.
              if [ -d "$PWD/node_modules/.bin" ]; then
                case ":$PATH:" in
                  *":$PWD/node_modules/.bin:"*) ;;
                  *) export PATH="$PWD/node_modules/.bin:$PATH" ;;
                esac
              fi

              if [ -t 1 ] && [ "''${DSH_QUIET_SHELL:-0}" != "1" ]; then
                echo "  🧊  dsh devShell ($(uname -s) ($(uname -m)))"
                echo "  Node   $(node --version) ($(command -v node))"
                echo "  pnpm   $(pnpm --version)"
                echo "  uv     $(uv --version 2>/dev/null)"
                if command -v dsh >/dev/null 2>&1; then
                  echo "  dsh    dsh <profile> (--expose-internals)"
                fi
              fi
            '';
          };
        };
      });
}
