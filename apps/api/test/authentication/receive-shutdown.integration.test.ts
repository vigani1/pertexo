import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'shutdown during request receipt',
  () => {
    const api = useBetterAuthRealApi('receive_shutdown');

    it('slow: drains and cuts off an incomplete upload within the receive deadline plus two seconds', async () => {
      const address = new URL(await api.listen());
      const uploadStarted = performance.now();
      const socket = connect({
        host: address.hostname,
        port: Number(address.port),
      });
      const closed = Promise.withResolvers<undefined>();
      let uploadClosed = false;
      socket.once('close', () => {
        uploadClosed = true;
        closed.resolve(undefined);
      });
      let uploadError: NodeJS.ErrnoException | undefined;
      socket.on('error', (error: NodeJS.ErrnoException) => {
        uploadError = error;
      });
      socket.resume();
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('error', reject);
          socket.once('connect', () => {
            socket.write(
              'POST /v1/auth/request-password-reset HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{',
              (error) => {
                if (error) reject(error);
                else resolve();
              },
            );
          });
        });
        expect(
          (await fetch(new URL('/v1/auth/capabilities', address))).status,
        ).toBe(200);
        expect(uploadClosed).toBe(false);
        const started = performance.now();
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.all([api.application().close(), closed.promise]),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(
                  new Error(
                    'Shutdown or upload cutoff exceeded the receive deadline plus two seconds',
                  ),
                );
              }, 32_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        expect(performance.now() - started).toBeLessThan(32_000);
        expect(uploadClosed).toBe(true);
        // Graceful drain preserves the upload's remaining receive window.
        expect(performance.now() - uploadStarted).toBeGreaterThanOrEqual(
          29_000,
        );
        expect([undefined, 'ECONNRESET']).toContain(uploadError?.code);
        const server = api.application().getHttpServer();
        expect(server.listening).toBe(false);
      } finally {
        socket.destroy();
      }
    }, 40_000);
  },
);
