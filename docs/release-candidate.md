# ServerForge release candidate report

**RC2 status: assembly and validation in progress; awaiting platform qualification.**
Version `0.1.0-rc.2` includes Bedrock and the current dashboard. The schema and
rollback compatibility declarations are unchanged. The current installation is
not replaced during assembly. Private bundle manifests identify the committed
source revision, source digest and exact image IDs; their validation receipts
must be checked before calling a bundle ready for external testing.

The preceding main check passed application/packaged checks but failed five
PostgreSQL image findings. Their review and the fixed file-state race are in
[the RC2 security review](security-review-rc2.md). Qualification export and
[platform/independent handoffs](platform-handoffs.md) are included. Green CI,
both-architecture scans, current recovery and a new four-hour unchanged-image
soak remain mandatory RC2 acceptance gates. External platform/independent results
and real-client/mod effects must be recorded separately. Historical RC1 evidence
below does not qualify RC2.

## Color picker simplification — 2026-09-16 UTC

`serverforge-web:color-picker-rc1-20260916` removes the accent preset buttons and
keeps the native color picker, hex input and a **Use workspace default** reset.
Existing saved accents and other preferences are preserved. Unused preset data
and CSS have been removed, and the dashboard guide reflects the simpler controls.
Build, lint, web/test type checks, **630 unit tests**, and both focused theme workflows
in Chromium and Firefox pass without skips or retries. Browser checks cover light/dark
contrast, keyboard reset, invalid input, tab synchronization, persistence, blocked
storage, pre-hydration appearance and 320-pixel layout. This UI-only change uses
focused checks; the full game/recovery evidence remains in the vibrancy checkpoint.
The scan retains 47 reviewed high/critical findings with zero unreviewed findings.
Installed after verified backup `panel-20260916T073857679Z-cc5a1a10`; readiness,
unchanged server records and the existing Tailscale address pass.
Evidence: `data/panel-checkpoints/20260916-color-picker/`. Image digest:
`sha256:92ef222d320202532ddc40868ca6bab35ee665e47c3b25029bbe9210dc8a1874`.

## Preset alignment correction — 2026-09-16 UTC

`serverforge-web:themes-layout-rc1-20260916` gives the accent presets equal grid
cells and reserves a fixed column for the selection checkmark. Labels, swatches
and checkmarks remain within the button borders as the grid wraps on smaller screens.
Build, lint, web/test type checks and both focused theme workflows pass in Chromium
and Firefox, including every selection at 320, 390, 768, 1024 and 1440 pixels.
This validation covers the preset layout and existing theme behavior; the preceding
full game/recovery release evidence is recorded in the vibrancy checkpoint below.
Evidence: `data/panel-checkpoints/20260915-theme-layout/`.
The image scan has zero unreviewed high/critical findings (47 existing reviewed
findings). Installed through the normal upgrade after verified backup
`panel-20260916T064801163Z-2961d676`; readiness, unchanged server records and the
existing Tailscale address pass. Image digest:
`sha256:402acf4b51d4a23cb036203ba1ae022ecc0c8d68c7d42364e6ecdd14f1d6c2c1`.

## Accent vibrancy correction — 2026-09-16 UTC

`serverforge-web:themes-vivid-rc1-20260916` corrects overly pale theme colors.
Text variants now target contrast against the actual neutral and selected-control
surfaces instead of a fixed luminance threshold. Logo and title marks use separate
variants, retaining the original accent when it meets 3:1 contrast; small text and
focus indicators retain at least 4.5:1 on their applicable surfaces. Primary fills,
neutral backgrounds, saved preferences, and semantic colors are unchanged.

The build, lint, web/test type checks, **630 unit tests**, and both focused theme
workflows in Chromium and Firefox pass. Six loaded overview screenshots cover
orange, Ocean and Violet in both modes. The final image scan retains the same
47 reviewed high/critical findings with zero unreviewed findings and no new exception.
The final packaged run passes **25 release checks** and all **16 browser workflows**
without skips or retries.
An earlier run stopped after a Minecraft server-file download timed out; its
dependent checks were skipped and are not counted as passing evidence. Its fixture
was cleaned before the fresh rerun, with no test or timeout changes.
Evidence: `data/panel-checkpoints/20260915-theme-vibrancy/` and
`data/release-tests/serverforge-packaged-g08fHX/`.
Installed locally through the normal upgrade after verified backup
`panel-20260916T063531716Z-46715072`. The web image digest is
`sha256:79590d7170ac8ea060a6af4fd233e7363a86bbd4a356fde678603b9584d8c0c9`.

## Browser theme customization checkpoint — 2026-09-16 UTC

