import { request as sendHttpRequest } from 'node:http';

import { expect, it, vi } from 'vitest';

import { currentSecret } from '../environment.js';
import { request } from '../requests.js';
import { deferred } from '../deferred.js';
import type { createIngressFixture } from '../fixture.js';

export function registerReturnsOriginalRunReferenceExactCompletedReplay(
  caseFixture: ReturnType<typeof createIngressFixture>,
): void {
  const { setup, applications } = caseFixture;

  it('returns the original run reference for an exact completed replay', async () => {
    const replay = setup({
      reference: undefined,
      acceptanceError: undefined,
      acceptance: {
        runId: '99999999-9999-4999-8999-999999999999',
        replayed: true,
      },
    });
    const response = await replay.application.inject(
      request('{}', currentSecret),
    );
    expect(response.statusCode).toBe(202);
    expect(response.json<{ runId: string; replayed: boolean }>()).toEqual({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: true,
    });
  });

  it('fails closed with a bounded response when infrastructure is unavailable', async () => {
    const { application, database } = setup({});
    database.resolveVerification.mockRejectedValueOnce(
      new Error('sensitive database failure'),
    );

    const response = await application.inject(request('{}', currentSecret));

    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>()).toMatchObject({
      code: 'webhook.unavailable',
    });
    expect(response.body).not.toContain('sensitive database failure');
    expect(database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('does not persist a delivery after the client socket closes during secret opening', async () => {
    const { application, database, openSecret } = setup({});
    const secretBarrier = deferred<Uint8Array>();
    let operationSignal: AbortSignal | undefined;
    openSecret.mockImplementationOnce(
      (_value: unknown, _context: unknown, signal: AbortSignal) => {
        operationSignal = signal;
        return secretBarrier.promise;
      },
    );
    await application.listen({ host: '127.0.0.1', port: 0 });
    const address = application.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Expected a TCP listening address');

    const body = '{}';
    const input = request(body, currentSecret);
    const clientRequest = sendHttpRequest({
      host: '127.0.0.1',
      port: address.port,
      method: input.method,
      path: input.url,
      headers: {
        ...input.headers,
        'content-length': Buffer.byteLength(body),
      },
    });
    try {
      clientRequest.on('error', () => {
        // Expected when the test intentionally closes the client socket.
      });
      clientRequest.end(body);
      await vi.waitFor(() => {
        expect(openSecret).toHaveBeenCalledOnce();
      });

      clientRequest.destroy();
      await vi.waitFor(() => {
        expect(operationSignal?.aborted).toBe(true);
      });
    } finally {
      clientRequest.destroy();
      secretBarrier.resolve(new Uint8Array(32).fill(4));
      await application.close();
      const ownedIndex = applications.indexOf(application);
      if (ownedIndex >= 0) applications.splice(ownedIndex, 1);
    }
    expect(database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('propagates accepted-reply serialization failures through the scoped error handler', async () => {
    const { application, database } = setup({});
    database.acceptVerifiedDelivery
      .mockResolvedValueOnce({
        runId: '99999999-9999-4999-8999-999999999999',
        replayed: false,
      })
      .mockResolvedValueOnce({
        runId: '99999999-9999-4999-8999-999999999999',
        replayed: true,
      });
    let failAcceptedReply = true;
    application.addHook('onSend', (_request, reply, payload) => {
      if (reply.statusCode === 202 && failAcceptedReply) {
        failAcceptedReply = false;
        throw new Error('simulated reply failure');
      }
      return Promise.resolve(payload);
    });

    const response = await application.inject(request('{}', currentSecret));

    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('webhook.unavailable');
    expect(database.acceptVerifiedDelivery).toHaveBeenCalledOnce();

    const retry = await application.inject(request('{}', currentSecret));
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: true,
    });
    expect(database.acceptVerifiedDelivery).toHaveBeenCalledTimes(2);
  });
}
