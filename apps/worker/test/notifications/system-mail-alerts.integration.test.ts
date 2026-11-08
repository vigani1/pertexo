import { randomUUID } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import * as notifications from '@pertexo/core/notifications';
import { createRetentionStore } from '@pertexo/core/lifecycle';
import {
  createApplicationSecretEnvelope,
  createSystemMailDeliveryStore,
  createSystemMailDeliveryHandler,
  createSmtpClient,
} from '@pertexo/secrets/server';
import { FailureNotificationDestinationConfigSchema } from '@pertexo/workflow-model';
import { sealFailureAlert } from '../../src/mail/failure-alert-content.js';
import { coordinatorFixture as fixture } from '../support/coordinator/consumer.js';
import {
  acceptRun,
  terminalizeFailedRun,
} from '../support/coordinator/runs.js';

const config = () =>
  parseDatabaseConfig({
    connectionString: fixture.databaseUrl(fixture.apiUrl),
    max: 3,
  });
const maintenance = () =>
  parseDatabaseConfig({
    connectionString: fixture.databaseUrl(
      process.env.DATABASE_MAINTENANCE_URL ?? '',
    ),
    max: 2,
  });
const envelope = createApplicationSecretEnvelope({
  current: { version: 'alert-v1', key: Buffer.alloc(32, 9).toString('base64') },
  previous: [],
});
const messages: string[] = [];
let port = 0;
const relay = new SMTPServer({
  logger: false,
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData: (stream, _session, callback) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    stream.on('end', () => {
      messages.push(Buffer.concat(chunks).toString());
      callback();
    });
  },
});
let destinations: ReturnType<
  typeof notifications.createNotificationDestinationStore
>;
let store: ReturnType<typeof notifications.createFailureNotificationStore>;
let mail: ReturnType<typeof createSystemMailDeliveryStore>;
let handler: ReturnType<typeof createSystemMailDeliveryHandler>;
let failSeal = false;
let authorize: (id: string, toEmail: string) => Promise<boolean>;
function createStore() {
  return notifications.createFailureNotificationStore(config(), undefined, {
    systemMail: (input) => {
      if (failSeal) throw new Error('Owned sealer unavailable');
      return sealFailureAlert(
        envelope,
        'server@example.test',
        'https://app.example.test',
        input,
      );
    },
  });
}

