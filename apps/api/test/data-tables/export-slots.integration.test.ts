import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import { TableExportAdmission } from '../../src/platform/http/csv/admission.js';
import { assertIntegrationGateConfigured } from '../support/integration-gate.js';

const requested = process.env.REDIS_RATE_LIMIT_INTEGRATION === 'true';
const redisUrl = process.env.REDIS_URL;
assertIntegrationGateConfigured({
  name: 'export concurrency integration',
  requested,
  required: { REDIS_URL: redisUrl },
});

describe.runIf(requested)('export admission on real Redis', () => {
  const runtimes: RedisRateLimitRuntime[] = [];
  function runtime() {
    const value = new RedisRateLimitRuntime(redisUrl ?? '');
    runtimes.push(value);
    return value;
  }
  afterAll(async () => {
    await Promise.all(runtimes.map((value) => value.close()));
  });

  it('allows only one workspace export across API instances and frees the slot on cancellation', async () => {
    const first = new TableExportAdmission(runtime());
    const second = new TableExportAdmission(runtime());
    const workspace = randomUUID();
    const opened = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const download = first.run(workspace, async () => {
      opened.resolve(undefined);
      await release.promise;
      throw new Error('canceled');
    });
    const failed = expect(download).rejects.toThrow('canceled');
    try {
      await opened.promise;
      await expect(
        second.run(workspace, () => Promise.resolve()),
      ).rejects.toThrow('export is already running');
      await expect(
        second.run(randomUUID(), () => Promise.resolve()),
      ).resolves.toBeUndefined();
    } finally {
      release.resolve(undefined);
      await failed;
    }
    await expect(
      second.run(workspace, () => Promise.resolve()),
    ).resolves.toBeUndefined();
  });
  it('expires a crashed owner and refuses to release its successor’s slot', async () => {
    const first = runtime(),
      second = runtime();
    const scope = randomUUID();
    const old = await first.acquireExclusiveSlot(scope, 100);
    expect(old).not.toBeNull();
    const acquired: {
      slot: Awaited<ReturnType<RedisRateLimitRuntime['acquireExclusiveSlot']>>;
    } = { slot: null };
    await expect
      .poll(async () => {
        acquired.slot ??= await second.acquireExclusiveSlot(scope, 10_000);
        return acquired.slot !== null;
      })
      .toBe(true);
    try {
      await old?.release();
      await expect(first.acquireExclusiveSlot(scope, 1000)).resolves.toBeNull();
    } finally {
      await acquired.slot?.release();
    }
    const final = await first.acquireExclusiveSlot(scope, 1000);
    expect(final).not.toBeNull();
    await final?.release();
  });
});
