# Network and remote access

Use **Network & access** in the sidebar for workspace configuration, then
**Share** on a server for player connection details. Local and public IPs,
custom hostnames, and host Tailscale addresses are separate choices.

## Choose the right address

| Connection              | Who can use it                               | What it needs                                                                              |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Local network           | Players on your Wi-Fi or wired LAN           | The host's LAN address and game ports allowed through its firewall                         |
| Public internet         | Players outside your network                 | A public IPv4 address or hostname, router forwarding, and host firewall access             |
| Tailscale game address  | Players with tailnet access to the game host | Tailscale installed on the host and access rules allowing the game ports                   |
| Tailscale dashboard URL | Your devices with tailnet access             | A reachable host Tailscale IP or private HTTPS Serve, plus your normal ServerForge sign-in |

**Copy invite** includes the server name, game/version, address, and connection
instructions. A QR code contains the join address only. Copy also works on a
plain HTTP LAN dashboard. Addresses do not include passwords or session tokens.

The dedicated Tailscale dashboard container proxies **dashboard traffic only**.
Its IP is not advertised as a game address. Use the host's Tailscale connection
for Minecraft TCP, Valheim/Palworld UDP, and other game traffic.

## Host discovery

For packaged installations, refresh the host snapshot after a network change:

```bash
./serverforge network --lan-address 192.168.1.20
```

Use the host's actual LAN address. The launcher reads host Tailscale status and
existing Serve handlers and writes a restricted snapshot under
`HOST_DATA_ROOT/.network/host.json`. It does not store peer lists or login keys.
This is a snapshot, not a background host daemon. Source development also has
`npm run network:setup` for automatic LAN/router discovery.

The API refreshes public IP/router status at most once per minute while it is
being requested. **Check connections** forces a refresh. If the router cannot
supply a public IPv4, the API asks `api.ipify.org` for the connection's public IP.
A custom public hostname remains usable when IP discovery is unavailable.

Docker bridge addresses are not used as the host LAN address. If SSDP discovery
is unavailable, enter **Local host IP** and **Router UPnP URL** in Network & access.
The router URL accepts a device description XML URL or a WAN control endpoint
using a literal private LAN IPv4 address. Redirects, public hosts, loopback,
XML entities, and oversized responses are rejected.

Reserve your host's LAN IP in the router's DHCP settings so manual router rules
and saved addresses remain valid after a reboot.

## Automatic UPnP forwarding

Both permissions are required:

1. A workspace administrator enables **Automatic port forwarding** in Network & access.
2. A server manager enables **Automatic public access** in that server's Share panel.

All existing and newly created servers default to automatic public access off.
Enabling the workspace switch alone never exposes a game. Rules are only
requested for running containers bound to the host LAN interface or `0.0.0.0`.

The worker checks every minute and on server lifecycle events. It journals each
intended mapping before opening it, verifies the router's response, renews it
before expiry, and removes owned mappings after stop, crash, deletion, or opt-out.
Rules survive an API restart through the database journal; rules lost during a
router reboot are recreated. Temporary router failures retain pending cleanup
and do not discard ownership records.

Only mappings with the exact ServerForge ownership description, host address,
and internal port are changed or deleted. A rule owned by another application
is shown as a conflict. Failed ownership queries never mean a port is free.
Routers limited to permanent leases are supported; the effective lease is
recorded and those rules are still explicitly removed when no longer needed.

The default lease is one hour. Stopping the API does not stop running games or
remove their mappings; finite leases can expire if the API remains down. A
permanent lease survives until the router or ServerForge removes it. Run one
API worker per router journal; distributed API replicas are not supported.

### Game and discovery ports

The Share panel lists the exact ports and protocols for that server:

- Minecraft exposes its game TCP port. RCON is never forwarded.
- Valheim exposes game and discovery UDP ports, with discovery at game port + 1.
- Palworld exposes game and declared discovery UDP ports. Its REST management
  endpoint stays private.
- Custom adapters can explicitly mark a query/discovery port `public: true`.
  Only `game` and `query` purposes qualify; the flag cannot expose RCON, REST,
  or another administrative purpose.

New servers reserve a contiguous block atomically. **Share → Change game port**
can move a stopped server to another available block in its node's allocation
pool. The server's game files are rewritten on next launch; share the new join
address with players. A running server cannot have its ports changed underneath it.

## Manual public forwarding

