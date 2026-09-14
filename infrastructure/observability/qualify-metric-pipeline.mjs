import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  describeBoundedChildFailure,
  runBoundedChildProcess,
} from '../bounded-child-process.mjs';

const COLLECTOR_IMAGE =
  'otel/opentelemetry-collector-contrib:0.136.0@sha256:45392d534c1edcc809c2d112394029246bc679d2ae5ea7081414a1fc74f2c621';
const PROMETHEUS_IMAGE =
  'prom/prometheus:v3.6.0@sha256:76947e7ef22f8a698fc638f706685909be425dbe09bd7a2cd7aca849f79b5f64';
const COMMAND_TIMEOUT_MILLISECONDS = 30_000;
const QUALIFICATION_TIMEOUT_MILLISECONDS = 45_000;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function command(args, label) {
  const result = await runBoundedChildProcess('docker', args, {
    timeoutMs: COMMAND_TIMEOUT_MILLISECONDS,
  });
  if (
    result.spawnError !== undefined ||
    result.timedOut ||
    result.signal !== null ||
    result.status !== 0
  )
    throw new Error(
      `${describeBoundedChildFailure(label, result, COMMAND_TIMEOUT_MILLISECONDS)}: ${result.stderr.trim()}`,
    );
  return result.stdout.trim();
}

function exactDockerId(value, label) {
  if (!/^[a-f0-9]{12,64}$/u.test(value))
    throw new Error(`${label} did not return one exact Docker ID`);
  return value;
}

function mappedPort(value, label) {
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(value.trim());
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${label} did not return one loopback TCP port`);
  return port;
}

function metricPoint(value, start, time) {
  return {
    asDouble: value,
    startTimeUnixNano: String(start),
    timeUnixNano: String(time),
  };
}

export function qualificationPayload(
  writerId,
  { counter, gauge, histogramCount, histogramSum },
  nowMilliseconds = Date.now(),
) {
  if (!/^writer-[a-z]$/u.test(writerId))
    throw new TypeError('qualification writer ID is invalid');
  const time = BigInt(nowMilliseconds) * 1_000_000n;
  const start = time - 1_000_000_000n;
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'qualification' } },
            { key: 'service.version', value: { stringValue: '1' } },
            {
              key: 'deployment.environment.name',
              value: { stringValue: 'test' },
            },
            {
              key: 'service.instance.id',
              value: { stringValue: writerId },
            },
            {
              key: 'host.name',
              value: { stringValue: 'must-not-be-exported' },
            },
            { key: 'process.pid', value: { intValue: '4242' } },
            {
              key: 'process.command_args',
              value: { arrayValue: { values: [{ stringValue: 'secret' }] } },
            },
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                description: 'Qualification operations observed by this writer',
                name: 'pertexo.qualification.operations',
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [metricPoint(counter, start, time)],
                  isMonotonic: true,
                },
                unit: '{event}',
              },
              {
                description: 'Qualification load observed by this writer',
                gauge: {
                  dataPoints: [metricPoint(gauge, start, time)],
                },
                name: 'pertexo.qualification.load',
                unit: '1',
              },
              {
                description: 'Qualification operation duration',
                histogram: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    {
                      bucketCounts: ['0', String(histogramCount - 1), '1'],
                      count: String(histogramCount),
                      explicitBounds: [0.1, 0.5],
                      startTimeUnixNano: String(start),
                      sum: histogramSum,
                      timeUnixNano: String(time),
                    },
                  ],
                },
                name: 'pertexo.qualification.duration',
                unit: 's',
              },
            ],
            scope: { name: 'qualification' },
          },
        ],
      },
    ],
  };
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(
      `qualification HTTP request failed with ${response.status}`,
    );
  return response.text();
}

async function eventually(label, action, predicate) {
  const deadline = Date.now() + QUALIFICATION_TIMEOUT_MILLISECONDS;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await action();
      if (predicate(last)) return last;
    } catch (error) {
      last = error;
    }
    await delay(500);
  }
  throw new Error(
    `${label} did not converge before the qualification deadline`,
    {
      cause: last instanceof Error ? last : undefined,
    },
  );
}

async function postMetrics(port, payload) {
  await fetchText(`http://127.0.0.1:${port}/v1/metrics`, {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

function samples(text, metricName) {
  return text.split('\n').filter((line) => line.startsWith(`${metricName}{`));
}

function writerIds(lines) {
  return lines
    .map((line) => /service_instance_id="([^"]+)"/u.exec(line)?.[1])
    .filter((value) => value !== undefined)
    .sort();
}

async function prometheusValue(port, query) {
  const url = new URL(`http://127.0.0.1:${port}/api/v1/query`);
  url.searchParams.set('query', query);
  const payload = JSON.parse(await fetchText(url));
  const value = Number(payload?.data?.result?.[0]?.value?.[1]);
  if (payload.status !== 'success' || !Number.isFinite(value))
    throw new Error(
      `Prometheus query did not return one finite value: ${query}`,
    );
  return value;
}

async function createContainer(owner, args, label) {
  const id = exactDockerId(await command(['create', ...args], label), label);
  owner.containers.push(id);
  await command(['start', id], `start ${label}`);
  return id;
}

async function cleanup(owner, primaryError) {
  const containerResults = await Promise.allSettled(
    owner.containers.map((id) =>
      command(['rm', '--force', id], `remove container ${id}`),
    ),
  );
  const laterResults = await Promise.allSettled([
    ...(owner.networkId === undefined
      ? []
      : [command(['network', 'rm', owner.networkId], 'remove network')]),
    rm(owner.directory, { force: true, recursive: true }),
  ]);
  const failures = [...containerResults, ...laterResults].flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 0) return;
  if (primaryError !== undefined)
    throw new AggregateError(
      [primaryError, ...failures],
      'Metric pipeline qualification and cleanup failed',
    );
  throw new AggregateError(failures, 'Metric pipeline cleanup failed');
}

