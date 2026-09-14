#!/bin/sh
set -eu
# This sidecar serves the dashboard only; its bundled SSH server stays disabled.
export TS_DISABLE_SSH_SERVER=true

mkdir -p /var/run/tailscale /var/lib/tailscale
tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock --tun=userspace-networking &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true; wait "$daemon" || true' TERM INT

# Keep the daemon alive while browser login is pending. Authentication timeouts
# must not restart it and invalidate the link the user is trying to authorize.
if [ -n "${TS_AUTHKEY:-}" ]; then
  for attempt in 1 2 3 4 5; do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 1
  done
  if ! tailscale --socket=/var/run/tailscale/tailscaled.sock status --json 2>/dev/null | grep -q '"BackendState": "Running"'; then
    tailscale --socket=/var/run/tailscale/tailscaled.sock up --auth-key="$TS_AUTHKEY" --hostname="${TS_HOSTNAME:-serverforge}" --accept-dns=false --timeout=20s || true
  fi
fi
wait "$daemon"
