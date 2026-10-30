import { AbuseRateLimitPolicy } from '@pertexo/rate-limit';
import { describe, expect, it, vi } from 'vitest';

import {
  admitRateLimit,
  type RateLimitMetricRecorder,
} from '../../src/platform/rate-limit/admission.js';

const policy = new AbuseRateLimitPolicy();
const closed = policy.evaluate('callback_ingress', {
  clientAddress: '203.0.113.1',
  tokenId: 'token',
});
const open = policy.evaluate('authenticated_read', {
  actorId: 'actor',
  workspaceId: 'workspace',
});

function recorder() {
  return { record: vi.fn<RateLimitMetricRecorder['record']>() };
}

describe('admitRateLimit', () => {
  it('admits an allowed request and records it', async () => {
    const metrics = recorder();
    await expect(
      admitRateLimit(
        { consume: () => Promise.resolve({ allowed: true }) },
        metrics,
        closed,
      ),
    ).resolves.toEqual({ kind: 'admitted' });
    expect(metrics.record).toHaveBeenCalledExactlyOnceWith({
      endpointClass: 'callback_ingress',
      failureMode: 'closed',
      outcome: 'allowed',
    });
  });

  it('reports a limit with its delay and the dimension that hit it', async () => {
    const metrics = recorder();
    await expect(
      admitRateLimit(
        {
          consume: () =>
            Promise.resolve({
              allowed: false,
              retryAfterSeconds: 7,
              limitedDimension: 'token',
            }),
        },
        metrics,
        closed,
      ),
    ).resolves.toEqual({ kind: 'limited', retryAfterSeconds: 7 });
    expect(metrics.record).toHaveBeenCalledExactlyOnceWith({
      endpointClass: 'callback_ingress',
      failureMode: 'closed',
      outcome: 'limited',
      limitedDimension: 'token',
    });
  });

  it('refuses when a fail-closed backend is down and keeps the cause', async () => {
    const failure = new Error('redis endpoint unavailable');
    const metrics = recorder();
    await expect(
      admitRateLimit(
        { consume: () => Promise.reject(failure) },
        metrics,
        closed,
      ),
    ).resolves.toEqual({ kind: 'unavailable', cause: failure });
    expect(metrics.record).toHaveBeenCalledExactlyOnceWith({
      endpointClass: 'callback_ingress',
      failureMode: 'closed',
      outcome: 'backend_error',
    });
  });

  it('admits when a fail-open backend is down, and still records the error', async () => {
    const metrics = recorder();
    await expect(
      admitRateLimit(
        { consume: () => Promise.reject(new Error('down')) },
        metrics,
        open,
      ),
    ).resolves.toEqual({ kind: 'admitted' });
    expect(metrics.record).toHaveBeenCalledExactlyOnceWith({
      endpointClass: 'authenticated_read',
      failureMode: 'open',
      outcome: 'backend_error',
    });
  });

  it('does not let a broken recorder change the decision', async () => {
    await expect(
      admitRateLimit(
        { consume: () => Promise.resolve({ allowed: true }) },
        {
          record: () => {
            throw new Error('metrics down');
          },
        },
        closed,
      ),
    ).resolves.toEqual({ kind: 'admitted' });
  });
});
