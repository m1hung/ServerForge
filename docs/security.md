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

### Authorisation

Three panel roles (`owner`, `admin`, `user`) plus per-server sub-users with ten
granular permissions. Every server route resolves access through
`requireServerAccess(request, uid, permission)` — there is no path that reads a
server without a permission check.

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

### Rate limiting and CORS

Global limit of 300 requests/minute per IP, backed by Redis so it holds across
replicas. `trustProxy` is on, so limits key on the real client IP rather than
your reverse proxy's. CORS is an explicit allowlist with credentials enabled —
`CORS_ORIGINS` must list your dashboard's exact origin.

## Deploying safely

**Put TLS in front of it.** Caddy is two lines:

```
panel.example.com {
  reverse_proxy localhost:3000
}
```

```
api.example.com {
  reverse_proxy localhost:8080
}
```

Then set `NEXT_PUBLIC_API_URL=https://api.example.com` and
`CORS_ORIGINS=https://panel.example.com`.

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
