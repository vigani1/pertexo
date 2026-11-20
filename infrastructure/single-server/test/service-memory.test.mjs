import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serviceMemoryLimits } from '../storage/service-memory.mjs';

const MIB = 1024 * 1024;

test('an unset or empty setting gives the qualified minimum server', () => {
  for (const environment of [{}, { API_MEMORY_MB: '', WORKER_MEMORY_MB: '' }])
    assert.deepEqual(serviceMemoryLimits(environment), {
      api: { memoryMiB: 512, heapMiB: 256 },
      worker: { memoryMiB: 768, heapMiB: 256, maximumRssBytes: 640 * MIB },
    });
});

test('the worker always drains at least 128 MiB below its cap', () => {
  for (const workerMiB of [512, 600, 768, 1024, 4096]) {
    const { worker } = serviceMemoryLimits({
      WORKER_MEMORY_MB: String(workerMiB),
    });
    assert.ok(workerMiB * MIB - worker.maximumRssBytes >= 128 * MIB);
    assert.ok(worker.heapMiB * MIB < worker.maximumRssBytes);
  }
});

test('a bigger server gives each service a bigger heap and drain budget', () => {
  assert.deepEqual(
    serviceMemoryLimits({ API_MEMORY_MB: '2048', WORKER_MEMORY_MB: '3072' }),
    {
      api: { memoryMiB: 2048, heapMiB: 1024 },
      worker: { memoryMiB: 3072, heapMiB: 1024, maximumRssBytes: 2560 * MIB },
    },
  );
});

test('refuses less than the qualified minimum or a value that is not whole MiB', () => {
  assert.throws(
    () => serviceMemoryLimits({ API_MEMORY_MB: '256' }),
    /API_MEMORY_MB must be at least 512/u,
  );
  assert.throws(
    () => serviceMemoryLimits({ WORKER_MEMORY_MB: '511' }),
    /WORKER_MEMORY_MB must be at least 512/u,
  );
  for (const value of ['1g', '768.5', '-1', ' 768'])
    assert.throws(
      () => serviceMemoryLimits({ WORKER_MEMORY_MB: value }),
      /WORKER_MEMORY_MB must be a whole number of MiB/u,
    );
});
