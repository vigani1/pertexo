import { transportMetrics } from '../support/transport/metrics.js';
import { expect, it } from 'vitest';

it('gives each worker fixture its own metric spies', () => {
  const first = transportMetrics();
  const second = transportMetrics();
  first.recordWorkerProcessStart();
  expect(first.recordWorkerProcessStart).toHaveBeenCalledOnce();
  expect(second.recordWorkerProcessStart).not.toHaveBeenCalled();
  expect(first.observeArtifacts).not.toBe(second.observeArtifacts);
});
