import type { InstallTools } from '../types.js';

/** The shipped shell waits for its child and does not forward Docker signals. */
export async function preparePalworldLauncher(tools: InstallTools): Promise<void> {
  const script = await tools.readFile('PalServer.sh');
  if (!script) throw new Error('PalServer.sh is missing. Repair or reinstall the Palworld server files.');
  const command = '"$UE_PROJECT_ROOT/Pal/Binaries/Linux/PalServer-Linux-Shipping" Pal "$@"';
  if (script.split(/\r?\n/).some((line) => line.trim() === `exec ${command}`)) return;
  if (!script.split(/\r?\n/).some((line) => line.trim() === command))
    throw new Error('The Palworld launcher differs from the supported Steam layout. Review its final exec command before starting; graceful shutdown cannot be guaranteed.');
  await tools.writeFile('PalServer.sh', script.split(/\r?\n/).map((line) => line.trim() === command ? `exec ${command}` : line).join('\n'));
}
