import { afterAll, beforeAll, expect } from 'vitest';

import { createNotificationDestinationStore } from '../../src/testing.js';
import {
  actorId,
  apiBaseUrl,
  asAdmin,
  asRuntime,
  databaseUrl,
  parseDatabaseConfig,
  randomUUID,
  workerBaseUrl,
  workspaceA,
} from '../runs/run-store/fixtures.js';
import {
  commitPinnedFailureNotificationRun,
  createTestFailureNotificationStore,
  failureNotificationIdentity,
} from '../runs/run-store/scheduling/fixture.js';

// An idempotent send keeps retrying while attempts remain, so two settle it on the retry.
const MAX_ATTEMPTS = 2;

type Kind = 'email' | 'slack';
type Destinations = ReturnType<typeof createNotificationDestinationStore>;
type Delivery = ReturnType<typeof createTestFailureNotificationStore>['store'];

export const emailBinding = (letter: string) =>
  `email:sha256:${letter.repeat(64)}` as const;
const configFor = (kind: Kind, connectionId: string, address: string) =>
  kind === 'email'
    ? { kind, connectionId, toEmail: address }
    : { kind, connectionId, channelId: address };
export const firstAddress = (kind: Kind) =>
  kind === 'email' ? 'first@example.test' : 'CFIRST';
export const secondAddress = (kind: Kind) =>
  kind === 'email' ? 'second@example.test' : 'CSECOND';

let delivery: Delivery;
export let destinations: Destinations;

beforeAll(() => {
  delivery = createTestFailureNotificationStore().store;
  destinations = createNotificationDestinationStore(
    parseDatabaseConfig({
      connectionString: databaseUrl(apiBaseUrl),
      max: 2,
    }),
  );
});

afterAll(async () => {
  await Promise.all([delivery.close(), destinations.close()]);
});

export async function createConnection(kind: Kind) {
  const connectionId = randomUUID();
  const secretVersionId = randomUUID();
  await asAdmin((pool) =>
    pool.query(
      `with connection_row as (
         insert into app.connections (
           id,workspace_id,provider_key,name,auth_type,status,
           current_secret_version_id,created_by
         ) values ($1,$2,$3::text,$4,$5,'active',$6,$7)
       )
       insert into app.connection_secret_versions (
         id,workspace_id,connection_id,kms_key_reference,
         encrypted_data_key,ciphertext,nonce,auth_tag,created_by
       ) values ($6,$2,$1,'kms','key','first-cipher','AAAAAAAAAAAAAAAA',
         'AAAAAAAAAAAAAAAAAAAAAA',$7)`,
      [
        connectionId,
        workspaceA,
        kind,
        `Alert ${connectionId}`,
        kind === 'email' ? 'resend_api_key' : 'slack_bot_token',
        secretVersionId,
        actorId,
      ],
    ),
  );
  return { connectionId, secretVersionId };
}

export async function rotateCredential(connectionId: string): Promise<string> {
  const rotated = randomUUID();
  await asRuntime(apiBaseUrl, workspaceA, async (client) => {
    await client.query(
      `insert into app.connection_secret_versions (
         id,workspace_id,connection_id,kms_key_reference,
         encrypted_data_key,ciphertext,nonce,auth_tag,created_by
       ) values ($1,$2,$3,'kms','key2','rotated-cipher','BBBBBBBBBBBBBBBB',
         'BBBBBBBBBBBBBBBBBBBBBB',$4)`,
      [rotated, workspaceA, connectionId, actorId],
    );
    await client.query(
      `update app.connections
          set current_secret_version_id=$3,health_revision=health_revision+1,
              last_health_transition_at=clock_timestamp(),
              last_health_transition_source='rotation'
        where workspace_id=$1 and id=$2`,
      [workspaceA, connectionId, rotated],
    );
  });
  return rotated;
}

export const command = () => ({
  workspaceId: workspaceA,
  actorId,
  idempotencyKey: randomUUID(),
  requestHash: 'a'.repeat(64),
});

export function appendAddress(
  alert: Readonly<{ kind: Kind; destinationId: string; connectionId: string }>,
  connectionId = alert.connectionId,
) {
  return destinations.appendVersion({
    ...command(),
    destinationId: alert.destinationId,
    expectedVersion: 1,
    config: configFor(alert.kind, connectionId, secondAddress(alert.kind)),
  });
}

