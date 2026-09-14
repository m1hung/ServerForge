# Operations

## Server configuration and allocation

The deployment form lets you set RAM, CPU cores, storage budget, and the game’s
settings before installation. Hardware starts with the selected edition’s
recommendations; use **Show advanced & expert settings** for additional game options.

For an existing server, open **Configuration**, edit the fields, and choose
**Save changes**. Game settings and hardware changes take effect on the next
start or restart. Saving does not interrupt a running game. Configuration
changes require `server.settings` permission and are blocked while an install,
start, stop, or restore is in progress.

RAM and storage use GiB; CPU supports fractional cores. Zero removes the
corresponding limit. Docker enforces RAM and CPU limits; storage is a tracked
budget, not an enforced disk quota. Existing saved passwords are kept unless
you enter a replacement or explicitly clear them. Game version, modpack, and
Steam branch are installation choices and cannot be changed in this form.

## Backups

### What the panel backs up

`npm run` is not involved — backups are created from the UI or on a schedule,
and written as plain `.tar.gz` under `BACKUP_ROOT/<server-uid>/`.

Archives contain the full server directory, including binaries, mods, worlds,
and configuration. Links and special files are rejected. The saved panel
configuration and hardware allocation are attached to the backup record in Postgres.
Downloading the archive downloads the files; retain the database to restore
panel configuration through the UI.

A running server stops for a consistent backup and resumes afterwards. Operations
are serialized per server. Different servers can back up concurrently, so choose
schedules that fit the host's disk capacity and I/O budget.

### What the panel does _not_ back up

**The database.** Server rows, users, permissions, schedules and backup records
all live in Postgres. Restoring game files without it leaves orphaned
directories with nothing pointing at them.

```bash
docker exec -t serverforge_postgres_1 pg_dump -U serverforge serverforge \
  | gzip > panel-$(date +%F).sql.gz
```

Run that on a schedule alongside your server backups.

### Restoring

Restore from **More tools → Backups & restore**. The archive checksum and extraction are checked first, and a fresh recovery backup is made before replacement. The server stops, the archive is unpacked into a
staging directory, and only then is the live directory swapped out — the
current world is kept until the restore succeeds, so a failed restore changes
nothing.

The server stays offline afterwards, deliberately: check the world is what you
expected before letting people back in.

## Locked out of the panel

Passwords are Argon2id hashes, so a forgotten one cannot be recovered — by you
or by anyone else. Set a new one from the machine instead:

```bash
npm run reset-password
```

It lists the accounts, asks which, and prompts twice without echoing. Add
`-- --user admin --generate` to skip the prompts and have it print a strong
password once.

Every session for that account is signed out, the same as changing a password
in the dashboard: a reset is exactly when a session somebody else is holding
must stop working.

Two-factor is left alone deliberately — losing a password should not silently
remove a second factor. If the authenticator is gone too, use a recovery code,
or add `--clear-2fa` to turn it off as well.

This needs shell access to the machine, which already implies database access,
so it grants nothing that was not there before.

## Scheduled tasks

Five-field cron in the server's timezone. Actions run in order and can combine:

| Want                  | Schedule    | Actions                    |
| --------------------- | ----------- | -------------------------- |
| Nightly restart       | `0 5 * * *` | warn command, then restart |
| Hourly backup, keep 6 | `0 * * * *` | backup, retain 6           |
| Weekly maintenance    | `0 4 * * 1` | stop, backup, start        |

Enable "Only when online" to keep a stopped server from being woken up by its
restart schedule. Leave it off for offline backups and crash alerts.

Retention is per-schedule: an hourly backup pruning to 6 never deletes the
manual backup you made before installing a mod.

## Running more than one instance

Run one API instance with its supervisor enabled. Operation locks and pending
event triggers are held in that process; horizontal API scaling is not supported.
`WORKER=0` disables supervision for development or maintenance, including crash
recovery, history collection, and scheduled tasks. It does not provide distributed
write locking for additional API replicas.

## Monitoring

`GET /health` reports the database and Redis:

```json
{ "status": "ok", "brand": "ServerForge", "checks": { "database": true, "cache": true } }
```

Returns `degraded` when either is down. Point your uptime check at it.

Open a server's Overview to watch live CPU, memory, network traffic, and uptime.
Readings refresh every two seconds through `/api/servers/:uid/resources` and
require `server.view` permission. CPU is measured per core (100% equals one
fully used core); memory excludes reclaimable file cache. Offline or unreachable
containers show unavailable readings, not zero consumption. Disk remains a
configured limit, not a live disk measurement. The Overview graph covers the current page session. **More tools → Performance &
recovery** adds persisted 30-second samples for the last seven days.

The CPU panel displays usage in cores and shows the active container allocation.
When Docker supplies both per-core counter samples, each host logical core has
its own 0–100% meter for this server’s usage. When those counters are unavailable
(including this Docker Desktop/cgroup v2 setup), a clearly labelled capacity view
shows the aggregate as core-sized blocks: 250% becomes 2.5 filled blocks. These
blocks represent CPU capacity, not measurements of individual physical cores.
Changing the saved allocation does not change the displayed active limit until
the game server restarts.

The console streams the latest 500 stdout/stderr lines and new output through
`/api/servers/:uid/console/stream`, requiring `server.console` permission. It
reconnects automatically and shows installation output before a game container
exists. A stopped container's recent logs remain readable until it is removed.
If a reverse proxy sits in front of the API, disable response buffering on the
stream endpoint and allow long-lived responses. Commands are only enabled for
games whose adapter supports them.

## Capacity

Set each server’s RAM and CPU in the deployment form or its Configuration tab.
Choose allocations that the host can support alongside the panel and other
workloads; the panel does not currently check aggregate node capacity.

The storage budget is recorded for each server but does not enforce a disk
quota. Monitor free space on the host separately.

## Upgrading

```bash
git pull && npm install && npm run build
```

```bash
npm run db:push
```

Restart the panel. **Running game servers are not disturbed** — containers keep
running, and the supervisor re-attaches to them on boot. That is the point of
reconciliation, and it means panel upgrades do not need a maintenance window.

## Crash handling

When a server expected to be running exits, it is marked crashed. If automatic
recovery is enabled, the supervisor retries with 30-, 60-, and 120-second delays,
then pauses after another failure. Ten minutes of stable operation reset the
counter. Manual stops and kills remain offline. OOM exits are identified in the
activity timeline and use the same retry guard; review memory allocation before
manually starting a persistent OOM loop.

See [Server management](management.md) for backups, file editing, staged updates,
players, shared access, diagnostics, and scheduled alerts.

## Logs

Development logs are human-readable; production logs are JSON for shipping.
`LOG_LEVEL=debug` adds detail. Cookies, tokens and every known password field
are redacted — logs from this panel end up pasted into support threads, so that
is not optional.

Container logs rotate at 20 MB × 3 files per server.

## Common tasks

**Move a server to a different port** — Network section on the server page. It
must be stopped first, since the container's port mapping is fixed at creation.

**Reinstall without losing a world** — Reinstall replaces server binaries and
loader files only. Worlds, configs and mods are untouched.

**Free disk fast** — delete completed backups first, then old servers. The
Files tab shows what a server is actually using.

**Reset a forgotten owner password**:

```bash
npm run db:studio
```

Or re-run the seed with `SEED_ADMIN_USERNAME` and `SEED_ADMIN_PASSWORD` set to
create a fresh owner account.
