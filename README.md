# ServerForge

A self-hosted dashboard for installing, configuring, monitoring, modding and
recovering game servers on one Docker host.

**Production release candidate work is in progress.** The implementation and
local evidence are tracked in [the release report](docs/release-candidate.md).
Windows/macOS qualification and required soak evidence cannot be inferred from
Linux tests. Candidate images are local/private; public publication is separate.

## Games and operations

| Game           | Implemented editions                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Minecraft Java | Vanilla, Paper, Purpur, Fabric, Forge, NeoForge, Modrinth packs, uploaded CurseForge server-pack ZIPs |
| Valheim        | Dedicated server and BepInEx                                                                          |
| Palworld       | Dedicated server and compatible Linux PAK mods                                                        |

Edition availability is distinct from platform qualification. The deployment
wizard reports supported, experimental or unsupported runtime combinations.
See [mod compatibility](docs/modded-servers.md) and the exact test evidence in
the release report before relying on a game/loader/platform combination.

See [using the dashboard](docs/dashboard.md) for everyday game management,
sharing, account security, schedules, and recovery.

- Compact server pages, dark mode, live console and resource monitoring.
- Saved and applied hardware limits, storage budgets and capability reporting.
- Configuration, files, mods, access roles, schedules, crash recovery and staged updates.
- Durable installation progress, safe cancellation/retry and retained failed uploads.
- Local/public/tailnet game addresses, opt-in UPnP and private Tailscale dashboard access.
- Invitation-only accounts, passwords, TOTP, sessions, scoped API keys and audit events.
- Game backups, automatic panel backups, full recovery bundles and host recovery commands.
- Versioned migrations, image-based installation and backed-up upgrade/rollback.

## Install the candidate

Use Docker Engine 24+ or Docker Desktop with Linux containers and Compose 2.24+.
Windows uses WSL2 Linux filesystem storage. Host Node.js and a source checkout
are unnecessary for the packaged installation.

From the candidate archive for your architecture:

```bash
sha256sum -c SHA256SUMS
docker load -i serverforge-images.tar
chmod +x serverforge
export SERVERFORGE_HOME="$HOME/serverforge"
./serverforge setup
```

Open the printed loopback URL and enter the installer's one-time owner setup
token. Setup preserves existing installations by refusing to overwrite their
configuration. See [setup](docs/setup.md) for alternate ports, source adoption,
macOS checksum verification and network access.

```bash
./serverforge status
./serverforge backup
./serverforge backup --full
./serverforge diagnostics
```

Keep verified recovery bundles off-host. Read [operations](docs/operations.md)
before upgrades or recovery. The Docker socket is a host administration boundary;
see [security](docs/security.md).

## Development and release checks

Use Node 22.12+ and `npm ci`. See [development setup](docs/setup.md#development).

```bash
npm run build
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:packaged
node scripts/scan-images.mjs
```

Integration checks create a separate Compose project with their own database,
ports, directories and secrets. Required Docker tests fail when Docker is
unavailable. Unit, integration and packaged browser checks reject unexpected
skips. The release checks do not use existing servers as destructive fixtures.

Image builds and scanner inputs are pinned; reviewed findings have exact
package/version bounds and expiry in `release/security-exceptions.json`.
A clean dependency audit is not a substitute for image scans or platform tests.

## Extend and customize

Installation branding is read at runtime from `BRAND_NAME`, `BRAND_TAGLINE` and
`BRAND_ACCENT`; custom image builds are unnecessary. Preserve the installation's
resource prefix and host paths when upgrading.

Game manifests use `data/games/`. Switch between light and dark mode in the sidebar.
See [adding a game](docs/adding-a-game.md), [management](docs/management.md),
and [networking](docs/networking.md).

## Licence

AGPL-3.0-or-later. See [LICENSE](LICENSE).
