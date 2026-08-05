#!/usr/bin/env node
/**
 * First-run setup.
 *
 *   npm run bootstrap
 *
 * Creates `.env` from the example, generates the two secrets, makes the data
 * directories, and prints exactly what to run next. Idempotent: re-running it
 * never overwrites an existing secret.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const secret = () => randomBytes(32).toString("hex");

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Sets a key only when it is missing or empty, preserving user edits. */
function fillIfEmpty(contents, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (!pattern.test(contents)) return `${contents}\n${key}="${value}"\n`;

  const line = contents.match(pattern)?.[0] ?? "";
  const current = line
    .slice(key.length + 1)
    .replace(/^["']|["']$/g, "")
    .trim();
  if (current !== "") return contents;

  // Function form: a `$` in a home directory would otherwise be read as a
  // replacement pattern and mangle the path being written.
  return contents.replace(pattern, () => `${key}="${value}"`);
}

function readValue(contents, key) {
  const line = contents.match(new RegExp(`^${key}=.*$`, "m"))?.[0];
  return (
    line
      ?.slice(key.length + 1)
      .replace(/^["']|["']$/g, "")
      .trim() || null
  );
}

/** Rewrites a relative path value to an absolute one, anchored at the repo. */
function absolutise(contents, key) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const line = contents.match(pattern)?.[0];
  if (!line) return contents;

  const current = line
    .slice(key.length + 1)
    .replace(/^["']|["']$/g, "")
    .trim();
  if (current === "" || path.isAbsolute(current)) return contents;

  return contents.replace(pattern, () => `${key}="${path.resolve(root, current)}"`);
}

async function main() {
  console.log(`\n${c.bold("ServerForge setup")}\n`);

  let contents;
  if (await exists(envPath)) {
    console.log(
      `${c.green("✓")} .env already exists — filling in anything missing`,
    );
    contents = await fs.readFile(envPath, "utf8");
  } else {
    contents = await fs.readFile(examplePath, "utf8");
    console.log(`${c.green("✓")} created .env from .env.example`);
  }

  const before = contents;
  contents = fillIfEmpty(contents, "SESSION_SECRET", secret());
  contents = fillIfEmpty(contents, "ENCRYPTION_KEY", secret());
  // Resolved here rather than relying on the absolutise pass below: these two
  // are the values Docker binds game containers against, and a relative one is
  // silently wrong rather than loudly broken.
  contents = fillIfEmpty(
    contents,
    "HOST_DATA_ROOT",
    path.resolve(root, readValue(contents, "DATA_ROOT") ?? "data/servers"),
  );
  contents = fillIfEmpty(
    contents,
    "HOST_BACKUP_ROOT",
    path.resolve(root, readValue(contents, "BACKUP_ROOT") ?? "data/backups"),
  );

  if (contents !== before) console.log(`${c.green("✓")} generated secrets`);

  // Data paths must be absolute.
  //
  // Workspace scripts each run with their own package as the cwd, so a
  // relative "./data/servers" resolves to three different directories
  // depending on whether the API, the seed, or a worker resolved it — and the
  // seed would then register a node pointing somewhere the API never looks.
  const pathsBefore = contents;
  for (const key of [
    "DATA_ROOT",
    "BACKUP_ROOT",
    "CACHE_ROOT",
    "HOST_DATA_ROOT",
    "HOST_BACKUP_ROOT",
  ]) {
    contents = absolutise(contents, key);
  }
  if (contents !== pathsBefore) {
    console.log(`${c.green("✓")} made data paths absolute`);
  }

  await fs.writeFile(envPath, contents, { mode: 0o600 });

  // Directories the API refuses to start without.
  for (const dir of ["data/servers", "data/backups", "data/cache"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  console.log(`${c.green("✓")} created data directories`);

  // Warn about the one value people forget to change before exposing a panel.
  if (/POSTGRES_PASSWORD=["']?change-me-in-production/.test(contents)) {
    console.log(
      `${c.yellow("!")} the database password is still the default — fine for local use, change it before exposing this panel`,
    );
  }

  // Docker access is checked properly rather than just "does the socket
  // exist": the socket is almost always present, and the thing that actually
  // stops people is not being in the `docker` group. Finding that out here
  // beats finding out when the next command fails.
  const docker = await dockerStatus();

  if (docker !== "ok") {
    console.log(`\n${c.bold(c.yellow("Before you can continue"))}\n`);

    if (docker === "missing") {
      console.log(
        `  Docker is not running — no socket at /var/run/docker.sock.\n`,
      );
      console.log(`    ${c.cyan("sudo systemctl start docker")}\n`);
    } else {
      console.log(
        `  Your user cannot access the Docker socket. One-time fix:\n`,
      );
      console.log(`    ${c.cyan("sudo usermod -aG docker $USER")}\n`);
      console.log(
        `  Then log out and back in, or run ${c.cyan("newgrp docker")} in this`,
      );
      console.log(`  terminal. Check it worked with ${c.cyan("docker ps")}.\n`);
    }

    console.log(`  ${c.dim("Everything below needs Docker, so start there.")}`);
  }

  console.log(
    `\n${c.bold(docker === "ok" ? "Start the persistent panel:" : "Then:")}\n`,
  );
  console.log(
    `  ${c.cyan("npm start".padEnd(20))} ${c.dim("# setup, start, and keep it running")}`,
  );
  console.log(
    `\n${c.dim("For source development instead, follow docs/setup.md.")}`,
  );
  console.log(
    `\nThen open ${c.cyan("http://localhost:3000")} and create your account.\n`,
  );
}

/** 'ok' | 'denied' | 'missing' */
async function dockerStatus() {
  if (process.env.DOCKER_HOST) return "ok";
  const socket = "/var/run/docker.sock";
  if (!(await exists(socket))) return "missing";
  try {
    await fs.access(socket, fsConstants.R_OK | fsConstants.W_OK);
    return "ok";
  } catch {
    return "denied";
  }
}

main().catch((error) => {
  console.error("\nSetup failed:", error.message, "\n");
  process.exit(1);
});
