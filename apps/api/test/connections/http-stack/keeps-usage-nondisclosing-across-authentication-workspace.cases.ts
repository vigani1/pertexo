import { ConnectionNotFoundError } from '@pertexo/core/connections';

import { connectionResponseSchema } from '@pertexo/contracts';
import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/integrations/server';
import { expect, it } from 'vitest';

import {
  credentialValue,
  connectionUrl,
  connectionPayload,
  authenticatedHeaders,
  start,
} from './fixture.js';

export function registerKeepsUsageNondisclosingAcrossAuthenticationWorkspace(): void {
  it('keeps usage nondisclosing across authentication, workspace and database authority failures', async () => {
    const { application, connection } = await start();
    const connectionId = '11111111-1111-4111-8111-111111111111';
    const unauthenticated = await application.inject({
      method: 'GET',
      url: `${connectionUrl}/${connectionId}/usage`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    const foreign = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${connectionId}/connections/${connectionId}/usage`,
      headers: { cookie: authenticatedHeaders.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    expect(connection.listConnectionUsage).not.toHaveBeenCalled();
    connection.listConnectionUsage.mockRejectedValueOnce(
      new ConnectionNotFoundError('internal private usage'),
    );
    const revoked = await application.inject({
      method: 'GET',
      url: `${connectionUrl}/${connectionId}/usage`,
      headers: { cookie: authenticatedHeaders.cookie },
    });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.payload).not.toContain('internal private usage');
    const unbounded = await application.inject({
      method: 'GET',
      url: `${connectionUrl}/${connectionId}/usage?limit=101`,
      headers: { cookie: authenticatedHeaders.cookie },
    });
    expect(unbounded.statusCode).toBe(400);
    expect(connection.listConnectionUsage).toHaveBeenCalledTimes(1);
  });

  it('does not serialize raw provider failure causes', async () => {
    const { application, connection } = await start();
    const created = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: authenticatedHeaders,
      payload: connectionPayload,
    });
    const connectionId = connectionResponseSchema.parse(created.json()).id;
    const providerFailure = new SecureHttpError(
      SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
      'definite_failure',
      { possiblyDispatched: false },
    );
    Object.defineProperty(providerFailure, 'cause', {
      value: new Error('provider body with raw-secret'),
    });
    connection.executeHttp.mockRejectedValueOnce(providerFailure);
    const response = await application.inject({
      method: 'POST',
      url: `${connectionUrl}/${connectionId}/test`,
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'test-provider-cause',
      },
      payload: { url: 'https://provider.example.test/health' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'provider.unavailable' });
    expect(response.payload).not.toContain('provider body with raw-secret');
    expect(response.payload).not.toContain(credentialValue);
  });
}
