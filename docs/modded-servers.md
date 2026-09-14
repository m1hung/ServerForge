# Modded servers

Choose a mod-enabled **Game edition** when deploying, then open the server’s
**Mods & plugins** view. Stop the server, upload the mod files and their required
dependencies, and start it again. Enable/disable preserves the file by adding or
removing `.disabled`; uploads never overwrite an existing file. Each upload is
limited to 256 MiB. The server owner or a member with `server.mods` permission can
manage mods.

| Game / edition                      | Support                                                                                   | Managed folder           |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------ |
| Minecraft Paper / Purpur            | Bukkit-compatible plugin JARs                                                             | `plugins`                |
| Minecraft Fabric / Forge / NeoForge | Mod JARs matching the loader and Minecraft version                                        | `mods`                   |
| Minecraft Modrinth modpack          | Modrinth project link or ID; optional pack version                                        | `mods`                   |
| Minecraft custom modpack            | Uploaded server-pack ZIP or public HTTPS download; loader and Java resolved from the pack | `mods`                   |
| Valheim + BepInEx                   | BepInExPack Valheim 5.4.2350 is installed; upload compatible plugin DLLs                  | `BepInEx/plugins`        |
| Palworld + PAK mods                 | PAK mods specifically compatible with the Linux dedicated server                          | `Pal/Content/Paks/~mods` |

Vanilla editions keep mods disabled. Minecraft deployment requires EULA acceptance.
For individual Minecraft mods, enter the version required by your mods instead of
`latest`. For packs, the pack supplies the game version and loader. A custom pack
must contain server files, not just a client export. Uploads and downloads are limited to 2 GiB;
ZIP extraction is limited to 8 GiB and 50,000 entries, and rejects links and paths
outside the server directory. Publisher checksums are verified when supplied.

For a CurseForge server pack, choose **Minecraft Java → Modpack from a .zip**,
leave **Server pack source** on **Upload a ZIP file**, and select the downloaded
Server Pack ZIP. Set the hardware and game options, accept the Minecraft EULA,
then choose **Create server**. Keep the page open while it uploads. Installation
continues on the server page, where the console shows progress. Start it when
installation finishes. The existing **Use a download link** option also remains
available. CurseForge client/profile exports containing only `manifest.json`
and overrides are not server packs; use the modpack’s Server Pack download.

Valheim’s pinned loader comes from the maintainer’s
[BepInExPack Valheim release](https://thunderstore.io/c/valheim/p/denikson/BepInExPack_Valheim/).
The panel launches the Linux server with Doorstop enabled and the selected world,
port and password. Check plugin and loader compatibility after game updates.
Existing servers created by the old folder-only installer need the loader installed
by their operator or a fresh deployment of the BepInEx edition.

Palworld’s [official server mod support currently requires Windows](https://docs.palworldgame.com/settings-and-operation/mod/).
This panel runs Linux containers: it does not install UE4SS, run Windows DLL/Lua mods,
or manage Steam Workshop server packages. Use only PAK mods whose authors explicitly
support Linux dedicated servers. A PAK can still require client installation or
additional files; follow its author’s instructions. Multi-file bundles, mod-specific
configuration, and loader updates currently require operator access to the server
files. Uploading a file does not resolve dependencies or prove compatibility.

Install work requires Docker on the API host. SteamCMD and Java installers run in
temporary containers, and the installed files persist in the server directory.

Verification for this change: automated mod-file, API authorization, ZIP safety,
adapter and existing regression tests; live download/checksum/extraction of the
BepInEx pack; desktop/mobile UI checks against isolated preview data. Full game
boots require a Docker-enabled environment and were not run here.
