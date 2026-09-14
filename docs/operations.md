# Operating and recovering ServerForge

Use one API process and its supervisor per installation. Multiple-host
orchestration and horizontal API scaling are outside this release.
All host commands below use the supplied launcher with `SERVERFORGE_HOME` set to
the installation directory.

## Configuration, resources, and installations

Choose game settings and hardware when creating a server, or edit them later
under **Configuration**. Saved values take effect on the next start/restart;
the editor also shows allocation actually applied to the running container.
Saving configuration never silently restarts a game.

CPU is measured in cores: 250% means 2.5 cores. When Docker provides per-core
counters, individual meters show real logical-core measurements. Otherwise,
capacity blocks represent aggregate usage and are labelled accordingly. They
are not measurements of physical cores. Unavailable or stale telemetry is
shown explicitly. Storage is a measured budget, not a portable hard quota.

Memory allocation is checked against all saved allocations and host headroom
(at least 512 MiB and the configured reserve percentage). CPU overcommit warns.
Additional swap is added to memory for Docker's combined memory-and-swap limit;
zero disables swap and an unset value keeps Docker's default. Unsupported
controls and invalid legacy I/O weights are reported rather than claimed as
active limits. Game containers and installation jobs have process/resource
limits, dropped capabilities and no-new-privileges.

Installation progress survives panel restarts. An interrupted attempt becomes
failed with a reason and a retry action. Retry uses fresh staging files. Cancel
stops at a safe boundary and cannot interrupt the final atomic replacement.
Uploaded server-pack ZIPs remain available after failure until installation
succeeds or the owner removes the uploaded pack. Client/profile exports are
not server packs. Windows-oriented packs may provide supported version metadata;
the panel does not execute uploaded batch scripts.

## Three backup products

| Product | Contents | Default retention | Game downtime |
| --- | --- | --- | --- |
| Game backup | One server's files; settings and allocation in the panel database | Manual or per schedule | Running game stops and resumes |
| Automatic panel backup | Database and required panel configuration | Seven successful copies, daily | None |
| Full recovery bundle | Panel backup, all game files/mods/worlds, game backups, themes and manifests | Three successful copies | Graceful stop during capture |

```bash
./serverforge backup
./serverforge backup --full
./serverforge verify /absolute/path/to/full-EXAMPLE.sfr
```

Bundles are directories ending in `.sfr`, with a versioned manifest, SHA-256
checksums, database archive, configuration and file archives. Creation uses a
temporary directory and verification before marking complete. Failed copies do
not prune successful backups. Sensitive directories are mode 700 and bundle
files mode 600. Preserve permissions when copying them off the host.

Full backups run only on demand or in an owner's explicit UTC maintenance
window under **System status**. The panel drains operations, records running
games, stops them gracefully, captures files and panel state, then resumes those
games even if backup creation fails. A game that fails to stop cleanly prevents
a full capture; inspect the failure and resume it before retrying.

**Keep a verified off-host copy.** A local bundle cannot recover a lost disk or
host. Bundles contain passwords hashes, TOTP encryption material and other
secrets; they are not diagnostic exports. Built-in cloud storage is not provided.
Internal symbolic/hard links are validated as a complete graph before extraction.
Steam links rooted at the game container directory are made portable. Escaping
links, cycles, writes through links and special files cause a clear failure;
files are never silently omitted.

Game restores run through **More tools → Backups & restore**. The panel validates
the checksum/archive, makes a recovery backup, stages replacement files and
journals the swap. The restored game stays offline for inspection.

## Fresh-host recovery

1. Install Docker and load the matching candidate application images on the new
   host. Copy the complete `.sfr` directory from the off-host backup.
2. Select an empty installation directory and configure it without initializing
   a panel database:

   ```bash
   export SERVERFORGE_HOME="$HOME/serverforge-recovered"
   ./serverforge setup --configure-only --port 3000
   ./serverforge verify /absolute/path/to/full-EXAMPLE.sfr
   ./serverforge restore /absolute/path/to/full-EXAMPLE.sfr
   ./serverforge start
   ```

3. Sign in with the preserved password and authenticator. Restored sessions and
   API keys are revoked. Host paths are remapped, old container IDs are cleared,
   and games remain offline. Password hashes, TOTP configuration and the required
   encryption key are preserved.
4. Inspect the games, start one at a time, check the console and actual saved
   world content, and stop again if anything differs from expectations.
5. Reauthenticate Tailscale, verify local/tailnet/public addresses from the
   intended clients, and explicitly re-enable network exposure. Full recovery
   clears stale networking state and disables public game exposure.

The destination database and game directories must be empty. Restore refuses
existing data rather than overwriting worlds. Bundle format, schema compatibility,
checksums and space are validated before restoration begins. Keep the source
bundle unchanged until recovered games have passed inspection.

If restoration is interrupted after the database was committed, the tool leaves
a recovery report and staged configuration for inspection. Do not repeatedly
restore into that partially populated destination. Preserve it, use another
empty destination for a clean retry, and inspect the report. Automated completion
of that interrupted finalization remains a release qualification item.

## Upgrade and rollback

Load the complete next-release image archive before upgrading:

```bash
docker load -i serverforge-images.tar
./serverforge upgrade VERSION
./serverforge diagnostics
```

The launcher verifies native matching image versions and the availability of
previous images, checks space, stops the panel, makes and verifies a panel backup,
applies migrations, starts the selected release and waits for readiness. Games
remain running through a panel upgrade. Existing identities, accounts, paths,
ports, secrets and networking preferences are preserved.

