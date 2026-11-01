import { randomUUID } from 'node:crypto';

import { createNotificationDestinationStore } from '@pertexo/core/notifications';
import { createFailureNotificationStore } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { JOB_NAME } from '@pertexo/queue';
import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/integrations/server';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FIRST_CIPHERTEXT,
  ROTATED_CIPHERTEXT,
  deliveryHarness,
  type EmailAnswer,
} from './credential-rotation.support.js';
import { coordinatorFixture as fixture } from '../support/coordinator/consumer.js';
import {
  acceptRun,
  terminalizeFailedRun,
} from '../support/coordinator/runs.js';

const { actorId, workflowId, workspaceId } = fixture;
const describeIntegration = fixture.enabled ? describe : describe.skip;

type Kind = 'email' | 'slack';

let store: ReturnType<typeof createFailureNotificationStore>;
let destinations: ReturnType<typeof createNotificationDestinationStore>;

const command = () => ({
  workspaceId,
  actorId,
  idempotencyKey: randomUUID(),
  requestHash: 'a'.repeat(64),
});

async function asAdmin(text: string, values: unknown[]) {
  const pool = new Pool({
    connectionString: fixture.databaseUrl(fixture.adminUrl),
    max: 1,
  });
  try {
    await pool.query(text, values);
  } finally {
    await pool.end();
  }
}

async function createTarget(kind: Kind, address: string) {
  const connectionId = randomUUID();
  const secretVersionId = randomUUID();
  await asAdmin(
    `with connection_row as (
       insert into app.connections (
         id,workspace_id,provider_key,name,auth_type,status,
         current_secret_version_id,created_by
       ) values ($1,$2,$3::text,$4,$5,'active',$6,$7)
     )
     insert into app.connection_secret_versions (
       id,workspace_id,connection_id,kms_key_reference,
       encrypted_data_key,ciphertext,nonce,auth_tag,created_by
     ) values ($6,$2,$1,'kms','key',$8,'AAAAAAAAAAAAAAAA',
       'AAAAAAAAAAAAAAAAAAAAAA',$7)`,
    [
      connectionId,
      workspaceId,
      kind,
      `Rotation ${connectionId}`,
      kind === 'email' ? 'resend_api_key' : 'slack_bot_token',
      secretVersionId,
      actorId,
      kind === 'email' ? FIRST_CIPHERTEXT : `slack-${FIRST_CIPHERTEXT}`,
    ],
  );
  const destinationId = randomUUID();
  const config =
    kind === 'email'
      ? ({ kind, connectionId, toEmail: address } as const)
      : ({ kind, connectionId, channelId: address } as const);
  await destinations.create({ ...command(), destinationId, config });
  await destinations.setWorkflowPolicy({
    ...command(),
    workflowId,
    destinationId,
  });
  return { connectionId, destinationId, secretVersionId };
}

async function rotateCredential(kind: Kind, connectionId: string) {
  const rotated = randomUUID();
  await asAdmin(
    `with secret_row as (
       insert into app.connection_secret_versions (
         id,workspace_id,connection_id,kms_key_reference,
         encrypted_data_key,ciphertext,nonce,auth_tag,created_by
       ) values ($1,$2,$3,'kms','key2',$5,'BBBBBBBBBBBBBBBB',
         'BBBBBBBBBBBBBBBBBBBBBB',$4)
     )
     update app.connections
        set current_secret_version_id=$1,health_revision=health_revision+1,
            last_health_transition_at=clock_timestamp(),
            last_health_transition_source='rotation'
      where workspace_id=$2 and id=$3`,
    [
      rotated,
      workspaceId,
      connectionId,
      actorId,
      kind === 'email' ? ROTATED_CIPHERTEXT : `slack-${ROTATED_CIPHERTEXT}`,
    ],
  );
  return rotated;
}

async function storedIntent(intentId: string) {
  const [row] = await fixture.workerQuery<{
    status: string;
    safe_error_code: string | null;
    delivery_binding: string | null;
    possibly_dispatched: boolean | null;
  }>(
    `select status,safe_error_code,delivery_binding,possibly_dispatched
       from app.run_failure_notification_intents
      where workspace_id=$1 and id=$2`,
    [workspaceId, intentId],
  );
  if (row === undefined) throw new Error('Intent is missing');
  return row;
}

/** Hands the worker the intent's newest delivery job, due now. */
async function runDelivery(
  harness: ReturnType<typeof deliveryHarness>,
  intentId: string,
) {
  await fixture.workerQuery(
    `update app.run_failure_notification_intents
        set next_delivery_at=clock_timestamp()-interval '1 second'
      where id=$1 and status='retry'`,
    [intentId],
  );
  const [outbox] = await fixture.workerQuery<{
    payload: Parameters<typeof harness.handler.handle>[0]['data'];
  }>(
    `select payload from app.outbox_events
      where workspace_id=$1 and aggregate_id=$2
        and job_name='deliver-run-failure-notification'
      order by created_at desc,id desc limit 1`,
    [workspaceId, intentId],
  );
  if (outbox === undefined) throw new Error('Delivery job is missing');
  await harness.handler.handle(
    {
      name: JOB_NAME.deliverRunFailureNotification,
      data: outbox.payload,
      transport: {
        attemptsMade: 0,
        jobId: `outbox-${outbox.payload.outboxEventId}`,
      },
    },
    { signal: new AbortController().signal },
  );
}

const failRun = async (accepted: Awaited<ReturnType<typeof acceptRun>>) =>
  (await terminalizeFailedRun(accepted)).intentId;

