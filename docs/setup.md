# Install ServerForge

The image-based release is a candidate awaiting platform qualification. Read
[the release report](release-candidate.md) before using it for important worlds.
Candidate archives are delivered privately; nothing in this workflow publishes
images or changes an existing installation automatically.

## Requirements

- Docker Engine 24+ or Docker Desktop, running Linux containers, and Compose 2.24+.
- Linux x86-64/ARM64, macOS, or Windows through WSL2. Use the matching native panel
  images. Platform support is qualified only when real test evidence is recorded.
- At least 2 GiB available to Docker for the panel, plus game allocations and host
  headroom. The installer also checks writable storage and free space.
- Internet access for game runtime images and game/loader downloads. The
  candidate archive includes the database and optional Tailscale service images. No host Node.js or source checkout is needed.
- On Windows, run the launcher inside a WSL2 Linux distribution and store the
  installation under its Linux filesystem, such as `~/serverforge`, not `/mnt/c`.
- On macOS, share the installation directory with Docker Desktop. Apple Silicon
  panel images are native; individual games have separate compatibility states.

Docker socket access grants control of the host. Use a dedicated host or VM and
limit workspace administrator access. See [security](security.md).

## Fresh installation

Unpack the archive for your architecture. Verify its checksums before loading:

```bash
sha256sum -c SHA256SUMS
# macOS alternative: shasum -a 256 -c SHA256SUMS
docker load -i serverforge-images.tar
chmod +x serverforge
mkdir -p "$HOME/serverforge"
export SERVERFORGE_HOME="$HOME/serverforge"
./serverforge setup
```

The archive contains matching versioned API, web, maintenance, PostgreSQL and
Tailscale images. The launcher requires all five to match the release and Docker architecture. Setup
creates fresh database credentials, signing/encryption secrets, a unique Compose
project and separate game/backup directories. It starts PostgreSQL, deploys the
committed migrations, seeds the local node, and waits for application readiness.
Choose another dashboard port with `./serverforge setup --port 3030`.

Open the loopback URL printed by setup. Enter the **one-time owner setup token**
printed by the installer, choose the first owner's username and password, and
create the account. Only the token hash is saved. If it is lost before setup is
completed, run `./serverforge setup-token` to replace it while no accounts exist; do not expose an
unclaimed setup page to a network. New installations are invitation-only.

Keep `SERVERFORGE_HOME` set whenever operating this installation, or run the
launcher from that directory. Configuration is in `config/.env`; data is under
`data/`. Keep this directory private and preserve the encryption key.

```bash
./serverforge status
./serverforge diagnostics
./serverforge stop
./serverforge start
```

Stopping the panel leaves game containers running. Stop games through the
dashboard first when preparing to shut down Docker or the computer. A panel
restart reconnects to its owned game containers.

## Enable access after owner setup

The dashboard initially binds only to `127.0.0.1`. The browser uses its own origin
for API calls; the database and API require no published host ports.

```bash
./serverforge access lan --bind 192.168.1.20
./serverforge network --lan-address 192.168.1.20
```

Use the actual address assigned to your host. `access lan` without `--bind`
listens on all IPv4 interfaces. Check the firewall from the intended client.
The launcher never rewrites firewall rules on unrelated Docker bridges.

For host Tailscale, keep the hostname **and dashboard port** that already work.
Run `./serverforge network` to read the host's status. Inspect existing Serve
handlers before adding HTTPS; never reset or replace unrelated handlers. Once
HTTPS is verified, `./serverforge access https` enables Secure cookies and
loopback binding for the trusted proxy. HTTP sign-in then stops working.

Alternatively, `./serverforge access sidecar` starts a separate dashboard-only
Tailscale device. Sign in through **Network & access**, enable its HTTPS handler,
and switch account sessions to HTTPS with `./serverforge access https`.
The sidecar carries dashboard traffic, not game traffic. See [networking](networking.md).

UPnP stays disabled until an owner enables it globally and for an individual
server. It maps game ports only. A successful router mapping does not prove
internet reachability through carrier-grade NAT or an upstream firewall.

## Existing source installation

Preserve a database dump, configuration, game directories, and the current
checkout before adopting it. Load the candidate images. From the original
installation directory, with `SERVERFORGE_HOME` pointing there:

```bash
./serverforge adopt --project serverforge
./serverforge upgrade 0.1.0-rc.2
```

Replace the project name with the existing Compose project. Adoption verifies
that the selected containers use that installation's game paths and PostgreSQL
volume. It records paths, secrets, ports, image IDs, and configuration without
restarting services. Upgrade then stops panel mutations, makes a verified panel
backup, recognizes one of the two supported legacy schemas, records its baseline,
and applies committed migrations. Unknown schema drift is reported and refused.
No command resets an unknown database automatically.

The source convenience command `npm start` builds local images and uses this
maintenance workflow. It is for developers with a checkout; end users can use
only the supplied images and launcher.

## Upgrade and recovery

Read [operations](operations.md) for verified backups, rollback, fresh-host
restore, password/second-factor recovery, and interrupted-operation handling.
A local backup alone does not protect against losing the host.

## Runtime configuration and branding

Edit `config/.env`, then restart the affected panel services with `serverforge
stop` and `serverforge start`. This does not stop games. Preserve credentials
and existing host paths; do not regenerate them during upgrades.

| Setting | Purpose |
| --- | --- |
| `WEB_PORT`, `BIND_HOST` | Dashboard port and listening address |
| `DASHBOARD_SCHEME`, `COOKIE_SECURE` | Trusted deployment scheme and Secure cookies |
| `BRAND_NAME`, `BRAND_TAGLINE`, `BRAND_ACCENT` | Browser branding, read at runtime |
| `BRAND_RESOURCE_PREFIX` | Installation ownership namespace; preserve once installed |
| `HOST_DATA_ROOT`, `HOST_BACKUP_ROOT`, `HOST_RECOVERY_ROOT` | Absolute host data locations |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | Required secret material; never share in diagnostics |
| `API_IMAGE`, `WEB_IMAGE`, `MAINTENANCE_IMAGE`, `POSTGRES_IMAGE`, `TAILSCALE_IMAGE` | Installed image IDs, managed by upgrades |

Game manifests remain supported. Invalid manifests are reported; executable
game code and mods must come from sources you trust. The sidebar controls light
and dark mode. Legacy custom theme directories are preserved in recovery bundles.

## Development

Use Node 22.12+ and the locked npm dependencies. The API file-access protections
require Linux (`/proc`); on Windows use WSL2, and on macOS run the API in its Linux
container. The browser development server can run natively.

```bash
npm ci
npm run bootstrap
npm run stack:up
npm run db:migrate
npm run db:seed
npm run dev
```

`prisma db push` is available only for disposable development databases.
Production uses the committed migration/adoption tool. Required release checks
are `npm run typecheck`, `npm run lint`, `npm run test:unit`,
`npm run test:integration`, and `npm run test:packaged`. Docker tests require
Docker and create their own isolated project; they fail if it is unavailable.
