/**
 * Cross-platform Docker readiness checks for host-side scripts.
 *
 * Prefer `docker info` over probing a fixed socket path: Docker Desktop on
 * Windows uses a named pipe, and macOS sometimes exposes the CLI socket under
 * ~/.docker/run rather than /var/run.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Candidate unix sockets / named pipes when DOCKER_HOST is unset.
 * On Windows the named pipe is not a filesystem path — do not existsSync it.
 */
export function dockerSocketCandidates() {
  if (process.env.DOCKER_SOCKET?.trim()) {
    return [process.env.DOCKER_SOCKET.trim()];
  }
  if (process.platform === "win32") {
    return ["//./pipe/docker_engine"];
  }
  return [
    "/var/run/docker.sock",
    path.join(homedir(), ".docker", "run", "docker.sock"),
  ];
}

/** Default DOCKER_SOCKET value for .env / API config on this host. */
export function defaultDockerSocket() {
  if (process.platform === "win32") return "//./pipe/docker_engine";
  for (const candidate of dockerSocketCandidates()) {
    try {
      accessSync(candidate, constants.R_OK | constants.W_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return "/var/run/docker.sock";
}

/**
 * @returns {{ ok: true } | { ok: false, reason: 'missing' | 'denied' | 'unavailable', detail: string }}
 */
export function probeDocker() {
  const result = spawnSync("docker", ["info"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error?.code === "ENOENT") {
    return {
      ok: false,
      reason: "missing",
      detail: "Docker is not installed or is not on PATH.",
    };
  }

  if (result.status === 0) return { ok: true };

  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/permission denied/i.test(detail)) {
    return { ok: false, reason: "denied", detail };
  }
  return {
    ok: false,
    reason: "unavailable",
    detail: detail || "docker info failed.",
  };
}

/** Human-readable fix steps for the current platform. */
export function dockerFixHint(reason) {
  const lines = (items) => items.map((line) => `  ${line}`).join("\n");

  if (process.platform === "win32") {
    if (reason === "missing") {
      return lines([
        "Install Docker Desktop for Windows, start it, and wait until it reports Running.",
        "Then open a new terminal and confirm `docker ps` works.",
        "https://docs.docker.com/desktop/setup/install/windows-install/",
      ]);
    }
    return lines([
      "Start Docker Desktop and wait until the whale icon shows it is running.",
      "Confirm `docker ps` works in this terminal, then retry.",
      "WSL 2 is recommended: clone and run ServerForge inside your WSL distro",
      "with Docker Desktop's WSL integration enabled.",
    ]);
  }

  if (process.platform === "darwin") {
    if (reason === "missing") {
      return lines([
        "Install Docker Desktop for Mac, start it, and wait until it is Running.",
        "https://docs.docker.com/desktop/setup/install/mac-install/",
      ]);
    }
    return lines([
      "Start Docker Desktop and wait until it reports Running.",
      "Confirm `docker ps` works, then retry.",
      "If the CLI cannot find the daemon, set DOCKER_HOST or DOCKER_SOCKET",
      "to your Docker Desktop socket (often ~/.docker/run/docker.sock).",
    ]);
  }

  // Linux
  if (reason === "missing" || reason === "unavailable") {
    const socketMissing = !existsSync("/var/run/docker.sock");
    if (socketMissing) {
      return lines([
        "Start Docker:  sudo systemctl start docker",
        "Enable at boot: sudo systemctl enable docker",
      ]);
    }
    return lines([
      "Docker CLI is present but the daemon did not answer.",
      "Try:  sudo systemctl start docker",
    ]);
  }

  return lines([
    "Grant Docker access (one-time):",
    "  sudo usermod -aG docker $USER",
    "Then log out and back in, or run:  newgrp docker",
    "Check with:  docker ps",
  ]);
}

/**
 * Exit with a clear message when the host cannot talk to Docker.
 * No-op when DOCKER_HOST is set (remote / unusual setups).
 */
export function assertDockerAccess() {
  if (process.env.DOCKER_HOST) return;

  const status = probeDocker();
  if (status.ok) return;

  const title =
    status.reason === "denied"
      ? "Your user cannot access the Docker daemon."
      : status.reason === "missing"
        ? "Docker does not appear to be available."
        : "Docker is unavailable.";

  console.error(["", title, "", dockerFixHint(status.reason), ""].join("\n"));
  if (status.detail && status.reason === "unavailable") {
    console.error(`  Detail: ${status.detail.split("\n")[0]}\n`);
  }
  process.exit(1);
}
