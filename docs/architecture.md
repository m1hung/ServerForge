# Architecture

## The shape of it

```
┌──────────────┐        HTTPS / WSS        ┌──────────────────────────────┐
│  Dashboard   │ ────────────────────────► │            API               │
│  Next.js 15  │ ◄──────────────────────── │          Fastify 5           │
└──────────────┘   REST + one WebSocket    │                              │
                                           │  routes · services · workers │
                                           └───────┬──────────────┬───────┘
                                                   │              │
                                     ┌─────────────▼───┐   ┌──────▼──────────┐
                                     │   PostgreSQL    │   │      Redis      │
                                     │  (source of     │   │  queues, pubsub │
                                     │   truth)        │   │  console buffer │
                                     └─────────────────┘   └─────────────────┘
                                                   │
                                        ┌──────────▼───────────┐
                                        │   RuntimeDriver      │
                                        │  ┌────────────────┐  │
                                        │  │ DockerRuntime  │  │  ← today
                                        │  ├────────────────┤  │
                                        │  │ AgentRuntime   │  │  ← next
                                        │  └────────────────┘  │
                                        └──────────┬───────────┘
                                                   │
                              ┌────────────────────┼────────────────────┐
                              ▼                    ▼                    ▼
                        ┌──────────┐         ┌──────────┐         ┌──────────┐
                        │ Paper    │         │ Palworld │         │  Fabric  │
                        │container │         │container │         │container │
                        └──────────┘         └──────────┘         └──────────┘
```

One API process runs the HTTP server, the job workers and the supervisor. That
is deliberate: a self-hosted panel should be one thing to run. `WORKER=0`
splits them when one machine stops being enough.

## The four extension points

Everything game-specific lives behind one of these. Nothing else in the
codebase should branch on which game it is handling.

### 1. `GameAdapter` — what a game *is*

`packages/adapters/src/types.ts`

A single object describes version resolution, install steps, the startup
command, the settings schema, log interpretation and where mods go. The
registry in `registry.ts` is the complete list of supported games.

### 2. `SettingsSchema` — what a user can change

`packages/core/src/settings-schema.ts`

A declarative array of typed settings, each with a `tier` (`basic` /
`advanced` / `expert`), plain-language `help`, an optional `showWhen` guard,
and a `target` describing where the value is materialised — a properties key,
an INI tuple entry, a JSON path, an env var, or adapter-internal.

From one declaration you get: the deploy wizard, the settings page, server-side
validation, and the write into the game's own config format. Adding a setting
is a one-object change.

### 3. `RuntimeDriver` — where servers actually run

`apps/api/src/runtime/types.ts`

Create, start, stop, stream logs, sample stats, write stdin, run a throwaway
install container. `DockerRuntime` talks to a local socket. A future
`AgentRuntime` will post the same operations to a remote daemon; business logic
does not change, because it never imports dockerode.

### 4. `InstallTools` — what an adapter may touch

`apps/api/src/services/install-tools.ts`

Download, unzip, read, write, list, and run a container. Every path is resolved
through `resolveWithin` against the server's own directory, so an adapter —
which acts on remote data like a modpack index — physically cannot write
outside its server.

## Key flows

### Deploying a server

1. `POST /api/servers` validates the body, then validates settings against the
   adapter's schema. A bad deploy costs nothing.
2. Capacity is checked against the node's headroom. Refusing now beats two
   servers fighting over RAM at 3am.
3. One transaction creates the server row and claims its ports.
4. The data directory is created outside the transaction (it cannot be rolled
   back), with a cleanup path if it fails.
5. An install job is queued and the request returns `202`. The user watches
   progress live; closing the tab changes nothing.
6. The worker resolves `latest` to a concrete version, records it, runs the
   adapter's install, materialises settings, and marks the server installed.

### Port allocation

Allocations are pre-materialised rows, one per port in the node's range.
Claiming one is a conditional `UPDATE ... WHERE serverId IS NULL`. Two
concurrent deploys racing for the last port produce one winner and one clean
"no ports available" error — never a double-bind that fails at container start.

### Live updates

The worker publishes to Redis; the API holds the WebSockets. That split means a
second API replica behind a load balancer works with no extra code.

One socket per open server page carries console lines, state changes, resource
samples and install progress. Subscriptions are reference-counted, so ten
people watching one server share a single Redis subscription. A capped list in
Redis keeps recent scrollback, so a fresh page load is never a blank console.

### State

`setServerState()` in `lib/events.ts` is the only writer. It updates the row,
the per-server channel and the fleet channel together — a split between them is
exactly what leaves a dashboard stuck on "Starting…" forever.

The supervisor reconciles against reality every 15 seconds and on boot. That is
what lets the panel restart without disturbing running game servers: the
containers keep running and we re-attach to them.

## Data model notes

- Every user-facing row has a short public `uid` used in URLs, so sequential
  ids never leak into the address bar.
- Settings live in a JSON column validated by the adapter's schema, not one
  column per game. Adding a game must not require a migration.
- Tokens are stored as SHA-256 only. A database dump cannot be replayed as a
  session.
- Secrets that must be recoverable (integration keys) are AES-256-GCM encrypted
  with `ENCRYPTION_KEY`.

## Why these choices

**Fastify over Next route handlers for the API.** Long-lived WebSockets, a
Docker log stream per running server, and background workers do not belong in a
serverless-shaped request lifecycle.

**Postgres as the only source of truth.** Redis holds nothing that cannot be
rebuilt — queues, pub/sub, a console ring buffer, rate-limit counters. Losing
Redis costs you in-flight jobs, not data.

**One container per server, bind-mounted data.** Restartable, resource-capped,
and the files stay plain files on the host that a user can inspect, back up or
copy away without the panel.

**Plain `tar.gz` backups.** A user must be able to take their data and leave.
Lock-in through file format is not a feature.
