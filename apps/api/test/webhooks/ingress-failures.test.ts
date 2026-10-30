import type { StructuredLogger } from '@pertexo/observability';
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
