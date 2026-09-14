#!/usr/bin/env node
/**
 * One-command production launcher.
 *
 * Safe to run on a fresh checkout or an existing installation. It prepares
 * configuration, initializes the database, starts the complete Docker stack
 * in detached mode, and leaves Docker responsible for keeping it alive.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dockerFixHint, ensureDockerGroupAccess, probeDocker } from "./lib/docker-access.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const winShell = process.platform === "win32";
const npm = resolveNpm();

// Linux: account may already be in `docker` while this shell is not. Re-exec
// under `sg docker` before any compose/socket work (same idea as start-server.sh).
ensureDockerGroupAccess({ cwd: root, argv: process.argv });

const color = {
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
};

function section(message) {
  console.log(`\n${color.bold(message)}`);
}

function success(message) {
  console.log(`${color.green("✓")} ${message}`);
}

function resolveNpm() {
  const name = process.platform === "win32" ? "npm.cmd" : "npm";
  const besideNode = path.join(path.dirname(process.execPath), name);
  if (fs.existsSync(besideNode)) return besideNode;
  return name;
}

function commandError(command, error) {
  const missingNpm =
    error?.code === "ENOENT" &&
    (command === "npm" ||
      command === "npm.cmd" ||
      path.basename(command) === "npm" ||
      path.basename(command) === "npm.cmd");

  if (missingNpm) {
    return [
      "npm is not installed or is not on PATH.",
      "ServerForge needs Node.js and npm. On some Linux distributions (including Arch),",
      "nodejs and npm are separate packages — installing Node does not install npm.",
      "",
      "Install npm, then run this launcher again:",
      "  Arch Linux:    sudo pacman -S npm",
      "  Debian/Ubuntu: sudo apt install npm",
      "  Fedora:        sudo dnf install npm",
      "  macOS/Windows: install Node.js from https://nodejs.org/ (includes npm)",
    ].join("\n");
  }

  return `Could not run ${command}: ${error.message}`;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    stdio: options.quiet ? "ignore" : "inherit",
    shell: winShell,
  });

  if (result.error) throw new Error(commandError(command, result.error));
  if (result.status !== 0) {
    throw new Error(
      `${options.label ?? command} exited with status ${result.status ?? "unknown"}`,
    );
  }
}

function compose(commandArgs, options) {
  run(process.execPath, ["scripts/compose.mjs", ...commandArgs], {
    label: "Docker Compose",
    ...options,
  });
}

function readEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return {};

  const values = {};
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(port, timeoutMs = 60_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const open = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(1_500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });

    if (open) return;
    await sleep(1_500);
  }

  throw new Error(
    `PostgreSQL did not become reachable on port ${port} within 60 seconds`,
  );
}

function composeHasWaitFlag() {
  for (const command of [
    ["docker", ["compose", "up", "--help"]],
    ["docker-compose", ["up", "--help"]],
  ]) {
    const result = spawnSync(command[0], command[1], {
      encoding: "utf8",
      shell: winShell,
    });
    if (/--wait\b/.test(`${result.stdout ?? ""}${result.stderr ?? ""}`)) {
      return true;
    }
  }
  return false;
}

function startDatabaseContainers() {
  if (composeHasWaitFlag()) {
    compose([
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "60",
      "postgres",
      "redis",
    ]);
    return;
  }
  compose(["up", "-d", "postgres", "redis"]);
}

function postgresContainerId() {
  const result = spawnSync(
    "docker",
    ["ps", "-q", "--filter", "name=serverforge-postgres"],
    { cwd: root, encoding: "utf8", shell: winShell },
  );
  return (result.stdout ?? "").trim().split(/\s+/).filter(Boolean)[0] ?? "";
}

/**
 * True when Postgres inside the container will accept a connection.
 *
 * Do not use the published host port for this: Docker's proxy listens on
 * 127.0.0.1:5432 the instant the container starts, including during first-boot
 * initdb, so a TCP connect is not "ready". Prisma then fails with P1001.
 */
function pgIsReady() {
  const id = postgresContainerId();
  if (!id) return false;
  const env = readEnv();
  const result = spawnSync(
    "docker",
    [
      "exec",
      id,
      "pg_isready",
      "-U",
      env.POSTGRES_USER || "serverforge",
      "-d",
      env.POSTGRES_DB || "serverforge",
    ],
    { cwd: root, encoding: "utf8", shell: winShell },
  );
  return result.status === 0;
}

async function waitForPostgres(timeoutMs = 60_000) {
  const startedAt = Date.now();
  let hits = 0;
  let lastNotice = 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (pgIsReady()) {
      hits += 1;
      // First-boot initdb brings a temporary server up, then shuts it down,
      // then starts the real one. Require a short streak so we do not hand
      // Prisma the gap in between.
      if (hits >= 3) return;
    } else {
      hits = 0;
    }

    const waited = Math.round((Date.now() - startedAt) / 1000);
    if (waited - lastNotice >= 10) {
      lastNotice = waited;
      console.log(color.dim(`  waiting for postgresql… ${waited}s`));
    }
    await sleep(500);
  }

  throw new Error(
    [
      "PostgreSQL did not become ready within 60 seconds.",
      "",
      ...describeContainerTrouble("serverforge-postgres-1"),
    ].join("\n"),
  );
}

