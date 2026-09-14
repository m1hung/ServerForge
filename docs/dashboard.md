# Using the dashboard

The sidebar keeps your place and theme as you move between pages. Use **Dark mode**
at the bottom of the sidebar; on a small screen, open the navigation menu first.
The **Quick start guide** explains the main tools without leaving the dashboard.

## Start a game

An owner or administrator selects **Deploy a server**, chooses a game and edition,
and sets its name, game rules, and hardware. The suggested allocation is a starting
point; the panel checks available memory and platform compatibility before creation.

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
| Configuration          | Change game settings and hardware, then restart to apply saved changes.  |
| Backups & restore      | Make a game recovery point or restore an earlier world.                  |
| Files                  | Browse and edit server files permitted by your account.                  |
| Performance & recovery | Inspect diagnostics and configure supported crash recovery.              |
| Updates & rollback     | Prepare an update, review it, apply it, or return to the saved version.  |
| Schedules & alerts     | Choose daily, weekly, or hourly maintenance, or respond to a game event. |
| Players                | View observed players and use the game's supported player controls.      |
| Shared access          | Let an existing dashboard account help manage this server.               |

The console's **Command cheat sheet** is specific to the game. Search for an action
and insert its command, replace any highlighted placeholders, then send it. Inserting
a command does not execute it. Games with a read-only console explain that limitation.

CPU usage can exceed 100% when a game uses several cores. Actual per-core readings,
where available, are distinct from aggregate CPU-capacity blocks. Stale or unavailable
readings are labelled. **Saved** allocation describes the next start; **applied**
allocation describes the current container. Storage is a measured budget, not a
portable hard disk quota.

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
sidecar does not tunnel game ports. UPnP requires both a workspace opt-in and a
per-server opt-in; test the resulting game address from the player's network.

Owners and administrators can use **System status** to check readiness, disk space,
backup failures, interrupted jobs, and pending restarts. Follow its action links to
the affected server or run the displayed maintenance command on the host.

Game backups protect one server. Automatic panel backups protect the database and
panel configuration. A **full recovery bundle** contains panel state and consistent
game files; creating one stops and then resumes running games. Keep a verified copy
on another device. Follow [operations and recovery](operations.md) for host commands,
upgrade, and fresh-host restoration.
