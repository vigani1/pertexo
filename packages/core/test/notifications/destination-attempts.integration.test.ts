import { describe, expect, it } from 'vitest';
import { atAttempt, delivery } from './delivery-attempt.support.js';
import { accessedSecretVersions, emailBinding } from './rotation.support.js';
import { asAdmin, workspaceA } from '../runs/run-store/run-store.fixture.js';

const load = (alert: Awaited<ReturnType<typeof atAttempt>>) =>
  delivery.loadDestination({
    workspaceId: workspaceA,
    intentId: alert.intentId,
    attemptNumber: alert.attemptNumber,
    workerId: 'attempt-boundary-worker',
    signal: new AbortController().signal,
  });
const stored = (ids: string[]) =>
  asAdmin((pool) =>
    pool.query<{
      id: string;
      status: string;
      delivery_attempts: number;
      dispatch_marked_at: Date | null;
      dispatched_config_version: number | null;
      dispatched_secret_version_id: string | null;
    }>(
      'select id,status,delivery_attempts,dispatch_marked_at,dispatched_config_version,dispatched_secret_version_id from app.run_failure_notification_intents where id=any($1::uuid[]) order by id',
      [ids],
    ),
  );

describe.each([1, 10])(
  'destination delivery at attempt %s',
  (attemptNumber) => {
    it('loads the exact sealed version and records real credential access', async () => {
      const alert = await atAttempt(attemptNumber);
      expect(await load(alert)).toEqual({
        kind: 'email',
        toEmail: 'first@example.test',
        configVersion: 1,
        connectionId: alert.connectionId,
        secretVersionId: alert.pinnedSecretVersionId,
        sealed: {
          kmsKeyReference: 'kms',
          encryptedDataKey: 'key',
          ciphertext: 'first-cipher',
          nonce: 'AAAAAAAAAAAAAAAA',
          tag: 'AAAAAAAAAAAAAAAAAAAAAA',
        },
      });
      expect(await accessedSecretVersions(alert.connectionId)).toEqual([
        alert.pinnedSecretVersionId,
      ]);
      expect((await stored([alert.intentId])).rows).toEqual([
        {
          id: alert.intentId,
          status: 'claimed',
          delivery_attempts: attemptNumber,
          dispatch_marked_at: null,
          dispatched_config_version: null,
          dispatched_secret_version_id: null,
        },
      ]);
    });

    it('fences only the claimed intent once and preserves the first dispatch evidence', async () => {
      const alert = await atAttempt(attemptNumber),
        other = await atAttempt(1);
      const destination = await load(alert);
      const input = {
        workspaceId: workspaceA,
        intentId: alert.intentId,
        attemptNumber,
        destinationIdentity: destination,
        deliveryBinding: emailBinding('a'),
      };
      await delivery.fenceDispatch(input);
      const before = (await stored([alert.intentId, other.intentId])).rows;
      const target = before.find((row) => row.id === alert.intentId);
      expect(target).toMatchObject({
        status: 'dispatching',
        delivery_attempts: attemptNumber,
        dispatched_config_version: 1,
        dispatched_secret_version_id: alert.pinnedSecretVersionId,
      });
      expect(target?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(before.find((row) => row.id === other.intentId)).toMatchObject({
        status: 'claimed',
        dispatch_marked_at: null,
        dispatched_config_version: null,
        dispatched_secret_version_id: null,
      });
      await expect(delivery.fenceDispatch(input)).rejects.toThrow(
        'Delivery dispatch fence failed',
      );
      expect((await stored([alert.intentId, other.intentId])).rows).toEqual(
        before,
      );
      expect(
        (
          await asAdmin((pool) =>
            pool.query(
              'select attempt_number,fact_type from app.run_failure_notification_audit_facts where notification_intent_id=$1 and fact_type=$2',
              [alert.intentId, 'dispatch_marked'],
            ),
          )
        ).rows,
      ).toEqual([
        { attempt_number: attemptNumber, fact_type: 'dispatch_marked' },
      ]);
    });
  },
);
