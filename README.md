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
| **Valheim**                 | Vanilla dedicated · BepInEx mods                                                                                |

Adding a game usually means writing a **manifest** — a declarative description
of how the server installs, launches and logs, with no code at all. Games that
need real logic (Minecraft resolves versions across several publishers' APIs
and unpacks modpacks) are written as adapters instead. Either way nothing in
the API, the workers, or the dashboard changes —
see [docs/adding-a-game.md](docs/adding-a-game.md).

## Features

- **Guided deploy** — four questions, safe defaults, ready to play
- **Live console** with command history, filtering, and plain-language
  explanations of common errors ("the server ran out of memory — raise the
  limit in Settings")
- **Live resource graphs** — CPU, memory, disk, players, uptime
- **Who's online** — player names read from the console, for the games whose
  logs announce them; the panel says so plainly for the ones that don't
- **Settings that explain themselves** — one declarative schema per game drives
  the UI, validation and the game's own config files
- **Progressive disclosure** — beginners see 8 settings, experts see all of them
- **File manager** — browse, edit, upload, unpack, download, with hard path
  containment
- **Backups** — plain `.tar.gz` you can open with any tool, plus scheduled
  backups with retention
- **Scheduled tasks** — cron-based restarts, commands, backups and webhooks, or
  the same actions triggered by something the server did (a player joins, it
  finishes starting, it crashes), with a cooldown so a busy server does not fire
  them repeatedly
- **Webhook alerts** — post to Discord or any JSON endpoint when a task runs,
  with `{player}` and `{server}` filled in. Outbound requests are checked
  against private address space and never follow redirects
- **Mods and plugins** — browse and install from Modrinth, toggle without
  deleting, or upload your own
- **Steam branches** — run a game's public test build, or pin an older one
  while your mods catch up, with a password for the locked ones
- **Multi-user** — panel roles, per-server sub-users with granular permissions,
  scoped API keys, audit log
- **Access roles** — named permission sets you define once and hand out per
  server, with allow / neutral / **deny**, where a deny overrides everything
  short of the panel owner
- **Two-factor auth** — TOTP from any authenticator app: scan the QR or type
  the key, with single-use recovery codes for when the phone is gone
- **Custom CSS themes** — drop a `.css` file in `data/themes/` and pick it under
  Account → Appearance (see `themes/README.md`)
- **Crash handling** — auto-restart with a crash-loop guard, OOM detection,
  and an explanation instead of a stack trace
- **HTTPS without the yak shave** — point a domain at the box, set one variable
  and run `npm run stack:tls`; Caddy gets and renews the certificate itself

---

## Requirements

- **Node.js 20.11+** (22 recommended)
- **Docker** — game servers run as Linux containers
  - Linux: Docker Engine
  - macOS / Windows: [Docker Desktop](https://docs.docker.com/desktop/)
- **PostgreSQL 14+** and **Redis 7+** — the compose file provides both

Confirm Docker works before anything else:

```bash
docker ps
```

**Linux:** if that fails with a permission error:

```bash
sudo usermod -aG docker $USER
```

Log out and back in afterwards.

**Windows:** install Docker Desktop with the WSL 2 backend. Running ServerForge
inside WSL is the smoothest path; native PowerShell/cmd also works once Desktop
is running. Keep the project under a path Docker Desktop can share (typically
somewhere under your user profile).

**macOS:** install and start Docker Desktop, then confirm `docker ps` works.

## Quick start

### Persistent install (all platforms)

```bash
npm start
```

Or use the platform launcher:

| Platform | Command |
| -------- | ------- |
| Linux | `./start-server.sh` (also enables Docker at boot / fixes group access) |
| macOS | `npm start` |
| Windows | `start-server.cmd` or `npm start` |

The launcher installs dependencies, creates configuration and secrets,
initializes the database, builds the production containers, and opens the
dashboard. It is idempotent — run it again after updates or a manual stop.

The stack runs detached and every service uses `restart: unless-stopped`.
Closing the terminal does not stop it. On Linux, the bash launcher also enables
Docker at boot when systemd is available.

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
themes/         Built-in CSS colour themes (drop more in data/themes/)
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
| `npm run lint`                    | Lint the whole workspace (warnings fail)          |
| `npm run stack:up` / `stack:down` | Postgres and Redis                                |
| `npm run stack:full`              | Everything, in containers                         |
| `npm run stack:tls`               | Everything, behind HTTPS on `PANEL_DOMAIN`        |
| `npm run db:push`                 | Apply the schema (development)                    |
| `npm run db:migrate`              | Create and apply a migration                      |
| `npm run db:seed`                 | Create the local node and its port allocations    |
| `npm run db:studio`               | Browse the database                               |

The compose commands work with both `docker compose` and the older
standalone `docker-compose`; the wrapper picks whichever is installed.

`npm test` includes an integration suite that drives the Docker runtime
driver against real Docker — creating containers, streaming their logs,
writing to their stdin and stopping them. It skips itself when the socket is
unreachable, so a machine without Docker still gets a green run. If it skips
when you did not expect it to, the usual cause is not being in the `docker`
group yet:

```bash
sudo usermod -aG docker $USER
```

Log out and back in, since group membership is only picked up at login.
Everything the suite creates is named `sf-selftest-*` and removed afterwards.

## Rebranding

Change three variables in `.env` and their `NEXT_PUBLIC_` mirrors:

```bash
BRAND_NAME="Your Panel"
BRAND_TAGLINE="Your promise here."
BRAND_ACCENT="#7c3aed"
```

That covers the UI, page titles, container name prefixes, Docker labels and
API headers. No source file hardcodes the product name in user-visible text.

## Custom CSS themes

The dashboard is driven by CSS variables in `apps/web/src/app/globals.css`, and
themes can go further — fonts, chrome, clip-paths, and CSS animation.

1. Copy an example from `themes/` (or write your own — see `themes/README.md`)
2. Put it in `data/themes/` (created by bootstrap)
3. Open **Account → Appearance** and pick it

Built-in themes include colour palettes (`ember`, `forest`, `slate`) and full
redesigns (`zenless`, `blueprint`, `phosphor`, `arcade`, `inkseal`, `obsidian`).
Owners and admins can set the panel-wide default. Light/dark mode (sidebar
sun/moon) still applies; redesign themes should define both `html.dark` and
`html.light` (or scoped `[data-sf-theme].light`).

The active theme id is exposed as `data-sf-theme` on `<html>`, with stable
hooks like `[data-sf-sidebar]` and `[data-sf-control="button"]` for deep
restyles.

## Documentation

- [Setup](docs/setup.md) — installation, configuration, troubleshooting
- [Architecture](docs/architecture.md) — how the pieces fit together
- [Adding a game](docs/adding-a-game.md) — the adapter contract, with a worked example
- [Security](docs/security.md) — threat model and hardening
- [Operations](docs/operations.md) — backups, upgrades, monitoring

## Status

Early. The core is built and tested, and the pieces below are the honest gaps:

- **Remote nodes** — the `RuntimeDriver` interface is shaped for it and the
  database models it, but only the local Docker driver is implemented. Note
  that container operations are the *only* thing it abstracts: the file
  manager, backups and installs all reach the filesystem directly, so a remote
  node needs a storage driver that does not exist yet
- **CurseForge** — modpack import works via uploaded server-pack `.zip`.
  Direct API browsing requires each host to supply their own CurseForge API
  key, per their terms. Paste one into **Panel settings → Integrations** and
  browsing turns on; without a key the panel says so plainly rather than
  failing oddly
- **Game breadth** — three games. The manifest format now covers the common
  case and Valheim runs on it, but Palworld is still a hand-written adapter and
  the catalogue is small. Manifests are loaded from the source tree; picking
  them up from `data/games/` so operators can add one without rebuilding is the
  next step
- **Console transport** — panel commands are written to the container's stdin.
  Games that only accept RCON can stream their logs but cannot be commanded
  from the console yet

## Licence

AGPL-3.0-or-later.
