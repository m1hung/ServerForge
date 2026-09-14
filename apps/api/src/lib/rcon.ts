import net from 'node:net';

const AUTH = 3;
const EXEC = 2;
const AUTH_RESPONSE = 2;
const RESPONSE_VALUE = 0;
const MAX_PACKET = 32_768;

export class RconError extends Error {
  readonly authFailed: boolean;

  constructor(message: string, options: { authFailed?: boolean } = {}) {
    super(message);
    this.name = 'RconError';
    this.authFailed = options.authFailed === true;
  }
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(4 + 4 + 4 + bodyBuf.length + 2);
  packet.writeInt32LE(packet.length - 4, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bodyBuf.copy(packet, 12);
  packet.writeUInt8(0, packet.length - 2);
  packet.writeUInt8(0, packet.length - 1);
  return packet;
}

export function readPackets(buffer: Buffer): {
  packets: { id: number; type: number; body: string }[];
  rest: Buffer;
} {
  const packets: { id: number; type: number; body: string }[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const size = buffer.readInt32LE(offset);
    if (size < 10 || size > MAX_PACKET) {
      throw new Error('not a valid RCON reply');
    }
    if (offset + 4 + size > buffer.length) break;
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const body = buffer.subarray(offset + 12, offset + 4 + size - 2).toString('utf8');
    packets.push({ id, type, body });
    offset += 4 + size;
  }
  return { packets, rest: buffer.subarray(offset) };
}

export async function rconCommand(
  target: { host: string; port: number; password: string; timeoutMs?: number },
  command: string,
): Promise<string> {
  const timeoutMs = target.timeoutMs ?? 5_000;
  const id = 1;
  const sentinelId = 2;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    let buffer = Buffer.alloc(0);
    let authed = false;
    let bodies = '';
    let settled = false;

    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? '');
    };

    const timer = setTimeout(
      () => finish(new RconError('The server timed out waiting for an RCON reply.')),
      timeoutMs,
    );

    socket.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
        finish(new RconError('Could not reach the server over RCON.'));
        return;
      }
      finish(new RconError(error.message));
    });

    socket.on('close', () => {
      if (!settled) {
        finish(
          new RconError(
            authed ? 'The server closed the connection.' : 'The password is wrong.',
            { authFailed: !authed },
          ),
        );
      }
    });

    socket.on('connect', () => {
      socket.write(encodePacket(id, AUTH, target.password));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let parsed;
      try {
        parsed = readPackets(buffer);
      } catch (error) {
        finish(error instanceof Error ? error : new RconError('not a valid RCON reply'));
        return;
      }
      buffer = parsed.rest;
      for (const packet of parsed.packets) {
        if (!authed) {
          if (packet.type === RESPONSE_VALUE) continue;
          if (packet.type === AUTH_RESPONSE) {
            if (packet.id === -1) {
              finish(new RconError('The password is wrong.', { authFailed: true }));
              return;
            }
            authed = true;
            socket.write(encodePacket(id, EXEC, command));
            socket.write(encodePacket(sentinelId, RESPONSE_VALUE, ''));
          }
          continue;
        }
        if (packet.id === sentinelId) {
          finish(undefined, bodies);
          return;
        }
        if (packet.id === id && packet.type === RESPONSE_VALUE) {
          bodies += packet.body;
        }
      }
    });
  });
}
