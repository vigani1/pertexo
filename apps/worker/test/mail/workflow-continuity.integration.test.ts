import { randomUUID } from 'node:crypto';
import { createWorkspaceInvitationDeliveryStore } from '@pertexo/core/tenant-access';
import { createWorkspaceInvitationDeliveryHandler } from '../../src/identity/invitation-delivery.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApplicationSecretEnvelope,
  authenticationMailAssociatedData,
} from '@pertexo/secrets/server';
import { startStack, type Stack } from '../support/recovery/stack.js';
import {
  startMailbox,
  type Mailbox,
} from '../support/recovery/stand-ins/smtp.js';
import { startFlow } from '../support/recovery/flows.js';
import { waitForRunsToEnd } from '../support/recovery/facts.js';

const first = {
  version: 'retained-v1',
  key: Buffer.alloc(32, 11).toString('base64'),
};
const second = {
  version: 'current-v2',
  key: Buffer.alloc(32, 12).toString('base64'),
};

describe.runIf(process.env.WORKER_TRANSPORT_INTEGRATION === 'true')(
  'mail key recovery in a serving worker',
  () => {
    let stack: Stack | undefined;
    let mailbox: Mailbox | undefined;
    const environment: Record<string, string> = {
      AUTH_MAIL_KEY: second.key,
      AUTH_MAIL_KEY_VERSION: second.version,
      AUTH_MAIL_POLL_MILLIS: '100',
      SYSTEM_MAIL_TRANSPORT: 'smtp',
      SYSTEM_MAIL_SMTP_HOST: '127.0.0.1',
      SYSTEM_MAIL_SMTP_TLS: 'none',
      INVITATION_EMAIL_FROM: 'invites@example.test',
    };
    beforeAll(async () => {
      mailbox = await startMailbox();
      environment.SYSTEM_MAIL_SMTP_PORT = String(mailbox.port);
      stack = await startStack('mail-keys', {
        redisDatabase: 12,
        environment: {
          AUTH_SIGN_UP_MODE: 'open',
          INVITATION_TOKEN_KEY: Buffer.alloc(32, 77).toString('base64'),
          INVITATION_TOKEN_KEY_VERSION: 'invitation-v1',
        },
        workerEnvironment: environment,
      });
    }, 120_000);
    afterAll(async () => {
      await stack?.close();
      await mailbox?.close();
    }, 60_000);

    it('warns on startup and per-message key loss, keeps workflows running, and sends once after restoring the key', async () => {
      if (stack === undefined || mailbox === undefined)
        throw new Error('Serving fixture missing');
      const activeStack = stack;
      const id = randomUUID(),
        expiresAt = new Date(Date.now() + 3_600_000);
      const sealed = createApplicationSecretEnvelope({ current: first }).seal(
        JSON.stringify({
          fromEmail: 'from@example.test',
          toEmail: 'retained@example.test',
          subject: 'Retained mail',
          text: 'Synthetic bearer link',
        }),
        authenticationMailAssociatedData('verification', id, expiresAt),
      );
      await activeStack.sql(
        `insert into app.system_mail_deliveries(id,purpose,expires_at,payload_ciphertext,payload_nonce,payload_tag,payload_key_version)
      values($1,'verification',$2,$3,$4,$5,$6)`,
        [
          id,
          expiresAt,
          sealed.ciphertext,
          sealed.nonce,
          sealed.tag,
          sealed.keyVersion,
        ],
      );
      const row = async () =>
        (
          await activeStack.sql<{
            status: string;
            payload_ciphertext: string | null;
            attempt_count: number;
            failure_code: string | null;
          }>(
            'select status,payload_ciphertext,attempt_count,failure_code from app.system_mail_deliveries where id=$1',
            [id],
          )
        )[0];
      await expect.poll(row, { timeout: 10_000 }).toEqual({
        status: 'retry',
        payload_ciphertext: sealed.ciphertext,
        attempt_count: 0,
        failure_code: 'delivery.payload_unavailable',
      });
      expect(mailbox.messages()).toEqual([]);
      await activeStack.worker.stop('SIGTERM');
      const missing = activeStack.createWorker('mail-missing-key');
      missing.start();
      await missing.waitForLog(/worker\.started/u, 30_000);
      expect(
        missing.logs.some(
          (line) =>
            line.text.includes('system_mail.key_unavailable') &&
            line.text.includes(first.version),
        ),
      ).toBe(true);
      const workspace = await activeStack.api.createWorkspace(
        'mail-key-continuity',
      );
      const execute = async () => {
        const runId = await startFlow(
          activeStack,
          workspace,
          'workflows continue',
          [
            {
              id: 'request',
              method: 'GET',
              url: `${activeStack.sink.origin}/ok/${randomUUID()}`,
            },
          ],
        );
        expect(
          (await waitForRunsToEnd(activeStack, [runId], 30_000))[runId]?.status,
        ).toBe('succeeded');
      };
      await execute();
      await missing.stop('SIGTERM');
      environment.AUTH_MAIL_PREVIOUS_KEYS = JSON.stringify([first]);
      await activeStack.sql(
        'update app.system_mail_deliveries set next_attempt_at=clock_timestamp() where id=$1',
        [id],
      );
      const recovered = activeStack.createWorker('mail-restored-key');
      recovered.start();
      await recovered.waitForLog(/worker\.started/u, 30_000);
      await expect.poll(row, { timeout: 10_000 }).toEqual({
        status: 'submitted',
        payload_ciphertext: null,
        attempt_count: 1,
        failure_code: null,
      });
      await execute();
      expect(mailbox.messages()).toEqual(['retained@example.test']);
      await recovered.stop('SIGTERM');
      const invitedEmail = `${randomUUID()}@example.test`;
      const invitation = await activeStack.api.call(
        'POST',
        `/v1/workspaces/${workspace}/invitations`,
        { email: invitedEmail, role: 'viewer' },
        { 'idempotency-key': randomUUID() },
      );
      expect(invitation.status).toBe(202);
      const invitationId = (invitation.json as { invitation: { id: string } })
        .invitation.id;
      const [event] = await activeStack.sql<{
        payload: {
          workspaceId: string;
          invitationId: string;
          deliveryAttemptId: string;
          outboxEventId: string;
        };
      }>(
        "select payload from app.outbox_events where aggregate_id=$1 and job_name='deliver-workspace-invitation'",
        [invitationId],
      );
      if (event === undefined) throw new Error('Invitation event missing');
      const [database] = await activeStack.sql<{ name: string }>(
        'select current_database() name',
      );
      const url = new URL(process.env.DATABASE_URL ?? '');
      url.pathname = `/${database?.name ?? ''}`;
      const deliveryStore = createWorkspaceInvitationDeliveryStore({
        connectionString: url.toString(),
        max: 2,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 5000,
        ownerRole: 'pertexo_owner',
      });
      let sends = 0;
      const uncertain = createWorkspaceInvitationDeliveryHandler({
        store: deliveryStore,
        envelope: createApplicationSecretEnvelope({
          current: {
            version: 'invitation-v1',
            key: Buffer.alloc(32, 77).toString('base64'),
          },
        }),
        email: {
          deduplicates: false,
          sendNotification: async (message) => {
            await message.beforeDispatch();
            sends += 1;
            return { kind: 'unknown', failure: { category: 'network' } };
          },
        },
        fromEmail: 'invites@example.test',
        webOrigin: 'http://127.0.0.1:5999',
        timeoutMillis: 1000,
      });
      try {
        const job = {
          name: 'deliver-workspace-invitation' as const,
          data: event.payload,
          transport: { jobId: event.payload.outboxEventId, attemptsMade: 0 },
        };
        await uncertain.handle(job, { signal: new AbortController().signal });
        await uncertain.handle(job, { signal: new AbortController().signal });
        expect(sends).toBe(1);
        const listed = await activeStack.api.call(
          'GET',
          `/v1/workspaces/${workspace}/invitations`,
        );
        expect(
          (
            listed.json as { items: { id: string; deliveryStatus: string }[] }
          ).items.find((item) => item.id === invitationId)?.deliveryStatus,
        ).toBe('unknown');
        const [facts] = await activeStack.sql<{
          status: string;
          token_ciphertext: string | null;
          acknowledged: boolean;
        }>(
          `select a.status,a.token_ciphertext,exists(select 1 from app.inbox_receipts r where r.message_id=$2 and r.completed_at is not null) acknowledged from app.workspace_invitation_delivery_attempts a where invitation_id=$1`,
          [invitationId, event.payload.outboxEventId],
        );
        expect(facts).toEqual({
          status: 'unknown',
          token_ciphertext: null,
          acknowledged: true,
        });
        const resend = await activeStack.api.call(
          'POST',
          `/v1/workspaces/${workspace}/invitations/${invitationId}/resend`,
          { expectedRevision: 1 },
          { 'idempotency-key': randomUUID() },
        );
        expect(resend.status).toBe(503);
        expect(resend.json).toMatchObject({
          code: 'workspace.invitation_delivery_unavailable',
        });
        expect(resend.json).toMatchObject({
          detail:
            'Email delivery could not be confirmed. Revoke this invitation and create a new one to send another link.',
        });
        expect(
          (
            await activeStack.api.call(
              'POST',
              `/v1/workspaces/${workspace}/invitations/${invitationId}/revoke`,
              { expectedRevision: 1 },
              { 'idempotency-key': randomUUID() },
            )
          ).status,
        ).toBe(202);
        expect(
          (
            await activeStack.api.call(
              'POST',
              `/v1/workspaces/${workspace}/invitations`,
              { email: invitedEmail, role: 'viewer' },
              { 'idempotency-key': randomUUID() },
            )
          ).status,
        ).toBe(202);
      } finally {
        await deliveryStore.close();
      }
    }, 90_000);
  },
);
