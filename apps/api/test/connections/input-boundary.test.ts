import { afterEach, describe, expect, it } from 'vitest';
import {
  start,
  workspaceId,
  cleanConnectionsRealNestHTTPStackFixture,
  connectionUrl,
  connectionPayload,
  authenticatedHeaders,
} from './http-stack/fixture.js';

afterEach(cleanConnectionsRealNestHTTPStackFixture);

describe('connection input HTTP boundary', () => {
  it.each(['Operations API', 'A'.repeat(128)])(
    'stores a trimmed name while preserving case: %s',
    async (name) => {
      const { application, connection } = await start();
      const response = await application.inject({
        method: 'POST',
        url: connectionUrl,
        headers: authenticatedHeaders,
        payload: { ...connectionPayload, name: `  ${name}  ` },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ name });
      expect(connection.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({ name }),
      );
    },
  );

  it.each(['   ', 'A'.repeat(129)])(
    'rejects an invalid name before encryption or persistence: %s',
    async (name) => {
      const { application, connection } = await start();
      const response = await application.inject({
        method: 'POST',
        url: connectionUrl,
        headers: authenticatedHeaders,
        payload: { ...connectionPayload, name },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'request.invalid' });
      expect(connection.createConnection).not.toHaveBeenCalled();
      expect(connection.encryption.seal).not.toHaveBeenCalled();
    },
  );

  it.each([
    'limit=0',
    'limit=1001',
    `after=${Buffer.from(
      JSON.stringify({
        kind: 'connection_usage',
        workspaceId,
        connectionId: '11111111-1111-4111-8111-111111111111',
        workflowVersionId: 'invalid',
      }),
    ).toString('base64url')}`,
  ])(
    'rejects invalid usage pagination before persistence: %s',
    async (query) => {
      const { application, connection } = await start();
      const response = await application.inject({
        method: 'GET',
        url: `${connectionUrl}/11111111-1111-4111-8111-111111111111/usage?${query}`,
        headers: authenticatedHeaders,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'request.invalid' });
      expect(connection.listConnectionUsage).not.toHaveBeenCalled();
    },
  );
});
