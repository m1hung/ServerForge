# Tester qualification bundle

This bundle is a candidate, not a qualified production release. It contains native
panel images, source, SBOMs, exact image identifiers, reviewed image findings,
checksums, a launcher and installation/recovery instructions. Do not test destructive
operations against an existing installation.

## Start an isolated installation

On Linux/macOS use a terminal; on Windows use WSL2 with files under the Linux home
directory. Choose the bundle matching Docker's architecture. Docker Engine and
Docker Desktop are separate qualification rows.

```bash
sha256sum -c SHA256SUMS
# macOS: shasum -a 256 -c SHA256SUMS
docker load -i serverforge-images.tar
export SERVERFORGE_HOME="$HOME/serverforge-qualification"
./serverforge setup --qualification --port 3030
```

Use an empty directory. `--qualification` creates a private fixture marker and
test-only owner credentials. The qualification commands refuse installations
without this marker. Do not reuse its owner account for a real installation.
Keep `config/qualification.json` private: it contains credentials and is not
part of a diagnostic submission.

## Game checks

```bash
./serverforge qualify --cases vanilla,paper,purpur,fabric,forge,neoforge --minutes 150
./serverforge qualify --cases valheim,valheim-bepinex,palworld,palworld-pak --minutes 150
```

For Apple Silicon, native Java/loaders and x86-64 emulation are independent tests.
Experimental combinations require explicit `--allow-experimental`. A successful
native dashboard build does not establish game compatibility. Failed or untested
combinations stay experimental or blocked.

The qualifier creates its own servers, records exact versions, installation
logs, console output and resource measurements, then stops them. It retains files
for inspection and reduces stopped fixtures' saved RAM reservation to 128 MiB.
`--reuse` rechecks existing qualifier-created installations after a fix; its report
identifies that reuse and does not count it as another fresh installation test.

For CurseForge, place a genuine, legally obtained **server pack ZIP** at
`$SERVERFORGE_HOME/config/qualification-pack.zip` and record its publisher URL.
Do not use a client/profile export. Then run:

```bash
./serverforge qualify --cases curseforge-zip --minutes 60
```

Its checksum is recorded. A client-only mod in a server pack can prevent startup;
retain the error and verify the publisher's server requirements. Do not silently
remove mods and report the original pack as passing.

Palworld PAK directory readiness is not proof of a real mod's compatibility.
Test a compatible Linux PAK, record its publisher/version/checksum and verify its
actual in-game effect. Without this result, the `palworld-pak` row remains
`mod-test-required` even when the server starts.

## Four-hour mixed-operation soak

Choose the UID of the vanilla Minecraft fixture printed in its game result:

```bash
./serverforge soak --server FIXTURE_UID --minutes 240
```

This performs configuration changes, console commands, consistent game backups,
restores and restarts, and checks a persistent world sentinel after each restore.
It samples real game telemetry and API memory, and separately records Docker
resource measurements for the API, web and database. Each run is bounded to
330 minutes, with cleanup and result files on failure/interruption.

The gate requires at least 240 minutes, eight complete operation cycles, 100
post-warmup samples and no operation failure. API RSS growth between the first
and last post-warmup quarters must stay below the larger of 128 MiB or 50% of the
initial quarter. Inspect the host samples for web/database growth, restarts and
resource pressure as well. Short runs are labelled `incomplete-duration` and
exit unsuccessfully for release-gate purposes; they are useful smoke tests only.

Do not change the candidate images during a qualifying soak. Record the image
identifiers used. A changed implementation needs a new qualification run.

## Required interactive and host checks

Record pass/fail, exact OS/Docker/architecture/game versions and relevant redacted
errors for each check. A missing result is **not tested**, never passed.

| Check | Evidence to record |
| --- | --- |
| Fresh installation | Owner token, first sign-in and ready health; no undocumented intervention |
| Accounts | Invite acceptance/replay refusal, TOTP/recovery, session/key revocation, permission denial |
| Browser | Creation, modpack upload, config edit, console, live telemetry, backups/restores, dark mode |
| Accessibility | Keyboard focus, dialogs/Escape, contrast, mobile, 200% zoom and scrolling |
| Local game access | Real game client joins the expected world from another LAN device |
| Tailnet access | Dashboard URL including its port, Serve HTTPS where configured, ACL/auth failure handling |
| Public access | Explicit UPnP opt-in, conflict refusal and real external-client join where available |
| Upgrade/rollback | Existing identifiers/settings/worlds preserved; failure/drift refusal and documented rollback |
| Host restart | Panel reconnects to existing game containers, no duplicate game processes |
| Full recovery | Fresh target, revoked sessions/keys, offline inspection, real-world startup/content confirmation |
| Failure handling | Docker/database outage, full disk, occupied port, browser disconnect and interrupted operation |
| Four-hour soak | Result and host resource samples, with no stuck jobs, lost worlds or unbounded growth |

Use [setup](setup.md), [operations](operations.md) and [networking](networking.md).
Do not disable protections or alter host firewall rules just to make a test pass.
Document any host permission or file-sharing steps required by Docker Desktop.

## Submit evidence

Results are under `config/qualification-results/`; host samples are
`config/soak-host-*.jsonl`. `serverforge diagnostics` produces a separate redacted
host report. Submit those reports and relevant redacted logs, plus your completed
check table. Do not submit `.env`, setup/owner credentials, session cookies,
TOTP/recovery codes, raw backup bundles or the qualification credential marker.

The release maintainer combines automated, browser, game, recovery and soak
results. Linux Engine, Linux Desktop, Windows/WSL2, Intel Mac and Apple Silicon
Mac require actual results. Missing platform results leave the candidate
**awaiting platform qualification**.

## Maintainer regression tools

`npm run test:packaged` creates a fresh disposable installation and runs four
required browser workflows, including axe-core WCAG AA checks across light/dark
mode and three viewport sizes. It also kills its own host upgrade command after
migrations and verifies documented lock recovery and rollback. Docker/database
checks remain mandatory; unavailable infrastructure does not produce a pass.

For source adoption and schema-incompatible rollback, a maintainer with a source
checkout can select retained legacy API/web **image IDs** and run
`scripts/host-upgrade-drill.mjs` using `SF_LEGACY_API_IMAGE`,
`SF_LEGACY_WEB_IMAGE`, `SF_MAINTENANCE_TEST_IMAGE` and `DOCKER_SOCKET`. It creates
both supported legacy database schemas in new fixture projects. Old background
workers are disabled so old network-management code cannot alter host networking.
It verifies schema, account identifiers, filesystem sentinels, runtime settings,
ports and restart behavior. Its filesystem sentinel does not replace the separate
real-world recovery drill. No existing installation is automatically discovered.

`scripts/real-world-drill.mjs` creates and restores a real Minecraft world into a
fresh fixture. After that drill, `scripts/operation-drill.mjs` can exercise actual
API termination during archive creation and atomic restore. Set `SF_GAME_TEST_HOME`
to that isolated restored installation under `data/release-tests/`,
`SF_GAME_TEST_UID` to its offline vanilla server, and `DOCKER_SOCKET` to the local
Docker socket. The fixture's private `test-cookie` is required. This deliberately
changes the fixture's scoreboard and kills only its labeled API process; it must
never be pointed at an ordinary installation. Its report records the image ID,
observed journal state and recovered world checksums. Preserve each report before
repeating a drill.