/** A run accepted with a real destination, which then fails: `duringRun` sits between the two. */
export async function failedRun(
  kind: Kind,
  duringRun: (
    target: Readonly<{
      kind: Kind;
      connectionId: string;
      destinationId: string;
    }>,
  ) => Promise<unknown> = () => Promise.resolve(),
) {
  const { connectionId, secretVersionId } = await createConnection(kind);
  const destinationId = randomUUID();
  await destinations.create({
    ...command(),
    destinationId,
    config: configFor(kind, connectionId, firstAddress(kind)),
  });
  const target = { kind, connectionId, destinationId };
  const { runId } = await commitPinnedFailureNotificationRun(
    {
      destinationId,
      secretVersionId,
      sideEffectClass: kind === 'email' ? 'idempotent_with_key' : 'unsafe',
    },
    async () => {
      await duringRun(target);
    },
  );
  const identity = await failureNotificationIdentity(runId);
  return {
    ...target,
    pinnedSecretVersionId: secretVersionId,
    intentId: identity.intent_id,
    firstDelivery: {
      outboxEventId: identity.outbox_id,
      payloadChecksum: identity.payload_checksum,
    },
  };
}

export type Alert = Awaited<ReturnType<typeof failedRun>>;

export async function claim(
  alert: Alert,
  outbox: Alert['firstDelivery'] = alert.firstDelivery,
) {
  const claimed = await delivery.claimDelivery({
    workspaceId: workspaceA,
    intentId: alert.intentId,
    delivery: outbox,
    recoverySeconds: 60,
    maxAttempts: MAX_ATTEMPTS,
  });
  if (claimed.kind !== 'ready')
    throw new Error(`Delivery was not claimable: ${claimed.kind}`);
  return claimed;
}

/** The retry's delivery event, made due now so the test doesn't wait for it. */
export async function claimRetry(alert: Alert) {
  const outbox = await asRuntime(workerBaseUrl, workspaceA, async (client) => {
    await client.query(
      `update app.run_failure_notification_intents
          set next_delivery_at=clock_timestamp()-interval '1 second'
        where id=$1`,
      [alert.intentId],
    );
    const { rows } = await client.query<{
      id: string;
      payload_checksum: string;
    }>(
      `select id,payload_checksum from app.outbox_events
        where aggregate_id=$1 order by created_at desc,id desc limit 1`,
      [alert.intentId],
    );
    return rows[0];
  });
  if (outbox === undefined) throw new Error('Retry event is missing');
  return claim(alert, {
    outboxEventId: outbox.id,
    payloadChecksum: outbox.payload_checksum,
  });
}

const attempt = (alert: Alert, attemptNumber: number) => ({
  workspaceId: workspaceA,
  intentId: alert.intentId,
  attemptNumber,
});

export const load = (alert: Alert, attemptNumber: number) =>
  delivery.loadDestination({
    ...attempt(alert, attemptNumber),
    workerId: 'rotation-test-worker',
    signal: new AbortController().signal,
  });

export const fence = (
  alert: Alert,
  attemptNumber: number,
  deliveryBinding?: string,
) =>
  delivery.fenceDispatch({
    ...attempt(alert, attemptNumber),
    ...(deliveryBinding === undefined ? {} : { deliveryBinding }),
  });

export const complete = (
  alert: Alert,
  attemptNumber: number,
  result: Parameters<Delivery['completeDelivery']>[0]['result'],
) =>
  delivery.completeDelivery({
    ...attempt(alert, attemptNumber),
    maxAttempts: MAX_ATTEMPTS,
    retryDelaySeconds: 30,
    result,
  });

/** Attempt 1 goes through the fence and may have reached the provider. */
export async function sendThatMayHaveGoneOut(alert: Alert, binding?: string) {
  const first = await claim(alert);
  const used = await load(alert, first.attemptNumber);
  await fence(alert, first.attemptNumber, binding);
  await expect(
    complete(alert, first.attemptNumber, {
      kind: 'retry',
      safeErrorCode: 'delivery.provider_ambiguous',
      possiblyDispatched: true,
    }),
  ).resolves.toBe('completed');
  return used;
}

export async function storedIntent(intentId: string) {
  const { rows } = await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{
      status: string;
      safe_error_code: string | null;
      possibly_dispatched: boolean | null;
      delivery_binding: string | null;
      provider_reference: string | null;
    }>(
      `select status,safe_error_code,possibly_dispatched,delivery_binding,
              provider_reference
         from app.run_failure_notification_intents where id=$1`,
      [intentId],
    ),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('Intent is missing');
  return row;
}

/** Which credential versions delivery opened for this connection, oldest first. */
export async function accessedSecretVersions(connectionId: string) {
  const { rows } = await asAdmin((pool) =>
    pool.query<{ secret_version_id: string }>(
      `select metadata->>'secretVersionId' secret_version_id
         from app.connection_events
        where workspace_id=$1 and connection_id=$2
          and event_type='connection.credential_accessed'
          and metadata->>'purpose'='failure_notification.deliver'
        order by created_at,id`,
      [workspaceA, connectionId],
    ),
  );
  return rows.map((row) => row.secret_version_id);
}
