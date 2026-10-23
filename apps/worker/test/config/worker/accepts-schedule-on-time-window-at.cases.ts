import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';
import { ZodError } from 'zod';
import { parseWorkerConfig } from '../../../src/config/worker.js';
import { requiredEnvironment } from './fixture.js';

export function registerAcceptsScheduleOnTimeWindowAt(): void {
  it.each([
    ['60', '60000', 60],
    ['3600', '10', 3_600],
  ])(
    'accepts a schedule on-time window at its bounds (%s s, poll %s ms)',
    (window, poll, expected) => {
      expect(
        parseWorkerConfig({
          ...requiredEnvironment,
          TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS: window,
          TRIGGER_SCHEDULE_POLL_MILLIS: poll,
        }).triggerRuntime,
      ).toMatchObject({
        onTimeWindowSeconds: expected,
        pollIntervalMillis: Number(poll),
      });
    },
  );

  it('never lets the schedule on-time window fall below the poll interval', () => {
    // The individual bounds already imply this (a window of at least a minute,
    // a poll of at most one), so it is shown with a poll past its own bound.
    let thrown: unknown;
    try {
      parseWorkerConfig({
        ...requiredEnvironment,
        TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS: '60',
        TRIGGER_SCHEDULE_POLL_MILLIS: '60001',
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const cause = (thrown as Error).cause;
    expect(cause).toBeInstanceOf(ZodError);
    expect(
      (cause as ZodError).issues.map(({ path, message }) => ({
        path,
        message,
      })),
    ).toContainEqual({
      path: ['TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS'],
      message: 'Schedule on-time window must not be shorter than its poll',
    });
  });

  it('rejects a node-attempt heartbeat that cannot renew before lease expiry', () => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        NODE_ATTEMPT_LEASE_SECONDS: '5',
        NODE_ATTEMPT_HEARTBEAT_MILLIS: '5000',
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it('accepts the last heartbeat millisecond before lease expiry', () => {
    expect(
      parseWorkerConfig({
        ...requiredEnvironment,
        NODE_ATTEMPT_HEARTBEAT_MILLIS: 4_999,
        NODE_ATTEMPT_LEASE_SECONDS: 5,
      }).nodeAttempt,
    ).toEqual({
      heartbeatIntervalMillis: 4_999,
      leaseDurationSeconds: 5,
      workerId: 'worker-local',
    });
  });

  it.each([
    ['WORKER_MAX_EVENT_LOOP_DELAY_MILLIS', 0],
    ['WORKER_MAX_RSS_BYTES', 0],
    ['WORKER_RESOURCE_UNHEALTHY_SAMPLES', 0],
    ['WORKER_RESOURCE_UNHEALTHY_SAMPLES', 13],
  ] as const)('rejects an invalid resource bound (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({ ...requiredEnvironment, [name]: value }),
    ).toThrow(/invalid worker configuration/iu);
  });

  it('rejects an unsupported log level before the worker starts', () => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        LOG_LEVEL: 'verbose',
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it('starts from the shared local example environment', () => {
    // Developers copy .env.example to .env and start the API and worker from it.
    const config = parseWorkerConfig(
      parseEnv(
        readFileSync(
          new URL('../../../../../.env.example', import.meta.url),
          'utf8',
        ),
      ),
    );

    expect(config.nodeEnv).toBe('development');
    expect(config.invitationDelivery).toBeUndefined();
    expect(config.retention.maintenanceDatabase).toBeDefined();
  });
}
