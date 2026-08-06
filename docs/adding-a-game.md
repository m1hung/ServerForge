# Adding a game

One file, one line in the registry. Nothing in the API, the workers or the
dashboard needs to change.

There are two ways to write that file, and **most games should use the first**:

| | When to use it | What you write |
|---|---|---|
| **Manifest** | The server installs from Steam (or one zip), is configured by a file or its command line, and prints something recognisable when ready | Data — no code |
| **Coded adapter** | The game needs real logic: resolving versions against a publisher's API, unpacking modpacks, anything conditional | TypeScript implementing `GameAdapter` |

A manifest is compiled into a `GameAdapter`, so nothing downstream can tell the
difference — and a manifest that outgrows the format can be rewritten as a
coded adapter later without touching anything else.

Valheim and Palworld are manifests
([`manifest/games/`](../packages/adapters/src/manifest/games/)). Palworld is
the one to read if your game is at all involved — it covers Unreal tuple
config, ports written into that config, a seeded default file, and a setting
only one variant has.

Minecraft is code, because resolving Paper/Fabric/Forge builds and importing
modpacks is a program, not a table.

---

## Where manifests live

Two places, same format:

**`data/games/*.json`** — added by whoever runs the panel. Drop a file in,
restart, and the game is in the deploy wizard. No rebuild and no TypeScript.
This is the path for a game you want on *your* panel. Created by
`npm run bootstrap`, and mounted into the API container by the compose stack.

**`packages/adapters/src/manifest/games/*.ts`** — shipped with the panel, and
what you write to contribute a game upstream. TypeScript rather than JSON so
the compiler checks it as you write; the shape is identical, and
`tests/manifest-loader.test.ts` asserts a built-in manifest survives the trip
through JSON so the two cannot drift.

A few rules for the directory:

- **`id` must not match a game the panel ships with.** It is what servers are
  stored against, so it has to be unique — and a manifest silently shadowing a
  built-in would look like the panel losing a game. Loading refuses instead.
- **Manifests are read once, at startup.** Restart after editing.
- **A bad file is skipped, not fatal.** Refusing to boot over one typo would
  take management of every running server with it. The API log names the file
  and every problem in it; the game is simply absent from the wizard.

## Writing a manifest

Create `packages/adapters/src/manifest/games/<game>.ts` (or a `.json` file in
`data/games/` with the same fields):

```ts
import type { GameManifest } from '../types.js';

export const exampleManifest: GameManifest = {
  manifestVersion: 1,
  id: 'example',
  name: 'Example',
  summary: 'One sentence for the game picker.',
  icon: 'Gamepad2',                        // any lucide-react icon name

  limits: { memoryMib: 4096, cpuCores: 2, diskMib: 10240 },
  variants: [{ id: 'example-vanilla', name: 'Example', summary: '…', order: 1,
               recommended: true, supportsMods: false }],
  ports: [{ purpose: 'game', protocol: 'udp' }],

  settings: [ /* the same schema described under settingsSchema below */ ],

  install: { kind: 'steam', appId: '896660' },

  runtime: {
    image: 'steamcmd/steamcmd:ubuntu-24',
    workingDir: '/home/container',
    command: ['./start_server.sh', '-port', '{{port.game}}'],
    ports: [{ containerPort: 2456, purpose: 'game', protocol: 'udp' }],
    stopTimeoutSeconds: 60,
    readyPattern: 'Game server connected',
  },
};
```

Register it in `registry.ts`:

```ts
const ADAPTERS: GameAdapter[] = [/* … */, compileManifest(exampleManifest)];
```

### Templates

Strings in `command`, `env`, `install.url` and `writeFile.contents` may
reference values:

| Token | Resolves to |
|---|---|
| `{{setting.KEY}}` | A value from `settings` |
| `{{port.PURPOSE}}` | The allocated host port for that purpose |
| `{{env.NAME}}` | An environment variable on the server |
| `{{serverName}}` `{{serverUid}}` `{{version}}` `{{variantId}}` | Server facts |
| `{{memoryMib}}` `{{cpuCores}}` `{{dataPath}}` | Resource limits and paths |

Add `|number` to render a checkbox as `1`/`0`, which is what command lines
almost always want — `|lower`, `|upper` and `|json` are also available.

This is not an expression language, and should not become one. Anything
conditional is expressed structurally:

```ts
// Omitted entirely when the field is empty. Passing `-password ""` is not the
// same as leaving it out, and several games treat it as a real password.
{ when: { ref: 'setting.Password', isSet: true },
  args: ['-password', '{{setting.Password}}'] }
```

