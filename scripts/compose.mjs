#!/usr/bin/env node
/**
 * Compose wrapper.
 *
 * Ubuntu still ships plenty of machines with the standalone `docker-compose`
 * v1 binary and no `docker compose` plugin. Rather than making that a
 * documentation footnote people hit as a confusing error, detect which one
 * exists and use it.
 *
 *   node scripts/compose.mjs up -d
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertDockerAccess, ensureDockerGroupAccess } from "./lib/docker-access.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(root, "docker", "docker-compose.yml");
const envFile = path.join(root, ".env");
const winShell = process.platform === "win32";

ensureDockerGroupAccess({ cwd: root, argv: process.argv });

function detect() {
  const plugin = spawnSync("docker", ["compose", "version"], {
    stdio: "ignore",
    shell: winShell,
  });
  if (plugin.status === 0) return { command: "docker", prefix: ["compose"] };

  const standalone = spawnSync("docker-compose", ["version"], {
    stdio: "ignore",
    shell: winShell,
  });
  if (standalone.status === 0) return { command: "docker-compose", prefix: [] };

  return null;
}

/**
 * Absolute host bind-mount roots, resolved against the repo.
 *
 * Compose resolves a relative volume source against the *compose file's*
 * directory (docker/), but hands the same text to the API verbatim as
 * HOST_DATA_ROOT, which resolves it against the API's own working directory.
 * A relative value therefore names two different directories: the panel tells
 * the daemon to bind a path nothing ever wrote to, Docker creates it empty,
 * and the game server dies on a missing jar.
 *
 * Resolving here — the only place that knows where the repo root is — makes
 * both sides the same absolute path regardless of where compose was invoked
 * from. Shell variables outrank `--env-file` in Compose, so these win over
 * .env; a value already set in either is kept, only made absolute.
 */
function hostRoots() {
  const fromEnvFile = readEnvFile();

  return Object.fromEntries(
    [
      ["HOST_DATA_ROOT", "data/servers"],
      ["HOST_BACKUP_ROOT", "data/backups"],
    ].map(([key, fallback]) => {
      const configured = (process.env[key] ?? fromEnvFile[key] ?? "").trim();
      return [
        key,
        path.resolve(root, configured === "" ? fallback : configured),
      ];
    }),
  );
}

/** Minimal .env reader — only the two path keys above are ever consulted. */
function readEnvFile() {
  if (!existsSync(envFile)) return {};

  const values = {};
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

assertDockerAccess();

const tool = detect();

if (!tool) {
  console.error(
    [
      "",
      "Docker Compose was not found.",
      "",
      "  Install Docker Desktop (Windows/macOS) or the Compose plugin (Linux):",
      "  https://docs.docker.com/compose/install/",
      "",
      "  On Linux you can also:  sudo apt install docker-compose-plugin",
      "",
      "You can also run Postgres and Redis yourself and point DATABASE_URL",
      "and REDIS_URL at them — nothing else in the panel requires Compose.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const child = spawn(
  tool.command,
  [
    ...tool.prefix,
    "--file",
    composeFile,
    "--env-file",
    envFile,
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, ...hostRoots() },
    shell: winShell,
  },
);

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error(`Could not run ${tool.command}: ${error.message}`);
  process.exit(1);
});