`config/upgrade.json` records image IDs, migration versions, backup ID and the
last completed step. Do not delete an unfinished journal or its backup.

```bash
./serverforge rollback
```

Rollback uses previous images alone only when their schema compatibility is
explicitly declared. Otherwise it restores the matching verified pre-upgrade
panel database and configuration. This is a snapshot restore, not a destructive
migration downgrade. Newer tables are removed within the same database
transaction that restores the old snapshot. Keep old release images available;
the launcher retains aliases so a rebuilt development tag cannot erase rollback
references. Changes made after the matching panel backup are lost on a database
rollback; inspect the chosen journal and backup first.

## Accounts and host recovery

Owners/admins create single-use 72-hour invitations in **Workspace accounts**.
Only owners can grant workspace administrator access. Invitations carry their
secret in the link fragment and exchange it through POST. Suspension immediately
revokes access; the last owner cannot be removed or suspended.

**Account** provides password changes, sessions/revocation, authenticator setup,
recovery-code regeneration and scoped API keys. Key secrets appear once and
expire after 90 days by default. Sensitive changes require the password and the
active second factor. Keep recovery codes outside the host.

```bash
./serverforge reset-password --user OWNER_USERNAME --generate
# Only if the authenticator and recovery codes were also lost:
./serverforge reset-password --user OWNER_USERNAME --generate --clear-2fa
```

The generated password is displayed once. Host recovery revokes sessions and
records an audit event. Do not include its output in diagnostic reports.

## Health, jobs and diagnostics

- `/health/live` reports whether the API process is responding.
- `/health/ready` checks the database, expected schema, Docker, storage and
  supervisor. It returns HTTP 503 when the panel cannot accept work.
- `/health` retains its `ok`, `docker`, and `brand` shape with truthful HTTP status.
- **System status** shows disk pressure, recovery failures, interrupted schedules,
  pending restarts, invalid saved controls and active operations.

Export redacted status in the dashboard, or run `./serverforge diagnostics` for
host/version checks. Ordinary diagnostics exclude raw game logs, configuration
and secrets. A diagnostic report is distinct from a recovery bundle.

Panel shutdown blocks new mutations, drains work within a bounded timeout,
closes streams and disconnects database clients. Healthy game containers remain
running. Restart reconciliation adopts owned containers created just before a
crash and flags duplicate claims instead of creating another container.
Missed cron occurrences are recorded and skipped. Interrupted command/webhook
runs require attention; uncertain operations are not automatically replayed.

Console streams reconnect and recheck access. A disconnected browser does not
cancel a running server operation. Archive traversal, oversized uploads and
untrusted outbound URLs are rejected by the relevant API boundaries.

## Palworld save and shutdown

Set an admin password and keep the REST API enabled before starting Palworld.
The panel uses its applied configuration to call the private save endpoint,
request shutdown and verify process exit. The REST host port is bound to loopback.
It refuses an unavailable or unauthenticated save API instead of claiming a
consistent backup after a signal-only stop.

For an older running game without these settings, save and shut down through
in-game administration, then configure them before the next start. See the
publisher's [save API](https://docs.palworldgame.com/api/rest-api/save/) and
[shutdown API](https://docs.palworldgame.com/api/rest-api/shutdown/).

## Database and Tailscale image updates

Candidate archives include five matching native images. An ordinary upgrade
preserves the installed database and Tailscale image IDs. To apply their reviewed
updates after loading the complete candidate archive, select them explicitly:

```bash
./serverforge upgrade 0.1.0-rc.1 \
  --postgres-image serverforge-postgres:0.1.0-rc.1 \
  --tailscale-image serverforge-tailscale:0.1.0-rc.1
```

The database image must remain PostgreSQL major version 17. This command is not
a PostgreSQL major-version migration. The verified pre-upgrade panel backup and
previous image identifiers remain available for documented rollback.

Upgrade also supports a stopped installation: it starts the recorded database
image before creating the verified backup. After selecting a database image, it
checks PostgreSQL's recorded and actual sorting-library versions. A changed or
missing version triggers a database-space check and `REINDEX DATABASE` while the
panel is stopped. Only a successful rebuild is followed by refreshing the version
and starting the panel. Readiness reports a mismatch as unavailable.
For a legacy database with an unrecorded version,
[PostgreSQL 17 rejects that transition through `REFRESH`](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/commands/dbcommands.c).
After the same backup and successful rebuild,
the launcher adopts only the selected database's actual version in `pg_database`
and verifies it. This requires the packaged database's administrative role; it
does not alter other databases or change the locale/provider.

Rebuild intent is recorded before SQL runs. Rollback rebuilds indexes again when
the interrupted or completed upgrade may have changed them, including when the
old version marker still matches. Insufficient space or a failed rebuild leaves
the upgrade checkpoint for recovery; it does not clear the version warning or
discard the verified backup. This follows
[PostgreSQL's collation maintenance guidance](https://www.postgresql.org/docs/17/sql-altercollation.html).

An already-running Tailscale sidecar is recreated when its image or entrypoint
changes. Its state volume is retained, and rollback restores the previous image.
An upgrade does not enable a sidecar that was stopped or never configured. Host
Tailscale and unrelated Serve handlers are not changed by this image update.

Legacy source adoption records the original API port bindings and API/web runtime
environment in private `config/legacy-runtime.json`. Rollback to the legacy images
restores those settings, including the direct API port used by older dashboards.
Starting a rolled-back legacy panel does not run new migrations. Run an explicit
backed-up upgrade to return to the candidate. Keep this private runtime file with
the configuration backup; it contains the original service credentials.