Automatic UPnP is optional. In your router, forward the exact game/discovery
ports listed in Share, with the correct TCP/UDP protocol, to the host LAN IP.
Allow those same ports through the host firewall. Do not forward the entire
allocation range or the dashboard/API ports for game access.

Manually created rules belong to the router administrator and are not removed
by ServerForge. You can share a public address while automatic access is off.
An active UPnP rule verifies router configuration, **not end-to-end internet
reachability**; test from a different network or have a friend connect.
Some routers do not support using their public IP from inside the LAN; use the
local address when you are at home.

A private/shared router WAN address indicates an upstream router or carrier-grade
NAT. UPnP only controls your immediate router. Ask your ISP for public IPv4,
configure the upstream router you control, or use host Tailscale for private
play. A public hostname does not remove NAT restrictions. This page accepts a
custom hostname but does not run a dynamic DNS updater.

## Tailscale dashboard access

### Existing host connection

If host discovery finds Tailscale running, ServerForge prefers that connection.
When the dashboard is reachable at `http://<host-tailscale-ip>:<WEB_PORT>`, it
shows that verified link immediately. Traffic travels through the encrypted
tailnet. No sudo command or second Tailscale login is needed for this path. Installations
configured to require Secure cookies only offer HTTPS dashboard links.

To add HTTPS, inspect `tailscale serve status` on the host first. The packaged
`./serverforge network` command prints the appropriate Serve target using the
installation's existing port. Configure that target only when it does not replace
another application's handler; preserve unrelated handlers and do not enable
public Funnel. Tailscale may require HTTPS setup or host permissions and will
print the relevant instruction. After the URL is verified, run
`./serverforge access https` to require Secure account cookies.

Open **Check connections** after setup. The page only offers a host dashboard link after a request to its setup endpoint succeeds.
HTTPS is preferred when verified; direct tailnet IP access is the fallback. Sign in to
Tailscale on your other device, open the displayed HTTPS URL, and sign in to
ServerForge normally. Tailnet ACLs/grants and device availability still apply.

If a bare `machine.tailnet.ts.net` hostname refuses the connection, HTTPS Serve
may not be enabled yet. Until it is, use the full dashboard link, including
`http://` and `:<WEB_PORT>`. After enabling Serve on the host, **Check connections**
probes the HTTPS hostname again, even if host discovery was last run before setup.

### Dedicated dashboard device

First run `./serverforge access sidecar` for a packaged installation. Choose
**Advanced connection settings → Tailscale connection → Dedicated dashboard
device**, then save:

1. Select **Connect Tailscale**, then **Authorize device** in your browser.
2. Enable MagicDNS and HTTPS certificates in your Tailscale DNS settings if needed.
3. Select **Check connections**, then **Enable dashboard access**.
4. Copy the private dashboard link to your other device.

Browser login needs no auth key. The sidecar daemon stays alive while authorization
is pending, with persistent state in the `tailscale-state` volume. For unattended
setup, the existing `TS_AUTHKEY` environment option remains supported. Never
commit an auth key or delete the identity volume just to restart the app.

The API manages this dedicated daemon over a shared Unix socket, using fixed
LocalAPI operations. Serve updates preserve other handlers and use ETag checks
to avoid overwriting concurrent configuration. The panel never enables Funnel.
**Disable remote dashboard** removes only its own Serve handler.

The underlying behavior is documented in the official [Tailscale Serve guide](https://tailscale.com/docs/features/tailscale-serve)
and [Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Access and troubleshooting

- Workspace network configuration and device authorization are limited to owners
  and admins. Scoped API keys need `*` for these panel-wide operations.
- Server sharing requires `server.view`; changing automatic public access or ports
  requires both `server.settings` and `server.power`. Shared responses omit router
  control URLs, login links, and other servers' mappings.
- Local HTTP and remote HTTPS use the dashboard's same-origin streaming API proxy.
  No separate API port is required in a browser. If upgrading an older install,
  run bootstrap and rebuild the web image to migrate its localhost API URL. HTTPS sessions receive Secure,
  HttpOnly, SameSite cookies; cross-origin writes are rejected and logout revokes
  the saved session.
- If the page reports no router, check router UPnP settings and run host discovery.
  A router that rejects forwarding from a bridged container may require manual rules.
- If Tailscale is connected but the dashboard is unreachable, check Serve,
  HTTPS/MagicDNS, tailnet access rules, and whether the web container is healthy.
- If a modded game is reachable but clients cannot join, match the server's game,
  loader, modpack, and mod versions. Port forwarding cannot resolve mod incompatibility.
