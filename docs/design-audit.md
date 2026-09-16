# Dashboard design audit — September 15, 2026

The dashboard has a consistent visual foundation: shared page titles and accent-colored
periods, typography, spacing, controls, status colors, icons and light/dark themes.
This audit found concrete accessibility, responsive layout and feedback defects
and corrected them in the existing design. A follow-up protects unsaved drafts
when navigating and completes the missing-page recovery views.
This is an audited checkpoint, not a guarantee that every possible bug is absent.

## Browser accent follow-up — 2026-09-16 UTC

Account appearance now offers six named presets and a native custom color picker
with hex validation. Shared root variables color navigation, buttons, selected
controls, focus indicators, logo accents and title periods. Status and game colors
remain semantic. Luminance-based variants preserve text contrast for extreme custom
colors; theme brightness and accent selection remain independent.

The focused workflows pass in Chromium and Firefox, including preset keyboard
selection, tab synchronization, malformed/blocked storage, resets that preserve
favorites, and light/dark first paint with client bundles blocked on dashboard,
sign-in, invitation and missing-page recovery routes. Narrow-screen controls fit
at 320 pixels. A separately configured brand accent and 48 page/theme combinations
also pass. Evidence: `data/panel-checkpoints/20260915-themes/`; final packaged
installation and scan results are recorded in the [release report](release-candidate.md).

## Scope

Reviewed the overview, deployment, account, workspace accounts, network and system
pages; sign-in, initial owner setup, second-factor sign-in and invitations; and all
ten server sections: overview/console/resources, mods, configuration, backups,
files, diagnostics, updates, schedules, players and shared access. Checked the
sharing, command reference, security confirmation and mobile navigation dialogs.

Inspection covered page hierarchy, title punctuation, spacing, buttons and links,
forms, validation, empty/loading/error/success states, permission-aware actions,
keyboard focus, native dialogs, long names/addresses, narrow screens, themes and
the existing motion/reduced-motion behavior. Server headings intentionally remain
smaller than workspace headings to preserve the compact desktop layout.

The browser matrix covers 1440 × 900, 720 × 450, 390 × 844 and 320 × 720 layouts in
light and dark mode. Separate public-page checks cover desktop and 320-pixel
widths, with and without an invitation token. The 320-pixel checks exercise reflow;
they do not substitute for testing every browser's actual zoom behavior.

All account, game, backup, restore and installation mutations used isolated Compose
projects with their own ports, secrets, databases and server files. Read-only audit
views used a restored qualification bundle. Simulated service failures and limited
member views used browser request interception, clearly separate from real API
permission tests in the packaged suite.

## Findings and fixes

