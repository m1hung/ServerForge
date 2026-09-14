import https from 'node:https';
import { lookup } from 'node:dns';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import { isBlockedAddress } from './ssrf.js';

/** Validate every redirect and pin the socket to the validated DNS result. */
export async function downloadResponse(
  raw: string,
  headers: Record<string, string> = {},
  hops = 0,
): Promise<IncomingMessage> {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (net.isIP(host) && isBlockedAddress(host))
  ) {
    throw new Error('Downloads require a public HTTPS URL without credentials.');
  }
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers,
        lookup(hostname, options, callback) {
          lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error, [], 0);
            if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
              return callback(
                new Error('Downloads cannot access private or local addresses.'),
                [],
                0,
              );
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      },
      resolve,
    );
    request.setTimeout(120000, () => request.destroy(new Error('Download timed out.')));
    request.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    response.destroy();
    if (hops >= 5 || !response.headers.location) throw new Error('Too many download redirects.');
    const next = new URL(response.headers.location, url);
    return downloadResponse(next.href, next.origin === url.origin ? headers : {}, hops + 1);
  }
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error(`Download failed (${response.statusCode}).`);
  }
  return response;
}
