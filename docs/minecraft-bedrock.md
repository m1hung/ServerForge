# Minecraft: Bedrock Edition

Choose **Deploy a server → Minecraft: Bedrock Edition → Bedrock Dedicated Server**.
Accept the Minecraft EULA, choose the current stable build, configure the world
and allocation, and deploy. This installs Mojang's official Linux server in the
existing protected Ubuntu 24 container runtime. It uses no Java installation.

The `latest` option reads the official download feed. Installs keep the exact
selected build; `latest` is resolved before installation. Mojang may withdraw old
ZIPs, so reinstalling an old build is not guaranteed. Keep a recovery backup.
The download uses Mojang's HTTPS endpoint with the panel's redirect, address,
archive and size checks. Mojang's feed does not provide a publisher checksum.

## Join and administer

- In **Connections**, copy the address and the **UDP game port**. Enter them
  separately in a Bedrock client's Add Server form. Use the assigned port, which
  may differ from Bedrock's usual 19132. Clients must use a compatible Bedrock
  version. Java clients and Java worlds are separate.
- **Invite-only game** defaults on. In Players, add a gamertag to the allowlist,
  or use `allowlist add "Alex Bedrock"` in Console. Dashboard invitations grant
  panel access; they do not grant permission to join the game.
- The console includes a Bedrock command cheat sheet. Commands such as `list`,
  `op`, `deop`, `kick`, and `stop` work through the native console. There is no
  Bedrock RCON endpoint and no Java `ban`/`whitelist`/`save-all` command mapping.
- Settings, CPU/memory allocation, live telemetry, player observations, schedules,
  game backups, staged updates and restore use the same controls as other games.
  Player observations begin when the panel connects to the log stream.

UPnP remains opt-in and maps only the allocated UDP game port. A dashboard
Tailscale sidecar does not tunnel game traffic: use a reachable host tailnet
address and the UDP port with appropriate ACLs. Public/LAN access still depends
on the host firewall and router. This adapter publishes IPv4 game traffic;
native IPv6 game exposure is not configured. The internal IPv6 port stays inside
the container. Bedrock's LAN visibility flag stays enabled because build 1.26.45.1
otherwise omits server information from direct UDP discovery replies. Docker
publishes only the assigned port; its additional default-port listeners remain
inside the bridge container. Automatic LAN broadcast discovery across Docker is
not promised; connect by address and port. Some console editions restrict adding
custom servers; no console-specific network workaround is installed.

## Worlds and add-ons

Bedrock saves worlds in `worlds/<World folder>/` using its own world format.
Back up and stop the server before importing or changing a world. Upload a ZIP
through **Files**, unpack it, and set World folder to the imported directory's
name. A Bedrock world needs its `level.dat` and `db/` contents together.

Native behavior packs belong in `behavior_packs/<pack>/` and resource packs in
`resource_packs/<pack>/`, with each pack's `manifest.json` at that directory's
root. Files can unpack ZIP archives; rename a ZIP-format `.mcpack` to `.zip`
before uploading. Attach the pack UUIDs and versions to the world's
`world_behavior_packs.json` and `world_resource_packs.json` as appropriate, then
restart and inspect the console. Packs may require matching experimental world
settings or scripting APIs. Automatic pack dependency resolution/import is not
provided. Java JAR plugins, Forge/Fabric mods and CurseForge Java server packs
cannot run on this server.

Updates preserve every world, allowlist, permissions, configuration and separately
named custom pack, including changes made after preparation. A recorded inventory
distinguishes Mojang's bundled packs so they update with the executable. Do not
edit or store your content in Mojang's built-in pack directories: those are
replaced during updates. The pre-update backup contains the old distribution and
worlds; restore that backup to roll back a world and server together.

## Platforms and qualification

The official Linux binary targets x86-64 and runs here on Ubuntu 24. Linux
containers on WSL2 and Intel Macs use the same adapter but need host qualification.
There is no native ARM64 Bedrock server in this integration. On Apple Silicon,
x86-64 emulation is explicitly experimental and requires opt-in; selecting a
native ARM64 runtime is rejected.

The isolated tester bundle accepts `serverforge qualify --cases bedrock --minutes 30` (see
the launcher's help for flags). Startup, console and telemetry evidence does not
qualify remote client joins, third-party add-ons, another host platform or a
four-hour soak. Record exact build and host versions for those tests.

References: [official download](https://www.minecraft.net/en-us/download/server/bedrock),
[server settings](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/server-properties),
[Bedrock server setup](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/getting-started).
