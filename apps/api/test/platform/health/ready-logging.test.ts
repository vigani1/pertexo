import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ApiDrainState } from '../../../src/platform/health/drain-state.js';
import { ReadyController } from '../../../src/platform/health/ready.controller.js';

function controller(check: () => Promise<void>, runtime?: () => Promise<void>) {
  const logger = { warn: vi.fn() };
  const drain = new ApiDrainState();
  return {
    drain,
    logger,
    ready: new ReadyController(
      { checkReadiness: check } as never,
      drain,
      runtime === undefined ? undefined : { checkReadiness: runtime },
      logger,
    ),
  };
}

async function refusal(work: Promise<unknown>) {
  const failure = await work.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ServiceUnavailableException);
  return failure as ServiceUnavailableException;
}

describe('a failed readiness probe', () => {
  it('logs which check failed and answers with no detail', async () => {
    const cause = new Error('password authentication failed for "pertexo_app"');
    const { logger, ready } = controller(() => Promise.reject(cause));

    const failure = await refusal(ready.ready());

    expect(failure.getStatus()).toBe(503);
    expect(failure.getResponse()).toEqual({ status: 'not_ready' });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'health.not_ready',
      {},
      cause,
    );
  });

  it('logs a failed runtime check the same way', async () => {
    const cause = new Error('queue unavailable');
    const { logger, ready } = controller(
      () => Promise.resolve(),
      () => Promise.reject(cause),
    );

    const failure = await refusal(ready.ready());

    expect(failure.getResponse()).toEqual({ status: 'not_ready' });
    expect(logger.warn).toHaveBeenCalledWith('health.not_ready', {}, cause);
  });

  it('answers a drain with the same body and logs nothing', async () => {
    const check = vi.fn(() => Promise.resolve());
    const { drain, logger, ready } = controller(check);
    drain.beginDrain();

    const failure = await refusal(ready.ready());

    expect(failure.getResponse()).toEqual({ status: 'not_ready' });
    expect(check).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays quiet when every check passes', async () => {
    const { logger, ready } = controller(() => Promise.resolve());

    await expect(ready.ready()).resolves.toEqual({ status: 'ready' });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