The local AMD64 image `serverforge-web:themes-rc3-20260916` adds six browser-local
accent presets and a native custom color picker with hex validation under
**Account → Appearance & preferences**. Buttons, links, navigation, selected
controls, focus indicators, logo accents and title periods share contrast-adjusted
colors. Light/dark/device mode remains independent, and semantic status/game colors
are retained. Saved appearance applies before hydration on dashboard and public
pages. Resetting display preferences preserves favorites. No dependency, API,
migration or game configuration change was introduced.

Production compilation, lint, repository/web type checking, **629 unit tests** and
**16 browser workflows**, plus **25 packaged release checks**, passed without skips
or retries. Both new theme workflows
also pass in Firefox 155. Coverage includes all presets in both modes, black/white
and saturated colors, keyboard selection, tab synchronization, malformed/blocked
storage, reset behavior, 320-pixel reflow and initial appearance with client bundles
blocked. A separate runtime-branding check and 48 page/theme combinations pass.
The final web image scan reports **zero unreviewed high/critical findings**, with
the same 47 reviewed findings and no new exception.

Evidence is in `data/release-tests/serverforge-packaged-fuvgUT/` and
`data/panel-checkpoints/20260915-themes/`. Image digest:
`sha256:b33a02c6a1bd4dad97c41e97c09664180bdb09586bf822ee940f92c8f2e97d87`.
The normal upgrade process installed it after verified panel backup
`panel-20260916T060716224Z-fb088436`. Readiness, localhost and the existing portful
Tailscale address pass. Both existing offline server records are identical;
database/Tailscale/Redis services, secrets and API/maintenance images are preserved.
Only the configured web image changed. Isolated Compose projects ran sequentially.
This local UI checkpoint does not qualify another platform or replace the frozen
candidate archive. No commit, push or public publication was performed.

## Settings simplification checkpoint — 2026-09-16 UTC

The local AMD64 follow-up `serverforge-web:settings-rc5-20260916` puts common
settings first, makes advanced game controls searchable, reveals hidden invalid
fields, and preserves edits when groups close. Optional deployment options,
allocation details, custom network addresses and display preferences are grouped
on demand. Required game passwords and enforcement warnings remain visible.
Search cannot submit a form. Existing server settings, defaults, permissions,
API/maintenance images and schema are retained.

Production compilation, lint, web type checking, **627 unit tests**, **14 browser
workflows** and **25 packaged checks** passed. The final browser run has no skips
or retries. Focused settings tests also pass in Firefox 155, including Enter-key
safety, advanced edit retention, hidden-field validation, all four game setup
screens, network discard and narrow-screen search. Eight visual checkpoints cover
server settings, deployment, preferences and networking. The final scan reports
**zero unreviewed high/critical findings**, with the same 47 reviewed findings and
no new exception.

Final-image evidence is in `data/release-tests/serverforge-packaged-GkDWd6/` and
`data/panel-checkpoints/20260915-settings-simplicity/`. An earlier overlapping test
attempt exhausted Docker's address pools before running checks; after its own
cleanup, the sequential run passed. No unrelated networks were removed. This local
UI follow-up adds no platform qualification and does not replace the frozen
candidate archive. It was installed locally after verified backup
`panel-20260916T041221653Z-62bb1f3d`; readiness, localhost and the existing
portful Tailscale URL pass. Existing server records, secrets, API/maintenance images
and database/network services are preserved. No commit or public publication was
performed.

## Navigation and recovery checkpoint — 2026-09-15

The local AMD64 image `serverforge-web:navigation-rc4-20260915` protects unsaved
configuration, files, schedules, server access, network settings and deployment
drafts. Shared Save/Discard/Stay decisions cover client navigation, Back/Forward and
server-section jumps; failed saves retain the outstanding drafts. Branded missing
pages and server lookup failures have consistent titles and recovery actions.
Keyboard Skip to content preserves the selected server section.

Production compilation, lint, **627 unit tests**, **13 browser workflows** and
**25 packaged checks** passed without skips or retries. Browser coverage includes
the existing 128 dashboard and 12 public authentication combinations, plus eight
missing-page cases and the new navigation scenarios. The focused navigation workflow
also passed in Firefox 155. The final web scan has **zero unreviewed high/critical
findings** and the same 47 reviewed findings; no exception was added.

Evidence: `data/release-tests/serverforge-packaged-eKjjK8/` and
`data/panel-checkpoints/20260915-navigation-recovery/`. See the
[design audit](design-audit.md) for scope and limitations. This local UI checkpoint
does not qualify another host platform or replace the frozen candidate archive.
No commit, push or public publication was performed.

## Dashboard design audit checkpoint — 2026-09-15