`when` also takes `equals: [...]` to match specific values, and `isSet: false`
for the inverse. An empty string and an unticked checkbox both count as unset.

### Settings need no code to be written out

Each setting's `target` says where its value belongs, and the panel writes it
there — reading the existing file, overwriting only the keys you model, and
writing it back, so anything a game update adds to its own config survives.
There is no `applySettings` to write.

Use `{ kind: 'internal' }` for values your `command` template reads instead.

**Unreal games** put dozens of settings inside one parenthesised INI value:

```ini
OptionSettings=(Difficulty=None,ExpRate=1.000000,ServerName="My server")
```

Name the outer key with `tuple` and `key` becomes the field inside it:

```ts
target: { kind: 'ini', file: CONFIG, section: SECTION,
          key: 'ExpRate', tuple: 'OptionSettings' }
```

Values are then formatted the way Unreal insists on — strings quoted, booleans
as `True`/`False`, and numbers as floats to six places when the setting
declares a `step`, integers when it does not. Fields you do not model are
round-tripped untouched.

### Values the user does not choose

Ports are the case that matters. The allocator decides them, and a game whose
own config still names its default port comes up listening where nothing is
published — online to the panel, unreachable to every player.

```ts
configValues: [
  { target: { kind: 'ini', file: CONFIG, section: SECTION,
              key: 'PublicPort', tuple: 'OptionSettings' },
    value: '{{port.game}}' },
]
```

These are written after the settings, so a computed port beats a stale one
somebody typed into a config by hand.

### Variant-only settings

A "install the mod loader" toggle is meaningless on the vanilla edition, so it
belongs to the variant rather than the game:

```ts
variants: [
  { id: 'example-modded', /* … */ settings: [ /* … */ ] },
]
```

They are prepended to the game's own settings — what makes the variant
different is what someone who deliberately chose it came to configure.

### Install steps

`install` is `{ kind: 'steam', appId }` or `{ kind: 'download', url, strip }`.
Steam games get the branch/beta settings automatically — set
`branchSettings: false` to opt out.

`postInstall` runs afterwards. Steps do `mkdir`, `writeFile` or `copyFile`, and
can be limited to certain variants, to a settings value, or both:

```ts
postInstall: [
  // Many games write their config on first boot and run on built-in defaults
  // until then — so without this, the choices someone made in the wizard would
  // apply to their *second* world. `ifMissing` defaults to true, because
  // overwriting on every reinstall would discard hand edits.
  { copyFile: { from: 'DefaultSettings.ini', to: CONFIG } },

  { variants: ['example-modded'],
    when: { ref: 'setting.sf_enable_loader', isSet: true },
    mkdir: 'plugins',
    message: 'Setting up the plugins folder…' },
]
```

### Entrypoints

`command` is the argv to run — but Docker prepends the image's `ENTRYPOINT` to
it, and for some images that entrypoint is a *tool* rather than a launcher.
The SteamCMD image is the case in point: it is used for Steam games because it
carries the right runtime libraries, but its entrypoint is steamcmd, so the
command arrives as arguments to steamcmd and the game never starts.

```ts
runtime: {
  entrypoint: [],   // clears the image's own
  command: ['./start_server.sh', '-port', '{{port.game}}'],
}
```

Leave it unset otherwise. Some images do real work in their entrypoint before
exec'ing the command — eclipse-temurin installs CA certificates there, and
clearing it would quietly break Java's TLS.

### Typed commands

By default a command typed in the panel console is written to the game's
stdin. Plenty of games never read it — their console is RCON or nothing, and
without this the panel can stream their log but not command the server.

```ts
runtime: {
  // …
  console: {
    transport: 'rcon',
    portPurpose: 'rcon',            // must be one of `ports`
    passwordSetting: 'rcon.password',
    enabledSetting: 'enable-rcon',  // optional
  },
}
```

RCON also returns what the command printed, which stdin cannot, so the reply
is written back into the console.

It degrades rather than fails: with no password set — or the enabling setting
off — the panel falls back to stdin, so a game that supports both keeps
working before RCON is configured. Minecraft is set up this way, which is why
`list` starts answering in the panel once you turn RCON on.

Reaching the port is handled for you in both deployment shapes. A panel
running on the host dials the published port on loopback; one running in a
container joins the game network at startup and dials the container by name,
because published ports are not routable between containers.

### Log rules

Ordered; first match wins, so put specific rules above catch-alls. Patterns are
matched case-insensitively.

```ts
logRules: [
  { pattern: 'Done \\(', level: 'success', ready: true,
    hint: 'Server is accepting players.' },
  { pattern: '(\\w+) joined the game', level: 'info',
    playerEvent: { type: 'join', nameGroup: 1 } },
]
```

