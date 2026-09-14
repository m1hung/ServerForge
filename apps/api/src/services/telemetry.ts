import { getAdapter } from '@serverforge/adapters';
import { prisma, type Server } from '@serverforge/db';
import type { LogHandle } from '../runtime/types.js';
import { runtime } from '../routes/servers.js';
import { emitServerEvent } from './server-events.js';

type Observations = {
  containerId: string;
  names: Set<string>;
  since: number;
  handle?: LogHandle;
  ready: boolean;
  ticks: { tps: number | null; mspt: number | null; at: number } | null;
  tickLine?: 'tps' | 'mspt';
};
const observed = new Map<string, Observations>();
// Strip terminal color escapes before parsing game metrics.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
export function parseTickMetrics(text: string): { tps?: number; mspt?: number } {
  const clean = text.replace(/§[0-9a-fk-or]/gi, '').replace(ANSI, '');
  const tps = /(?:TPS[^:\n]*:|TPS\s*=)\s*\*?([\d.]+)/i.exec(clean);
  const mspt = /(?:MSPT[^:\n]*:|average tick[^:\n]*:)\s*([\d.]+)/i.exec(clean);
  return {
    ...(tps && Number(tps[1]) <= 1000 ? { tps: Number(tps[1]) } : {}),
    ...(mspt ? { mspt: Number(mspt[1]) } : {}),
  };
}
export function acceptTickOutput(serverUid: string, text: string) {
  const state = observed.get(serverUid);
  if (!state) return;
  for (const line of text.split('\n')) {
    const clean = line.replace(/§[0-9a-fk-or]/gi, '').replace(ANSI, '');
    const result = parseTickMetrics(clean);
    // Spark prints headings and measurements on separate lines on some loaders.
    if (/TPS from last/i.test(clean) && result.tps === undefined) state.tickLine = 'tps';
    else if (/Tick durations|MSPT from last/i.test(clean)) state.tickLine = 'mspt';
    else if (state.tickLine) {
      const numbers = clean
        .replace(/^(?:\[[^\]]*\]:?\s*)+/, '')
        .trim()
        .match(/^\*?([\d.]+)(?:\s*\/\s*([\d.]+))?/);
      if (numbers) {
        if (state.tickLine === 'tps') result.tps = Number(numbers[1]);
        else result.mspt = Number(numbers[2] ?? numbers[1]);
        state.tickLine = undefined;
      }
    }
    if (result.tps !== undefined || result.mspt !== undefined)
      state.ticks = {
        tps: result.tps ?? state.ticks?.tps ?? null,
        mspt: result.mspt ?? state.ticks?.mspt ?? null,
        at: Date.now(),
      };
  }
}
export function observations(server: Pick<Server, 'uid' | 'gameId' | 'state'>) {
  const current = observed.get(server.uid);
  return {
    supported: !!getAdapter(server.gameId).reportsPlayers,
    players: server.state === 'running' ? [...(current?.names ?? [])].sort() : [],
    since: current?.since ?? null,
    partial: true,
    ticks: current?.ticks && Date.now() - current.ticks.at < 120000 ? current.ticks : null,
  };
}
export async function observeServer(server: Server, newContainer = false) {
  if (!server.containerId) return;
  const previous = observed.get(server.uid);
  if (previous?.containerId === server.containerId && previous.handle) return;
  previous?.handle?.close();
  const state: Observations = {
    containerId: server.containerId,
    names: new Set(),
    since: Date.now(),
    ready: false,
    ticks: null,
  };
  observed.set(server.uid, state);
  const adapter = getAdapter(server.gameId);
  state.handle = await runtime.streamLogs(server.containerId, {
    // A freshly created container has no earlier session to replay. Include its boot output
    // so fast startup and player events are not lost before the log stream attaches.
    tail: newContainer ? 1000 : 0,
    onLine(line) {
      acceptTickOutput(server.uid, line);
      const insight = adapter.inspectLog?.(line);
      if (insight?.ready && !state.ready) {
        state.ready = true;
        emitServerEvent({ serverUid: server.uid, type: 'server.ready', at: Date.now() });
      }
      if (insight?.playerEvent) {
        const event = insight.playerEvent;
        if (event.type === 'join') state.names.add(event.name);
        else state.names.delete(event.name);
        emitServerEvent({
          serverUid: server.uid,
          type: event.type === 'join' ? 'player.join' : 'player.leave',
          playerName: event.name,
          at: Date.now(),
        });
      }
    },
    onEnd() {
      state.handle = undefined;
    },
  });
}
export function clearObservations(serverUid: string) {
  observed.get(serverUid)?.handle?.close();
  observed.delete(serverUid);
}
export function closeObservations() {
  for (const uid of observed.keys()) clearObservations(uid);
}
export async function sampleServer(server: Server) {
  if (!server.containerId) return;
  const usage = await runtime.stats(server.containerId);
  if (!usage) return;
  const current = observations(server);
  await prisma.metricSample.create({
    data: {
      serverId: server.id,
      cpuPercent: usage.cpuPercent,
      memoryBytes: Math.round(usage.memoryBytes),
      diskBytes: usage.diskBytes,
      networkRx: Math.round(usage.networkRxBytes),
      networkTx: Math.round(usage.networkTxBytes),
      playersOnline: null,
      tps: current.ticks?.tps,
      mspt: current.ticks?.mspt,
    },
  });
}
