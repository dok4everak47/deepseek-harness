#!/usr/bin/env bash
# Configure or remove an outbound HTTP(S) proxy for the *Nix daemon*, which is
# the process that actually downloads from cache.nixos.org on multi-user
# installs (the default on macOS and most Linux distributions).
#
# Usage:
#   scripts/nix-daemon-proxy.sh on  [proxy_url]   # default http://127.0.0.1:7890
#   scripts/nix-daemon-proxy.sh off
#   scripts/nix-daemon-proxy.sh status
#
# `on` and `off` require root (re-run with sudo). After changing the proxy the
# nix-daemon service is restarted so the new environment takes effect.
#
# On NixOS the daemon cannot be configured at runtime — set
#   services.nix-daemon.envVars = { HTTP_PROXY = "..."; ...; };
# in configuration.nix and run `nixos-rebuild switch`. This script will print
# that snippet and exit.

set -euo pipefail

DEFAULT_PROXY="${NIX_PROXY:-http://127.0.0.1:7890}"
NO_PROXY_DEFAULT="${NO_PROXY:-localhost,127.0.0.1,::1,.local}"

action="${1:-status}"
proxy="${2:-$DEFAULT_PROXY}"

if [ -f /etc/NIXOS ]; then
  cat <<EOF >&2
This host is NixOS. The nix-daemon proxy is declared, not managed at runtime.
Add to configuration.nix:

  services.nix-daemon.envVars = {
    HTTP_PROXY  = "$proxy";
    HTTPS_PROXY = "$proxy";
    http_proxy  = "$proxy";
    https_proxy = "$proxy";
    NO_PROXY    = "$NO_PROXY_DEFAULT";
  };

Then run: sudo nixos-rebuild switch
EOF
  exit 0
fi

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "error: '$action' requires root — re-run with sudo." >&2
    exit 1
  fi
}

set_proxy_env() {
  # $1 = proxy url (empty to unset)
  local p="$1"
  if [ "$(uname -s)" = "Darwin" ]; then
    if [ -n "$p" ]; then
      launchctl setenv HTTP_PROXY  "$p"
      launchctl setenv HTTPS_PROXY "$p"
      launchctl setenv http_proxy  "$p"
      launchctl setenv https_proxy "$p"
      launchctl setenv ALL_PROXY   "$p"
      launchctl setenv all_proxy   "$p"
      launchctl setenv NO_PROXY    "$NO_PROXY_DEFAULT"
      launchctl setenv no_proxy    "$NO_PROXY_DEFAULT"
    else
      launchctl unsetenv HTTP_PROXY  || true
      launchctl unsetenv HTTPS_PROXY || true
      launchctl unsetenv http_proxy  || true
      launchctl unsetenv https_proxy || true
      launchctl unsetenv ALL_PROXY   || true
      launchctl unsetenv all_proxy   || true
      launchctl unsetenv NO_PROXY    || true
      launchctl unsetenv no_proxy    || true
    fi
  elif command -v systemctl >/dev/null 2>&1; then
    local dropin=/etc/systemd/system/nix-daemon.service.d/proxy.conf
    if [ -n "$p" ]; then
      mkdir -p "$(dirname "$dropin")"
      cat >"$dropin" <<EOF
[Service]
Environment="HTTP_PROXY=$p"
Environment="HTTPS_PROXY=$p"
Environment="http_proxy=$p"
Environment="https_proxy=$p"
Environment="ALL_PROXY=$p"
Environment="all_proxy=$p"
Environment="NO_PROXY=$NO_PROXY_DEFAULT"
Environment="no_proxy=$NO_PROXY_DEFAULT"
EOF
      systemctl daemon-reload
    else
      rm -f "$dropin"
      systemctl daemon-reload
    fi
  else
    echo "error: unsupported platform — set the proxy in your init system for nix-daemon." >&2
    exit 1
  fi
}

restart_daemon() {
  if [ "$(uname -s)" = "Darwin" ]; then
    launchctl kickstart -k system/org.nixos.nix-daemon 2>/dev/null \
      || echo "warning: could not kickstart org.nixos.nix-daemon — restart it manually." >&2
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl restart nix-daemon
  fi
}

show_status() {
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "launchctl env (applies to services launched after this):"
    launchctl getenv HTTPS_PROXY 2>/dev/null | sed 's/^/  HTTPS_PROXY=/' || echo "  HTTPS_PROXY=(unset)"
  elif command -v systemctl >/dev/null 2>&1; then
    local dropin=/etc/systemd/system/nix-daemon.service.d/proxy.conf
    if [ -f "$dropin" ]; then
      echo "systemd drop-in: $dropin"
      sed 's/^/  /' "$dropin"
    else
      echo "no systemd drop-in at $dropin (proxy off for nix-daemon)"
    fi
  fi
  echo
  echo "running nix-daemon environment (if a daemon is reachable):"
  if [ -S /nix/var/nix/daemon-socket/socket ]; then
    nix daemon --help >/dev/null 2>&1 || true
    systemctl show nix-daemon -p Environment 2>/dev/null | sed 's/^/  /' || true
  fi
}

case "$action" in
  on)
    need_root
    echo "enabling nix-daemon proxy: $proxy"
    set_proxy_env "$proxy"
    restart_daemon
    echo "done."
    ;;
  off)
    need_root
    echo "disabling nix-daemon proxy"
    set_proxy_env ""
    restart_daemon
    echo "done."
    ;;
  status)
    show_status
    ;;
  *)
    echo "usage: $0 {on [proxy_url]|off|status}" >&2
    exit 2
    ;;
esac
