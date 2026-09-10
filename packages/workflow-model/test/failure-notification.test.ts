import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  FailureNotificationContextV1Schema,
  FailureNotificationDestinationConfigSchema,
  FailureNotificationDeliveryResultV1Schema,
  FailureNotificationPolicyV1Schema,
} from '../src/failure-notification.js';

const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

const safeCodeSchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);
const predecessorFailureNotificationContextV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    terminalEventSequence: z.number().int().positive(),
    terminalStatus: z.enum(['failed', 'timed_out', 'outcome_unknown']),
    triggerType: z.enum(['api', 'manual', 'replay', 'schedule', 'webhook']),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    primaryFailure: z
      .object({
        nodeId: z.string().min(1).max(128),
        invocationKey: z.string().min(1).max(256),
        nodeStatus: z.enum(['failed', 'timed_out', 'outcome_unknown']),
        attemptNumber: z.number().int().nonnegative(),
        safeErrorCode: safeCodeSchema,
      })
      .strict(),
    totalFailureCount: z.number().int().positive().max(10_000),
  })
  .strict();

async function contextFixture(
  release: 'predecessor' | 'candidate',
): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL(
        `./fixtures/failure-notification-context-${release}-v1.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as unknown;
}

describe('failure notification contracts', () => {
  it('pins predecessor and candidate readers for an additive mixed-version rollout', async () => {
    const predecessor = await contextFixture('predecessor');
    const candidate = await contextFixture('candidate');

    expect(
      predecessorFailureNotificationContextV1Schema.parse(predecessor),
    ).toEqual(predecessor);
    expect(FailureNotificationContextV1Schema.parse(predecessor)).toEqual(
      predecessor,
    );
    expect(FailureNotificationContextV1Schema.parse(candidate)).toEqual(
      candidate,
    );
    expect(
      predecessorFailureNotificationContextV1Schema.safeParse(candidate)
        .success,
    ).toBe(false);
  });

  it('fails closed on unsupported notification context versions in both readers', async () => {
    const predecessor = (await contextFixture('predecessor')) as Record<
      string,
      unknown
    >;

    expect(
      predecessorFailureNotificationContextV1Schema.safeParse({
        ...predecessor,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      FailureNotificationContextV1Schema.safeParse({
        ...predecessor,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
  });

  it('canonicalizes the destination email domain', () => {
    expect(
      FailureNotificationDestinationConfigSchema.parse({
        kind: 'email',
        connectionId: id('1'),
        toEmail: 'Alerts@Example.COM',
      }),
    ).toEqual({
      kind: 'email',
      connectionId: id('1'),
      toEmail: 'Alerts@example.com',
    });
  });

  it('accepts bounded channel-neutral policy, context, and results', () => {
    expect(
      FailureNotificationPolicyV1Schema.parse({
        schemaVersion: 1,
        policyVersion: 1,
        destinationId: id('1'),
        destinationConfigVersion: 3,
        sideEffectClass: 'idempotent_with_key',
      }),
    ).toMatchObject({ policyVersion: 1 });
    expect(
      FailureNotificationContextV1Schema.parse({
        schemaVersion: 1,
        runId: id('2'),
        workflowId: id('3'),
        workflowVersionId: id('4'),
        terminalEventSequence: 7,
        terminalStatus: 'failed',
        triggerType: 'manual',
        startedAt: '2026-08-24T10:00:00.000Z',
        completedAt: '2026-08-24T10:01:00.000Z',
        primaryFailure: {
          nodeId: 'send',
          invocationKey: 'send',
          nodeStatus: 'failed',
          attemptNumber: 2,
          safeErrorCode: 'provider.unavailable',
        },
        totalFailureCount: 1,
      }),
    ).toMatchObject({ totalFailureCount: 1 });
    expect(
      FailureNotificationContextV1Schema.parse({
        schemaVersion: 1,
        runId: id('2'),
        workflowId: id('3'),
        workflowVersionId: id('4'),
        terminalEventSequence: 7,
        terminalStatus: 'timed_out',
        triggerType: 'manual',
        startedAt: '2026-08-24T10:00:00.000Z',
        completedAt: '2026-08-24T10:01:00.000Z',
        primaryFailure: {
          source: 'run',
          runStatus: 'timed_out',
          safeErrorCode: 'execution.deadline_exceeded',
        },
        totalFailureCount: 1,
      }),
    ).toMatchObject({ primaryFailure: { source: 'run' } });
    expect(
      FailureNotificationDeliveryResultV1Schema.parse({
        schemaVersion: 1,
        kind: 'delivered',
        possiblyDispatched: true,
        providerReference: 'opaque-123',
      }),
    ).toMatchObject({ kind: 'delivered' });
  });

  it('rejects unsafe detail and unbounded fields', () => {
    const base = {
      schemaVersion: 1,
      runId: id('2'),
      workflowId: id('3'),
      workflowVersionId: id('4'),
      terminalEventSequence: 7,
      terminalStatus: 'failed',
      triggerType: 'manual',
      startedAt: '2026-08-24T10:00:00.000Z',
      completedAt: '2026-08-24T10:01:00.000Z',
      primaryFailure: {
        nodeId: 'send',
        invocationKey: 'send',
        nodeStatus: 'failed',
        attemptNumber: 1,
        safeErrorCode: 'provider.failure',
      },
      totalFailureCount: 1,
    };
    for (const extra of [
      { errorSummary: 'secret response body' },
      { input: { token: 'secret' } },
      { actorId: id('5') },
      { connectionId: id('6') },
    ]) {
      expect(
        FailureNotificationContextV1Schema.safeParse({ ...base, ...extra })
          .success,
      ).toBe(false);
    }
    expect(
      FailureNotificationDeliveryResultV1Schema.safeParse({
        schemaVersion: 1,
        kind: 'definite_failure',
        possiblyDispatched: false,
        safeErrorCode: 'UPPER CASE AND UNSAFE',
      }).success,
    ).toBe(false);
    expect(
      FailureNotificationContextV1Schema.safeParse({
        ...base,
        terminalStatus: 'timed_out',
        primaryFailure: {
          source: 'run',
          runStatus: 'timed_out',
          safeErrorCode: 'execution.deadline_exceeded',
          nodeId: 'invented-node',
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['delivered without dispatch', 'delivered', false, undefined],
    ['definite failure after dispatch', 'definite_failure', true, 'failure'],
    ['unknown before dispatch', 'outcome_unknown', false, 'unknown'],
    ['failure with provider reference', 'definite_failure', false, 'failure'],
  ])(
    'rejects contradictory delivery state: %s',
    (_name, kind, possiblyDispatched, safeErrorCode) => {
      expect(
        FailureNotificationDeliveryResultV1Schema.safeParse({
          schemaVersion: 1,
          kind,
          possiblyDispatched,
          ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
          ...(kind === 'definite_failure' && !possiblyDispatched
            ? { providerReference: 'not-valid-on-failure' }
            : {}),
        }).success,
      ).toBe(false);
    },
  );
});
