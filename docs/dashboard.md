# Using the dashboard

The sidebar keeps your place and theme as you move between pages. Use **Dark mode**
at the bottom of the sidebar; on a small screen, open the navigation menu first.
The **Quick start guide** explains the main tools without leaving the dashboard.

Sign-in and invitation pages use the same workspace layout. If the panel cannot
be reached at sign-in, use **Retry connection**. A missing invitation link explains
how to request a complete one instead of presenting an unusable account form.

## Make the dashboard yours

Open **Account → Appearance & preferences**, or **Customize** on the overview.
Theme, spacing, accent color and reduced motion are shown first. Open **Overview display**
for the default server view and statistics, or **Console display** for log text
size and wrapping. These choices save automatically.
The device's reduced-motion setting is always respected. Reset display preferences
restores the defaults and keeps your favorite servers.

Use the **Custom accent** color picker or the **Hex color** field for a six-digit color such as
`#2563eb`. Valid colors apply immediately; incomplete or invalid text leaves your
last valid color active and explains how to correct it. Buttons, links, focus outlines,
logo accents and title periods follow your choice. Logos and title accents stay close
to the chosen color; smaller text adjusts separately for readability on light and
dark backgrounds. Game identities and status colors keep their meaning.

The sidebar's dark-mode toggle changes brightness independently of accent color.
**Use workspace default** restores the installation's configured branding and keeps your
other display choices. **Reset display preferences** also clears a custom accent.
Saved appearance is applied before the dashboard, sign-in, invitation and recovery
pages render, so changing pages or reloading does not flash the default theme.

Pages and cards ease into view, controls respond with a light spring, and successful
copies and favorites get a small icon pop. Theme changes blend between colors.
These effects do not replay on every live reading or console line. **Reduce animation**
turns off the motion and smooth scrolling immediately, including theme transitions.

Star a server in either the list or card view. Use **Favorites** to show just those
servers, or sort with favorites, running servers, or servers needing attention first.
Search also matches descriptions, game names, and addresses. Use the copy icon beside
an overview address to copy it. For network-specific addresses and verification,
open the server's **Share** controls.

Your view, sort order, favorites, appearance and console display choices persist
for this dashboard address in this browser profile, across reloads and tabs. A local
address and a Tailscale address have separate preferences. They apply to anyone using that
browser profile and do not sync to another device or grant server access. Search
and filters are temporary. Automatic view uses cards on small screens; explicitly
choosing list or cards overrides it. If browser storage is blocked, changes still
work for the current page session and the preferences section explains why they
couldn't be saved.

## Start a game

An owner or administrator selects **Deploy a server**, chooses a game and edition,
and names the server. Resources start with the game's suggested allocation; adjust
them if needed. **Game options** stays collapsed when its defaults are ready to use.
Games that need a password show those options immediately. The panel checks
available memory and platform compatibility before creation.

For a CurseForge pack, select the uploaded server-pack edition and upload the
publisher's **server pack ZIP**. A client/profile export is a different format.
Follow installation progress on the server page. A failed upload stays available
for inspection and retry; retry uses fresh staging files. Start the game when the
installation completes, then wait for its console to report readiness.

## Find the right server tool

Every available tool appears above the server's content. You can bookmark its URL
to return directly to that section. Members see tools allowed by their permissions.

| Tool                   | Use it to                                                                |
| ---------------------- | ------------------------------------------------------------------------ |
| Overview               | Start or stop the game, read its console, and watch resource usage.      |
| Mods & plugins         | View or upload files compatible with the selected game and loader.       |
| Settings               | Change game settings and hardware, then restart to apply saved changes.  |
| Backups & restore      | Make a game recovery point or restore an earlier world.                  |
| Files                  | Browse and edit server files permitted by your account.                  |
| Performance & recovery | Inspect diagnostics and configure supported crash recovery.              |
| Updates & rollback     | Prepare an update, review it, apply it, or return to the saved version.  |
| Schedules & alerts     | Choose daily, weekly, or hourly maintenance, or respond to a game event. |
| Players                | View observed players and use the game's supported player controls.      |
| Shared access          | Let an existing dashboard account help manage this server.               |

**Settings** groups server details, resources and game options. Common game settings
are shown first. Open **Advanced game settings** or **Expert game settings** only
when needed, or use **Find a game setting** to search by name, help text, group or
configuration key. Selecting a result opens its section and focuses the field.
A setting that depends on another option explains what must be enabled first;
searching never changes a value, and Enter in the search box does not save the form. Closing a section keeps your edits, and validation
opens sections containing invalid fields. Use **Save changes** to apply the draft
or **Discard changes** to return to saved values. **Compare saved and running limits**
shows the detailed allocation table; warnings remain visible without opening it.

