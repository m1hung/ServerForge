# Security

## Read this first

**The panel needs the Docker socket, and access to the Docker socket is
equivalent to root on the host.** Anyone who can create containers can mount
`/` and read or write anything.

That means:

- Anyone with an **owner** or **admin** account on this panel can, with effort,
  become root on the machine.
- The panel must never be exposed directly to the internet without TLS and,
  ideally, without something in front of it.
- Give people the lowest role that works. A friend who just needs to restart a
  server should be a **sub-user** with `server.power`, not an admin.

This is the same trust model Pterodactyl's daemon has. It is stated here
plainly rather than buried, because deploying a game panel on a box that also
holds something valuable is a decision worth making deliberately.

## What is protected, and how

### Authentication

- **Passwords** use Argon2id with 19 MiB of memory, two iterations and one lane.
  Missing usernames still perform a password verification against a decoy hash.
- **Sessions** use random 256-bit tokens. Only SHA-256 token hashes are stored.
  Cookies are HttpOnly and SameSite=Lax. Secure is controlled by the trusted
  deployment scheme and `COOKIE_SECURE`, never by unsigned browser forwarding headers. Logout deletes the stored session.
- **Suspended accounts** are rejected on every authenticated request. The host
  password-reset command revokes all sessions and invalidates pending 2FA sign-ins.
- **Stored API keys** are checked for scopes, expiry, revocation and suspension.
  API keys are a separate credential and bypass interactive two-factor sign-in.
- **Registration** creates the first owner under a database lock. Subsequent
  anonymous registrations require `registration.mode` to be explicitly `open`.
  The seeded `invite_only` policy and a missing policy both reject registration.
  Owner setup also requires the installer’s one-time token. Workspace accounts
  provides hashed, revocable, single-use invitations valid for 72 hours; fragment
  tokens are exchanged through POST. Only owners grant administrator access.

### Two-factor sign-in

For accounts already enrolled in TOTP, the API decrypts the stored AES-256-GCM
secret and verifies RFC 6238 codes, including one time step of clock drift.
Comparisons use constant-time buffers and check the whole time window.

A correct password creates a five-minute ticket instead of a session. Tickets
are single-use and expire after five failed code attempts. Suspension, password
reset and disabling two-factor invalidate pending sign-ins. The dashboard accepts
an authenticator code or recovery code in its verification form.

Accepted TOTP time steps are recorded in the database, preventing reuse across
tickets and API restarts. Recovery codes are stored as SHA-256 hashes and removed
when used. A per-account database lock prevents concurrent requests from spending
the same code twice. Preserve `ENCRYPTION_KEY` when migrating an installation.
The Account page provides enrollment/confirmation, recovery-code regeneration
and removal. Sensitive changes require the password and active second factor.
Session and API-key secrets are shown only at creation; API keys have a default
90-day expiry and explicit scope ceilings.

### Authorisation

Three panel roles (`owner`, `admin`, `user`) plus per-server sub-users with ten
granular permissions. Every server route resolves access through
`requireServerAccess(request, uid, permission)` — there is no path that reads a
server without a permission check.

Permissions come from four places: the panel role, owning the server, **access
roles** assigned on that server, and direct grants on the membership row. How
they combine is decided by one pure function, `resolveServerAccess` in
`packages/core/src/permissions.ts`, with an exhaustive test suite. Two rules,
in order:

1. **The panel owner is always allowed.** Nothing can deny them — a panel whose
   owner can be locked out of it has no way back.
2. **Otherwise a deny beats everything.** A role that denies `server.files`
   takes it away from a panel admin and from the server's own owner. That is
   the difference between `deny` and merely "not granted".

A permission left out of a role's map is **neutral**: it neither grants nor
blocks, leaving another source to decide. Neutral is expressed by absence, so
there is exactly one way to say it.

The same resolver produces the _effective_ permission list the dashboard uses
to decide which tabs to show, and filters the server list so a denied server
does not appear and then 403 when opened. A second implementation of these
rules anywhere would be a way for the UI and the API to disagree.

An API key is a **ceiling**, checked separately and first: it can narrow what
its owner may do through that key, never widen it.

