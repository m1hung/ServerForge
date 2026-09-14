import { expect, it } from 'vitest';
import { preparePalworldLauncher } from '../packages/adapters/src/palworld/launcher.js';
import type { InstallTools } from '../packages/adapters/src/types.js';

it('preserves Steam setup and gives the game direct ownership of shutdown signals', async () => {
  let script = '#!/bin/sh\ncp steamclient.so linux64/steamclient.so\n"$UE_PROJECT_ROOT/Pal/Binaries/Linux/PalServer-Linux-Shipping" Pal "$@"\n';
  let writes = 0;
  const tools = { readFile: async () => script, writeFile: async (_file: string, value: string) => { script = value; writes++; } } as InstallTools;
  await preparePalworldLauncher(tools);
  expect(script).toContain('cp steamclient.so linux64/steamclient.so\nexec "$UE_PROJECT_ROOT/Pal/Binaries/Linux/PalServer-Linux-Shipping" Pal "$@"');
  await preparePalworldLauncher(tools);
  expect(writes).toBe(1);
});
it('refuses an unknown launcher instead of guessing how to rewrite it', async () => {
  const tools = { readFile: async () => '#!/bin/sh\n./unknown-launcher "$@"', writeFile: async () => { throw new Error('Must not write'); } } as unknown as InstallTools;
  await expect(preparePalworldLauncher(tools)).rejects.toThrow('differs from the supported Steam layout');
});
