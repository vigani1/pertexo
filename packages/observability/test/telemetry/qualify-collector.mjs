import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { metrics, trace } from '@opentelemetry/api';
import {
  createTelemetryLifecycle,
  parseObservabilityConfig,
} from '../../dist/startup.js';
import {
  describeBoundedChildFailure,
  runBoundedChildProcess,
} from '../../../../infrastructure/support/bounded-child-process.mjs';

const root = new URL('../../../../', import.meta.url);
const name = `pertexo-otel-4600-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), 'pertexo-otel-'));
let container;
let lifecycle;

async function docker(args) {
  const result = await runBoundedChildProcess('docker', args, {
    cwd: root,
    timeoutMs: 60_000,
  });
  if (result.status !== 0 || result.timedOut || result.spawnError)
    throw new Error(
      `${describeBoundedChildFailure('SDK collector qualification', result, 60_000)}: ${result.stderr}`,
    );
  return (
    args[0] === 'logs' ? result.stdout + result.stderr : result.stdout
  ).trim();
}

async function eventually(operation) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(250);
    }
  }
}

try {
  const compose = JSON.parse(
    await docker([
      'compose',
      '-f',
      'infrastructure/observability/compose.yaml',
      'config',
      '--format',
      'json',
    ]),
  );
  const config = await readFile(
    new URL('infrastructure/observability/otel-collector.yaml', root),
    'utf8',
  );
  // Keep the production processors and exporters; expose span details for proof.
  await writeFile(
    join(directory, 'collector.yaml'),
    config.replace('verbosity: basic', 'verbosity: detailed'),
  );
  container = await docker([
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '--memory',
    '384m',
    '-p',
    '127.0.0.1:5460:4318',
    '-p',
    '127.0.0.1:5470:9464',
    '-v',
    `${directory}/collector.yaml:/etc/otelcol/config.yaml:ro`,
    compose.services['otel-collector'].image,
    '--config=/etc/otelcol/config.yaml',
  ]);
  assert.match(container, /^[a-f0-9]{64}$/u);
  await eventually(async () => {
    const response = await fetch('http://127.0.0.1:5470/metrics', {
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(response.status, 200);
  });

  lifecycle = createTelemetryLifecycle(
    parseObservabilityConfig({
      environment: 'test',
      serviceName: 'pertexo-sdk-qualification',
      serviceVersion: '3',
      otlpHttpEndpoint: 'http://127.0.0.1:5460',
    }),
  );
  lifecycle.start();
  const tracer = trace.getTracer('collector-qualification');
  const counter = metrics
    .getMeter('collector-qualification')
    .createCounter('pertexo.sdk.qualification.operations');
  let traceId;
  let parentId;
  let childId;
  tracer.startActiveSpan('pertexo.sdk.qualification.parent', (parent) => {
    traceId = parent.spanContext().traceId;
    parentId = parent.spanContext().spanId;
    const child = tracer.startSpan('pertexo.sdk.qualification.child');
    childId = child.spanContext().spanId;
    assert.equal(child.spanContext().traceId, traceId);
    counter.add(7, { operation: 'qualification' });
    child.end();
    parent.end();
  });
  assert.notEqual(traceId, '0'.repeat(32));
  await lifecycle.flush();
  await lifecycle.shutdown();

  await eventually(async () => {
    const response = await fetch('http://127.0.0.1:5470/metrics', {
      signal: AbortSignal.timeout(1000),
    });
    const body = await response.text();
    assert.match(
      body,
      /^pertexo_sdk_qualification_operations_total\{[^\n]*operation="qualification"[^\n]*\} 7$/mu,
    );
    assert.match(body, /service_name="pertexo-sdk-qualification"/u);
    const spans = await docker(['logs', container]);
    assert.ok(spans.includes('pertexo.sdk.qualification.parent'));
    assert.ok(spans.includes('pertexo.sdk.qualification.child'));
    for (const id of [traceId, parentId, childId])
      assert.ok(spans.includes(id));
    assert.match(spans, new RegExp(`Parent ID\\s*:\\s*${parentId}`, 'u'));
    assert.doesNotMatch(spans, /-> (?:process\.pid|host\.name):/u);
  });
  console.log(
    JSON.stringify({ sdk: '3', traces: 2, parentContext: true, counter: 7 }),
  );
} finally {
  try {
    await lifecycle?.shutdown();
  } finally {
    try {
      // The unique name also owns cleanup if Docker started but lost its reply.
      await docker(['rm', '-f', container ?? name]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
