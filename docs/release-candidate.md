# ServerForge 0.1.0-rc.1 implementation checkpoint

**Status: awaiting platform qualification. Not approved for production or public
publication.** The current live installation has not been upgraded by this work.

Implementation began on 2026-09-14 at 09:02 UTC. This first run is capped at six
hours and must checkpoint by 15:02 UTC. Implementation, artifact creation and
qualification are separate results. The final checkpoint evidence is retained
under `data/release-tests/` and candidate artifact manifests under `data/candidates/`.

## Installation protection

A private recovery checkpoint was created before editing at
`data/panel-checkpoints/20260914T090219Z-before-rc`. It contains a Git bundle,
working source and patch, configuration, PostgreSQL dump and schema, container
inventory, and both existing stopped game servers' files. The dump was checked
with `pg_restore --list`; artifacts have SHA-256 checksums. Directories are private
and files restrictive. This checkpoint contains secrets and must never be shared
with ordinary diagnostics or committed to Git.

All destructive checks use separate Compose projects, databases, credentials,
ports, container ownership labels and game directories under `data/release-tests`.
No live world, router mapping or host Tailscale handler was used as a fixture.

## Implementation status

| Work package | Delivered implementation and evidence | Remaining acceptance work |
| --- | --- | --- |
| Baseline and release checks | Private recovery checkpoint; isolated fixtures; CI build/lint/type/unit/database/Docker/browser/image checks; unexpected skips fail | Remote CI execution |
| Dependencies and images | Development dependency updates; minimal API/web/maintenance images; patched versioned PostgreSQL/Tailscale targets; native architecture builds, image IDs, checksums, SBOMs and scans in artifact tool | Selected artifacts include scans and reviewed exceptions; platform execution must match their image digests |
| Container protection | Non-root games/installers, dropped capabilities, no-new-privileges, PID 2048, log rotation 20 MiB × 3, bounded ownership helper | Repeat enforcement on other Docker hosts |
| Resource reporting | CPU/memory/swap enforcement, capability detection, I/O limitations, saved/applied allocations, aggregate RAM headroom, storage budgets/free-space checks | Other cgroup/host combinations and disk-failure stress |
| Lifecycle | Graceful panel shutdown, truthful live/ready checks, mutation draining, ownership reconciliation, interrupted cron attention | Broader termination timing matrix |
| Installation | Durable attempts, progress, fresh retry staging, safe cancellation, retained failed ZIPs, interrupted-installer cleanup | More interruption points around atomic finalization |
| Migrations | Committed baseline/network-auth/RC migrations; known catalog adoption; unknown drift refusal; fresh and both legacy schemas tested | Other host platforms and legacy background-worker/game concurrency |
| Upgrade and panel backups | Daily seven-backup retention, image-based maintenance launcher, verified pre-upgrade backup, upgrade journal and explicit compatible/image or database rollback | Additional termination points and other platform qualification |
| Full recovery | Versioned/checksummed complete bundles; maintenance stop/resume; restrictive permissions; fresh-target restore, path remap, session/key revocation, offline games and disabled external exposure | Repeat fresh-host real-game recovery against final artifacts on qualified platforms |
| Accounts | One-time owner token; invitation-only, hashed single-use 72-hour invitations; role ceilings, server grants, suspension and last-owner protection | Additional browser and security review |
| Account security | Password changes, TOTP confirmation/replay protection/recovery codes, session revocation, scoped expiring API keys, secret-free audits | Final application security review and broader adversarial coverage |
| Installer | Thin Docker-only launcher; native image/version checks, private setup, preflight, runtime branding, diagnostics and recovery commands | Independent tester follows installation/recovery docs |
| Networking | Portful host Tailscale URL preserved; verified HTTPS reporting; dashboard/game distinction; opt-in owned UPnP mappings; focused diagnostics | Real external/LAN/tailnet clients, ACL denial/expiry and router variation |
| Operational UI | Account/workspace/system pages, failed jobs/backups/capabilities, progress/retry/cancel, applied limits, explicit stale telemetry, compact desktop and responsive dark mode | Automated 42-case WCAG AA scan passed; manual screen-reader, keyboard and browser-zoom audit remains |
| Game qualification | Real Minecraft families, original CurseForge ZIP, Valheim/BepInEx and Palworld lifecycle checks; tester and soak commands | Real Linux PAK mod, external joins, complete exact-version matrix |
| Platform/candidate acceptance | Local Linux Docker Desktop evidence and machine-readable tester tools | Linux Engine, Windows/WSL2, Intel Mac, Apple Silicon and four-hour final-code soaks |