Requesting a server you cannot see returns **404, not 403**, so the API cannot
be used to enumerate which servers exist.

Guard rails that keep a panel administrable: you cannot suspend your own
account, only the owner can change roles, and the last owner cannot be demoted.

### Path containment

The file manager takes paths straight from the URL, so this is the highest-
consequence code in the product. Everything funnels through
`resolveWithin(root, relative)` in `packages/core/src/paths.ts`, which handles
`..`, absolute paths, backslashes, NUL bytes, and — importantly — sibling
directories with a shared prefix (`/srv/abc` must not match `/srv/abc-evil`).

`safeExtractTarget` applies the same check per archive entry, which is what
stops zip-slip when unpacking a modpack.

Symlinks are never followed out of the server directory: the file service uses
`lstat` everywhere `stat` would be tempting, and refuses to open or edit links.

`tests/paths.test.ts` covers each vector explicitly. If you touch this file,
those tests are the specification.

### Container isolation

Every game server runs with:

- a non-root user (`1000:1000`)
- `CapDrop: ALL` and `no-new-privileges`
- configured memory and CPU limits, and a 2,048-process limit
- the configured additional swap allowance; zero disables swap, while an unset
  value preserves Docker's default
- I/O weighting only when Docker reports support (a scheduling weight, not a
  hard throughput limit)
- only its own data directory bind-mounted
- Docker stdout/stderr log rotation at 20 MiB × 3 files; game-written files
  still consume the monitored storage budget

Restart policy is `no` — the panel owns restarts. Letting Docker restart a
crashed server behind our back would desync state and hide crash loops.

If the host rejects these protections, startup fails with the Docker error;
the runtime never silently retries with weaker settings. Installation containers
also run without root, with 2 GiB RAM, two CPU cores, bounded logs and a process
limit by default. A separate, fixed-command ownership helper has only CHOWN and
DAC_OVERRIDE, no network, a read-only root filesystem, and the target data mount.
Unreadable host shares produce an actionable error; the helper cannot override
filesystem policy imposed outside the Docker VM.

The launcher does not edit host firewall rules. Access to the API's Docker socket
still makes the panel a trusted host administration tool; game-container limits
do not turn the API into an untrusted multi-tenant security boundary.

### Input handling

- Every request body is validated with Zod before it reaches a handler.
- Game settings are validated against the adapter's schema; unknown keys are
  rejected rather than silently dropped.
- Startup commands are **argv arrays, never shell strings**, so no setting can
  become a command injection.
- `LD_PRELOAD`, `PATH` and `HOME` cannot be set through the environment editor.
- File downloads are served `Content-Disposition: attachment` with
  `nosniff`, so an uploaded `.html` cannot execute against the panel's origin.

### Secrets

Bootstrap generates random `SESSION_SECRET` and `ENCRYPTION_KEY` values; keep
`.env` out of version control and preserve the encryption key in backups.
TOTP secrets use AES-256-GCM. Game configuration files and server settings can
contain plaintext game passwords, so restrict access to database and game backups.

The API omits secret settings from its configuration responses and returns
set/not-set indicators instead. Request bodies and authentication headers are
not included in normal request logging. The logger redacts secret fields and known environment secrets. Never add
credentials or full request bodies to logs; redaction is an additional safeguard.
Audit events describe changes without storing the new secret values.

### Outbound requests from user input

A schedule's webhook action lets a user name a URL that the panel requests
from inside its own network. Unguarded, that is a probe for the Docker API on localhost, a router admin page
on the LAN, or the cloud metadata service on `169.254.169.254`, which on a
hosted box hands out instance credentials.

- Only `http:` and `https:` are accepted, and never with embedded credentials.
- The hostname is resolved and **every** returned address is checked against
  private, loopback, link-local, CGNAT, multicast and reserved space — IPv6
  included, with IPv4-mapped (`::ffff:127.0.0.1`) and NAT64 addresses judged as
  the IPv4 address they carry.
- Redirects are never followed. A public host that passed the check would
  otherwise be able to bounce the request to a private one.
- The check runs again at send time, not just when the schedule is saved, since
  DNS can be repointed in between.
- Responses are never read, only their status, so a receiver cannot tie up a
  worker with a large body. Requests time out at 10 seconds.

