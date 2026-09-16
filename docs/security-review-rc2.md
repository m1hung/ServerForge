# RC2 security review and independent-review handoff

Review date: 2026-09-16. Scope: the source commit identified by the RC2 bundle
manifest, its five packaged images on both architectures, and the single-host
installation described in `security.md`. This is an author-run code review and
regression exercise, not an independent assessment or a claim of production approval.
The final validation receipts accompany the private candidate; this document does
not predeclare their results.

## Threat model

Protect game worlds, account credentials, encryption material and the host from
anonymous browsers, ordinary workspace users, malicious game downloads, archives,
router responses and spoofed proxy headers. Owners/admins and the host operator
are trusted administrators: Docker access is equivalent to host root. Arbitrary
mods and owner-selected game executables are trusted code within that boundary.
An ordinary member with console/file permissions receives only those game-level
permissions, not workspace administration. The API and PostgreSQL have no published
ports in the packaged deployment. The web proxy authenticates forwarded metadata.

## Application review

| Surface | Review and regression evidence |
| --- | --- |
| Owner setup and passwords | One-time setup-token hash, serialized first-owner creation, Argon2id and missing-user decoy, invitation-only default; `auth-hardening`, `accounts.integration`. |
| Invitations and roles | Hashed fragment token, POST exchange, expiry/revocation, concurrent single use, owner-only admin grants and last-owner preservation; `accounts.integration`. |
| TOTP and recovery codes | Encrypted secret, confirmation, accepted-counter replay protection, transaction-locked recovery-code consumption, sensitive-change password/second-factor proof; `totp`, `accounts.integration`. |
| Sessions and API keys | Token hashes, suspension on each request, expiry/scope checks, account operations restricted to sessions, explicit revocation; `accounts.integration`, `network-auth`. Console streams rotate after at most 60 seconds to recheck session access. |
| Server and host permissions | Shared permission resolver and per-route permissions, admin-only server creation/network/node controls, internal maintenance HMAC separate from account keys; `permissions`, `management`, `accounts.integration`. |
| Proxy headers and CSRF | Only authenticated same-origin proxy metadata is trusted; unsigned forwarding values cannot select cookie security or bypass origin checks; `api-proxy`, `network-auth`. |
| Outbound requests | Public-address validation and DNS pinning for downloads, redirect revalidation, credential stripping across origins; router discovery is a separate opt-in local-network path; `webhooks`, `igd`, `install-tools`. |
| Files, archives and uploads | Path bounds, no-follow reads, bounded upload/expansion, archive traversal/link rejection and atomic replacement; `archive-paths`, `server-file-race`, `server-pack-upload`, `mod-files`, `modpacks`. |
| Install and runtime execution | Non-root game/installer, capability drop, no-new-privileges, resource limits, narrowly scoped ownership helper; `runtime-protection`, `docker-runtime.integration`, `lifecycle.integration`. |
| Recovery and secrets | Private bundle permissions, checksummed/versioned manifests, verified backup before upgrade, restored sessions/keys revoked, encryption key preserved, external exposure disabled; `recovery.integration`, packaged/world recovery drills. Diagnostic redaction excludes raw backups and account secrets. |
| Candidate/evidence integrity | Committed source snapshot, occupied-output refusal, source/image/archive/checksum validation, candidate-bound allowlisted export and planted-secret checks; `candidate-source`, `candidate-verification`, `qualification-report`. |

Confirmed finding **SF-RC2-01 (medium, fixed)**: file mutations checked a server
state loaded before acquiring the operation lock. A start completed between the
lookup and lock acquisition could permit a write beside a running game. A stale
`crashed` database state could also hide a running container. The shared stopped
check now rechecks permissions and database state inside the lock and queries the
container's actual running state. Reproduction covers both cases and verifies no
directory is created. Text writes, uploads, mkdir, rename and extraction share the
fix (`tests/management.test.ts`). No critical/high application defect was confirmed
in this scoped author review; independent review remains pending.

