import {
  EventCoordinationUnavailableError,
  WebhookIntakeBusyError,
} from '@pertexo/core/triggers';
import type { StructuredLogger } from '@pertexo/observability';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { createIngressFixture } from './ingress/fixture.js';
import { currentSecret, endpointKey } from './ingress/environment.js';
import { request } from './ingress/requests.js';

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies StructuredLogger;
}

// api-03: an outage behind webhook ingress must reach the logs with its cause,
// not only a rising `unavailable` counter.
describe('webhook ingress failures', () => {
  const { setup, setupPreflight } = createIngressFixture();

  it('answers an unexpected acceptance failure with a safe 503', async () => {
    const failure = new Error('connection terminated unexpectedly');
    const { application, health } = setup({
      reference: undefined,
      acceptanceError: failure,
      logger: logger(),
    });
    const response = await application.inject(request('{}', currentSecret));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'webhook.unavailable' });
    expect(response.payload).not.toContain('connection terminated');
    expect(health).toHaveBeenCalledWith('degraded');
  });

  it('tells the sender when to retry if the database is only busy or away', async () => {
    const { application } = setup({
      reference: undefined,
      acceptanceError: new Error('timeout exceeded when trying to connect'),
      logger: logger(),
    });
    const response = await application.inject(request('{}', currentSecret));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'webhook.unavailable' });
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('promises no retry time for a failure that time will not cure', async () => {
    const { application } = setup({
      reference: undefined,
      acceptanceError: new TypeError('a bug, not an outage'),
      logger: logger(),
    });
    const response = await application.inject(request('{}', currentSecret));
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBeUndefined();
  });

  it('refuses a delivery that outwaited a full workspace like any other full workspace', async () => {
    const log = logger();
    const { application, database, health } = setup({
      reference: undefined,
      acceptanceError: new WebhookIntakeBusyError(),
      logger: log,
    });
    const response = await application.inject(request('{}', currentSecret));
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'webhook.rate_limited' });
    expect(response.headers['retry-after']).toBe('5');
    expect(database.recordRejectedDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'rate_limited' }),
    );
    expect(log.warn.mock.calls[0]?.[0]).toBe('webhook.intake_busy');
    expect(log.error).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalledWith('degraded');
  });

  it('tells the sender when to retry if event coordination is away', async () => {
    const { application } = setup({
      reference: undefined,
      acceptanceError: new EventCoordinationUnavailableError(),
      logger: logger(),
    });
    const response = await application.inject(request('{}', currentSecret));
    expect(response.statusCode).toBe(503);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('does not report an outage when a sender leaves while its delivery waits', async () => {
    const log = logger();
    const { application, database, health } = setup({
      reference: undefined,
      logger: log,
    });
    let sawAbort = (): void => undefined;
    const aborted = new Promise<void>((resolve) => {
      sawAbort = resolve;
    });
    database.acceptVerifiedDelivery.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- what the wait in line does with it
            reject(signal.reason);
            sawAbort();
          });
        }),
    );
    const origin = await application.listen({ port: 0, host: '127.0.0.1' });
    const sent = request('{}', currentSecret);
    const sender = new AbortController();
    const delivery = fetch(`${origin}${sent.url}`, {
      method: sent.method,
      headers: sent.headers,
      body: sent.payload,
      signal: sender.signal,
    });
    await vi.waitFor(() => {
      expect(database.acceptVerifiedDelivery).toHaveBeenCalled();
    });
    sender.abort();
    await expect(delivery).rejects.toThrow();
    await aborted;
    await delay(20);
    expect(log.error).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalledWith('degraded');
  });

  it('logs the cause of an unexpected acceptance failure', async () => {
    const failure = new Error('connection terminated unexpectedly');
    const log = logger();
    const { application } = setup({
      reference: undefined,
      acceptanceError: failure,
      logger: log,
    });
    expect(
      (await application.inject(request('{}', currentSecret))).statusCode,
    ).toBe(503);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0]).toContain(failure);
  });

  it('logs the cause of an unexpected preflight failure', async () => {
    const failure = new Error('verification read failed');
    const log = logger();
    const fixture = await setupPreflight(undefined, log);
    fixture.database.resolveVerification.mockRejectedValue(failure);
    const response = await fixture.application.inject({
      method: 'OPTIONS',
      url: `/hooks/${endpointKey}`,
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(response.statusCode).toBe(503);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0]).toContain(failure);
  });

  it('logs the cause when the committed response cannot be read', async () => {
    const failure = new Error('response read failed');
    const log = logger();
    const f = setup({ logger: log });
    f.database.acceptVerifiedDelivery.mockResolvedValue({
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
      responseWaitSeconds: 1,
    });
    f.database.readResponse.mockRejectedValue(failure);
    expect(
      (await f.application.inject(request('{}', currentSecret))).statusCode,
    ).toBe(202);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0]).toContain(failure);
  });
});