| Priority | Finding                                                                                                            | Resolution                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| High     | Keyboard focus could leave the open mobile navigation and reach obscured controls.                                 | Background workspace is inert while the drawer is open. Tab/Shift+Tab stay inside, Escape returns focus, an explicit close button is present, and resizing to desktop releases the drawer. Native dialogs retain their own focus handling. |
| High     | Sign-in could hide an initial service failure and offer an ineffective retry route.                                | Visible connection/error states, a working Retry connection action, and disabled submission until setup state is known. Entered credentials remain governed by the existing authentication flow.                                           |
| High     | Authentication links failed text/link contrast checks; the desktop brand footer measured only 4.45:1.              | Shared accessible link color plus underlining, and a brighter footer color with contrast above 4.5:1.                                                                                                                                      |
| Medium   | Invitations used a different page layout and a missing token still offered an unusable signup form.                | Shared authentication layout with the same branding, title treatment and form controls. Missing invitations explain how to obtain a complete link; valid links show the account form and pending/error feedback.                           |
| Medium   | Opening a complete invitation link from an already-open invitation page left the old form state visible.           | Fragment changes load the new invitation and clear stale errors. The token is still removed from the visible URL immediately and sent only in the acceptance POST.                                                                         |
| Medium   | Network, backup and schedule pages overflowed a 320-pixel viewport (335, 328 and 381 pixels respectively).         | Removed intrinsic width constraints from the network path and allowed tool actions and long buttons to wrap. All tested pages fit the viewport; detailed tables/console keep intentional internal scrolling.                               |
| Medium   | Clipboard denial had no visible explanation; a throwing fallback could leave a hidden textarea and steal focus.    | Visible manual-copy guidance and an alert icon. Cleanup and focus restoration now run even if the browser's fallback throws.                                                                                                               |
| Medium   | Players appeared unsupported while still loading; other tools had ambiguous blank states.                          | Explicit loading and retry states across resource-backed tools. Unsupported messaging appears only after a successful response. Empty access lists and file searches explain what to do next.                                              |
| Medium   | Installation lookup errors could remain stale after a successful refresh, and initial loading looked like failure. | Separate loading, lookup failure and action failure states. Successful polling clears the lookup error while retaining an actionable operation error.                                                                                      |
| Medium   | Mod guidance offered deployment or file actions to users without the relevant access.                              | Actions follow the existing workspace role/server permissions. Restricted members receive a clear request-access explanation. API authorization is unchanged.                                                                              |
| Medium   | Some hardware limitations looked like success notices, and unlimited memory could read “Unlimited MiB.”            | Consistent warning colors, explicit unsupported-swap guidance and correct unlimited-memory labels. Saved/applied allocation and storage-budget distinctions remain intact.                                                                 |
| Low      | The sharing connection selector had an aria-label on an untyped div.                                               | The selector is now a named group of pressed-state buttons.                                                                                                                                                                                |

The fixes reuse native HTML/CSS and shared components; no animation, routing or UI
dependency was added. All normal page titles use `PageTitle`, including its
decorative orange period. Section headings and dialog titles intentionally use the
existing smaller hierarchy instead of repeating page-title decoration everywhere.

## Navigation and recovery follow-up

**Resolved — protect unsaved edits when leaving a server page.**

Previously, selecting Account after editing a server's Panel name discarded the
draft. A shared native dialog now offers Save and leave, Discard and leave, or Stay
here for sidebar navigation, server changes, sign-out and Back/Forward. Saving
multiple dirty forms waits for each save; a failed request retains the remaining
drafts. Configuration and files persist between server sections. Schedules and
shared access are protected when leaving their section; network settings and
deployment drafts are also covered. Deployment is never submitted by the leave
dialog. Reload/close keeps the native browser warning.

Client links use Next's navigation callback. Back/Forward tracks existing history
entries and restores the source entry before asking; it adds no sentinel entries
and preserves opaque router state. Direct section jumps receive the same protection.
The keyboard skip link focuses the main content without changing the server section.
Dirty data stays in memory, not browser storage.
This is navigation protection, not crash recovery or automatic submission of console
commands and security forms.

**Resolved — complete missing-page recovery views.** Unknown routes use the shared
brand layout and orange-period title, with links to the overview and sign-in.
Server loading, missing-server and temporary-failure views use the shared title
component. HTTP status is preserved by the API client so an unavailable service
offers Retry rather than incorrectly claiming the server is missing. Changing
server identifiers clears the previous server's state.

## Settings simplification follow-up

Server **Configuration** is now labelled **Settings**; existing bookmarked
`#configuration` URLs still work. Server details, resources and game options have
consistent headings and save/discard actions. The saved/running allocation table
is available on demand, while enforcement warnings remain visible.

Game settings show common options first and group advanced and expert controls in
native disclosures. Search includes names, descriptions, groups and configuration
keys across all tiers. Results reveal and focus the relevant field. Conditional
settings explain their prerequisite without changing it. Searching and pressing
Enter in search never save the form; closing a group keeps every edited value.
Native validation opens all enclosing groups containing an invalid field.

