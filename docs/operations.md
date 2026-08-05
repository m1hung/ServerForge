# Operations

## Backups

### What the panel backs up

`npm run` is not involved — backups are created from the UI or on a schedule,
and written as plain `.tar.gz` under `BACKUP_ROOT/<server-uid>/`.

Excluded by default: `logs/`, `crash-reports/`, `cache/`, `libraries/`,
`versions/`, `steamapps/` and the panel's own scratch directory. These are
regenerated on install and would multiply archive size for nothing.

Backups run one at a time across the whole panel, so a backup never makes
someone's game unplayable.

### What the panel does *not* back up

**The database.** Server rows, users, permissions, schedules and backup records
all live in Postgres. Restoring game files without it leaves orphaned
directories with nothing pointing at them.

```bash
docker exec -t serverforge_postgres_1 pg_dump -U serverforge serverforge \
  | gzip > panel-$(date +%F).sql.gz
```

Run that on a schedule alongside your server backups.

### Restoring

Restore from the Backups tab. The server stops, the archive is unpacked into a
staging directory, and only then is the live directory swapped out — the
current world is kept until the restore succeeds, so a failed restore changes
nothing.

The server stays offline afterwards, deliberately: check the world is what you
expected before letting people back in.

## Scheduled tasks

Five-field cron in the server's timezone. Actions run in order and can combine:

| Want | Schedule | Actions |
|---|---|---|
| Nightly restart | `0 5 * * *` | warn command, then restart |
| Hourly backup, keep 6 | `0 * * * *` | backup, retain 6 |
| Weekly maintenance | `0 4 * * 1` | stop, backup, start |

"Only when online" is on by default, so a stopped server does not get woken up
by its own restart schedule.

Retention is per-schedule: an hourly backup pruning to 6 never deletes the
manual backup you made before installing a mod.

## Running more than one instance

Only one process may supervise servers at a time. The supervisor takes a short
Redis lock (`sf:leader:monitor`) and renews it; a second instance stands by and
takes over within 30 seconds if the leader disappears.

Without that lock, two instances both attach to every container, so every
console line is published twice and every resource sample is doubled — which
reads as a game bug rather than a deployment mistake.

For a pure API replica behind a load balancer, set `WORKER=0`. It serves HTTP
and WebSockets without running workers or the supervisor at all.

## Monitoring

`GET /health` reports the database and Redis:

```json
{ "status": "ok", "brand": "ServerForge", "checks": { "database": true, "cache": true } }
```

Returns `degraded` when either is down. Point your uptime check at it.

Per-server resource samples land in `MetricSample` and are exposed at
`/api/servers/:uid/metrics?hours=24`.

## Capacity

Set each node's memory and disk in Settings → Machines. The panel then refuses
deploys that would exceed the node's capacity minus its headroom (10% by
default), with a message naming how much is actually free.

Leave capacity at 0 to disable the check — useful on a machine you are sharing
with other workloads and managing by hand.

Disk quotas are enforced by a slow sampler rather than a filesystem quota: a
server that exceeds its limit is stopped and the owner is told why. A 20 GB
modpack is expensive to walk, hence the once-a-minute cadence.

## Upgrading

```bash
git pull && npm install && npm run build
```

```bash
npm run db:migrate
```

Restart the panel. **Running game servers are not disturbed** — containers keep
running, and the supervisor re-attaches to them on boot. That is the point of
reconciliation, and it means panel upgrades do not need a maintenance window.

## Crash handling

A server that exits non-zero is marked crashed and auto-restarted, up to three
consecutive times. After that, auto-restart pauses and the timeline says so —
restarting a server that fails during boot just fills the console with the same
error forever.

OOM kills never auto-restart: more memory is needed, and retrying without it
wastes everyone's time. The console shows what to change.

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