async function runRetry(command, commandArgs, options, attempts = 8) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      run(command, commandArgs, options);
      return;
    } catch (error) {
      lastError = error;
      if (i === attempts) break;
      console.log(
        color.dim(
          `  ${options.label ?? command} not ready yet, retrying… (${i}/${attempts})`,
        ),
      );
      await sleep(1_000);
    }
  }
  throw lastError;
}

/**
 * Waits for a service to answer, saying so while it waits.
 *
 * The silence here used to be the whole problem: two minutes of no output
 * after "Container serverforge-web-1 Started" is indistinguishable from a
 * hung launcher, and people reasonably killed it before it ever reported
 * anything. It prints progress now, and when it does give up it says what
 * the container itself was complaining about — which is nearly always the
 * actual answer.
 */
async function waitForHttp(url, label, container, timeoutMs = 120_000) {
  const startedAt = Date.now();
  let lastNotice = 0;
  let repairedForwarding = false;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Still starting, or waiting on its own dependencies.
    }

    const waited = Math.round((Date.now() - startedAt) / 1000);
    if (waited - lastNotice >= 10) {
      lastNotice = waited;
      console.log(color.dim(`  waiting for ${label.toLowerCase()}… ${waited}s`));

      // If the container has already decided it cannot start, waiting out the
      // rest of the timeout is the hang this used to be. One common cause is
      // Docker FORWARD rules missing for the compose bridge — restore those
      // once and retry, rather than polling a crash loop.
      if (container && containerWillNotRecover(container)) {
        if (!repairedForwarding) {
          repairedForwarding = true;
          if (repairComposeBridgeForwarding()) {
            spawnSync("docker", ["restart", container], {
              cwd: root,
              encoding: "utf8",
              shell: winShell,
            });
            continue;
          }
        }
        throw new Error(
          [
            `${label} is running but cannot start.`,
            "",
            ...describeContainerTrouble(container),
          ].join("\n"),
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    [
      `${label} did not become reachable at ${url} within two minutes.`,
      "",
      ...describeContainerTrouble(container),
    ].join("\n"),
  );
}

/**
 * True when the *latest* start attempt is blocked, not merely slow.
 *
 * Logs accumulate across restarts, so an earlier "Startup blocked" followed
 * by "API ready" must not be treated as still doomed.
 */
function containerWillNotRecover(container) {
  const result = spawnSync("docker", ["logs", "--tail", "40", container], {
    cwd: root,
    encoding: "utf8",
    shell: winShell,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const markers = [
    ...output.matchAll(/Startup blocked:|API ready|Server listening at/gi),
  ];
  if (markers.length === 0) return false;
  return /Startup blocked:/i.test(markers[markers.length - 1][0]);
}

/**
 * Docker 28+ sets FORWARD policy DROP and is supposed to ACCEPT each compose
 * bridge. After a daemon restart, UFW reload, or Tailscale rewriting
 * iptables, those per-bridge ACCEPTs are often missing even though NAT still
 * exists — so containers time out reaching Postgres/Redis on the same network.
 *
 * Restores Docker's own rules (not a blanket FORWARD ACCEPT) via the host
 * netns. The docker group can do this without sudo.
 *
 * @returns {boolean} true when rules were missing and got restored
 */
function repairComposeBridgeForwarding() {
  if (process.platform !== "linux") return false;

  const script = [
    "iptables -L DOCKER-FORWARD -n >/dev/null 2>&1 || exit 0",
    "changed=0",
    'for br in $(ip -o link show type bridge | awk -F": " \'{print $2}\' | cut -d@ -f1 | grep "^br-" || true); do',
    '  iptables -C DOCKER-FORWARD -i "$br" -j ACCEPT 2>/dev/null || { iptables -I DOCKER-FORWARD -i "$br" -j ACCEPT; changed=1; }',
    '  iptables -C DOCKER-BRIDGE -o "$br" -j DOCKER 2>/dev/null || { iptables -I DOCKER-BRIDGE -o "$br" -j DOCKER; changed=1; }',
    '  iptables -C DOCKER-CT -o "$br" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || { iptables -I DOCKER-CT -o "$br" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; changed=1; }',
    "done",
    'if [ "$changed" = 1 ]; then echo REPAIRED; else echo OK; fi',
  ].join("\n");

  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--privileged",
      "--pid=host",
      "--network=host",
      "alpine",
      "nsenter",
      "-t",
      "1",
      "-m",
      "-n",
      "--",
      "sh",
      "-c",
      script,
    ],
    { cwd: root, encoding: "utf8", shell: winShell },
  );

  if (result.status !== 0) return false;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!output.includes("REPAIRED")) return false;

  console.log(
    color.dim(
      "  restored Docker bridge forwarding rules (compose bridges were not ACCEPTed)",
    ),
  );
  return true;
}