See `apps/api/src/lib/ssrf.ts`.

### Sign-in limits and browser origins

Password sign-in and registration share a limit of ten attempts per normalized
username per fifteen minutes, plus sixty total attempts per minute. The username
limit cannot be bypassed by changing forwarded IP headers. Limits and pending
2FA tickets live in the API process and reset when it restarts; run one API
process, or introduce shared storage before using replicas. This is not a global
rate limit on authenticated game-management traffic.

Browser writes must originate from the dashboard's own origin or an exact
`CORS_ORIGINS` entry. Cross-site browser writes without an Origin header are
also rejected. The streaming dashboard proxy supports LAN, public HTTPS and
Tailscale URLs without embedding a separate API address in the browser.

The browser stays on the same-origin web proxy. It strips incoming forwarded
headers and signs the client/origin metadata with the installation secret. The
API trusts only that signed proxy path. Scheme selection is explicit through
DASHBOARD_SCHEME; spoofed forwarding headers cannot enable Secure cookies, bypass
origin checks or change client throttling. The API has no published host port
in the packaged installation. Keep the web service behind trusted infrastructure.

### Networking permissions

Network configuration and Tailscale device authorization require a panel owner
or administrator. UPnP additionally requires a server manager's explicit opt-in.
Only game and declared discovery ports can be forwarded; management ports stay
private. Existing router rules are preserved and ownership is checked before
updates or removal. Tailscale integration never enables public Funnel access.
See [networking.md](networking.md) for router and tailnet limits.

### Dependency maintenance

Run `npm audit --omit=dev` when updating runtime dependencies. The root PostCSS
and UUID overrides keep transitive dependencies on patched versions compatible
with this release; recheck those overrides during future framework upgrades.

## Deploying safely

**Put TLS in front of it.** The stack ships a `tls` profile that does this for
you — Caddy, a Let's Encrypt certificate it renews by itself, and both services
behind one hostname. Point a domain at the machine, then in `.env`:

```bash
PANEL_DOMAIN="panel.example.com"
BIND_HOST="127.0.0.1"
NEXT_PUBLIC_API_URL="auto"
CORS_ORIGINS="https://panel.example.com"
COOKIE_SECURE="true"
```

```bash
npm run stack:tls
```

`BIND_HOST` is the part people forget. Without it the dashboard and API stay
published on `0.0.0.0:3000` and `0.0.0.0:8080`, so anyone who knows the IP can
skip the certificate entirely and sign in over plain HTTP. Setting it to
`127.0.0.1` leaves Caddy as the only way in from off the machine.

`COOKIE_SECURE="true"` matters for the same reason: a session cookie without
the `Secure` flag will be sent over plain HTTP if anything ever downgrades the
connection.

See [setup.md](setup.md#https) for the full walkthrough, including
rebuilding older images that embedded a localhost API address.

**Do not expose the game port range to the internet unless you mean to.** Only
publish the ports for servers people should be able to reach.

**Change `POSTGRES_PASSWORD`** before anything is reachable. `npm run bootstrap`
warns while it is still the default.

**Keep registration invite-only** — the seeded default. Open registration on an
internet-facing panel means anyone can deploy containers on your hardware.

**Back up the database, not just the servers.** Restoring worlds without the
panel database leaves orphaned files with no rows pointing at them.

## Reporting a vulnerability

Open a private security advisory rather than a public issue.

## Known limitations

- **Game containers share the host kernel.** Docker is not a security boundary
  against a determined attacker with a kernel exploit. Do not hand out servers
  to people you have no trust relationship with.
- **No egress filtering.** A game server container can reach the internet,
  which mods legitimately need. If you run untrusted mods, put the game network
  behind a firewall policy you control.
- **Backups are not encrypted at rest.** They are plain `tar.gz` — deliberately,
  so you can open them with any tool. Encrypt the volume if that matters.

Game file reads validate the opened Linux file descriptor before reading bytes,
so a directory swapped by a running game cannot redirect a download outside its
server root. Text reads remain bounded if a file grows during reading. Run the
API in its Linux image; the descriptor check depends on Linux `/proc/self/fd`.
