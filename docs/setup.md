# Setup

## Requirements

- Node.js 20.11 or newer (22 recommended)
- Docker with a working CLI (`docker ps`)
  - **Linux:** Docker Engine; your user should be in the `docker` group
  - **macOS / Windows:** [Docker Desktop](https://docs.docker.com/desktop/)
- Docker Compose — either `docker compose` or the older `docker-compose`

Check Docker access before anything else:

```bash
docker ps
```

### Linux

If that fails with a permission error:

```bash
sudo usermod -aG docker $USER
```

Log out and back in. Group membership does not apply to existing sessions.

### macOS

Install Docker Desktop, start it, and wait until it reports Running. The
default socket is usually `/var/run/docker.sock`; if the CLI cannot find the
daemon, set `DOCKER_SOCKET` in `.env` to `~/.docker/run/docker.sock` (bootstrap
detects this automatically when possible).

### Windows

Install Docker Desktop with the **WSL 2** backend.

- **Recommended:** clone the repo inside your WSL distro and run `npm start`
  there (with Docker Desktop’s WSL integration enabled for that distro).
- **Native:** from PowerShell or cmd in the project folder, run
  `npm start` or `start-server.cmd` while Docker Desktop is running.

Keep `HOST_DATA_ROOT` / the project under a path Docker Desktop can share
(usually somewhere in your user profile). Game servers always run as Linux
containers; the host OS only needs Node for bootstrap and Compose.

## Persistent one-click install

From the project directory:

```bash
npm start
```

Platform-specific launchers:

| Platform | Command |
| -------- | ------- |
| Linux | `./start-server.sh` |
| Windows | `start-server.cmd` or `.\start-server.ps1` |
| Any | `npm start` |

This single launcher is safe on both new and existing installations. It
installs dependencies, runs bootstrap, starts Postgres and Redis, applies and
seeds the database, then builds and starts the API and dashboard in detached
production containers.

Closing the terminal does not stop the panel. Every service has
`restart: unless-stopped`, so it also returns after a reboot when Docker starts
at boot. On Linux with systemd, `./start-server.sh` enables Docker at boot when
possible. Check it at any time with:

```bash
npm run status:persistent
```

Stop it explicitly with:

```bash
npm run stop:persistent
```

Configuration, database volumes, game files, and backups are retained.

## Development install

```bash
npm install
```

```bash
npm run bootstrap
```

Bootstrap creates `.env`, generates `SESSION_SECRET` and `ENCRYPTION_KEY`, and
makes the data directories. It never overwrites a value you have already set,
so re-running it is safe.

```bash
npm run stack:up
```

```bash
npm run db:push
```

```bash
npm run db:seed
```

The seed registers this machine as a node and pre-creates its port allocations
(25500–25999 by default). Without it, deploys fail with "no free ports".

```bash
npm run dev
```

Open <http://localhost:3000> and create your account. The first account owns
the panel.

## Configuration

Everything lives in `.env`. The values worth knowing:

| Variable               | Default                  | Notes                                  |
| ---------------------- | ------------------------ | -------------------------------------- |
| `BRAND_NAME`           | `ServerForge`            | Also set `NEXT_PUBLIC_BRAND_NAME`      |
| `DATABASE_URL`         | local Postgres           |                                        |
| `REDIS_URL`            | `redis://localhost:6379` |                                        |
| `API_PORT`             | `8080`                   |                                        |
| `WEB_PORT`             | `3000`                   |                                        |
| `NEXT_PUBLIC_API_URL`  | `http://localhost:8080`  | Must be reachable **from the browser** |
| `CORS_ORIGINS`         | `http://localhost:3000`  | Exact origins, comma separated         |
| `DATA_ROOT`            | `./data/servers`         | Where game files live                  |
| `BACKUP_ROOT`          | `./data/backups`         |                                        |
| `THEMES_ROOT`          | `./data/themes`          | Custom CSS themes                      |
| `HOST_DATA_ROOT`       | absolute `DATA_ROOT`     | Container mount; must be absolute      |
| `HOST_BACKUP_ROOT`     | absolute `BACKUP_ROOT`   | Container mount; must be absolute      |
| `HOST_THEMES_ROOT`     | absolute `data/themes`   | Container mount; must be absolute      |
| `PORT_RANGE_START/END` | `25500`/`25999`          | Change before seeding                  |
| `UPNP_ENABLED`         | `false`                  | Automatic router forwarding, see below |
| `CURSEFORGE_API_KEY`   | empty                    | Optional, see below                    |

`NEXT_PUBLIC_*` values are inlined at build time. Changing them means
rebuilding the dashboard.

### Serving to other machines

With `NEXT_PUBLIC_API_URL=auto` (the Docker default), open the dashboard at
`http://<this-machine-lan-ip>:3000`. Backups and game files stay on the host;
remote browsers only drive the panel.

Make sure every origin you use is listed:

```bash
CORS_ORIGINS="http://localhost:3000,http://192.168.1.50:3000"
COOKIE_SECURE="false"
```

`COOKIE_SECURE=false` is required for plain HTTP on a LAN IP — browsers reject
Secure cookies outside `localhost`. Set it to `true` only behind TLS.

Then set the node's public host so join addresses are correct — Settings →
Machines, or directly:

```bash
npm run db:studio
```

Before doing this over the internet, read [security.md](security.md).

### Letting people connect from outside your network

Three things have to line up, and only the first is automatic:

1. **Your router must forward the game port** to this machine.
2. **The node's public host** must be your public address, not a LAN IP —
   otherwise the panel hands players an address that cannot leave their house.
3. **Your public address must be stable**, or become stable via dynamic DNS.
   Most home connections get a new one periodically.

The first-run wizard covers all three without a terminal. It asks one question
— who should be able to join — and writes the answer itself. For (3) it can
keep a DuckDNS name pointed at your connection: the token is stored encrypted,
verified the moment you save, and refreshed every 15 minutes.

That refresh always sends the IPv4 address **explicitly**, read from your
router rather than inferred from the connection. On a dual-stack host the
inferred form is actively dangerous — providers use whichever family the
request arrived on, so an update over IPv6 replaces or deletes the `A` record
and the hostname stops resolving for most players. See
`tests/ddns-providers.test.ts`.

For (1), the panel can drive the router itself over UPnP:

```bash
UPNP_ENABLED="true"
```

Each server then gets its game port forwarded when it starts and released when
it stops. **Only the game port is ever forwarded.** Adapters also declare rcon
and query ports, usually on the very next numbers — rcon is a remote console,
so forwarding a *range* would hand the internet a command channel into the
server. The filter lives in `forwardablePorts()` and is covered by
`tests/forwardable-ports.test.ts`; there is no option to widen it.

Mappings are re-asserted every 15 minutes rather than held by a lease, because
the thing that actually breaks a home setup is the router rebooting and
forgetting its table. Stopping the panel deliberately leaves mappings in place,
so a panel restart never drops players out of a running server.

Two caveats:

- **Discovery does not work from a container.** SSDP is multicast and does not
  cross Docker's bridge, so the containerised API cannot find the router. The
  SOAP calls that follow are ordinary unicast HTTP and work fine, so set
  `UPNP_CONTROL_URL` to the control endpoint from your router's device
  description. Running the API on the host (`npm run dev`) needs no such help.
- **UPnP is a trust decision at the router**, not here: once enabled, any
  device on your LAN can open ports. If that is not acceptable, leave
  `UPNP_ENABLED=false` and add one static forward for the game port instead —
  allocations are handed out in ascending order from `PORT_RANGE_START`, so a
  single forward covers a single server indefinitely.

If your ISP puts you behind carrier-grade NAT, no amount of forwarding will
help — the address in your router is not reachable from outside. Check by
comparing the router's WAN address against `curl -s https://ifconfig.me`; if
they differ, or the WAN address is inside `100.64.0.0/10`, you need a relay
(Tailscale for a friends-only server, or a tunnel service for a public one).

### CurseForge

CurseForge requires each host to use their own API key under their terms, so
none is bundled. Without a key, modpack import still works: download the
modpack's **server pack** `.zip`, upload it in the Files tab, and unpack it.

With a key from <https://console.curseforge.com/>, in-panel browsing becomes
available. Paste it into **Panel settings → CurseForge**, where it is stored
encrypted with `ENCRYPTION_KEY` and never shown again — no restart, and no
editing `.env` on the server.

`CURSEFORGE_API_KEY` in the environment still works and is the better choice
for a deployment configured from a file. A key saved in the panel takes
precedence; clearing the field in the panel hands control back to the
environment.

Modrinth needs no key and works out of the box.

## Troubleshooting

**"Cannot reach PostgreSQL"** — `npm run stack:up`, then check
`docker ps` shows the postgres container as healthy.

**"Cannot reach the Docker daemon"** — the group fix above. The API starts
without Docker but cannot deploy anything.

**"This machine has no free ports left"** — you ran `db:seed` before setting
`PORT_RANGE_START/END`, or you genuinely used them all. Widen the range in
`.env` and re-run `npm run db:seed`; it only adds the missing rows.

**Deploy fails with "Could not create the server folder"** — `DATA_ROOT` does
not exist or is not writable by the user running the API.

**"Unable to access jarfile server.jar"** — the server directory Docker mounted
is not the one the panel installed into. `HOST_DATA_ROOT` must be the host path
that `DATA_ROOT` is mounted from, absolute and identical on both sides; anything
else and Docker creates an empty directory instead. The API refuses to start
when it can prove they disagree, and names the correct value in the error. Fix
it with `npm run bootstrap`, then recreate the stack:

```bash
npm run stop:persistent && ./start-server.sh
```

**Server installs, then immediately crashes** — open the Console tab. Common
causes are already explained inline there: too little memory, a port conflict,
or a mod loader mismatch.

**Container starts but the world is not saved** — the panel chowns server
directories to uid 1000, which requires root. If the API runs as an unprivileged
user, `chown` the data directory yourself:

```bash
sudo chown -R 1000:1000 data/servers
```

**Dashboard loads but says it cannot reach the panel** — `NEXT_PUBLIC_API_URL`
points somewhere the _browser_ cannot reach. `localhost` inside a container is
not `localhost` in your browser.

## Production

```bash
./start-server.sh
```

The launcher builds and runs the API and dashboard as containers alongside
Postgres and Redis. Bootstrap fills `HOST_DATA_ROOT` and `HOST_BACKUP_ROOT`
with absolute paths automatically so sibling game containers and the API use
the same files.

Put TLS in front of both services — see below — and read
[security.md](security.md).

## HTTPS

For a LAN-only panel, skip this: plain HTTP on your own network is fine and
`COOKIE_SECURE="false"` is the correct setting for it.

For a panel with a domain name pointing at it, the `tls` profile puts Caddy in
front and handles certificates itself. There is no certbot step and nothing to
renew.

**Before you start**, the domain's A (or AAAA) record must already resolve to
this machine, and ports 80 and 443 must reach it. Port 80 is not optional —
it is how Let's Encrypt verifies you control the name.

Set these in `.env`:

```bash
PANEL_DOMAIN="panel.example.com"
TLS_EMAIL="you@example.com"          # optional, for expiry warnings
BIND_HOST="127.0.0.1"
NEXT_PUBLIC_API_URL="https://panel.example.com"
CORS_ORIGINS="https://panel.example.com"
COOKIE_SECURE="true"
```

Then:

```bash
npm run stack:tls
```

The dashboard and the API are served from the same hostname, split by path:
everything under `/api` goes to the API, everything else to the dashboard.
That is why `NEXT_PUBLIC_API_URL` is the panel's own URL rather than a separate
`api.` subdomain.

### Things that go wrong here

**`NEXT_PUBLIC_API_URL` is baked into the web image at build time.** Next.js
inlines `NEXT_PUBLIC_*` variables during the build, so changing it afterwards
does nothing until the image is rebuilt. `npm run stack:tls` passes `--build`,
but if you edit the value later, run it again rather than restarting.

**Signed out at random, or "Cannot reach the API".** Almost always
`CORS_ORIGINS` still naming `http://localhost:3000`, or `COOKIE_SECURE` left
`false` while the browser is on HTTPS. Both must name the https origin.

**Certificate never issues.** Caddy logs the reason:

```bash
npm run stack:logs -- caddy
```

The usual causes are the DNS record not having propagated yet, port 80 blocked
upstream, or another process already holding 80/443 on the host.

**Losing the certificate on every restart.** The `caddy-data` volume holds
them. Let's Encrypt rate-limits re-issuance, so do not prune it casually.