/**
 * The tail of a stuck container's log, and a reading of it.
 *
 * A container that starts and then cannot reach Postgres or Redis looks
 * identical from outside to one that is merely slow. The difference is written
 * plainly in its own log, so the launcher fetches it rather than leaving
 * someone to discover `docker logs` on their own.
 */
function describeContainerTrouble(container) {
  if (!container) return ["Check what it is doing with:  npm run stack:logs"];

  const result = spawnSync("docker", ["logs", "--tail", "20", container], {
    cwd: root,
    encoding: "utf8",
    shell: winShell,
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output === "") return ["Check what it is doing with:  npm run stack:logs"];

  const lines = [`Last output from ${container}:`, "", ...output.split("\n").map((l) => `  ${l}`)];

  // The one failure worth naming outright. Containers that cannot reach each
  // other by name are almost never an application problem — Docker's FORWARD
  // chain is DROP, and the compose bridge was never ACCEPTed. A daemon
  // restart does not always restore those rules (UFW and Tailscale both
  // rewrite iptables around Docker).
  if (/Cannot reach (PostgreSQL|Redis)|ETIMEDOUT/i.test(output)) {
    lines.push(
      "",
      "This container is running but cannot reach the database or Redis, which",
      "are running too. That is Docker networking rather than the panel: the",
      "compose bridge is missing from Docker's FORWARD chain, so traffic between",
      "containers is dropped.",
      "",
      "The launcher tries to restore those rules on start. If you still see this,",
      "restart Docker and start again:",
      "",
      "  sudo systemctl restart docker && npm start",
    );
  }

  return lines;
}

function ensureDocker() {
  const status = process.env.DOCKER_HOST ? { ok: true } : probeDocker();
  if (status.ok) {
    success("Docker is ready");
    return;
  }

  throw new Error(
    `${status.detail || "Docker is unavailable."}\n\n${dockerFixHint(status.reason)}`,
  );
}

function openDashboard(url) {
  if (args.has("--no-open")) return;

  let opener = null;
  if (process.platform === "darwin") {
    opener = { command: "open", args: [url] };
  } else if (process.platform === "win32") {
    opener = { command: "cmd", args: ["/c", "start", "", url] };
  } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    opener = { command: "xdg-open", args: [url] };
  }

  if (!opener) return;
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  child.on("error", () => undefined);
  child.unref();
}

async function main() {
  console.log(`\n${color.bold("ServerForge persistent launcher")}`);
  console.log(
    color.dim(
      "First launch performs setup; later launches are safe and faster.",
    ),
  );

  section("1/5 Preparing the installation");
  if (!args.has("--skip-install")) {
    run(npm, ["install", "--prefer-offline", "--no-audit", "--no-fund"], {
      label: "Dependency installation",
    });
    success("Dependencies are installed");
  }
  run(process.execPath, ["scripts/bootstrap.mjs"], { label: "Bootstrap" });
  ensureDocker();

  section("2/5 Starting the database");
  startDatabaseContainers();
  const env = readEnv();
  await waitForPostgres();
  await waitForPort(Number(env.POSTGRES_PORT || 5432));
  success("PostgreSQL and Redis are running");

  section("3/5 Initializing application data");
  await runRetry(npm, ["run", "db:push"], { label: "Database schema setup" });
  await runRetry(npm, ["run", "db:seed"], { label: "Database seed" });
  success("Database is ready");

  section("4/5 Starting the persistent stack");
  compose([
    "--profile",
    "full",
    "up",
    "-d",
    "--build",
    "--force-recreate",
    "api",
    "web",
    // The tailnet sidecar. Named explicitly like the others, or `npm start`
    // would leave the panel's front door down while reporting success.
    "tailscale",
  ]);
  repairComposeBridgeForwarding();
  await waitForHttp(
    `http://127.0.0.1:${Number(env.API_PORT || 8080)}/health`,
    "The API",
    "serverforge-api-1",
  );
  await waitForHttp(
    `http://127.0.0.1:${Number(env.WEB_PORT || 3000)}`,
    "The dashboard",
    "serverforge-web-1",
  );
  success("API and dashboard are healthy");

  section("5/5 Verifying services");
  compose(["--profile", "full", "ps"]);

  const url = `http://localhost:${env.WEB_PORT || 3000}`;
  console.log(`\n${color.green(color.bold("ServerForge is running"))}`);
  console.log(`  Dashboard: ${url}`);
  console.log(
    "  Persistence: containers restart automatically unless explicitly stopped",
  );
  console.log(`  Stop later: ${color.bold("npm run stop:persistent")}`);
  console.log(`  View logs:  ${color.bold("npm run stack:logs")}\n`);
  openDashboard(url);
}

main().catch((error) => {
  console.error(
    `\n${color.yellow("ServerForge could not start:")} ${error.message}`,
  );
  console.error(
    `\n${color.dim("Inspect the services with: npm run stack:logs")}\n`,
  );
  process.exit(1);
});