## Verified local results at artifact preparation

- Unit checks: 626 passed across 47 files in the latest complete unit run.
- Database/Docker integration: 44 passed across six files, no skips. Latest
  report: `data/release-tests/serverforge-test-681a6722f3a1-fzfw91/result.json`.
- Packaged browser/host workflow passed setup, owner token, invitation, account,
  networking, dark mode, mobile focus, actual Minecraft creation and commands,
  real telemetry, saved versus applied CPU, consistent backup/world restore,
  panel/full backup, verification, upgrade, declared rollback and diagnostics.
  Report: `data/release-tests/serverforge-packaged-5mlg7h/result.json`.
- Full fresh-host recovery started real Minecraft 1.20.1 and read the restored
  scoreboard value `14092026`; database, configuration, encryption key and world
  checksum were checked. Restored sessions were rejected and games initially
  remained offline. Report: `data/release-tests/world-restore-Tty9lm/result.json`.
- A real API process kill during NeoForge installation produced an actionable
  failed attempt, cleaned its orphan installer, preserved the uploaded ZIP,
  allowed cancellation of a fresh retry, and completed a third attempt. Exactly
  one game container then started. Report under
  `launcher-check/config/qualification-results/installation-interruption-1789389868276`.
- Source adoption, upgrade from both known legacy schemas, incompatible-schema
  rollback, preservation of original API ports/environment, and restart without
  implicit re-migration passed. Legacy background workers were disabled to isolate
  this drill from their old host-network behavior. World files here are sentinels;
  real-game recovery is tested separately. Report:
  `data/release-tests/host-upgrade-x7uLb4/result.json`.
- The packaged host command was killed after its migration checkpoint. The
  documented stale-lock recovery and rollback returned the API to readiness with
  the previous images. Report: `serverforge-packaged-5mlg7h/result.json`.
- Browser accessibility checks now cover seven pages in light/dark mode at
  desktop, mobile and a 200%-equivalent CSS viewport. Shared light-mode text,
  status labels and brand button contrast were corrected. Final packaged results
  are authoritative; automated scans do not replace manual accessibility checks.
  Manual review also corrected the light-mode step numbers to 5.45:1 contrast.
  Final image tests must include this correction.
- Schema drift checks reject extra views, sequences, standalone composite types,
  domains and public extensions. The catalog fixtures include the application’s
  existing identity sequences; fresh installation and both legacy states passed
  after extending the checks.
- Dependency audit found zero reported vulnerabilities. Runtime findings are
  separately reviewed in [image security review](image-security-review.md).
  Reviewed exceptions are not claims that the underlying packages are patched.
- The first mixed-operation smoke completed three backup/restore cycles and 33
  minutes, then failed at backup pruning because the tester sent a bodyless DELETE
  with a JSON content type. The tester request was corrected; its failed report
  remains intact. A bounded repeat is recorded in the final checkpoint. Neither
  short run can satisfy the four-hour soak gate.
- Real API termination during backup archive creation and after restore journal
  creation passed on the candidate amd64 API. The incomplete archive was removed,
  failed work became actionable, and journal recovery preserved the correct world.
  Minecraft restarted and confirmed the recovered scoreboard. Report:
  `data/release-tests/world-restore-Tty9lm/operation-kill-result.json`.
  The repeatable source drill is `scripts/operation-drill.mjs` and accepts only an
  explicitly selected installation under `data/release-tests/`.