`reportsPlayers` is derived from whether any rule actually produces a
`playerEvent`, so the claim cannot drift from the behaviour. A rule that
matches but captures an empty name falls through to the next rule rather than
reporting a nameless player.

### Validation

Manifests are validated when they load, not when a field is first used — a typo
in a settings key should fail at startup, not three minutes into an install.
`validateManifest` catches references to settings and ports that do not exist,
unknown filters, invalid regular expressions, and player rules whose capture
group is missing.

---

## Writing a coded adapter

Only when the format genuinely does not fit.

## The contract

Create `packages/adapters/src/<game>/index.ts` exporting a `GameAdapter`:

```ts
import type { GameAdapter } from '../types.js';

export const valheimAdapter: GameAdapter = {
  id: 'valheim',
  name: 'Valheim',
  summary: 'Co-op viking survival. Up to 10 players.',
  icon: 'Axe',                       // any lucide-react icon name
  variants: [ /* … */ ],

  defaultLimits: () => ({ memoryMib: 4096, cpuCores: 2, diskMib: 10240 }),
  requiredPorts: () => [
    { purpose: 'game', protocol: 'udp' },
    { purpose: 'query', protocol: 'udp' },
  ],
  settingsSchema: (variantId) => valheimSettings(variantId),

  listVersions: async () => [{ id: 'latest', label: 'Latest', stable: true }],
  resolveVersion: async () => ({ id: 'latest', label: 'Latest', stable: true }),

  install: async (ctx, tools, report) => { /* … */ },
  applySettings: async (ctx, tools) => { /* … */ },
  startup: (ctx) => ({ /* … */ }),
  inspectLog: (line) => { /* … */ },
  modDirectory: () => 'BepInEx/plugins',
};
```

Then register it:

```ts
// packages/adapters/src/registry.ts
const ADAPTERS: GameAdapter[] = [minecraftAdapter, palworldAdapter, valheimAdapter];
```

That is the whole integration. The deploy wizard, settings page, install
pipeline, console, mods tab and port allocator all pick it up.

## Writing each piece

### `variants`

Editions of the same game — Paper vs Vanilla, modded vs not. Exactly one should
be `recommended: true`.

`summary` is what a beginner chooses on, so no jargon. `detail` is the longer
"which should I pick?" text revealed on selection.

### `settingsSchema`

The most important part, because it generates the entire settings UI.

```ts
{
  key: 'max-players',              // stable — it is the stored value
  type: 'number',
  label: 'Max players',
  help: 'How many people can be online at once. Each player needs roughly '
      + '200–400 MB of memory on a modded server.',
  tier: 'basic',                   // basic | advanced | expert
  group: 'Basics',                 // becomes a card in the UI
  default: 10,
  min: 1,
  max: 1000,
  unit: 'players',
  restartRequired: true,           // shows a badge, warns after saving
  target: { kind: 'properties', file: 'server.properties', key: 'max-players' },
}
```

**Help text rule:** assume the reader has never seen a config file. Do not
restate the label as a sentence, and do not say "see the wiki". Explain the
consequence of the choice.

**Tiers.** `basic` is always visible — aim for under ten per game. `advanced`
lives behind a disclosure. `expert` is for things that can break a server.

**`showWhen`** hides a setting until its parent is enabled. Hidden settings are
neither validated nor written.

**`target`** decides where the value lands:

| kind | Where it goes |
|---|---|
| `properties` | `key=value` file, comments and hand edits preserved |
| `ini` | INI section, including Unreal's parenthesised tuples |
| `json` | Dotted path in a JSON file |
| `env` | Container environment variable |
| `internal` | Nothing — your own code reads it from `ctx.settings` |

### `install`

Lay out the server files. Report progress generously — this is the screen
someone stares at for twenty minutes.

```ts
async install(ctx, tools, report) {
  await report.phase('preparing', 'Creating the server folder…', 5);
  await tools.mkdir('.');

  await report.phase('downloading', 'Downloading from Steam…', 20);
  const result = await tools.runInContainer({
    image: 'steamcmd/steamcmd:ubuntu-24',
    command: ['+force_install_dir', '/home/container', '+login', 'anonymous',
              '+app_update', '896660', 'validate', '+quit'],
    timeoutMs: 60 * 60 * 1000,
  });

  if (result.exitCode !== 0) {
    // Errors surface directly to the user. Write them for the user.
    throw new Error(
      'SteamCMD failed. This is usually a temporary Steam outage — try again.'
    );
  }

  await report.phase('configuring', 'Writing your settings…', 90);
  await this.applySettings(ctx, tools);
  await report.phase('finalizing', 'Ready to start.', 100);
}
```

