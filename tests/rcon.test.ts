import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RconError,
  encodePacket,
  rconCommand,
  readPackets,
} from '../apps/api/src/lib/rcon.js';

/**
 * RCON is a wire protocol, so it is tested over a real socket against a real
 * server rather than against a mock of itself. The fake below implements
 * Valve's spec, and each test bends one part of it — fragmented reads, replies
 * coalesced into one packet, output split across several, a rejected password,
 * a server that never answers.
 *
 * Those are not hypotheticals. Long `list` output on a busy server is the
 * usual cause of the multi-packet case, and treating one TCP read as one
 * message is exactly the bug that makes RCON clients drop output now and then.
 */

const AUTH = 3;
const EXEC = 2;
const AUTH_RESPONSE = 2;
const RESPONSE_VALUE = 0;

interface FakeOptions {
  password: string;
  /** Returns the body(s) to answer a command with. Several = several packets. */
  respond?: (command: string) => string[];
  /** Writes replies one byte at a time, to force fragmented reads. */
  dribble?: boolean;
  /** Accepts the connection and then says nothing at all. */
  silent?: boolean;
  /** Hangs up instead of answering the auth request. */
  hangUpOnAuth?: boolean;
  /** Sends the empty RESPONSE_VALUE some servers emit before the auth reply. */
  emptyBeforeAuth?: boolean;
}

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startFake(options: FakeOptions): Promise<number> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let authed = false;

    const send = (packet: Buffer) => {
      if (!options.dribble) {
        socket.write(packet);
        return;
      }
      for (const byte of packet) socket.write(Buffer.from([byte]));
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (options.silent) return;

      const { packets, rest } = readPackets(buffer);
      buffer = rest;

      for (const packet of packets) {
        if (packet.type === AUTH) {
          if (options.hangUpOnAuth) {
            socket.destroy();
            return;
          }
          const ok = packet.body === options.password;
          if (options.emptyBeforeAuth) send(encodePacket(packet.id, RESPONSE_VALUE, ''));
          send(encodePacket(ok ? packet.id : -1, AUTH_RESPONSE, ''));
          authed = ok;
          continue;
        }

        if (packet.type === EXEC && authed) {
          const bodies = options.respond?.(packet.body) ?? [`ran: ${packet.body}`];
          for (const body of bodies) send(encodePacket(packet.id, RESPONSE_VALUE, body));
          continue;
        }

        // The sentinel: answered after the command's packets, which is what
        // makes it usable as an end marker.
        if (packet.type === RESPONSE_VALUE && authed) {
          send(encodePacket(packet.id, RESPONSE_VALUE, ''));
        }
      }
    });
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

// ───────────────────────────────────────────────────────────── packet codec ──

describe('rcon packet encoding', () => {
  it('lays out the header the way the spec describes', () => {
    const packet = encodePacket(7, EXEC, 'list');

    expect(packet.readInt32LE(0)).toBe(packet.length - 4);
    expect(packet.readInt32LE(4)).toBe(7);
    expect(packet.readInt32LE(8)).toBe(EXEC);
    expect(packet.subarray(12, 16).toString()).toBe('list');
    // Two NULs: one ends the body, one ends the packet.
    expect(packet.readUInt8(packet.length - 2)).toBe(0);
    expect(packet.readUInt8(packet.length - 1)).toBe(0);
  });

  it('round-trips through the reader', () => {
    const { packets, rest } = readPackets(encodePacket(9, EXEC, 'say hi'));
    expect(packets).toEqual([{ id: 9, type: EXEC, body: 'say hi' }]);
    expect(rest.length).toBe(0);
  });

  it('handles a body containing multi-byte characters', () => {
    // Length is bytes, not characters — getting that wrong truncates the body.
    const { packets } = readPackets(encodePacket(1, EXEC, 'say héllo → 世界'));
    expect(packets[0]!.body).toBe('say héllo → 世界');
  });

  it('reads several packets out of one buffer', () => {
    const buffer = Buffer.concat([encodePacket(1, EXEC, 'a'), encodePacket(2, EXEC, 'b')]);
    const { packets, rest } = readPackets(buffer);

    expect(packets.map((p) => p.body)).toEqual(['a', 'b']);
    expect(rest.length).toBe(0);
  });

  it('keeps a partial packet back until the rest arrives', () => {
    const whole = encodePacket(1, EXEC, 'hello');
    const first = readPackets(whole.subarray(0, 8));

    expect(first.packets).toEqual([]);
    expect(first.rest.length).toBe(8);

    const second = readPackets(Buffer.concat([first.rest, whole.subarray(8)]));
    expect(second.packets).toEqual([{ id: 1, type: EXEC, body: 'hello' }]);
  });

  it('rejects a length field that is nonsense', () => {
    // Pointing the port at something that is not an RCON server should say so
    // rather than trying to allocate whatever the first four bytes suggest.
    const bogus = Buffer.alloc(12);
    bogus.writeInt32LE(999_999_999, 0);
    expect(() => readPackets(bogus)).toThrow(/not a valid RCON reply/);
  });
});