The soak console reader also now uses the qualifier's existing abort-on-exit
pattern for endless streams, so iterator cancellation cannot wait for the stream
rotation deadline after a successful command response.

## Five PostgreSQL findings from the failed main check

The failure was reproduced with a fresh supported PostgreSQL 17-trixie build.
All five are **High** findings in `libxml2` version
`2.12.7+dfsg+really2.9.14-2.1+deb13u3`. PostgreSQL reports 17.11 and links
`libxml2.so.2`. The library cannot simply be removed from that upstream binary.
At review time Debian trixie has no fixed package; the tracker lists a fix in
forky/sid at `2.15.4+dfsg-1`. Using unstable libraries is not a supported repair.

| Advisory | Affected behavior and applicability |
| --- | --- |
| [CVE-2026-86138](https://security-tracker.debian.org/tracker/CVE-2026-86138) | Integer overflow in XML dictionary construction (`xmlDictAddQString`). |
| [CVE-2026-86139](https://security-tracker.debian.org/tracker/CVE-2026-86139) | Integer overflow in libxml2 URI escaping (`xmlURIEscapeStr`). |
| [CVE-2026-86142](https://security-tracker.debian.org/tracker/CVE-2026-86142) | XPointer expression length/heap overflow. |
| [CVE-2026-86143](https://security-tracker.debian.org/tracker/CVE-2026-86143) | Invalid negative output-callback length during XML serialization. |
| [CVE-2026-86144](https://security-tracker.debian.org/tracker/CVE-2026-86144) | XInclude parse flags not propagated; possible network restriction bypass. |

The committed PostgreSQL workload has no XML columns, XML/XPath/XPointer queries,
DTD validation, XInclude resource loader, or arbitrary-SQL endpoint. Prisma and
backup/restore use relational data and PostgreSQL custom-format archives. UPnP XML
is parsed separately in JavaScript, with DTD/entity rejection; it is not passed to
PostgreSQL/libxml2. This supports a workload-specific reachability assessment,
not a claim that libxml2 is patched. Each issue has its own PostgreSQL-only,
exact-version exception, reviewed 2026-09-16 and expiring 2026-10-14. New XML
features, extensions, direct database workloads or base changes require a new
review. Install a supported stable fix when available.

Existing exceptions were reassessed against their original exact package/image
scope and the RC2 runtime: removed mount/namespace/infocmp executables and SUID
bits remain removed; no Perl archive or monetary-format API was introduced;
PostgreSQL retains the non-XML workload; the packaged Tailscale sidecar retains
SSH disablement. No existing exception was broadened or given a later expiry.
See `image-security-review.md` and the complete exact-version ledger shipped in
`security/reviewed-findings.json`. Current scans must validate all five images
on each architecture; reviewed vulnerabilities remain visible in those reports.

## Independent reviewer exercise

1. Verify the bundle checksums and image/source identifiers. Work only in a new
   marked qualification installation, following `qualification.md`.
2. Reproduce the file-state race regression and ordinary-user administration
   denial tests. Review permissions with two users on separate servers, including
   files, archives, console streams, backups, configuration and API keys.
3. Attempt invitation replay/concurrent acceptance, TOTP/recovery-code reuse,
   suspended/revoked-session access, API-key privilege escalation, cross-origin
   writes and forged forwarding metadata.
4. Review arbitrary-download redirects, archive links/traversal and install
   scripts. Confirm the owner/Docker administration boundary is acceptable for
   the intended deployment; do not treat mods as untrusted sandboxed workloads.
5. Perform the fresh-host recovery exercise and inspect secret handling locally.
   Submit only the redacted qualification export and a findings report containing
   severity, reproduction, affected source/image ID and proposed resolution.

Open questions: independently confirm the image reachability assessments,
console revocation timing, native-library exposure, recovery redaction, browser
accessibility and behavior on each external platform. External client joins and
actual mod effects remain a separate qualification item. Unavailable independent
results are pending, not passed.
