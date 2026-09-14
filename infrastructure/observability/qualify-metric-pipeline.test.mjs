import assert from 'node:assert/strict';
import test from 'node:test';

import { qualificationPayload } from './qualify-metric-pipeline.mjs';

test('builds independent cumulative counter, gauge, and histogram streams', () => {
  const payload = qualificationPayload(
    'writer-a',
    { counter: 3, gauge: 7, histogramCount: 2, histogramSum: 0.7 },
    1_750_000_000_000,
  );
  const resource = payload.resourceMetrics[0];
  const attributes = Object.fromEntries(
    resource.resource.attributes.map(({ key, value }) => [key, value]),
  );
  const metrics = resource.scopeMetrics[0].metrics;

  assert.deepEqual(attributes['service.instance.id'], {
    stringValue: 'writer-a',
  });
  assert.deepEqual(attributes['host.name'], {
    stringValue: 'must-not-be-exported',
  });
  assert.deepEqual(
    metrics.map(({ name }) => name),
    [
      'pertexo.qualification.operations',
      'pertexo.qualification.load',
      'pertexo.qualification.duration',
    ],
  );
  assert.equal(metrics[0].sum.dataPoints[0].asDouble, 3);
  assert.equal(metrics[1].gauge.dataPoints[0].asDouble, 7);
  assert.equal(metrics[2].histogram.dataPoints[0].count, '2');
  assert.equal(metrics[2].histogram.dataPoints[0].sum, 0.7);
});

test('rejects an unbounded or domain-derived writer identity', () => {
  assert.throws(
    () =>
      qualificationPayload('workspace-customer-id', {
        counter: 1,
        gauge: 1,
        histogramCount: 1,
        histogramSum: 1,
      }),
    /writer ID is invalid/u,
  );
});
