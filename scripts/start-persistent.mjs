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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const args = new Set(process.argv.slice(2));

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

function commandExists(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    stdio: options.quiet ? "ignore" : "inherit",
  });

  if (result.error)
    throw new Error(`Could not run ${command}: ${result.error.message}`);
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
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error(
    `PostgreSQL did not become reachable on port ${port} within 60 seconds`,
  );
}

async function waitForHttp(url, label, timeoutMs = 120_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The API container may still be building or waiting for its dependencies.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    `${label} did not become reachable at ${url} within two minutes`,
  );
}

function ensureDocker() {
  if (!commandExists("docker")) {
    throw new Error(
      "Docker is not installed. Install Docker Engine and run this launcher again.",
    );
  }

  const docker = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (docker.status !== 0) {
    const output = `${docker.stdout ?? ""}\n${docker.stderr ?? ""}`.trim();
    if (output.includes("permission denied")) {
      throw new Error(
        "Docker is running, but this session cannot access its socket. Run `./start-server.sh` so the launcher can repair group access.",
      );
    }
    throw new Error(
      `Docker is unavailable. ${output || "Verify `docker ps` works."}`,
    );
  }

  success("Docker is ready");
}

function openDashboard(url) {
  if (args.has("--no-open")) return;

  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "linux" &&
          (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
        ? { command: "xdg-open", args: [url] }
        : null;

  if (!opener) return;
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
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
  compose(["up", "-d", "postgres", "redis"]);
  const env = readEnv();
  await waitForPort(Number(env.POSTGRES_PORT || 5432));
  success("PostgreSQL and Redis are running");

  section("3/5 Initializing application data");
  run(npm, ["run", "db:push"], { label: "Database schema setup" });
  run(npm, ["run", "db:seed"], { label: "Database seed" });
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
  ]);
  await waitForHttp(
    `http://127.0.0.1:${Number(env.API_PORT || 8080)}/health`,
    "The API",
  );
  await waitForHttp(
    `http://127.0.0.1:${Number(env.WEB_PORT || 3000)}`,
    "The dashboard",
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