All paths above are relative to the repository's private `data/release-tests`
directory where abbreviated. Later checkpoint results supersede earlier runs
only for the checks they actually repeat. Some earlier game reports include
failures found and fixed during implementation; their raw reports remain intact.

## Game evidence and limitations

On Linux Docker Desktop 29.7.2, x86-64, cgroup v2:

| Game/variant | Real local evidence | Qualification limitation |
| --- | --- | --- |
| Minecraft vanilla 1.20.1 | Installation, startup, console, telemetry, game and full-host world recovery | No external game client or four-hour final-artifact soak |
| Paper 196 / Purpur 2062 / Fabric Loader 0.19.5 (Minecraft 1.20.1) | Installation, startup, console, telemetry and stop; versions read from runtime logs | Repeat on final artifacts and other hosts |
| Forge 1.20.1 / 47.4.10 | Installation, startup, console, telemetry and stop | Other versions and hosts untested |
| NeoForge 1.21.1 / 21.1.250 | Installation, startup, console, telemetry and stop | Other versions and hosts untested |
| CurseForge Just Simply Create 1.0.1 | Original server ZIP, Minecraft 1.21.1 / NeoForge 21.1.133, successful installation/start and crash/retry drill | Representative pack only; no mods silently removed |
| Valheim l-1.0.12 | Vanilla and BepInEx 5.4.23.5 startup, telemetry and clean stop | Client/mod-effect and recovery qualification pending |
| Palworld v1.0.4.102642 | Authenticated REST save/shutdown, exit 0, actual Level.sav flush/checksum | No player join; real Linux PAK mod still `mod-test-required` |

The CurseForge pack publisher is [Just Simply Create Server Pack 1.0.1](https://www.curseforge.com/minecraft/modpacks/just-simply-create/files/6311372).
Its SHA-256 is `235dfb3386633c764891099b2a1cc76f24e16ac9320e6c995dc0a62e6019b445`.
Game reports are under `launcher-check/config/qualification-results/`.

An earlier Palworld stop test exposed a signal-only shutdown that did not flush
world data. The corrected adapter performs authenticated save and shutdown and
requires clean exit before a consistent backup. The successful corrected report
is `2026-09-14T12-36-12.316Z-18f12d/result.json`. Earlier startup-only results do
not establish world persistence.

## Acceptance blockers and next bounded run

The candidate remains unqualified until all of the following have real evidence:

1. Final candidate images pass required checks and image review with current,
   unexpired findings; remote CI is green without unexpected skips.
2. Remaining interruption/failure cases pass, including more host upgrade/restore timing points,
   full disks, and more atomic-replacement timing points. Unknown schema and
   bundle formats must continue to fail before destructive work.
3. A final application security review has no unresolved critical/high finding.
   Existing focused tests are useful coverage, not a complete audit.
4. A real compatible Palworld Linux PAK is verified in-game; real clients verify
   LAN/public/tailnet game access where those features are claimed.
5. Linux Engine, Linux Desktop, Windows/WSL2, Intel Mac and Apple Silicon have
   real installation/lifecycle/network/recovery reports. Apple Silicon game
   compatibility is not inferred from successful ARM image builds.
6. Each qualified platform completes at least four hours of mixed operations on
   unchanged candidate images with no stuck work, duplicate containers, lost
   worlds or unbounded panel growth.
7. An independent tester follows the installation, upgrade and recovery docs
   without undocumented intervention; the complete accessibility audit passes.

See [qualification instructions](qualification.md). The next run should consume
the final checkpoint record, preserve the live installation, use isolated
fixtures, and finish missing qualification before any production upgrade or
public publication. A local backup alone does not protect against host loss.
