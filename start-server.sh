#!/usr/bin/env bash
# Linux convenience launcher.
#
# Grants docker-group access when needed, enables the Docker systemd unit at
# boot, then hands off to the cross-platform Node launcher. On Windows or
# macOS use `npm start`, `start-server.cmd`, or `start-server.ps1` instead.
set -Eeuo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
mkdir -p data

LOG_FILE="$PWD/data/startup.log"
exec > >(tee -a "$LOG_FILE") 2>&1

pause_on_error() {
  local status=$?
  trap - ERR
  printf '\nServerForge could not start. The full log is at:\n  %s\n' "$LOG_FILE"
  if [[ -t 0 ]]; then
    read -r -p "Press Enter to close this window..." || true
  fi
  exit "$status"
}
trap pause_on_error ERR

if ! command -v docker >/dev/null 2>&1; then
  printf '\nDocker is not installed. Install Docker Engine, then run this launcher again.\n'
  false
fi

# Docker's system service must start at boot for persistent containers to
# return after a reboot. Do this before checking socket access: a running
# daemon and a denied socket are different problems and need different fixes.
if command -v systemctl >/dev/null 2>&1 &&
  [[ "$(systemctl show --property=LoadState --value docker.service 2>/dev/null || true)" == "loaded" ]]; then
  if ! systemctl is-active --quiet docker.service ||
    ! systemctl is-enabled --quiet docker.service; then
    printf '\nStarting Docker and enabling it at boot (sudo may ask for your password).\n'
    sudo systemctl enable --now docker.service
  fi
fi

USE_DOCKER_GROUP=false
if ! DOCKER_OUTPUT="$(docker info 2>&1)"; then
  if [[ "$DOCKER_OUTPUT" == *"permission denied"* ]]; then
    printf '\nDocker is running, but %s cannot access it yet.\n' "${USER:-this user}"

    if [[ " $(id -nG "${USER:?Current user is unknown}") " != *" docker "* ]]; then
      printf 'Granting Docker access (sudo may ask for your password).\n'
      sudo usermod -aG docker "$USER"
    fi

    if ! command -v sg >/dev/null 2>&1; then
      printf '\nDocker access was granted, but this session cannot refresh its groups.\n'
      printf 'Log out and back in once, then run this launcher again.\n'
      false
    fi

    # Group changes normally require a logout. `sg` applies the new docker
    # group to this one command so first-run setup can continue immediately.
    USE_DOCKER_GROUP=true
  else
    printf '\nDocker is unavailable:\n%s\n' "$DOCKER_OUTPUT"
    false
  fi
fi

if [[ "$USE_DOCKER_GROUP" == "true" ]]; then
  printf 'Docker access granted. Continuing setup now.\n'
  printf -v LAUNCH_COMMAND '%q ' node scripts/start-persistent.mjs "$@"
  sg docker -c "$LAUNCH_COMMAND"
else
  node scripts/start-persistent.mjs "$@"
fi

trap - ERR
