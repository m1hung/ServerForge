# ServerForge

**Launch a game server in minutes, not hours.**

A self-hosted panel for deploying, configuring, monitoring, backing up and
modding game servers. Built to be genuinely usable by someone who has never
opened a `server.properties` file, without getting in the way of someone who
lives in one.

> Renaming the product is three variables in `.env` — see [Rebranding](#rebranding).

---

## What it supports today

| Game                        | Editions                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Minecraft: Java Edition** | Vanilla · Paper · Purpur · Fabric · Forge · NeoForge · Modrinth modpacks · CurseForge-style `.zip` server packs |
| **Palworld**                | Vanilla dedicated · Modded (UE4SS workflow)                                                                     |

Adding a game means writing one adapter file and adding it to a list. Nothing
in the API, the workers, or the dashboard needs to change —
see [docs/adding-a-game.md](docs/adding-a-game.md).

## Features

- **Guided deploy** — four questions, safe defaults, ready to play
- **Live console** with command history, filtering, and plain-language
  explanations of common errors ("the server ran out of memory — raise the
  limit in Settings")
- **Live resource graphs** — CPU, memory, disk, players, uptime
- **Settings that explain themselves** — one declarative schema per game drives
  the UI, validation and the game's own config files
- **Progressive disclosure** — beginners see 8 settings, experts see all of them
- **File manager** — browse, edit, upload, unpack, download, with hard path
  containment
- **Backups** — plain `.tar.gz` you can open with any tool, plus scheduled
  backups with retention
- **Scheduled tasks** — cron-based restarts, commands and backups
- **Mods and plugins** — browse and install from Modrinth, toggle without
  deleting, or upload your own
- **Multi-user** — roles, per-server sub-users with granular permissions,
  scoped API keys, audit log
- **Crash handling** — auto-restart with a crash-loop guard, OOM detection,
  and an explanation instead of a stack trace

---

## Requirements

- **Node.js 20.11+** (22 recommended)
- **Docker** — game servers run as containers
- **PostgreSQL 14+** and **Redis 7+** — the compose file provides both

Your user must be able to reach the Docker socket:

```bash
sudo usermod -aG docker $USER
```

Log out and back in afterwards, then check it works:

```bash
docker ps
```

## Quick start

For a persistent installation, run the launcher:

```bash
./start-server.sh
```

You can also use `npm start`. The launcher installs dependencies, creates the
configuration and secrets, initializes the database, builds the production
containers, and opens the dashboard. It is idempotent, so use the same command
again after updates or a manual stop.

The stack runs detached and every service uses `restart: unless-stopped`.
Closing the terminal does not stop it, and it returns after a reboot when
Docker is enabled at boot. The launcher enables the Docker systemd service
when possible.

```bash
npm run stop:persistent
```

stops it explicitly. Data and configuration are retained.

Open <http://localhost:3000>. The first account you create owns the panel.

### Development from source

The manual development workflow remains available:

```bash
npm install
npm run bootstrap
npm run stack:up
npm run db:push
npm run db:seed
npm run dev
```

This runs the API and dashboard in the foreground with hot reload and is not
persistent. Before using either mode on anything internet-facing, read
[docs/security.md](docs/security.md) — in particular the part about the Docker
socket, which makes panel access equivalent to root on the host.

---

## Project layout

```
apps/
  api/          Fastify API, workers, Docker runtime driver
  web/          Next.js dashboard
packages/
  core/         Branding, contracts, settings-schema DSL, path safety
  db/           Prisma schema, client, seed
  adapters/     Game adapters (Minecraft family, Palworld)
docker/         Compose stack and Dockerfiles
docs/           Setup, architecture, security, operations
scripts/        bootstrap, dev runner, compose wrapper
tests/          Unit tests
```

## Commands

| Command                           | What it does                                      |
| --------------------------------- | ------------------------------------------------- |
| `npm start`                       | One-command setup and persistent production start |
| `npm run stop:persistent`         | Explicitly stop the persistent stack              |
| `npm run status:persistent`       | Show persistent service status                    |
| `npm run dev`                     | API and dashboard together, with prefixed logs    |
| `npm run build`                   | Build every package                               |
| `npm test`                        | Run the test suite                                |
| `npm run typecheck`               | Typecheck the whole workspace                     |
| `npm run stack:up` / `stack:down` | Postgres and Redis                                |
| `npm run stack:full`              | Everything, in containers                         |
| `npm run db:push`                 | Apply the schema (development)                    |
| `npm run db:migrate`              | Create and apply a migration                      |
| `npm run db:seed`                 | Create the local node and its port allocations    |
| `npm run db:studio`               | Browse the database                               |

The compose commands work with both `docker compose` and the older
standalone `docker-compose`; the wrapper picks whichever is installed.

## Rebranding

Change three variables in `.env` and their `NEXT_PUBLIC_` mirrors:

```bash
BRAND_NAME="Your Panel"
BRAND_TAGLINE="Your promise here."
BRAND_ACCENT="#7c3aed"
```

That covers the UI, page titles, container name prefixes, Docker labels and
API headers. No source file hardcodes the product name in user-visible text.

## Documentation

- [Setup](docs/setup.md) — installation, configuration, troubleshooting
- [Architecture](docs/architecture.md) — how the pieces fit together
- [Adding a game](docs/adding-a-game.md) — the adapter contract, with a worked example
- [Security](docs/security.md) — threat model and hardening
- [Operations](docs/operations.md) — backups, upgrades, monitoring

## Status

Early. The core is built and tested, and the pieces below are the honest gaps:

- **Remote nodes** — the `RuntimeDriver` interface is shaped for it and the
  database models it, but only the local Docker driver is implemented
- **CurseForge** — modpack import works via uploaded server-pack `.zip`.
  Direct API browsing requires each host to supply their own CurseForge API
  key, per their terms; without one the panel says so plainly rather than
  failing oddly
- **Two-factor auth** — schema is in place, flow is not built

## Licence

AGPL-3.0-or-later.
