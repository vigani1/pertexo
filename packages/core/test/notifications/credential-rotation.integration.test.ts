import { describe, expect, it } from 'vitest';

import { FailureNotificationStateError } from '../../src/testing.js';
import {
  accessedSecretVersions,
  appendAddress,
  claim,
  claimRetry,
  command,
  complete,
  createConnection,
  destinations,
  emailBinding,
  failedRun,
  fence,
  load,
  rotateCredential,
  secondAddress,
  storedIntent,
  type Alert,
} from './rotation.support.js';
import { asAdmin, workspaceA } from '../runs/run-store/fixtures.js';

describe.each(['email', 'slack'] as const)(
  'a %s alert after its credential rotated',
  (kind) => {
    it('loads the new credential and can end delivered', async () => {
      let rotated = '';
      const alert = await failedRun(kind, async ({ connectionId }) => {
        rotated = await rotateCredential(connectionId);
      });
      const claimed = await claim(alert);

      const destination = await load(alert, claimed.attemptNumber);
      expect(destination).toMatchObject({
        secretVersionId: rotated,
        sealed: { ciphertext: 'rotated-cipher' },
      });
      await fence(
        alert,
        claimed.attemptNumber,
        kind === 'email' ? emailBinding('a') : undefined,
      );
      await expect(
        complete(alert, claimed.attemptNumber, {
          kind: 'delivered',
          possiblyDispatched: true,
          providerReference: 'provider-reference',
        }),
      ).resolves.toBe('completed');

      expect(await storedIntent(alert.intentId)).toMatchObject({
        status: 'delivered',
        safe_error_code: null,
        provider_reference: 'provider-reference',
      });
      expect(await accessedSecretVersions(alert.connectionId)).toEqual([
        rotated,
      ]);
    });
  },
);

describe.each(['email', 'slack'] as const)(
  'a %s destination changed during a run',
  (kind) => {
    const address = (destination: Awaited<ReturnType<typeof load>>): string =>
      destination.kind === 'email'
        ? destination.toEmail
        : destination.channelId;

    it('sends to the appended version, not the one the run started with', async () => {
      const alert = await failedRun(kind, (target) => appendAddress(target));
      const claimed = await claim(alert);

      expect(address(await load(alert, claimed.attemptNumber))).toBe(
        secondAddress(kind),
      );
      await fence(
        alert,
        claimed.attemptNumber,
        kind === 'email' ? emailBinding('a') : undefined,
      );
      expect((await storedIntent(alert.intentId)).status).toBe('dispatching');
    });

    it("uses the credential of the new version's connection", async () => {
      let moved = '';
      const alert = await failedRun(kind, async (target) => {
        const next = await createConnection(kind);
        moved = next.secretVersionId;
        await appendAddress(target, next.connectionId);
      });
      const claimed = await claim(alert);

      const destination = await load(alert, claimed.attemptNumber);
      expect(destination.secretVersionId).toBe(moved);
      expect(address(destination)).toBe(secondAddress(kind));
    });
  },
);

describe('a retry after a definite failure before sending', () => {
  it.each([
    ['email', emailBinding('a'), emailBinding('b')],
    ['slack', undefined, undefined],
  ] as const)(
    'passes the fence for %s with the rotated credential and its own binding',
    async (kind, firstBinding, secondBinding) => {
      const alert = await failedRun(kind);
      const first = await claim(alert);
      await load(alert, first.attemptNumber);
      await fence(alert, first.attemptNumber, firstBinding);
      expect((await storedIntent(alert.intentId)).delivery_binding).toBe(
        firstBinding ?? null,
      );
      await expect(
        complete(alert, first.attemptNumber, {
          kind: 'retry',
          safeErrorCode: 'delivery.provider_unavailable',
          possiblyDispatched: false,
        }),
      ).resolves.toBe('completed');
      const rotated = await rotateCredential(alert.connectionId);

      const retry = await claimRetry(alert);
      expect(retry.deliveryUnresolved).toBe(false);
      await expect(load(alert, retry.attemptNumber)).resolves.toMatchObject({
        secretVersionId: rotated,
      });
      await expect(
        fence(alert, retry.attemptNumber, secondBinding),
      ).resolves.toBeUndefined();

      expect(await storedIntent(alert.intentId)).toMatchObject({
        status: 'dispatching',
        delivery_binding: secondBinding ?? null,
      });
    },
  );
});

describe('an alert with nowhere to go', () => {
  const unavailable: readonly (readonly [
    string,
    (alert: Alert) => Promise<unknown>,
  ])[] = [
    [
      'its destination was disabled',
      (alert) =>
        destinations.setStatus({
          ...command(),
          destinationId: alert.destinationId,
          status: 'disabled',
        }),
    ],
    ...['revoked', 'reauthorization_required'].map(
      (status) =>
        [
          `its connection is ${status}`,
          (alert: Alert) =>
            asAdmin((pool) =>
              pool.query(
                `update app.connections set status=$3,health_revision=health_revision+1,
                        last_health_transition_at=clock_timestamp(),
                        last_health_transition_source='revoke'
                  where workspace_id=$1 and id=$2`,
                [workspaceA, alert.connectionId, status],
              ),
            ),
        ] as const,
    ),
  ];

  it.each(unavailable)(
    'does not send when %s, and is recorded as a dead letter',
    async (_name, makeUnavailable) => {
      const alert = await failedRun('slack');
      await makeUnavailable(alert);
      const claimed = await claim(alert);

      await expect(load(alert, claimed.attemptNumber)).rejects.toBeInstanceOf(
        FailureNotificationStateError,
      );
      await expect(fence(alert, claimed.attemptNumber)).rejects.toBeInstanceOf(
        FailureNotificationStateError,
      );
      expect(await accessedSecretVersions(alert.connectionId)).toEqual([]);

      // What the worker answers when the load is refused on a first send.
      await expect(
        complete(alert, claimed.attemptNumber, {
          kind: 'definite_failure',
          safeErrorCode: 'delivery.destination_unavailable',
          possiblyDispatched: false,
        }),
      ).resolves.toBe('completed');
      expect(await storedIntent(alert.intentId)).toMatchObject({
        status: 'dead_letter',
        safe_error_code: 'delivery.destination_unavailable',
        possibly_dispatched: false,
      });
    },
  );

  it.each(unavailable)(
    'is refused at the fence when %s after it loaded',
    async (_name, makeUnavailable) => {
      const alert = await failedRun('slack');
      const claimed = await claim(alert);
      await load(alert, claimed.attemptNumber);

      await makeUnavailable(alert);

      await expect(fence(alert, claimed.attemptNumber)).rejects.toBeInstanceOf(
        FailureNotificationStateError,
      );
      expect((await storedIntent(alert.intentId)).status).toBe('claimed');
    },
  );
});
