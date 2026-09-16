import { parseIni, parseTuple } from '@serverforge/adapters';
import { badRequest } from '@serverforge/core';
import { runningInContainer } from '../lib/config.js';
import { containerName } from '../lib/container-name.js';
import { localDataPath } from '../lib/storage-paths.js';
import { readTextFile } from './file-manager.js';
import type { RuntimeDriver } from '../runtime/types.js';

/** Read applied credentials from the running game's file, not pending settings. */
export async function stopPalworld(server: { uid: string; name: string; dataPath: string; containerId: string; allocations: { purpose: string; port: number }[] }, runtime: Pick<RuntimeDriver, 'status'>) {
  const file = await readTextFile(localDataPath(server.dataPath), 'Pal/Saved/Config/LinuxServer/PalWorldSettings.ini');
  const options = parseTuple(parseIni(file.content)['/Script/Pal.PalGameWorldSettings']?.OptionSettings || '');
  const port = server.allocations.find((allocation) => allocation.purpose === 'rest')?.port;
  if (options.RESTAPIEnabled?.toLowerCase() !== 'true' || !options.AdminPassword || !port || Number(options.RESTAPIPort) !== port)
    throw badRequest('Palworld needs its REST API and an admin password to save and shut down safely. Use /Save and /Shutdown in-game for this session, then enable the REST API and set an admin password in Configuration before starting again.');
  const host = runningInContainer() ? containerName(server) : '127.0.0.1';
  const headers = { authorization: `Basic ${Buffer.from(`admin:${options.AdminPassword.replace(/\\([\\"])/g, '$1')}`).toString('base64')}`, 'content-type': 'application/json' };
  for (const operation of ['save', 'shutdown']) {
    const response = await fetch(`http://${host}:${port}/v1/api/${operation}`, {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(15000),
      ...(operation === 'shutdown' ? { body: JSON.stringify({ waittime: 1, message: 'ServerForge is saving and stopping this server.' }) } : {}),
    }).catch(() => { throw badRequest('Palworld’s save API is unavailable. Check its console and REST API settings; the panel has not forced the game to stop.'); });
    await response.body?.cancel();
    if (!response.ok) throw badRequest(`Palworld refused ${operation} (${response.status}). Check the applied admin password and REST API; no forced shutdown was attempted.`);
  }
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const status = await runtime.status(server.containerId);
    if (!status.running) {
      if (status.oomKilled || (status.exitCode != null && status.exitCode !== 0))
        throw badRequest('Palworld exited abnormally during shutdown. Inspect its console before retrying the backup.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw badRequest('Palworld did not finish its requested shutdown. No forced stop or recovery snapshot was performed.');
}
