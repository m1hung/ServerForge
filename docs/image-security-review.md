# Image security review

The candidate records image identifiers, CycloneDX SBOMs and Grype JSON reports.
An image scan is evidence about that image and vulnerability database at a point
in time. It does not establish application security or game compatibility.

The application scan command is `node scripts/scan-images.mjs`. It inspects the
API, web, maintenance, PostgreSQL and Tailscale images, exports them and runs digest-pinned Syft and
Grype containers without access to the Docker socket. The scanner verifies that
its database is valid. It fails on unreviewed high/critical findings, expired
exceptions or prohibited runtime contents.

Build/test packages and npm are excluded from application runtime images.
PostgreSQL and Tailscale retain their upstream service entrypoints and receive
distribution security updates during the versioned build.
Affected mount/namespace/infocmp command-line tools and inherited SUID/SGID bits
are removed. Exact-version exceptions live in `release/security-exceptions.json`;
they expire on 2026-10-14 and require renewed review after relevant code or base
changes. They retain the finding in reports rather than suppressing the scanner.

| Reported source-package issue | Review basis |
| --- | --- |
| ncurses CVE-2025-69720 | Affected `infocmp` executable removed; retained libraries do not expose that CLI path. |
| Perl CVE-2026-9538 | Application archive operations use npm tar, not Perl Archive::Tar. |
| glibc CVE-2026-5435 | Deprecated DNS debug printers are outside the application's DNS/database call paths. |
| glibc CVE-2026-19499 | Temporary stable-OS risk acceptance: Debian marks the monetary-format padding overflow minor/no-DSA with no known network-facing impact. Shipped Node, Prisma, PostgreSQL and backup client binaries have no direct `strfmon`/`strfmon_l` imports; ServerForge exposes no native monetary-format interface. This does not establish safety of arbitrary extensions or dynamically loaded native code. |
| zlib CVE-2026-85091 | Trigger uses a nonblocking gz file-printing sequence; application gzip streams and normal PostgreSQL archives do not use it. |
| util-linux CVE-2026-76642, 78409, 78408, 78410 | Affected mount/nsenter helpers and SUID/SGID privileges are removed; the application does not configure fstab hooks. |
| libacl CVE-2026-54369, 54370 | No application ACL pathname operations; affected ACL executables are absent. |
| PostgreSQL libxml2 CVE-2026-6653, 74860, 86140 | No XML columns, XML queries, DTD validation or Python SAX bindings in the ServerForge workload; PostgreSQL is private. Does not cover arbitrary database workloads. |
| Tailscale GO-2026-6355, 6303, 6354 | Vulnerable SSH module remains linked, but `TS_DISABLE_SSH_SERVER=true` prevents SSH startup/re-enablement in the packaged dashboard sidecar. No SSH client is invoked. |

Each entry includes its exact Debian tracker URL, package versions, rationale,
review date and expiry. These are scoped reachability assessments, not claims
that the underlying distribution packages are patched. They do not excuse a
reachable application issue or apply automatically to another image.

The development dependency audit is separate (`npm audit --audit-level=high`).
Each candidate architecture includes all five image reports. Third-party game
runtime images require separate scan evidence; application reports do not cover
them. Local scans of Java 17, Java 21 and SteamCMD Ubuntu 24 found no high/critical
findings at the recorded date. Other versions need their own scans.

The PostgreSQL libxml2 critical finding is still visible in the report and is
reviewed only for the committed application's non-XML workload. Tailscale SSH
disablement was verified by attempting to enable it in an isolated userspace
daemon; it refused with “SSH server administratively disabled.” The image and
entrypoint both set the disable flag. These exceptions do not apply to host
Tailscale, arbitrary PostgreSQL queries, or modified service configurations.
See the exact advisory links in the exception ledger.

A separate application security review and final platform qualification remain
release gates. Reviewed scanner findings alone do not establish release readiness.

The 2026-09-15 Bedrock checkpoint includes the CVE-2026-19499 symbol inspection
at `data/panel-checkpoints/20260915-bedrock/cve-review/symbols.json` and the
unmodified scanner findings. Its exact-version exception expires on 2026-10-14.
[Debian's advisory](https://security-tracker.debian.org/tracker/CVE-2026-19499)
lists no fixed trixie package at review time. Upgrade to a stable fix when
available; do not switch the production image to Debian unstable for this issue.

## RC2 review — 2026-09-16

The failed main check's five additional PostgreSQL libxml2 findings were reproduced
on the supported stable image. [The RC2 review](security-review-rc2.md) records
individual advisories, the exact vulnerable package, available upstream fixes and
the non-XML workload assessment. Five separate PostgreSQL-only exceptions expire
on 2026-10-14; existing exceptions were not broadened or extended. The library is
still vulnerable and findings remain visible. Both candidate architectures must
pass fresh scans before external testing is approved.