The local AMD64 image `serverforge-web:design-audit-rc3-20260915` shares the
authentication layout, repairs invitation and sign-in recovery, improves contrast,
contains mobile navigation focus, removes narrow-screen overflow, clarifies loading,
error and empty states, and makes restricted actions and allocation warnings clearer.
No new dependency, API, migration or game configuration change was introduced.

Lint, production web compilation/type checking, **626 unit tests**, **12 browser
workflows**, **25 packaged checks**, **128 dashboard accessibility/reflow combinations**
and **12 public authentication combinations** passed. The final browser run had no
skips or retries. A supplemental 39-case audit and long-name/address checks passed;
inconclusive automated contrast flags and manual review limits remain recorded.
The web image scan has **zero unreviewed high/critical findings**, with the existing
47 reviewed findings and expiring exceptions unchanged.

See the [design audit](design-audit.md) for findings. The navigation/recovery
checkpoint above resolves the draft-loss and missing-page follow-ups. Evidence is in
`data/release-tests/serverforge-packaged-6nMsMW/` and
`data/panel-checkpoints/20260915-design-audit/`. This local follow-up is outside
the frozen candidate archive, was not published, and adds no platform qualification.

## Dashboard motion checkpoint — 2026-09-15

The local web image `serverforge-web:motion-20260915` adds short page/card entrances,
dialog transitions, spring feedback on controls, and small favorite/copy animations.
Theme surfaces blend between colors. It uses native CSS, preserves the persistent
sidebar and drafts when switching server tools, and avoids animating incoming console lines or telemetry.
Both device reduced motion and the dashboard preference disable the effects.

Lint, production web build/type checking, **626 unit tests**, **10 browser workflows**,
**25 packaged checks** and **96 accessibility/reflow combinations** passed. Browser
tests include motion opt-outs, refresh stability and dialog keyboard focus, with no
skips or retries. Supplemental appearance checks inspect native animation timing,
hover/press behavior and mobile navigation. The web image scan has no unreviewed
high/critical findings; the existing expiring exceptions remain in effect.

Evidence: `data/release-tests/serverforge-packaged-Wv9vh7/` and
`data/panel-checkpoints/20260915-motion/`. The latter includes the local deployment
and recovery record. This AMD64 follow-up is outside the frozen candidate archive
and does not qualify additional platforms.

## Quality-of-life development checkpoint — 2026-09-15

The local web follow-up `serverforge-web:qol-rc-20260915` adds browser-scoped
appearance and layout preferences, overview favorites and sorting, address copying,
console filtering/downloads, adjustable log text and wrapping, and in-memory command
recall. Existing Bedrock API/maintenance images, permissions, database schema and
server configuration are retained. See the [dashboard guide](dashboard.md).

Validation passed **626 unit tests**, lint, type checking and a production web image
build. The final image passed **10 browser workflows**, **25 packaged checks** and
**96 accessibility/reflow combinations**, without skipped or retried browser tests.
A supplemental four-case visual check covers compact preferences with reduced
motion on light/dark desktop/mobile screens. The final web image scan reports zero
unreviewed high/critical findings; existing expiring security exceptions still apply.

Evidence: `data/release-tests/serverforge-packaged-fePlG7/` and
`data/panel-checkpoints/20260915-qol/`. These local AMD64 changes are outside the
frozen candidate archive and do not qualify additional host platforms. Preferences
are stored for each dashboard origin and browser profile; they do not sync between
devices or between localhost and Tailscale addresses.

## Bedrock development checkpoint — 2026-09-15

Minecraft Bedrock is implemented as a separate adapter and deployment option.
This follow-up has local AMD64 API/web/maintenance images tagged
`bedrock-20260915`; it is **not included in the frozen candidate archive below**.
See [Bedrock setup](minecraft-bedrock.md) for configuration, UDP access, native
add-ons, update preservation and platform limitations.

On Linux x86-64 Docker Desktop, official Bedrock **1.26.45.1** (build 49559497)
passed installation, protected non-root startup, actual UDP discovery on an
allocated port, console/allowlist commands, live resource measurements, graceful
shutdown, staged distribution replacement and backup restore. The updated and
restored server both read a persistent scoreboard marker from the saved world.
Browser checks covered creation, the Bedrock command reference, gamertags with
spaces, add-on file navigation, settings, dark/light contrast and mobile reflow.

Evidence is in `data/release-tests/bedrock-20260915/` (`result.json`,
`recovery-result.json`, `browser-result.json`, game logs and qualification output).
Build, unit, integration, packaging and security records are in
`data/panel-checkpoints/20260915-bedrock/`. The security review records a new,
expiring Debian glibc finding; reviewed exceptions do not mean patched packages.

Authenticated external Bedrock client joins, third-party add-on effects,
Windows/macOS, ARM emulation and a Bedrock four-hour soak remain unqualified.
No native ARM64 Bedrock support or public image publication is claimed.

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