// ─────────────────────────────────────────────────────────── over a socket ──

describe('rconCommand', () => {
  it('authenticates and returns the command output', async () => {
    const port = await startFake({ password: 'secret' });

    await expect(
      rconCommand({ host: '127.0.0.1', port, password: 'secret' }, 'list'),
    ).resolves.toBe('ran: list');
  });

  it('joins a reply split across several packets', async () => {
    // The case that matters: a long player list arrives in 4 KB chunks with
    // no end marker, and a client that stops at the first one silently
    // truncates it.
    const port = await startFake({
      password: 'secret',
      respond: () => ['part one ', 'part two ', 'part three'],
    });

    await expect(rconCommand({ host: '127.0.0.1', port, password: 'secret' }, 'list')).resolves.toBe(
      'part one part two part three',
    );
  });

  it('survives replies arriving one byte at a time', async () => {
    const port = await startFake({
      password: 'secret',
      dribble: true,
      respond: () => ['slowly delivered'],
    });

    await expect(rconCommand({ host: '127.0.0.1', port, password: 'secret' }, 'list')).resolves.toBe(
      'slowly delivered',
    );
  });

  it('tolerates the empty packet some servers send before the auth reply', async () => {
    const port = await startFake({ password: 'secret', emptyBeforeAuth: true });

    await expect(rconCommand({ host: '127.0.0.1', port, password: 'secret' }, 'list')).resolves.toBe(
      'ran: list',
    );
  });

  it('reports a wrong password as a wrong password', async () => {
    const port = await startFake({ password: 'secret' });

    const error = await rconCommand(
      { host: '127.0.0.1', port, password: 'wrong' },
      'list',
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RconError);
    expect((error as RconError).authFailed).toBe(true);
    expect((error as RconError).message).toMatch(/password is wrong/i);
  });

  it('treats a hang-up during sign-in as an auth failure', async () => {
    const port = await startFake({ password: 'secret', hangUpOnAuth: true });

    const error = await rconCommand(
      { host: '127.0.0.1', port, password: 'secret' },
      'list',
    ).catch((e: unknown) => e);

    expect((error as RconError).authFailed).toBe(true);
  });

  it('gives up on a server that never answers', async () => {
    const port = await startFake({ password: 'secret', silent: true });

    await expect(
      rconCommand({ host: '127.0.0.1', port, password: 'secret', timeoutMs: 150 }, 'list'),
    ).rejects.toThrow(/timed out/i);
  });

  it('explains a refused connection instead of leaking errno', async () => {
    // Port 1 is reserved and nothing listens on it.
    await expect(
      rconCommand({ host: '127.0.0.1', port: 1, password: 'x', timeoutMs: 500 }, 'list'),
    ).rejects.toThrow(/Could not reach the server over RCON/);
  });

  it('returns empty for a command the game answers with nothing', async () => {
    // Plenty of commands print nothing. That is success, not failure.
    const port = await startFake({ password: 'secret', respond: () => [''] });

    await expect(rconCommand({ host: '127.0.0.1', port, password: 'secret' }, 'save').catch((e) => e))
      .resolves.toBe('');
  });

  it('does not leave the socket open after finishing', async () => {
    const port = await startFake({ password: 'secret' });
    const before = process.getActiveResourcesInfo?.().length ?? 0;

    await rconCommand({ host: '127.0.0.1', port, password: 'secret' }, 'list');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = process.getActiveResourcesInfo?.().length ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });
});

