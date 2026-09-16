# RC2 platform and independent tester handoffs

Use only the private bundle for your architecture. Record its release, Git
revision, source digest and all five image IDs from `manifest.json`. A changed
image invalidates affected results. Run one isolated Compose project at a time.
Follow `qualification.md` for setup, game tests, soak and redacted export.

## Linux Engine

Use Linux x86-64 and a supported Docker Engine/Compose installation. Record the
engine version, distribution/kernel and storage filesystem. Confirm the selected
socket is accessible under the operator's normal account. If it is inaccessible,
record **not tested: host permission required**; do not loosen socket permissions
or silently substitute Docker Desktop. Exercise setup, browser access, game
lifecycle, host restart, upgrade/rollback, fresh-target recovery and four-hour soak.
CI running on Linux is not this platform's qualification result.

## Windows x86-64 / WSL2

Enable Docker Desktop's Linux containers and integration with the selected WSL2
distribution. Extract/load the amd64 bundle and run the launcher inside WSL2.
Set `SERVERFORGE_HOME` beneath the Linux home (for example
`$HOME/serverforge-qualification`), never `/mnt/c`. Open the displayed loopback
port in the Windows browser. Record Windows, WSL kernel/distribution, Docker and
browser versions. Check file ownership, occupied-port errors, restart/reconnection,
LAN/Tailscale access from another device and actionable firewall diagnostics.
Perform upgrade/rollback, recovery and the full soak in that same filesystem.

## Intel Mac

Use the amd64 bundle with Docker Desktop. Record macOS, Docker, CPU, allocated VM
memory and browser versions. Keep the installation in a directory shared with
Docker; verify a rejected/unshared path produces a useful error. Check permissions,
loopback/LAN access, sleep/restart reconnection, upgrade/rollback and fresh-target
recovery. Run the four-hour soak while the host remains awake. Document any manual
file-sharing change; an undocumented intervention is a failed install exercise.

## Apple Silicon Mac

Load the arm64 bundle and verify all five panel/service images report arm64.
Record macOS/Docker/chip and VM allocation. Test native Java games separately from
amd64 game emulation. Never infer game compatibility from a native dashboard.
Only opt into `--allow-experimental` for explicitly experimental game rows, and
record emulation settings, game/loader versions and outcomes separately. Bedrock
and other x86-only binaries are not native ARM games. Untested/failed combinations
remain experimental or blocked. Complete the same file-sharing, networking,
upgrade, recovery and soak checks as Intel Mac.

## Independent installation and recovery exercise

Use shipped documents only. Record each undocumented intervention as a defect.

1. Verify checksums, load images and follow `setup.md` in a new directory using
   `setup --qualification`. Create the owner, accept an invitation and confirm an
   ordinary member cannot administer the host. Record readiness and browser steps.
2. Use `qualify --cases vanilla,bedrock --minutes 90`. Create identifiable world
   data and confirm it through the game console; record exact game versions.
3. Follow `operations.md` to create a full backup. Verify it using the launcher.
   Keep this sensitive bundle local/off-host under your control, never in a report.
4. Stop the source fixture. Set `SERVERFORGE_HOME` to a different empty directory,
   configure the candidate there with `setup --configure-only --qualification`
   and a free port, then follow the documented `restore` and `start` commands.
5. Verify the games start offline, accounts/passwords and TOTP remain usable,
   previous sessions/API keys fail, and exposure stays disabled. Inspect remapped
   paths, start each game, and verify actual recovered world content.
6. Configure remote access afresh. Tailscale requires reauthentication and the
   working dashboard URL may require its port. The sidecar is not a game tunnel.
7. Retain candidate identifiers, pass/fail/not-tested checklist and redacted errors.
   Run `qualification-report` on the original marked fixture after restarting it.
   Recovery evidence from the independent destination must identify both projects
   and the same candidate images; never attach raw recovery bundles.

## Manual accessibility checklist

For every workspace page and server tab in both themes, record **pass**, **fail**
or **not tested**, browser/assistive-technology version and a short reproduction:

- Keyboard-only navigation, visible focus, logical tab order, skip navigation,
  dialog focus/return and Escape handling; no keyboard trap in console or tables.
- Screen-reader names, headings, validation errors, dialogs and status announcements.
- 200% zoom and 320 CSS-pixel width: reachable controls, readable labels, internal
  console/table scrolling without hidden page actions.
- Custom light/dark accents including black/white, contrast, selected states and
  reduced motion. Device-theme changes and navigation must not flash the old theme.

Automated accessibility checks and author-run rehearsals are recorded separately
from these independent human checks. Complete `security-review-rc2.md` for the
independent security review. No response is a pending result, never an approval.
