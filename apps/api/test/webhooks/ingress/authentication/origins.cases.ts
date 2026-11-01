import { CallableInputInvalidError } from '@pertexo/workflow-model';
import { StoredExecutionValueInvalidError } from '@pertexo/node-sdk';

import { expect, it } from 'vitest';

import { endpointKey, currentSecret, verification } from '../environment.js';
import { request } from '../requests.js';
import type { createIngressFixture } from '../fixture.js';

export function registerKeepsPreflightStorageReadRefusesUnknownEndpoints(
  caseFixture: ReturnType<typeof createIngressFixture>,
): void {
  const { setupPreflight, setup } = caseFixture;

  it('keeps preflight storage read-only and refuses unknown endpoints, origins, methods and unsupported headers', async () => {
    const f = await setupPreflight({
      ...verification,
      authentication: {
        mode: 'secret_url',
        allowedOrigins: ['https://app.example'],
      },
    });
    const base = {
      method: 'OPTIONS' as const,
      url: `/hooks/${endpointKey}`,
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
      },
    };
    for (const extra of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { 'access-control-request-method': 'PUT' },
      { 'access-control-request-headers': 'authorization' },
    ]) {
      const result = await f.application.inject({
        ...base,
        headers: { ...base.headers, ...extra },
      });
      expect(result.statusCode).toBe(401);
      expect(result.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(f.database.consumeIngressLimit).not.toHaveBeenCalled();
    f.database.resolveVerification.mockResolvedValueOnce(null);
    expect((await f.application.inject(base)).statusCode).toBe(401);
    expect(f.database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('adds exact CORS origin to 202 and workflow replies; refuses other browser origins before admission', async () => {
    const f = setup({
      reference: {
        ...verification,
        authentication: {
          mode: 'secret_url',
          allowedOrigins: ['https://app.example'],
        },
      },
    });
    const send = (origin: string) =>
      f.application.inject({
        method: 'POST',
        url: `/hooks/${endpointKey}`,
        headers: { origin, 'content-type': 'application/json' },
        payload: '{}',
      });
    const accepted = await send('https://app.example');
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers['access-control-allow-origin']).toBe(
      'https://app.example',
    );
    f.database.acceptVerifiedDelivery.mockResolvedValueOnce({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
      responseWaitSeconds: 1,
    });
    f.database.readResponse.mockResolvedValueOnce({
      state: 'responded',
      response: {
        statusCode: 200,
        contentType: 'text/csv',
        body: 'a,b\n1,2',
        headers: { 'x-total-count': '1' },
      },
    });
    const reply = await send('https://app.example');
    expect(reply.body).toBe('a,b\n1,2');
    expect(reply.headers['access-control-allow-origin']).toBe(
      'https://app.example',
    );
    expect(reply.headers['access-control-allow-credentials']).toBeUndefined();
    expect((await send('https://evil.example')).statusCode).toBe(401);
    expect(f.database.acceptVerifiedDelivery).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'callable input contract',
      error: new CallableInputInvalidError({
        code: 'type_mismatch',
        path: ['private-name'],
      }),
    },
    {
      name: 'stored JSON bounds',
      error: new StoredExecutionValueInvalidError(),
    },
  ])(
    'returns a safe 400 when a signed delivery violates $name',
    async ({ error }) => {
      const { application, database } = setup({});
      database.acceptVerifiedDelivery.mockRejectedValue(error);
      const response = await application.inject(
        request('{"private-name":"private-value"}', currentSecret),
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'request.invalid' });
      expect(response.payload).not.toContain('private-name');
      expect(response.payload).not.toContain('private-value');
    },
  );

  it('returns the committed JSON response without serializing its bytes again', async () => {
    const f = setup({});
    f.database.acceptVerifiedDelivery.mockResolvedValue({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
      responseWaitSeconds: 1,
    });
    f.database.readResponse.mockResolvedValue({
      state: 'responded',
      response: {
        statusCode: 201,
        contentType: 'application/json',
        body: '{"message":"hello"}',
        headers: { 'x-request-id': 'response-1' },
      },
    });
    const result = await f.application.inject(request('{}', currentSecret));
    expect(result.statusCode).toBe(201);
    expect(result.body).toBe('{"message":"hello"}');
    expect(result.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': 'response-1',
    });
    expect(f.database.acceptVerifiedDelivery).toHaveBeenCalledOnce();
  });

  it.each([
    { statusCode: 200, body: 'hello 👋\n' },
    { statusCode: 204, body: '' },
  ])(
    'returns exact text and empty-body responses ($statusCode)',
    async ({ statusCode, body }) => {
      const f = setup({});
      f.database.acceptVerifiedDelivery.mockResolvedValue({
        runId: '99999999-9999-4999-8999-999999999999',
        replayed: false,
        responseWaitSeconds: 1,
      });
      f.database.readResponse.mockResolvedValue({
        state: 'responded',
        response: { statusCode, contentType: 'text/plain', body, headers: {} },
      });
      const result = await f.application.inject(request('{}', currentSecret));
      expect(result.statusCode).toBe(statusCode);
      expect(result.body).toBe(body);
    },
  );

  it.each(['text/csv', 'application/xml'] as const)(
    'returns exact UTF-8 bytes with an explicit charset for %s',
    async (contentType) => {
      const f = setup({});
      f.database.acceptVerifiedDelivery.mockResolvedValueOnce({
        runId: '99999999-9999-4999-8999-999999999999',
        replayed: false,
        responseWaitSeconds: 1,
      });
      f.database.readResponse.mockResolvedValueOnce({
        state: 'responded',
        response: {
          statusCode: 200,
          contentType,
          headers: { 'x-total-count': '1' },
          body: 'héllo',
        },
      });
      const result = await f.application.inject(request('{}', currentSecret));
      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toBe(
        `${contentType}; charset=utf-8`,
      );
      expect(result.body).toBe('héllo');
    },
  );

  it('returns only a safe code when the run fails before replying', async () => {
    const f = setup({});
    f.database.acceptVerifiedDelivery.mockResolvedValue({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
      responseWaitSeconds: 1,
    });
    f.database.readResponse.mockResolvedValue({ state: 'failed' });
    const result = await f.application.inject(request('{}', currentSecret));
    expect(result.statusCode).toBe(500);
    expect(result.json()).toEqual({ code: 'webhook.workflow_failed' });
    expect(f.database.recordRejectedDelivery).not.toHaveBeenCalled();
  });
}