// ───────────────────────────────────────────────────────── address resolving ──

import { resolveRconTarget } from '../apps/api/src/lib/rcon-target.js';
import type { StartupPlan } from '../packages/adapters/src/types.js';

/**
 * Which address the panel dials depends on where the panel itself runs, and
 * both shapes are normal. Getting it wrong is not a crash — it is a console
 * that times out for one class of user and works for the other, which is the
 * kind of bug that survives a long time.
 */
describe('resolveRconTarget', () => {
  const plan = (overrides: Partial<StartupPlan> = {}): StartupPlan => ({
    image: 'img',
    command: ['run'],
    workingDir: '/home/container',
    env: {},
    ports: [
      { containerPort: 25565, purpose: 'game', protocol: 'tcp' },
      { containerPort: 25575, purpose: 'rcon', protocol: 'tcp' },
    ],
    console: {
      transport: 'rcon',
      portPurpose: 'rcon',
      enabledSetting: 'enable-rcon',
      passwordSetting: 'rcon.password',
    },
    stopTimeoutSeconds: 60,
    ...overrides,
  });

  const allocations = [
    { ip: '0.0.0.0', port: 25500, purpose: 'game' },
    { ip: '0.0.0.0', port: 25501, purpose: 'rcon' },
  ];

  const enabled = { 'enable-rcon': true, 'rcon.password': 'secret' };

  const resolve = (over: Partial<Parameters<typeof resolveRconTarget>[0]> = {}) =>
    resolveRconTarget({
      plan: plan(),
      containerName: 'serverforge-abc123',
      allocations,
      settings: enabled,
      inContainer: false,
      ...over,
    });

  it('dials loopback and the published port when the panel runs on the host', () => {
    expect(resolve()).toEqual({ host: '127.0.0.1', port: 25501 });
  });

  it('dials the container by name when the panel runs in a container', () => {
    // Published host ports are not reachable from another container; the
    // shared Docker network and the container name are.
    expect(resolve({ inContainer: true })).toEqual({
      host: 'serverforge-abc123',
      port: 25501,
    });
  });

  it('uses a specific bind address over loopback when one is allocated', () => {
    expect(
      resolve({ allocations: [{ ip: '10.0.0.5', port: 25501, purpose: 'rcon' }] }),
    ).toEqual({ host: '10.0.0.5', port: 25501 });
  });

  it('uses the container port for a game whose listening port is fixed', () => {
    // `fixed` means the game cannot be told which port to listen on, so the
    // mapping is hostPort -> containerPort and the container side differs.
    const fixedPlan = plan({
      ports: [
        { containerPort: 25565, purpose: 'game', protocol: 'tcp' },
        { containerPort: 25575, purpose: 'rcon', protocol: 'tcp', fixed: true },
      ],
    });

    expect(resolve({ plan: fixedPlan, inContainer: true })).toEqual({
      host: 'serverforge-abc123',
      port: 25575,
    });
  });

  it('declines when the adapter does not offer an rcon console', () => {
    expect(resolve({ plan: plan({ console: undefined }) })).toBeNull();
  });

  it('declines when the user has not switched rcon on', () => {
    expect(resolve({ settings: { 'enable-rcon': false, 'rcon.password': 'secret' } })).toBeNull();
  });

  it('declines when no password is set, rather than trying and failing', () => {
    // A server whose owner has not set RCON up yet should keep using stdin,
    // not start reporting authentication errors.
    expect(resolve({ settings: { 'enable-rcon': true, 'rcon.password': '' } })).toBeNull();
    expect(resolve({ settings: { 'enable-rcon': true, 'rcon.password': '   ' } })).toBeNull();
    expect(resolve({ settings: { 'enable-rcon': true } })).toBeNull();
  });

  it('declines when the port it was told to use was never allocated', () => {
    expect(resolve({ allocations: [{ ip: '0.0.0.0', port: 25500, purpose: 'game' }] })).toBeNull();
  });

  it('needs no enabling setting when the adapter does not declare one', () => {
    const always = plan({
      console: { transport: 'rcon', portPurpose: 'rcon', passwordSetting: 'rcon.password' },
    });
    expect(resolve({ plan: always, settings: { 'rcon.password': 'secret' } })).toEqual({
      host: '127.0.0.1',
      port: 25501,
    });
  });
});