export async function qualifyMetricPipeline() {
  const assets = resolve('infrastructure/observability');
  const owner = {
    containers: [],
    directory: await mkdtemp(join(tmpdir(), 'pertexo-metric-pipeline-')),
    networkId: undefined,
  };
  let primaryError;
  try {
    const suffix = randomUUID();
    owner.networkId = exactDockerId(
      await command(
        ['network', 'create', `pertexo-metric-${suffix}`],
        'create metric network',
      ),
      'create metric network',
    );
    const collector = await createContainer(
      owner,
      [
        '--name',
        `pertexo-metric-collector-${suffix}`,
        '--network',
        owner.networkId,
        '--network-alias',
        'otel-collector',
        '--read-only',
        '--mount',
        `type=bind,source=${join(assets, 'otel-collector.yaml')},target=/etc/otelcol/config.yaml,readonly`,
        '--publish',
        '127.0.0.1::4318/tcp',
        '--publish',
        '127.0.0.1::9464/tcp',
        COLLECTOR_IMAGE,
        '--config=/etc/otelcol/config.yaml',
      ],
      'create collector',
    );
    const prometheus = await createContainer(
      owner,
      [
        '--name',
        `pertexo-metric-prometheus-${suffix}`,
        '--network',
        owner.networkId,
        '--read-only',
        '--tmpfs',
        '/prometheus:mode=1777',
        '--mount',
        `type=bind,source=${join(assets, 'prometheus.yaml')},target=/etc/prometheus/prometheus.yaml,readonly`,
        '--mount',
        `type=bind,source=${join(assets, 'pertexo-alerts.yaml')},target=/etc/prometheus/pertexo-alerts.yaml,readonly`,
        '--publish',
        '127.0.0.1::9090/tcp',
        PROMETHEUS_IMAGE,
        '--config.file=/etc/prometheus/prometheus.yaml',
      ],
      'create Prometheus',
    );
    const collectorPort = mappedPort(
      await command(['port', collector, '4318/tcp'], 'read collector port'),
      'collector port',
    );
    const prometheusPort = mappedPort(
      await command(['port', prometheus, '9090/tcp'], 'read Prometheus port'),
      'Prometheus port',
    );
    const collectorScrapePort = mappedPort(
      await command(
        ['port', collector, '9464/tcp'],
        'read collector scrape port',
      ),
      'collector scrape port',
    );
    await eventually(
      'collector readiness',
      () =>
        postMetrics(
          collectorPort,
          qualificationPayload('writer-a', {
            counter: 3,
            gauge: 7,
            histogramCount: 2,
            histogramSum: 0.7,
          }),
        ),
      () => true,
    );
    await postMetrics(
      collectorPort,
      qualificationPayload('writer-b', {
        counter: 5,
        gauge: 9,
        histogramCount: 3,
        histogramSum: 1.1,
      }),
    );
    await postMetrics(
      collectorPort,
      qualificationPayload('writer-c', {
        counter: 2,
        gauge: 4,
        histogramCount: 1,
        histogramSum: 0.2,
      }),
    );

    const scrape = await eventually(
      'collector writer separation',
      () => fetchText(`http://127.0.0.1:${collectorScrapePort}/metrics`),
      (text) =>
        samples(text, 'pertexo_qualification_operations_total').length === 3,
    );
    const counterLines = samples(
      scrape,
      'pertexo_qualification_operations_total',
    );
    if (writerIds(counterLines).join(',') !== 'writer-a,writer-b,writer-c')
      throw new Error('collector did not preserve exact writer identities');
    if (/must-not-be-exported|process_pid|process_command_args/u.test(scrape))
      throw new Error(
        'collector exposed a prohibited process or host identity',
      );
    const scrapePath = join(owner.directory, 'collector.metrics');
    await writeFile(scrapePath, scrape, { mode: 0o600 });
    await command(
      [
        'run',
        '--rm',
        '--read-only',
        '--tmpfs',
        '/tmp',
        '--mount',
        `type=bind,source=${scrapePath},target=/qualification.metrics,readonly`,
        '--entrypoint',
        '/bin/sh',
        PROMETHEUS_IMAGE,
        '-c',
        'promtool check metrics < /qualification.metrics',
      ],
      'validate collector scrape',
    );

    const expectations = [
      ['count(pertexo_qualification_operations_total)', 3],
      ['sum(pertexo_qualification_operations_total)', 10],
      ['max(pertexo_qualification_load_ratio)', 9],
      ['sum(pertexo_qualification_duration_seconds_count)', 6],
      ['sum(pertexo_qualification_duration_seconds_sum)', 2],
    ];
    for (const [query, expected] of expectations) {
      await eventually(
        `Prometheus query ${query}`,
        () => prometheusValue(prometheusPort, query),
        (value) => Math.abs(value - expected) < 1e-9,
      );
    }
    return Object.freeze({
      aggregateCounter: 10,
      aggregateGaugeMaximum: 9,
      aggregateHistogramCount: 6,
      aggregateHistogramSum: 2,
      collectorImage: COLLECTOR_IMAGE,
      privacySafe: true,
      prometheusImage: PROMETHEUS_IMAGE,
      restartModel: 'new-writer-series; prior writer remains cached',
      scrapeValid: true,
      writerCount: 3,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanup(owner, primaryError);
  }
}

if (import.meta.main) {
  const result = await qualifyMetricPipeline();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
