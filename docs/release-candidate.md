# ServerForge release candidate report

**Status: awaiting platform qualification. This candidate is not approved for
production or public publication.** The application release checks pass. Native
AMD64 and ARM64 artifacts are built, scanned and checksummed; successful image
builds do not qualify a platform or its games.

## Candidate and evidence

The frozen application source is `d410b04e1b08b1574cd0ce90106f98eaafa9b4f1`, with
source digest
`863f59ad0bb2003af3669b6f4d4b5980f92d284ecbf901b925bd96605d06a27a`.
The private artifact directory is `data/candidates/0.1.0-rc.1-ui-d410b04`.
Each architecture bundle contains API, web, maintenance, PostgreSQL and Tailscale
images, immutable image IDs, source, the launcher, documentation, SBOMs, security
reports and verified `SHA256SUMS`. Nothing was pushed to an image registry.

Later validation-script and documentation changes do not change these runtime
images. Keep their supplemental evidence alongside the original bundle; do not
rewrite its source digest or claim it was built from a later commit.

[Application release checks, run 34888247137](https://github.com/m1hung/ServerForge/actions/runs/34888247137)
passed all 23 steps: build, type checking, lint, **611 unit tests**, **46 database
and Docker integration tests**, **nine browser workflows**, dependency audit and
all five image scans. There were no unexpected skipped checks. The validation follow-up on `82154d6`
also passed [all release checks, run 34893063784](https://github.com/m1hung/ServerForge/actions/runs/34893063784). Browser coverage
includes **96** light/dark, desktop/mobile/reflow accessibility combinations.

The latest UI work ran from 17:01 to 19:08 UTC on September 14, 2026 and ended at a
recoverable checkpoint. A separate database and qualification run began at 19:08
UTC, with a six-hour deadline of 01:08 UTC September 15. Its private evidence is
under `data/panel-checkpoints/20260914T190828Z-database-qualification`. The timed
soak and post-run resource/container verification completed successfully by 23:58 UTC.
The final documentation CI and handoff manifest are recorded in the candidate's
`qualification-supplement`, alongside the unchanged image bundles.

## User experience

- All pages use the shared title treatment, including the orange period, matching
  spacing, form controls and light/dark colors. Sidebar navigation and theme state
  persist between pages without a document reload.
- All ten server tools are visible and bookmarkable. Members see the tools their
  permissions allow. The compact desktop server overview fits its viewport;
  console and tables scroll internally, while narrow screens can scroll normally.
- Daily, weekly and hourly schedules use readable controls and the selected
  timezone. Custom cron remains available. Invitations offer view-only, operator
  and custom permissions, with understandable names for API scopes.
- Account security asks for identity verification beside the action. Authenticator
  setup includes a QR code, manual entry and confirmation; recovery codes and API
  secrets remain visible until acknowledged. Dialog focus and Escape behavior are
  checked in the browser.
- Backups show their eventual success or failure on the same page. Storage errors,
  interrupted jobs, stale telemetry and networking failures have visible recovery
  actions. Saved hardware limits remain distinct from the running allocation.
- A game-specific console command reference searches and inserts commands without
  executing them. Placeholders are selected for replacement. Read-only game
  consoles explain their limitations.

See the [dashboard guide](dashboard.md). Automated accessibility checks found no
WCAG AA violations or horizontal page overflow in the tested combinations;
independent screen-reader and complete manual accessibility reviews remain open.
Visual inspection of 15 captured workspace/server/mobile screens found no blocking
layout issue; this is not a substitute for independent usability testing.

## Release-check and reliability repairs

The failed clean-runner checks exposed fixtures that depended on a locally cached
image, unrestricted traversal of private test artifacts, incorrect ownership of
private installer configuration, and scanners unable to write their private
output. Fixtures now pull their own pinned image, CI collects an explicit report
allowlist, installer files retain the invoking host user's ownership, and scanners
write as that user. Required Docker checks fail when Docker is unavailable. Legacy
upgrade fixtures also remove their verified empty networks during cleanup, avoiding
address-pool exhaustion after repeated local runs.

Qualification also found a PostgreSQL collation mismatch after changing base
images. Backed-up upgrades now check space, record a recovery journal, rebuild
database indexes and update collation metadata before readiness. NULL legacy
metadata is handled after reindexing. Rollback rebuilds indexes when the journal
shows a potentially interrupted collation change. Drift never triggers a reset.

Host `stop` and `status` include background services. `start` resumes an existing
Tailscale sidecar and its retained state; it does not enable a new sidecar.
Upgrade/rollback selects matching service images while preserving Tailscale state.

A recovery-validator false failure was also corrected: Minecraft can reorder
scoreboard entries after a resumed save. Restored bytes are now compared with the
verified backup snapshot, not a later live save. Real-game scoreboard checks still
verify the recovered content. The failed report and its investigation are retained. The larger matrix recovery
validator also corrected a test-only assumption that the public server summary
contained its admin password; the API correctly withholds secrets. That report
retains the initial failure and links its successful authenticated follow-up.

## Verified local checks

These results use Linux Docker Desktop 29.7.2, Compose 5.5.1, x86-64, cgroup v2,
Arch Linux kernel 7.2.4 and Docker VM kernel 7.0.12-linuxkit. The Docker VM has
20 CPUs and approximately 7.5 GiB RAM. Unless stated otherwise, the following
reports use the frozen candidate image IDs.

| Check                                       | Result and evidence under `data/release-tests/`                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged installation and browser workflows | Passed: protected owner setup, invitations, permissions, TOTP/recovery codes, sessions, scoped keys, password changes, networking, schedules, modpack errors/retry, real Minecraft console/telemetry/configuration/backup/restore, mobile focus and theme persistence. `serverforge-packaged-h7QuUr/result.json`                                                 |
| Host upgrade and rollback                   | Passed: verified backup, stopped-installation upgrade, real collation mismatch/index rebuild, rollback, preserved accounts, existing/disabled Tailscale states, service-image rollback, killed upgrade, documented lock recovery and redacted diagnostics. Same packaged report.                                                                                 |
| Known legacy schemas                        | Both baseline and networking/authentication schema adoption and rollback passed on the final images in `host-upgrade-32IQh1/result.json`. Original accounts, world sentinels, secrets, ports and legacy restart behavior were preserved; fixture networks were cleaned up. Fresh and both legacy database migration paths also pass required integration checks. |
| Fresh-host full recovery                    | Passed: verified full bundle, remapped paths, retained passwords/encryption material, revoked sessions/keys/invitations, offline games and disabled external exposure. Real Minecraft 1.20.1 started and confirmed world value `14092026`. `world-restore-URTi3B/result.json`                                                                                    |
| Full matrix recovery                        | Passed across nine restored game variants: all 4,766 regular files (17.2 GB) matched the snapshot, both Valheim variants loaded their saved locations, Palworld confirmed its original world GUID, and all Minecraft families/the original pack started. `matrix-restore-OrlqD3/recovery-evidence.json`                                                          |
| Database and Docker access outages          | Passed: liveness stays available, readiness becomes 503, recovery reconnects the same healthy game without a duplicate. Only the isolated API loses Docker access; the shared daemon stays running. `world-restore-URTi3B/fault-result.json`                                                                                                                     |
| Real storage exhaustion                     | Passed: genuine ENOSPC in a disposable 128 MiB tmpfs backup volume, browser-visible failure, unchanged live world and previous backup files, successful retry and game-confirmed world content. The host disk and database volume are not filled. Same fault report.                                                                                             |
| Interrupted game operations                 | Passed: actual API kills during backup archive creation and after restore journal creation; partial archive cleanup, actionable failure, atomic-state world preservation and real game startup/content. `world-restore-URTi3B/operation-kill-result.json`                                                                                                        |
| Installation interruption                   | Earlier real NeoForge installer kill failed actionably, removed its orphan installer, retained its ZIP, cancelled a fresh retry and completed a third attempt with one game container. `launcher-check/config/qualification-results/installation-interruption-1789389868276/`                                                                                    |
| Accessibility and reflow                    | Passed all 96 combinations across seven workspace/server pages and nine additional server tools. `serverforge-packaged-h7QuUr/browser-output/accessibility.json`                                                                                                                                                                                                 |
| Four-hour mixed-operation soak              | Passed: 240.2 minutes, 23 completed configuration/backup/restore/restart cycles, 819 real telemetry samples and 480 host samples. Every restored world-content check passed. `soak-ui-ebcae7d/config/qualification-results/soak-2026-09-14T19-57-29.573Z-bdd582/result.json`                                                                                     |
| Browser continuity during the soak          | Passed: 213 navigation/theme checks over a separate 212.2-minute observation, with zero document reloads or JavaScript errors. Browser heap ranged from 5.4 to 7.8 MiB. `browser-soak-result.json` in the private checkpoint and handoff supplement.                                                                                                             |

The soak ran from **19:57:29 to 23:57:39 UTC September 14**. The API, web,
database and backup worker kept their original container IDs, image IDs and start
times, with **zero restarts or OOM kills**. Post-run readiness passed, active
operations were empty, and the game was offline without a duplicate running
container. The isolated panel was then stopped; its evidence and data were retained.

After excluding the first 15 minutes, average API process RSS was **235.4 MiB**
in the first quarter and **227.3 MiB** in the last quarter. API, web and database
container memory stayed within the declared growth thresholds. Browser observation
began at 20:25:34 UTC and ended at 23:57:47 UTC, so it is not presented as a
four-hour browser test. The handoff includes the underlying samples, the separate
`soak-review.json`, and resource charts showing sampling gaps during operations.
A finite soak does not establish that memory can never grow under other workloads.

These crash drills cover specific observed interruption points, not every possible
instruction boundary. Earlier short, interrupted or failed soaks are preserved and
do not count toward the four-hour gate. Earlier reports are superseded only for
checks actually repeated.

## Game evidence

Final-image matrix:
`launcher-check/config/qualification-results/2026-09-14T20-00-46.532Z-4876e3/result.json`.
All nine selected cases passed. Reused installations are identified in that report;
the CurseForge case performs a fresh upload and installation of the original ZIP.

| Game/variant                  | Tested version and result                                                                                                | Remaining limitation                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Minecraft vanilla             | 1.20.1: fresh install, console, telemetry, game backup, full-host world recovery and four-hour mixed-operation soak      | No external client join; other platforms need their own soak                                     |
| Paper / Purpur                | Minecraft 1.20.1, builds 196 / 2062: startup, console, telemetry and stop                                                | Snapshot restore/startup also passed; other versions/platforms untested                          |
| Fabric                        | Minecraft 1.20.1, Loader 0.19.5: startup, console, telemetry and stop                                                    | Snapshot restore/startup also passed; other mods/versions/platforms untested                     |
| Forge                         | Minecraft 1.20.1 / 47.4.10: startup, console, telemetry and stop                                                         | Snapshot restore/startup also passed; other versions/platforms untested                          |
| NeoForge                      | Minecraft 1.21.1 / 21.1.250: startup, console, telemetry and stop                                                        | Snapshot restore/startup also passed; other versions/platforms untested                          |
| CurseForge Just Simply Create | Server pack 1.0.1, Minecraft 1.21.1 / NeoForge 21.1.133: original ZIP installation, startup, console, telemetry and stop | Representative pack only; no mods removed; a mod update-check warning does not prevent readiness |
| Valheim                       | l-1.0.12, network version 40: vanilla and BepInExPack 5.4.2350 startup, telemetry and clean stop                         | Client joins and actual mod effects remain untested                                              |
| Palworld                      | v1.0.4.102642: authenticated save/shutdown, clean exit, snapshot restore and original world GUID confirmation            | No player join; a real compatible Linux PAK remains `mod-test-required`                          |

The pack is [Just Simply Create Server Pack 1.0.1](https://www.curseforge.com/minecraft/modpacks/just-simply-create/files/6311372),
SHA-256 `235dfb3386633c764891099b2a1cc76f24e16ac9320e6c995dc0a62e6019b445`.
Game and loader versions were recorded from installation metadata and runtime logs.

The exact Java 17, Java 21 and SteamCMD game images used by this matrix were scanned:
**zero high/critical findings** in all three. Application/service images contain
reviewed, expiring exceptions; **zero unreviewed high/critical findings** is not a
claim that every underlying package is patched. See [image security review](image-security-review.md).
All runtime scan exceptions must be reassessed before their 2026-10-14 expiry.

## Current installation and recovery

Private checkpoints preserve the original source, database/schema, configuration,
images and game directories before changes. Destructive tests use their own Compose
projects, databases, secrets, ports, ownership labels and directories. Never commit
or share checkpoints, raw backups, credential files or qualification cookies.

The local installation was upgraded to the frozen candidate after verified panel
backup `panel-20260914T195820121Z-5f271c0b`. Verification found zero differences in
existing account/server identifiers, permissions, settings, allocations, paths or
network preferences; all **1,851** original game files matched. Both existing games
remain offline. The working portful Tailscale dashboard URL was preserved. Existing
Redis and unrelated host/router networking were retained.

Recovery uses the host commands in [operations](operations.md). The upgrade journal
records the matching backup, previous/selected images, schema and collation work.
Use the documented rollback; do not substitute an arbitrary old image across an
incompatible schema or attempt a destructive schema downgrade. A local backup alone
does not protect against losing the host: keep a verified off-host copy.

## Remaining acceptance gates

| Gate                                               | Status                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Required application CI and candidate image review | Passed for frozen application and validation follow-up `82154d6`                                                       |
| Four-hour unchanged-image soak on Linux Desktop    | Passed: 240.2 minutes and 23 recovery cycles, with post-run resource/container verification                            |
| Linux Engine qualification                         | CI runs required Docker checks; full platform/network/recovery/soak qualification still needs its own evidence         |
| Windows/WSL2, Intel Mac and Apple Silicon          | No real machine reports supplied; not qualified. Native ARM panel builds do not prove game compatibility.              |
| Real client connections                            | LAN, public and tailnet game joins, ACL denial/expiry, router variation and applicable HTTPS Serve verification remain |
| Mod qualification                                  | Actual Palworld Linux PAK effect and broader client/mod combinations remain                                            |
| Independent usability and security review          | Tester-led installation/recovery, screen-reader/manual accessibility and final application security review remain      |
| Broader fault coverage                             | Additional interruption points and other host/cgroup/storage combinations remain                                       |

Use the [qualification bundle instructions](qualification.md) to gather the missing
results. Unknown or failed platforms must remain unqualified or explicitly
experimental. Public publication remains a separate step.