Deployment starts with the existing resource defaults and collapses optional game
rules. Games with an empty required password show their options immediately. Theme,
spacing and reduced motion stay prominent; overview and console preferences have
separate expandable groups. Custom network addresses are optional, disabled port
forwarding reads as a normal state, and network settings offer Discard changes.
No server default, permission, API, database schema or dependency changed in this
follow-up. Desktop server tools retain their internal scrolling; narrow screens
use normal page scrolling.

This follow-up passed 627 unit tests, lint, production compilation/type checking,
14 browser workflows and 25 packaged checks on the final image. The added settings
workflow passed in Chromium and Firefox 155, covering search without submission,
retained advanced edits, hidden invalid fields, conditional options, all four game
setup screens, network discard, preferences and 320px light/dark accessibility.
Eight final visual checkpoints fit without JavaScript errors. Evidence is in
`data/panel-checkpoints/20260915-settings-simplicity/` and
`data/release-tests/serverforge-packaged-GkDWd6/`. Failed preliminary runs remain
recorded and are not counted as passes. This does not qualify additional game/host
combinations or replace an independent usability/accessibility review.

## Verification of the navigation/recovery checkpoint

- Production web compilation and type checking, lint and 627 unit tests passed.
- The original supplementary 39-case narrow-screen audit reported no automated WCAG AA
  violations, page overflow or escaped mobile focus after the fixes.
- Long server names and IPv6 addresses fit at 320, 720 and 1440 pixels.
- Manual inspection confirmed the security dialog's description is unobscured
  and readable, with 7.06:1 contrast from the rendered dark-theme colors. Axe marked
  some dialog, offscreen form and layered overview text contrast inconclusive;
  these flags are retained in the evidence, not counted as automatic passes.
- All 13 browser workflows passed without skips or retries, including 128 dashboard
  accessibility/reflow combinations and 12 public authentication combinations.
  All 25 packaged checks passed, including real Minecraft operations, backups,
  upgrades, rollback and interruption recovery. Results are in
  `data/release-tests/serverforge-packaged-eKjjK8/`. Failed preliminary runs remain
  in the evidence and do not count as passes.
- The added workflow covers failed and combined saves, sidebar navigation, multiple
  history entries, Forward, reload cancellation, direct section jumps, keyboard
  skip links, form reversion, schedule/access/deployment/network drafts, a 320px
  dialog and eight missing-page theme/width/route combinations. It also passed in
  Firefox 155. Four public recovery screenshots were checked separately.

Evidence: `data/panel-checkpoints/20260915-design-audit/` for the initial audit and
`data/panel-checkpoints/20260915-navigation-recovery/` for the follow-up. These private
directories contain screenshots, machine-readable results, build/scan logs, source
checkpoints and recovery records. Do not publish credentials, raw configuration,
private traces or backup bundles.

The latest settings image is installed locally through the normal upgrade process,
following verified panel backup `panel-20260916T041221653Z-62bb1f3d`. Readiness and
the existing localhost/Tailscale addresses pass. API/maintenance images, secrets,
ports, database/network services and the two existing offline server records were
preserved. Nothing was committed, pushed or publicly published by this audit.

## Limits of this audit

The full suite exercised Chromium on Linux Docker Desktop; the navigation/recovery
and settings workflows also passed in Firefox. WebKit could not launch because its native host
libraries are unavailable, so no Safari result is claimed. Real mobile devices,
assistive-technology testing and independent user sessions remain useful
qualification work. Automated WCAG checks and keyboard inspection are not a full
screen-reader audit. Reduced motion and persistent navigation have regression
coverage; not every combination of games, browsers, roles and failure timing has
been inspected visually.

The broader release still awaits the platform, external-client and independent
review gates in the [release report](release-candidate.md). Existing reviewed image
security exceptions remain; zero unreviewed findings does not mean zero known
vulnerabilities. This UI follow-up does not qualify additional host platforms or
publish a release.