All `tools` paths are relative to the server directory and containment-checked.
You cannot escape it, even with a path that came from a remote manifest.

For a SteamCMD game, do not hand-roll the command above — use the shared
helper, which already handles branch selection, argument ordering and an error
message that distinguishes a bad branch name from a Steam outage:

```ts
import { steamAppUpdate, steamBranchFrom, steamBranchSettings } from '../util/steamcmd.js';

// In settingsSchema(), so the game gets the branch fields every other
// SteamCMD game has:
return [...yourSettings, ...steamBranchSettings()];

// In install():
await steamAppUpdate(tools, {
  appId: '896660',
  validate: true,
  ...steamBranchFrom(ctx.settings),
  report: (msg) => report.log(msg),
});
```

### `applySettings`

Runs after install and before every start, so saving a setting and restarting is
all a user ever has to do — there is no separate "apply" step.

Read the existing config, overwrite only the keys you model, write it back.
Preserving unknown keys matters: it is what stops a game update from silently
resetting settings you do not know about yet.

### `startup`

Pure — no I/O — so it is trivially testable.

```ts
startup(ctx) {
  const game = ctx.allocations.find((a) => a.purpose === 'game');
  return {
    image: 'steamcmd/steamcmd:ubuntu-24',
    command: ['./start_server.sh', `-port=${game?.port ?? 2456}`],
    workingDir: '/home/container',
    env: { ...ctx.environment },
    ports: [{ containerPort: 2456, purpose: 'game', protocol: 'udp' }],
    stopCommand: undefined,       // omit if the game has no stdin command
    stopTimeoutSeconds: 60,
    readyPattern: 'Game server connected',
  };
}
```

`command` is **argv, never a shell string**. That is what keeps user-supplied
settings from becoming a command injection.

If the game saves on an in-band shutdown command (Minecraft's `stop`), set
`stopCommand`. The runtime writes it to stdin and only falls back to a signal
if the process does not exit in time — worth doing, because killing a game
mid-write corrupts worlds.

### `inspectLog`

Runs on every console line, so keep it cheap. This is where a cryptic crash
becomes an explanation:

```ts
inspectLog(line) {
  if (/Game server connected/.test(line)) {
    return { level: 'success', ready: true, hint: 'Server is accepting players.' };
  }
  if (/Address already in use/i.test(line)) {
    return {
      level: 'error',
      hint: 'Another program is using this port. Change it under Network.',
    };
  }
  if (/(\w+) has joined/.exec(line)) {
    return { level: 'info', playerEvent: { type: 'join', name: /* … */ } };
  }
  return null;
}
```

`ready: true` is what flips the server from "Starting" to "Online".

If you return `playerEvent`, also set `reportsPlayers: true` on the adapter.
That flag is what the Overview tab uses to decide between showing a player list
and saying the game does not announce who is connected — without it your names
are parsed and then never shown. `tests/adapters.test.ts` checks the flag and
the behaviour agree, so a mismatch fails the suite.

Two things to watch when writing the regex, both of which have bitten this
codebase: put the same flags on the guard and the extraction (a case-insensitive
`test` in front of a case-sensitive `exec` enters the branch and then matches
nothing), and check which capture group holds the name — Valheim's line is
`Got character ZDOID from Erik`, where `ZDOID` is a literal and the name comes
after `from`.

## Testing

Adapters are pure enough to test without a container. Follow
`tests/adapters.test.ts`:

```ts
it('passes the allocated port to the launcher', () => {
  const plan = valheimAdapter.startup(context);
  expect(plan.command).toContain('-port=2456');
});

it('explains a port conflict in plain language', () => {
  const insight = valheimAdapter.inspectLog?.('Address already in use');
  expect(insight?.hint).toMatch(/port/i);
});
```

The existing suite also asserts cross-cutting rules — exactly one recommended
variant per game, jargon-free summaries, a JSON-serialisable catalogue — so a
new adapter is checked against them automatically.

## Checklist

- [ ] Exactly one `recommended` variant
- [ ] Summaries a beginner can choose on
- [ ] `defaultLimits` generous enough not to crash on first run
- [ ] Under ten `basic` settings
- [ ] Every `help` explains a consequence, not the label
- [ ] `startup` returns argv, never a shell string
- [ ] `stopCommand` set if the game saves on shutdown
- [ ] `inspectLog` detects ready, out-of-memory and port conflicts
- [ ] `reportsPlayers` set if — and only if — `inspectLog` returns `playerEvent`
- [ ] Install errors are written for a person, not a log parser
- [ ] Registered in `registry.ts`
- [ ] Tests added
