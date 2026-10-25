import { afterEach, describe, expect, it } from 'vitest';
import {
  start,
  cleanConnectionsRealNestHTTPStackFixture,
  connectionUrl,
  authenticatedHeaders,
} from './http-stack/fixture.js';

afterEach(cleanConnectionsRealNestHTTPStackFixture);
describe('connection cursor request boundary', () => {
  it('rejects PostgreSQL year zero as request.invalid before persistence', async () => {
    const { application } = await start();
    const cursor = Buffer.from(
      JSON.stringify({
        kind: 'connections',
        status: 'active',
        createdAt: '0000-01-01T00:00:00.000000Z',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).toString('base64url');
    const result = await application.inject({
      method: 'GET',
      url: `${connectionUrl}?after=${cursor}`,
      headers: authenticatedHeaders,
    });
    expect(result.statusCode).toBe(400);
    expect(result.json()).toMatchObject({ code: 'request.invalid' });
  });
});