const maySendAndLoseTheAnswer: EmailAnswer = async (send) => {
  await send();
  throw new SecureHttpError(SECURE_HTTP_ERROR_CODE.timedOut, 'ambiguous', {
    possiblyDispatched: true,
  });
};

const failBeforeReachingProvider: EmailAnswer = async (send) => {
  await send();
  return { kind: 'rate_limited' };
};

describeIntegration('failure alerts through a rotated credential', () => {
  beforeAll(async () => {
    await fixture.setup();
    const config = (url: string) =>
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(url),
        max: 3,
      });
    store = createFailureNotificationStore(config(fixture.workerUrl));
    destinations = createNotificationDestinationStore(config(fixture.apiUrl));
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([store.close(), destinations.close()]);
    await fixture.restoreServicesAndClose();
  });

  it.each([
    ['email', 'ops@example.test'],
    ['slack', 'COPS'],
  ] as const)(
    'delivers a %s alert with the new credential when it rotated during the run',
    async (kind, address) => {
      const harness = deliveryHarness(store);
      const { connectionId } = await createTarget(kind, address);
      const accepted = await acceptRun();
      await rotateCredential(kind, connectionId);
      const intentId = await failRun(accepted);

      await runDelivery(harness, intentId);

      expect(await storedIntent(intentId)).toMatchObject({
        status: 'delivered',
        safe_error_code: null,
      });
      if (kind === 'email')
        expect(harness.emails).toEqual([
          { apiKey: `re_${ROTATED_CIPHERTEXT}`, toEmail: address },
        ]);
      else
        expect(harness.slackMessages).toEqual([
          { botToken: `xoxb-slack-${ROTATED_CIPHERTEXT}`, channelId: address },
        ]);
    },
  );

  it('sends to the new Slack channel when a version is appended during the run', async () => {
    const harness = deliveryHarness(store);
    const { connectionId, destinationId } = await createTarget('slack', 'COLD');
    const accepted = await acceptRun();
    await destinations.appendVersion({
      ...command(),
      destinationId,
      expectedVersion: 1,
      config: { kind: 'slack', connectionId, channelId: 'CNEW' },
    });
    const intentId = await failRun(accepted);

    await runDelivery(harness, intentId);

    expect(harness.slackMessages.map(({ channelId }) => channelId)).toEqual([
      'CNEW',
    ]);
    expect((await storedIntent(intentId)).status).toBe('delivered');
  });

  it('settles as outcome unknown, without sending or opening the new credential, when it rotated after a send that may have gone out', async () => {
    const harness = deliveryHarness(store);
    const { connectionId } = await createTarget('email', 'ops@example.test');
    const intentId = await failRun(await acceptRun());
    harness.answers.push(maySendAndLoseTheAnswer);

    await runDelivery(harness, intentId);
    expect(await storedIntent(intentId)).toMatchObject({
      status: 'retry',
      possibly_dispatched: true,
    });
    await rotateCredential('email', connectionId);

    await runDelivery(harness, intentId);

    expect(await storedIntent(intentId)).toMatchObject({
      status: 'outcome_unknown',
      safe_error_code: 'delivery.identity_changed',
      possibly_dispatched: true,
    });
    expect(harness.opened).toEqual([FIRST_CIPHERTEXT]);
    expect(harness.emails).toHaveLength(0);
  });

  it('delivers an email retry with the new credential and a new binding after a definite failure before sending', async () => {
    const harness = deliveryHarness(store);
    const { connectionId } = await createTarget('email', 'ops@example.test');
    const intentId = await failRun(await acceptRun());
    harness.answers.push(failBeforeReachingProvider);

    await runDelivery(harness, intentId);
    const first = await storedIntent(intentId);
    expect(first).toMatchObject({
      status: 'retry',
      possibly_dispatched: false,
    });
    expect(first.delivery_binding).toMatch(/^email:sha256:/u);
    await rotateCredential('email', connectionId);

    await runDelivery(harness, intentId);

    const second = await storedIntent(intentId);
    expect(second.status).toBe('delivered');
    expect(second.delivery_binding).toMatch(/^email:sha256:/u);
    expect(second.delivery_binding).not.toBe(first.delivery_binding);
    expect(harness.emails.at(-1)).toMatchObject({
      apiKey: `re_${ROTATED_CIPHERTEXT}`,
    });
  });

  it.each([
    [
      'its destination was disabled',
      ({ destinationId }: Awaited<ReturnType<typeof createTarget>>) =>
        destinations.setStatus({
          ...command(),
          destinationId,
          status: 'disabled',
        }),
    ],
    [
      'its connection was revoked',
      ({ connectionId }: Awaited<ReturnType<typeof createTarget>>) =>
        asAdmin(
          `update app.connections set status='revoked',health_revision=health_revision+1,
                  last_health_transition_at=clock_timestamp(),
                  last_health_transition_source='revoke'
            where workspace_id=$1 and id=$2`,
          [workspaceId, connectionId],
        ),
    ],
  ] as const)(
    'records a dead letter and sends nothing when %s',
    async (_name, makeUnavailable) => {
      const harness = deliveryHarness(store);
      const target = await createTarget('slack', 'COPS');
      const intentId = await failRun(await acceptRun());
      await makeUnavailable(target);

      await runDelivery(harness, intentId);

      expect(await storedIntent(intentId)).toMatchObject({
        status: 'dead_letter',
        safe_error_code: 'delivery.destination_unavailable',
        possibly_dispatched: false,
      });
      expect(harness.slackMessages).toEqual([]);
      expect(harness.opened).toEqual([]);
    },
  );
});
