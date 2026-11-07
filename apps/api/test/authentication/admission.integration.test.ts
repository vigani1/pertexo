import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'public authentication transport admission',
  () => {
    const api = useBetterAuthRealApi('admission');
    it('bounds the exact public capabilities route by client address', async () => {
      for (let index = 0; index < 30; index += 1) {
        const response = await api.send('GET', '/v1/auth/capabilities', {
          remoteAddress: '198.51.100.41',
        });
        expect(response.statusCode, response.payload).toBe(200);
        expect(response.json()).toMatchObject({
          password: { enabled: true },
          signUp: 'open',
        });
      }
      const refused = await api.send('GET', '/v1/auth/capabilities', {
        remoteAddress: '198.51.100.41',
      });
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ code: 'request.rate_limited' });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(
        (
          await api.send('GET', '/v1/auth/capabilities', {
            remoteAddress: '198.51.100.42',
          })
        ).statusCode,
      ).toBe(200);
    });
    it('expires an incomplete body and continues serving completed requests', async () => {
      const url = new URL(await api.listen());
      const socket = connect({ host: url.hostname, port: Number(url.port) });
      const start = performance.now();
      try {
        const response = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  'Incomplete request was not refused within the receive deadline',
                ),
              ),
            65_000,
          );
          let data = '';
          socket.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          socket.once('error', reject);
          socket.once('close', () => {
            clearTimeout(timer);
            resolve(data);
          });
          socket.once('connect', () =>
            socket.write(
              'POST /v1/auth/request-password-reset HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{',
            ),
          );
        });
        expect(response).toContain('408 Request Timeout');
        expect(performance.now() - start).toBeLessThan(65_000);
        const healthy = await api.send(
          'POST',
          '/v1/auth/request-password-reset',
          { payload: { email: 'absent@example.test' } },
        );
        expect(healthy.statusCode, healthy.payload).toBe(200);
      } finally {
        socket.destroy();
      }
    }, 75_000);
  },
);
