# Server management

Open a server and select a tool from the tabs above its content. All available
tools stay visible; the desktop overview stays compact and longer panels scroll
internally. Tools and actions require the corresponding server permissions.

## Backups and restore

Choose a name and select **Back up now**. Progress appears in the list. A running
server stops gracefully while all its files are archived and starts again after
the backup. Offline servers remain offline. Archives are plain gzip-compressed
tar files with SHA-256 checksums. Safe internal Steam links are preserved; escaping links, link cycles and special files are rejected. A failed graceful stop aborts the snapshot.

**Restore** checks the archive, stages its contents, and creates a new recovery
backup before replacing the live files. It restores the saved game configuration,
version, Java settings, and hardware allocation as well. The server stays offline
for review. Use the recovery backup to undo a restore or update. Downloads contain
the game files; panel configuration snapshots and backup records live in Postgres.
Keep a separate database backup, and copy important archives off the host.

## Files

Browse folders, filter entries, download files, upload files up to 2 GiB, create
folders, rename items, and extract ZIPs into a new folder. Extraction never merges
into an existing directory. ZIP extraction is limited to 50,000 entries and 8 GiB
uncompressed. Traversal, symbolic links, and the panel's internal directory are
blocked. UTF-8 text files up to 2 MiB can be edited, with atomic saving and checks
for changes made since the file was opened.

Stop the server before any file mutation. Use **Configuration** for settings the
panel manages: those values are written again on startup. File editing is useful
for mod and plugin configuration. File drafts survive switching between tools.

## Updates and rollback

Staged updates support Minecraft Java, Valheim, and Palworld. Choose a target
version, or upload the next server-pack ZIP for a custom Minecraft modpack. Client
profile exports are not server packs. Preparing installs in a separate directory
while the current server can keep running. Review added, changed, and removed
installation files before applying; only the first 200 paths per category are
shown. The preserved-path list identifies world and configuration data.

Applying first stops and backs up the server, then copies the latest saves and
configuration into the prepared installation. It swaps files with a recovery
journal so an interrupted swap can be rolled back when the panel restarts. Enable
**Start after update** if desired. Otherwise it stays offline. Roll back from the
automatic **Before update** backup. Mod compatibility still depends on the game,
loader, and pack; a successful preparation does not prove every mod will run.

## Performance and recovery

CPU, memory, and network totals are sampled every 30 seconds while the server is
running and retained for seven days. Charts display CPU in core equivalents and
memory; the Overview continues to show live readings every two seconds. Missing
samples are unavailable, and disk usage is only present when the runtime supplies
it. The activity timeline includes crashes, operations, and schedule results.

**Restart after crashes** enables up to three recovery attempts with 30-, 60-,
and 120-second delays. A ten-minute stable run resets the counter. Manual stops
stay stopped. Memory exhaustion is identified in the crash report.

Minecraft's **Collect tick metrics** sends `spark tps`. Install the Spark plugin
or mod for your loader if it is not bundled. Tick health is collected on request,
not continuously; readings expire after two minutes. Spark's tick-duration output
uses its median when available. CPU alone does not measure game tick health.

## Schedules and Discord alerts

Choose a daily, weekly or hourly schedule and its timezone, or use **Custom cron
expression** for other timings. Event triggers support ready, stopped, crashed,
player joined and player left. Add ordered actions:
power, console command, backup with retention, apply an already prepared update,
or webhook. Minecraft restarts can broadcast a countdown through its console. Palworld uses its private REST save/shutdown path; its displayed in-game commands are not panel-console commands. Set
**Only when online** according to the task; turn it off for crash alerts or
backups of offline servers.

Discord alerts use a webhook action with Discord format and a webhook URL you
provide. Templates support `{server}`, `{task}`, `{event}`, and
`{player}`. URLs are checked against private networks at connection time, requests
time out, and redirects are refused. Saving a schedule does not send a test alert;
**Run now** executes its configured actions, including any webhook.

Retention applies only to successful backups from that schedule. Manual and
recovery backups are kept. Each run rechecks the creator's current permissions;
revoked access prevents execution. Clock schedules show their next run and skip
missed intervals after downtime. Event triggers use observed log events while the
panel is running; they are not replayed after a panel restart. Queued events are
bounded to 1,000 and cooldowns limit repeated triggers. Run one API supervisor;
the operation locks and event queue are local to that process.

## Players and shared access

The player list contains joins and leaves observed since the panel connected to
the current console. It is explicitly partial: players already connected before
observation may be missing. Minecraft supports allowlisting, kicking, banning,
pardoning, and granting or removing operator status. Other games show their supported administration commands and where they can be used; Palworld and Valheim panel consoles are read-only.

**Shared access** grants an existing panel account selected permissions on this
server. The account must already exist. You can edit or revoke grants, and cannot
grant permissions beyond your own. Console, files, settings, and backups expose
powerful server administration capabilities, so give them only to trusted admins.
Panel ownership and global administrator roles are managed separately.
