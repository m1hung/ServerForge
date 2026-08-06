# Adding a game

One file, one line in the registry. Nothing in the API, the workers or the
dashboard needs to change.

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
