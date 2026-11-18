import type { Meter } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSseVisibilityMetrics,
  SSE_VISIBILITY_METRIC_NAME,
  type SseVisibilityPath,
} from '../../../src/platform/observability/sse-visibility-metrics.js';
import {
  startTelemetrySdk,
  type TelemetrySdk,
} from '../../support/telemetry-sdk.js';

/**
 * A real stream's frames record their path, and nothing else, through the
 * HTTP API in operation-telemetry.integration.test.ts. These cases stay
 * because their inputs need a clock: an exact latency, and a database
 * timestamp from the future, which a real stack never produces on demand.
 * They use the real OpenTelemetry SDK; the last ones replace its meter,
 * because the SDK never throws on demand.
 */
const paths: readonly SseVisibilityPath[] = [
  'initial_backfill',
  'reconnect_backfill',
  'live_wakeup',
  'recovery_backfill',
];
const createdAt = new Date('2026-08-21T12:00:00.000Z');

describe('SSE visibility metrics', () => {
  let sdk: TelemetrySdk | undefined;

  afterEach(async () => {
    await sdk?.stop();
    sdk = undefined;
  });

  function started(): TelemetrySdk {
    sdk = startTelemetrySdk();
    return sdk;
  }

  function record(now: number, path: SseVisibilityPath, at = createdAt) {
    createSseVisibilityMetrics({ now: () => now }).recordFirstEligibleFrame({
      createdAt: at,
      path,
    });
  }

  it.each(paths)('records exact zero latency for the %s path', async (path) => {
    const sdk = started();

    record(createdAt.getTime(), path);

    expect(
      await sdk.points(SSE_VISIBILITY_METRIC_NAME.persistedToVisible),
    ).toMatchObject([
      { attributes: { path }, unit: 's', value: { count: 1, sum: 0 } },
    ]);
    expect(await sdk.points(SSE_VISIBILITY_METRIC_NAME.clockSkew)).toEqual([]);
  });

  it('records exact positive latency labelled only by its path', async () => {
    const sdk = started();

    record(Date.parse('2026-08-21T12:00:02.500Z'), 'live_wakeup');

    const points = await sdk.points(
      SSE_VISIBILITY_METRIC_NAME.persistedToVisible,
    );
    expect(points).toMatchObject([{ value: { count: 1, sum: 2.5 } }]);
    expect(points[0]?.attributes).toEqual({ path: 'live_wakeup' });
  });

  it.each([
    [
      'a future timestamp',
      createdAt.getTime(),
      new Date(createdAt.getTime() + 1),
    ],
    ['an invalid date', createdAt.getTime(), new Date(Number.NaN)],
    ['a non-finite clock', Number.POSITIVE_INFINITY, createdAt],
  ])(
    'counts %s as skew and leaves the latency histogram out',
    async (_name, now, at) => {
      const sdk = started();

      record(now, 'recovery_backfill', at);

      expect(
        await sdk.points(SSE_VISIBILITY_METRIC_NAME.persistedToVisible),
      ).toEqual([]);
      expect(
        await sdk.points(SSE_VISIBILITY_METRIC_NAME.clockSkew),
      ).toMatchObject([
        { attributes: { path: 'recovery_backfill' }, value: 1 },
      ]);
    },
  );

  describe('when the meter or clock fails', () => {
    it.each(['histogram', 'counter'] as const)(
      'falls back to a no-op when the %s cannot be created',
      (instrument) => {
        const failing = (): never => {
          throw new Error(`${instrument} construction failed`);
        };
        const meter = {
          createHistogram:
            instrument === 'histogram'
              ? failing
              : () => ({ record: () => undefined }),
          createCounter:
            instrument === 'counter'
              ? failing
              : () => ({ add: () => undefined }),
        } as unknown as Meter;

        expect(() => {
          createSseVisibilityMetrics({ meter }).recordFirstEligibleFrame({
            createdAt,
            path: 'initial_backfill',
          });
        }).not.toThrow();
      },
    );

    it.each(['clock', 'histogram', 'counter'] as const)(
      'keeps the stream going when the %s throws while recording',
      (failurePoint) => {
        const fails = (point: typeof failurePoint) => () => {
          if (failurePoint === point) throw new Error(`${point} failed`);
        };
        const meter = {
          createHistogram: () => ({ record: fails('histogram') }),
          createCounter: () => ({ add: fails('counter') }),
        } as unknown as Meter;
        const selected = createSseVisibilityMetrics({
          meter,
          now: () => {
            fails('clock')();
            // A reading before the timestamp takes the skew counter's branch.
            return failurePoint === 'counter'
              ? createdAt.getTime() - 1_000
              : createdAt.getTime() + 1_000;
          },
        });

        expect(() => {
          selected.recordFirstEligibleFrame({ createdAt, path: 'live_wakeup' });
        }).not.toThrow();
      },
    );
  });
});