describe.runIf(fixture.enabled)(
  'shared failure alerts through durable system mail',
  () => {
    beforeAll(async () => {
      await fixture.setup();
      await new Promise<void>((resolve) => {
        relay.listen(0, '127.0.0.1', resolve);
      });
      const address = relay.server.address();
      if (!address || typeof address === 'string')
        throw new Error('Relay did not listen');
      port = address.port;
      destinations = notifications.createNotificationDestinationStore(config());
      store = createStore();
      mail = createSystemMailDeliveryStore(config());
      let authorizer:
        | ReturnType<
            typeof notifications.createFailureNotificationMailAuthorizer
          >
        | undefined;
      const failureAlerts = {
        authorize: (id: string, toEmail: string) => {
          authorizer ??= notifications.createFailureNotificationMailAuthorizer(
            config(),
            maintenance(),
          );
          return authorizer.authorize(id, toEmail);
        },
      };
      authorize = failureAlerts.authorize;
      handler = createSystemMailDeliveryHandler({
        store: mail,
        envelope,
        email: createSmtpClient({
          mode: 'smtp',
          host: '127.0.0.1',
          port,
          tls: 'none',
        }),
        timeoutMillis: 3000,
        workerId: 'system-alert-proof',
        failureAlerts,
      });
      closeAuthorizer = async () => {
        await authorizer?.close();
      };
    }, 60_000);
    let closeAuthorizer = () => Promise.resolve();
    afterAll(async () => {
      await Promise.allSettled([
        destinations.close(),
        store.close(),
        mail.close(),
        closeAuthorizer(),
      ]);
      await new Promise<void>((resolve) => {
        relay.close(resolve);
      });
      await fixture.restoreServicesAndClose();
    });

    async function prepare() {
      const memberId = randomUUID();
      const toEmail = `${memberId}@example.test`;
      await fixture.ownerQuery(
        "insert into app.users(id,email,display_name,status,email_verified) values($1,$2,'Alert member','active',true)",
        [memberId, toEmail],
      );
      await fixture.ownerQuery(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')",
        [fixture.workspaceId, memberId],
      );
      // Personal mail is explicitly off; a shared destination is independent.
      await fixture.ownerQuery(
        "insert into app.notice_preferences(workspace_id,user_id,mode) values($1,$2,'off')",
        [fixture.workspaceId, memberId],
      );
      const destinationId = randomUUID();
      await destinations.create({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        destinationId,
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        config: FailureNotificationDestinationConfigSchema.parse({
          kind: 'system_mail',
          memberId,
        }),
      });
      await destinations.setWorkflowPolicy({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        workflowId: fixture.workflowId,
        destinationId,
        idempotencyKey: randomUUID(),
        requestHash: 'b'.repeat(64),
      });
      const { intentId } = await terminalizeFailedRun(await acceptRun());
      const [event] = await fixture.workerQuery<{
        id: string;
        payload_checksum: string;
      }>(
        "select id,payload_checksum from app.outbox_events where aggregate_id=$1 and job_name='deliver-run-failure-notification' limit 1",
        [intentId],
      );
      if (event === undefined)
        throw new Error('A failed run must create its alert intent');
      const claim = () =>
        store.claimDelivery({
          workspaceId: fixture.workspaceId,
          intentId,
          delivery: {
            outboxEventId: event.id,
            payloadChecksum: event.payload_checksum,
          },
          recoverySeconds: 30,
          maxAttempts: 3,
        });
      return { memberId, toEmail, destinationId, intentId, claim };
    }
    async function state(intentId: string) {
      return (
        await fixture.workerQuery(
          'select status,safe_error_code,possibly_dispatched from app.run_failure_notification_intents where id=$1',
          [intentId],
        )
      )[0];
    }
    async function reconcile(intentId: string) {
      await fixture.workerQuery(
        "update app.run_failure_notification_intents set recovery_at=clock_timestamp()-interval '1 second' where id=$1",
        [intentId],
      );
      await store.recoverDue(10, 3);
    }
    it('queues atomically with the intent ID and completes only after real SMTP acceptance, ignoring personal preferences', async () => {
      const f = await prepare();
      failSeal = true;
      await expect(f.claim()).rejects.toThrow('Owned sealer unavailable');
      expect(await state(f.intentId)).toMatchObject({ status: 'pending' });
      expect(
        await fixture.ownerQuery(
          'select id from app.system_mail_deliveries where id=$1',
          [f.intentId],
        ),
      ).toEqual([]);
      failSeal = false;
      await f.claim();
      await f.claim();
      expect(await state(f.intentId)).toMatchObject({ status: 'claimed' });
      expect(
        (
          await fixture.ownerQuery(
            'select id,purpose,status from app.system_mail_deliveries where id=$1',
            [f.intentId],
          )
        )[0],
      ).toMatchObject({
        id: f.intentId,
        purpose: 'workflow_failure_alert',
        status: 'queued',
      });
      await reconcile(f.intentId);
      expect(await state(f.intentId)).toMatchObject({ status: 'claimed' });
      const before = messages.length;
      expect(await handler.runOnce()).toBe(1);
      expect(messages).toHaveLength(before + 1);
      expect(messages[before]).toContain(`To: ${f.toEmail}`);
      expect(messages[before]).toContain('From: server@example.test');
      expect(messages[before]).toContain(
        'Subject: Coordinator proof: run failed',
      );
      expect(messages[before]).toContain('Open the run:');
      await store.close();
      store = createStore();
      await reconcile(f.intentId);
      expect(await state(f.intentId)).toMatchObject({
        status: 'delivered',
        possibly_dispatched: true,
      });
      expect(
        (
          await fixture.ownerQuery(
            'select * from app.system_mail_deliveries where id=$1',
            [f.intentId],
          )
        )[0],
      ).toMatchObject({ status: 'submitted', had_uncertain_attempt: false });
    });
    it('preserves possible acceptance when an unresolved claim expires during downtime', async () => {
      const f = await prepare();
      await f.claim();
      expect(
        await mail.claim({ workerId: 'crashed-alert', limit: 1 }),
      ).toHaveLength(1);
      await fixture.ownerQuery(
        "update app.system_mail_deliveries set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour',lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [f.intentId],
      );
      const retention = createRetentionStore(maintenance(), { pageSize: 10 });
      try {
        await retention.enforce();
        await retention.enforce();
      } finally {
        await retention.close();
      }
      expect(
        (
          await fixture.ownerQuery(
            'select status,payload_ciphertext from app.system_mail_deliveries where id=$1',
            [f.intentId],
          )
        )[0],
      ).toEqual({ status: 'expired', payload_ciphertext: null });
      await reconcile(f.intentId);
      expect(await state(f.intentId)).toMatchObject({
        status: 'outcome_unknown',
        possibly_dispatched: true,
      });
    });
    it('records a definite dead letter when definite failures exhaust the shared queue', async () => {
      const f = await prepare();
      await f.claim();
      const definite = createSystemMailDeliveryHandler({
        store: mail,
        envelope,
        timeoutMillis: 3000,
        workerId: 'definite-failure',
        failureAlerts: { authorize },
        email: {
          deduplicates: false,
          sendNotification: () =>
            Promise.resolve({
              kind: 'retryable',
              failure: { category: 'network' },
            }),
        },
      });
      for (let attempt = 0; attempt < 12; attempt += 1) {
        expect(await definite.runOnce()).toBe(1);
        await fixture.ownerQuery(
          "update app.system_mail_deliveries set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",
          [f.intentId],
        );
      }
      expect(
        (
          await fixture.ownerQuery(
            'select status,attempt_count from app.system_mail_deliveries where id=$1',
            [f.intentId],
          )
        )[0],
      ).toEqual({ status: 'reconciliation_required', attempt_count: 12 });
      await reconcile(f.intentId);
      expect(await state(f.intentId)).toMatchObject({
        status: 'dead_letter',
        possibly_dispatched: false,
      });
    });
    it('retains an uncertain provider result for reconciliation and never sends it again', async () => {
      const f = await prepare();
      await f.claim();
      let submissions = 0;
      const uncertain = createSystemMailDeliveryHandler({
        store: mail,
        envelope,
        timeoutMillis: 3000,
        workerId: 'uncertain-alert-proof',
        failureAlerts: { authorize },
        email: {
          deduplicates: false,
          sendNotification: async (message) => {
            await message.beforeDispatch();
            submissions += 1;
            return { kind: 'unknown', failure: { category: 'network' } };
          },
        },
      });
      await uncertain.runOnce();
      await reconcile(f.intentId);
      expect(await state(f.intentId)).toMatchObject({
        status: 'outcome_unknown',
      });
      expect(await uncertain.runOnce()).toBe(0);
      expect(submissions).toBe(1);
    });
    it.each(['removed', 'address_changed', 'destination_changed'] as const)(
      'refuses queued mail when %s before dispatch',
      async (change) => {
        const f = await prepare();
        await f.claim();
        if (change === 'removed')
          await fixture.ownerQuery(
            "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
            [fixture.workspaceId, f.memberId],
          );
        if (change === 'address_changed')
          await fixture.ownerQuery(
            "update app.users set email='changed@example.test' where id=$1",
            [f.memberId],
          );
        if (change === 'destination_changed')
          await destinations.appendVersion({
            workspaceId: fixture.workspaceId,
            actorId: fixture.actorId,
            destinationId: f.destinationId,
            expectedVersion: 1,
            idempotencyKey: randomUUID(),
            requestHash: 'c'.repeat(64),
            config: FailureNotificationDestinationConfigSchema.parse({
              kind: 'system_mail',
              memberId: fixture.actorId,
            }),
          });
        const before = messages.length;
        await handler.runOnce();
        expect(messages).toHaveLength(before);
        await reconcile(f.intentId);
        expect(await state(f.intentId)).toMatchObject({
          status: 'dead_letter',
          safe_error_code: 'failure_alert.superseded',
        });
      },
    );
  },
);
