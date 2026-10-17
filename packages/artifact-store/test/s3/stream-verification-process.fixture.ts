import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { verifiedBody } from '../../src/stream-verification.js';

const mode = process.argv[2];
const controller = new AbortController();
const upstream = new PassThrough();
const reason =
  mode === 'abort'
    ? new DOMException(
        'transfer timed out before its reader attached',
        'TimeoutError',
      )
    : new Error('transfer stopped before its reader attached');
const body = verifiedBody(
  upstream,
  {
    artifactId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c02',
    workspaceId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01',
    byteLength: 5,
    mediaType: 'text/plain',
    sha256: createHash('sha256').update('hello').digest('hex'),
  },
  5,
  'stored',
  controller.signal,
);

if (mode === 'abort') controller.abort(reason);
else if (mode === 'upstream') upstream.destroy(reason);
else if (mode === 'premature-close') upstream.destroy();
else throw new Error('Unknown stream scenario');

// Give errors a full event-loop turn before the consumer can observe them.
await setImmediate();
let caught: unknown;
try {
  for await (const _chunk of body) {
    // Observe the terminal error through the public Readable API.
  }
} catch (error: unknown) {
  caught = error;
}
process.stdout.write(
  JSON.stringify({
    originalError:
      mode === 'premature-close'
        ? caught instanceof Error &&
          'code' in caught &&
          caught.code === 'ERR_STREAM_PREMATURE_CLOSE'
        : caught === reason,
    upstreamDestroyed: upstream.destroyed,
    abortListeners: getEventListeners(controller.signal, 'abort').length,
  }),
);