The console's **Command cheat sheet** is specific to the game. Search for an action
and insert its command, replace any highlighted placeholders, then send it. Inserting
a command does not execute it. Games with a read-only console explain that limitation.

Filter the latest **500 console lines** by text or output stream, adjust text size,
or turn line wrapping off for aligned tables. **Standard error** selects the stderr
stream; games may also write informational messages there. **Download visible logs**
saves only the current filtered lines, not the full historical log. Pausing scrolling
keeps receiving output, and the 500-line limit still applies. Use **Follow latest**
to return to the newest output.

In the command field, **↑ / ↓** recall up to 30 successfully sent commands from the
current server visit. You can edit a recalled command before sending it; going down
past the newest restores your draft. History is held only in memory and is cleared
on reload or when switching servers. Arrow keys never execute commands.

CPU usage can exceed 100% when a game uses several cores. Actual per-core readings,
where available, are distinct from aggregate CPU-capacity blocks. Stale or unavailable
readings are labelled. **Saved** allocation describes the next start; **applied**
allocation describes the current container. Storage is a measured budget, not a
portable hard disk quota.

Settings and file drafts stay available when switching between a server's
tools. Leaving through the sidebar, another server, sign-out or browser Back/Forward
offers **Save and leave**, **Discard and leave**, and **Stay here**. A failed save
keeps the draft and explains the error. Schedule and shared-access drafts receive
the same protection when changing sections. Network settings are protected too.
New-server forms offer Stay or Discard; finish deployment on the creation page.
Reloading or closing the browser uses its native unsaved-changes warning. Drafts
remain in memory; they are not recovery backups and cannot survive a browser crash.

Missing pages and nonexistent servers use the same title styling as the dashboard,
with a link back to your servers. A temporary server lookup failure offers **Retry**
and is distinguished from a server that does not exist or is no longer accessible.

Tools distinguish loading, unavailable data and empty results. Use **Retry loading**
after a failed lookup, or **Clear filter** when a file search has no matches.
Installation status retries its lookup automatically. If copying an address is
blocked by the browser, a visible message tells you to select the text manually.

Schedules use the selected timezone, initially your browser's timezone. Simple
choices display a readable time; **Custom cron expression** is available for other
timings. Review every action before enabling a schedule, especially restarts,
console commands, and webhooks.

## Invite players or share management

These are separate tasks:

- **Share** on a server gives players its local, public, or Tailscale game address.
  Players do not need a dashboard account. Include the displayed port and follow
  the connection instructions for their network.
- **Workspace accounts** creates a private, single-use dashboard invitation that
  expires after 72 hours. Select initial servers and choose view-only, operator,
  or custom permissions. An invitation with no servers grants an empty workspace.
- **Shared access** changes an existing account's permissions on one server.
  Console and file permissions allow powerful changes; choose them deliberately.

Only owners can grant administrator access. Account changes that need identity
verification ask for your password and active second factor beside the action.

## Secure your account

Open **Account** to change your password, sign out devices, set up an authenticator,
or manage scoped API keys. Authenticator setup requires confirmation before it is
enabled. Save the recovery codes when displayed. API keys are also shown once;
store them securely and grant only the scopes your integration needs.

## Connect remotely and keep recovery points

**Network & access** separates remote dashboard access from game connections.
Use the displayed Tailscale dashboard URL, including its port. A portless HTTPS
address is shown only when the Serve configuration has been verified. The dashboard
sidecar does not tunnel game ports. Detected addresses are used by default; open
**Custom addresses** only to override them. **Discard changes** restores your saved
network settings. Port forwarding being off is a normal state for local-only games.
UPnP requires both a workspace opt-in and a
per-server opt-in; test the resulting game address from the player's network.

Owners and administrators can use **System status** to check readiness, disk space,
backup failures, interrupted jobs, and pending restarts. Follow its action links to
the affected server or run the displayed maintenance command on the host.

Game backups protect one server. Automatic panel backups protect the database and
panel configuration. A **full recovery bundle** contains panel state and consistent
game files; creating one stops and then resumes running games. Keep a verified copy
on another device. Follow [operations and recovery](operations.md) for host commands,
upgrade, and fresh-host restoration.
