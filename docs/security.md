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

- **Passwords**: Argon2id at the OWASP 2024 interactive baseline
  (19 MiB, t=2, p=1). Never logged, never returned.
- **Sessions**: 256 bits of entropy in an httpOnly, SameSite=Lax cookie,
  `Secure` in production. Only the SHA-256 is stored, so a database dump cannot
  be replayed as a login.
- **API keys**: same storage, prefixed `sf_live_` so a leaked key is greppable.
  Shown once, scoped, revocable, optionally expiring.
- **Login throttling**: 10 attempts per username+IP per 15 minutes. Counting both
  means an attacker cannot lock a legitimate user out from elsewhere.
- **Timing**: a non-existent username is verified against a real decoy hash, so
  response time does not reveal which usernames have accounts.
- **Password change** invalidates every other session.
- **Suspension** deletes sessions immediately, not at next expiry.

### Two-factor authentication

TOTP (RFC 6238), implemented in `apps/api/src/lib/totp.ts` and pinned against
the RFC's published test vectors in `tests/totp.test.ts`.

- The secret is **AES-256-GCM encrypted at rest**, so a database dump alone does
  not let someone generate codes.
- A correct password does **not** create a session when 2FA is on. It returns a
  ticket that expires in 5 minutes, is single-use, and is destroyed after 5
  wrong codes — six digits is only a million possibilities, so the attempt
  limit is what makes the space large enough.
- A code that has been accepted **cannot be replayed** inside its validity
  window, so one observed over a shoulder or captured by a phishing page is
  already spent.
- Verification allows ±1 time step for clock drift and compares in constant
  time, with no early exit between candidate steps.
- **Recovery codes**: 10 single-use codes, stored only as SHA-256, removed as
  they are used, shown exactly once. The alphabet excludes `0/O`, `1/I/L` and
  `U/V` because these get written on paper.
- Enrolment is confirmed with a live code before anything changes, so a
  mis-scanned secret cannot lock someone out of their own panel.
- Enabling, disabling and regenerating codes all re-ask for the password: a
  stolen session should not be able to turn 2FA on to keep the real owner out,
  or off to keep itself in.

**API keys deliberately bypass 2FA.** They are a separate credential with their
own scopes and revocation, and a second factor cannot be typed by a script. If
you turn 2FA on because an account may be compromised, revoke its keys too.

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

The same resolver produces the *effective* permission list the dashboard uses
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
- `CapDrop: ALL`, and `no-new-privileges` **where the host supports it**
- hard memory, CPU, PID and block-IO limits
- `MemorySwap == Memory`, so a leaking server cannot drag the host into swap
- only its own data directory bind-mounted
- log rotation, so a spamming server cannot fill the disk

Restart policy is `no` — the panel owns restarts. Letting Docker restart a
crashed server behind our back would desync state and hide crash loops.

**About `no-new-privileges`.** On some kernel and Docker combinations, setting
this flag makes *every* exec fail with "operation not permitted", regardless of
image or user — turning a defence-in-depth measure into a total outage. The
runtime therefore probes it once at startup with a throwaway container and
applies it only where it works, logging a warning when it does not. Capability
dropping and the non-root user are unaffected and always apply.

If you see `no-new-privileges` disabled in your logs and want it back, the fix
is at the host level (kernel or Docker version), not in the panel.

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

- `SESSION_SECRET` and `ENCRYPTION_KEY` are 32-byte random values, length-
  checked at boot so a truncated paste fails at start rather than at first login.
- Stored integration secrets are AES-256-GCM encrypted.
- Logs redact cookies, authorization headers, and every known password field.
- Secret settings are never echoed back by the API; the UI shows set/not-set
  and writes a new value only if you enter one.

### Outbound requests from user input

A schedule's webhook action is the one place a user gets to name a URL that the
panel itself then requests, from inside whatever network the panel runs on.
Unguarded that is a probe for the Docker API on localhost, a router admin page
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

### Rate limiting and CORS

Global limit of 300 requests/minute per IP, backed by Redis so it holds across
replicas. `trustProxy` is on, so limits key on the real client IP rather than
your reverse proxy's. CORS is an explicit allowlist with credentials enabled —
`CORS_ORIGINS` must list your dashboard's exact origin.

## Deploying safely

**Put TLS in front of it.** The stack ships a `tls` profile that does this for
you — Caddy, a Let's Encrypt certificate it renews by itself, and both services
behind one hostname. Point a domain at the machine, then in `.env`:

```bash
PANEL_DOMAIN="panel.example.com"
BIND_HOST="127.0.0.1"
NEXT_PUBLIC_API_URL="https://panel.example.com"
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

See [setup.md](setup.md#https) for the full walkthrough, including why
`NEXT_PUBLIC_API_URL` has to be right *before* the image is built.

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
