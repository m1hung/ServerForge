import net from 'node:net';

/**
 * Source RCON client.
 *
 * The protocol Valve defined for Half-Life and that most dedicated servers
 * since have adopted — Minecraft, ARK, Conan, Project Zomboid, Squad. It
 * matters here because a large share of games never read stdin at all: their
 * console is RCON or nothing, and without this the panel can stream their logs
 * but not command them.
 *
 * A packet is:
 *
 *     int32  length of everything after this field
 *     int32  request id, echoed back so replies can be matched
 *     int32  type
 *     bytes  body, NUL-terminated
 *     byte   a second NUL
 *
 * Connections are not pooled. A game server holds a small fixed number of RCON
 * slots and a panel that keeps one open per server would exhaust them on a busy
 * host; commands are rare and human-paced, so a connection per command is the
 * right trade.
 */

// ── Packet types ────────────────────────────────────────────────────────────
const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;
/** Also the type of a successful auth reply, which is why matching is by id. */
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_RESPONSE_VALUE = 0;

/** Servers signal a rejected password by echoing this id instead of ours. */
const AUTH_FAILED_ID = -1;

const HEADER_BYTES = 12;
/** Valve's documented ceiling for a single packet. */
const MAX_PACKET_BYTES = 4096;
/**
 * Refuses a length field that would have us buffer unbounded memory. A real
 * server never sends this; something that is not an RCON server might.
 */
const MAX_ACCEPTED_BYTES = 64 * 1024;

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  /** Applies to the whole exchange — connect, authenticate and command. */
  timeoutMs?: number;
}

export class RconError extends Error {
  constructor(
    message: string,
    /** True when the password was rejected, which is worth saying plainly. */
    readonly authFailed = false,
  ) {
    super(message);
    this.name = 'RconError';
  }
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  // length counts id + type + body + the two trailing NULs.
  const buffer = Buffer.alloc(HEADER_BYTES + payload.length + 2);

  buffer.writeInt32LE(buffer.length - 4, 0);
  buffer.writeInt32LE(id, 4);
  buffer.writeInt32LE(type, 8);
  payload.copy(buffer, 12);
  buffer.writeUInt8(0, 12 + payload.length);
  buffer.writeUInt8(0, 13 + payload.length);

  return buffer;
}

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

/**
 * Pulls whole packets off a growing buffer.
 *
 * TCP gives no message boundaries, so a reply can arrive split across reads or
 * several replies can arrive in one. Both happen in practice — long `list`
 * output from a busy server is the usual trigger — and treating a read as a
 * message is the bug that makes RCON clients drop output intermittently.
 */
export function readPackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let offset = 0;

  while (buffer.length - offset >= 4) {
    const length = buffer.readInt32LE(offset);

    if (length < 8 || length > MAX_ACCEPTED_BYTES) {
      throw new RconError(
        'The server sent something that is not a valid RCON reply. Check that the RCON port is right and is not being used by something else.',
      );
    }
    if (buffer.length - offset - 4 < length) break; // Wait for the rest.

    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    // Body runs to the first of the two trailing NULs.
    const body = buffer.subarray(offset + 12, offset + 4 + length - 2).toString('utf8');

    packets.push({ id, type, body });
    offset += 4 + length;
  }

  return { packets, rest: buffer.subarray(offset) };
}

/**
 * Connects, authenticates, runs one command and disconnects.
 *
 * The response is whatever the game chose to print. Many commands print
 * nothing at all and return an empty string; that is success, not a failure.
 */
export async function rconCommand(options: RconOptions, command: string): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5000;

  return new Promise<string>((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;
    let authenticated = false;
    const chunks: string[] = [];

    const AUTH_ID = 1;
    const COMMAND_ID = 2;
    /**
     * A second, empty request sent straight after the command.
     *
     * Responses longer than one packet arrive as several with the same id and
     * no end marker. Servers answer in order, so the reply to this sentinel
     * cannot arrive before the command's last packet — which makes it the end
     * marker the protocol otherwise lacks.
     */
    const SENTINEL_ID = 3;

    const finish = (error: RconError | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? '');
    };

    const timer = setTimeout(() => {
      finish(
        new RconError(
          authenticated
            ? 'The server accepted the connection but did not answer the command in time.'
            : 'Timed out talking to the server over RCON. Check that RCON is enabled and the port is reachable.',
        ),
      );
    }, timeoutMs);

    socket.on('error', (error) => {
      finish(
        new RconError(
          `Could not reach the server over RCON: ${error.message}. Check that RCON is enabled in Settings and the server has been restarted since.`,
        ),
      );
    });

    socket.on('close', () => {
      // A server that hangs up mid-exchange has usually rejected the password
      // and closed rather than replying, which is worth naming.
      finish(
        new RconError(
          authenticated
            ? 'The server closed the RCON connection before finishing its reply.'
            : 'The server closed the RCON connection during sign-in. This is usually a wrong RCON password.',
          !authenticated,
        ),
      );
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      let parsed;
      try {
        parsed = readPackets(buffer);
      } catch (error) {
        finish(error as RconError);
        return;
      }
      buffer = parsed.rest;

      for (const packet of parsed.packets) {
        if (!authenticated) {
          // The empty RESPONSE_VALUE some servers send before the auth reply
          // is not the answer — wait for the AUTH_RESPONSE.
          if (packet.type !== SERVERDATA_AUTH_RESPONSE) continue;

          if (packet.id === AUTH_FAILED_ID) {
            finish(new RconError('The RCON password is wrong.', true));
            return;
          }

          authenticated = true;
          socket.write(encodePacket(COMMAND_ID, SERVERDATA_EXECCOMMAND, command));
          socket.write(encodePacket(SENTINEL_ID, SERVERDATA_RESPONSE_VALUE, ''));
          continue;
        }

        if (packet.id === SENTINEL_ID) {
          finish(null, chunks.join('').trim());
          return;
        }
        if (packet.id === COMMAND_ID) chunks.push(packet.body);
      }
    });

    socket.setNoDelay(true);
    socket.connect(options.port, options.host, () => {
      socket.write(encodePacket(AUTH_ID, SERVERDATA_AUTH, options.password));
    });
  });
}

export const RCON_INTERNALS = {
  SERVERDATA_AUTH,
  SERVERDATA_EXECCOMMAND,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_RESPONSE_VALUE,
  AUTH_FAILED_ID,
  MAX_PACKET_BYTES,
};
